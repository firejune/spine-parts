/**
 * The painting, generated on a ComfyUI box from the config's inline
 * `generation` block: `painting_<seed>.png` and `painting_<seed>_meta.json`
 * per seed, and `control_<skeleton>.png` when the config asks for structural
 * control — `<skeleton>` is the built-in's name, or for a pose file (issue
 * #198) `pose-` and the first 12 hex digits of the image's sha256, so two pose
 * files drawn at one size never share a name on the box.
 *
 * The words and the graph are `src/graphs.ts` (`buildPrompts`,
 * `paintingGraph`) and the skeleton is `src/skeleton.ts`; this file carries
 * them to the box and back. Before anything is uploaded the whole graph is
 * checked against the box's `/object_info` — a checkpoint, LoRA, ControlNet
 * or upscale model the box does not list is refused by name, not discovered
 * as a failed job.
 *
 * Every seed waits for an empty queue, and each painting is written only after
 * its job is in `/history`, not in error, and the image it saved decodes at
 * twice the latent size (4x-AnimeSharp then 0.5). A seed whose file already
 * exists in `--out` is refused before the first job, so no painting is
 * overwritten.
 *
 * The meta file holds the positive and negative prompts verbatim, what was
 * dropped as `DUP_WORDS`, where the pose words came from, the checkpoint, the
 * LoRAs, control and sampler as the graph used them (defaults resolved, each
 * by its named fields, so an annotation or an `x-` record its author wrote in
 * the config never reaches the meta), the elapsed seconds and the prompt id —
 * never the host.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ControlPose, PaintConfig } from '../config.ts';
import { type Problem, refuseIfAny } from '../errors.ts';
import { buildPrompts, checkGraph, paintingGraph, resolvedControl, resolvedLoras, resolvedSampler } from '../graphs.ts';
import { decodePngBytes, encodePngBytes } from '../raster/png.ts';
import { isSkeletonName, renderSkeleton } from '../skeleton.ts';
import { ComfyClient, historyImages, refuse } from './client.ts';

export interface PaintRun {
  /** Read through `loadPaintConfig(path)`, which has already required and checked `generation`. */
  config: PaintConfig;
  /** The pose file `generation.control.skeleton` names, as `loadPaintConfig` read it; null for a built-in or no control. */
  pose: ControlPose | null;
  out: string;
  seeds: number;
  seed0: number;
  wait: number;
  timeout: number;
}

export interface Painted {
  seed: number;
  file: string;
  elapsed: number;
  size: [number, number];
}

export async function runPainting(client: ComfyClient, run: PaintRun, say: (line: string) => void): Promise<Painted[]> {
  const g = run.config.generation;
  const seeds = Array.from({ length: run.seeds }, (_, i) => run.seed0 + i);
  const taken: Problem[] = seeds
    .filter((s) => existsSync(join(run.out, `painting_${s}.png`)))
    .map((s) => ({ code: 'COMFY_OUT_FREE', object: join(run.out, `painting_${s}.png`), detail: 'already exists; a seed whose painting is on disk is not generated again over it' }));
  refuseIfAny(taken);
  const prompts = buildPrompts(g);
  const [w, h] = g.latent;
  say(`  positive (${prompts.positive.length} chars, pose words from ${prompts.poseFrom}${prompts.dropped.length > 0 ? `, dropped ${prompts.dropped.join(' | ')}` : ''}): ${prompts.positive}`);
  say(`  negative (${prompts.negative.length} chars): ${prompts.negative}`);

  await client.systemStats();
  const control = g.control === undefined ? null : resolvedControl(g.control);
  const drawn = control === null ? null : controlImage(control.skeleton, run.pose, w, h);
  const skeletonName = drawn === null ? null : `spine_parts_${drawn.label}_${w}x${h}.png`;
  const probe = paintingGraph(g, seeds[0], prompts, `spine_parts_${run.config.key}_${seeds[0]}`, skeletonName);
  refuseIfAny(checkGraph(probe, await client.objectInfo(), client.host, new Set(['30.image'])));
  say('  box: every node, input and model of the painting graph is on its /object_info');

  mkdirSync(run.out, { recursive: true });
  let skeletonRef: string | null = null;
  if (control !== null && drawn !== null && skeletonName !== null) {
    const local = join(run.out, `control_${drawn.label}.png`);
    writeFileSync(local, drawn.png);
    skeletonRef = await client.uploadImage(drawn.png, skeletonName);
    say(`  control: ${drawn.from} at ${w}x${h} -> ${local}, uploaded as input/${skeletonRef}; ${control.model} strength ${control.strength} end ${control.end_percent}`);
  }

  const done: Painted[] = [];
  for (const seed of seeds) {
    const waited = await client.waitQueueEmpty(run.wait, say);
    if (waited > 0.05) say(`  queue empty after ${waited.toFixed(1)} s`);
    const graph = paintingGraph(g, seed, prompts, `spine_parts_${run.config.key}_${seed}`, skeletonRef);
    const id = await client.submit(graph, 'rig-parts');
    say(`  seed ${seed}: queued prompt ${id}; GPU job started`);
    const { entry, elapsed } = await client.waitHistory(id, run.timeout);
    const image = historyImages(entry).find((im) => im.type === 'output');
    if (image === undefined) {
      refuse('COMFY_HISTORY_OUTPUTS', `prompt ${id}`, `lists outputs from node(s) ${Object.keys(entry.outputs).join(', ')} and no image of type "output"; SaveImage (node 9) is required to have saved one`);
    }
    const bytes = await client.view(image.filename, image.subfolder, image.type);
    const img = decodePngBytes(bytes, `output/${image.filename}`);
    if (img.width !== 2 * w || img.height !== 2 * h) {
      refuse('COMFY_PAINTING_SIZE', `output/${image.filename}`, `is ${img.width}x${img.height}; ${2 * w}x${2 * h} is required (latent ${w}x${h}, 4x-AnimeSharp then 0.5)`);
    }
    const file = join(run.out, `painting_${seed}.png`);
    writeFileSync(file, bytes);
    const meta = {
      seed,
      elapsed_s: Math.round(elapsed * 10) / 10,
      latent: [w, h],
      size: [img.width, img.height],
      key: run.config.key,
      checkpoint: g.checkpoint,
      loras: resolvedLoras(g.loras),
      sampler: resolvedSampler(g.sampler),
      control,
      pose_from: prompts.poseFrom,
      dropped: prompts.dropped,
      positive: prompts.positive,
      negative: prompts.negative,
      prompt_id: id,
    };
    writeFileSync(join(run.out, `painting_${seed}_meta.json`), `${JSON.stringify(meta, null, 1)}\n`);
    say(`  seed ${seed}: GPU job finished in ${elapsed.toFixed(1)} s -> ${file} (${img.width}x${img.height})`);
    done.push({ seed, file, elapsed, size: [img.width, img.height] });
  }
  return done;
}

/** The control image for a built-in skeleton or the pose file read beside the config, with the name it is written and uploaded under. */
function controlImage(skeleton: string, pose: ControlPose | null, w: number, h: number): { png: Uint8Array; label: string; from: string } {
  if (isSkeletonName(skeleton)) return { png: encodePngBytes(renderSkeleton(skeleton, w, h)), label: skeleton, from: `${skeleton} skeleton` };
  // loadPaintConfig reads the file a non-built-in skeleton names, or refuses; a run without it skipped the loader.
  if (pose === null) throw new Error(`runPainting: generation.control.skeleton names the pose file "${skeleton}" and no pose was read; load the config through loadPaintConfig`);
  const png = encodePngBytes(renderSkeleton(pose.points, w, h));
  return { png, label: `pose-${createHash('sha256').update(png).digest('hex').slice(0, 12)}`, from: `pose file ${pose.file}` };
}

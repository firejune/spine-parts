#!/usr/bin/env bun
/**
 * The assemble stage against the reference implementation's own outputs —
 * a TEST-SIDE tool, run by hand on a machine that has the private corpus.
 * Nothing it reads is copied into this tree, and it prints no character name:
 * public characters are called by their public key, private ones `C1`…`Cn`
 * in the sorted order of their directories.
 *
 *   bun fixtures/oracle_assemble.ts <characters-dir> <scratch-out-dir> [--only <label>]
 *
 * Each `<characters-dir>/<key>/` that holds `config.json`,
 * `source/painting_<seed>.png`, `layers/{full,head}/layers.json`,
 * `rig/parts.json`, `rig/parts/*.png` and `render/recomposite_rig.png` is one
 * character; a directory missing any of them, or named `_provisional_*`, is
 * skipped and said so. The port's outputs go under `<scratch-out-dir>`,
 * which must lie outside this repository.
 *
 * The configs there are the reference's OLD schema, which `src/config.ts`
 * refuses by design (`generation.character_file`, `status`, …).
 * `stripLegacyConfig` keeps exactly the fields the assemble stage reads and
 * fills the sections the loader requires but the stage never reads (`bones`,
 * `meshes`, `regions`, `motion`) with a one-bone placeholder, so the stage is
 * measured through the real loader rather than around it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { assemble, type AssembleResult, measureRecomposite, proposePlan, type SeamRule, sourceInRig, stageFields } from '../src/assemble.ts';
import { parseConfig } from '../src/config.ts';
import { PartsError } from '../src/errors.ts';
import { readWrapperLayers } from '../src/layers.ts';
import type { PartRecord, PartsFile } from '../src/parts.ts';
import { readPng, writePng } from '../src/raster/png.ts';
import type { Raster } from '../src/raster/types.ts';

const PUBLIC_KEYS = ['sample', 'demo'];

/** The legacy config reduced to what the assemble stage reads, plus the placeholders the loader requires. */
export function stripLegacyConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const st = raw.seethrough as Record<string, unknown>;
  const as = raw.assemble as Record<string, unknown>;
  const plan = as.plan as Array<[string, string, string]>;
  const assembleOut: Record<string, unknown> = { rig_scale: as.rig_scale, plan };
  if (as.extend_below_crop !== undefined) assembleOut.extend_below_crop = as.extend_below_crop;
  return {
    key: raw.key,
    seethrough: { resolution: st.resolution, steps: st.steps, seed: st.seed, offload: st.offload, head_box: st.head_box },
    assemble: assembleOut,
    bones: [{ name: 'anchor', parent: 'root', at: [0, 0] }],
    meshes: {},
    regions: Object.fromEntries(plan.map((p) => [p[0], 'anchor'])),
    motion: { duration: 1, tracks: [] },
  };
}

interface Character {
  key: string;
  label: string;
  dir: string;
}

function characters(root: string): { chars: Character[]; skipped: string[] } {
  const chars: Character[] = [];
  const skipped: string[] = [];
  let n = 0;
  for (const key of readdirSync(root).sort()) {
    const dir = join(root, key);
    const need = ['config.json', 'layers/full/layers.json', 'layers/head/layers.json', 'rig/parts.json', 'render/recomposite_rig.png'];
    const isPublic = PUBLIC_KEYS.includes(key);
    const missing = need.filter((f) => !existsSync(join(dir, f)));
    if (key.startsWith('_provisional_') || missing.length > 0) {
      skipped.push(isPublic ? key : `(a directory missing ${missing.join(', ') || 'nothing — provisional'})`);
      continue;
    }
    chars.push({ key, label: isPublic ? key : `C${++n}`, dir });
  }
  return { chars, skipped };
}

function place(img: Raster, x: number, y: number, W: number, H: number): Raster {
  const out: Raster = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  for (let r = 0; r < img.height; r++) out.data.set(img.data.subarray(r * img.width * 4, (r + 1) * img.width * 4), ((y + r) * W + x) * 4);
  return out;
}

/** Over the union of two parts' boxes on the rig: mean |d| over RGBA samples, max, and pixels whose max-channel |d| > 8. */
function pixelDiff(a: Raster, b: Raster): { mean: number; max: number; over8: number; px: number } {
  let sum = 0;
  let max = 0;
  let over8 = 0;
  let n = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    const ia = p * 4;
    if (a.data[ia + 3] === 0 && b.data[ia + 3] === 0) continue;
    n++;
    let m = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a.data[ia + c] - b.data[ia + c]);
      sum += d;
      m = Math.max(m, d);
    }
    max = Math.max(max, m);
    if (m > 8) over8++;
  }
  return { mean: n === 0 ? 0 : sum / (4 * n), max, over8, px: n };
}

function imageDiff(a: Raster, b: Raster): { mean: number; max: number; over8: number } {
  let sum = 0;
  let max = 0;
  let over8 = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    let m = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]);
      sum += d;
      m = Math.max(m, d);
    }
    max = Math.max(max, m);
    if (m > 8) over8++;
  }
  return { mean: sum / (3 * a.width * a.height), max, over8 };
}

const FIELDS: ReadonlyArray<keyof PartRecord> = ['from', 'x', 'y', 'w', 'h', 'opaque_px', 'projected_core_px', 'source_px_taken', 'refused_drift_px', 'merged_px', 'seam_override_px'];

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error('usage: bun fixtures/oracle_assemble.ts <characters-dir> <scratch-out-dir> [--only <label>]');
    process.exit(2);
  }
  const root = resolve(argv[0]);
  const outRoot = resolve(argv[1]);
  const only = argv.indexOf('--only') >= 0 ? argv[argv.indexOf('--only') + 1] : null;
  if (!relative(resolve(import.meta.dir, '..'), outRoot).startsWith('..')) {
    console.error('the scratch out dir must lie outside this repository');
    process.exit(2);
  }
  const { chars, skipped } = characters(root);
  console.log(`characters: ${chars.map((c) => c.label).join(', ')}; skipped ${skipped.length}: ${skipped.join('; ')}`);
  const summary: string[] = [];
  const seamRows: string[] = [];
  for (const ch of chars) {
    if (only !== null && ch.label !== only) continue;
    const raw = JSON.parse(readFileSync(join(ch.dir, 'config.json'), 'utf8')) as Record<string, unknown>;
    const seed = (raw.generation as Record<string, unknown>).seed as number;
    const source = readPng(join(ch.dir, 'source', `painting_${seed}.png`));
    const full = readWrapperLayers(join(ch.dir, 'layers', 'full'));
    const head = readWrapperLayers(join(ch.dir, 'layers', 'head'));
    const stripped = stripLegacyConfig(raw);
    let fields: ReturnType<typeof stageFields>;
    let loader = 'loader green';
    try {
      fields = stageFields(parseConfig(stripped));
    } catch (err) {
      if (!(err instanceof PartsError)) throw err;
      loader = `loader REFUSED (${err.problems.map((p) => p.code).join(', ')}); measured with the loader bypassed`;
      const st = stripped.seethrough as Record<string, unknown>;
      const as = stripped.assemble as Record<string, unknown>;
      fields = {
        resolution: st.resolution as number,
        headBox: st.head_box as [number, number, number, number],
        rigScale: as.rig_scale as number,
        plan: as.plan as ReturnType<typeof stageFields>['plan'],
        extend: (as.extend_below_crop ?? []) as ReturnType<typeof stageFields>['extend'],
        // The reference had no patches and no cuts, so no config it wrote carries any.
        patches: [],
        cuts: [],
      };
    }
    const results = new Map<SeamRule, AssembleResult>();
    for (const rule of ['near-white', 'silhouette'] as const) {
      try {
        results.set(rule, assemble({ source, full, head, ...fields, seamRule: rule, projectRule: 'core' }));
      } catch (err) {
        if (!(err instanceof PartsError)) throw err;
        console.log(`${ch.label} ${rule}: REFUSED ${err.message}`);
      }
    }
    const res = results.get('near-white');
    if (res === undefined) {
      summary.push(`| ${ch.label} | refused | | | | | |`);
      continue;
    }
    const outDir = join(outRoot, ch.label);
    mkdirSync(join(outDir, 'parts'), { recursive: true });
    writeFileSync(join(outDir, 'parts.json'), `${JSON.stringify(res.parts, null, 1)}\n`);
    for (const { record, image } of res.images) writePng(join(outDir, 'parts', `${record.name}.png`), image);
    writePng(join(outDir, 'recomposite_rig.png'), res.recomposite);

    const py = JSON.parse(readFileSync(join(ch.dir, 'rig', 'parts.json'), 'utf8')) as PartsFile;
    const [W, H] = res.parts.rig_size;
    console.log(`\n## ${ch.label} — ${loader}; rig ${W}x${H} (reference ${py.rig_size.join('x')}), scale ${res.parts.scale_rig_per_source} (reference ${py.scale_rig_per_source})`);
    const ghostKeys = new Set([...Object.keys(py.ghost_px), ...Object.keys(res.parts.ghost_px)]);
    const ghostDiff = [...ghostKeys].filter((k) => py.ghost_px[k] !== res.parts.ghost_px[k]).map((k) => `${k} ${py.ghost_px[k]}->${res.parts.ghost_px[k]}`);
    console.log(`ghost_px: ${ghostKeys.size} key(s), ${ghostDiff.length} differ${ghostDiff.length > 0 ? `: ${ghostDiff.join(', ')}` : ''}`);
    const names = [...new Set([...py.parts.map((p) => p.name), ...res.parts.parts.map((p) => p.name)])];
    let fieldDiffs = 0;
    let fieldsSeen = 0;
    let worstMax = 0;
    let over8Total = 0;
    let partsExact = 0;
    const orderSame = py.parts.map((p) => p.name).join(',') === res.parts.parts.map((p) => p.name).join(',');
    console.log('| part | from | box (ref -> port) | opaque ref/port | core | taken | drift | merged | seam | px mean | px max | px > 8 |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const name of names) {
      const a = py.parts.find((p) => p.name === name);
      const b = res.parts.parts.find((p) => p.name === name);
      if (a === undefined || b === undefined) {
        console.log(`| ${name} | ${a === undefined ? 'ONLY IN PORT' : 'ONLY IN REFERENCE'} |||||||||||`);
        fieldDiffs++;
        continue;
      }
      const diffs = FIELDS.filter((f) => a[f] !== b[f]);
      fieldsSeen += FIELDS.length;
      fieldDiffs += diffs.length;
      const pyImg = readPng(join(ch.dir, 'rig', 'parts', `${name}.png`));
      const ours = res.images.find((p) => p.record.name === name);
      const d = pixelDiff(place(pyImg, a.x, a.y, W, H), place((ours as { image: Raster }).image, b.x, b.y, W, H));
      worstMax = Math.max(worstMax, d.max);
      over8Total += d.over8;
      if (diffs.length === 0 && d.max === 0) partsExact++;
      const cell = (f: keyof PartRecord): string => (a[f] === b[f] ? String(a[f]) : `${a[f]}/${b[f]}`);
      const box = a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h ? `${a.x},${a.y} ${a.w}x${a.h}` : `${a.x},${a.y} ${a.w}x${a.h} -> ${b.x},${b.y} ${b.w}x${b.h}`;
      console.log(
        `| ${name} | ${a.from === b.from ? a.from : `${a.from}/${b.from}`} | ${box} | ${cell('opaque_px')} | ${cell('projected_core_px')} | ${cell('source_px_taken')} | ${cell('refused_drift_px')} | ${cell('merged_px')} | ${cell('seam_override_px')} | ${d.mean.toFixed(4)} | ${d.max} | ${d.over8} |`,
      );
    }
    const srcr = sourceInRig(source, W, H);
    const pyRec = readPng(join(ch.dir, 'render', 'recomposite_rig.png'));
    const rec = imageDiff(pyRec, res.recomposite);
    const pyPlaced = py.parts.map((p) => ({ record: p, image: readPng(join(ch.dir, 'rig', 'parts', `${p.name}.png`)) }));
    const pyFig = measureRecomposite(pyRec, srcr, pyPlaced);
    const f = res.figures;
    console.log(
      `recomposite port vs reference: mean |d| ${rec.mean.toFixed(4)}, max ${rec.max}, px > 8: ${rec.over8}; ` +
        `vs source — reference mean ${pyFig.meanAbs.toFixed(3)} within ${(100 * pyFig.within).toFixed(2)}% err ${pyFig.errorPx} uncovered ${pyFig.uncoveredErrorPx}; ` +
        `port mean ${f.meanAbs.toFixed(3)} within ${(100 * f.within).toFixed(2)}% err ${f.errorPx} uncovered ${f.uncoveredErrorPx}`,
    );
    summary.push(
      `| ${ch.label} | ${names.length} | ${orderSame ? 'same' : 'DIFFERENT'} | ${fieldDiffs} of ${fieldsSeen} | ${partsExact} | ${worstMax} | ${over8Total} | ${rec.mean.toFixed(4)} / ${rec.max} / ${rec.over8} | ${pyFig.meanAbs.toFixed(3)} / ${f.meanAbs.toFixed(3)} | ${pyFig.errorPx} / ${f.errorPx} | ${ghostDiff.length} |`,
    );
    const sil = results.get('silhouette');
    if (sil !== undefined) {
      const s = sil.figures;
      seamRows.push(
        `| ${ch.label} | ${f.meanAbs.toFixed(3)} | ${s.meanAbs.toFixed(3)} | ${(100 * f.within).toFixed(2)}% | ${(100 * s.within).toFixed(2)}% | ${f.errorPx} | ${s.errorPx} | ${f.uncoveredErrorPx} | ${s.uncoveredErrorPx} | ${res.parts.parts.reduce((t, p) => t + p.seam_override_px, 0)} | ${sil.parts.parts.reduce((t, p) => t + p.seam_override_px, 0)} |`,
      );
    }
    // the proposal, against the plan the reference proposed (where the config says it was kept unchanged)
    const as = raw.assemble as Record<string, unknown>;
    const note = typeof as.plan_note === 'string' ? as.plan_note : '';
    const prop = proposePlan(full, head, { sourceW: source.width, sourceH: source.height, resolution: fields.resolution, headBox: fields.headBox, rigScale: fields.rigScale });
    const same = JSON.stringify(prop.plan) === JSON.stringify(as.plan) && JSON.stringify(prop.extend_below_crop) === JSON.stringify(as.extend_below_crop ?? []);
    const notesIn = prop.notes.every((n) => note.includes(n));
    console.log(
      `propose-plan: ${prop.plan.length} part(s), ${prop.extend_below_crop.length} extend(s), notes [${prop.notes.join(' | ')}]; ` +
        `${note.startsWith('= assemble_parts.py --propose-plan output unchanged') ? `config says the proposal was kept unchanged -> plan+extend ${same ? 'EQUAL' : 'DIFFERENT'}, notes ${notesIn ? 'all quoted in plan_note' : 'NOT all in plan_note'}` : `config was hand-edited or carries no note -> plan+extend ${same ? 'equal' : 'differ'} (informative only)`}`,
    );
  }
  console.log('\n| character | parts | order | parts.json fields differing | parts pixel-exact | worst part px max | part px > 8 (sum) | recomposite port vs ref mean / max / px > 8 | vs source mean ref / port | error px > 40 ref / port | ghost keys differing |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of summary) console.log(r);
  console.log('\n| character | mean faithful | mean silhouette | within faithful | within silhouette | err > 40 faithful | err > 40 silhouette | uncovered faithful | uncovered silhouette | seam px faithful | seam px silhouette |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of seamRows) console.log(r);
}

if (import.meta.main) main();

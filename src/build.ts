/**
 * The stages as callable units, and `build`, which runs three of them in a row.
 *
 * Each command in `cli.ts` — `assemble`, `rig`, `check`, `loop` — is a thin
 * flag parser over one function here, and `build` calls the same functions in
 * the same process. That is the whole reason this file exists: a driver that
 * re-implemented a stage (or re-spawned the CLI and parsed its text) would be a
 * second copy that could drift from the command it claims to run. What a
 * stage prints, it prints through the `Log` it is handed, so `build` reads the
 * very lines the command prints, under a `[stage]` prefix.
 *
 *     build = assemble -> rig -> check [-> loop]
 *
 * `propose` is deliberately not a step. A config with bones is the input to
 * `build`: the proposal is a starting point to be corrected against its
 * overlay, and a driver that fed the proposal straight to `rig` would turn a
 * draft into a rig with nobody having looked at it.
 *
 * `build --out <dir>` receives:
 *
 * | path | from |
 * | --- | --- |
 * | `parts/<name>.png`, `parts.json`, `recomposite_rig.png`, `recomposite_error_rig.png` | assemble — the loose parts, an intermediate, and the error map of their flat stack |
 * | `rig/` (`rig.json`, `motion.json`, `mesh_report.json`, `images/`) | rig |
 * | `check/` (`build/` with the packed atlas, both gate files, `idle_frames/`, `contact.png`, `motion_heat.png`, `check.json`) | check |
 * | `idle.png` (lossless APNG), `idle-indexed.png` (indexed APNG), `idle.gif` | loop, with `--loop`, from `check/idle_frames/` |
 *
 * The artifact is `check/build/skeleton.json`, `.atlas` and the packed page
 * (issue #2): the last lines of a green build are the pack line and those
 * three paths.
 *
 * Emit only after green, stage by stage: each stage writes only after its own
 * checks, and `build` stops at the first stage that refuses — printing that
 * stage's own FAIL lines — so nothing downstream of a red is written. The paths
 * `build` owns under `--out` (the table above, and nothing else) are removed
 * before the first stage runs, so a file left by an earlier run cannot sit
 * beside a later run's refusal looking current.
 *
 * Pure in the sense `src/` is held to: no clock, no randomness, no network and
 * no child process. rig-c runs as a process, but the process is injected
 * as a {@link RigcRunner}, exactly as `src/check.ts` takes it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type AnimFrame, EncodeError, encodeApng, encodeIndexedApng, INDEXED_DEFAULTS } from './apng.ts';
import { assemble, type AssembleResult, figuresLine, holeLines, type ProjectRule, type SeamRule, stageFields } from './assemble.ts';
import { allocationClause, type Reducer, stageBClause, unboundedClause } from './automesh.ts';
import { residualClause } from './autoenvelope.ts';
import { type AutoMotionCase, failingRows, localRow, motionClause, motionDeformation, motionDocument, motionInput, motionRowText, motionStimulus, motionVerdict, noStimulusProblem, type ReplayCandidate, runComparison } from './automotion.ts';
import {
  bisectAccepted,
  budgetProblem,
  type CountedProbe,
  finalVerdict,
  gridFrameIds,
  maxReplays,
  MULTI_INTERVAL_RULE,
  type MultiIntervalRow,
  multiIntervalSearch,
  noMultiReductionProblem,
  noReductionProblem,
  passingIntervals,
  readingText,
  REPLAY_RULE,
  type ReplayProbe,
  type ReplayRow,
  roleReadings,
  rolesProblem,
  selectionSchedule,
  splitSchedule,
  untestedIntervals,
} from './autoreplay.ts';
import { BARS, besideIdleLine, causeLines, REQUIREMENTS_DIR, type CheckReport, type PackLine, DEFAULT_PACK_SHAPE, DEFAULT_PAGE_EDGES, JUDGEMENT_LINES, type JudgementLine, packedBuildArgs, packedBuildLabel, type PackMode, type PackShape, type PageEdges, readFrameSet, REPORTED_LINES, type ReportedLine, type RigcRunner, runCheck, SEAM_MEAN_BAR, SOURCE_LINE, SEAM_PX_BAR, SEAM_PX_LEVEL, SEAM_PX_LEVEL_HIGH, SPINEBOY_YARDSTICK } from './check.ts';
import { loadConfig, loadConfigAndAnimations, loadEarlyConfig } from './config.ts';
import { PartsError, type Problem, problemLine, refuseIfAny } from './errors.ts';
import type { MeshQualityReport, MotionSchedule } from 'rig-c/mesh';
import { encodeGif } from './gif.ts';
import { CONTROL_SUFFIX, withAnimations } from './motion.ts';
import type { PaletteError } from './palette.ts';
import { type LayerSet, readLayers } from './layers.ts';
import { type PartRecord, readParts, writeParts } from './parts.ts';
import { encodePngBytes, readPng, writePng } from './raster/png.ts';
import type { Raster } from './raster/types.ts';
import { readRequirements, type RequirementLine, summaryText } from './requirements.ts';
import { type AutoMeshReport, buildRig, DEFAULT_IDLE_KEYS, type IdleKeys, type MeshReport, type RigCommand, rigJsonText, type RigOutput, type RigSpec, type StrayCleared } from './rig.ts';

/** Where a stage's lines go. The commands hand it `console.log`; `build` hands it a prefixing wrapper. */
export type Log = (line: string) => void;

// ---------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------

/** The painting, refused by name when it is missing or is not a PNG. */
export function readSource(path: string): Raster {
  if (!existsSync(path)) {
    throw new PartsError([{ code: 'ASSEMBLE_SOURCE_PRESENT', object: path, detail: 'no such file; the painting the two runs were made from is required' }]);
  }
  try {
    return readPng(path);
  } catch (err) {
    throw new PartsError([{ code: 'ASSEMBLE_SOURCE_DECODES', object: path, detail: `${(err as Error).message}; a PNG is required` }]);
  }
}

/** Read both runs, collecting the refusals of both before throwing. */
export function readRuns(full: string, head: string): { full: LayerSet; head: LayerSet } {
  const problems: Problem[] = [];
  const one = (path: string): LayerSet | null => {
    try {
      return readLayers(path);
    } catch (err) {
      if (err instanceof PartsError) {
        problems.push(...err.problems);
        return null;
      }
      throw err;
    }
  };
  const f = one(full);
  const h = one(head);
  if (problems.length > 0) throw new PartsError(problems);
  return { full: f as LayerSet, head: h as LayerSet };
}

export interface AssembleStageInput {
  source: string;
  full: string;
  head: string;
  config: string;
  seam: SeamRule;
  project: ProjectRule;
}

/** Where the assemble stage writes: `parts.json`, the directory of part PNGs, the recomposite, and its error map. */
export interface AssembleOutputs {
  partsJson: string;
  partsDir: string;
  recomposite: string;
  errorMap: string;
}

/** The error map's file name beside a recomposite: `recomposite_rig.png` -> `recomposite_error_rig.png`. */
export const ERROR_MAP_FILE = 'recomposite_error_rig.png';

/**
 * One line per part whose fringe `pushBackFringe` cleared (issue #119), in
 * draw order: `  fringe pushed back: "topwear" 723 px, where the painting
 * shows "handwear_l" 460 px, "bottomwear" 257 px`. No line when no part had
 * one, so a stack the rule did not touch prints what it printed before.
 */
export function fringeLines(parts: readonly PartRecord[]): string[] {
  return parts
    .filter((p) => p.fringe_pushed_back !== undefined && p.fringe_pushed_back.length > 0)
    .map((p) => {
      const list = p.fringe_pushed_back ?? [];
      const n = list.reduce((a, q) => a + q.px, 0);
      return `  fringe pushed back: "${p.name}" ${n} px, where the painting shows ${list.map((q) => `"${q.part}" ${q.px} px`).join(', ')}`;
    });
}

/** Read, assemble, and write only after every refusal has had its chance. Throws a PartsError on a refusal, having written nothing. */
export function assembleStage(input: AssembleStageInput, outs: AssembleOutputs, log: Log): AssembleResult {
  const src = readSource(input.source);
  const runs = readRuns(input.full, input.head);
  // The early door: assemble runs before propose has drafted bones, meshes,
  // regions and motion, so it requires only what it reads (issue #20).
  const fields = stageFields(loadEarlyConfig(input.config, 'assemble'));
  const result = assemble({ source: src, full: runs.full, head: runs.head, ...fields, seamRule: input.seam, projectRule: input.project });
  // Emit only after green: every refusal above has already thrown.
  mkdirSync(outs.partsDir, { recursive: true });
  mkdirSync(dirname(outs.partsJson), { recursive: true });
  mkdirSync(dirname(outs.recomposite), { recursive: true });
  mkdirSync(dirname(outs.errorMap), { recursive: true });
  writeParts(outs.partsJson, result.parts);
  for (const { record, image } of result.images) writePng(join(outs.partsDir, `${record.name}.png`), image);
  writePng(outs.recomposite, result.recomposite);
  writePng(outs.errorMap, result.errorMap);
  const [W, H] = result.parts.rig_size;
  log(`rig-parts assemble: ${result.images.length} part(s) on a ${W}x${H} rig (${result.parts.scale_rig_per_source} rig px per source px), seam rule ${result.seamRule}, projection rule ${result.projectRule}`);
  for (const p of result.parts.parts) {
    log(
      `  ${p.name.padEnd(11)} ${p.from.padEnd(16)} ${`${p.w}x${p.h}`.padEnd(9)} @${String(p.x).padStart(4)},${String(p.y).padStart(4)} ` +
        `op=${String(p.opaque_px).padStart(6)} vis=${String(p.visible_px).padStart(6)} src=${String(p.source_px_taken).padStart(6)}/${String(p.projected_core_px).padStart(6)} ` +
        `unproj=${String(p.visible_not_projected_px).padStart(5)} drift=${String(p.refused_drift_px).padStart(5)} merged=${p.merged_px} seam=${p.seam_override_px}`,
    );
  }
  for (const l of fringeLines(result.parts.parts)) log(l);
  const total = (k: 'opaque_px' | 'visible_px' | 'occluded_px' | 'source_px_taken' | 'visible_not_projected_px'): number => result.parts.parts.reduce((a, p) => a + (p[k] ?? 0), 0);
  const [op, vis, occ, taken, unproj] = (['opaque_px', 'visible_px', 'occluded_px', 'source_px_taken', 'visible_not_projected_px'] as const).map(total);
  const pct = (n: number): string => `${((100 * n) / op).toFixed(1)}%`;
  log(
    `  pixels: opaque ${op} = visible ${vis} + occluded ${occ} (${pct(occ)}); taken from the painting ${taken} (${pct(taken)}); ` +
      `visible but not projected ${unproj} (${pct(unproj)})`,
  );
  const ghosts = Object.values(result.parts.ghost_px).reduce((a, b) => a + b, 0);
  log(`  ghost px removed: ${ghosts} over ${Object.keys(result.parts.ghost_px).length} layer(s)`);
  log(figuresLine(result.figures));
  for (const l of holeLines(result.figures)) log(l);
  log(`wrote ${outs.partsJson}, ${result.images.length} PNG(s) in ${outs.partsDir}, ${outs.recomposite}, ${outs.errorMap} (uncovered error px red, covered error px blue, the painting grey)`);
  return result;
}

// ---------------------------------------------------------------------------
// rig
// ---------------------------------------------------------------------------

export interface GateRun {
  label: string;
  status: number;
  /**
   * rigc's FAIL lines, its assertion summary, the core entry's `here:` line and
   * the one SKIP this stage's own declaration causes, as it printed them — or,
   * for a run that exited non-zero with none of those, the lines
   * {@link causeLines} says name why.
   */
  lines: string[];
}

/**
 * `A15_IDLE_NO_MESH_BONE_KEYS`'s SKIP under `invariants.idleDrivesMeshes` —
 * the line in which rigc states what `--idle-keys direct` declared and what it
 * costs. It is the one SKIP the rig stage prints: every other SKIP is a check
 * with nothing to measure, while this one is switched off by a field this
 * stage wrote, so it is shown rather than folded into the skipped count.
 */
const DECLARED_SKIP = /^ {2}SKIP {2}A15_IDLE_NO_MESH_BONE_KEYS: declared by the rig/;

/** The core entry's line after its summary (rig-c 2.0.0 and later): which rules ran, and that the round trip did not. */
const HERE_LINE = /^ {2}\.\. {4}here: /;

function gateRun(label: string, rigc: RigcRunner, args: string[]): GateRun {
  const r = rigc(args);
  const lines = r.out.split('\n').filter((l) => /^ {2}FAIL {2}/.test(l) || /assertions: \d+ measured/.test(l) || /^rigc compile error/.test(l) || DECLARED_SKIP.test(l) || HERE_LINE.test(l));
  const failed = lines.some((l) => /^ {2}FAIL {2}/.test(l) || /^rigc compile error/.test(l));
  return { label, status: r.status, lines: r.status !== 0 && !failed ? [...lines, ...causeLines(r.out)] : lines };
}

/**
 * The motion gate's reference build (issue #135): rigc's `build` under the
 * spine-html profile and nothing else — the same gate over the compile that
 * the candidate's build runs, without `--pack`. Its model document is all the
 * comparison reads, and it differs from a packed build's only in where the
 * atlas puts each region (its `pages`), which rig-c's comparison
 * allowlists as atlas layout; the pages a reference would pack are never
 * written anywhere, so packing them was work nobody read. No render is asked
 * of rigc by either build.
 */
export const REFERENCE_BUILD_ARGS: readonly string[] = ['--profile', 'spine-html'];

/** The reference build's label, as the rig stage prints it. */
export const REFERENCE_BUILD_LABEL = `build ${REFERENCE_BUILD_ARGS.join(' ')}`;

/**
 * rig-c's gate over the rig in a scratch directory: `build` under the
 * spine-html profile with `--pack --page-edges <edges> --pack-shape <shape>`, which runs the gate
 * once over the compile and once over the packed pages on disk. There is no
 * second `validate --profile spine` run: spine-html holds every rule spine
 * measures (selftest `CH09`). The files are staged exactly as `--out` will
 * receive them, so what passed is what is written. The scratch directory is
 * the caller's, and is emptied here before and after. `images` are the PNG
 * files' bytes as `--out` will receive them: the rig stage's are its rasters
 * encoded as `writePng` encodes them, `compose`'s the builds' own files.
 * `mode` null is the motion gate's reference ({@link REFERENCE_BUILD_ARGS}):
 * the same gate over the compile, nothing packed; its build directory sits
 * where a packed one would, so every relative path in its model document is
 * the candidate's.
 */
export function gateThroughRigc(
  images: ReadonlyArray<readonly [string, Uint8Array]>,
  texts: ReadonlyArray<readonly [string, string]>,
  rigc: RigcRunner,
  scratch: string,
  mode: PackMode | null,
  onGreen?: (buildDir: string) => void,
): GateRun[] {
  rmSync(scratch, { recursive: true, force: true });
  try {
    mkdirSync(join(scratch, 'images'), { recursive: true });
    for (const [file, bytes] of images) writeFileSync(join(scratch, 'images', file), bytes);
    for (const [file, text] of texts) writeFileSync(join(scratch, file), text);
    const build = join(scratch, 'build');
    const label = mode === null ? REFERENCE_BUILD_LABEL : packedBuildLabel(mode);
    const args = mode === null ? [...REFERENCE_BUILD_ARGS] : packedBuildArgs(mode);
    const runs = [gateRun(label, rigc, ['build', '--rig', join(scratch, 'rig.json'), '--motion', join(scratch, 'motion.json'), '--out', build, ...args])];
    // What the caller reads off a green build before the scratch is emptied (the motion gate's model document); nothing for a red one.
    if (onGreen !== undefined && runs.every((g) => g.status === 0)) onGreen(build);
    return runs;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * What only this package can add to rigc's refusal of a two-bone ik a control
 * splits (issue #103). Under `--idle-keys ctl` a chain link the idle keys is
 * keyed through a same-origin `<link>_ctl` parent, so a config's ik over that
 * link and the link above it names a pair whose second bone is not the
 * first's child; rig-c 2.15.0's rig-spec parser refuses it by name
 * (firejune/rigc#1205), with `("<link>_ctl" stands between)` in its sentence
 * and a remedy a config cannot follow — a config cannot name the control.
 *
 * This reads rigc's verdict and checks no rule of its own: for each control
 * the stage added, a rigc line saying that control, and only it, stands
 * between gets one sentence naming the flag on the command that ran. The ik
 * shape is rigc's to judge; a pair split by a control and by a bone the config
 * declares (`"…_ctl", "…" stand between`) gets nothing, because
 * `--idle-keys direct` would not make it a parent and its child. Should rigc
 * reword its sentence, rigc's refusal still reaches the author and only this
 * sentence is lost; the selftest holds it on the installed rigc (`RG56`).
 */
export function ctlRemedies(lines: readonly string[], controls: readonly string[], command: RigCommand): string[] {
  const out: string[] = [];
  for (const bone of controls) {
    const ctl = `${bone}${CONTROL_SUFFIX}`;
    if (!lines.some((l) => l.includes(`("${ctl}" stands between)`))) continue;
    out.push(`"${ctl}" is the control this stage keys "${bone}" through under --idle-keys ctl, and a config cannot name it: run \`${command} --idle-keys direct\`, which keys "${bone}" in place, so no control stands between "${bone}" and its parent`);
  }
  return out;
}

export interface RigStageInput {
  config: string;
  /** The directory holding parts.json and parts/<name>.png. */
  parts: string;
  out: string;
  /** Where the idle's keys on mesh-driving bones go; `ctl` when absent. See `IDLE_KEYS` in `src/rig.ts`. */
  idleKeys?: IdleKeys;
  /** The gate build's `--page-edges`; {@link DEFAULT_PAGE_EDGES} when absent. The pack is scratch here; the gate is what it is for. */
  pageEdges?: PageEdges;
  /** The gate build's `--pack-shape`; {@link DEFAULT_PACK_SHAPE} when absent. */
  packShape?: PackShape;
  /** The command running the stage, which {@link ctlRemedies} names beside the flag; `rig` when absent. It moves no byte written. */
  command?: RigCommand;
  /**
   * How `buildRig` runs each automatic part's reduction (`src/automesh.ts`);
   * `runReduction` when absent. A caller that already ran the reduction on the
   * same input hands `reuseReductions` over it (`tools/auto_matrix.ts`), so the
   * same `reduceMesh` call is not run twice (issue #135). It moves no byte
   * written: the same input is the same result.
   */
  reduce?: Reducer;
}

/** One automatic part's motion gate, as the rig stage ran it (`src/automotion.ts`). */
export interface MotionGateRun {
  part: string;
  /** The reference build through rigc's gate — null when the part was refused before anything was compiled. */
  reference: GateRun | null;
  /** rig-c's `compare` report — null when the comparison did not run or refused its input. */
  report: MeshQualityReport | null;
  /** What refuses the part; empty when it is accepted. */
  problems: Problem[];
  /** Why no comparison ran, for the mesh line; null when one ran. */
  notCompared: string | null;
  /** The reference build's model document, read off its green build; null when it was not built or is red. Nothing writes it. */
  referenceModel: string | null;
}

/** The model document a green gate build wrote, or null. */
function modelAt(buildDir: string): string | null {
  const path = join(buildDir, RIGC_MODEL_DOCUMENT);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * The motion gate of every automatic part (issue #126, item 3): for each, the
 * reference rig — `rig` with that part's attachment swapped for its unreduced
 * source and nothing else — through rigc's gate ({@link REFERENCE_BUILD_ARGS}:
 * the stage's `build` under spine-html, without packing, issue #135), then
 * rig-c's comparison of its `skeleton.model.json` with the candidate's
 * (`candidateModel`, the stage's own gate build). A part refused before
 * compiling (no `motion`, no stimulus) costs no build.
 */
export function motionGates(
  rig: RigOutput,
  images: ReadonlyArray<readonly [string, Uint8Array]>,
  texts: ReadonlyArray<readonly [string, string]>,
  candidateModel: string | null,
  rigc: RigcRunner,
  scratch: string,
  schedules: ReadonlyMap<string, MotionSchedule> = new Map(),
): MotionGateRun[] {
  return rig.autoMotion.map((c: AutoMotionCase): MotionGateRun => {
    const out = (over: Partial<MotionGateRun>): MotionGateRun => ({ part: c.part, reference: null, report: null, problems: [], notCompared: null, referenceModel: null, ...over });
    if (c.motion === undefined) {
      return out({
        problems: [{ code: 'CONFIG_FIELD_PRESENT', object: `${c.object}.motion`, detail: 'is absent and required; an automatic mesh is accepted only when its motion is measured and passes (issue #126 item 3)' }],
        notCompared: 'no motion bounds',
      });
    }
    const stim = motionStimulus(rig.rig.bones, rig.motion, c.boundBones);
    if (stim.by.length === 0) return out({ problems: [noStimulusProblem(c, stim.keyed)], notCompared: 'no stimulus' });
    if (candidateModel === null) {
      return out({
        problems: [{ code: 'AUTO_MESH_MOTION_INPUT', object: c.object, detail: `the rig stage's gate build wrote no ${RIGC_MODEL_DOCUMENT}, so there is no candidate document to compare; rigc's build writes one beside every green build` }],
        notCompared: `no candidate ${RIGC_MODEL_DOCUMENT}`,
      });
    }
    const refRig = JSON.parse(rigJsonText(rig.rig)) as RigSpec;
    refRig.skins.default[c.part] = { [c.part]: c.reference };
    const refTexts = texts.map(([file, text]) => [file, file === 'rig.json' ? rigJsonText(refRig) : text] as const);
    let refModel: string | null = null;
    const [gate] = gateThroughRigc(images, refTexts, rigc, scratch, null, (dir) => {
      refModel = modelAt(dir);
    });
    if (gate.status !== 0 || refModel === null) {
      return out({
        reference: gate,
        problems: [
          {
            code: 'AUTO_MESH_MOTION_INPUT',
            object: c.object,
            detail: `the reference (the rig with "${c.part}" as its unreduced source mesh) ${gate.status !== 0 ? `is refused by rigc's gate, exit ${gate.status}${gate.lines.length > 0 ? `: ${gate.lines.map((l) => l.trim()).join(' | ')}` : ''}` : `built green and wrote no ${RIGC_MODEL_DOCUMENT}`}; a reference that is not gated is not evidence, and nothing is built in the part's place`,
          },
        ],
        notCompared: 'the reference build is red',
      });
    }
    const ran = runComparison(c.object, motionInput(c, c.motion, refModel, candidateModel, schedules.get(c.part)));
    if ('code' in ran) return out({ reference: gate, problems: [ran], notCompared: 'rig-c refused the input', referenceModel: refModel });
    const verdict = motionVerdict(c.object, ran);
    return out({ reference: gate, report: ran, problems: verdict === null ? [] : [verdict], referenceModel: refModel });
  });
}

/** The mesh report as written: each automatic row with the motion gate's rows in place of "unmeasured", and its `compare` document after `quality_report`. */
export function withMotion(rows: readonly MeshReport[], runs: readonly MotionGateRun[], cases: readonly AutoMotionCase[], replays: ReadonlyMap<string, ReplayRow | MultiIntervalRow> = new Map()): MeshReport[] {
  return rows.map((m) => {
    if (!('mode' in m) || m.mode !== 'auto') return m;
    const run = runs.find((r) => r.part === m.part);
    const c = cases.find((x) => x.part === m.part);
    if (run === undefined || run.report === null || c === undefined || c.motion === undefined) return m;
    const replay = replays.get(m.part);
    if (replay === undefined) {
      const row: AutoMeshReport = { ...m, deformation: motionDeformation(c.motion, run.report), motion_report: motionDocument(run.report) };
      return row;
    }
    // A replayed part's row carries `replay` just before `deformation`; every other key keeps its place.
    const { deformation: _unmeasured, quality_report: quality, ...head } = m;
    const row: AutoMeshReport = { ...head, replay, deformation: motionDeformation(c.motion, run.report), quality_report: quality, motion_report: motionDocument(run.report) };
    return row;
  });
}

/** One automatic part's acceptance loop after the gate refused its full result (`src/autoreplay.ts`): the step chosen, or the problem. */
export interface ReplaySearchRun {
  part: string;
  /** The replay to write, the grid frame ids it was chosen on and the search's figures; null when the part is refused. */
  chosen: {
    candidate: ReplayCandidate;
    grid: string[];
    row: Omit<ReplayRow, 'selection' | 'held_out'> | Omit<MultiIntervalRow, 'selection' | 'held_out'>;
    /** The multi-interval search only (issue #148): every frame id any probe's comparison walked, for the final roles check. */
    probeFrames?: string[];
  } | null;
  problems: Problem[];
  /** What the stage prints about the search. */
  lines: string[];
}

/**
 * The search of one automatic part (`src/autoreplay.ts`, module header): the
 * source compared with itself on the grid frames first — a source the gate
 * would refuse leaves the part refused as the full result was, and no search
 * runs — then a bisection over the removal steps of the full run's
 * `acceptedAt`. Each probe replays a step (`AutoSearch.replay`, pure), puts it
 * into `rig` alone, builds that rig through rigc's gate without packing (the
 * reference's build, {@link REFERENCE_BUILD_ARGS}) and compares it with the
 * reference on the grid frames alone ({@link selectionSchedule}). A replay
 * that breaks rig-c's promise, a red build or a refused comparison refuses the
 * part; a replay that keeps the promise and misses a geometry target is a probe
 * that did not pass.
 */
export function replaySearch(
  rig: RigOutput,
  c: AutoMotionCase,
  run: MotionGateRun,
  images: ReadonlyArray<readonly [string, Uint8Array]>,
  texts: ReadonlyArray<readonly [string, string]>,
  rigc: RigcRunner,
  scratch: string,
): ReplaySearchRun {
  const lines: string[] = [];
  const refuse = (p: Problem): ReplaySearchRun => ({ part: c.part, chosen: null, problems: [p], lines });
  if (c.motion === undefined || run.report === null || run.referenceModel === null) return { part: c.part, chosen: null, problems: run.problems, lines };
  const motion = c.motion;
  const refModel = run.referenceModel;
  const grid = gridFrameIds(run.report);
  const N = c.search.acceptedAt.length;
  const I = c.search.inserted;
  const fullLocal = localRow(run.report);
  const fullReading = fullLocal === null ? null : { value: fullLocal.value, state: fullLocal.state, frame: fullLocal.worst?.frame?.id ?? null };
  const fullText = `reads ${failingRows(run.report).map(motionRowText).join('; ') || 'no failing row'}`;
  // Step 0: the source against itself on the selection frames. It reads no motion; a geometry row it fails leaves the part refused as today.
  const self = runComparison(c.object, motionInput(c, motion, refModel, refModel, selectionSchedule(grid)));
  if ('code' in self) return refuse(self);
  if (motionVerdict(c.object, self) !== null) {
    lines.push(`replay "${c.part}": the unreduced source is not accepted against itself on the grid frames; no search runs`);
    return { part: c.part, chosen: null, problems: run.problems, lines };
  }
  const selection = motion.selection;
  if (selection !== undefined && selection.maxProbes < maxReplays(N, I)) return refuse(budgetProblem(c.object, selection.maxProbes, N, I));
  const kept = new Map<number, ReplayCandidate>();
  const probeFrames: string[] = [];
  let fatal: Problem | null = null;
  let candidatesTried = 0;
  const counted = (step: number): CountedProbe => {
    const refused = (reason: string): CountedProbe => ({ step, verdict: 'refused', value: null, frame: null, reason, vertices: null });
    if (fatal !== null) return refused('the search was refused at an earlier step');
    const rep = c.search.replay(step);
    if ('code' in rep) {
      if (rep.code !== 'AUTO_MESH_ACCEPTED') fatal = rep;
      return refused(rep.code);
    }
    candidatesTried += rep.candidatesTried;
    const candRig = JSON.parse(rigJsonText(rig.rig)) as RigSpec;
    candRig.skins.default[c.part] = { [c.part]: rep.attachment };
    const candTexts = texts.map(([file, text]) => [file, file === 'rig.json' ? rigJsonText(candRig) : text] as const);
    let model: string | null = null;
    const [gate] = gateThroughRigc(images, candTexts, rigc, scratch, null, (dir) => {
      model = modelAt(dir);
    });
    if (gate.status !== 0 || model === null) {
      fatal = {
        code: 'AUTO_MESH_MOTION_INPUT',
        object: c.object,
        detail: `the replay to accepted step ${step} (the rig with "${c.part}" as that step's mesh) ${gate.status !== 0 ? `is refused by rigc's gate, exit ${gate.status}${gate.lines.length > 0 ? `: ${gate.lines.map((l) => l.trim()).join(' | ')}` : ''}` : `built green and wrote no ${RIGC_MODEL_DOCUMENT}`}; a candidate that is not gated is not evidence, and nothing is built in the part's place`,
      };
      return refused(`rigc exit ${gate.status}`);
    }
    const cmp = runComparison(c.object, motionInput(c, motion, refModel, model, selectionSchedule(grid)));
    if ('code' in cmp) {
      fatal = cmp;
      return refused(cmp.code);
    }
    const r = localRow(cmp);
    const pass = motionVerdict(c.object, cmp) === null;
    if (pass) kept.set(step, rep);
    for (const f of cmp.candidates[0]?.motion?.schedule.walked ?? []) probeFrames.push(f.id);
    return { step, verdict: pass ? 'pass' : 'fail', value: r?.value ?? null, frame: r?.worst?.frame?.id ?? null, reason: null, vertices: rep.row.vertices };
  };
  if (selection !== undefined) return multiIntervalRun(c, selection.maxProbes, N, I, counted, () => fatal, kept, grid, probeFrames, fullReading, fullText, () => candidatesTried, lines);
  // The bisection, the stage as it was before issue #148: a probe carries no vertex count.
  const probe = (step: number): ReplayProbe => {
    const { vertices: _counted, ...p } = counted(step);
    return p;
  };
  const { chosen, probes } = bisectAccepted(I, N, probe);
  lines.push(
    `replay "${c.part}": bisection over the removal steps ${I + 1}..${N - 1} of ${N} accepted step(s), ${probes.length} replay(s) of at most ${maxReplays(N, I)}: ${probes.map((p) => `${p.step} ${p.verdict}${p.value === null ? '' : ` ${p.value}`}`).join(', ') || 'none'}`,
  );
  if (fatal !== null) return refuse(fatal);
  const candidate = kept.get(chosen);
  if (chosen <= I || candidate === undefined) return refuse(noReductionProblem(c.object, fullText, N, I, probes));
  return {
    part: c.part,
    chosen: {
      candidate,
      grid,
      row: { rule: REPLAY_RULE, accepted_steps: N, refinement_steps: I, chosen_step: chosen, replays: probes.length, max_replays: maxReplays(N, I), candidates_tried: candidatesTried, full: fullReading, probes },
    },
    problems: [],
    lines,
  };
}

/**
 * The multi-interval search of one automatic part (issue #148; `src/autoreplay.ts`, `multiIntervalSearch`), run by
 * {@link replaySearch} when the author wrote `motion.selection`: the same probe — a replay, an unpacked gated build, a
 * comparison on the grid frames alone — called once per distinct step, up to `maxProbes` replays; the fewest-vertex
 * candidate among the tested steps that passed is chosen, the lower step on a tie. The source (step I) and the full
 * result (step N) bound the domain and are never written; the bisection's own result is among the tested.
 */
function multiIntervalRun(
  c: AutoMotionCase,
  maxProbes: number,
  N: number,
  I: number,
  probe: (step: number) => CountedProbe,
  fatalOf: () => Problem | null,
  kept: ReadonlyMap<number, ReplayCandidate>,
  grid: string[],
  probeFrames: string[],
  full: MultiIntervalRow['full'],
  fullText: string,
  triedOf: () => number,
  lines: string[],
): ReplaySearchRun {
  const run = multiIntervalSearch(I, N, maxProbes, probe, () => fatalOf() !== null);
  const tested = [...new Set(run.probes.map((p) => p.step))].sort((a, b) => a - b);
  const pick = run.chosen;
  lines.push(
    `replay "${c.part}": multi-interval selection over the removal steps ${I + 1}..${N - 1} of ${N} accepted step(s), ${run.probes.length} replay(s) of at most ${maxProbes} (maxProbes), ended ${run.termination}: ` +
      `${run.probes.map((p) => `${p.step} ${p.verdict}${p.value === null ? '' : ` ${p.value}`}${p.vertices === null ? '' : ` v=${p.vertices}`}`).join(', ') || 'none'}; ` +
      `the bisection kept ${run.bisection <= I ? 'none' : `step ${run.bisection}`}; ${pick === null ? 'no tested step passed' : `the fewest vertices among the tested passing steps: step ${pick.step}, ${pick.vertices} vertices`} (best among tested candidates)`,
  );
  const fatal = fatalOf();
  if (fatal !== null) return { part: c.part, chosen: null, problems: [fatal], lines };
  const candidate = pick === null ? undefined : kept.get(pick.step);
  if (pick === null || candidate === undefined) return { part: c.part, chosen: null, problems: [noMultiReductionProblem(c.object, fullText, N, I, maxProbes, run.termination, run.probes)], lines };
  const counts = candidate.row.result.counts;
  return {
    part: c.part,
    chosen: {
      candidate,
      grid,
      probeFrames,
      row: {
        rule: MULTI_INTERVAL_RULE,
        policy: 'multi-interval',
        max_probes: maxProbes,
        accepted_steps: N,
        refinement_steps: I,
        chosen_step: pick.step,
        bisection_step: run.bisection,
        replays: run.probes.length,
        candidates_tried: triedOf(),
        termination: run.termination,
        tested,
        passing_intervals: passingIntervals(run.probes),
        untested_intervals: untestedIntervals(I, N, new Set(tested)),
        chosen: { vertices: candidate.row.vertices, boundary: counts.boundaryVertices, interior: counts.interiorVertices, triangles: candidate.row.triangles, bindings: counts.bindings },
        full,
        probes: run.probes,
        roles: { selection: 'grid', held_out: 'irr', probe_frames: new Set(probeFrames).size },
      },
    },
    problems: [],
    lines,
  };
}

/**
 * Author the rig, gate it through rigc in `scratch`, and write `out` only when
 * the gate is green — and, for every automatic mesh, only when its motion gate
 * accepted it (issue #126 item 3; {@link motionGates}).
 */
export function rigStage(input: RigStageInput, rigc: RigcRunner, scratch: string, log: Log): RigOutput {
  const { config: cfg, animations: from } = loadConfigAndAnimations(input.config);
  const parts = readParts(join(input.parts, 'parts.json'));
  const images = new Map<string, Raster>();
  for (const p of parts.parts) {
    const png = join(input.parts, 'parts', `${p.name}.png`);
    if (existsSync(png)) images.set(p.name, readPng(png));
  }
  const first = buildRig(cfg, parts, images, undefined, input.idleKeys ?? DEFAULT_IDLE_KEYS, input.reduce);
  const textsOf = (r: RigOutput): Array<[string, string]> => [
    ['rig.json', rigJsonText(r.rig)],
    ['motion.json', rigJsonText(withAnimations(r.motion, from === null ? null : from.table))],
    ['mesh_report.json', rigJsonText(r.meshReport)],
  ];
  const firstTexts = textsOf(first);
  // The gate runs before the lines are printed, and its lines print where they always did: an automatic part's motion
  // gate compares the model document of this very build, the one written (issue #126 item 3). mesh_report.json is staged
  // as buildRig wrote it; rigc reads only rig.json, motion.json and images/.
  const pngs = first.images.map(([file, img]) => [file, encodePngBytes(img)] as const);
  const mode: PackMode = { pageEdges: input.pageEdges ?? DEFAULT_PAGE_EDGES, packShape: input.packShape ?? DEFAULT_PACK_SHAPE };
  let firstModel: string | null = null;
  const firstGate = gateThroughRigc(pngs, firstTexts, rigc, scratch, mode, first.autoMotion.length === 0 ? undefined : (dir) => (firstModel = modelAt(dir)));
  const firstRed = firstGate.filter((g) => g.status !== 0);
  const firstMotion = firstRed.length > 0 ? [] : motionGates(first, pngs, firstTexts, firstModel, rigc, scratch);
  // The acceptance loop (src/autoreplay.ts): a part whose full result the motion gate refused, and only such a part, is
  // searched for a replayed step. Where no part is, nothing below runs and the stage is the one it always was.
  const searches = firstMotion
    .filter((r) => r.report !== null && r.problems.some((p) => p.code === 'AUTO_MESH_MOTION'))
    .map((r) => replaySearch(first, first.autoMotion.find((c) => c.part === r.part) as AutoMotionCase, r, pngs, firstTexts, rigc, scratch));
  const searched = new Set(searches.map((s) => s.part));
  const chosen = searches.flatMap((s) => (s.chosen === null ? [] : [{ part: s.part, ...s.chosen }]));
  const settled = searches.length > 0 && chosen.length === searches.length && firstMotion.every((r) => searched.has(r.part) || r.problems.length === 0);
  // Every part's search chose a step: the rig with those steps in place goes through the gate again, as written, and
  // each automatic part through the motion gate again — a chosen one on the whole idle with its grid frames as selection.
  let rig = first;
  let texts = firstTexts;
  let gate = firstGate;
  let motion: MotionGateRun[] = firstMotion.map((r) => (searched.has(r.part) ? { ...r, problems: searches.find((s) => s.part === r.part)?.problems ?? r.problems } : r));
  let finalGate: GateRun[] | null = null;
  let finalMotion: MotionGateRun[] = [];
  const replays = new Map<string, ReplayRow | MultiIntervalRow>();
  if (settled) {
    const swapped = JSON.parse(rigJsonText(first.rig)) as RigSpec;
    for (const k of chosen) swapped.skins.default[k.part] = { [k.part]: k.candidate.attachment };
    rig = { ...first, rig: swapped, meshReport: first.meshReport.map((m) => chosen.find((k) => k.part === m.part)?.candidate.row ?? m) };
    texts = textsOf(rig);
    let model: string | null = null;
    finalGate = gateThroughRigc(pngs, texts, rigc, scratch, mode, (dir) => (model = modelAt(dir)));
    gate = finalGate;
    finalMotion = gate.some((g) => g.status !== 0) ? [] : motionGates(rig, pngs, texts, model, rigc, scratch, new Map(chosen.map((k) => [k.part, splitSchedule(k.grid)])));
    motion = finalMotion.map((r) => {
      const k = chosen.find((x) => x.part === r.part);
      if (k === undefined || r.report === null) return r;
      const roles = roleReadings(r.report);
      replays.set(r.part, { ...k.row, selection: roles.selection, held_out: roles.held_out });
      // issue #148: a multi-interval choice holds its roles — no probe read a frame the final comparison holds out.
      const c = rig.autoMotion.find((x) => x.part === r.part) as AutoMotionCase;
      const leaked = k.probeFrames === undefined ? null : rolesProblem(c.object, k.row.chosen_step, k.probeFrames, r.report);
      if (leaked !== null) return { ...r, problems: [leaked] };
      if (!r.problems.some((p) => p.code === 'AUTO_MESH_MOTION')) return r;
      const held = finalVerdict(c.object, k.row.chosen_step, k.row.accepted_steps, r.report);
      return { ...r, problems: held === null ? [] : [held] };
    });
  }
  const red = gate.filter((g) => g.status !== 0);
  log(`rig-parts rig: ${cfg.key}, rig ${parts.rig_size[0]}x${parts.rig_size[1]}, ${parts.parts.length} part(s)`);
  let vertices = 0;
  for (const m of rig.meshReport) {
    vertices += m.vertices;
    const head = `  mesh ${m.part.padEnd(12)} v=${String(m.vertices).padStart(4)} t=${String(m.triangles).padStart(4)} hull=${String(m.hull).padStart(3)} `;
    const infl = `bones=${m.bones.length} infl max ${m.max_influences} mean ${m.mean_influences.toFixed(2)} cover ${m.art_coverage.toFixed(5)}`;
    if ('mode' in m && m.mode === 'auto') {
      const s = m.source.counts;
      const r = m.result.counts;
      const t = m.termination;
      const tried = t.reason === 'no-further-valid-reduction' || t.reason === 'budget-exhausted' || t.reason === 'replayed-to-accepted-step' ? ` after ${t.candidatesTried} candidate(s)` : '';
      const worst = m.worst_residual === null ? 'none declared' : `${m.worst_residual.code}${m.worst_residual.region === null ? '' : `[${m.worst_residual.region}]`} ${m.worst_residual.value} ${m.worst_residual.bound?.op} ${m.worst_residual.bound?.value}`;
      const from = s === null ? 'unread' : `${s.boundaryVertices}+${s.interiorVertices}`;
      const run = motion.find((x) => x.part === m.part);
      const moved = run === undefined ? 'motion not compared (the gate is red)' : run.report !== null ? motionClause(run.report) : `motion not compared (${run.notCompared ?? 'refused'})`;
      const rp = replays.get(m.part);
      const replayed =
        rp === undefined || run?.report === null || run === undefined
          ? ''
          : `; replayed to accepted step ${rp.chosen_step} of ${rp.accepted_steps} after ${rp.replays} replay(s); selection ${readingText(rp.selection, roleReadings(run.report).bound)}; held out ${readingText(rp.held_out, roleReadings(run.report).bound)}`;
      log(`${head}auto ${from} -> ${r.boundaryVertices}+${r.interiorVertices} (hull+interior) bindings ${r.bindings} ${infl} ${t.reason}${tried}; worst ${worst}${unboundedClause(m.residuals, m.settings.targets.artFit)}${allocationClause(m.residuals)}${stageBClause(m.settings, m.result)}${residualClause(m.skinning_residual)}${strayClause(m.stray_cleared)}; ${moved}${replayed}`);
    } else if ('mode' in m) {
      const c = m.contour;
      const stray = c.strayIslands === 0 ? '' : ` left out ${c.strayIslands} island(s), ${c.strayPixels} px`;
      const regions = m.regions.map((rg) => ` region ${rg.name}->${rg.bone} reaches ${rg.reached} (${rg.whole} whole)`).join('');
      log(`${head}contour tol=${m.params.tolerance} margin=${m.params.margin} spacing=${m.params.spacing} ${infl} overshoot ${c.overshoot} min angle ${c.smallestAngle.value}${stray}${regions}`);
    } else log(`${head}grid=${m.grid} ${infl} loop passes ${rig.loopPasses[m.part]}`);
  }
  const regions = rig.rig.slots.length - rig.meshReport.length;
  const tracks = rig.motion.animations.idle.tracks;
  const keys = tracks.reduce((n, t) => n + t.keys.length, 0);
  log(
    `  bones ${rig.rig.bones.length} (${rig.controls.length} control) slots ${rig.rig.slots.length} meshes ${rig.meshReport.length} regions ${regions} vertices ${vertices}; idle ${rig.motion.animations.idle.duration} s, ${tracks.length} track(s), ${keys} key(s)`,
  );
  if (from !== null) log(`  animations beside the idle, from ${from.file} as written: ${Object.keys(from.table).join(', ') || 'none'}`);
  log(
    rig.idleKeys === 'ctl'
      ? `  idle keys ctl: ${rig.meshKeyed.length} mesh-driving bone(s) keyed by the idle, each keyed through a same-origin <bone>_ctl parent`
      : `  idle keys direct: ${rig.meshKeyed.length} mesh-driving bone(s) keyed in place, ${rig.rig.invariants === undefined ? 'so no invariants.idleDrivesMeshes is declared (it would switch nothing off)' : 'invariants.idleDrivesMeshes declared'}`,
  );
  for (const g of firstGate) {
    log(`  rigc ${g.label}: exit ${g.status}`);
    for (const l of g.lines) log(`    ${l.trim()}`);
  }
  for (const r of firstMotion) {
    if (r.reference === null) continue;
    log(`  rigc ${r.reference.label}, reference "${r.part}" (its unreduced source mesh): exit ${r.reference.status}`);
    for (const l of r.reference.lines) log(`    ${l.trim()}`);
  }
  for (const s of searches) for (const l of s.lines) log(`  ${l}`);
  if (finalGate !== null) {
    for (const g of finalGate) {
      log(`  rigc ${g.label}, the rig with its replayed step(s): exit ${g.status}`);
      for (const l of g.lines) log(`    ${l.trim()}`);
    }
    for (const r of finalMotion) {
      if (r.reference === null) continue;
      log(`  rigc ${r.reference.label}, reference "${r.part}" against the rig with its replayed step(s): exit ${r.reference.status}`);
      for (const l of r.reference.lines) log(`    ${l.trim()}`);
    }
  }
  if (red.length > 0) {
    const problems: Problem[] = red.map((g) => ({
      code: 'RIG_RIGC_GREEN',
      object: `rigc ${g.label}`,
      detail: `exited ${g.status}${g.lines.length > 0 ? `: ${g.lines.map((l) => l.trim()).join(' | ')}` : ', and it printed nothing'}; ${ctlRemedies(g.lines, rig.controls, input.command ?? 'rig').map((s) => `${s}; `).join('')}exit 0 is required before anything is written, and nothing was`,
    }));
    throw new PartsError(problems);
  }
  // Emit only after green: a part the motion gate did not accept refuses the stage, every part's problem named at once.
  refuseIfAny(motion.flatMap((r) => r.problems));
  if (motion.length > 0) {
    const rows = withMotion(rig.meshReport, motion, rig.autoMotion, replays);
    rig.meshReport.splice(0, rig.meshReport.length, ...rows);
    texts[2] = ['mesh_report.json', rigJsonText(rig.meshReport)];
  }
  mkdirSync(join(input.out, 'images'), { recursive: true });
  for (const [file, img] of rig.images) writePng(join(input.out, 'images', file), img);
  for (const [file, text] of texts) writeFileSync(join(input.out, file), text);
  log(`rig-parts rig: wrote ${join(input.out, 'rig.json')}, motion.json, mesh_report.json and ${rig.images.length} image(s) under ${join(input.out, 'images')}`);
  return rig;
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

export interface CheckStageInput {
  /** The directory holding rig.json and motion.json. */
  rig: string;
  /**
   * The directory holding parts.json and parts/ (`--parts`). Absent, it is the
   * rig directory, where a missing parts.json is measured without (issue #77);
   * named, a missing one is refused.
   */
  parts?: string;
  out: string;
  /** The painting `--source` names (issue #77): adds the setup pose against it. */
  source?: string;
  /** The packed build's `--page-edges`; {@link DEFAULT_PAGE_EDGES} when absent. */
  pageEdges?: PageEdges;
  /** The packed build's `--pack-shape`; {@link DEFAULT_PACK_SHAPE} when absent. */
  packShape?: PackShape;
  /** The scene's declared requirements (`--requirements`, issue #93); absent, nothing is read, written or printed for them. */
  requirements?: string;
}

/**
 * What a declared `source.stray` cleared, as the rig stage prints it on the part's mesh line (issue #172): empty when
 * nothing was declared or nothing was left out, so such a line prints what it always printed.
 */
export function strayClause(cleared: StrayCleared | undefined): string {
  if (cleared === undefined || cleared.islands === 0) return '';
  return `; stray cleared ${cleared.islands} island(s), ${cleared.pixels} of ${cleared.art_pixels} art px, from the art every reader of the mesh takes (the image is drawn as assembled)`;
}

/** The pack line as it is printed: rigc's own, then the page's opaque share beside the spineboy yardstick. */
export function packLines(r: CheckReport): string[] {
  if (r.pack.length === 0) return ['pack: no pack line in the build output'];
  return r.pack.map((p) => {
    const op = r.packOpaque.find((o) => o.page === p.page);
    return `${p.line}; page opaque ${op === undefined ? 'not measured (page not on disk)' : `${(op.share * 100).toFixed(1)}%`} (alpha > 0) — spineboy yardstick ${SPINEBOY_YARDSTICK}, a reference and not a bar`;
  });
}

function showFigure(v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? 'none' : v.map(showFigure).join(' | ');
  if (typeof v === 'object' && v !== null) return Object.entries(v).map(([k, x]) => `${k} ${showFigure(x)}`).join(', ');
  return String(v);
}

/**
 * How many of the {@link BARS} measured and how many said SKIP, by name — the
 * summary's second half (issue #77): `PASS` reads only the bars that measured,
 * so a run that measured one bar says so on the line that says PASS.
 */
export function barsSummary(r: CheckReport): string {
  const { measured, skipped } = r.bars;
  return `${measured.length} of ${BARS.length} bar(s) measured, ${skipped.length} skipped${skipped.length === 0 ? '' : ` (${skipped.map((s) => s.bar).join(', ')})`}`;
}

/** A judgement line as the console prints it: its name, its status, then its figures and bars as check.json holds them (a SKIP prints its reason). */
export function judgementLine(name: string, line: JudgementLine | ReportedLine): string {
  if (line.status === 'SKIP') return `${name}: SKIP — ${String(line.reason)}`;
  return `${name}: ${line.status} — ${Object.entries(line)
    .filter(([k]) => k !== 'status')
    .map(([k, v]) => `${k} ${showFigure(v)}`)
    .join('; ')}`;
}

/** A requirement's line as the console prints it: its name and status, the reason first when NOT MEASURABLE, then its figures as check.json holds them. */
export function requirementText(name: string, line: RequirementLine): string {
  const rest = Object.entries(line).filter(([k]) => k !== 'status' && k !== 'reason');
  return `${name}: ${line.status} — ${[...(line.status === 'NOT MEASURABLE' ? [String(line.reason)] : []), ...rest.map(([k, v]) => `${k} ${showFigure(v)}`)].join('; ')}`;
}

/**
 * Run the check and print its report. Returns the report; `figures.PASS` says
 * whether every bar was met, and each one that was not is printed as a FAIL
 * line here. Throws a PartsError when the check could not measure at all.
 */
export function checkStage(input: CheckStageInput, rigc: RigcRunner, bin: string, log: Log): CheckReport {
  const v = rigc(['--version']);
  log(`rig-parts check: ${input.rig} -> ${input.out}`);
  const versionLines = v.out.trim().split('\n');
  const entryLine = versionLines.find((l) => l.startsWith('entry:'));
  log(`  rigc ${versionLines[0]} at ${bin}${entryLine === undefined ? '' : `; ${entryLine}`}`);
  const mode: PackMode = { pageEdges: input.pageEdges ?? DEFAULT_PAGE_EDGES, packShape: input.packShape ?? DEFAULT_PACK_SHAPE };
  const r = runCheck(input.rig, input.out, rigc, input.parts, mode, input.source, input.requirements);
  log(`  gate spine-html (rigc ${packedBuildLabel(mode)}), verbatim:`);
  for (const l of r.gateHtml) log(l);
  for (const l of packLines(r)) log(`  ${l}`);
  const fig = r.figures;
  if (r.idle === null) log(`  loop: SKIP — ${fig.skipped?.loop ?? ''}`);
  else log(`  loop: idle ${r.idle.frames} frame(s) at ${r.idle.fps} fps, f0000 vs f${String(r.idle.lastIndex).padStart(4, '0')} (t = ${r.idle.duration}s): max |d| ${fig.loop_max_diff} (0 required)`);
  if (r.loopPhysics !== null) log(`  ${r.loopPhysics}`);
  const beside = besideIdleLine(r.besideIdle);
  if (beside !== null) log(`  ${beside}`);
  if (r.seamViewport === null || fig.seam_mean === null) log(`  seam: SKIP — ${fig.skipped?.seam ?? ''}`);
  else {
    log(
      `  seam: setup pose at ${r.seamViewport.pixelWidth}x${r.seamViewport.pixelHeight}, scale ${r.seamViewport.scale.toFixed(4)}: mean |d| ${fig.seam_mean} (<= ${SEAM_MEAN_BAR.toFixed(1)}), ` +
        `${fig.seam_px_over_40} px over ${SEAM_PX_LEVEL} (<= ${SEAM_PX_BAR}), ${fig.seam_px_over_80} px over ${SEAM_PX_LEVEL_HIGH} (reported)`,
    );
  }
  for (const name of JUDGEMENT_LINES) log(`  ${judgementLine(name, fig[name])}`);
  for (const name of REPORTED_LINES) log(`  ${judgementLine(name, fig[name])}`);
  const vsSource = fig[SOURCE_LINE];
  if (vsSource !== undefined) log(`  ${judgementLine(SOURCE_LINE, vsSource)}`);
  if (r.requirements !== null) {
    for (const [name, line] of Object.entries(r.requirements.lines)) log(`  ${requirementText(name, line)}`);
    log(`  ${summaryText(r.requirements.summary)}`);
  }
  log(`  gate: spine-html ${fig.gate_spine_html_green ? 'green' : 'RED'} (${fig.rigc_entry.entry}${fig.rigc_entry.spine_core === null ? ', rigc\'s own validator' : `, the spine-core ${fig.rigc_entry.spine_core} round trip`})`);
  log(`  wrote ${r.written.map((w) => join(input.out, w)).join(', ')}, ${join(input.out, 'build')}/${r.idle === null ? '' : `, ${join(input.out, 'idle_frames')}/`}${r.requirements === null ? '' : `, ${join(input.out, REQUIREMENTS_DIR)}/`}`);
  for (const p of r.problems) log(`  FAIL  ${problemLine(p)}`);
  const reqNotPass = r.requirements === null ? 0 : r.requirements.summary.declared - r.requirements.summary.pass;
  const notMet = r.requirements === null ? `${r.problems.length} bar(s) not met` : `${r.problems.length - reqNotPass} bar(s) not met, ${reqNotPass} declared requirement(s) not PASS`;
  log(`${fig.PASS ? 'check: PASS' : `check: FAIL — ${notMet}`}; ${barsSummary(r)}`);
  return r;
}

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------

function sameRgba(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The loop file's format: `apng` is the lossless APNG, the exactness record;
 * `indexed` the colour-type-3 APNG with one shared palette, the README-sized
 * file; `gif` the GIF89a. The CLI picks it from the extension and `--palette`.
 */
export type LoopFormat = 'apng' | 'indexed' | 'gif';

export interface LoopResult {
  bytes: number;
  /** The palette error over every encoded frame; null for the lossless APNG, which has none. */
  error: PaletteError | null;
}

/**
 * Encode a rigc frame set as a looping APNG, indexed APNG or GIF and write it.
 * An encoder refusal is a PartsError coded `LOOP_ENCODE`, so it prints like
 * every other.
 */
export function loopStage(frames: string, out: string, format: LoopFormat, log: Log): LoopResult {
  const set = readFrameSet(frames);
  const images = set.frames.map((fr) => fr.image);
  log(`rig-parts loop: ${set.dir} -> ${out}`);
  log(`  ${images.length} frame(s) ${images[0]?.width ?? 0}x${images[0]?.height ?? 0} at ${set.fps} fps (from frames.json), animation ${set.animation ?? '(none)'}`);
  let used = images;
  const lastName = set.frames[set.frames.length - 1]?.name ?? '';
  if (images.length > 1 && sameRgba(images[0].data, images[images.length - 1].data)) {
    used = images.slice(0, -1);
    log(`  ${lastName} equals f0000.png byte for byte, so it is dropped: the loop wraps onto frame 0, and showing it twice would hold that pose for two ticks`);
  } else if (images.length > 1) {
    log(`  ${lastName} differs from f0000.png, so every frame is kept and the loop will jump at the wrap`);
  }
  const anim: AnimFrame[] = used.map((image) => ({ image, ticks: 1 }));
  log(`  ${anim.length} frame(s) encoded, ${(anim.length / set.fps).toFixed(3)}s per loop, looping forever`);
  try {
    if (format === 'apng') {
      const { bytes, stats } = encodeApng(anim, set.fps);
      writeFileSync(out, bytes);
      log(`  APNG: ${stats.frames} frame(s) after merging identical neighbours, ${stats.overFrames} of ${Math.max(0, stats.frames - 1)} later frame(s) blended OVER with unchanged pixels cleared, lossless`);
      log(`  wrote ${out}: ${stats.bytes} bytes`);
      return { bytes: stats.bytes, error: null };
    }
    if (format === 'indexed') {
      const { bytes, stats } = encodeIndexedApng(anim, set.fps);
      writeFileSync(out, bytes);
      log(
        `  indexed APNG: ${stats.frames} frame(s) after merging, ${stats.overFrames} of ${Math.max(0, stats.frames - 1)} later frame(s) blended OVER; ${stats.entries} palette entries (1 transparent, ${stats.entries - 1} cut from ${stats.distinct} distinct), ${stats.bitDepth}-bit, ${INDEXED_DEFAULTS.dither ? 'Floyd–Steinberg dithering' : 'no dithering'}, filter ${INDEXED_DEFAULTS.adaptiveFilter ? 'adaptive' : 'None'}`,
      );
      log(`  ${errorText(stats.all)}`);
      log(`  wrote ${out}: ${stats.bytes} bytes`);
      return { bytes: stats.bytes, error: stats.all };
    }
    const { bytes, stats } = encodeGif(anim, set.fps);
    writeFileSync(out, bytes);
    log(`  GIF: ${stats.frames} frame(s) after merging, ${stats.colours} palette colour(s) cut from ${stats.distinct} distinct, no dithering`);
    log(`  palette error (per channel, of 255): frame 0 max ${stats.frame0.max}, mean ${stats.frame0.mean.toFixed(3)}; all frames max ${stats.all.max}, mean ${stats.all.mean.toFixed(3)}`);
    log(`  wrote ${out}: ${stats.bytes} bytes`);
    return { bytes: stats.bytes, error: stats.all };
  } catch (err) {
    if (err instanceof EncodeError) throw new PartsError([{ code: 'LOOP_ENCODE', object: out, detail: err.message }]);
    throw err;
  }
}

/** A palette error as the loop lines print it: R, G, B per channel over every frame, and alpha. */
function errorText(e: PaletteError): string {
  return `palette error (per channel, of 255, all frames): max ${e.max}, mean ${e.mean.toFixed(3)}; alpha max ${e.alphaMax}`;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export interface BuildInput {
  config: string;
  source: string;
  full: string;
  head: string;
  out: string;
  seam: SeamRule;
  project: ProjectRule;
  loop: boolean;
  /** `--page-edges` for both packed builds, the rig stage's gate and the check's artifact. */
  pageEdges: PageEdges;
  /** `--pack-shape` for both packed builds, as `pageEdges`; {@link DEFAULT_PACK_SHAPE} when absent. */
  packShape?: PackShape;
  /** `--requirements`, forwarded to the check (issue #93): read before assemble runs, so a file check would refuse is refused first; absent, nothing moves. */
  requirements?: string;
  /** `--idle-keys`, forwarded to the rig stage as `rig` takes it (issue #95); {@link DEFAULT_IDLE_KEYS} when absent. */
  idleKeys?: IdleKeys;
}

/**
 * The rigc process for each stage: `rig` gates through one, `check` measures
 * through the other. `cli.ts` hands both the same runner, the `rigc` binary
 * rig-c's launcher answers for; they are two fields so a caller can tell
 * the stages' calls apart (the selftest counts them).
 */
export interface BuildRunners {
  rig: RigcRunner;
  check: RigcRunner;
  /** Where the check's rigc binary is, for its header line. */
  checkBin: string;
  /** A directory the rig stage may stage its gate in; emptied before and after. */
  scratch: string;
}

/** Every path `build` writes under `--out`, relative — and so every path it clears first. */
export const BUILD_OWNS: readonly string[] = ['parts', 'parts.json', 'recomposite_rig.png', ERROR_MAP_FILE, 'rig', 'check', 'idle.gif', 'idle.png', 'idle-indexed.png'];

export type BuildStage = 'assemble' | 'rig' | 'check' | 'loop' | 'artifact';

export interface BuildResult {
  /** The stage that refused, or null when the build is green. */
  stoppedAt: BuildStage | null;
  check: CheckReport | null;
  /** The artifact's paths, on green: skeleton JSON, atlas, then each packed page. */
  artifact: string[];
}

/**
 * rigc's own record of the compiled rig, which `build` writes beside the
 * skeleton JSON and atlas (rig-c's AUTHORING, the `--out` row; written
 * since 1.6): what rigc's posing core reads, not a Spine file, so it is not the
 * artifact and is not counted as a second skeleton JSON.
 */
export const RIGC_MODEL_DOCUMENT = 'skeleton.model.json';

/** The three artifact files of a packed build, each refused by name when absent. */
export function artifactPaths(buildDir: string, pack: readonly PackLine[]): string[] {
  const problems: Problem[] = [];
  const names = existsSync(buildDir) ? readdirSync(buildDir).sort() : [];
  const json = names.filter((n) => n.endsWith('.json') && n !== RIGC_MODEL_DOCUMENT);
  const atlas = names.filter((n) => n.endsWith('.atlas'));
  if (json.length !== 1) problems.push({ code: 'BUILD_ARTIFACT_PRESENT', object: `${buildDir} skeleton JSON`, detail: `holds ${json.length} .json file(s) [${json.join(', ')}]; the packed build writes exactly one besides rigc's ${RIGC_MODEL_DOCUMENT}` });
  if (atlas.length !== 1) problems.push({ code: 'BUILD_ARTIFACT_PRESENT', object: `${buildDir} atlas`, detail: `holds ${atlas.length} .atlas file(s) [${atlas.join(', ')}]; the packed build writes exactly one` });
  if (pack.length === 0) problems.push({ code: 'BUILD_ARTIFACT_PRESENT', object: `${buildDir} packed page`, detail: 'rigc printed no pack line, so no packed page is named; the build runs with --pack and must print one' });
  for (const p of pack) {
    if (!names.includes(p.page)) problems.push({ code: 'BUILD_ARTIFACT_PRESENT', object: `${buildDir} packed page`, detail: `the pack line names ${p.page}, which is not on disk` });
  }
  if (problems.length > 0) throw new PartsError(problems);
  return [join(buildDir, json[0]), join(buildDir, atlas[0]), ...pack.map((p) => join(buildDir, p.page))];
}

/**
 * assemble -> rig -> check [-> loop], each stage's lines under its prefix,
 * stopping at the first stage that refuses. Returns where it stopped; the
 * caller turns that into the exit status. A crash that is not a refusal is
 * rethrown: it is not a stage's message and must not be printed as one.
 */
export function build(input: BuildInput, run: BuildRunners, log: Log): BuildResult {
  const prefixed = (stage: BuildStage): Log => (line) => log(`[${stage}] ${line}`);
  const refused = (stage: BuildStage, err: unknown, check: CheckReport | null = null): BuildResult => {
    if (!(err instanceof PartsError)) throw err;
    const say = prefixed(stage);
    for (const p of err.problems) say(`  FAIL  ${problemLine(p)}`);
    say(`refused: ${err.problems.length} problem(s)`);
    log(`build: stopped at ${stage}; no later stage ran`);
    return { stoppedAt: stage, check, artifact: [] };
  };
  const out = input.out;
  mkdirSync(out, { recursive: true });
  for (const p of BUILD_OWNS) rmSync(join(out, p), { recursive: true, force: true });
  // The idle-keys value is named only when it is not the default, so a build without the flag, or with the default, prints the line it printed before issue #95.
  const idleKeys = input.idleKeys ?? DEFAULT_IDLE_KEYS;
  log(`rig-parts build: ${input.config} -> ${out}, seam rule ${input.seam}, projection rule ${input.project}, page edges ${input.pageEdges}, pack shape ${input.packShape ?? DEFAULT_PACK_SHAPE}${idleKeys === DEFAULT_IDLE_KEYS ? '' : `, idle keys ${idleKeys}`}${input.loop ? ', with the idle loop' : ''}`);

  try {
    // build runs rig next, which needs the whole config, so the full loader is
    // asked first: a config rig would refuse is refused before assemble writes
    // anything, and under [assemble], as it was before the stage had its own
    // narrower door.
    loadConfig(input.config);
    // The same for the requirements file's own shape; its names resolve against the rig, in the check, before it builds.
    if (input.requirements !== undefined) readRequirements(input.requirements);
    assembleStage(
      { source: input.source, full: input.full, head: input.head, config: input.config, seam: input.seam, project: input.project },
      { partsJson: join(out, 'parts.json'), partsDir: join(out, 'parts'), recomposite: join(out, 'recomposite_rig.png'), errorMap: join(out, ERROR_MAP_FILE) },
      prefixed('assemble'),
    );
  } catch (err) {
    return refused('assemble', err);
  }

  try {
    rigStage({ config: input.config, parts: out, out: join(out, 'rig'), idleKeys, pageEdges: input.pageEdges, packShape: input.packShape, command: 'build' }, run.rig, run.scratch, prefixed('rig'));
  } catch (err) {
    return refused('rig', err);
  }

  let report: CheckReport;
  try {
    report = checkStage({ rig: join(out, 'rig'), parts: out, out: join(out, 'check'), pageEdges: input.pageEdges, packShape: input.packShape, ...(input.requirements === undefined ? {} : { requirements: input.requirements }) }, run.check, run.checkBin, prefixed('check'));
  } catch (err) {
    return refused('check', err);
  }
  if (!report.figures.PASS) {
    log(`build: stopped at check; ${report.problems.length} bar(s) not met, so no loop was encoded and no artifact is reported`);
    return { stoppedAt: 'check', check: report, artifact: [] };
  }

  if (input.loop) {
    const frames = join(out, 'check', 'idle_frames');
    try {
      const say = prefixed('loop');
      const lossless = loopStage(frames, join(out, 'idle.png'), 'apng', say);
      const indexed = loopStage(frames, join(out, 'idle-indexed.png'), 'indexed', say);
      const gif = loopStage(frames, join(out, 'idle.gif'), 'gif', say);
      const fig = (e: PaletteError | null): string => (e === null ? 'lossless' : `max ${e.max}, mean ${e.mean.toFixed(3)}`);
      say(`loop: idle.png ${lossless.bytes} B (${fig(lossless.error)}); idle-indexed.png ${indexed.bytes} B (${fig(indexed.error)}); idle.gif ${gif.bytes} B (${fig(gif.error)}) — palette error per channel over all frames`);
    } catch (err) {
      return refused('loop', err, report);
    }
  }

  let artifact: string[];
  try {
    artifact = artifactPaths(join(out, 'check', 'build'), report.pack);
  } catch (err) {
    return refused('artifact', err, report);
  }
  log(`build: PASS — the packed atlas is the artifact; parts/ and rig/ are the intermediates it was made from`);
  for (const l of packLines(report)) log(`  ${l}`);
  for (const a of artifact) log(`  ${a}`);
  return { stoppedAt: null, check: report, artifact };
}

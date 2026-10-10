/**
 * The check stage: build a rig through rig-c, gate it under both
 * profiles, render its idle, and measure the two things the gate cannot see —
 * whether the setup pose IS the flat stack of parts (the seam), and whether the
 * idle ends where it began (the loop).
 *
 * ⭐ **This is the one stage that drives a subprocess, and it does not own the
 * spawn.** Every rigc step — build, validate, render — is rig-c's own CLI,
 * never a re-implementation of it, because rigc's gate is the only oracle
 * behind a skeleton (CLAUDE.md, "rig-c's gate is not optional here
 * either"): the spine-core round trip where the runtime resolves beside rigc,
 * rigc's own validator where it does not, and `check.json`'s `rigc_entry` says
 * which ({@link readRigcEntry}). But `src/` is held to no child
 * processes (`TY06`, with `src/comfy/` its one named exception), so the process
 * is injected: `runCheck` takes a {@link RigcRunner}, `cli.ts` hands it one
 * that spawns the binary {@link findRigc} located, and the selftest hands it
 * the same. What this module does with the file system is read inputs and write
 * the outputs listed below; it never reads the clock or the network.
 *
 * Input — a rig directory holding what the rig stage writes:
 * `rig.json`, `motion.json` (with an `idle` animation), `parts.json`, and
 * `parts/<name>.png` for every part (the last two may sit in a directory of
 * their own, `partsHome`). It is a rig SPEC, which `rigc build` compiles, not
 * a compiled skeleton. Since issue #77 the `idle` and `parts.json` may be
 * missing — a rig merged from several rig-parts outputs has neither — and
 * every line that reads the missing one says SKIP with the reason; the
 * painting (`--source`) adds {@link SOURCE_LINE}. The inputs are read only;
 * everything is written under the output directory (the idle's outputs only
 * when there is an idle):
 *
 * | output | what |
 * | --- | --- |
 * | `build/` | `rigc build --profile spine-html --pack --page-edges free --pack-shape polygon` (or `pot`, `rect`, when the caller names them; {@link PAGE_EDGES}, {@link PACK_SHAPES}) — the packed atlas is the final artifact |
 * | `gate_spine-html.txt` | that build's gate lines, verbatim — the one gate: rigc's `build` runs it once over the compile and once over the packed pages on disk, and `spine-html` holds every rule `spine` measures (selftest `CH09`) |
 * | `idle_frames/` | `rigc render --animation idle --fps 12 --max 640 --geometry`: `frames.json` + `idle/f*.png` + `idle/geometry.json` (each mesh's skinned vertices, which `TEXTURE_STRETCH` reads, every attachment's posed triangles, which `TIP_OVER_ROOT` and both halves of `STILL_REGIONS_DARK` read since issues #118 and #123, and every bone's world transform, which the face half reads its head bone from) |
 * | `contact.png` | rigc's own contact sheet of that render, copied out |
 * | `motion_heat.png` | frame 0 in grey with each pixel's largest change across the idle in red |
 * | `check.json` | the figures below and `PASS` |
 * | `requirements/` | under `--requirements` only (issue #93): `as-declared/<animation>/`, and per follow `released/<name>/` and `full/<name>/` — rigc renders with `--geometry` ({@link measureRequirements}) |
 *
 * The acceptance bars are the reference implementation's (`check_rig.py`):
 * both gate summaries `0 failed`; seam mean |d| <= 1.0 of 255 and at most 50
 * pixels differing by more than 40; loop max |d| == 0.
 *
 * Beside them, six judgement lines (issue #11, and #31 for the sixth) measure
 * what used to be left to an eye — `BREATH_VISIBLE`, `BLINK_NO_HOLE`,
 * `CHAIN_LAG`, `TIP_OVER_ROOT`, `STILL_REGIONS_DARK`, `TEXTURE_STRETCH` — from
 * rigc renders of the idle (the whole rig, or a part alone through `--slot`),
 * from the setup still with the blink held shut, from `motion.json` read as
 * sines, or from the skinned mesh vertices the idle render's `--geometry`
 * writes beside its frames (rig-c {@link RIGC_GEOMETRY_VERSION} or later,
 * which `check` asks `rigc --version` for before it builds anything). Each reports SKIP,
 * with the reason, when the rig has nothing for it to read. The instruments
 * are `src/instruments.ts`; the bars are below and in AUTHORING §7. After
 * them, one REPORTED line with no bar, `RECOMPOSITE_HOLES` (issue #25): the
 * uncovered holes `assemble` recorded in `parts.json`'s `recomposite` block,
 * copied into `check.json` because the seam cannot see them — it compares the
 * setup pose with the flat stack of parts, and a pixel no part holds is
 * missing from both. The
 * part-alone renders and the shut-eye still are scratch (`_isolated/`,
 * `_still/`), removed before the stage returns.
 *
 * Where this port deliberately differs from the reference, each written where
 * it applies below: a gate summary is read with a pattern rather than the
 * substring `"0 failed"` (which `"10 failed"` contains); a gate with no summary
 * line is not green (Python's `all()` of nothing is `True`); the seam render's
 * `--max` is the rig canvas's longest side rather than the literal 1216 (which
 * was that for every rig it ever saw); the grey is read from rigc's
 * `frames.json` rather than typed; the crop-to-world map comes from the rig's
 * own stage box through `src/coords.ts` rather than an open-coded `-W/2`; and
 * the last idle frame is refused unless it sits at t = duration.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { measureRecomposite, type RecompositeFigures, recompositeRecord, sourceInRig } from './assemble.ts';
import { cropToSpineY } from './coords.ts';
import { PartsError, type Problem, refuseIfAny } from './errors.ts';
import { framesInside, IDLE_FPS } from './motion.ts';
import {
  blinkFigures,
  type GeometryPose,
  type MeshRest,
  blinkTracks,
  type ArtMask,
  type BoneTrack,
  type BoneWorld,
  boxLabel,
  crossingOf,
  type FrameMap,
  chainFigures,
  EYE_TAGS,
  eyeBones,
  FACE_FEATURE_TAGS,
  FACE_TAGS,
  FEET_TAGS,
  frameBox,
  heatField,
  partsTagged,
  type PixelBox,
  type PosedTriangles,
  regionHeat,
  partWorldBox,
  type RigRegion,
  setupToFrame,
  stillReading,
  stillTolerance,
  stretchFigures,
  stretchSeverity,
  sweptBox,
  SWING_TAGS,
  topmostIndex,
  TORSO_TAGS,
  halfTravels,
  type WorldBox,
} from './instruments.ts';
import { type PartRecord, type PartsFile, readParts } from './parts.ts';
import {
  aimLine,
  contactLine,
  declareConsumerDriven,
  followLine,
  forceMix,
  mutedLine,
  mutedOnly,
  placeTargets,
  type Poses,
  rangeLine,
  readRequirements,
  type RequirementLine,
  type RequirementsFile,
  requirementProblem,
  type RequirementsSummary,
  requirementsSummary,
  resolveRequirements,
  rigFacts,
  placedArt,
  type PosedAttachment,
  resolveSeams,
  type SeamFrame,
  seamLine,
  type SeamPair,
  stretchRequirementLine,
} from './requirements.ts';
import { alphaComposite } from './raster/composite.ts';
import { readPng, writePng } from './raster/png.ts';
import { newFloatImage, newRaster, type Raster } from './raster/types.ts';
import type { BaseTag } from './tags.ts';
import { warpAffine } from './raster/warp.ts';

// ---------------------------------------------------------------------------
// the bars
// ---------------------------------------------------------------------------

/** Seam: mean max-channel |d| over the frame, in levels of 255, at most this. */
export const SEAM_MEAN_BAR = 1.0;
/** Seam: pixels whose max-channel |d| exceeds {@link SEAM_PX_LEVEL}, at most this many. */
export const SEAM_PX_BAR = 50;
export const SEAM_PX_LEVEL = 40;
/** Seam: the second, reported-only level. */
export const SEAM_PX_LEVEL_HIGH = 80;
/** Loop: frame 0 vs the frame at t = duration, largest |d|, exactly this. */
export const LOOP_MAX_BAR = 0;

/** The idle render the reference makes, and the one issue #1's loop is encoded from. Defined beside the blink it has to see (`src/motion.ts`). */
export { IDLE_FPS };
export const IDLE_MAX_PX = 640;
/** The throwaway setup-pose animation: one key at 0 and one at this time, rendered at this rate. */
const STILL_DURATION = 0.1;
const STILL_FPS = 10;

/**
 * The judgement lines' bars (issue #11). Each is derived from the two public
 * examples by one stated rule, and AUTHORING §7 quotes what each example
 * measures beside it: a floor is half the weaker example's figure, a ceiling
 * twice the worse one's, so the weaker example clears every bar by a factor of
 * two; a bar the model itself fixes (a still part does not move, a lag is
 * above 0, a hole is 0 pixels) is that value, not a margin. The still regions'
 * bar is the model's too — nothing moves — read up to the arithmetic's own
 * rounding (`stillTolerance` in `src/instruments.ts`, issue #123).
 */
export const BREATH_TORSO_MEAN_FLOOR = 3.809;
export const BREATH_FEET_MAX_CEILING = 0;
export const BLINK_HOLE_BAR = 0;
/** The reported colour-patch level: the seam's own "differs by more than 40". */
export const BLINK_PATCH_LEVEL = SEAM_PX_LEVEL;
/** The smallest lag the reading resolves, in cycles: phases are written to three places. */
export const CHAIN_LAG_MIN_STEP = 0.001;
export const TIP_RATIO_FLOOR = 1.4725;
/**
 * `TEXTURE_STRETCH`'s ceiling on max(ratio, 1/ratio) (issue #31): the worse
 * example's figure (demo, 1.388) squared. The ceiling rule is "twice the worse
 * one's", and it is applied to the quantity whose zero means "nothing
 * happened", as it is for heat: for an edge ratio that is |ln r|, so twice
 * |ln 1.388| is ln(1.388²). Doubling the ratio itself (2.776) was rejected —
 * its zero is not at 1, and it would pass an edge drawn at 2.7 times its rest
 * length, the mutant the line exists to catch included.
 */
export const TEXTURE_STRETCH_CEILING = 1.926544;

/** The first rig-c whose `render` writes `geometry.json` (`--geometry`, rig-c 1.4.0's changelog). */
export const RIGC_GEOMETRY_VERSION = '1.4.0';
/** The geometry export's file name inside a frame set directory, and the format tag it carries. */
export const GEOMETRY_FILE = 'geometry.json';
export const GEOMETRY_SPEC = 'rigc-geometry/1';

/** Issue #2's yardstick, measured on the Spine example export `spineboy.png` (alpha > 0). */
export const SPINEBOY_YARDSTICK = '1024x256, 40 region(s), 45.8% opaque (alpha > 0)';

/**
 * What a packed page's edges may be: rig-c's `build --pack --page-edges`,
 * handed to it verbatim (the flag is in rig-c's CLI since 1.4.0, the
 * floor `check` already requires; 1.5.0 made `free` search every width).
 * `pot` is a power of two on both edges; `free` is the least-area page the
 * placement needs, at the cost rigc's help states: region attachments sample
 * within 1 LSB of the loose build rather than exactly.
 *
 * `free` is the default here although rigc's own default is `pot`: the packed
 * page is this package's final artifact, and on the two public examples `free`
 * takes the page from 1024x2048 to 967x1338 (covered 56.3 % -> 91.2 %) and
 * from 512x2048 to 479x1166 (49.7 % -> 93.4 %), rigc 1.5.1, 2.0.3, 2.1.3 and 2.10.1 (`rect`) alike. The cost was
 * measured on the same two builds. Each of the 49 idle frames differs from the
 * `pot` build's, by at most 1 level in any channel (demo 2,373 px, sample 651
 * px over all 49). On sample that moves STILL_REGIONS_DARK's reported
 * screen-space face mean from 11.475 to 11.472; no bar or status moves. The
 * atlas rigc writes says `filter: Linear, Linear` and has no `repeat` line, so
 * a consumer that mipmaps or repeats the page itself is the one that wants
 * `pot`. AUTHORING §5, *Page edges*, holds the tables.
 */
export const PAGE_EDGES = ['pot', 'free'] as const;
export type PageEdges = (typeof PAGE_EDGES)[number];
export const DEFAULT_PAGE_EDGES: PageEdges = 'free';

/**
 * What two packed rectangles may share: rig-c's `build --pack
 * --pack-shape`, handed to it verbatim (in rig-c's CLI since 2.1.0; this
 * package's range starts at 2.15.0). `rect` keeps every region's cell apart;
 * `polygon` packs a region that only meshes draw by its emitted hull, so a
 * neighbour may sit inside its rectangle where the hull is not, with the
 * padding kept between footprints — a region attachment stays its rectangle
 * (rigc's help).
 *
 * `polygon` is the default here although rigc's own default is `rect`, for the
 * reason {@link DEFAULT_PAGE_EDGES} is `free`: the packed page is this
 * package's final artifact, rigc gates the footprints on the pages on disk
 * (`A49_PACKED_FOOTPRINTS_DO_NOT_OVERLAP`), and the cost is the class already
 * accepted for `free`. Measured with rig-c 2.1.3, and again with 2.10.1,
 * whose pages, atlases and idle frames are byte-identical to it (the full entry,
 * spine-core 4.3.13 beside it), `rig-parts build` on the two public examples
 * under `--page-edges free`: `polygon` takes demo's page from 967x1338 (91.2 %
 * covered) to 922x1348 (95.0 %), 3.9 % less area, and sample's from 479x1166
 * (93.4 %) to 477x1151 (95.0 %), 1.7 % less. Each of the 49 idle frames at 12
 * fps differs from the `rect` build's by at most 1 level in any channel (demo
 * 2,594 px, sample 740 px over all 49), and no figure in `check.json` but
 * `pack_mode` moves. Under `--page-edges pot` both shapes give the same page
 * size and the same frames. AUTHORING §5, *Pack shape*, holds the tables.
 * `--pack-shape rect` writes the page and atlas rigc 2.0.3 wrote for 0.7.0
 * (measured byte for byte on both examples; selftest `CK53` holds rect to
 * rigc's own rect page).
 */
export const PACK_SHAPES = ['rect', 'polygon'] as const;
export type PackShape = (typeof PACK_SHAPES)[number];
export const DEFAULT_PACK_SHAPE: PackShape = 'polygon';

/** How a packed build packs: its `--page-edges` and its `--pack-shape`, each handed to rigc verbatim. */
export interface PackMode {
  pageEdges: PageEdges;
  packShape: PackShape;
}

/** Both defaults, {@link DEFAULT_PAGE_EDGES} and {@link DEFAULT_PACK_SHAPE}. */
export const DEFAULT_PACK_MODE: PackMode = { pageEdges: DEFAULT_PAGE_EDGES, packShape: DEFAULT_PACK_SHAPE };

/** The packed build's rigc arguments after `--out <dir>`, as every stage that packs passes them. */
export function packedBuildArgs(mode: PackMode): string[] {
  return ['--profile', 'spine-html', '--pack', '--page-edges', mode.pageEdges, '--pack-shape', mode.packShape];
}

/** The packed build as a label: the rigc command line that was run, after `rigc`. */
export function packedBuildLabel(mode: PackMode): string {
  return `build ${packedBuildArgs(mode).join(' ')}`;
}

// ---------------------------------------------------------------------------
// the rigc process, injected
// ---------------------------------------------------------------------------

export interface RigcCall {
  /** Exit status; a process that did not start is reported by the runner as a non-zero status with the reason in `out`. */
  status: number;
  /** stdout then stderr. */
  out: string;
}

export type RigcRunner = (args: readonly string[]) => RigcCall;

/** A line in which a rigc run that stopped says why: Bun's own `error: …`, rigc's `rigc <command>: …` refusals, a `usage: …` line. */
const CAUSE = /^(error: |rigc[\w -]*: |usage: )/;

/**
 * What a rigc run that exited non-zero said about why, for a refusal whose own
 * filter (FAIL lines, the assertion summary) matched nothing: every line that
 * names a cause, or, when none does, the last three non-empty lines. Measured
 * against rig-c 2.0.3: its `cli.ts` run by path without
 * `@esotericsoftware/spine-core` beside it dies at import with one
 * `error: Cannot find module '@esotericsoftware/spine-core' from …` line, and its
 * core entry refuses `validate` with one `rigc validate: …` line, neither of
 * which a gate filter reads. The last lines and not the first are the fallback
 * because `rigc build` prints its header and inputs before it can stop. Empty
 * only when the run printed nothing at all.
 */
export function causeLines(out: string): string[] {
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const named = lines.filter((l) => CAUSE.test(l));
  return named.length > 0 ? named : lines.slice(-3);
}

/** The two entries rig-c's launcher (`bin/rigc.cjs`, rig-c 2.0.0 and later) runs. */
export const RIGC_ENTRIES = ['cli.ts', 'cli_core.ts'] as const;
export type RigcEntry = (typeof RIGC_ENTRIES)[number];

/** The first rig-c whose `--version` names the entry that ran (its launcher's stderr line; rig-c 2.0.0's changelog, issue #1061 there). */
export const RIGC_ENTRY_VERSION = '2.0.0';

/**
 * Which rigc entry gated the build, as `check.json` records it: `cli.ts`, the
 * spine-core round trip, with the runtime's version; `cli_core.ts`, rigc's own
 * validator over its model document, with no runtime (`spine_core` null).
 */
export interface RigcEntryRecord {
  entry: RigcEntry;
  spine_core: string | null;
}

/** The launcher's two `entry:` lines, whole, as rig-c 2.0.3's `bin/rigc.cjs` writes them. */
const ENTRY_FULL = /^entry: cli\.ts — @esotericsoftware\/spine-core (\S+) present$/;
const ENTRY_CORE = /^entry: cli_core\.ts — @esotericsoftware\/spine-core absent — /;

/**
 * The entry a `rigc --version` run names. A run with no `entry:` line is a
 * rigc older than {@link RIGC_ENTRY_VERSION}, or not rigc's launcher, and is
 * refused `CHECK_RIGC_ENTRY`; an `entry:` line in neither form above is refused
 * `CHECK_RIGC_ENTRY_READS`, naming the line — a third entry is not read as
 * either of the two.
 */
export function readRigcEntry(versionOut: string): RigcEntryRecord {
  const lines = versionOut.split('\n').map((l) => l.trim());
  const line = lines.find((l) => l.startsWith('entry:'));
  if (line === undefined) {
    refuseIfAny([
      {
        code: 'CHECK_RIGC_ENTRY',
        object: '`rigc --version`',
        detail: `printed ${JSON.stringify(versionOut.trim())} and no \`entry:\` line; rig-c ${RIGC_ENTRY_VERSION} or later is required — its launcher names the entry that ran, and check.json records which one gated the build (\`bun install\` puts this package's own rig-c at node_modules/.bin/rigc)`,
      },
    ]);
  }
  const at = line as string;
  const full = ENTRY_FULL.exec(at);
  if (full !== null) return { entry: 'cli.ts', spine_core: full[1] };
  if (ENTRY_CORE.test(at)) return { entry: 'cli_core.ts', spine_core: null };
  refuseIfAny([
    {
      code: 'CHECK_RIGC_ENTRY_READS',
      object: `rigc's entry line ${JSON.stringify(at)}`,
      detail: 'reads as neither "entry: cli.ts — @esotericsoftware/spine-core <version> present" nor "entry: cli_core.ts — @esotericsoftware/spine-core absent — …"; one of the two is required',
    },
  ]);
  throw new Error('unreachable');
}

/**
 * Where the `rigc` binary is: `node_modules/.bin/rigc` in `from` or any
 * directory above it (a clone has it beside the package; an install has it in
 * the consumer's `node_modules/.bin`), then every directory on `PATH`. A miss
 * is refused naming every place looked.
 */
export function findRigc(from: string, pathVar: string): string {
  const looked: string[] = [];
  let dir = resolve(from);
  for (;;) {
    const bin = join(dir, 'node_modules', '.bin', 'rigc');
    looked.push(bin);
    if (existsSync(bin)) return bin;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const p of pathVar.split(delimiter).filter((s) => s !== '')) {
    const bin = join(p, 'rigc');
    if (existsSync(bin)) return bin;
  }
  refuseIfAny([
    {
      code: 'CHECK_RIGC_PRESENT',
      object: 'the rig-c CLI `rigc`',
      detail: `found at none of ${looked.length} node_modules/.bin/rigc path(s) from ${resolve(from)} up (nearest ${looked[0]}) nor on PATH; rig-c is this package's dependency — \`bun install\` puts it at node_modules/.bin/rigc`,
    },
  ]);
  return '';
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

export interface StageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What `--parts` is, said once for the refusals and the help. */
export const PARTS_HOME_SENTENCE = '--parts names the directory holding parts.json and parts/, not parts/ itself (after build, that is build\'s --out, whose rig is <out>/rig); without --parts it is --rig';

/**
 * What `check` does without `--parts` when the rig directory holds no
 * `parts.json` (issue #77), said once for the help and the SKIP lines.
 */
export const NO_PARTS_SENTENCE = 'without --parts, a rig directory holding no parts.json is measured without one: the seam and every line that reads parts.json say SKIP, by name — unless the directory above --rig holds parts.json (build\'s layout), which is refused naming it';

/**
 * What the painting `--source` names is compared with (issue #77), for the
 * refusals and the help: assemble's own resample of it onto the rig canvas.
 */
export const SOURCE_SENTENCE = '--source names the painting the rig was made from: the stage size itself, or any size assemble takes to the stage (width and height each the painting\'s times one rig_scale, truncated — parts.json\'s scale_rig_per_source when parts.json is read), resampled onto the stage as assemble resamples it (lanczos3, alpha dropped)';

/** The painting `--source` names, read and checked against the stage before anything is built. */
export interface SourceInput {
  path: string;
  painting: Raster;
}

export interface CheckInputs {
  rigDir: string;
  rigPath: string;
  motionPath: string;
  partsPath: string;
  partsDir: string;
  rig: Record<string, unknown>;
  motion: Record<string, unknown>;
  /** Null when the rig directory holds no `parts.json` and no `--parts` was named (issue #77); {@link noParts} says why. */
  parts: PartsFile | null;
  /** Why `parts` is null, as the SKIP lines say it; null when `parts.json` was read. */
  noParts: string | null;
  stage: StageBox;
  rootBone: string;
  /** Null when `motion.json` declares no `idle` animation (issue #77); {@link noIdle} says why. */
  idleDuration: number | null;
  /** Why `idleDuration` is null, as the SKIP lines say it; null when there is an idle. */
  noIdle: string | null;
  /** The painting `--source` named, or null without `--source`. */
  source: SourceInput | null;
}

/** The inputs every line that reads both the parts and the idle takes: both present. */
export type FullInputs = CheckInputs & { parts: PartsFile; idleDuration: number };

/**
 * Whether a painting `w`x`h` can be the one assemble made a `W`x`H` rig canvas
 * from: assemble's `checkGeometry` makes the canvas `trunc(w * S)` x
 * `trunc(h * S)` for `rig_scale` S, so with S known (parts.json's
 * `scale_rig_per_source`) both must come out; with S unknown some S must
 * satisfy both, which is `W h < (H + 1) w` and `H w < (W + 1) h` in integers.
 * The same size is S = 1. Null when it can; otherwise the refusal's detail.
 */
export function sourceSizeProblem(w: number, h: number, stage: StageBox, scale: number | null): string | null {
  const { width: W, height: H } = stage;
  const whole = (v: number): boolean => Number.isInteger(v) && v > 0;
  if (!whole(W) || !whole(H)) return `the stage (rig.json's "skeleton") is ${W}x${H}; whole positive pixel counts are required to compare it with a painting pixel for pixel`;
  if (scale !== null) {
    if (Math.trunc(w * scale) === W && Math.trunc(h * scale) === H) return null;
    return `is ${w}x${h}, which parts.json's scale_rig_per_source ${scale} takes to ${Math.trunc(w * scale)}x${Math.trunc(h * scale)}; the stage is ${W}x${H}, so the painting assemble was given is required`;
  }
  if (W * h < (H + 1) * w && H * w < (W + 1) * h) return null;
  return `is ${w}x${h}; no single rig_scale takes it to the ${W}x${H} stage (assemble truncates width and height times the same scale), so the painting is not this rig's — ${SOURCE_SENTENCE}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readJson(path: string, problems: Problem[]): Record<string, unknown> | null {
  if (!existsSync(path)) {
    problems.push({ code: 'CHECK_INPUT_PRESENT', object: path, detail: 'no such file; the rig directory holds rig.json, motion.json, parts.json and parts/' });
    return null;
  }
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (isRecord(v)) return v;
    problems.push({ code: 'CHECK_INPUT_IS_JSON', object: path, detail: `holds ${JSON.stringify(v)?.slice(0, 40)}; an object is required` });
  } catch (err) {
    problems.push({ code: 'CHECK_INPUT_IS_JSON', object: path, detail: `does not parse as JSON: ${(err as Error).message}` });
  }
  return null;
}

/**
 * Read and cross-check the rig directory. Every problem is collected before
 * one refusal. `partsHome` is the directory holding `parts.json` and `parts/`
 * when they do not sit beside `rig.json` — `build` keeps the parts at the top
 * of its output and the rig under `rig/`; absent, it is the rig directory, and
 * there (issue #77) a `parts.json` may be missing: the rig is then measured
 * without parts ({@link NO_PARTS_SENTENCE}). A named `partsHome` with no
 * `parts.json` is refused, as is a missing one whose directory's parent holds
 * `parts.json` — build's layout, where the miss is `--parts` left off. An
 * `idle` may be missing too; an `idle` that is there must have a positive
 * duration. `sourcePath` is `--source`, read and held to the stage here, so a
 * painting that is not this rig's is refused before anything is built.
 */
export function readCheckInputs(rigDir: string, partsHome?: string, sourcePath?: string): CheckInputs {
  const dir = resolve(rigDir);
  const named = partsHome !== undefined;
  const home = resolve(partsHome ?? rigDir);
  const problems: Problem[] = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    refuseIfAny([{ code: 'CHECK_INPUT_PRESENT', object: dir, detail: 'is not a directory; --rig names the directory holding rig.json and motion.json (and parts.json and parts/, or --parts names where they are)' }]);
  }
  const rigPath = join(dir, 'rig.json');
  const motionPath = join(dir, 'motion.json');
  const partsPath = join(home, 'parts.json');
  const partsDir = join(home, 'parts');
  if (home !== dir && (!existsSync(home) || !statSync(home).isDirectory())) {
    refuseIfAny([{ code: 'CHECK_INPUT_PRESENT', object: home, detail: `is not a directory; ${PARTS_HOME_SENTENCE}` }]);
  }
  const rig = readJson(rigPath, problems);
  const motion = readJson(motionPath, problems);
  let parts: PartsFile | null = null;
  let noParts: string | null = null;
  if (!existsSync(partsPath)) {
    // The usual miss is passing parts/ itself, or leaving --parts off after build; the parent is then named.
    const parent = dirname(home);
    const parentHolds = existsSync(join(parent, 'parts.json'));
    if (named || parentHolds) {
      const hint = parentHolds ? ` — ${parent} holds parts.json, so --parts ${parent} is the directory meant` : '';
      problems.push({
        code: 'CHECK_INPUT_PRESENT',
        object: partsPath,
        detail: `no such file; ${PARTS_HOME_SENTENCE} (the seam check composites the parts parts.json lists)${hint}`,
      });
    } else noParts = `no parts.json: ${partsPath} does not exist and no --parts was named, so there are no parts to composite and no See-through tags to choose regions by`;
  }
  else {
    try {
      parts = readParts(partsPath);
    } catch (err) {
      if (err instanceof PartsError) problems.push(...err.problems);
      else throw err;
    }
  }
  if (parts !== null) {
    for (const p of parts.parts) {
      const png = join(partsDir, `${p.name}.png`);
      if (!existsSync(png)) {
        problems.push({ code: 'CHECK_PART_PNG_PRESENT', object: `part "${p.name}"`, detail: `${png} does not exist; parts.json lists it` });
        continue;
      }
      const im = readPng(png);
      if (im.width !== p.w || im.height !== p.h) {
        problems.push({ code: 'CHECK_PART_PNG_MATCHES_BOX', object: `part "${p.name}"`, detail: `${png} is ${im.width}x${im.height}; parts.json's box is ${p.w}x${p.h}` });
      }
    }
  }
  let stage: StageBox | null = null;
  let rootBone: string | null = null;
  if (rig !== null) {
    const s = rig.skeleton;
    const nums = isRecord(s) && ['x', 'y', 'width', 'height'].every((k) => typeof s[k] === 'number' && Number.isFinite(s[k]));
    if (!nums) {
      problems.push({ code: 'CHECK_RIG_STAGE_PRESENT', object: `${rigPath} field "skeleton"`, detail: `is ${JSON.stringify(s)}; the stage box { x, y, width, height } is required — it is where parts.json's crop pixels sit in Spine's world` });
    } else {
      stage = { x: s.x as number, y: s.y as number, width: s.width as number, height: s.height as number };
      if (parts !== null && (stage.width !== parts.rig_size[0] || stage.height !== parts.rig_size[1])) {
        problems.push({
          code: 'CHECK_RIG_STAGE_IS_THE_CANVAS',
          object: `${rigPath} field "skeleton"`,
          detail: `is ${stage.width}x${stage.height}; parts.json's rig_size is ${parts.rig_size[0]}x${parts.rig_size[1]}, and the seam compares the two pixel for pixel`,
        });
      }
    }
    const slots = new Set((Array.isArray(rig.slots) ? rig.slots : []).filter(isRecord).map((s) => s.name));
    if (parts !== null) {
      for (const p of parts.parts) {
        if (!slots.has(p.name)) {
          problems.push({
            code: 'CHECK_PART_SLOT_PRESENT',
            object: `part "${p.name}"`,
            detail: `${rigPath} has no slot named "${p.name}"; the rig stage draws every part by the slot of its own name, and the judgement lines render a part alone by that slot`,
          });
        }
      }
    }
    const bones = rig.bones;
    const first: unknown = Array.isArray(bones) ? bones[0] : undefined;
    if (isRecord(first) && typeof first.name === 'string') rootBone = first.name;
    else problems.push({ code: 'CHECK_RIG_ROOT_BONE', object: `${rigPath} field "bones"`, detail: 'has no first bone with a name; the setup-pose render keys the root bone' });
  }
  let idleDuration: number | null = null;
  let noIdle: string | null = null;
  if (motion !== null) {
    const anims = motion.animations;
    const idle = isRecord(anims) ? anims.idle : undefined;
    if (idle === undefined) {
      noIdle = `no idle: ${motionPath} field "animations" holds ${isRecord(anims) ? `[${Object.keys(anims).join(', ')}]` : JSON.stringify(anims) ?? 'nothing'} and no "idle", so there is no loop to close and no idle frame to read`;
    } else if (!isRecord(idle)) {
      problems.push({ code: 'CHECK_IDLE_PRESENT', object: `${motionPath} animation "idle"`, detail: `is ${JSON.stringify(idle)}; an animation object is required — the loop is measured on it` });
    } else if (!(typeof idle.duration === 'number' && idle.duration > 0)) {
      problems.push({ code: 'CHECK_IDLE_PRESENT', object: `${motionPath} animation "idle" field "duration"`, detail: `is ${JSON.stringify(idle.duration)}; a positive number of seconds is required` });
    } else idleDuration = idle.duration;
  }
  let source: SourceInput | null = null;
  if (sourcePath !== undefined) {
    const path = resolve(sourcePath);
    if (!existsSync(path) || !statSync(path).isFile()) {
      problems.push({ code: 'CHECK_INPUT_PRESENT', object: path, detail: `no such file; ${SOURCE_SENTENCE}` });
    } else {
      try {
        source = { path, painting: readPng(path) };
      } catch (err) {
        problems.push({ code: 'CHECK_SOURCE_PNG', object: path, detail: `does not read as a PNG: ${(err as Error).message.split('\n')[0]}; ${SOURCE_SENTENCE}` });
      }
    }
    if (source !== null && stage !== null) {
      const why = sourceSizeProblem(source.painting.width, source.painting.height, stage, parts === null ? null : parts.scale_rig_per_source);
      if (why !== null) problems.push({ code: 'CHECK_SOURCE_SIZE', object: `--source ${path}`, detail: why });
    }
  }
  refuseIfAny(problems);
  return {
    rigDir: dir,
    rigPath,
    motionPath,
    partsPath,
    partsDir,
    rig: rig as Record<string, unknown>,
    motion: motion as Record<string, unknown>,
    parts,
    noParts,
    stage: stage as StageBox,
    rootBone: rootBone as string,
    idleDuration,
    noIdle,
    source,
  };
}

// ---------------------------------------------------------------------------
// gate lines
// ---------------------------------------------------------------------------

/**
 * The `here:` line rig-c's core entry (`cli_core.ts`, 2.0.0 and later)
 * prints after its assertion summary, saying which rules ran and that the
 * spine-core round trip did not; `cli.ts` prints none.
 */
const HERE_LINE = /^\.\.\s+here: /;

/**
 * `check_rig.py`'s filter for the build: summary, stats and pack lines, and
 * anything that failed — and, under rigc's core entry, its `here:` line, so the
 * gate file says which validator ran.
 */
export function buildGateLines(out: string): string[] {
  return out
    .split('\n')
    .filter((l) => (l.trim().startsWith('..') && (l.includes(' assertions: ') || l.includes('pages=') || l.includes('pack:') || HERE_LINE.test(l.trim()))) || l.includes('FAIL') || l.includes('compile error'));
}

/**
 * The rules a rigc run measured — every `PASS` and `FAIL` line's rule name, in
 * the order printed, each once. A SKIP, a PROF line and a summary are not
 * measurements. The selftest's `CH09` compares a build's set with
 * `rigc validate --profile spine`'s on the same build.
 */
export function measuredRules(out: string): string[] {
  const seen: string[] = [];
  for (const m of out.matchAll(/^ {2}(?:PASS|FAIL) {2}([A-Z][A-Z0-9_]*)/gm)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

const SUMMARY = /\((\d+) passed, (\d+) failed\)/;

/**
 * Green = rigc exited 0, at least one summary line, and every summary line says
 * `0 failed`. Read with a pattern: the reference's substring test `"0 failed"`
 * is also true of `"10 failed"`, and its `all()` over no summary line is true.
 */
export function gateGreen(status: number, lines: readonly string[]): boolean {
  const summaries = lines.filter((l) => l.includes(' assertions: '));
  return status === 0 && summaries.length > 0 && summaries.every((l) => SUMMARY.exec(l)?.[2] === '0');
}

export interface PackLine {
  line: string;
  page: string;
  width: number;
  height: number;
  regions: number;
  coveredPct: number;
  padding: number;
  /** `free` when the line carries `, page edges free` after the padding, `pot` when it does not — rig-c prints the clause exactly when it packed under `--page-edges free` (its `src/cli/shared.ts`, the pack line). */
  pageEdges: PageEdges;
  /**
   * The line's last clause, `, shape rect` or `, shape polygon`: rig-c
   * 2.1 names the `--pack-shape` it packed under on every pack line, its
   * default included. A line with no shape clause is the 1.5.1–2.0.3 form,
   * from a rigc that had no other shape, and reads as `rect`.
   */
  packShape: PackShape;
}

/** rigc's pack line, whole: the line is this and nothing else, or it is refused. */
const PACK = /^pack: (\S+) (\d+)x(\d+), (\d+) region\(s\), (\d+(?:\.\d+)?)% covered, padding (\d+)(, page edges free)?(?:, shape (rect|polygon))?$/;

/** A pack line that names its shape: the rig-c 2.1 form. */
const PACK_SHAPE_CLAUSE = /, shape (?:rect|polygon)$/;

/**
 * Every pack line among the gate lines — a line that reads `pack:` once its
 * `..` gutter is taken off. Two forms are read, each by name: rig-c
 * 2.1's, which ends `, shape rect` or `, shape polygon`, and the 1.5.1–2.0.3
 * form, which has no shape clause and reads as `rect`; in both,
 * `, page edges free` sits between the padding and the shape or is absent. Any
 * other line (an unknown shape, an unknown suffix, a missing field, the clauses
 * out of order) is refused, `CHECK_PACK_LINE_READS`, naming the line and the
 * form required: a line half-read would lose the field that changed.
 */
export function parsePackLines(lines: readonly string[]): PackLine[] {
  const out: PackLine[] = [];
  const problems: Problem[] = [];
  for (const l of lines) {
    const text = l.trim().replace(/^\.\.\s+/, '');
    if (!text.startsWith('pack:')) continue;
    const m = PACK.exec(text);
    if (m === null) {
      problems.push({
        code: 'CHECK_PACK_LINE_READS',
        object: `rigc's pack line ${JSON.stringify(text)}`,
        detail: 'does not read as "pack: <page> <W>x<H>, <N> region(s), <P>% covered, padding <D>", then ", page edges free" or nothing, then ", shape rect", ", shape polygon" or nothing; that form is required',
      });
      continue;
    }
    out.push({
      line: text,
      page: m[1],
      width: Number(m[2]),
      height: Number(m[3]),
      regions: Number(m[4]),
      coveredPct: Number(m[5]),
      padding: Number(m[6]),
      pageEdges: m[7] === undefined ? 'pot' : 'free',
      packShape: m[8] === 'polygon' ? 'polygon' : 'rect',
    });
  }
  refuseIfAny(problems);
  return out;
}

function powerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/**
 * Where a pack line disagrees with the pack mode the build was given. The
 * line's own page-edges clause must say the `--page-edges` passed, and a `pot`
 * page must be a power of two on both edges, as rigc's help defines it,
 * `CHECK_PACK_PAGE_EDGES`. By the same rule the line's shape must be the
 * `--pack-shape` passed, `CHECK_PACK_SHAPE` — a line with no shape clause
 * reads as `rect`, so under `polygon` it disagrees. That is the case that
 * matters: rigc 2.0.3 takes `--pack-shape` without a word, packs by
 * rectangles and prints the form with no shape clause (measured), so a rigc
 * older than 2.1.0 first on `PATH` is refused here rather than shipping a
 * rect page as a polygon one. One problem per disagreement; empty is
 * agreement.
 */
export function packEdgeProblems(pack: readonly PackLine[], mode: PackMode): Problem[] {
  const edges = mode.pageEdges;
  const problems: Problem[] = [];
  for (const p of pack) {
    const object = `packed page ${p.page}`;
    if (p.pageEdges !== edges) {
      problems.push({
        code: 'CHECK_PACK_PAGE_EDGES',
        object,
        detail: `rigc's pack line says page edges ${p.pageEdges} (${p.pageEdges === 'free' ? 'it carries ", page edges free"' : 'no ", page edges free" clause'}); the build was run with --page-edges ${edges}, so page edges ${edges} is required`,
      });
    } else if (edges === 'pot' && !(powerOfTwo(p.width) && powerOfTwo(p.height))) {
      problems.push({ code: 'CHECK_PACK_PAGE_EDGES', object, detail: `is ${p.width}x${p.height}; the build was run with --page-edges pot, so a power of two on both edges is required` });
    }
    if (p.packShape !== mode.packShape) {
      problems.push({
        code: 'CHECK_PACK_SHAPE',
        object,
        detail: `rigc's pack line says shape ${p.packShape} (${PACK_SHAPE_CLAUSE.test(p.line) ? `it ends ", shape ${p.packShape}"` : 'no ", shape" clause: the 1.5.1-2.0.3 form, read as rect'}); the build was run with --pack-shape ${mode.packShape}, so shape ${mode.packShape} is required`,
      });
    }
  }
  return problems;
}

/** Share of a page's pixels with alpha above 0 — the measure issue #2's spineboy figure is in. rigc's "covered" is region rectangles, not pixels. */
export function opaqueShare(r: Raster): number {
  let n = 0;
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] > 0) n++;
  return n / (r.width * r.height);
}

// ---------------------------------------------------------------------------
// rigc's frames
// ---------------------------------------------------------------------------

export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface FrameSet {
  /** The directory holding the frames. */
  dir: string;
  animation: string | null;
  fps: number;
  sampled: number;
  written: number;
  stride: number;
  /** The last sampled frame's time, as rigc records it. */
  duration: number;
  background: [number, number, number, number];
  viewport: Viewport;
  /** `f<index>.png`, in index order. */
  frames: Array<{ name: string; index: number; image: Raster }>;
}

function sidecarProblem(object: string, detail: string): never {
  refuseIfAny([{ code: 'FRAMES_SIDECAR', object, detail }]);
  throw new Error('unreachable');
}

/**
 * A frame set as `rigc render` wrote it: either the `--out` directory
 * (`frames.json` plus one set directory) or a set directory whose parent holds
 * `frames.json`. Every figure is read off the sidecar; none is assumed.
 */
export function readFrameSet(path: string): FrameSet {
  const dir = resolve(path);
  let sidecarPath: string;
  let setName: string | null;
  if (existsSync(join(dir, 'frames.json'))) {
    sidecarPath = join(dir, 'frames.json');
    setName = null;
  } else if (existsSync(join(dirname(dir), 'frames.json'))) {
    sidecarPath = join(dirname(dir), 'frames.json');
    setName = basename(dir);
  } else {
    return sidecarProblem(dir, `neither ${join(dir, 'frames.json')} nor ${join(dirname(dir), 'frames.json')} exists; the fps and the frame count are read from the frames.json \`rigc render\` writes`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  } catch (err) {
    return sidecarProblem(sidecarPath, `does not parse as JSON: ${(err as Error).message}`);
  }
  if (!isRecord(raw) || !Array.isArray(raw.sets) || !isRecord(raw.viewport) || !Array.isArray(raw.background)) {
    return sidecarProblem(sidecarPath, 'lacks "sets", "viewport" or "background"; a rigc-frames/1 sidecar carries all three');
  }
  const sets = raw.sets.filter(isRecord);
  let set: Record<string, unknown> | undefined;
  if (setName === null) {
    if (sets.length !== 1) return sidecarProblem(sidecarPath, `holds ${sets.length} set(s) [${sets.map((s) => String(s.dir)).join(', ')}]; name one set directory when there is not exactly one`);
    set = sets[0];
  } else {
    set = sets.find((s) => s.dir === setName);
    if (set === undefined) return sidecarProblem(sidecarPath, `has no set "${setName}"; it has [${sets.map((s) => String(s.dir)).join(', ')}]`);
  }
  const num = (o: Record<string, unknown>, k: string, at: string): number => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return sidecarProblem(sidecarPath, `${at} field "${k}" is ${JSON.stringify(v)}; a number is required`);
    return v;
  };
  const vpRaw = raw.viewport;
  const viewport: Viewport = {
    x: num(vpRaw, 'x', 'viewport'),
    y: num(vpRaw, 'y', 'viewport'),
    width: num(vpRaw, 'width', 'viewport'),
    height: num(vpRaw, 'height', 'viewport'),
    scale: num(vpRaw, 'scale', 'viewport'),
    pixelWidth: num(vpRaw, 'pixelWidth', 'viewport'),
    pixelHeight: num(vpRaw, 'pixelHeight', 'viewport'),
  };
  const bg = raw.background;
  if (bg.length !== 4 || !bg.every((v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255)) {
    return sidecarProblem(sidecarPath, `"background" is ${JSON.stringify(bg)}; four 8-bit channels are required`);
  }
  const setDir = join(dirname(sidecarPath), String(set.dir));
  if (!existsSync(setDir)) return sidecarProblem(setDir, 'does not exist; frames.json names it');
  const frames = readdirSync(setDir)
    .map((name) => ({ name, m: /^f(\d+)\.png$/.exec(name) }))
    .filter((e) => e.m !== null)
    .map((e) => ({ name: e.name, index: Number((e.m as RegExpExecArray)[1]) }))
    .sort((a, b) => a.index - b.index)
    .map((e) => ({ ...e, image: readPng(join(setDir, e.name)) }));
  const written = num(set, 'written', `set "${String(set.dir)}"`);
  if (frames.length !== written) return sidecarProblem(setDir, `holds ${frames.length} f*.png frame(s); frames.json says ${written} were written`);
  return {
    dir: setDir,
    animation: typeof set.animation === 'string' ? set.animation : null,
    fps: num(set, 'fps', `set "${String(set.dir)}"`),
    sampled: num(set, 'sampled', `set "${String(set.dir)}"`),
    written,
    stride: num(set, 'stride', `set "${String(set.dir)}"`),
    duration: num(set, 'duration', `set "${String(set.dir)}"`),
    background: bg as [number, number, number, number],
    viewport,
    frames,
  };
}

// ---------------------------------------------------------------------------
// the keyed loop: physics left out (issue #183)
// ---------------------------------------------------------------------------

/** A physics constraint the loop's frames leave out, as the `loop:` physics line names it. */
export interface LoopPhysics {
  name: string;
  bone: string;
  /** Where it was declared: rig.json's `constraints`, or motion.json's `physics` table. */
  in: 'rig.json' | 'motion.json';
}

/**
 * The rig spec and motion spec with every physics constraint left out, and
 * the constraints it left out; null when there is none, so a rig without one
 * is measured from the very build and render it always was.
 *
 * rig-c's render resets physics at frame 0 and steps it by 1/fps (its
 * `spinePoser`), so a constraint still moving at the idle's duration makes
 * the last frame differ from the first by what the simulation is doing, not by
 * what the keys say. `CHECK_LOOP_CLOSES` measures the keys: a rig-c
 * `constraints` entry of `type` `"physics"` and every entry of motion.json's
 * `physics` table are dropped, with what names them only to activate or key
 * them — a skin's `physics` list, and an animation track whose target is a
 * `physics` constraint. Nothing else is touched, and nothing here judges the
 * constraints: the line that names them reports.
 */
export function withoutPhysics(rig: Record<string, unknown>, motion: Record<string, unknown>): { rig: Record<string, unknown>; motion: Record<string, unknown>; physics: LoopPhysics[] } | null {
  const physics: LoopPhysics[] = [];
  const constraints = Array.isArray(rig.constraints) ? rig.constraints : null;
  if (constraints !== null) {
    for (const c of constraints) if (isRecord(c) && c.type === 'physics') physics.push({ name: String(c.name), bone: String(c.bone), in: 'rig.json' });
  }
  const table = isRecord(motion.physics) ? motion.physics : null;
  if (table !== null) for (const [name, e] of Object.entries(table)) physics.push({ name, bone: isRecord(e) ? String(e.bone) : '', in: 'motion.json' });
  if (physics.length === 0) return null;
  const r: Record<string, unknown> = { ...rig };
  if (constraints !== null) {
    const kept = constraints.filter((c) => !(isRecord(c) && c.type === 'physics'));
    if (kept.length > 0) r.constraints = kept;
    else delete r.constraints;
  }
  if (isRecord(rig.skins)) {
    r.skins = Object.fromEntries(Object.entries(rig.skins).map(([skin, entry]) => {
      if (!isRecord(entry) || !('physics' in entry)) return [skin, entry];
      return [skin, Object.fromEntries(Object.entries(entry).filter(([k]) => k !== 'physics'))];
    }));
  }
  const m: Record<string, unknown> = { ...motion };
  delete m.physics;
  if (isRecord(motion.animations)) {
    m.animations = Object.fromEntries(Object.entries(motion.animations).map(([name, a]) => {
      if (!isRecord(a) || !Array.isArray(a.tracks)) return [name, a];
      return [name, { ...a, tracks: a.tracks.filter((t) => !(isRecord(t) && 'physics' in t)) }];
    }));
  }
  return { rig: r, motion: m, physics };
}

/** The one line naming what {@link withoutPhysics} left out of the loop's frames: reported, not judged. */
export function loopPhysicsLine(physics: readonly LoopPhysics[]): string {
  return `loop physics: ${physics.length} physics constraint(s) left out of the loop's frames, reported, not judged — ${physics.map((p) => `"${p.name}" on bone "${p.bone}" (${p.in})`).join(', ')}`;
}

// ---------------------------------------------------------------------------
// pixel measurements
// ---------------------------------------------------------------------------

/** Largest per-channel |a - b| over RGB (alpha dropped, as PIL's `convert("RGB")` does), and the first pixel where it is. */
export function maxRgbDiff(a: Raster, b: Raster): { max: number; x: number; y: number } {
  let max = 0;
  let at = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]);
      if (d > max) {
        max = d;
        at = p;
      }
    }
  }
  return { max, x: at % a.width, y: Math.floor(at / a.width) };
}

/**
 * The motion heat map: frame 0 as grey, blended 0.6 toward a red channel
 * holding each pixel's largest per-channel change from frame 0 across all
 * frames. The grey is PIL's `convert("L")` (`(19595 R + 38470 G + 7471 B +
 * 0x8000) >> 16`) and the blend is PIL's `Image.blend` (`in1 + alpha * (in2 -
 * in1)` with alpha as float32, fused, truncated) — the reference's two calls,
 * measured byte-exact against the reference's own heat maps (ORACLE_check.md).
 */
export function motionHeat(frames: readonly Raster[]): Raster {
  const f0 = frames[0];
  const n = f0.width * f0.height;
  const d = heatField(frames);
  const alpha = Math.fround(0.6);
  // One rounding, to float32, of the exact `in1 + alpha * (in2 - in1)`: the
  // build of Pillow 12.2.0 measured here contracts the expression to a fused
  // multiply-add. Rounding the product first (two roundings) disagreed with it
  // on 33 of 256 values of in1 at in2 = 0; this form agrees on all 65,536
  // (in1, in2) pairs. The product and sum are exact in float64, so one fround
  // IS the fused result.
  const blend = (a: number, b: number): number => Math.trunc(Math.fround(a + alpha * (b - a)));
  const out = newRaster(f0.width, f0.height);
  for (let p = 0; p < n; p++) {
    const l = (f0.data[p * 4] * 19595 + f0.data[p * 4 + 1] * 38470 + f0.data[p * 4 + 2] * 7471 + 0x8000) >>> 16;
    out.data[p * 4] = blend(l, d[p]);
    out.data[p * 4 + 1] = blend(l, 0);
    out.data[p * 4 + 2] = blend(l, 0);
    out.data[p * 4 + 3] = 255;
  }
  return out;
}

export interface SeamFigures {
  mean: number;
  over40: number;
  over80: number;
}

/**
 * The flat stack of parts over the background, in rig pixels: PIL's
 * `alpha_composite` of every part at its `x, y`, in parts.json order, over an
 * opaque canvas of the render's own background colour.
 */
export function flatComposite(parts: PartsFile, partsDir: string, background: readonly [number, number, number, number]): Raster {
  const [W, H] = parts.rig_size;
  let canvas = newRaster(W, H);
  for (let i = 0; i < W * H; i++) canvas.data.set(background, i * 4);
  for (const p of parts.parts) canvas = alphaComposite(canvas, readPng(join(partsDir, `${p.name}.png`)), p.x, p.y);
  return canvas;
}

/**
 * The seam figures: the setup-pose frame vs the flat composite carried onto the
 * frame's pixel grid.
 *
 * Crop pixel (u, v) is world (stage.x + u, stage.y + cropToSpineY(v, H)), and
 * world (wx, wy) is frame pixel ((wx - vp.x) s, (vp.y + vp.height - wy) s), so
 * the map is a scale by s and a translate. It is warped with
 * `src/raster/warp.ts` (cv2's bilinear `warpAffine`, which is also what the
 * reference's `INTER_AREA` flag gets from cv2 — see that file) in float32.
 * cv2's `borderValue` is the background; this warp's border is 0, so the
 * composite is warped as `(pixel - background)` and the background added back,
 * which is the same linear sum. The per-pixel figure is the largest channel
 * |d|, as in the reference.
 */
export function seamFigures(composite: Raster, frame: Raster, stage: StageBox, vp: Viewport, background: readonly [number, number, number, number]): SeamFigures {
  const [W, H] = [composite.width, composite.height];
  const s = vp.scale;
  // The reference hands cv2 the matrix as float32 (`np.float32([[...]])`), and
  // that quantisation moves a sample row across a 1/32-pixel step: in float64
  // one row of one rig's 1216-row frame (C1 in ORACLE_check.md) sampled
  // differently and the unrounded mean drifted 3.1e-4. The map is rounded to
  // float32 the same way.
  const f = Math.fround;
  const map = { sx: f(s), sy: f(s), tx: f((stage.x - vp.x) * s), ty: f((vp.y + vp.height - (stage.y + cropToSpineY(0, H))) * s) };
  const src = newFloatImage(W, H, 3);
  for (let p = 0; p < W * H; p++) for (let c = 0; c < 3; c++) src.data[p * 3 + c] = composite.data[p * 4 + c] - background[c];
  const warped = warpAffine(src, map, vp.pixelWidth, vp.pixelHeight, 'bilinear');
  if (frame.width !== vp.pixelWidth || frame.height !== vp.pixelHeight) {
    refuseIfAny([{ code: 'CHECK_SEAM_FRAME_SIZE', object: 'the setup-pose frame', detail: `is ${frame.width}x${frame.height}; frames.json's viewport is ${vp.pixelWidth}x${vp.pixelHeight}` }]);
  }
  let sum = 0;
  let over40 = 0;
  let over80 = 0;
  const n = vp.pixelWidth * vp.pixelHeight;
  for (let p = 0; p < n; p++) {
    let m = 0;
    for (let c = 0; c < 3; c++) {
      const w = Math.fround(warped.data[p * 3 + c] + background[c]);
      const d = Math.abs(w - frame.data[p * 4 + c]);
      if (d > m) m = d;
    }
    sum += m;
    if (m > SEAM_PX_LEVEL) over40++;
    if (m > SEAM_PX_LEVEL_HIGH) over80++;
  }
  return { mean: sum / n, over40, over80 };
}

/** Python's `round(x, 3)` for the figures written: to three places, on the value's exact decimal expansion. */
function round3(x: number): number {
  return Number(x.toFixed(3));
}

// ---------------------------------------------------------------------------
// the setup pose against the painting (issue #77)
// ---------------------------------------------------------------------------

/** The line `--source` adds: the setup pose against the painting, with assemble's recomposite figures. */
export const SOURCE_LINE = 'SETUP_POSE_VS_SOURCE';

/** The name the setup pose's coverage goes by where assemble's measure names a part. */
export const SETUP_POSE_COVER = '(setup pose)';

/** The throwaway rig whose every slot is tinted black, rendered beside the setup-pose still: the coverage the opaque render does not carry. */
const BLACK_RIG = 'rig_black.json';

/**
 * The rig with every slot tinted black (`color` `000000` with the slot's own
 * alpha kept, and `dark` `000000` where the slot has one), so the setup pose
 * drawn from it is the render's background times what the art lets through.
 */
export function blackRig(rig: Record<string, unknown>): Record<string, unknown> {
  const slots = (Array.isArray(rig.slots) ? rig.slots : []).map((s) => {
    if (!isRecord(s)) return s;
    const alpha = typeof s.color === 'string' && s.color.length === 8 ? s.color.slice(6) : 'ff';
    return { ...s, color: `000000${alpha}`, ...(s.dark === undefined ? {} : { dark: '000000' }) };
  });
  return { ...rig, slots };
}

/**
 * The setup pose against the painting with `assemble`'s recomposite figures,
 * by `assemble`'s own function (`measureRecomposite`): mean |d| and the share
 * within 8 over the mean channel, error pixels over 40 by the max channel, the
 * uncovered ones where nothing has alpha above 128, and their 8-connected
 * holes — over the stage's W x H pixels, which is assemble's population.
 *
 * What stands in for assemble's two inputs, because the setup pose is what is
 * measured and the parts are not read:
 * - **The recomposite.** assemble composites onto opaque white; rigc renders
 *   onto its opaque `background` (232 grey, rig-c's `BACKGROUND`), so the
 *   frame carries no alpha. A second still of the same pose, every slot tinted
 *   black ({@link blackRig}), is the background times what the art lets
 *   through, channel by channel: `black = bg (1 - a)`. The pose over white is
 *   then `open + (255 - bg) black / bg` — exact for every slot drawn with the
 *   normal blend, which is every slot rig-parts writes.
 * - **The coverage.** assemble's "a part has alpha above 128" becomes "the
 *   setup pose has alpha above 128", the alpha read as `255 (1 - black / bg)`
 *   on the channel that lets most through. Where two translucent parts overlap
 *   the stack's alpha exceeds either part's, so a pixel uncovered here is
 *   uncovered in assemble's reading too, never the reverse.
 *
 * Both are carried from the frame's grid onto the stage's with the seam's map
 * turned round (the stage pixel (u, v) is world (stage.x + u, stage.y +
 * cropToSpineY(v, H)), the frame pixel ((wx - vp.x) s, (vp.y + vp.height -
 * wy) s)), through the same bilinear `warpAffine` in float32, the border
 * reading as no art; then rounded to 8 bits, as assemble's composite is.
 */
export function sourceFigures(open: Raster, black: Raster, vp: Viewport, background: readonly [number, number, number, number], stage: StageBox, srcr: Raster): RecompositeFigures {
  const problems: Problem[] = [];
  for (const [label, f] of [['the setup-pose frame', open], ['the black-tinted setup-pose frame', black]] as const) {
    if (f.width !== vp.pixelWidth || f.height !== vp.pixelHeight) problems.push({ code: 'CHECK_SOURCE_GRID', object: label, detail: `is ${f.width}x${f.height}; frames.json's viewport is ${vp.pixelWidth}x${vp.pixelHeight}` });
  }
  if (background[3] !== 255 || background.slice(0, 3).some((c) => c === 0)) {
    problems.push({ code: 'CHECK_SOURCE_GRID', object: 'the render background', detail: `is ${JSON.stringify(background)}; an opaque background with no channel at 0 is required — the coverage is read as how much of it the black-tinted pose lets through` });
  }
  if (srcr.width !== stage.width || srcr.height !== stage.height) problems.push({ code: 'CHECK_SOURCE_GRID', object: 'the painting on the rig canvas', detail: `is ${srcr.width}x${srcr.height}; the stage is ${stage.width}x${stage.height}` });
  refuseIfAny(problems);
  const [W, H] = [stage.width, stage.height];
  const n = vp.pixelWidth * vp.pixelHeight;
  // Ink = 255 - the pose over white, so the warp's border 0 reads as white paper; channel 3 is the coverage alpha.
  const ink = newFloatImage(vp.pixelWidth, vp.pixelHeight, 4);
  for (let p = 0; p < n; p++) {
    let through = 0;
    for (let c = 0; c < 3; c++) {
      const t = black.data[p * 4 + c] / background[c];
      if (t > through) through = t;
      ink.data[p * 4 + c] = 255 - (open.data[p * 4 + c] + (255 - background[c]) * t);
    }
    ink.data[p * 4 + 3] = 255 * (1 - Math.min(1, through));
  }
  const s = vp.scale;
  const f = Math.fround;
  // The seam's map is crop -> frame: x' = s x + (stage.x - vp.x) s, y' = s y + (vp.y + vp.height - (stage.y + cropToSpineY(0, H))) s. This is its inverse.
  const map = { sx: f(1 / s), sy: f(1 / s), tx: f(vp.x - stage.x), ty: f(stage.y + cropToSpineY(0, H) - (vp.y + vp.height)) };
  const warped = warpAffine(ink, map, W, H, 'bilinear');
  const to8 = (v: number): number => Math.min(255, Math.max(0, Math.round(v)));
  const can = newRaster(W, H);
  const cover = newRaster(W, H);
  for (let p = 0; p < W * H; p++) {
    for (let c = 0; c < 3; c++) can.data[p * 4 + c] = to8(255 - warped.data[p * 4 + c]);
    can.data[p * 4 + 3] = 255;
    cover.data[p * 4 + 3] = to8(warped.data[p * 4 + 3]);
  }
  const record: PartRecord = { name: SETUP_POSE_COVER, from: SETUP_POSE_COVER, x: 0, y: 0, w: W, h: H, opaque_px: 0, projected_core_px: 0, source_px_taken: 0, refused_drift_px: 0, merged_px: 0, seam_override_px: 0 };
  return measureRecomposite(can, srcr, [{ record, image: cover }]);
}

/** {@link sourceFigures} as the line `check.json` carries: assemble's `recomposite` block's figures and limits, the largest hole's box, and what was compared. */
export function sourceLine(fig: RecompositeFigures, painting: Raster, stage: StageBox, vp: Viewport): ReportedLine {
  const r = recompositeRecord(fig);
  return {
    status: 'REPORTED',
    painting_px: `${painting.width}x${painting.height}`,
    stage_px: `${stage.width}x${stage.height}`,
    render_px: `${vp.pixelWidth}x${vp.pixelHeight}`,
    render_scale: Number(vp.scale.toFixed(4)),
    mean_abs: r.mean_abs,
    within_limit: r.within_limit,
    within_share: r.within_share,
    error_limit: r.error_limit,
    error_px: r.error_px,
    covered_alpha: r.covered_alpha,
    uncovered_error_px: r.uncovered_error_px,
    hole_count: r.hole_count,
    largest: r.holes.length === 0 ? null : { px: r.holes[0].px, box: boxText(r.holes[0]) },
  };
}

// ---------------------------------------------------------------------------
// the stage
// ---------------------------------------------------------------------------

/** One judgement line (issue #11): its status, the figures it measured, and the bars it held them to — or why it measured nothing. */
export type JudgementLine = { status: 'PASS' | 'FAIL'; [figure: string]: unknown } | { status: 'SKIP'; reason: string };

/** The judgement lines, in the order check.json and the console carry them. */
export const JUDGEMENT_LINES = ['BREATH_VISIBLE', 'BLINK_NO_HOLE', 'CHAIN_LAG', 'TIP_OVER_ROOT', 'STILL_REGIONS_DARK', 'TEXTURE_STRETCH'] as const;
export type JudgementName = (typeof JUDGEMENT_LINES)[number];

/**
 * A line with no bar (issue #25): it reports figures and can never be a FAIL,
 * so `PASS` does not read it. SKIP, with the reason, when there is nothing to
 * report from.
 */
export type ReportedLine = { status: 'REPORTED'; [figure: string]: unknown } | { status: 'SKIP'; reason: string };

/** The reported lines, after the judgement lines, in the order check.json and the console carry them. */
export const REPORTED_LINES = ['RECOMPOSITE_HOLES'] as const;

/** check.json — the reference's fields in its order, then the judgement lines, then PASS. */
export interface CheckFigures {
  gate_spine_html_green: boolean;
  /** Which rigc entry gated the build ({@link readRigcEntry}): provenance, not a bar. */
  rigc_entry: RigcEntryRecord;
  /** How the artifact's page was packed: the `--page-edges` and `--pack-shape` rigc was handed, which its pack line was read to agree with ({@link packEdgeProblems}). Provenance, not a bar. */
  pack_mode: { page_edges: PageEdges; pack_shape: PackShape };
  /** Null when the rig has no idle (issue #77); `skipped.loop` then says why. */
  loop_max_diff: number | null;
  /**
   * Written only when the rig declares a physics constraint (issue #183):
   * each one {@link withoutPhysics} left out of the frames `loop_max_diff` was
   * read from. Reported, not judged; a rig without one writes the keys it always wrote.
   */
  loop_physics?: LoopPhysics[];
  /** The three seam figures: null when there is no parts.json (issue #77); `skipped.seam` then says why. */
  seam_mean: number | null;
  seam_px_over_40: number | null;
  seam_px_over_80: number | null;
  BREATH_VISIBLE: JudgementLine;
  BLINK_NO_HOLE: JudgementLine;
  CHAIN_LAG: JudgementLine;
  TIP_OVER_ROOT: JudgementLine;
  STILL_REGIONS_DARK: JudgementLine;
  TEXTURE_STRETCH: JudgementLine;
  RECOMPOSITE_HOLES: ReportedLine;
  /** Written only under `--source` (issue #77): the setup pose against the painting, REPORTED. */
  SETUP_POSE_VS_SOURCE?: ReportedLine;
  /**
   * Written only when the loop or the seam measured nothing (issue #77): the
   * reason for each, by the name its console line goes by. The judgement and
   * reported lines carry their own SKIP; these two bars have figures, not a
   * status, so their reasons sit here, and a run that measured both writes
   * the keys it always wrote.
   */
  skipped?: { loop?: string; seam?: string };
  /** Written only under `--requirements` (issue #93): the file's fps, the summary, and one line per declared requirement, by name. */
  requirements?: RequirementsBlock;
  PASS: boolean;
}

/** `check.json`'s `requirements` block: the fps every named animation was sampled at, the summary, and each line by its name, in the file's order. */
export interface RequirementsBlock {
  fps: number;
  summary: RequirementsSummary;
  lines: Record<string, RequirementLine>;
}

/** The bars `PASS` reads, in the order the summary counts them: the gate, the reference's two, then the judgement lines. */
export const BARS = ['gate', 'loop', 'seam', ...JUDGEMENT_LINES] as const;

export interface CheckReport {
  figures: CheckFigures;
  gateHtml: string[];
  pack: PackLine[];
  /** Opaque share (alpha > 0) of each packed page, by page file name. */
  packOpaque: Array<{ page: string; share: number }>;
  /** Null when the rig has no idle. */
  idle: { frames: number; fps: number; duration: number; lastIndex: number; loopAt: { x: number; y: number } } | null;
  /** The physics line ({@link loopPhysicsLine}); null when the rig declares no physics constraint or has no idle. */
  loopPhysics: string | null;
  /** The setup-pose still's grid; null when nothing read the still (no parts.json and no `--source`). */
  seamViewport: Viewport | null;
  /** Every bar in {@link BARS} that measured, and every one that did not with its reason. */
  bars: { measured: string[]; skipped: Array<{ bar: string; reason: string }> };
  /** Every bar that was not met, one problem each; empty on PASS. */
  problems: Problem[];
  written: string[];
  /** Under `--requirements` only (issue #93): what `check.json`'s `requirements` block holds; null without the flag. */
  requirements: RequirementsBlock | null;
  /**
   * The animations `motion.json` holds beside the idle (issue #183), in its
   * order: built and gated with the rig, measured by nothing here — every bar
   * reads the idle. Empty when the idle is alone.
   */
  besideIdle: string[];
}

/**
 * The one line `check` prints when `motion.json` holds animations beside the
 * idle (issue #183), or null when it holds none, so a rig of the idle alone
 * prints what it printed before.
 */
export function besideIdleLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return `beside the idle: ${names.length} animation(s), ${names.join(', ')} — built and gated by rigc with the rig, not measured: every bar here reads the idle`;
}

/**
 * One `CHECK_RIGC_GREEN` per line that says why `rigc <what>` was not green:
 * its FAIL and compile-error lines, or, when there are none, {@link causeLines}.
 * A run that printed nothing is still one problem, never none.
 */
export function rigcFailed(what: string, call: RigcCall, lines: readonly string[]): Problem[] {
  const named = lines.filter((l) => l.includes('FAIL') || l.includes('compile error'));
  const quoted = named.length > 0 ? named.map((l) => l.trim()) : causeLines(call.out);
  const object = `\`rigc ${what}\``;
  if (quoted.length === 0) return [{ code: 'CHECK_RIGC_GREEN', object, detail: `exit ${call.status}, and it printed nothing` }];
  return quoted.map((l) => ({ code: 'CHECK_RIGC_GREEN', object, detail: `exit ${call.status}: ${l}` }));
}

/**
 * Run the whole check. Refuses (throws a PartsError) when the inputs are
 * unreadable or a rigc step that everything after it depends on is red — the
 * gate file is written first, so the refusal's evidence is on disk. Otherwise
 * it measures everything it can read, writes every output including
 * `check.json`, and returns the report; `report.problems` names each bar that
 * was not met, and `figures.PASS` is true exactly when it is empty. `mode`
 * reaches rigc's `--page-edges` and `--pack-shape` verbatim, a pack line that
 * disagrees with either is refused (`CHECK_PACK_PAGE_EDGES`,
 * `CHECK_PACK_SHAPE`), and `check.json` records it as `pack_mode`.
 *
 * What it can read (issue #77): the gate always runs, on whatever the spec
 * declares. Without `parts.json` ({@link readCheckInputs}) the seam, the four
 * judgement lines that choose regions by tag and `RECOMPOSITE_HOLES` say SKIP
 * with the reason; without an `idle` the loop and every line that reads idle
 * frames say SKIP, and no idle is rendered (no `idle_frames/`, `contact.png`
 * or `motion_heat.png`). `source` (`--source`) adds {@link SOURCE_LINE}.
 *
 * `requirements` (`--requirements`, issue #93) is read with the rig directory
 * and resolved against it before anything is built ({@link readRequirements},
 * {@link resolveRequirements}); after every line above, each declared
 * requirement is measured ({@link measureRequirements}) into `requirements/`,
 * `check.json` gains its `requirements` block, and every FAIL and NOT
 * MEASURABLE is a problem. Without it nothing here reads, writes or prints
 * anything it did not before.
 */
export function runCheck(rigDir: string, outDir: string, rigc: RigcRunner, partsHome?: string, mode: PackMode = DEFAULT_PACK_MODE, source?: string, requirements?: string): CheckReport {
  let inp: CheckInputs;
  let reqFile: RequirementsFile | null = null;
  let seams: Map<string, SeamPair[]> | null = null;
  if (requirements === undefined) inp = readCheckInputs(rigDir, partsHome, source);
  else {
    // Both readers collect every problem; one refusal names both sets.
    const refused: Problem[] = [];
    const take = <T>(read: () => T): T | null => {
      try {
        return read();
      } catch (err) {
        if (!(err instanceof PartsError)) throw err;
        refused.push(...err.problems);
        return null;
      }
    };
    const got = take(() => readCheckInputs(rigDir, partsHome, source));
    reqFile = take(() => readRequirements(requirements));
    refuseIfAny(refused);
    inp = got as CheckInputs;
    const file = reqFile as RequirementsFile;
    const ready = inp;
    take(() => resolveRequirements(file, ready.rig, ready.motion, ready.rootBone));
    // A seam's pairs are read off parts.json's art (issue #111); both resolvers' problems are named in one refusal.
    if (file.requirements.some((r) => r.kind === 'seam')) {
      const parts = ready.parts;
      seams = take(() => resolveSeams(file, parts === null ? null : parts.parts.map((p) => p.name), ready.noParts, (n) => {
        const rec = (parts as PartsFile).parts.find((p) => p.name === n) as PartRecord;
        return placedArt(rec.x, rec.y, readPng(join(ready.partsDir, `${n}.png`)));
      }));
    }
    refuseIfAny(refused);
  }
  const rigcEntry = readRigcEntry(requireRigcVersion(rigc));
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  const buildDir = join(out, 'build');
  const idleDir = join(out, 'idle_frames');
  const stillDir = join(out, '_still');
  const isoDir = join(out, '_isolated');
  const loopDir = join(out, '_loop');
  for (const d of [buildDir, idleDir, stillDir, isoDir, loopDir]) rmSync(d, { recursive: true, force: true });
  const written: string[] = [];
  const write = (name: string, data: string): void => {
    writeFileSync(join(out, name), data);
    written.push(name);
  };

  // 1. build, packed, under the policy profile
  const build = rigc(['build', '--rig', inp.rigPath, '--motion', inp.motionPath, '--out', buildDir, ...packedBuildArgs(mode)]);
  const gateHtml = buildGateLines(build.out);
  write('gate_spine-html.txt', `${gateHtml.join('\n')}\n`);
  if (build.status !== 0) refuseIfAny(rigcFailed(packedBuildLabel(mode), build, gateHtml));
  const pack = parsePackLines(gateHtml);
  refuseIfAny(packEdgeProblems(pack, mode));
  const packOpaque = pack.filter((p) => existsSync(join(buildDir, p.page))).map((p) => ({ page: p.page, share: opaqueShare(readPng(join(buildDir, p.page))) }));

  // 2. no second gate: `rigc validate --profile spine` of this build measured no rule the build's own two passes
  // had not (14 of the build's 23 on the demo, rigc 1.5.1 and 2.0.3 alike; selftest CH09 holds it), and on rigc's
  // core entry — an install without spine-core — `validate` is refused outright
  const htmlGreen = gateGreen(build.status, gateHtml);

  // What each line reads, and why it cannot when it cannot (issue #77).
  const full: FullInputs | null = inp.parts !== null && inp.idleDuration !== null ? { ...inp, parts: inp.parts, idleDuration: inp.idleDuration } : null;
  const lacking = [inp.noParts, inp.noIdle].filter((r): r is string => r !== null).join('; ');
  const problems: Problem[] = [];

  // 3. the idle, the loop, the heat — only when there is an idle
  let idle: FrameSet | null = null;
  let loop: { max: number; x: number; y: number } | null = null;
  let loopSet: FrameSet | null = null;
  let loopPhysics: LoopPhysics[] | null = null;
  if (inp.idleDuration !== null) {
    const render = rigc(['render', '--candidate', buildDir, '--animation', 'idle', '--fps', String(IDLE_FPS), '--max', String(IDLE_MAX_PX), '--geometry', '--out', idleDir]);
    if (render.status !== 0) refuseIfAny(rigcFailed('render --animation idle --geometry', render, render.out.split('\n').filter((l) => l.includes('FAIL') || l.includes('rigc:'))));
    idle = readFrameSet(idleDir);
    const last = idle.frames[idle.frames.length - 1];
    if (idle.stride !== 1 || idle.written !== idle.sampled || idle.duration !== inp.idleDuration || last.index !== idle.sampled - 1) {
      refuseIfAny([
        {
          code: 'CHECK_LOOP_LAST_FRAME_AT_DURATION',
          object: `idle frame ${last.name}`,
          detail: `rigc sampled ${idle.sampled} frame(s), wrote ${idle.written} at stride ${idle.stride}, the last at t = ${idle.duration}s; the loop compares frame 0 with the frame at the idle's duration, ${inp.idleDuration}s, so a duration that is a whole number of 1/${IDLE_FPS} s ticks and every frame written are required`,
        },
      ]);
    }
    const contact = join(idle.dir, 'contact.png');
    if (existsSync(contact)) {
      copyFileSync(contact, join(out, 'contact.png'));
      written.push('contact.png');
    }
    loop = maxRgbDiff(idle.frames[0].image, last.image);
    loopSet = idle;
    // The keyed loop (issue #183): with a physics constraint, the same rig and motion with every one left out, built
    // the same way and rendered the same way, is what frame 0 and the frame at the duration are read from.
    const stripped = withoutPhysics(inp.rig, inp.motion);
    if (stripped !== null) {
      loopPhysics = stripped.physics;
      try {
        mkdirSync(loopDir, { recursive: true });
        const images = typeof inp.rig.images === 'string' ? resolve(inp.rigDir, inp.rig.images) : inp.rig.images;
        writeFileSync(join(loopDir, 'rig.json'), JSON.stringify({ ...stripped.rig, images }));
        writeFileSync(join(loopDir, 'motion.json'), JSON.stringify(stripped.motion));
        const what = 'the idle with its physics constraint(s) left out';
        const lb = rigc(['build', '--rig', join(loopDir, 'rig.json'), '--motion', join(loopDir, 'motion.json'), '--out', join(loopDir, 'build'), ...packedBuildArgs(mode)]);
        if (lb.status !== 0) refuseIfAny(rigcFailed(`${packedBuildLabel(mode)} (${what})`, lb, buildGateLines(lb.out)));
        const lr = rigc(['render', '--candidate', join(loopDir, 'build'), '--animation', 'idle', '--fps', String(IDLE_FPS), '--max', String(IDLE_MAX_PX), '--out', join(loopDir, 'frames')]);
        if (lr.status !== 0) refuseIfAny(rigcFailed(`render --animation idle (${what})`, lr, lr.out.split('\n').filter((l) => l.includes('FAIL') || l.includes('rigc:'))));
        const kept = readFrameSet(join(loopDir, 'frames'));
        const keptLast = kept.frames[kept.frames.length - 1];
        if (kept.stride !== 1 || kept.written !== kept.sampled || keptLast.index !== last.index) {
          refuseIfAny([
            {
              code: 'CHECK_LOOP_LAST_FRAME_AT_DURATION',
              object: `idle frame ${keptLast.name} (${what})`,
              detail: `rigc sampled ${kept.sampled} frame(s), wrote ${kept.written} at stride ${kept.stride}; the idle as written ends at ${last.name}, and the loop compares frame 0 with that frame`,
            },
          ]);
        }
        loop = maxRgbDiff(kept.frames[0].image, keptLast.image);
        loopSet = kept;
      } finally {
        rmSync(loopDir, { recursive: true, force: true });
      }
    }
    const idleImages = idle.frames.map((f) => f.image);
    writePng(join(out, 'motion_heat.png'), motionHeat(idleImages));
    written.push('motion_heat.png');
  }

  // 3b. the parts a judgement reads alone: each rendered by its own slots, on the whole rig's grid
  const isolated = (label: string, ps: readonly PartRecord[]): FrameSet => {
    const dir = join(isoDir, label);
    const r = rigc(['render', '--candidate', buildDir, '--animation', 'idle', '--fps', String(IDLE_FPS), '--max', String(IDLE_MAX_PX), '--slot', ps.map((p) => p.name).join(','), '--out', dir]);
    if (r.status !== 0) refuseIfAny(rigcFailed(`render --animation idle --slot ${ps.map((p) => p.name).join(',')}`, r, r.out.split('\n').filter((l) => l.includes('FAIL') || l.includes('rigc:'))));
    return readFrameSet(dir);
  };
  let breath: JudgementLine = skip(lacking);
  let tip: JudgementLine = skip(lacking);
  if (full !== null) {
    try {
      breath = breathLine(full, isolated, problems);
      if (idle !== null) tip = tipLine(full, join(idle.dir, GEOMETRY_FILE), idle.written, problems);
    } finally {
      rmSync(isoDir, { recursive: true, force: true });
    }
  }
  let chain: JudgementLine = skip(inp.noIdle ?? '');
  let stretch: JudgementLine = skip(inp.noIdle ?? '');
  let still: JudgementLine = skip(lacking);
  if (idle !== null) {
    chain = chainLine(inp, problems);
    // One reader for the one geometry file: the stretch reads its meshes, the still regions every slot and the head bone.
    const geometryPath = join(idle.dir, GEOMETRY_FILE);
    const geometry = readGeometry(geometryPath, idle.written);
    stretch = stretchLine(geometry, geometryPath, problems);
    if (full !== null) still = stillLine(full, idle, geometry, geometryPath, problems);
  }

  // 4. the setup pose as a one-key throwaway animation — the seam reads it against the parts, the source line against
  // the painting — and, beside it, the same pose with the eyes shut
  let seam: SeamFigures | null = null;
  let seamViewport: Viewport | null = null;
  let blink: JudgementLine = skip(lacking);
  let sourceRead: ReportedLine | null = null;
  if (inp.parts !== null || inp.source !== null) {
    try {
      mkdirSync(stillDir, { recursive: true });
      const images = typeof inp.rig.images === 'string' ? resolve(inp.rigDir, inp.rig.images) : inp.rig.images;
      writeFileSync(join(stillDir, 'rig.json'), JSON.stringify({ ...inp.rig, images }));
      const eyes = full === null ? [] : partsTagged(full.parts, EYE_TAGS);
      const slotBone = new Map((Array.isArray(inp.rig.slots) ? inp.rig.slots : []).filter(isRecord).map((sl) => [String(sl.name), String(sl.bone)]));
      const shut = full === null ? [] : blinkTracks(inp.motion, eyeBones(inp.rig, eyes.map((p) => slotBone.get(p.name) ?? '')));
      const animations: Record<string, unknown> = {
        still: { duration: STILL_DURATION, loop: false, tracks: [{ bone: inp.rootBone, property: 'rotate', keys: [{ t: 0, v: [0] }, { t: STILL_DURATION, v: [0] }] }] },
      };
      if (eyes.length > 0 && shut.length > 0) {
        animations[BLINK_ANIMATION] = {
          duration: STILL_DURATION,
          loop: false,
          tracks: shut.map((b) => ({ ...b.target, property: 'scaley', keys: [{ t: 0, v: [b.closed] }, { t: STILL_DURATION, v: [b.closed] }] })),
        };
      }
      writeFileSync(join(stillDir, 'motion.json'), JSON.stringify({ ...inp.motion, animations }));
      const sb = rigc(['build', '--rig', join(stillDir, 'rig.json'), '--motion', join(stillDir, 'motion.json'), '--out', join(stillDir, 'build'), '--profile', 'spine']);
      if (sb.status !== 0) refuseIfAny(rigcFailed('build (the setup-pose still)', sb, buildGateLines(sb.out)));
      // The stage is the parts' canvas wherever parts.json is read (CHECK_RIG_STAGE_IS_THE_CANVAS), so this is its longest side.
      const maxSide = Math.ceil(Math.max(inp.stage.width, inp.stage.height));
      const sr = rigc(['render', '--candidate', join(stillDir, 'build'), '--animation', 'still', '--fps', String(STILL_FPS), '--max', String(maxSide), '--out', join(stillDir, 'render')]);
      if (sr.status !== 0) refuseIfAny(rigcFailed('render (the setup-pose still)', sr, sr.out.split('\n').filter((l) => l.includes('FAIL'))));
      const stillSet = readFrameSet(join(stillDir, 'render'));
      seamViewport = stillSet.viewport;
      if (inp.parts !== null) {
        const composite = flatComposite(inp.parts, inp.partsDir, stillSet.background);
        seam = seamFigures(composite, stillSet.frames[0].image, inp.stage, stillSet.viewport, stillSet.background);
      }
      if (inp.source !== null) {
        // The same pose with every slot tinted black, built with the same animations so rigc fits the same grid.
        writeFileSync(join(stillDir, BLACK_RIG), JSON.stringify(blackRig({ ...inp.rig, images })));
        const kb = rigc(['build', '--rig', join(stillDir, BLACK_RIG), '--motion', join(stillDir, 'motion.json'), '--out', join(stillDir, 'black_build'), '--profile', 'spine']);
        if (kb.status !== 0) refuseIfAny(rigcFailed('build (the setup-pose still, every slot tinted black)', kb, buildGateLines(kb.out)));
        const kr = rigc(['render', '--candidate', join(stillDir, 'black_build'), '--animation', 'still', '--fps', String(STILL_FPS), '--max', String(maxSide), '--out', join(stillDir, 'black')]);
        if (kr.status !== 0) refuseIfAny(rigcFailed('render (the setup-pose still, every slot tinted black)', kr, kr.out.split('\n').filter((l) => l.includes('FAIL'))));
        const blackSet = readFrameSet(join(stillDir, 'black'));
        if (!sameViewport(stillSet.viewport, blackSet.viewport) || stillSet.background.join(',') !== blackSet.background.join(',')) {
          refuseIfAny([
            {
              code: 'CHECK_SOURCE_GRID',
              object: 'the black-tinted setup-pose still',
              detail: `is on ${JSON.stringify(blackSet.viewport)} over ${JSON.stringify(blackSet.background)}; the setup-pose still is on ${JSON.stringify(stillSet.viewport)} over ${JSON.stringify(stillSet.background)}, and the coverage is read pixel for pixel between the two`,
            },
          ]);
        }
        const srcr = sourceInRig(inp.source.painting, inp.stage.width, inp.stage.height);
        const fig = sourceFigures(stillSet.frames[0].image, blackSet.frames[0].image, stillSet.viewport, stillSet.background, inp.stage, srcr);
        sourceRead = sourceLine(fig, inp.source.painting, inp.stage, stillSet.viewport);
      }
      if (full !== null) {
        const H = full.parts.rig_size[1];
        if (eyes.length === 0) blink = skip(`no part comes from a See-through ${tagWords(EYE_TAGS)} layer, so there is no eye to look behind`);
        else if (shut.length === 0) blink = skip(`no idle "scaley" track on the bones of ${quoteParts(eyes)} goes below its first key, so the idle has no blink`);
        else {
          const br = rigc(['render', '--candidate', join(stillDir, 'build'), '--animation', BLINK_ANIMATION, '--fps', String(STILL_FPS), '--max', String(maxSide), '--out', join(stillDir, 'blink')]);
          if (br.status !== 0) refuseIfAny(rigcFailed(`render (the setup pose with the eyes shut, "${BLINK_ANIMATION}")`, br, br.out.split('\n').filter((l) => l.includes('FAIL'))));
          blink = blinkLine(full, eyes, shut, stillSet, readFrameSet(join(stillDir, 'blink')), idle as FrameSet, H, problems);
        }
      }
    } finally {
      rmSync(stillDir, { recursive: true, force: true });
    }
  }

  // 5. the scene's declared requirements (issue #93), only under --requirements
  const reqProblems: Problem[] = [];
  const reqBlock = reqFile === null ? null : measureRequirements(inp, reqFile, buildDir, out, rigc, reqProblems, seams ?? new Map());

  const skipped: { loop?: string; seam?: string } = {};
  if (inp.noIdle !== null) skipped.loop = inp.noIdle;
  if (inp.noParts !== null) skipped.seam = inp.noParts;
  const figures: CheckFigures = {
    gate_spine_html_green: htmlGreen,
    rigc_entry: rigcEntry,
    pack_mode: { page_edges: mode.pageEdges, pack_shape: mode.packShape },
    loop_max_diff: loop === null ? null : loop.max,
    ...(loopPhysics === null ? {} : { loop_physics: loopPhysics }),
    seam_mean: seam === null ? null : round3(seam.mean),
    seam_px_over_40: seam === null ? null : seam.over40,
    seam_px_over_80: seam === null ? null : seam.over80,
    BREATH_VISIBLE: breath,
    BLINK_NO_HOLE: blink,
    CHAIN_LAG: chain,
    TIP_OVER_ROOT: tip,
    STILL_REGIONS_DARK: still,
    TEXTURE_STRETCH: stretch,
    RECOMPOSITE_HOLES: inp.parts === null ? { status: 'SKIP', reason: inp.noParts ?? '' } : holesLine(inp.parts),
    ...(sourceRead === null ? {} : { [SOURCE_LINE]: sourceRead }),
    ...(Object.keys(skipped).length === 0 ? {} : { skipped }),
    ...(reqBlock === null ? {} : { requirements: reqBlock }),
    PASS: false,
  };
  const barProblems: Problem[] = [];
  if (!htmlGreen) barProblems.push(...rigcFailed(packedBuildLabel(mode), build, gateHtml));
  if (loop !== null && idle !== null && loopSet !== null && loop.max !== LOOP_MAX_BAR) {
    const last = idle.frames[idle.frames.length - 1];
    barProblems.push({
      code: 'CHECK_LOOP_CLOSES',
      object: `idle frame f0000.png vs ${last.name} (t = ${idle.duration}s)${loopPhysics === null ? '' : ', its physics constraint(s) left out'}`,
      detail: `max |d| ${loop.max}/255, first at pixel ${loop.x},${loop.y} of ${loopSet.viewport.pixelWidth}x${loopSet.viewport.pixelHeight}; ${LOOP_MAX_BAR} is required — the idle's last key must equal its first`,
    });
  }
  if (figures.seam_mean !== null && figures.seam_px_over_40 !== null && (figures.seam_mean > SEAM_MEAN_BAR || figures.seam_px_over_40 > SEAM_PX_BAR)) {
    barProblems.push({
      code: 'CHECK_SEAM_WITHIN_BAR',
      object: 'the setup-pose render vs the flat composite of parts/',
      detail: `mean |d| ${figures.seam_mean}/255 and ${figures.seam_px_over_40} px over ${SEAM_PX_LEVEL} (${figures.seam_px_over_80} over ${SEAM_PX_LEVEL_HIGH}); mean <= ${SEAM_MEAN_BAR.toFixed(1)} and <= ${SEAM_PX_BAR} px over ${SEAM_PX_LEVEL} are required`,
    });
  }
  const rank = (q: Problem): number => JUDGEMENT_LINES.findIndex((n) => q.code === `CHECK_${n}`);
  problems.sort((a, b) => rank(a) - rank(b));
  problems.unshift(...barProblems);
  problems.push(...reqProblems);
  figures.PASS = problems.length === 0;
  write('check.json', `${JSON.stringify(figures, null, 1)}\n`);
  const bars: CheckReport['bars'] = { measured: ['gate'], skipped: [] };
  const tally = (bar: string, reason: string | null): void => {
    if (reason === null) bars.measured.push(bar);
    else bars.skipped.push({ bar, reason });
  };
  tally('loop', skipped.loop ?? null);
  tally('seam', skipped.seam ?? null);
  for (const n of JUDGEMENT_LINES) {
    const l = figures[n];
    tally(n, l.status === 'SKIP' ? l.reason : null);
  }
  return {
    figures,
    gateHtml,
    pack,
    packOpaque,
    idle: idle === null || loop === null ? null : { frames: idle.frames.length, fps: idle.fps, duration: idle.duration, lastIndex: idle.frames[idle.frames.length - 1].index, loopAt: { x: loop.x, y: loop.y } },
    loopPhysics: loopPhysics === null ? null : loopPhysicsLine(loopPhysics),
    seamViewport,
    bars,
    problems,
    written,
    requirements: reqBlock,
    besideIdle: isRecord(inp.motion.animations) ? Object.keys(inp.motion.animations).filter((n) => n !== 'idle') : [],
  };
}

// ---------------------------------------------------------------------------
// the scene's declared requirements (issue #93)
// ---------------------------------------------------------------------------

/** Where `check` writes the requirement renders, under `--out`: `as-declared/<animation>/`, `released/<name>/`, `full/<name>/`. */
export const REQUIREMENTS_DIR = 'requirements';

/** The throwaway copies' specs and builds, under `--out`; removed before the stage returns. */
const REQUIREMENTS_SCRATCH = '_requirements';

/**
 * Measure every requirement of a file {@link resolveRequirements} has passed.
 * Every pose is rig-c's: each animation a requirement names is rendered
 * once with `--geometry` at the file's fps, from the rig under test's own
 * build — or, when the file places scene targets for it, from a copy with
 * them written in ({@link placeTargets}, built `--profile spine`, as the setup
 * still is) — into `requirements/as-declared/<animation>/`. Each `follow` adds
 * two copies, released and full ({@link forceMix}), the scene targets placed
 * on both, rendered into `requirements/released/<name>/` and
 * `requirements/full/<name>/`. The released copy's constraint is muted
 * throughout, which rig-c's A47 (ik) or A48 (transform) refuses unless
 * the rig declares the mix consumer-driven: when the gate refuses that copy
 * for that constraint and nothing else ({@link mutedOnly}), the copy — never
 * the rig under test — declares it in `invariants.consumerDrivenMix`, rigc's
 * own door, and the line says so. A copy rigc refuses otherwise is refused,
 * `CHECK_RIGC_GREEN`, quoting rigc. Lines go into the returned block; each
 * FAIL and NOT MEASURABLE into `problems`.
 */
export function measureRequirements(inp: CheckInputs, file: RequirementsFile, buildDir: string, out: string, rigc: RigcRunner, problems: Problem[], seams: ReadonlyMap<string, readonly SeamPair[]> = new Map()): RequirementsBlock {
  const reqDir = join(out, REQUIREMENTS_DIR);
  const scratch = join(out, REQUIREMENTS_SCRATCH);
  for (const d of [reqDir, scratch]) rmSync(d, { recursive: true, force: true });
  mkdirSync(reqDir, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  const images = typeof inp.rig.images === 'string' ? resolve(inp.rigDir, inp.rig.images) : inp.rig.images;
  const base = { ...inp.rig, images };
  let copies = 0;
  const buildCopy = (rig: Record<string, unknown>, motion: Record<string, unknown>): { dir: string; call: RigcCall } => {
    const dir = join(scratch, `copy${copies++}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rig.json'), JSON.stringify(rig));
    writeFileSync(join(dir, 'motion.json'), JSON.stringify(motion));
    return { dir: join(dir, 'build'), call: rigc(['build', '--rig', join(dir, 'rig.json'), '--motion', join(dir, 'motion.json'), '--out', join(dir, 'build'), '--profile', 'spine']) };
  };
  const green = (b: { dir: string; call: RigcCall }, what: string): string => {
    if (b.call.status !== 0) refuseIfAny(rigcFailed(`build (${what})`, b.call, buildGateLines(b.call.out)));
    return b.dir;
  };
  const posesOf = (candidate: string, animation: string, dir: string, label: string): { poses: Poses; geo: IdleGeometry; path: string } => {
    const r = rigc(['render', '--candidate', candidate, '--animation', animation, '--fps', String(file.fps), '--max', String(IDLE_MAX_PX), '--geometry', '--out', dir]);
    if (r.status !== 0) refuseIfAny(rigcFailed(`render --animation ${animation} --geometry (${label})`, r, r.out.split('\n').filter((l) => l.includes('FAIL') || l.includes('rigc:'))));
    const set = readFrameSet(dir);
    if (set.written !== set.sampled || set.stride !== 1) {
      refuseIfAny([{ code: 'CHECK_REQUIREMENTS_FRAMES', object: `${dir} (${label})`, detail: `rigc sampled ${set.sampled} frame(s) and wrote ${set.written} at stride ${set.stride}; every sampled frame is required, since a requirement holds over all of them` }]);
    }
    const path = join(set.dir, GEOMETRY_FILE);
    const geo = readGeometry(path, set.written);
    if (geo === null) return geometryProblem(path, 'does not exist; `rigc render --geometry` writes it, and every requirement is measured from it');
    const cache = new Map<string, { setup: BoneWorld; frames: BoneWorld[] }>();
    const bone = (name: string): { setup: BoneWorld; frames: BoneWorld[] } => {
      const hit = cache.get(name);
      if (hit !== undefined) return hit;
      const t = boneTrackOf(geo, path, set, name);
      if (typeof t === 'string') return geometryProblem(path, t);
      const v = { setup: t.setup, frames: t.frames };
      cache.set(name, v);
      return v;
    };
    const root = boneTrackOf(geo, path, set, inp.rootBone);
    if (typeof root === 'string') return geometryProblem(path, root);
    return { poses: { label, indices: geo.frames.map((f) => f.index), times: root.times, bone }, geo, path };
  };

  const lines: Record<string, RequirementLine> = {};
  try {
    const placed = new Map<string, { rig: Record<string, unknown>; motion: Record<string, unknown> }>();
    const placedFor = (animation: string): { rig: Record<string, unknown>; motion: Record<string, unknown> } => {
      let p = placed.get(animation);
      if (p === undefined) {
        p = placeTargets(base, inp.motion, file.targets, animation, inp.stage);
        placed.set(animation, p);
      }
      return p;
    };
    const declared = new Map<string, { poses: Poses; geo: IdleGeometry; path: string }>();
    for (const r of file.requirements) {
      if (declared.has(r.animation)) continue;
      const scene = file.targets.some((t) => t.animation === r.animation);
      const label = scene ? `as declared, the scene targets of "${r.animation}" placed` : 'as declared';
      const candidate = scene ? green(buildCopy(placedFor(r.animation).rig, placedFor(r.animation).motion), `the rig ${label}`) : buildDir;
      declared.set(r.animation, posesOf(candidate, r.animation, join(reqDir, 'as-declared', r.animation), label));
    }
    for (const r of file.requirements) {
      const d = declared.get(r.animation) as { poses: Poses; geo: IdleGeometry; path: string };
      const scene = placedFor(r.animation);
      const facts = rigFacts(scene.rig, inp.stage);
      let line: RequirementLine;
      if (r.kind === 'contact') line = contactLine(r, d.poses, facts);
      else if (r.kind === 'aim') line = aimLine(r, d.poses, facts);
      else if (r.kind === 'range') line = rangeLine(r, d.poses, facts);
      else if (r.kind === 'stretch') line = stretchRequirementLine(r, d.geo.meshes, d.geo.frames, d.poses);
      else if (r.kind === 'seam') {
        const shown = attachmentPoses(d.path, d.poses.indices.length);
        const frames: SeamFrame[] = shown.map((f) => ({ part: f.get(r.part) ?? null, neighbour: f.get(r.neighbour) ?? null }));
        line = seamLine(r, seams.get(r.name) ?? [], frames, d.poses, inp.stage);
      } else {
        const rel = forceMix(scene.rig, scene.motion, r, 0);
        let relBuild = buildCopy(rel.rig, rel.motion);
        let door: string | null = null;
        if (relBuild.call.status !== 0 && mutedOnly(buildGateLines(relBuild.call.out).filter((l) => l.includes('FAIL')).map((l) => l.trim()), r)) {
          relBuild = buildCopy(declareConsumerDriven(rel.rig, r), rel.motion);
          door = `${mutedLine(r).rule} refused the released copy (its mix is 0 throughout), so that copy alone declares ${r.constraint_type} constraint "${r.constraint}" in invariants.consumerDrivenMix`;
        }
        const released = posesOf(green(relBuild, `the released copy of "${r.name}": ${r.constraint_type} constraint "${r.constraint}" ${r.property} mix forced to 0`), r.animation, join(reqDir, 'released', r.name), 'released');
        const fullCopy = forceMix(scene.rig, scene.motion, r, 1);
        const full = posesOf(green(buildCopy(fullCopy.rig, fullCopy.motion), `the full copy of "${r.name}": ${r.constraint_type} constraint "${r.constraint}" ${r.property} mix forced to 1`), r.animation, join(reqDir, 'full', r.name), 'full');
        const same = (a: Poses, b: Poses): boolean => a.times.length === b.times.length && a.times.every((t, i) => t === b.times[i] && a.indices[i] === b.indices[i]);
        if (!same(d.poses, released.poses) || !same(d.poses, full.poses)) {
          refuseIfAny([{ code: 'CHECK_REQUIREMENTS_FRAMES', object: `requirement "${r.name}"`, detail: `the as-declared, released and full renders of "${r.animation}" sample frames at [${d.poses.times.join(', ')}], [${released.poses.times.join(', ')}] and [${full.poses.times.join(', ')}] s; the follow is read frame by frame across the three, so the same frames are required` }]);
        }
        line = { ...followLine(r, d.poses, released.poses, full.poses), released_copy: door ?? 'built as forced: rig-c\'s gate passed it with no further declaration' };
      }
      lines[r.name] = line;
      const p = requirementProblem(r, line);
      if (p !== null) problems.push(p);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { fps: file.fps, summary: requirementsSummary(file, new Map(Object.entries(lines))), lines };
}

// ---------------------------------------------------------------------------
// the judgement lines (issue #11)
// ---------------------------------------------------------------------------

/**
 * `RECOMPOSITE_HOLES`: `parts.json`'s `recomposite` block as a line — the
 * uncovered error pixels, how many holes they make, and the largest hole's box
 * and bordering parts. Read, not measured: the block is what assemble measured
 * on the painting, which check never sees. REPORTED, never FAIL, because no
 * bar for a hole is derivable by the rule the judgement bars follow: both
 * public examples hold hundreds of holes of a few dozen pixels along part
 * edges (453 on demo, the largest 70 px; 259 on sample, the largest 94 px),
 * and whether a hole matters depends on where it is — which the box and the
 * bordering parts say and a count cannot (AUTHORING §7).
 */
export function holesLine(parts: PartsFile): ReportedLine {
  const r = parts.recomposite;
  if (r === undefined) return { status: 'SKIP', reason: 'parts.json has no "recomposite" block (a parts.json the reference wrote has none); re-run assemble, which writes it' };
  return {
    status: 'REPORTED',
    error_px: r.error_px,
    uncovered_error_px: r.uncovered_error_px,
    hole_count: r.hole_count,
    largest: r.holes.length === 0 ? null : { px: r.holes[0].px, box: boxText(r.holes[0]), borders: r.holes[0].borders.map((b) => `${b.part} ${b.px} px`) },
  };
}

function boxText(h: { x: number; y: number; w: number; h: number }): string {
  return `${h.x},${h.y} ${h.w}x${h.h}`;
}

/** The throwaway animation that holds the blink tracks at their closed value, rendered beside the setup-pose still. */
export const BLINK_ANIMATION = 'blink_shut';

function skip(reason: string): JudgementLine {
  return { status: 'SKIP', reason };
}

function tagWords(tags: readonly BaseTag[]): string {
  return tags.map((t) => `"${t}"`).join(' or ');
}

function quoteParts(ps: readonly PartRecord[]): string {
  return ps.map((p) => `"${p.name}"`).join(', ');
}

type Isolate = (label: string, ps: readonly PartRecord[]) => FrameSet;

/** (1) The torso moves while the feet do not: each rendered alone, heat over its own box. */
function breathLine(inp: FullInputs, isolated: Isolate, problems: Problem[]): JudgementLine {
  const torso = partsTagged(inp.parts, TORSO_TAGS);
  const feet = partsTagged(inp.parts, FEET_TAGS);
  if (torso.length === 0) return skip(`no part comes from a See-through ${tagWords(TORSO_TAGS)} layer, so there is no torso to see breathe`);
  if (feet.length === 0) return skip(`no part comes from a See-through ${tagWords(FEET_TAGS)} layer, so there are no feet to hold still`);
  const H = inp.parts.rig_size[1];
  const ts = isolated('torso', torso);
  const fs = isolated('feet', feet);
  const tb = frameBox(torso, H, inp.stage, ts.viewport);
  const fb = frameBox(feet, H, inp.stage, fs.viewport);
  if (tb === null || fb === null) return skip(`the ${tb === null ? 'torso' : 'feet'} box falls outside the idle frame`);
  const th = regionHeat(heatField(ts.frames.map((f) => f.image)), ts.viewport.pixelWidth, tb);
  const fh = regionHeat(heatField(fs.frames.map((f) => f.image)), fs.viewport.pixelWidth, fb);
  const mean = round3(th.mean);
  const ok = mean >= BREATH_TORSO_MEAN_FLOOR && fh.max <= BREATH_FEET_MAX_CEILING;
  if (mean < BREATH_TORSO_MEAN_FLOOR) {
    problems.push({
      code: 'CHECK_BREATH_VISIBLE',
      object: `torso ${quoteParts(torso)} rendered alone, frame box ${boxLabel(tb)}`,
      detail: `heat mean ${mean}/255 over the idle; >= ${BREATH_TORSO_MEAN_FLOOR} is required — the chest's breath track moves too little, or the torso is not weighted to the bone it keys`,
    });
  }
  if (fh.max > BREATH_FEET_MAX_CEILING) {
    problems.push({
      code: 'CHECK_BREATH_VISIBLE',
      object: `feet ${quoteParts(feet)} rendered alone, frame box ${boxLabel(fb)}`,
      detail: `heat max ${fh.max}/255 over the idle; <= ${BREATH_FEET_MAX_CEILING} is required — the feet move: their slot rides, or their mesh is weighted to, a bone the idle keys`,
    });
  }
  return {
    status: ok ? 'PASS' : 'FAIL',
    torso_parts: torso.map((p) => p.name),
    torso_heat_mean: mean,
    torso_floor: BREATH_TORSO_MEAN_FLOOR,
    feet_parts: feet.map((p) => p.name),
    feet_heat_max: fh.max,
    feet_ceiling: BREATH_FEET_MAX_CEILING,
  };
}

/**
 * What `TIP_OVER_ROOT` is measured with, written into its line (issue #118):
 * the idle's posed geometry, not a render of the part. Until #118 the line
 * read rendered pixels — figures in frame px under `root_px`/`tip_px` — so an
 * old and a new check.json are told apart by this key and by the units in
 * the field names.
 */
export const TIP_INSTRUMENT = 'geometry';

/**
 * (4) Each swinging part's tip travels further than its root: how far the art
 * in the lower half of the part's box travels against the upper half — the
 * centroid of the art's area inside each fixed half, through the posed mesh
 * ({@link halfTravels}) — read off the idle's `geometry.json`. Until issue
 * #118 the halves were read off the part rendered alone at `--max 640`, a
 * binary-coverage centroid per half; every root half on the three examples
 * travels under a frame pixel, where that centroid scatters by up to 0.3 px
 * with the grid, so the ratio was set by the grid.
 */
function tipLine(inp: FullInputs, geometryPath: string, frames: number, problems: Problem[]): JudgementLine {
  const swing = partsTagged(inp.parts, SWING_TAGS);
  if (swing.length === 0) return skip(`no part comes from a See-through ${tagWords(SWING_TAGS)} layer, so there is no hem or sleeve to swing`);
  const poses = attachmentPoses(geometryPath, frames);
  const rows: Array<Record<string, unknown>> = [];
  let measured = 0;
  let failed = false;
  for (const p of swing) {
    const art = placedArt(p.x, p.y, readPng(join(inp.partsDir, `${p.name}.png`)));
    const shown = poses.map((f) => f.get(p.name) ?? null);
    const t = halfTravels(art, p, inp.stage, shown);
    if (t.root === null || t.tip === null) {
      rows.push({ part: p.name, unmeasured: shown[0] === null ? 'its slot shows no attachment on idle frame 0' : `on idle frame 0 the ${t.root === null ? 'upper' : 'lower'} half of its box holds no art its attachment draws` });
      continue;
    }
    measured++;
    const ratio = t.root > 0 ? round3(t.tip / t.root) : null;
    const ok = ratio === null ? t.tip > 0 : ratio >= TIP_RATIO_FLOOR;
    rows.push({ part: p.name, root_rig_px: round3(t.root), tip_rig_px: round3(t.tip), ratio });
    if (!ok) {
      failed = true;
      problems.push({
        code: 'CHECK_TIP_OVER_ROOT',
        object: `part "${p.name}", box ${p.x},${p.y} ${p.w}x${p.h} rig px, posed by the idle's geometry`,
        detail: `the art in its lower half travels ${round3(t.tip)} rig px and in its upper half ${round3(t.root)} rig px (ratio ${ratio ?? 'undefined: nothing moves'}); a ratio >= ${TIP_RATIO_FLOOR} is required — the chain's amplitudes do not grow toward the tip, or the mesh is not weighted to the chain`,
      });
    }
  }
  if (measured === 0) return { status: 'SKIP', reason: `none of ${quoteParts(swing)} could be measured: ${rows.map((r) => `${String(r.part)}: ${String(r.unmeasured)}`).join('; ')}` };
  return { status: failed ? 'FAIL' : 'PASS', instrument: TIP_INSTRUMENT, parts: rows, ratio_floor: TIP_RATIO_FLOOR };
}

/**
 * The bone the face is measured in the frame of (issue #33): the bone every
 * `face`-tagged part's slot rides in rig.json — which is the bone the config's
 * `regions.<part>` (or, for a mesh, its first segment) names for it, carried
 * into the rig spec by the rig stage. Never a bone found by its name.
 */
export type HeadBone = { bone: string } | { none: string };

export function headBoneOf(inp: Pick<FullInputs, 'rig' | 'parts'>): HeadBone {
  const face = partsTagged(inp.parts, FACE_TAGS);
  if (face.length === 0) return { none: `no part comes from a See-through ${tagWords(FACE_TAGS)} layer` };
  const slotBone = new Map((Array.isArray(inp.rig.slots) ? inp.rig.slots : []).filter(isRecord).map((sl) => [String(sl.name), typeof sl.bone === 'string' ? sl.bone : null]));
  const bones = [...new Set(face.map((p) => slotBone.get(p.name) ?? null))];
  if (bones.length === 1 && bones[0] !== null) return { bone: bones[0] };
  return { none: `the face parts ride ${face.map((p) => `"${p.name}" on ${JSON.stringify(slotBone.get(p.name) ?? null)}`).join(', ')}; the head frame is one bone's, so they must share a slot bone` };
}

/**
 * One bone's world transform at the setup pose and on every frame of a set,
 * off the geometry {@link readGeometry} read beside those frames. A string
 * (the reason) when the set has no geometry file; a `CHECK_GEOMETRY_FILE`
 * refusal when the file disagrees with the frames it sits beside in what the
 * face half needs and the stretch does not read: the viewport (the transforms
 * would be carried onto another grid), the frame indices, the bone on the
 * setup pose and on every frame with six finite numbers, and each frame's time.
 */
export function boneTrackOf(geo: IdleGeometry | null, path: string, set: FrameSet, bone: string): BoneTrack | string {
  if (geo === null) return `${path} does not exist, so no bone's per-frame transform is known (rigc render writes it with --geometry)`;
  const gv = geo.viewport;
  const vp = set.viewport;
  const keys: Array<keyof Viewport> = ['x', 'y', 'width', 'height', 'scale', 'pixelWidth', 'pixelHeight'];
  const off = keys.filter((k) => gv?.[k] !== vp[k]);
  if (off.length > 0) return geometryProblem(path, `viewport ${off.map((k) => `${k} ${JSON.stringify(gv?.[k])}`).join(', ')}; the frames.json beside it says ${off.map((k) => `${k} ${vp[k]}`).join(', ')} — the transforms would be carried onto another grid`);
  const world = (bones: unknown, at: string): BoneWorld => {
    const b = Array.isArray(bones) ? bones.filter(isRecord).find((x) => x.name === bone) : undefined;
    if (b === undefined) return geometryProblem(path, `${at} has no bone "${bone}"`);
    const f = ['a', 'b', 'c', 'd', 'worldX', 'worldY'] as const;
    const bad = f.filter((k) => typeof b[k] !== 'number' || !Number.isFinite(b[k]));
    if (bad.length > 0) return geometryProblem(path, `${at} bone "${bone}" field(s) ${bad.map((k) => `"${k}" ${JSON.stringify(b[k])}`).join(', ')}; finite numbers are required`);
    return { a: b.a as number, b: b.b as number, c: b.c as number, d: b.d as number, worldX: b.worldX as number, worldY: b.worldY as number };
  };
  if (geo.frames.length !== set.frames.length || geo.frames.some((f, i) => f.index !== set.frames[i].index)) {
    return geometryProblem(path, `holds frame(s) [${geo.frames.map((f) => String(f.index)).join(', ')}]; the set holds [${set.frames.map((f) => f.index).join(', ')}]`);
  }
  const badTime = geo.times.findIndex((t) => typeof t !== 'number' || !Number.isFinite(t));
  if (badTime >= 0) return geometryProblem(path, `frame ${String(geo.frames[badTime].index)} field "time" is ${JSON.stringify(geo.times[badTime])}; a number of seconds is required`);
  return { bone, setup: world(geo.setupBones, 'setup'), frames: geo.frameBones.map((bs, i) => world(bs, `frame ${String(geo.frames[i].index)}`)), times: geo.times as number[] };
}

/** {@link readGeometry} then {@link boneTrackOf}, for a frame set's own `geometry.json`. */
export function readBoneTrack(set: FrameSet, bone: string): BoneTrack | string {
  const path = join(set.dir, GEOMETRY_FILE);
  return boneTrackOf(readGeometry(path, set.written), path, set, bone);
}

/**
 * What `STILL_REGIONS_DARK` is measured with, written into each half (issue
 * #123): the idle's posed geometry, not its frames. Until #123 the face half
 * compared a heat mean in the head's frame with twice the resampler's own and
 * the feet half a screen-space heat mean with a ceiling, both read off the
 * idle's pixels, so an old and a new check.json are told apart by this key.
 */
export const STILL_INSTRUMENT = 'geometry';

/** Four significant figures: a figure that may be a rounding residue near 1e-12 keeps its size rather than reading 0. */
function sig4(x: number): number {
  return x === 0 ? 0 : Number(x.toPrecision(4));
}

/**
 * The slots the idle moves on purpose, by slot rather than by bone: every slot
 * a `deform` or `sequence` entry or a slot-targeted track of the idle names.
 * A still-set candidate rides the head bone alone, so a bone track cannot move
 * it relative to that bone; what can is a key on the slot itself.
 */
function idleDrivenSlots(motion: Record<string, unknown>): Set<string> {
  const anims = isRecord(motion.animations) ? motion.animations : {};
  const idle = isRecord(anims.idle) ? anims.idle : {};
  const named = new Set<string>();
  for (const key of ['deform', 'sequence', 'tracks']) {
    const list = idle[key];
    if (!Array.isArray(list)) continue;
    for (const t of list) if (isRecord(t) && typeof t.slot === 'string') named.add(t.slot);
  }
  return named;
}

/**
 * Whether every attachment the default skin gives a slot is carried by one
 * bone alone: a region or an unweighted mesh on a slot of that bone, or a mesh
 * whose every weight names it.
 */
function ridesOnly(rig: Record<string, unknown>, slot: string, slotBone: string | undefined, bone: string): boolean {
  const skins = isRecord(rig.skins) ? rig.skins : {};
  const skin = isRecord(skins.default) ? skins.default : {};
  const atts = isRecord(skin[slot]) ? Object.values(skin[slot]) : [];
  if (atts.length === 0) return false;
  return atts.every((a) => {
    if (!isRecord(a)) return false;
    const type = a.type ?? 'region';
    if (type === 'region') return slotBone === bone;
    if (type !== 'mesh') return false;
    if (!Array.isArray(a.weights)) return slotBone === bone;
    return a.weights.every((v) => Array.isArray(v) && v.length > 0 && v.every((w) => isRecord(w) && w.bone === bone));
  });
}

/** One half's figures (issue #123): the still set's displacement in the reference frame, its tolerance, and the reported crossings. */
interface StillHalf {
  figures: Record<string, unknown>;
  over: Array<{ slot: string; max: number; frame: number }>;
  rms: number;
  tolerance: number;
}

/**
 * (7) Nothing moves that should hold still (issue #123), read off the idle's
 * posed geometry. The face half asks whether the face and the parts drawn
 * over it that the head carries keep their place relative to the head bone —
 * the bone the face's slot rides — over the idle; the feet half whether the
 * feet keep theirs on the screen (they ride the root, which the idle does not
 * key, so the screen is their own frame).
 *
 * The face's still set, derived from the rig and the motion, never from a
 * list: the `face` slots, and every slot drawn after the first of them whose
 * art overlaps a face part's art at the setup pose, whose every attachment the
 * head bone alone carries ({@link ridesOnly}), and which the idle does not key
 * by slot ({@link idleDrivenSlots}, reported as `driven_slots`). The features
 * the blink and the brows move ride bones of their own, so they are not in it.
 * The feet's still set is the `footwear` slots.
 *
 * Each still slot's art is carried through its posed attachment back into the
 * reference frame on every idle frame and compared with its setup position
 * ({@link stillReading}); the figure is the largest displacement, with the RMS
 * beside it, and the bar is the arithmetic's own tolerance
 * ({@link stillTolerance}) — nothing may move. How far another slot's art
 * swings into the region (`face` on top at the setup pose, clear of where the
 * features go; `footwear` on top) is reported per slot, `crossing`, with no
 * bar ({@link crossingOf}). No render grid enters either half.
 */
export function stillLine(inp: FullInputs, idle: FrameSet, geo: IdleGeometry | null, geometryPath: string, problems: Problem[]): JudgementLine {
  const face = partsTagged(inp.parts, FACE_TAGS);
  const feet = partsTagged(inp.parts, FEET_TAGS);
  if (face.length === 0 && feet.length === 0) return skip(`no part comes from a See-through ${tagWords([...FACE_TAGS, ...FEET_TAGS])} layer, so there is no still region to read`);
  if (geo === null) return skip(`${geometryPath} does not exist; \`rigc render --geometry\` (rig-c ${RIGC_GEOMETRY_VERSION} or later) writes it, and the still regions are read off it`);
  const H = inp.parts.rig_size[1];
  const W = inp.parts.rig_size[0];
  const poses = attachmentPoses(geometryPath, idle.written);
  const top = topmostIndex(inp.parts, (i) => readPng(join(inp.partsDir, `${inp.parts.parts[i].name}.png`)));
  const index = new Map(inp.parts.parts.map((p, i) => [p.name, i]));
  const record = new Map(inp.parts.parts.map((p) => [p.name, p]));
  const slots = (Array.isArray(inp.rig.slots) ? inp.rig.slots : []).filter(isRecord).map((sl) => ({ name: String(sl.name), bone: typeof sl.bone === 'string' ? sl.bone : undefined }));
  const slotBone = new Map(slots.map((sl) => [sl.name, sl.bone]));
  const arts = new Map<string, ArtMask>();
  const artOf = (name: string): ArtMask => {
    let a = arts.get(name);
    if (a === undefined) {
      const p = record.get(name) as PartRecord;
      a = placedArt(p.x, p.y, readPng(join(inp.partsDir, `${name}.png`)));
      arts.set(name, a);
    }
    return a;
  };
  const shownOf = (slot: string): Array<PosedTriangles | null> => poses.map((f) => f.get(slot) ?? null);
  const frameIndex = (k: number | null): number | null => (k === null ? null : idle.frames[k].index);

  /** The still set measured in one frame, and every later slot's crossing into `region`. */
  const half = (still: readonly string[], firstSlot: number, maps: readonly FrameMap[], entryMax: number, coordFloor: number, region: RigRegion): StillHalf => {
    const rows: Array<Record<string, unknown>> = [];
    const over: StillHalf['over'] = [];
    let worst: { slot: string; max: number; frame: number | null } | null = null;
    let sumSq = 0;
    let weight = 0;
    let coordMax = coordFloor;
    const readings = still.map((slot) => ({ slot, r: stillReading(artOf(slot), inp.stage, shownOf(slot), maps) }));
    for (const { r } of readings) coordMax = Math.max(coordMax, r.coordMax);
    const tolerance = stillTolerance(coordMax, entryMax);
    for (const { slot, r } of readings) {
      if (r.max === null) {
        rows.push({ slot, unmeasured: 'no idle frame shows it' });
        continue;
      }
      sumSq += r.sumSq;
      weight += r.weight;
      rows.push({ slot, max_rig_px: sig4(r.max), rms_rig_px: sig4(r.weight > 0 ? Math.sqrt(r.sumSq / r.weight) : 0) });
      if (worst === null || r.max > worst.max) worst = { slot, max: r.max, frame: frameIndex(r.frame) };
      if (r.max > tolerance) over.push({ slot, max: r.max, frame: frameIndex(r.frame) as number });
    }
    const crossing: Array<Record<string, unknown>> = [];
    for (const sl of slots.slice(firstSlot + 1)) {
      if (still.includes(sl.name) || !record.has(sl.name)) continue;
      const c = crossingOf(artOf(sl.name), inp.stage, shownOf(sl.name), maps, region);
      // Art that only touches the region within the arithmetic's tolerance has not entered it.
      if (c !== null && c.depth > tolerance) crossing.push({ slot: sl.name, depth_rig_px: round3(c.depth), area_rig_px2: round3(c.area), frame: frameIndex(c.frame) });
    }
    const rms = weight > 0 ? Math.sqrt(sumSq / weight) : 0;
    return {
      figures: {
        instrument: STILL_INSTRUMENT,
        still_slots: rows,
        max_rig_px: worst === null ? null : sig4(worst.max),
        // Where the largest displacement is, only when it is a motion: below the tolerance it is rounding, and its place is noise.
        at: worst === null || worst.max <= tolerance ? null : { slot: worst.slot, frame: worst.frame },
        rms_rig_px: sig4(rms),
        tolerance_rig_px: sig4(tolerance),
        crossing,
      },
      over,
      rms,
      tolerance,
    };
  };
  const regionOf = (idx: ReadonlySet<number>, exclude: readonly WorldBox[]): RigRegion => {
    const data = new Uint8Array(W * H);
    for (let v = 0; v < H; v++) {
      for (let u = 0; u < W; u++) {
        if (!idx.has(top[v * W + u])) continue;
        const x0 = inp.stage.x + u;
        const y1 = inp.stage.y + cropToSpineY(v, H);
        if (exclude.some((e) => x0 + 1 > e.x0 && x0 < e.x1 && y1 > e.y0 && y1 - 1 < e.y1)) continue;
        data[v * W + u] = 1;
      }
    }
    return { width: W, height: H, data };
  };
  const firstOf = (names: readonly string[]): number => Math.min(...names.map((n) => slots.findIndex((sl) => sl.name === n)).filter((i) => i >= 0));

  const faceHalf = (): Record<string, unknown> | string => {
    if (face.length === 0) return `no part comes from a See-through ${tagWords(FACE_TAGS)} layer`;
    const head = headBoneOf(inp);
    if (!('bone' in head)) return `no head bone to measure it in: ${head.none}`;
    const track = boneTrackOf(geo, geometryPath, idle, head.bone);
    if (typeof track === 'string') return track;
    const maps: FrameMap[] = [];
    for (const f of track.frames) {
      const m = setupToFrame(track.setup, f);
      if (m === null) return `the head bone "${head.bone}" has a singular setup transform, so there is no head frame to carry the face into`;
      maps.push(m);
    }
    const entries = [track.setup, ...track.frames];
    const entryMax = Math.max(...entries.map((b) => Math.max(Math.abs(b.a), Math.abs(b.b), Math.abs(b.c), Math.abs(b.d))));
    const coordFloor = Math.max(...entries.map((b) => Math.max(Math.abs(b.worldX), Math.abs(b.worldY))));
    // The features are left out of the region where they go in the head's frame, not only where they sit at rest.
    const features = partsTagged(inp.parts, FACE_FEATURE_TAGS);
    const swept: WorldBox[] = [];
    for (const p of features) {
      const ft = boneTrackOf(geo, geometryPath, idle, slotBone.get(p.name) ?? '');
      if (typeof ft === 'string') return `no track for feature "${p.name}"'s bone: ${ft}`;
      const sb = sweptBox(partWorldBox(p, H, inp.stage), ft, track);
      if (sb === null) return `feature "${p.name}"'s bone or the head bone "${head.bone}" has a singular transform on a frame, so where the feature goes in the head's frame is not known`;
      swept.push(sb);
    }
    const faceNames = face.map((p) => p.name);
    const first = firstOf(faceNames);
    const faceArt = faceNames.map(artOf);
    const overFace = (name: string): boolean => {
      const a = artOf(name);
      return faceArt.some((f) => {
        for (let y = Math.max(a.y, f.y); y < Math.min(a.y + a.height, f.y + f.height); y++) {
          for (let x = Math.max(a.x, f.x); x < Math.min(a.x + a.width, f.x + f.width); x++) if (a.data[(y - a.y) * a.width + x - a.x] === 1 && f.data[(y - f.y) * f.width + x - f.x] === 1) return true;
        }
        return false;
      });
    };
    const drivenNames = idleDrivenSlots(inp.motion);
    const driven: string[] = [];
    const still = [...faceNames];
    for (const sl of slots.slice(first + 1)) {
      if (still.includes(sl.name) || !record.has(sl.name) || !ridesOnly(inp.rig, sl.name, sl.bone, head.bone) || !overFace(sl.name)) continue;
      if (drivenNames.has(sl.name)) driven.push(sl.name);
      else still.push(sl.name);
    }
    const h = half(still, first, maps, entryMax, coordFloor, regionOf(new Set(face.map((p) => index.get(p.name) as number)), swept));
    for (const o of h.over) {
      problems.push({
        code: 'CHECK_STILL_REGIONS_DARK',
        object: `slot "${o.slot}" of the face's still set (${still.map((n) => `"${n}"`).join(', ')}), in the frame of its head bone "${head.bone}"`,
        detail: `its art moves ${sig4(o.max)} rig px relative to that bone at idle frame ${o.frame} (RMS over the still set ${sig4(h.rms)}); at most ${sig4(h.tolerance)} rig px is required — the arithmetic's own rounding, so nothing may move — a mesh over the face weighted to a bone the head does not carry, or the face mesh deformed by another bone`,
      });
    }
    return { parts: faceNames, head_bone: head.bone, ...h.figures, driven_slots: driven };
  };

  const feetHalf = (): Record<string, unknown> | string => {
    if (feet.length === 0) return `no part comes from a See-through ${tagWords(FEET_TAGS)} layer`;
    const names = feet.map((p) => p.name);
    const h = half(names, firstOf(names), poses.map(() => null), 1, 0, regionOf(new Set(feet.map((p) => index.get(p.name) as number)), []));
    for (const o of h.over) {
      problems.push({
        code: 'CHECK_STILL_REGIONS_DARK',
        object: `slot "${o.slot}" of the feet (${names.map((n) => `"${n}"`).join(', ')}), in screen space`,
        detail: `its art moves ${sig4(o.max)} rig px at idle frame ${o.frame} (RMS over the feet ${sig4(h.rms)}); at most ${sig4(h.tolerance)} rig px is required — the arithmetic's own rounding — something that should hold still moves: a mesh weighted to a swinging bone, or a part that rides the wrong bone`,
      });
    }
    return { parts: names, ...h.figures };
  };

  const f = faceHalf();
  const t = feetHalf();
  if (typeof f === 'string' && typeof t === 'string') return skip(`face: ${f}; feet: ${t}`);
  const failed = problems.some((q) => q.code === 'CHECK_STILL_REGIONS_DARK');
  return { status: failed ? 'FAIL' : 'PASS', face: typeof f === 'string' ? { unmeasured: f } : f, feet: typeof t === 'string' ? { unmeasured: t } : t };
}

function fmt3(x: number): string {
  return x.toFixed(3);
}

/** (3) Down every chain the phase lags and the amplitude does not shrink, read off motion.json's rotate tracks. */
export function chainLine(inp: Pick<CheckInputs, 'rig' | 'motion'>, problems: Problem[]): JudgementLine {
  const cf = chainFigures(inp.rig, inp.motion);
  const long = cf.chains.filter((c) => c.length >= 2);
  if (cf.edges.length === 0 && long.length === 0) {
    return skip(`no idle "rotate" track sits under another at the same period${cf.unread.length > 0 ? ` (unread, not sampled sines: ${cf.unread.join(', ')})` : ''}, so there is no chain to lag`);
  }
  const violations: string[] = [];
  for (const e of cf.edges) {
    if (round3(e.step) < CHAIN_LAG_MIN_STEP) {
      const v = `"${e.child}" follows its keyed ancestor "${e.parent}" by ${fmt3(e.step)} cycle(s)`;
      violations.push(v);
      problems.push({ code: 'CHECK_CHAIN_LAG', object: `bone "${e.child}" under "${e.parent}"`, detail: `phase step ${fmt3(e.step)} cycle(s); >= ${CHAIN_LAG_MIN_STEP} is required — a link must lag the one above it (a larger "phase", or a positive "lag" on the chain track)` });
    }
  }
  for (const c of long) {
    for (let i = 1; i < c.length; i++) {
      const a = round3(c[i - 1].reading.amp);
      const b = round3(c[i].reading.amp);
      if (b < a) {
        violations.push(`"${c[i].bone}" swings ${fmt3(b)} under "${c[i - 1].bone}"'s ${fmt3(a)}`);
        problems.push({ code: 'CHECK_CHAIN_LAG', object: `bone "${c[i].bone}" in the chain from "${c[0].bone}"`, detail: `amplitude ${fmt3(b)} below the link above's ${fmt3(a)}; non-decreasing down the chain is required — "amps" grow toward the tip` });
      }
    }
  }
  const minStep = cf.edges.length === 0 ? null : round3(Math.min(...cf.edges.map((e) => e.step)));
  return {
    status: violations.length === 0 ? 'PASS' : 'FAIL',
    chains: long.map((c) => `${c.map((l) => l.bone).join(' > ')}: period ${round3(c[0].reading.period)}s, phase ${c.map((l) => fmt3(l.reading.phase)).join(' ')}, amp ${c.map((l) => fmt3(l.reading.amp)).join(' ')}`),
    lags: cf.edges.map((e) => `${e.parent} > ${e.child} ${e.step >= 0 ? '+' : ''}${fmt3(e.step)}`),
    min_step: minStep,
    step_floor: CHAIN_LAG_MIN_STEP,
    other_period: cf.otherPeriod.map((e) => `${e.parent} > ${e.child}`),
    unread: cf.unread,
    first_violation: violations[0] ?? null,
  };
}

function sameViewport(a: Viewport, b: Viewport): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.scale === b.scale && a.pixelWidth === b.pixelWidth && a.pixelHeight === b.pixelHeight;
}

/** (2) The setup pose with the blink tracks held at their closed value, against the setup pose, inside the eye box. */
function blinkLine(
  inp: CheckInputs,
  eyes: readonly PartRecord[],
  shut: ReturnType<typeof blinkTracks>,
  open: FrameSet,
  closed: FrameSet,
  idle: FrameSet,
  H: number,
  problems: Problem[],
): JudgementLine {
  if (!sameViewport(open.viewport, closed.viewport)) return skip(`the closed-eye render's grid ${JSON.stringify(closed.viewport)} is not the setup still's ${JSON.stringify(open.viewport)}, so the two cannot be compared pixel for pixel`);
  const box = frameBox(eyes, H, inp.stage, open.viewport);
  if (box === null) return skip('the eye box falls outside the setup-pose frame');
  const b = blinkFigures(open.frames[0].image, closed.frames[0].image, open.background, box, BLINK_PATCH_LEVEL);
  const from = Math.max(...shut.map((s) => s.window[0]));
  const to = Math.min(...shut.map((s) => s.window[1]));
  const frames = framesInside(from, to, idle.fps, idle.sampled);
  if (b.holePx > BLINK_HOLE_BAR) {
    problems.push({
      code: 'CHECK_BLINK_NO_HOLE',
      object: `the eye box ${boxLabel(box)} (${quoteParts(eyes)}) with the eyes shut`,
      detail: `${b.holePx} px show the background where the open eye had art; ${BLINK_HOLE_BAR} is required — the layer under the eye has no art there (See-through left it empty), so a closed eye opens a hole`,
    });
  }
  return {
    status: b.holePx > BLINK_HOLE_BAR ? 'FAIL' : 'PASS',
    eye_parts: eyes.map((p) => p.name),
    closed: shut.map((s) => `${'bone' in s.target ? `bone ${s.target.bone}` : `group ${s.target.group}`} scaley ${s.closed} from ${s.window[0]}s to ${s.window[1]}s`),
    idle_frames_closed: frames,
    box_px: b.px,
    hole_px: b.holePx,
    hole_bar: BLINK_HOLE_BAR,
    patch_max: b.patchMax,
    patch_px_over_40: b.patchOver,
  };
}

// ---------------------------------------------------------------------------
// texture stretch (issue #31): rigc's geometry export
// ---------------------------------------------------------------------------

/** `major.minor.patch` of a `rigc --version` line, or null when it holds none. */
export function parseRigcVersion(out: string): [number, number, number] | null {
  const m = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Refuse, before anything is built, a rigc older than
 * {@link RIGC_GEOMETRY_VERSION}: its `render` has no `--geometry`, so the idle
 * render would fail on the flag after the build had run, and
 * the refusal would name a flag rather than the version that lacks it.
 * Returns what `--version` printed, stdout then stderr, which is where
 * {@link readRigcEntry} reads the entry.
 */
export function requireRigcVersion(rigc: RigcRunner): string {
  const v = rigc(['--version']);
  const got = v.status === 0 ? parseRigcVersion(v.out) : null;
  const need = parseRigcVersion(RIGC_GEOMETRY_VERSION) as [number, number, number];
  const below = got !== null && (got[0] - need[0] || got[1] - need[1] || got[2] - need[2]) < 0;
  if (got === null || below) {
    refuseIfAny([
      {
        code: 'CHECK_RIGC_VERSION',
        object: '`rigc --version`',
        detail: `${got === null ? `exit ${v.status}, printed ${JSON.stringify(v.out.trim().split('\n')[0] ?? '')} — no version` : `is ${got.join('.')}`}; rig-c ${RIGC_GEOMETRY_VERSION} or later is required — its \`render --geometry\` writes the skinned mesh vertices TEXTURE_STRETCH is measured from (\`bun install\` puts this package's own rig-c at node_modules/.bin/rigc)`,
      },
    ]);
  }
  return v.out;
}

export interface IdleGeometry {
  meshes: MeshRest[];
  frames: GeometryPose[];
  /** The rest, carried as read for {@link boneTrackOf}, which checks what it uses: the viewport, the setup pose's and each frame's `bones`, each frame's `time`. */
  viewport: Record<string, unknown> | null;
  setupBones: unknown;
  frameBones: unknown[];
  times: unknown[];
}

function geometryProblem(object: string, detail: string): never {
  refuseIfAny([{ code: 'CHECK_GEOMETRY_FILE', object, detail }]);
  throw new Error('unreachable');
}

function numberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/**
 * The mesh half of a `rigc-geometry/1` file: every `rest` entry of kind
 * `mesh`, and each frame's attachments. Null when the file does not exist
 * (the line then says SKIP, naming it); a file that exists and does not hold
 * `frames` frames of well-formed vertices is refused naming what is wrong,
 * because a figure read off a half-written export would be a wrong number
 * printed as a measurement.
 */
export function readGeometry(path: string, frames: number): IdleGeometry | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return geometryProblem(path, `does not parse as JSON: ${(err as Error).message}`);
  }
  if (!isRecord(raw) || raw.spec !== GEOMETRY_SPEC) return geometryProblem(path, `"spec" is ${JSON.stringify(isRecord(raw) ? raw.spec : raw)?.slice(0, 40)}; ${JSON.stringify(GEOMETRY_SPEC)} is required`);
  if (!Array.isArray(raw.rest) || !Array.isArray(raw.frames)) return geometryProblem(path, 'lacks "rest" or "frames"; a rigc-geometry/1 file carries both');
  if (raw.frames.length !== frames) return geometryProblem(path, `holds ${raw.frames.length} frame(s); the frame set beside it wrote ${frames}`);
  const meshes: MeshRest[] = [];
  for (const [i, r] of raw.rest.entries()) {
    if (!isRecord(r) || r.kind !== 'mesh') continue;
    const at = `rest[${i}] (slot ${JSON.stringify(r.slot)}, attachment ${JSON.stringify(r.attachment)})`;
    if (typeof r.slot !== 'string' || typeof r.attachment !== 'string') return geometryProblem(path, `${at} has no string "slot" and "attachment"`);
    if (!numberArray(r.vertices) || r.vertices.length % 2 !== 0) return geometryProblem(path, `${at} "vertices" is not an even-length array of finite numbers`);
    const n = r.vertices.length / 2;
    const tri = r.triangles;
    if (!numberArray(tri) || tri.length % 3 !== 0 || !tri.every((x) => Number.isInteger(x) && x >= 0 && x < n)) return geometryProblem(path, `${at} "triangles" is not index triplets into its ${n} vertices`);
    meshes.push({ slot: r.slot, attachment: r.attachment, vertices: r.vertices, triangles: tri });
  }
  const want = new Map(meshes.map((m) => [`${m.slot}\u0000${m.attachment}`, m.vertices.length]));
  const poses: GeometryPose[] = [];
  for (const [i, f] of raw.frames.entries()) {
    if (!isRecord(f) || typeof f.index !== 'number' || !Array.isArray(f.attachments)) return geometryProblem(path, `frames[${i}] has no "index" or "attachments"`);
    const attachments: GeometryPose['attachments'][number][] = [];
    for (const a of f.attachments) {
      if (!isRecord(a) || typeof a.slot !== 'string' || typeof a.attachment !== 'string') continue;
      const n = want.get(`${a.slot}\u0000${a.attachment}`);
      if (n === undefined) continue;
      if (!numberArray(a.vertices) || a.vertices.length !== n) {
        return geometryProblem(path, `frame ${f.index} mesh "${a.slot}" attachment "${a.attachment}" has ${Array.isArray(a.vertices) ? a.vertices.length : 'no'} vertex number(s); its rest entry has ${n}`);
      }
      attachments.push({ slot: a.slot, attachment: a.attachment, vertices: a.vertices });
    }
    poses.push({ index: f.index, attachments });
  }
  return {
    meshes,
    frames: poses,
    viewport: isRecord(raw.viewport) ? raw.viewport : null,
    setupBones: isRecord(raw.setup) ? raw.setup.bones : undefined,
    frameBones: raw.frames.map((f) => (isRecord(f) ? f.bones : undefined)),
    times: raw.frames.map((f) => (isRecord(f) ? f.time : undefined)),
  };
}

/**
 * Every attachment a `rigc-geometry/1` file shows, frame by frame, keyed by
 * its slot: the posed vertices with the rest vertices and triangles of the
 * same slot and attachment — regions and meshes alike, which a seam
 * requirement reads (issue #111). Read only for a `seam` requirement, so a
 * run without one reads the file exactly as before ({@link readGeometry}).
 * A file that is not a whole export of `frames` frames — a rest entry without
 * well-formed vertices and triangles, a frame showing an attachment with no
 * rest entry or another vertex count — is refused naming what is wrong.
 */
export function attachmentPoses(path: string, frames: number): Array<Map<string, PosedAttachment>> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return geometryProblem(path, `does not read as JSON: ${(err as Error).message}`);
  }
  if (!isRecord(raw) || !Array.isArray(raw.rest) || !Array.isArray(raw.frames)) return geometryProblem(path, 'lacks "rest" or "frames"; a rigc-geometry/1 file carries both');
  if (raw.frames.length !== frames) return geometryProblem(path, `holds ${raw.frames.length} frame(s); the frame set beside it wrote ${frames}`);
  const rest = new Map<string, { vertices: number[]; triangles: number[] }>();
  for (const [i, r] of raw.rest.entries()) {
    if (!isRecord(r) || typeof r.slot !== 'string' || typeof r.attachment !== 'string') return geometryProblem(path, `rest[${i}] has no string "slot" and "attachment"`);
    const at = `rest[${i}] (slot ${JSON.stringify(r.slot)}, attachment ${JSON.stringify(r.attachment)})`;
    if (!numberArray(r.vertices) || r.vertices.length % 2 !== 0) return geometryProblem(path, `${at} "vertices" is not an even-length array of finite numbers`);
    const n = r.vertices.length / 2;
    const tri = r.triangles;
    if (!numberArray(tri) || tri.length % 3 !== 0 || !tri.every((x) => Number.isInteger(x) && x >= 0 && x < n)) return geometryProblem(path, `${at} "triangles" is not index triplets into its ${n} vertices`);
    rest.set(`${r.slot}\u0000${r.attachment}`, { vertices: r.vertices, triangles: tri });
  }
  return raw.frames.map((f, i) => {
    if (!isRecord(f) || !Array.isArray(f.attachments)) return geometryProblem(path, `frames[${i}] has no "attachments"`);
    const shown = new Map<string, PosedAttachment>();
    for (const a of f.attachments) {
      if (!isRecord(a) || typeof a.slot !== 'string' || typeof a.attachment !== 'string') return geometryProblem(path, `frames[${i}] holds an attachment with no string "slot" and "attachment"`);
      const r = rest.get(`${a.slot}\u0000${a.attachment}`);
      if (r === undefined) return geometryProblem(path, `frames[${i}] shows slot "${a.slot}" attachment "${a.attachment}", which "rest" has no entry for`);
      if (!numberArray(a.vertices) || a.vertices.length !== r.vertices.length) return geometryProblem(path, `frames[${i}] slot "${a.slot}" attachment "${a.attachment}" has ${Array.isArray(a.vertices) ? a.vertices.length : 'no'} vertex number(s); its rest entry has ${r.vertices.length}`);
      shown.set(a.slot, { rest: r.vertices, posed: a.vertices, triangles: r.triangles });
    }
    return shown;
  });
}

function stretchAtText(s: { triangle: number; vertices: readonly number[]; edge: readonly number[]; frame: number }): string {
  return `triangle ${s.triangle} (vertices ${s.vertices.join(' ')}), edge ${s.edge.join('-')}, idle frame ${s.frame}`;
}

/**
 * (6) No visible texture stretch: for every mesh triangle, each edge's length
 * in each idle frame over its rest length (the setup pose's bones, no deform —
 * which on both examples is the art's own proportions, the attachment's `uvs`
 * times its size, to 2.4e-5). The figure is the rig's worst max(ratio,
 * 1/ratio); each mesh's largest and smallest ratio, and where, are the detail.
 * SKIP when the render wrote no geometry file or the rig draws no mesh.
 */
export function stretchLine(geo: IdleGeometry | null, path: string, problems: Problem[]): JudgementLine {
  if (geo === null) return skip(`${path} does not exist; \`rigc render --geometry\` (rig-c ${RIGC_GEOMETRY_VERSION} or later) writes it, and the skinned mesh vertices are read from it`);
  if (geo.meshes.length === 0) return skip('the rig draws no mesh attachment (every slot is a region), so there is no triangle to stretch');
  const figures = stretchFigures(geo.meshes, geo.frames);
  const rows: Array<Record<string, unknown>> = [];
  let worst: { mesh: (typeof figures)[number]; at: NonNullable<(typeof figures)[number]['max']>; severity: number } | null = null;
  let maxAll: number | null = null;
  let minAll: number | null = null;
  let failed = false;
  for (const m of figures) {
    if (m.degenerate.length > 0) {
      failed = true;
      problems.push({
        code: 'CHECK_TEXTURE_STRETCH',
        object: `mesh "${m.slot}" attachment "${m.attachment}"`,
        detail: `${m.degenerate.length} rest edge(s) of length 0, the first triangle ${m.degenerate[0].triangle} edge ${m.degenerate[0].edge.join('-')}; no stretch ratio can be read off an edge with no rest length — two of the mesh's vertices coincide at the setup pose`,
      });
    }
    if (m.max === null || m.min === null) {
      rows.push({ slot: m.slot, triangles: m.triangles, unmeasured: 'no idle frame shows this attachment' });
      continue;
    }
    const sMax = stretchSeverity(m.max.ratio);
    const sMin = stretchSeverity(m.min.ratio);
    const at = sMin > sMax ? m.min : m.max;
    const severity = round3(Math.max(sMax, sMin));
    if (worst === null || severity > worst.severity) worst = { mesh: m, at, severity };
    maxAll = maxAll === null ? m.max.ratio : Math.max(maxAll, m.max.ratio);
    minAll = minAll === null ? m.min.ratio : Math.min(minAll, m.min.ratio);
    rows.push({ slot: m.slot, triangles: m.triangles, max_ratio: round3(m.max.ratio), max_at: stretchAtText(m.max), min_ratio: round3(m.min.ratio), min_at: stretchAtText(m.min), severity });
    if (severity > TEXTURE_STRETCH_CEILING) {
      failed = true;
      problems.push({
        code: 'CHECK_TEXTURE_STRETCH',
        object: `mesh "${m.slot}" ${stretchAtText(at)}`,
        detail: `the edge is ${round3(at.ratio)} times its rest length (max(ratio, 1/ratio) ${severity}); <= ${TEXTURE_STRETCH_CEILING} is required — the texture on it is ${at.ratio >= 1 ? 'stretched' : 'squeezed'}: the bones this mesh is weighted to move apart (amplitudes too large down a chain), or a vertex blends bones that move against each other`,
      });
    }
  }
  if (worst === null) return { status: 'SKIP', reason: `no idle frame shows any of the rig's ${figures.length} mesh(es): ${figures.map((m) => `"${m.slot}"`).join(', ')}` };
  return {
    status: failed ? 'FAIL' : 'PASS',
    meshes: figures.length,
    triangles: figures.reduce((n, m) => n + m.triangles, 0),
    frames: geo.frames.length,
    severity: worst.severity,
    severity_ceiling: TEXTURE_STRETCH_CEILING,
    worst: { slot: worst.mesh.slot, triangle: worst.at.triangle, vertices: worst.at.vertices, edge: worst.at.edge, frame: worst.at.frame, ratio: round3(worst.at.ratio) },
    max_ratio: round3(maxAll as number),
    min_ratio: round3(minAll as number),
    per_mesh: rows,
  };
}

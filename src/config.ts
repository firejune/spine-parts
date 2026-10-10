/**
 * The character config: everything character-specific the CPU stages read,
 * plus the optional blocks for the two GPU stages.
 *
 * One file per character, filled in as the loop runs. What a step requires is
 * what that step reads, and {@link CONFIG_REQUIRES} states it once per loader:
 * the full loader, in front of `rig` and `build`, requires `key`, `assemble`,
 * `bones`, `meshes`, `regions` and `motion`; the early doors, in front of the
 * steps that run before `propose` has drafted the rig, require less.
 * `generation` is read only by the optional image-generation adapter; a
 * character whose painting came from anywhere else leaves it out.
 *
 * 🔒 **Every key is known or refused.** An unknown key is refused by name and
 * so is a missing one — a config that half-loads is a rig nobody can reason
 * about. There are two open doors, and both lead nowhere — nothing reads what
 * stands behind them. Annotation: `note`, and any key ending in `_note`, may
 * hold a string anywhere an object is expected. Annotations are how a hand
 * correction records its reason beside the value it corrected, and refusing
 * them would push that reason out of the file. Record: any key beginning with
 * `x-` and at least one character after it may hold any JSON value in the same
 * places (issue #70) — a project's own provenance, such as the gate results of
 * a past build or the seeds a search rejected, kept beside the conditions that
 * made the rig. The record test comes first, so `x-seed_note` is a record. The
 * part-name maps (`meshes`, `regions`, `motion.blink.still`) are not objects
 * in this sense: their keys are part names, and an `x-` key there is a part
 * name like any other. No stage writes a vouched object whole into an output;
 * each writer names its fields (`resolvedSampler` and its kin in
 * `src/graphs.ts`), which is what keeps both doors read by nothing.
 *
 * ⛔ **The generation block is inline.** Configs written for the private
 * reference pointed at a character file and an art-job id elsewhere
 * (`generation.character_file`, `generation.art_job`) and overrode parts of it
 * (`identity_override`, `lora_strength`). None of that resolves outside the
 * tree it was written in, so each of those keys is refused with a message that
 * names what replaces it, rather than as a bare unknown.
 *
 * Coordinates in `bones`, `meshes` and `motion` are RIG pixels, y down, origin
 * top-left — the parts' own space. The y flip to Spine happens once, in
 * `rig-c/src/transform.ts` (see `src/coords.ts`), when the rig is built.
 *
 * 🔗 **`constraints` is rig-c's, verbatim (issue #92).** An optional list
 * of constraint objects in rig-c's own rig-spec shape (`RigConstraint`:
 * `ik`, `transform`, `path`, `physics`, `slider`), handed to rigc as
 * `rig.json`'s `constraints` in the order written. The loader owns four things
 * and nothing else: the list is a list of objects; each has a `type` rigc's
 * union names and a non-empty `name`, unique within its kind (rigc's identity
 * of a constraint is its kind and its name); every bone a constraint names
 * — the fields {@link CONSTRAINT_BONE_FIELDS} lists, read off rigc's
 * `buildRigConstraint` — is a bone `bones` declares; and a bone a constraint
 * follows does not move with the bones it drives ({@link checkConstraints}).
 * Every other field, its type and its range — an ik's `bones` as a shape
 * included (rig-c 2.15.0, issue #103) — are rigc's to refuse, at the rig
 * stage's gate, in rigc's words. A record
 * (`x-…`) and an annotation (`note`, `…_note`) ride on a constraint as on any
 * object the loader vouches for, and the rig stage leaves them out of what it
 * hands rigc ({@link constraintForRig}).
 *
 * 🔗 **`motion.animations_from` is rig-c's too, verbatim (issue #183).** An
 * optional path, relative to the config file's directory, to a file in
 * rig-c's motion-spec shape whose `animations` are written into `motion.json`
 * beside the idle on every `rig` and `build`, untouched. The loader owns what
 * the merge needs and nothing else ({@link readAnimationsFrom}): the file
 * exists and parses; it is an object holding `spec` ("rigc-motion/1") and an
 * `animations` table of objects, nothing else that would be dropped; no
 * animation is named `idle`; and no key in it is written twice. What an
 * animation holds is rigc's to accept or refuse, at the rig stage's gate. The
 * file is read where the config is read from a path ({@link loadConfig});
 * {@link parseConfig}, which has no path to resolve against, checks only that
 * the field is a non-empty string.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { RIG_SKIN_CONSTRAINT_KEYS, type RigConstraint, type RigSkinConstraintKey } from 'rig-c/src/rig.ts';
import { GRID, MAX_SIDE } from './contour.ts';
import { type Problem, refuseIfAny } from './errors.ts';
import { acceptedTagNames, readTag } from './tags.ts';

export type Point = [number, number];

export interface Lora {
  name: string;
  strength: number;
  strength_clip?: number;
}

export interface Sampler {
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
}

export interface Control {
  skeleton: 'stand_sides' | 'stand_clasp';
  strength: number;
  end_percent: number;
  model?: string;
}

export interface Generation {
  checkpoint: string;
  loras: Lora[];
  trigger: string;
  identity: string;
  sampler: Sampler;
  costume: string;
  negative_extra: string;
  pose?: string;
  style: string;
  negative_pose: string;
  latent: [number, number];
  seed: number;
  control?: Control;
}

export interface SeeThrough {
  /** Square crop `[x0, y0, x1, y1]` in source pixels for the second, head-only run. */
  head_box?: [number, number, number, number];
  resolution: number;
  steps: number;
  seed: number;
  offload: boolean;
}

export type Run = 'full' | 'head';

/** One part: its name, which run it comes from, and the See-through tag it is. Order = draw order, back to front. */
export type PlanEntry = [string, Run, string];

export interface Extend {
  part: string;
  run: Run;
  tag: string;
}

/** Which pixels of a patch's box it takes: the painting's figure silhouette inside the box, or the whole box. */
export type PatchAlpha = 'silhouette' | 'box';
export const PATCH_ALPHAS: readonly PatchAlpha[] = ['silhouette', 'box'];

/** Where a patch is drawn: behind every part, in front of every part, or immediately behind a named plan part. */
export type PatchDraw = 'back' | 'front' | { before: string };

/**
 * An extra part cut from the PAINTING rather than from a See-through layer —
 * for a piece of the figure no layer holds (a hem the runs dropped). Its
 * `box` is `[x0, y0, x1, y1]` in RIG pixels, the space `parts.json` and the
 * recomposite are in, `x1`/`y1` exclusive. Its bone is `regions.<name>`, as
 * for every region part: a patch is always a region, never a mesh.
 */
export interface Patch {
  name: string;
  box: [number, number, number, number];
  alpha: PatchAlpha;
  draw: PatchDraw;
}

export interface Assemble {
  /** Rig pixels per source pixel. */
  rig_scale: number;
  plan: PlanEntry[];
  extend_below_crop?: Extend[];
  patches?: Patch[];
}

export interface SingleBone {
  name: string;
  parent: string;
  at: Point;
  tip?: Point;
}

export interface ChainBones {
  /** The links are named `<chain>0`, `<chain>1`, … in `points` order. */
  chain: string;
  parent: string;
  points: Point[];
  tip: Point;
}

export type BoneEntry = SingleBone | ChainBones;

/** A chain name, a bone name, or an explicit segment `[bone, from, to]`. */
export type Segment = string | [string, Point, Point];

/**
 * One mesh: exactly one of three modes (issue #84, issue #126). `r` and
 * `segments` mean the same in all three. Which mode is the author's choice on
 * every entry; nothing picks one, and `propose` still writes `grid`.
 *
 * - `grid`: the lattice (`src/mesh.ts`), as it has always been — every byte it
 *   writes is unchanged by the second mode existing.
 * - `contour`: the part's alpha outline through rig-c's tracer, with
 *   interior vertices placed where they are declared (`src/contour.ts`), and
 *   local deformation regions weighted to their own bones
 *   (`src/localweights.ts`).
 * - `auto`: the contour mesh at alpha 1 and above as the source, reduced and
 *   locally refined by rig-c's `reduceMesh` under the author's declared
 *   bounds (`src/automesh.ts`).
 */
export type MeshSpec = LatticeMeshSpec | ContourMeshSpec | AutoMeshSpec;

/**
 * `meshes.<part>.rule` (issue #161): how a mesh's vertices are weighted. `"distance"` is `influences()`
 * (`src/weights.ts`), and what an absent field means; `"heat"` is bone heat over the part's silhouette
 * (`src/heat.ts`), in every mode. Nothing else is a rule.
 */
export type WeightRule = 'distance' | 'heat';

export const WEIGHT_RULES: readonly WeightRule[] = ['distance', 'heat'];

export interface LatticeMeshSpec {
  grid: number;
  r: number;
  segments: Segment[];
  /** The distance rule's exponent, `w = 1/(d + r)^exponent`, above 0 (issue #161); absent is 2, the rule as it always was. */
  exponent?: number;
  /** Absent: `"distance"`. */
  rule?: WeightRule;
}

export interface ContourMeshSpec {
  contour: ContourSpec;
  r: number;
  segments: Segment[];
  /** The distance rule's exponent, `w = 1/(d + r)^exponent`, above 0 (issue #161); absent is 2, the rule as it always was. */
  exponent?: number;
  /** Absent: `"distance"`. */
  rule?: WeightRule;
}

/**
 * `meshes.<part>.contour`. Lengths and positions are RIG pixels, like every
 * other length in the config; the rig stage carries a position into the part
 * image by a translation only (the part's box less the pad), so a length means
 * the same number of pixels in both. Art is `ART_ALPHA`, the lattice's and
 * `check`'s; it is not a field.
 */
export interface ContourSpec {
  /** rig-c's Douglas–Peucker tolerance on the traced outline, px, 0 or more. */
  tolerance: number;
  /** rig-c's outward offset of the simplified outline, px, 0 or more. */
  margin: number;
  /** The background interior spacing, px, above 0. */
  spacing: number;
  /** The most vertices the mesh may have; absent is no budget. */
  budget?: number;
  /** The largest island, in art pixels, that may be left out of the mesh; absent leaves none out. */
  stray?: number;
  /** Local deformation regions; absent is none. */
  regions?: ContourRegionSpec[];
}

/**
 * A local deformation region: a shape in rig px, a control bone, the spacing
 * the mesh is refined at inside it and its band, and the band the bone's
 * weight falls across ({@link import('./localweights.ts').regionWeight}).
 * Every coordinate and length is a multiple of 1/256 px: the weight's 0 and 1
 * are decided exactly on that grid.
 */
export type ContourRegionSpec =
  | { name: string; shape: 'circle'; cx: number; cy: number; r: number; spacing: number; band: number; bone: string }
  | { name: string; shape: 'polygon'; points: Point[]; spacing: number; band: number; bone: string };

/**
 * One mesh in the automatic mode (issue #126, item 2): the contour mesh over
 * the part at alpha 1 and above is the source, and rig-c's `reduceMesh`
 * (`rig-c/mesh`, 2.28.x) refines it inside the declared regions and
 * removes what the declared bounds allow (`src/automesh.ts`); the result is
 * kept only when its motion passes `motion` (`src/automotion.ts`). Every quality
 * input is a number the author wrote, named as rig-c's contract
 * (docs/MESH_REDUCTION.md) names it; none has a default inside this package
 * but the two the agreement fixed for parts's policy — `protect.hull` is false
 * when absent (P20) — and the lists of `protect`, which are empty when absent,
 * as an absent `regions` is "none" everywhere in this config.
 */
export interface AutoMeshSpec {
  auto: AutoSpec;
  r: number;
  segments: Segment[];
  /** The distance rule's exponent, `w = 1/(d + r)^exponent`, above 0 (issue #161); absent is 2, the rule as it always was. */
  exponent?: number;
  /** Absent: `"distance"`. */
  rule?: WeightRule;
}

export interface AutoSpec {
  /** The source mesh: the contour mode's own parameters, px. */
  source: { tolerance: number; margin: number; spacing: number; stray?: number };
  /** What the source must already satisfy (correction 3). */
  sourceBounds: ArtFitBoundsSpec;
  /** What the result must satisfy. */
  targets: { artFit: ArtFitBoundsSpec; maxBoundaryDeviation: number; minAngle?: number };
  protect?: {
    hull?: boolean;
    vertices?: number[];
    edges?: Array<[number, number]>;
    regionBoundaries?: string[];
    weightJump?: number | null;
    influences?: string[];
  };
  influences: { maxInfluences: number; minWeight: number };
  budget: { maxCandidates: number };
  minArtSamples: number;
  regions?: AutoRegionSpec[];
  /**
   * The motion gate's bounds (issue #126, item 3; `src/automotion.ts`). The
   * loader requires it on every auto mesh (`CONFIG_FIELD_PRESENT`): the mode is
   * accepted into a build only when its motion is measured and passes. It is
   * optional in the type only because `buildRig`, which measures geometry
   * alone, does not read it; the rig stage refuses a spec without it by the
   * same code.
   */
  motion?: AutoMotionSpec;
  /**
   * Stage B of rigc#1271 (rig-c 2.25.0–2.27.0), each opt-in and each the
   * author's: absent, the field is not sent to `reduceMesh` and the call is the
   * one it was before the field existed. `boundaryRuns.maxVertices` (a whole
   * number, 2 or more; no default) lets each removal pass replace a run of 2 to
   * that many consecutive source-hull vertices with one chord, as one step held
   * to every declared row; `retriangulate: 'delaunay'` re-triangulates the kept
   * vertices by Delaunay flips once the reduction ends, taken whole only when
   * every declared row still passes; `removalOrder: 'deformation-load'` tries the
   * single removals in ascending predicted load instead of ascending source
   * index. What each promises and does not is rig-c's (docs/MESH_REDUCTION.md
   * §8, the three *Stage B* subsections).
   */
  boundaryRuns?: { maxVertices: number };
  retriangulate?: 'delaunay';
  removalOrder?: 'deformation-load';
}

/**
 * `meshes.<part>.auto.motion` — what rig-c's `compareMeshesInMotion`
 * holds the reduced mesh to against its unreduced source on the idle:
 * `maxLocalDeformation` in rig px (the rig's world units: its bones carry no
 * scale), required; `maxStretch` / `minStretch` (ratios) gate only when
 * written — absent, the rows are reported and not gated, the contract's own
 * rule; `deformMayFold` lets the part's folds be listed instead of refused,
 * false when absent — the one non-numeric default, echoed in the row.
 * `gradation` (px per px, 0 or more, or null) is the author's G for rig-c's
 * `MQ_ALLOCATION_CONTRAST` (docs/MESH_REDUCTION.md §8, *G — what it derives
 * from*): how fast the mesh may coarsen away from something that needs
 * density — at d px from a need of size h, edges up to h + G · d, the form of
 * a region's `grade`. Nothing a rig declares fixes it (rigc#1291), so it is
 * never derived: left out (or null) it is sent as null, and the row reads
 * `not-measurable` naming it while `MQ_DEFORM_LOAD` is measured.
 */
export interface AutoMotionSpec {
  maxLocalDeformation: number;
  maxStretch?: number;
  minStretch?: number;
  deformMayFold?: boolean;
  gradation?: number | null;
  /**
   * How the acceptance loop (`src/autoreplay.ts`) chooses a replayed step when
   * the full result fails the gate (issue #148). Absent: the bisection, and the
   * stage is byte for byte the one it was before the field existed.
   * `{ policy: 'multi-interval', maxProbes }` probes up to `maxProbes` distinct
   * removal steps (a whole number, 1 or more; the author's, never derived) in
   * a fixed order and keeps the fewest-vertex candidate among those that
   * passed — the best among tested candidates, never the last, the minimal
   * or a complete walk.
   */
  selection?: AutoSelectionSpec;
  /**
   * The skinning residual as a per-step veto (issue #126, rig-c 2.31.0's
   * `targets.skinning`, rigc#1295; `src/autoenvelope.ts`). Absent: nothing is
   * sent and the stage is byte for byte the one it was before the field
   * existed. `{ maxResidual }` (drawing px, 0 or more; the author's, never
   * derived) asks rig-c to refuse every removal, boundary run and post-pass
   * whose `MQ_SKINNING_RESIDUAL` against the original source exceeds it, under
   * the envelope derived from the declared idle. The residual is a pose-free
   * bound, not the motion verdict: the motion comparison still runs and still
   * decides.
   */
  residual?: AutoResidualSpec;
}

/** `meshes.<part>.auto.motion.residual` (issue #126, rigc#1295): the author's bound on the skinning residual, drawing px. */
export interface AutoResidualSpec {
  maxResidual: number;
}

/** `meshes.<part>.auto.motion.selection` (issue #148): the one policy besides the bisection, and its probe budget. */
export interface AutoSelectionSpec {
  policy: 'multi-interval';
  maxProbes: number;
}

/**
 * An art-fit bound set. `maxOvershoot` and `maxUndercut` are a number (px) or
 * `null`, "declared absent": rig-c measures the residual, reports its row
 * `undeclared` and gates nothing on it. Left out, either is refused by name —
 * absence is never read as "not bounded". `minCoverage` is always a number.
 */
export interface ArtFitBoundsSpec {
  minCoverage: number;
  maxOvershoot: number | null;
  maxUndercut: number | null;
}

/**
 * A region of the automatic mode, in one of two forms (issue #155).
 *
 * - **Weight and density** ({@link AutoWeightRegionSpec}): a shape and a
 *   control bone as a contour region has them, the bone's weight `band` (the
 *   same falloff, `src/localweights.ts`), and the density rig-c holds the
 *   mesh to (§5 of its contract): every edge meeting the region at most
 *   `maxEdgeLength` px (L0), relaxing as `L0 + grade·d` across `transition` px
 *   outside it, and the region's art sample floor (P9).
 * - **Density only** ({@link AutoDensityRegionSpec}): the same shape and
 *   density with no `bone` and no `band`. It is handed to rig-c exactly as the
 *   first form's density is, and it takes no part in the weights: no vertex's
 *   `g` comes from it, it adds no bone to `protect.influences`, and a source
 *   vertex inside it is weighted as one no region reaches. A vertex rig-c
 *   inserts there carries rig-c's interpolation of its source triangle (§6),
 *   as every inserted vertex does in either form.
 *
 * The two are told apart by `bone`: the loader takes `bone` and `band`
 * together or neither, and refuses either alone by name. Coordinates and
 * `band` are multiples of 1/256 px, as a contour region's.
 */
export type AutoRegionSpec = AutoWeightRegionSpec | AutoDensityRegionSpec;

/** An automatic-mode region that weights its bone and asks for density (the one form before issue #155). */
export type AutoWeightRegionSpec =
  | { name: string; shape: 'circle'; cx: number; cy: number; r: number; band: number; bone: string; maxEdgeLength: number; transition: number; grade: number; minArtSamples: number }
  | { name: string; shape: 'polygon'; points: Point[]; band: number; bone: string; maxEdgeLength: number; transition: number; grade: number; minArtSamples: number };

/** An automatic-mode region that asks for density and weights nothing (issue #155): no `bone`, no `band`. */
export type AutoDensityRegionSpec =
  | { name: string; shape: 'circle'; cx: number; cy: number; r: number; maxEdgeLength: number; transition: number; grade: number; minArtSamples: number }
  | { name: string; shape: 'polygon'; points: Point[]; maxEdgeLength: number; transition: number; grade: number; minArtSamples: number };

/** Whether an automatic-mode region weights a bone: the loader admits `bone` and `band` together or neither (issue #155). */
export function weightsABone(rg: AutoRegionSpec): rg is AutoWeightRegionSpec {
  return 'bone' in rg;
}

export interface SingleTrack {
  bone: string;
  prop: SingleProp;
  amp: number;
  period: number;
  phase: number;
  base?: number;
}

export interface ChainTrack {
  chain: string;
  amps: number[];
  period: number;
  phase: number;
  lag: number;
}

export type Track = SingleTrack | ChainTrack;

/**
 * A region part the blink moves, cut at a rig row: the rows above `row` are
 * drawn by a second slot `<part>_still` on `bone`, which the blink does not
 * key, and the rows from `row` down stay on the part's own slot and blink.
 * For an eyelash layer that also carries the eyelid crease (issue #26).
 */
export interface BlinkStill {
  row: number;
  bone: string;
}

/**
 * The idle's one blink. `eyes` names at least one bone; `brows` and
 * `brow_drop` are stated together or not at all, and a stated `brows` names
 * at least one bone — rigc refuses a group with no members, and a
 * `brow_drop` with no brows is a value nothing reads. A figure with no eye
 * bone has no blink: leave `blink` out (`CONFIG_BLINK_GROUP_MEMBERS`).
 */
export interface Blink {
  t: number;
  eyes: string[];
  brows?: string[];
  squash: number;
  brow_drop?: number;
  still?: Record<string, BlinkStill>;
}

export interface Motion {
  duration: number;
  tracks: Track[];
  blink?: Blink;
  /**
   * A file in rig-c's motion-spec shape whose `animations` are written beside
   * the idle (issue #183), its path relative to the config file's directory.
   * Absent, `motion.json` holds the idle alone.
   */
  animations_from?: string;
}

/** The motion-spec version a file `motion.animations_from` names must state: rig-c's, the one `motion.json` states. */
export const ANIMATIONS_FROM_SPEC = 'rigc-motion/1';

/**
 * The animations `motion.animations_from` names, as read: `table` is the file's
 * `animations` object itself, each animation untouched, in the order
 * `JSON.parse` gives its keys (the file's order, except that a name that is an
 * array index, `"0"` to `"4294967294"`, comes first, in numeric order — the
 * JavaScript object's own key order, which no writer here can change).
 */
export interface AnimationsFrom {
  /** The file, resolved against the config's directory. */
  file: string;
  table: Record<string, unknown>;
}

/**
 * One entry of `config.constraints`: a constraint in rig-c's rig-spec
 * shape. The loader vouches for `type`, `name` and the bone names in the
 * fields {@link CONSTRAINT_BONE_FIELDS} lists; every other field is carried
 * unread and is rigc's to accept or refuse.
 */
export interface ConfigConstraint {
  type: RigSkinConstraintKey;
  name: string;
  [field: string]: unknown;
}

export interface CharacterConfig {
  key: string;
  note?: string;
  generation?: Generation;
  seethrough?: SeeThrough;
  assemble: Assemble;
  bones: BoneEntry[];
  meshes: Record<string, MeshSpec>;
  regions: Record<string, string>;
  motion: Motion;
  constraints?: ConfigConstraint[];
}

/** The fields of one constraint kind, as rig-c's interface for that kind declares them. */
type ConstraintField<K extends RigSkinConstraintKey> = Exclude<keyof Extract<RigConstraint, { type: K }>, number | symbol>;

/**
 * 🔒 The bone-bearing fields of each of rig-c's five constraint kinds,
 * and whether each holds one bone name or a list of them — the one table this
 * package keeps of rigc's constraint shapes, and only of the fields that name
 * a bone. Read off `buildRigConstraint` in rig-c 2.10.1
 * (`src/compile.ts`), where each is resolved with its `needBone` (the ik's
 * `bones` and `target`, the transform's `bones` and `source`, the path's
 * `bones`, the physics constraint's `bone`, the slider's optional `bone`); a
 * path's `slot` names a slot and a slider's `animation` an animation, which
 * rigc resolves. rigc exports no such table. Each field name is typed
 * against rigc's own interface for its kind, so a rigc release that renames
 * one breaks the typecheck by name, and the selftest holds every name to
 * rigc's `RIG_KEYS` at run time (`CF66`).
 */
export const CONSTRAINT_BONE_FIELDS: { readonly [K in RigSkinConstraintKey]: ReadonlyArray<readonly [ConstraintField<K>, 'one' | 'list']> } = {
  ik: [['bones', 'list'], ['target', 'one']],
  transform: [['bones', 'list'], ['source', 'one']],
  path: [['bones', 'list']],
  physics: [['bone', 'one']],
  slider: [['bone', 'one']],
};

/**
 * The bone a constraint follows, by kind — an ik's `target`, a transform's
 * `source` (rigc: "4.2 called this target") — or none. It is what makes a
 * bone a `target` in `src/structure.ts`'s roles, and the bone the rig stage
 * declares `invariants.detached` for.
 */
export const CONSTRAINT_FOLLOWS: Readonly<Partial<Record<RigSkinConstraintKey, 'target' | 'source'>>> = { ik: 'target', transform: 'source' };

/** Whether a key on a vouched object is the loader's own door — a record or an annotation — that nothing reads. */
export function isDoorKey(key: string): boolean {
  return isRecordKey(key) || key === 'note' || key.endsWith('_note');
}

/**
 * A constraint as the rig stage hands it to rigc: every field the config
 * wrote, in the order written, but the records (`x-…`) and annotations
 * (`note`, `…_note`) the loader let ride on it — they are read by nothing,
 * and rigc refuses a key it does not read. No rigc constraint field is a
 * record or an annotation name (`CF66` holds that to rigc's `RIG_KEYS`), so
 * nothing rigc would read is left out.
 */
export function constraintForRig(c: ConfigConstraint): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(c)) if (!isDoorKey(key)) out[key] = value;
  return out;
}

/** The single-value bone properties a sine track may drive — rigc's one-channel bone timelines. */
export const SINGLE_PROPS = ['rotate', 'translatex', 'translatey', 'scalex', 'scaley', 'shearx', 'sheary'] as const;
export type SingleProp = (typeof SINGLE_PROPS)[number];

/** The bone every rig has and no config declares. */
export const ROOT_BONE = 'root';

/** Keys from the private reference era, each with what replaces it. */
const RETIRED: Record<string, Record<string, string>> = {
  generation: {
    character_file:
      'pointed at a character file outside this tree; write its values inline instead — generation.checkpoint, generation.loras, generation.trigger, generation.identity and generation.sampler',
    art_job: 'named a job record outside this tree; put the costume words themselves in generation.costume and where they came from in generation.costume_note',
    identity_override: 'overrode the character file\'s identity; with the values inline, write the identity you want in generation.identity',
    lora_strength: 'overrode every LoRA\'s strength; with the values inline, set generation.loras[i].strength on each',
    seed0: 'recorded where a seed search started; the chosen seed is generation.seed, and the search belongs in generation.seed_note, or as a structured record in generation.x-seeds_tried',
    seeds_tried: 'recorded the seeds a search tried; the chosen seed is generation.seed, and the search belongs in generation.seed_note, or as a structured record in generation.x-seeds_tried',
  },
};

/**
 * A project's own record: a key beginning `x-` with at least one character
 * after it, holding any JSON value, read by nothing. `X-`, `x_` and a bare
 * `x-` are not record names, so a typo of one is still refused by name.
 */
function isRecordKey(key: string): boolean {
  return key.length > 2 && key.startsWith('x-');
}

/** What every refusal of a key the schema does not know adds after its own sentence: the two doors. */
const DOORS = 'a project\'s own record goes under a key beginning "x-" (any JSON, read by nothing), a remark under note or <name>_note (a string)';

// ---------------------------------------------------------------------------
// the checker
// ---------------------------------------------------------------------------

type Json = unknown;

class Check {
  readonly problems: Problem[] = [];

  fail(code: string, object: string, detail: string): void {
    this.problems.push({ code, object, detail });
  }

  /** An object with exactly these keys (plus records and annotations); returns it, or null after refusing. */
  object(path: string, v: Json, required: readonly string[], optional: readonly string[]): Record<string, Json> | null {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      this.fail('CONFIG_FIELD_TYPE', path, `is ${show(v)}; an object is required`);
      return null;
    }
    const o = v as Record<string, Json>;
    const section = path.replace(/^config\.?/, '');
    for (const key of Object.keys(o)) {
      if (required.includes(key) || optional.includes(key)) continue;
      if (isRecordKey(key)) continue;
      if (key === 'note' || key.endsWith('_note')) {
        if (typeof o[key] !== 'string') {
          this.fail('CONFIG_FIELD_TYPE', `${path}.${key}`, `is ${show(o[key])}; an annotation is a string — a structured record goes under a key beginning "x-" (any JSON, read by nothing)`);
        }
        continue;
      }
      const retired = RETIRED[section]?.[key];
      if (retired !== undefined) this.fail('CONFIG_KEY_RETIRED', `${path}.${key}`, retired);
      else this.fail('CONFIG_KEY_KNOWN', `${path}.${key}`, `is not a field here; known: ${[...required, ...optional].join(', ')} — ${DOORS}`);
    }
    for (const key of required) if (!(key in o)) this.fail('CONFIG_FIELD_PRESENT', `${path}.${key}`, 'is absent and required');
    return o;
  }

  string(path: string, v: Json, nonEmpty = true): v is string {
    if (typeof v === 'string' && (!nonEmpty || v !== '')) return true;
    this.fail('CONFIG_FIELD_TYPE', path, `is ${show(v)}; ${nonEmpty ? 'a non-empty string' : 'a string'} is required`);
    return false;
  }

  number(path: string, v: Json, rule: 'any' | 'positive' | 'non-negative' | 'unit' = 'any'): v is number {
    const ok =
      typeof v === 'number' &&
      Number.isFinite(v) &&
      (rule === 'any' || (rule === 'positive' ? v > 0 : rule === 'non-negative' ? v >= 0 : v >= 0 && v <= 1));
    if (!ok) {
      const need = { any: 'a finite number', positive: 'a number above 0', 'non-negative': 'a number at or above 0', unit: 'a number in [0, 1]' }[rule];
      this.fail('CONFIG_FIELD_TYPE', path, `is ${show(v)}; ${need} is required`);
    }
    return ok;
  }

  int(path: string, v: Json, min: number): v is number {
    if (typeof v === 'number' && Number.isInteger(v) && v >= min) return true;
    this.fail('CONFIG_FIELD_TYPE', path, `is ${show(v)}; an integer at or above ${min} is required`);
    return false;
  }

  point(path: string, v: Json): v is Point {
    if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) return true;
    this.fail('CONFIG_FIELD_TYPE', path, `is ${show(v)}; a point [x, y] in rig pixels is required`);
    return false;
  }

  array(path: string, v: Json, nonEmpty: boolean): v is Json[] {
    if (Array.isArray(v) && (!nonEmpty || v.length > 0)) return true;
    this.fail('CONFIG_FIELD_TYPE', path, `is ${show(v)}; ${nonEmpty ? 'a non-empty array' : 'an array'} is required`);
    return false;
  }
}

function show(v: Json): string {
  if (v === undefined) return 'absent';
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/** A part name becomes a file name (`parts/<name>.png`) and a Spine slot name, so it may not be a path. */
function partNameOk(name: string): boolean {
  return name !== '' && !name.startsWith('.') && !/[\\/]/.test(name);
}

// ---------------------------------------------------------------------------
// the loader
// ---------------------------------------------------------------------------

/** The file as parsed JSON, or a refusal naming why not. Both loaders read through it. */
function readConfigFile(path: string): Json {
  if (!existsSync(path)) refuseIfAny([{ code: 'CONFIG_FILE_PRESENT', object: path, detail: 'no such file' }]);
  let raw: Json;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    refuseIfAny([{ code: 'CONFIG_IS_JSON', object: path, detail: `does not parse as JSON: ${(err as Error).message}` }]);
  }
  return raw;
}

export function loadConfig(path: string): CharacterConfig {
  return loadConfigAndAnimations(path).config;
}

/**
 * The full loader with the file `motion.animations_from` names read beside it,
 * relative to the config's directory: every problem in either is one refusal.
 * `animations` is null when the config names no file.
 */
export function loadConfigAndAnimations(path: string): { config: CharacterConfig; animations: AnimationsFrom | null } {
  return parseConfigFrom(readConfigFile(path), dirname(resolve(path)));
}

// ---------------------------------------------------------------------------
// the early loader — before the rig exists
// ---------------------------------------------------------------------------

/**
 * Which step is reading the config before the rig exists, and so which fields
 * that step requires. The requirement is the caller's to name because it is a
 * fact about the step, not about the file: the same config legitimately lacks
 * `seethrough` when the painting is generated and must carry it when the
 * See-through images are cut.
 *
 * - `paint` — `comfy paint`, the first step of all: `key` and `generation`.
 *   Nothing else exists yet, and nothing else is read.
 * - `layers` — `inputs` and `assemble --propose-plan`: `key`, `seethrough`
 *   (`head_box` absent until `propose --head-box` has run) and
 *   `assemble.rig_scale`.
 * - `assemble` — plain `assemble`: the `layers` door plus `assemble.plan`,
 *   which `--propose-plan` printed, and `extend_below_crop` when present, both
 *   under the full loader's own rules. `bones`, `meshes`, `regions` and
 *   `motion` are drafted by `propose` from the parts this step writes, so
 *   requiring them here is what made a new character need placeholder rig
 *   fields (issue #20).
 *
 * `generation` is checked on every door when present, because that block is
 * complete before any image exists.
 */
export type EarlyDoor = 'paint' | 'layers' | 'assemble';

/** Every loader: the three early doors, and `full` — `parseConfig`, in front of `rig`, `build` and `propose --from-config`/`--compare`. */
export type ConfigDoor = EarlyDoor | 'full';

/**
 * 🔒 The one statement of what each loader requires, as dotted field paths.
 * The loaders read their required keys from here — the top-level keys are the
 * first segments, `config.assemble`'s the second — and docs/AUTHORING.md §4's
 * table is compared against it by the selftest, so neither the doc nor a
 * loader can state a requirement the other does not.
 */
export const CONFIG_REQUIRES: Readonly<Record<ConfigDoor, readonly string[]>> = {
  paint: ['key', 'generation'],
  layers: ['key', 'seethrough', 'assemble.rig_scale'],
  assemble: ['key', 'seethrough', 'assemble.rig_scale', 'assemble.plan'],
  full: ['key', 'assemble.rig_scale', 'assemble.plan', 'bones', 'meshes', 'regions', 'motion'],
};

/** The top-level keys a loader requires, in `CONFIG_REQUIRES` order. */
function topRequired(door: ConfigDoor): string[] {
  return [...new Set(CONFIG_REQUIRES[door].map((f) => f.split('.')[0]))];
}

/** The keys a loader requires inside one top-level section. */
function sectionRequired(door: ConfigDoor, section: string): string[] {
  return CONFIG_REQUIRES[door].filter((f) => f.startsWith(`${section}.`)).map((f) => f.slice(section.length + 1));
}

/** What `comfy paint` reads: the key its files are named for and the generation block it paints from. */
export interface PaintConfig {
  key: string;
  generation: Generation;
}

/**
 * What a character's config holds before its layers exist: a key, the
 * See-through block and the rig scale. `inputs` and `assemble --propose-plan`
 * run at that point, and the full loader would refuse the config for the plan,
 * bones, meshes, regions and motion that are written only after them.
 */
export interface EarlyConfig {
  key: string;
  seethrough: SeeThrough;
  assemble: { rig_scale: number };
}

/** What plain `assemble` reads: the early config plus the plan `--propose-plan` printed. */
export interface AssembleConfig {
  key: string;
  seethrough: SeeThrough;
  assemble: Assemble;
}

const TOP_KEYS = ['key', 'generation', 'seethrough', 'assemble', 'bones', 'meshes', 'regions', 'motion', 'constraints'] as const;

/**
 * The one partial entry point. It validates exactly what its door requires —
 * with the full loader's own rules for each — plus `generation` whenever it is
 * present. The sections a later step writes may be present and are NOT read or
 * vouched for (for `paint` that is everything but `key` and `generation`; for
 * `layers`, `assemble.plan`, `extend_below_crop`, `patches`, `bones`, `meshes`,
 * `regions` and `motion`; for `assemble`, the last four); a caller that needs
 * them uses {@link parseConfig}. Every other key that is not a record or an
 * annotation is still refused by name, and a retired one
 * (`generation.character_file` and its kin) still with what replaces it: a
 * config is not allowed to be half-known at any stage.
 */
export function parseEarlyConfig(raw: Json, door: 'paint'): PaintConfig;
export function parseEarlyConfig(raw: Json, door: 'layers'): EarlyConfig;
export function parseEarlyConfig(raw: Json, door: 'assemble'): AssembleConfig;
export function parseEarlyConfig(raw: Json, door: EarlyDoor): PaintConfig | EarlyConfig | AssembleConfig {
  const c = new Check();
  // `generation` is taken out of the generic presence check so its absence can
  // say what the block has to hold, rather than only that it is missing.
  const needed = topRequired(door);
  const required = needed.filter((k) => k !== 'generation');
  const top = c.object('config', raw, required, TOP_KEYS.filter((k) => !required.includes(k)));
  if (top === null) refuseIfAny(c.problems);
  const t = top as Record<string, Json>;
  if ('key' in t) c.string('config.key', t.key);
  if ('generation' in t) checkGeneration(c, t.generation);
  else if (needed.includes('generation')) {
    c.fail(
      'CONFIG_FIELD_PRESENT',
      'config.generation',
      `is absent and required; comfy paint generates from it and nothing else — ${GENERATION_REQUIRED.join(', ')}, and pose or control`,
    );
  }
  if (door === 'layers') {
    if ('seethrough' in t) checkSeeThrough(c, t.seethrough);
    if ('assemble' in t) {
      const a = c.object('config.assemble', t.assemble, sectionRequired(door, 'assemble'), ['plan', 'extend_below_crop', 'patches']);
      if (a !== null && 'rig_scale' in a) c.number('config.assemble.rig_scale', a.rig_scale, 'positive');
    }
  }
  if (door === 'assemble') {
    if ('seethrough' in t) checkSeeThrough(c, t.seethrough);
    if ('assemble' in t) checkAssemble(c, t.assemble, door);
  }
  refuseIfAny(c.problems);
  return raw as PaintConfig | EarlyConfig | AssembleConfig;
}

export function loadEarlyConfig(path: string, door: 'paint'): PaintConfig;
export function loadEarlyConfig(path: string, door: 'layers'): EarlyConfig;
export function loadEarlyConfig(path: string, door: 'assemble'): AssembleConfig;
export function loadEarlyConfig(path: string, door: EarlyDoor): PaintConfig | EarlyConfig | AssembleConfig {
  const raw = readConfigFile(path);
  if (door === 'paint') return parseEarlyConfig(raw, 'paint');
  if (door === 'layers') return parseEarlyConfig(raw, 'layers');
  return parseEarlyConfig(raw, 'assemble');
}

/**
 * Validate a parsed config. Every problem found is thrown at once, as one
 * `PartsError`. With no path to resolve against, `motion.animations_from` is
 * checked as a non-empty string and its file is not read ({@link loadConfig} reads it).
 */
export function parseConfig(raw: Json): CharacterConfig {
  return parseConfigFrom(raw, null).config;
}

function parseConfigFrom(raw: Json, base: string | null): { config: CharacterConfig; animations: AnimationsFrom | null } {
  const c = new Check();
  const required = topRequired('full');
  const top = c.object('config', raw, required, TOP_KEYS.filter((k) => !required.includes(k)));
  if (top === null) refuseIfAny(c.problems);
  const t = top as Record<string, Json>;
  if ('key' in t) c.string('config.key', t.key);
  if ('generation' in t) checkGeneration(c, t.generation);
  if ('seethrough' in t) checkSeeThrough(c, t.seethrough);
  const { parts, patches } = 'assemble' in t ? checkAssemble(c, t.assemble, 'full') : { parts: [], patches: [] };
  const names = 'bones' in t ? checkBones(c, t.bones) : { bones: new Set<string>([ROOT_BONE]), chains: new Map<string, number>(), parents: new Map<string, string>() };
  if ('meshes' in t) checkMeshes(c, t.meshes, names.bones, names.chains);
  if ('regions' in t) checkRegions(c, t.regions, names.bones);
  if ('meshes' in t && 'regions' in t && 'assemble' in t) checkCoverage(c, parts, patches, t.meshes, t.regions);
  if ('motion' in t) checkMotion(c, t.motion, names.bones, names.chains, 'regions' in t ? t.regions : undefined);
  if ('constraints' in t) checkConstraints(c, t.constraints, names.bones, names.parents);
  const from = isPlainObject(t.motion) ? t.motion.animations_from : undefined;
  const animations = base !== null && typeof from === 'string' && from !== '' ? readAnimationsFrom(c, resolve(base, from)) : null;
  refuseIfAny(c.problems);
  return { config: raw as CharacterConfig, animations };
}

function isPlainObject(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Read the file `motion.animations_from` names (issue #183) and vouch for what
 * merging its animations beside the idle needs, every problem collected in `c`:
 *
 * - `CONFIG_FILE_PRESENT`: no such file, or a file that cannot be read.
 * - `CONFIG_IS_JSON`: the text does not parse.
 * - `CONFIG_FIELD_TYPE`: the file is not an object, its `spec` is not
 *   "rigc-motion/1", its `animations` is not an object, or an animation in it
 *   is not one. `CONFIG_KEY_KNOWN` / `CONFIG_FIELD_PRESENT`: a key besides
 *   `spec` and `animations` (and the annotation and record doors), or one of
 *   the two absent. rig-c's `easings`, `groups`, `setup`, `physics` and `mix`
 *   are refused rather than dropped: `motion.json`'s own are this package's,
 *   and a table read and not written would be a value lost without a word.
 * - `CONFIG_ANIMATION_NAME_FREE`: an animation named `idle`, the one the
 *   config's own `motion` writes.
 * - `CONFIG_KEY_UNIQUE`: a key written twice in one object of the file.
 *   `JSON.parse` keeps the last and drops the others silently, so the file's
 *   text is read for it ({@link repeatedKeys}).
 *
 * Returns the animations when this file added no problem, else null.
 */
function readAnimationsFrom(c: Check, file: string): AnimationsFrom | null {
  const field = 'config.motion.animations_from';
  const shape = `a file in rig-c's motion-spec shape, {"spec": "${ANIMATIONS_FROM_SPEC}", "animations": {"<name>": {"duration": …, "tracks": [...]}}}, its path relative to the config's directory`;
  if (!existsSync(file) || !statSync(file).isFile()) {
    c.fail('CONFIG_FILE_PRESENT', field, `names ${file}, which is no such file; ${shape} is required`);
    return null;
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    c.fail('CONFIG_FILE_PRESENT', field, `names ${file}, which cannot be read: ${(err as Error).message}; ${shape} is required`);
    return null;
  }
  let raw: Json;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    c.fail('CONFIG_IS_JSON', `${field} (${file})`, `does not parse as JSON: ${(err as Error).message}`);
    return null;
  }
  const before = c.problems.length;
  const at = `${field} (${file})`;
  if (!isPlainObject(raw)) {
    c.fail('CONFIG_FIELD_TYPE', at, `is ${show(raw)}; ${shape} is required`);
    return null;
  }
  for (const r of repeatedKeys(text)) {
    c.fail(
      'CONFIG_KEY_UNIQUE',
      `${at}${r.at === '' ? '' : `.${r.at}`}`,
      `names "${r.key}" ${r.count === 2 ? 'twice' : `${r.count} times`}; each key once is required — JSON keeps only the last, so ${r.at === 'animations' ? 'every animation of that name but the last' : 'every value but the last'} would be dropped without a word`,
    );
  }
  const o = c.object(at, raw, ['spec', 'animations'], []);
  if (o !== null && 'spec' in o && o.spec !== ANIMATIONS_FROM_SPEC) {
    c.fail('CONFIG_FIELD_TYPE', `${at}.spec`, `is ${show(o.spec)}; "${ANIMATIONS_FROM_SPEC}" is required, the motion-spec version motion.json states`);
  }
  if (o !== null && 'animations' in o) {
    if (!isPlainObject(o.animations)) {
      c.fail('CONFIG_FIELD_TYPE', `${at}.animations`, `is ${show(o.animations)}; a table keyed by animation name is required, {"<name>": {"duration": …, "tracks": [...]}}`);
    } else {
      for (const [name, anim] of Object.entries(o.animations)) {
        if (name === 'idle') {
          c.fail('CONFIG_ANIMATION_NAME_FREE', `${at}.animations.idle`, 'is the idle, which config.motion writes; an animation beside it needs another name');
        } else if (!isPlainObject(anim)) {
          c.fail('CONFIG_FIELD_TYPE', `${at}.animations.${name}`, `is ${show(anim)}; an animation object in rig-c's motion-spec shape is required ({"duration": …, "tracks": [...]}, and what else rigc reads)`);
        }
      }
    }
  }
  if (c.problems.length > before || o === null) return null;
  return { file, table: o.animations as Record<string, unknown> };
}

/**
 * Every key an object in the JSON `text` names more than once, with the
 * object's dotted path (`""` for the top level, `animations.smile.tracks[0]`
 * below it) and how many times — what `JSON.parse` folds into its last value
 * without a word. `text` must already parse; the walk is a reader of valid
 * JSON only, and keys are compared after their escapes are decoded.
 */
export function repeatedKeys(text: string): Array<{ at: string; key: string; count: number }> {
  const out: Array<{ at: string; key: string; count: number }> = [];
  let i = 0;
  const ws = (): void => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const str = (): string => {
    const start = i;
    i++;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (at: string): void => {
    ws();
    const ch = text[i];
    if (ch === '{') {
      i++;
      const seen = new Map<string, number>();
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        const key = str();
        seen.set(key, (seen.get(key) ?? 0) + 1);
        ws();
        i++; // the colon
        value(at === '' ? key : `${at}.${key}`);
        ws();
        if (text[i++] === '}') break;
      }
      for (const [key, count] of seen) if (count > 1) out.push({ at, key, count });
    } else if (ch === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (let k = 0; ; k++) {
        value(`${at}[${k}]`);
        ws();
        if (text[i++] === ']') break;
      }
    } else if (ch === '"') str();
    else while (i < text.length && !',]} \t\n\r'.includes(text[i])) i++;
  };
  value('');
  return out;
}

/** The four sections `propose` drafts and a config carries: what a skeleton comparison reads of either. */
export interface SkeletonSections {
  bones: BoneEntry[];
  meshes: Record<string, MeshSpec>;
  regions: Record<string, string>;
  motion: Motion;
}

/**
 * A `proposal.json` as `propose` writes it — `bones`, `meshes`, `regions`,
 * `motion` and `notes` (strings) — under the full loader's own rules for the
 * four rig sections (issue #85). There is no plan to hold the meshes and
 * regions against, so the coverage rule (every plan part exactly one of a
 * mesh or a region) is the one rule not run; `propose` held its proposal to
 * it before writing (`checkProposal`). A key the loader would not take is
 * refused by name, as in a config. Refusals name the fields `proposal.…`.
 */
export function parseProposalSections(raw: Json): SkeletonSections {
  const c = new Check();
  const top = c.object('config', raw, ['bones', 'meshes', 'regions', 'motion'], ['notes']);
  if (top !== null) {
    const names = 'bones' in top ? checkBones(c, top.bones) : { bones: new Set<string>([ROOT_BONE]), chains: new Map<string, number>(), parents: new Map<string, string>() };
    if ('meshes' in top) checkMeshes(c, top.meshes, names.bones, names.chains);
    if ('regions' in top) checkRegions(c, top.regions, names.bones);
    if ('motion' in top) checkMotion(c, top.motion, names.bones, names.chains, 'regions' in top ? top.regions : undefined);
    if ('notes' in top && c.array('config.notes', top.notes, false)) (top.notes as Json[]).forEach((n, i) => c.string(`config.notes[${i}]`, n, false));
  }
  refuseIfAny(c.problems.map((p) => ({ ...p, object: p.object.replace(/^config\b/, 'proposal') })));
  return raw as SkeletonSections;
}

/**
 * `motion.blink.still`: part name -> `{row, bone}`. The part must be a region
 * whose bone the blink's `eyes` names — a cut on anything else holds nothing
 * still that was moving — and `bone` must be declared and must not be one of
 * the blink's eyes, or the still piece would blink with the rest.
 */
function checkBlinkStill(c: Check, v: Json, eyes: Json, bones: Set<string>, regions: Json): void {
  const at = 'config.motion.blink.still';
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    c.fail('CONFIG_FIELD_TYPE', at, `is ${show(v)}; an object of part name -> {row, bone} is required`);
    return;
  }
  const eyeList = Array.isArray(eyes) ? eyes.filter((e): e is string => typeof e === 'string') : [];
  const regionOf = typeof regions === 'object' && regions !== null && !Array.isArray(regions) ? (regions as Record<string, Json>) : {};
  for (const [part, entry] of Object.entries(v as Record<string, Json>)) {
    const e = c.object(`${at}.${part}`, entry, ['row', 'bone'], []);
    if (e === null) continue;
    if ('row' in e) c.int(`${at}.${part}.row`, e.row, 0);
    if ('bone' in e) {
      if (typeof e.bone !== 'string' || !bones.has(e.bone)) c.fail('CONFIG_NAME_RESOLVES', `${at}.${part}.bone`, `is ${show(e.bone)}; a declared bone is required`);
      else if (eyeList.includes(e.bone)) {
        c.fail('CONFIG_STILL_OFF_THE_BLINK', `${at}.${part}.bone`, `is "${e.bone}", which config.motion.blink.eyes names, so the still piece would blink too; a bone the blink does not key is required (the eye bone's parent, as propose writes it)`);
      }
    }
    const rb = Object.prototype.hasOwnProperty.call(regionOf, part) ? regionOf[part] : undefined;
    if (typeof rb !== 'string') {
      c.fail('CONFIG_NAME_RESOLVES', `${at}.${part}`, `names "${part}", which config.regions does not attach; a region part is required — a mesh is not cut`);
    } else if (!eyeList.includes(rb)) {
      c.fail(
        'CONFIG_STILL_OFF_THE_BLINK',
        `${at}.${part}`,
        `names a region on "${rb}", which config.motion.blink.eyes (${eyeList.join(', ') || 'none'}) does not name, so the blink never moves it and there is nothing to hold still; a region on a blinking eye bone is required`,
      );
    }
  }
}

/** The fields every generation block carries; `pose` or `control` is required besides, checked below. */
const GENERATION_REQUIRED = ['checkpoint', 'loras', 'trigger', 'identity', 'sampler', 'costume', 'negative_extra', 'style', 'negative_pose', 'latent', 'seed'] as const;

function checkGeneration(c: Check, v: Json): void {
  const g = c.object('config.generation', v, GENERATION_REQUIRED, ['pose', 'control']);
  if (g === null) return;
  const p = 'config.generation';
  for (const key of ['checkpoint', 'identity', 'costume', 'style', 'negative_pose'] as const) if (key in g) c.string(`${p}.${key}`, g[key]);
  for (const key of ['trigger', 'negative_extra'] as const) if (key in g) c.string(`${p}.${key}`, g[key], false);
  if ('pose' in g) c.string(`${p}.pose`, g.pose);
  if ('seed' in g) c.int(`${p}.seed`, g.seed, 0);
  if ('latent' in g) {
    const l = g.latent;
    if (!(Array.isArray(l) && l.length === 2 && l.every((n) => typeof n === 'number' && Number.isInteger(n) && n > 0))) {
      c.fail('CONFIG_FIELD_TYPE', `${p}.latent`, `is ${show(l)}; [width, height] in positive integers is required`);
    }
  }
  if ('loras' in g && c.array(`${p}.loras`, g.loras, false)) {
    (g.loras as Json[]).forEach((lo, i) => {
      const o = c.object(`${p}.loras[${i}]`, lo, ['name', 'strength'], ['strength_clip']);
      if (o === null) return;
      if ('name' in o) c.string(`${p}.loras[${i}].name`, o.name);
      if ('strength' in o) c.number(`${p}.loras[${i}].strength`, o.strength);
      if ('strength_clip' in o) c.number(`${p}.loras[${i}].strength_clip`, o.strength_clip);
    });
  }
  if ('sampler' in g) {
    const s = c.object(`${p}.sampler`, g.sampler, ['steps', 'cfg', 'sampler', 'scheduler'], []);
    if (s !== null) {
      if ('steps' in s) c.int(`${p}.sampler.steps`, s.steps, 1);
      if ('cfg' in s) c.number(`${p}.sampler.cfg`, s.cfg, 'positive');
      if ('sampler' in s) c.string(`${p}.sampler.sampler`, s.sampler);
      if ('scheduler' in s) c.string(`${p}.sampler.scheduler`, s.scheduler);
    }
  }
  if ('control' in g) {
    const k = c.object(`${p}.control`, g.control, ['skeleton', 'strength', 'end_percent'], ['model']);
    if (k !== null) {
      if ('skeleton' in k && k.skeleton !== 'stand_sides' && k.skeleton !== 'stand_clasp') {
        c.fail('CONFIG_FIELD_TYPE', `${p}.control.skeleton`, `is ${show(k.skeleton)}; "stand_sides" or "stand_clasp" is required`);
      }
      if ('strength' in k) c.number(`${p}.control.strength`, k.strength, 'non-negative');
      if ('end_percent' in k) c.number(`${p}.control.end_percent`, k.end_percent, 'unit');
      if ('model' in k) c.string(`${p}.control.model`, k.model);
    }
  }
  if (!('pose' in g) && !('control' in g)) {
    c.fail('CONFIG_FIELD_PRESENT', `${p}.pose`, 'is absent and so is generation.control; the pose words come from one of them, and neither is guessed');
  }
}

function checkSeeThrough(c: Check, v: Json): void {
  const s = c.object('config.seethrough', v, ['resolution', 'steps', 'seed', 'offload'], ['head_box']);
  if (s === null) return;
  const p = 'config.seethrough';
  if ('resolution' in s) c.int(`${p}.resolution`, s.resolution, 1);
  if ('steps' in s) c.int(`${p}.steps`, s.steps, 1);
  if ('seed' in s) c.int(`${p}.seed`, s.seed, 0);
  if ('offload' in s && typeof s.offload !== 'boolean') c.fail('CONFIG_FIELD_TYPE', `${p}.offload`, `is ${show(s.offload)}; true or false is required`);
  if ('head_box' in s) {
    const b = s.head_box;
    const ints = Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isInteger(n));
    if (!ints) c.fail('CONFIG_FIELD_TYPE', `${p}.head_box`, `is ${show(b)}; [x0, y0, x1, y1] in integer source pixels is required`);
    else {
      const [x0, y0, x1, y1] = b as number[];
      if (!(x1 > x0 && y1 > y0 && x1 - x0 === y1 - y0)) {
        c.fail('CONFIG_HEAD_BOX_SQUARE', `${p}.head_box`, `is ${x1 - x0}x${y1 - y0}; a non-empty square is required (the head run is fed a square crop)`);
      }
    }
  }
}

function checkRunTag(c: Check, path: string, run: Json, tag: Json): void {
  if (run !== 'full' && run !== 'head') c.fail('CONFIG_FIELD_TYPE', `${path} run`, `is ${show(run)}; "full" or "head" is required`);
  if (typeof tag !== 'string' || readTag(tag) === null) {
    c.fail('CONFIG_TAG_KNOWN', `${path} tag`, `is ${show(tag)}; a See-through v3 tag is required — one of ${acceptedTagNames().join(', ')}`);
  }
}

/**
 * Returns the plan's part names, in plan order, and the patches' names, in
 * patch order. `plan` is left out of the generic presence check so that its
 * absence says which command writes one — the step a config without a plan
 * has most likely skipped.
 */
function checkAssemble(c: Check, v: Json, door: 'assemble' | 'full'): { parts: string[]; patches: string[] } {
  const required = sectionRequired(door, 'assemble');
  const a = c.object('config.assemble', v, required.filter((k) => k !== 'plan'), ['plan', 'extend_below_crop', 'patches']);
  if (a === null) return { parts: [], patches: [] };
  if (required.includes('plan') && !('plan' in a)) {
    c.fail('CONFIG_FIELD_PRESENT', 'config.assemble.plan', 'is absent and required; `assemble --propose-plan` prints one from the two runs — paste its plan and extend_below_crop into config.assemble');
  }
  const p = 'config.assemble';
  if ('rig_scale' in a) c.number(`${p}.rig_scale`, a.rig_scale, 'positive');
  const parts: string[] = [];
  if ('plan' in a && c.array(`${p}.plan`, a.plan, true)) {
    const seenPart = new Map<string, number>();
    const seenSource = new Map<string, number>();
    (a.plan as Json[]).forEach((entry, i) => {
      const at = `${p}.plan[${i}]`;
      if (!(Array.isArray(entry) && entry.length === 3 && typeof entry[0] === 'string')) {
        c.fail('CONFIG_FIELD_TYPE', at, `is ${show(entry)}; [part name, "full" | "head", tag] is required`);
        return;
      }
      const [name, run, tag] = entry as [string, Json, Json];
      if (!partNameOk(name)) c.fail('CONFIG_PART_NAME', at, `names the part ${show(name)}; a part name is a file name, so it may not be empty, start with "." or hold a slash`);
      checkRunTag(c, at, run, tag);
      if (seenPart.has(name)) c.fail('CONFIG_PART_UNIQUE', at, `names the part "${name}" again (first at plan[${seenPart.get(name)}]); each part is one layer`);
      else seenPart.set(name, i);
      const source = `${String(run)}:${String(tag)}`;
      if (seenSource.has(source)) c.fail('CONFIG_PART_UNIQUE', at, `takes ${source} again (first at plan[${seenSource.get(source)}]); one layer makes one part`);
      else seenSource.set(source, i);
      parts.push(name);
    });
  }
  if ('extend_below_crop' in a && c.array(`${p}.extend_below_crop`, a.extend_below_crop, false)) {
    (a.extend_below_crop as Json[]).forEach((entry, i) => {
      const at = `${p}.extend_below_crop[${i}]`;
      const e = c.object(at, entry, ['part', 'run', 'tag'], []);
      if (e === null) return;
      checkRunTag(c, at, e.run, e.tag);
      if (typeof e.part !== 'string' || !parts.includes(e.part)) {
        c.fail('CONFIG_NAME_RESOLVES', `${at}.part`, `is ${show(e.part)}; a part named in assemble.plan is required`);
      }
    });
  }
  const patches = 'patches' in a ? checkPatches(c, a.patches, parts) : [];
  return { parts, patches };
}

/**
 * `assemble.patches`: each entry `{name, box, alpha, draw}`, refused field by
 * field. What the config alone cannot know — whether the box lies inside the
 * rig, whether the rule leaves any pixel — the assemble stage refuses
 * (`ASSEMBLE_PATCH_BOX_INSIDE`, `ASSEMBLE_PATCH_OPAQUE`). Returns the patch
 * names, in order.
 */
function checkPatches(c: Check, v: Json, plan: string[]): string[] {
  const p = 'config.assemble.patches';
  const names: string[] = [];
  if (!c.array(p, v, false)) return names;
  const seen = new Map<string, number>();
  (v as Json[]).forEach((entry, i) => {
    const at = `${p}[${i}]`;
    // `bone` is the field a reader expects here, and the answer is a place
    // that already exists: one place for a region's bone, not two.
    let fields = entry;
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry) && 'bone' in entry) {
      c.fail('CONFIG_KEY_KNOWN', `${at}.bone`, 'is not a field here; a patch is a region, and the bone a region rides is config.regions.<name> — write it there');
      const { bone: _bone, ...rest } = entry as Record<string, Json>;
      fields = rest;
    }
    const e = c.object(at, fields, ['name', 'box', 'alpha', 'draw'], []);
    if (e === null) return;
    if ('name' in e && c.string(`${at}.name`, e.name)) {
      const name = e.name;
      if (!partNameOk(name)) c.fail('CONFIG_PART_NAME', `${at}.name`, `names the part ${show(name)}; a part name is a file name, so it may not be empty, start with "." or hold a slash`);
      if (plan.includes(name)) c.fail('CONFIG_PART_UNIQUE', `${at}.name`, `names the part "${name}", which assemble.plan[${plan.indexOf(name)}] already makes; a patch is a part of its own`);
      else if (seen.has(name)) c.fail('CONFIG_PART_UNIQUE', `${at}.name`, `names the part "${name}" again (first at patches[${seen.get(name)}])`);
      else seen.set(name, i);
      names.push(name);
    }
    if ('box' in e) {
      const b = e.box;
      const ints = Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0);
      if (!ints) c.fail('CONFIG_FIELD_TYPE', `${at}.box`, `is ${show(b)}; [x0, y0, x1, y1] in non-negative integer rig pixels is required`);
      else {
        const [x0, y0, x1, y1] = b as number[];
        if (!(x1 > x0 && y1 > y0)) c.fail('CONFIG_PATCH_BOX', `${at}.box`, `is [${x0}, ${y0}, ${x1}, ${y1}], ${x1 - x0}x${y1 - y0}; a non-empty box is required (x1 > x0 and y1 > y0; x1 and y1 are exclusive)`);
      }
    }
    if ('alpha' in e && !(PATCH_ALPHAS as readonly Json[]).includes(e.alpha)) {
      c.fail('CONFIG_FIELD_TYPE', `${at}.alpha`, `is ${show(e.alpha)}; one of ${PATCH_ALPHAS.map((r) => `"${r}"`).join(', ')} is required — "silhouette" takes the painting's figure inside the box, "box" the whole box`);
    }
    if ('draw' in e) {
      const d = e.draw;
      if (d === 'back' || d === 'front') return;
      if (typeof d === 'object' && d !== null && !Array.isArray(d)) {
        const o = c.object(`${at}.draw`, d, ['before'], []);
        if (o !== null && 'before' in o && (typeof o.before !== 'string' || !plan.includes(o.before))) {
          c.fail('CONFIG_NAME_RESOLVES', `${at}.draw.before`, `is ${show(o.before)}; a part named in assemble.plan is required`);
        }
        return;
      }
      c.fail('CONFIG_FIELD_TYPE', `${at}.draw`, `is ${show(d)}; "back", "front" or {"before": "<plan part>"} is required`);
    }
  });
  return names;
}

/** Returns every bone name (root and chain links included), each chain's link count, and each declared bone's parent as written. */
function checkBones(c: Check, v: Json): { bones: Set<string>; chains: Map<string, number>; parents: Map<string, string> } {
  const bones = new Set<string>([ROOT_BONE]);
  const chains = new Map<string, number>();
  const parents = new Map<string, string>();
  if (!c.array('config.bones', v, true)) return { bones, chains, parents };
  // Not `declare`: Bun strips `declare(...)` as a TypeScript ambient declaration
  // while tsc accepts it as a call, so the call vanished at run time with both
  // gates green. Measured, not assumed — the selftest has a control for it.
  const addBone = (name: string, at: string): void => {
    if (name === ROOT_BONE) c.fail('CONFIG_BONE_UNIQUE', at, `declares "${ROOT_BONE}", which every rig already has`);
    else if (bones.has(name)) c.fail('CONFIG_BONE_UNIQUE', at, `declares the bone "${name}" a second time`);
    bones.add(name);
  };
  (v as Json[]).forEach((entry, i) => {
    const at = `config.bones[${i}]`;
    const isChain = typeof entry === 'object' && entry !== null && 'chain' in entry;
    if (isChain) {
      const b = c.object(at, entry, ['chain', 'parent', 'points', 'tip'], []);
      if (b === null) return;
      if ('parent' in b && c.string(`${at}.parent`, b.parent) && !bones.has(b.parent)) {
        c.fail('CONFIG_NAME_RESOLVES', `${at}.parent`, `names "${b.parent}", which is not "${ROOT_BONE}" or a bone declared above it; parents come first`);
      }
      if ('tip' in b) c.point(`${at}.tip`, b.tip);
      if (!c.string(`${at}.chain`, b.chain)) return;
      const name = b.chain;
      if (chains.has(name)) c.fail('CONFIG_BONE_UNIQUE', `${at}.chain`, `declares the chain "${name}" a second time`);
      if ('points' in b && c.array(`${at}.points`, b.points, true)) {
        const points = b.points as Json[];
        points.forEach((pt, k) => c.point(`${at}.points[${k}]`, pt));
        points.forEach((_, k) => addBone(`${name}${k}`, `${at} link ${k}`));
        points.forEach((_, k) => {
          if (k > 0) parents.set(`${name}${k}`, `${name}${k - 1}`);
          else if (typeof b.parent === 'string' && !parents.has(`${name}0`)) parents.set(`${name}0`, b.parent);
        });
        chains.set(name, points.length);
      }
      return;
    }
    const b = c.object(at, entry, ['name', 'parent', 'at'], ['tip']);
    if (b === null) return;
    if ('parent' in b && c.string(`${at}.parent`, b.parent) && !bones.has(b.parent)) {
      c.fail('CONFIG_NAME_RESOLVES', `${at}.parent`, `names "${b.parent}", which is not "${ROOT_BONE}" or a bone declared above it; parents come first`);
    }
    if ('at' in b) c.point(`${at}.at`, b.at);
    if ('tip' in b) c.point(`${at}.tip`, b.tip);
    if ('name' in b && c.string(`${at}.name`, b.name)) {
      addBone(b.name, `${at}.name`);
      if (typeof b.parent === 'string' && !parents.has(b.name)) parents.set(b.name, b.parent);
    }
  });
  return { bones, chains, parents };
}

function checkMeshes(c: Check, v: Json, bones: Set<string>, chains: Map<string, number>): void {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    c.fail('CONFIG_FIELD_TYPE', 'config.meshes', `is ${show(v)}; an object of part name -> mesh is required`);
    return;
  }
  for (const [part, spec] of Object.entries(v as Record<string, Json>)) {
    const at = `config.meshes.${part}`;
    // The known keys keep their old order (grid, r, segments) with contour after them, and `r` and `segments` are
    // required in the place and words the object check uses, so a lattice mesh's refusals read as they did.
    const m = c.object(at, spec, [], ['grid', 'r', 'segments', 'contour', 'auto', 'exponent', 'rule']);
    if (m === null) continue;
    for (const key of ['r', 'segments']) if (!(key in m)) c.fail('CONFIG_FIELD_PRESENT', `${at}.${key}`, 'is absent and required');
    const modes = ['grid', 'contour', 'auto'].filter((k) => k in m);
    if (modes.length === 2 && !modes.includes('auto')) {
      c.fail('CONFIG_MESH_MODE', at, 'has both grid (the lattice) and contour; exactly one is required — a mesh is one or the other');
    } else if (modes.length > 1) {
      c.fail('CONFIG_MESH_MODE', at, `has ${modes.join(' and ')}; exactly one of grid (the lattice), contour (the outline mode) and auto (the automatic mode) is required — a mesh is one of them`);
    } else if (modes.length === 0) {
      c.fail('CONFIG_MESH_MODE', at, 'has neither grid (the lattice cell size, px) nor contour (the outline mode) nor auto (the automatic mode); exactly one is required');
    }
    if ('grid' in m) c.int(`${at}.grid`, m.grid, 1);
    if ('contour' in m) checkContour(c, `${at}.contour`, m.contour, bones);
    if ('auto' in m) checkAuto(c, `${at}.auto`, m.auto, bones);
    if ('r' in m) c.number(`${at}.r`, m.r, 'non-negative');
    // issue #161: the distance rule's exponent, in every mode; absent is 2 (src/weights.ts), nothing is filled in here.
    if ('exponent' in m) c.number(`${at}.exponent`, m.exponent, 'positive');
    if ('rule' in m && !WEIGHT_RULES.includes(m.rule as WeightRule)) {
      c.fail('CONFIG_FIELD_TYPE', `${at}.rule`, `is ${show(m.rule)}; "distance" (the distance rule, what an absent rule means) or "heat" (bone heat over the part's silhouette) is required`);
    }
    // issue #161: the exponent is the distance rule's; bone heat has none, so declaring both is refused rather than ignored.
    if ('exponent' in m && m.rule === 'heat') {
      c.fail('CONFIG_FIELD_TYPE', `${at}.exponent`, `is ${show(m.exponent)} on a mesh that declares rule "heat"; the exponent belongs to the distance rule (w = 1/(d + r)^exponent) and bone heat reads none — remove exponent, or declare rule "distance"`);
    }
    if ('segments' in m && c.array(`${at}.segments`, m.segments, true)) {
      (m.segments as Json[]).forEach((s, i) => {
        const sp = `${at}.segments[${i}]`;
        if (typeof s === 'string') {
          if (!chains.has(s) && !bones.has(s)) c.fail('CONFIG_NAME_RESOLVES', sp, `names "${s}", which is neither a chain nor a bone`);
          return;
        }
        if (!(Array.isArray(s) && s.length === 3 && typeof s[0] === 'string')) {
          c.fail('CONFIG_FIELD_TYPE', sp, `is ${show(s)}; a chain name, a bone name, or [bone, [x, y], [x, y]] is required`);
          return;
        }
        if (!bones.has(s[0] as string)) c.fail('CONFIG_NAME_RESOLVES', `${sp}[0]`, `names "${String(s[0])}", which is not a bone`);
        c.point(`${sp}[1]`, s[1]);
        c.point(`${sp}[2]`, s[2]);
      });
    }
  }
}

/**
 * `meshes.<part>.contour` (issue #84). `tolerance`, `margin` and `spacing` are
 * required — nothing is defaulted; `budget`, `stray` and `regions` are
 * optional, and an absent one is "none", not a guessed value. What the outline
 * itself refuses (a band that folds a polygon, a spacing whose keep radius
 * snaps to nothing) is `src/contour.ts`'s, at the rig stage, in its words;
 * what is read here is the shape of the block, the bone each region names, and
 * the grid every region number must sit on.
 */
function checkContour(c: Check, at: string, v: Json, bones: Set<string>): void {
  const o = c.object(at, v, ['tolerance', 'margin', 'spacing'], ['budget', 'stray', 'regions']);
  if (o === null) return;
  if ('tolerance' in o) c.number(`${at}.tolerance`, o.tolerance, 'non-negative');
  if ('margin' in o && c.number(`${at}.margin`, o.margin, 'non-negative') && (o.margin as number) > 0 && (o.margin as number) < 1) {
    c.fail('CONFIG_FIELD_TYPE', `${at}.margin`, `is ${o.margin as number}; 0, or 1 px or more, is required — the outline's silhouette grows by the pixels whose centre lies within the margin of an art pixel's centre, and none lies closer than 1 px, so a margin under 1 px would add nothing`);
  }
  if ('spacing' in o) c.number(`${at}.spacing`, o.spacing, 'positive');
  if ('budget' in o) c.int(`${at}.budget`, o.budget, 3);
  if ('stray' in o) c.int(`${at}.stray`, o.stray, 0);
  if (!('regions' in o) || !c.array(`${at}.regions`, o.regions, false)) return;
  const names = new Set<string>();
  (o.regions as Json[]).forEach((rv, i) => {
    const rat = `${at}.regions[${i}]`;
    const shape = typeof rv === 'object' && rv !== null && !Array.isArray(rv) ? (rv as Record<string, Json>).shape : undefined;
    const own = shape === 'circle' ? ['cx', 'cy', 'r'] : shape === 'polygon' ? ['points'] : [];
    const r = c.object(rat, rv, ['name', 'shape', 'bone', 'spacing', 'band', ...own], []);
    if (r === null) return;
    if ('shape' in r && own.length === 0) c.fail('CONFIG_FIELD_TYPE', `${rat}.shape`, `is ${show(r.shape)}; "circle" (with cx, cy, r) or "polygon" (with points) is required`);
    if ('name' in r && c.string(`${rat}.name`, r.name)) {
      if (names.has(r.name)) c.fail('CONFIG_REGION_NAME_UNIQUE', `${rat}.name`, `"${r.name}" is declared twice in this mesh; each region needs its own name`);
      names.add(r.name);
    }
    if ('bone' in r && (typeof r.bone !== 'string' || !bones.has(r.bone))) {
      c.fail('CONFIG_NAME_RESOLVES', `${rat}.bone`, `is ${show(r.bone)}; a bone config.bones declares is required — the region's control bone`);
    }
    const onGrid = (path: string, n: Json, rule: 'any' | 'positive' | 'non-negative'): void => {
      if (!c.number(path, n, rule)) return;
      const v2 = n as number;
      if (!Number.isInteger(v2 * GRID) || Math.abs(v2) > MAX_SIDE) {
        c.fail('CONFIG_FIELD_TYPE', path, `is ${v2}; a multiple of 1/${GRID} px within ±${MAX_SIDE} px is required — a region's weight is 1 inside it and 0 past its band, and those two are decided exactly on that grid`);
      }
    };
    if ('spacing' in r) c.number(`${rat}.spacing`, r.spacing, 'positive');
    if ('band' in r) onGrid(`${rat}.band`, r.band, 'non-negative');
    if (shape === 'circle') {
      if ('cx' in r) onGrid(`${rat}.cx`, r.cx, 'any');
      if ('cy' in r) onGrid(`${rat}.cy`, r.cy, 'any');
      if ('r' in r) onGrid(`${rat}.r`, r.r, 'positive');
    }
    if (shape === 'polygon' && 'points' in r && c.array(`${rat}.points`, r.points, true)) {
      const pts = r.points as Json[];
      if (pts.length < 3) c.fail('CONFIG_FIELD_TYPE', `${rat}.points`, `has ${pts.length} point(s); 3 or more [x, y] in rig pixels are required`);
      pts.forEach((p, k) => {
        if (!c.point(`${rat}.points[${k}]`, p)) return;
        onGrid(`${rat}.points[${k}][0]`, (p as Point)[0], 'any');
        onGrid(`${rat}.points[${k}][1]`, (p as Point)[1], 'any');
      });
    }
  });
}

/**
 * `meshes.<part>.auto` (issue #126, item 2). Every number is required and
 * read as rig-c's contract types it (docs/MESH_REDUCTION.md §1, §5, §6):
 * nothing is defaulted, nothing is read off the image. The two absences that
 * mean something are stated: `protect` and each of its fields may be left out
 * — `hull` is then false (P20, the default the agreement fixed for parts's
 * policy), each list empty and `weightJump` null (no such protection, which
 * the report echoes) — and `regions` and `source.stray` may be left out, as in
 * the contour mode. `motion` is required (issue #126 item 3), and inside it
 * `maxLocalDeformation`; `maxStretch`, `minStretch`, `deformMayFold` and
 * `gradation` may be left out (`AutoMotionSpec`). What only rig-c can judge (a region bound under one
 * texel, a region outside the art, a protected vertex index the source does
 * not have) is its refusal at the rig stage, in its words.
 */
function checkAuto(c: Check, at: string, v: Json, bones: Set<string>): void {
  const o = c.object(at, v, ['source', 'sourceBounds', 'targets', 'influences', 'budget', 'minArtSamples', 'motion'], ['protect', 'regions', 'boundaryRuns', 'retriangulate', 'removalOrder']);
  if (o === null) return;
  // Stage B (rigc#1271): three opt-ins, each absent = not sent; a value is exactly one rig-c accepts, or it is refused by name.
  if ('boundaryRuns' in o) {
    const b = c.object(`${at}.boundaryRuns`, o.boundaryRuns, ['maxVertices'], []);
    if (b !== null && 'maxVertices' in b) c.int(`${at}.boundaryRuns.maxVertices`, b.maxVertices, 2);
  }
  if ('retriangulate' in o && o.retriangulate !== 'delaunay') {
    c.fail('CONFIG_FIELD_TYPE', `${at}.retriangulate`, `is ${show(o.retriangulate)}; "delaunay" is required (the one post-pass rig-c offers), or leave the field out for the triangles the removals leave`);
  }
  if ('removalOrder' in o && o.removalOrder !== 'deformation-load') {
    c.fail('CONFIG_FIELD_TYPE', `${at}.removalOrder`, `is ${show(o.removalOrder)}; "deformation-load" is required (the one order rig-c offers besides its default), or leave the field out for ascending source index`);
  }
  if ('motion' in o) {
    const m = c.object(`${at}.motion`, o.motion, ['maxLocalDeformation'], ['maxStretch', 'minStretch', 'deformMayFold', 'gradation', 'selection', 'residual']);
    if (m !== null) {
      // issue #126 (rigc#1295): the skinning residual veto, opt-in; its bound is the author's number, never defaulted.
      if ('residual' in m) {
        const res = c.object(`${at}.motion.residual`, m.residual, ['maxResidual'], []);
        if (res !== null && 'maxResidual' in res) c.number(`${at}.motion.residual.maxResidual`, res.maxResidual, 'non-negative');
      }
      // issue #148: the multi-interval selection, opt-in; its budget is the author's whole number, never defaulted.
      if ('selection' in m) {
        const sel = c.object(`${at}.motion.selection`, m.selection, ['policy', 'maxProbes'], []);
        if (sel !== null) {
          if ('policy' in sel && sel.policy !== 'multi-interval') {
            c.fail('CONFIG_FIELD_TYPE', `${at}.motion.selection.policy`, `is ${show(sel.policy)}; "multi-interval" is required (the one policy besides the bisection), or leave selection out for the bisection`);
          }
          if ('maxProbes' in sel) c.int(`${at}.motion.selection.maxProbes`, sel.maxProbes, 1);
        }
      }
      // rigc#1291: the author's G, a number at or above 0, or null (sent as null: Δ not measured); never derived.
      if ('gradation' in m && m.gradation !== null) c.number(`${at}.motion.gradation`, m.gradation, 'non-negative');
      if ('maxLocalDeformation' in m) c.number(`${at}.motion.maxLocalDeformation`, m.maxLocalDeformation, 'non-negative');
      if ('maxStretch' in m) c.number(`${at}.motion.maxStretch`, m.maxStretch, 'non-negative');
      if ('minStretch' in m) c.number(`${at}.motion.minStretch`, m.minStretch, 'non-negative');
      if ('deformMayFold' in m && typeof m.deformMayFold !== 'boolean') c.fail('CONFIG_FIELD_TYPE', `${at}.motion.deformMayFold`, `is ${show(m.deformMayFold)}; true or false is required`);
    }
  }
  if ('source' in o) {
    const s = c.object(`${at}.source`, o.source, ['tolerance', 'margin', 'spacing'], ['stray']);
    if (s !== null) {
      if ('tolerance' in s) c.number(`${at}.source.tolerance`, s.tolerance, 'non-negative');
      if ('margin' in s && c.number(`${at}.source.margin`, s.margin, 'non-negative') && (s.margin as number) > 0 && (s.margin as number) < 1) {
        c.fail('CONFIG_FIELD_TYPE', `${at}.source.margin`, `is ${s.margin as number}; 0, or 1 px or more, is required — the source's silhouette grows by the pixels whose centre lies within the margin of an art pixel's centre, and none lies closer than 1 px`);
      }
      if ('spacing' in s) c.number(`${at}.source.spacing`, s.spacing, 'positive');
      if ('stray' in s) c.int(`${at}.source.stray`, s.stray, 0);
    }
  }
  const fit = (path: string, f: Json): void => {
    const b = c.object(path, f, ['minCoverage', 'maxOvershoot', 'maxUndercut'], []);
    if (b === null) return;
    if ('minCoverage' in b) c.number(`${path}.minCoverage`, b.minCoverage, 'unit');
    // A bound may be declared absent with null: rig-c (from 2.21.0) measures
    // and reports it as `undeclared` and gates nothing on it. Left out, it is
    // refused above (CONFIG_FIELD_PRESENT), as rig-c refuses it too.
    for (const k of ['maxOvershoot', 'maxUndercut'] as const) {
      if (!(k in b) || b[k] === null) continue;
      const v = b[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        c.fail('CONFIG_FIELD_TYPE', `${path}.${k}`, `is ${show(v)}; a number at or above 0, or null (declared absent: measured and reported, not bounded), is required`);
      }
    }
  };
  if ('sourceBounds' in o) fit(`${at}.sourceBounds`, o.sourceBounds);
  if ('targets' in o) {
    const t = c.object(`${at}.targets`, o.targets, ['artFit', 'maxBoundaryDeviation'], ['minAngle']);
    if (t !== null) {
      if ('artFit' in t) fit(`${at}.targets.artFit`, t.artFit);
      if ('maxBoundaryDeviation' in t) c.number(`${at}.targets.maxBoundaryDeviation`, t.maxBoundaryDeviation, 'non-negative');
      if ('minAngle' in t) c.number(`${at}.targets.minAngle`, t.minAngle, 'non-negative');
    }
  }
  if ('influences' in o) {
    const l = c.object(`${at}.influences`, o.influences, ['maxInfluences', 'minWeight'], []);
    if (l !== null) {
      if ('maxInfluences' in l) c.int(`${at}.influences.maxInfluences`, l.maxInfluences, 1);
      if ('minWeight' in l && c.number(`${at}.influences.minWeight`, l.minWeight, 'non-negative') && (l.minWeight as number) >= 1) {
        c.fail('CONFIG_FIELD_TYPE', `${at}.influences.minWeight`, `is ${l.minWeight as number}; a share at or above 0 and below 1 is required (0 drops only shares that are 0 on the weight grid)`);
      }
    }
  }
  if ('budget' in o) {
    const b = c.object(`${at}.budget`, o.budget, ['maxCandidates'], []);
    if (b !== null && 'maxCandidates' in b) c.int(`${at}.budget.maxCandidates`, b.maxCandidates, 0);
  }
  if ('minArtSamples' in o) c.int(`${at}.minArtSamples`, o.minArtSamples, 1);
  const names = new Set<string>();
  if ('regions' in o && c.array(`${at}.regions`, o.regions, false)) {
    (o.regions as Json[]).forEach((rv, i) => {
      const rat = `${at}.regions[${i}]`;
      const shape = typeof rv === 'object' && rv !== null && !Array.isArray(rv) ? (rv as Record<string, Json>).shape : undefined;
      const own = shape === 'circle' ? ['cx', 'cy', 'r'] : shape === 'polygon' ? ['points'] : [];
      const r = c.object(rat, rv, ['name', 'shape', 'maxEdgeLength', 'transition', 'grade', 'minArtSamples', ...own], ['bone', 'band']);
      if (r === null) return;
      // issue #155: `bone` and `band` together are the weight-and-density form, neither is the density-only form; one alone is refused.
      if ('band' in r && !('bone' in r)) {
        c.fail('CONFIG_REGION_BAND_NEEDS_BONE', `${rat}.band`, `is ${show(r.band)} and the region names no bone; a band is the falloff of a bone's weight — add "bone", or leave "band" out for a density-only region`);
      }
      if ('bone' in r && !('band' in r)) {
        c.fail('CONFIG_REGION_BONE_NEEDS_BAND', `${rat}.bone`, `is ${show(r.bone)} and the region declares no band; a region that weights a bone needs the band its weight falls off across (0 for a hard edge) — add "band", or leave "bone" out for a density-only region`);
      }
      if ('shape' in r && own.length === 0) c.fail('CONFIG_FIELD_TYPE', `${rat}.shape`, `is ${show(r.shape)}; "circle" (with cx, cy, r) or "polygon" (with points) is required`);
      if ('name' in r && c.string(`${rat}.name`, r.name)) {
        if (names.has(r.name)) c.fail('CONFIG_REGION_NAME_UNIQUE', `${rat}.name`, `"${r.name}" is declared twice in this mesh; each region needs its own name`);
        names.add(r.name);
      }
      if ('bone' in r && (typeof r.bone !== 'string' || !bones.has(r.bone))) {
        c.fail('CONFIG_NAME_RESOLVES', `${rat}.bone`, `is ${show(r.bone)}; a bone config.bones declares is required — the region's control bone`);
      }
      const onGrid = (path: string, n: Json, rule: 'any' | 'positive' | 'non-negative'): void => {
        if (!c.number(path, n, rule)) return;
        const v2 = n as number;
        if (!Number.isInteger(v2 * GRID) || Math.abs(v2) > MAX_SIDE) {
          c.fail('CONFIG_FIELD_TYPE', path, `is ${v2}; a multiple of 1/${GRID} px within ±${MAX_SIDE} px is required — a region's weight is 1 inside it and 0 past its band, and those two are decided exactly on that grid`);
        }
      };
      if ('band' in r) onGrid(`${rat}.band`, r.band, 'non-negative');
      if ('maxEdgeLength' in r) c.number(`${rat}.maxEdgeLength`, r.maxEdgeLength, 'positive');
      if ('transition' in r) c.number(`${rat}.transition`, r.transition, 'non-negative');
      if ('grade' in r) c.number(`${rat}.grade`, r.grade, 'non-negative');
      if ('minArtSamples' in r) c.int(`${rat}.minArtSamples`, r.minArtSamples, 1);
      if (shape === 'circle') {
        if ('cx' in r) onGrid(`${rat}.cx`, r.cx, 'any');
        if ('cy' in r) onGrid(`${rat}.cy`, r.cy, 'any');
        if ('r' in r) onGrid(`${rat}.r`, r.r, 'positive');
      }
      if (shape === 'polygon' && 'points' in r && c.array(`${rat}.points`, r.points, true)) {
        const pts = r.points as Json[];
        if (pts.length < 3) c.fail('CONFIG_FIELD_TYPE', `${rat}.points`, `has ${pts.length} point(s); 3 or more [x, y] in rig pixels are required`);
        pts.forEach((p, k) => {
          if (!c.point(`${rat}.points[${k}]`, p)) return;
          onGrid(`${rat}.points[${k}][0]`, (p as Point)[0], 'any');
          onGrid(`${rat}.points[${k}][1]`, (p as Point)[1], 'any');
        });
      }
    });
  }
  if ('protect' in o) {
    const p = c.object(`${at}.protect`, o.protect, [], ['hull', 'vertices', 'edges', 'regionBoundaries', 'weightJump', 'influences']);
    if (p === null) return;
    if ('hull' in p && typeof p.hull !== 'boolean') c.fail('CONFIG_FIELD_TYPE', `${at}.protect.hull`, `is ${show(p.hull)}; true or false is required`);
    if ('vertices' in p && c.array(`${at}.protect.vertices`, p.vertices, false)) (p.vertices as Json[]).forEach((n, k) => c.int(`${at}.protect.vertices[${k}]`, n, 0));
    if ('edges' in p && c.array(`${at}.protect.edges`, p.edges, false)) {
      (p.edges as Json[]).forEach((e, k) => {
        if (!(Array.isArray(e) && e.length === 2 && e.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0))) {
          c.fail('CONFIG_FIELD_TYPE', `${at}.protect.edges[${k}]`, `is ${show(e)}; a pair of source vertex indices [a, b] is required`);
        }
      });
    }
    if ('regionBoundaries' in p && c.array(`${at}.protect.regionBoundaries`, p.regionBoundaries, false)) {
      (p.regionBoundaries as Json[]).forEach((n, k) => {
        if (typeof n !== 'string' || !names.has(n)) c.fail('CONFIG_NAME_RESOLVES', `${at}.protect.regionBoundaries[${k}]`, `is ${show(n)}; the name of a region this mesh declares is required`);
      });
    }
    if ('weightJump' in p && p.weightJump !== null) c.number(`${at}.protect.weightJump`, p.weightJump, 'non-negative');
    if ('influences' in p && c.array(`${at}.protect.influences`, p.influences, false)) {
      (p.influences as Json[]).forEach((n, k) => {
        if (typeof n !== 'string' || !bones.has(n)) c.fail('CONFIG_NAME_RESOLVES', `${at}.protect.influences[${k}]`, `is ${show(n)}; a bone config.bones declares is required`);
      });
    }
  }
}

function checkRegions(c: Check, v: Json, bones: Set<string>): void {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    c.fail('CONFIG_FIELD_TYPE', 'config.regions', `is ${show(v)}; an object of part name -> bone name is required`);
    return;
  }
  for (const [part, bone] of Object.entries(v as Record<string, Json>)) {
    if (typeof bone !== 'string' || !bones.has(bone)) {
      c.fail('CONFIG_NAME_RESOLVES', `config.regions.${part}`, `is ${show(bone)}; a bone name is required`);
    }
  }
}

/**
 * Every plan part is exactly one of a mesh or a region, every patch is a
 * region, and every mesh or region is a plan part or a patch.
 */
function checkCoverage(c: Check, parts: string[], patches: string[], meshes: Json, regions: Json): void {
  const m = typeof meshes === 'object' && meshes !== null ? Object.keys(meshes) : [];
  const r = typeof regions === 'object' && regions !== null ? Object.keys(regions) : [];
  for (const patch of patches) {
    if (m.includes(patch)) c.fail('CONFIG_PART_ATTACHED', `part "${patch}"`, `is an assemble.patches entry and has a meshes entry; a patch is a region — drop config.meshes.${patch} and name its bone in config.regions.${patch}`);
    else if (!r.includes(patch)) c.fail('CONFIG_PART_ATTACHED', `part "${patch}"`, `is an assemble.patches entry with no regions entry; a patch is a region, so config.regions.${patch} naming its bone is required`);
  }
  for (const part of parts) {
    const inM = m.includes(part);
    const inR = r.includes(part);
    if (!inM && !inR) c.fail('CONFIG_PART_ATTACHED', `part "${part}"`, 'has neither a meshes entry nor a regions entry; exactly one is required');
    if (inM && inR) c.fail('CONFIG_PART_ATTACHED', `part "${part}"`, 'has both a meshes entry and a regions entry; exactly one is required');
  }
  for (const name of [...m, ...r]) {
    if (!parts.includes(name) && !patches.includes(name)) {
      c.fail('CONFIG_NAME_RESOLVES', `config.${m.includes(name) ? 'meshes' : 'regions'}.${name}`, 'names a part that neither assemble.plan nor assemble.patches makes');
    }
  }
}

/** What an empty blink group is told: the tags whose parts make its bones, and what to write instead. */
const BLINK_GROUP_EMPTY: Readonly<Record<'eyes' | 'brows', string>> = {
  eyes: 'is []; the eyes group must name at least one bone (rigc refuses a group with no members). The eye bones come from eyewhite-r / eyewhite-l parts; a figure with none has nothing to blink, so leave config.motion.blink out',
  brows: 'is []; the brows group must name at least one bone (rigc refuses a group with no members). The brow bones come from eyebrow-r / eyebrow-l parts; a figure with none has nothing to drop, so leave brows and brow_drop out',
};

function checkMotion(c: Check, v: Json, bones: Set<string>, chains: Map<string, number>, regions: Json): void {
  const m = c.object('config.motion', v, ['duration', 'tracks'], ['blink', 'animations_from']);
  if (m === null) return;
  const p = 'config.motion';
  if ('animations_from' in m) c.string(`${p}.animations_from`, m.animations_from);
  // Every bone property the idle will key, and the tracks that key it, in the
  // order idleMotion writes them: single and chain tracks, then the eyes
  // group, then the brows group.
  const claims = new Map<string, string[]>();
  const claim = (target: string, by: string): void => {
    claims.set(target, [...(claims.get(target) ?? []), by]);
  };
  const duration = 'duration' in m && c.number(`${p}.duration`, m.duration, 'positive') ? (m.duration as number) : null;
  const periodFits = (at: string, period: Json): void => {
    if (!c.number(at, period, 'positive') || duration === null) return;
    const cycles = duration / period;
    if (Math.abs(cycles - Math.round(cycles)) > 1e-9) {
      c.fail(
        'CONFIG_PERIOD_DIVIDES_DURATION',
        at,
        `is ${period} s against a ${duration} s idle, ${cycles.toFixed(4)} cycles; a whole number of cycles is required or the loop's last frame is not its first`,
      );
    }
  };
  if ('tracks' in m && c.array(`${p}.tracks`, m.tracks, false)) {
    (m.tracks as Json[]).forEach((tr, i) => {
      const at = `${p}.tracks[${i}]`;
      if (typeof tr === 'object' && tr !== null && 'chain' in tr) {
        const t = c.object(at, tr, ['chain', 'amps', 'period', 'phase', 'lag'], []);
        if (t === null) return;
        if ('period' in t) periodFits(`${at}.period`, t.period);
        if ('phase' in t) c.number(`${at}.phase`, t.phase);
        if ('lag' in t) c.number(`${at}.lag`, t.lag);
        const links = typeof t.chain === 'string' ? chains.get(t.chain) : undefined;
        if (links === undefined) c.fail('CONFIG_NAME_RESOLVES', `${at}.chain`, `is ${show(t.chain)}; a chain declared in config.bones is required`);
        // A chain track keys rotate on every link (idleMotion), one link per point.
        else for (let k = 0; k < links; k++) claim(`${String(t.chain)}${k}.rotate`, `${at} (chain "${String(t.chain)}", link ${k})`);
        if ('amps' in t && c.array(`${at}.amps`, t.amps, true)) {
          const amps = t.amps as Json[];
          amps.forEach((a, k) => c.number(`${at}.amps[${k}]`, a));
          if (links !== undefined && amps.length !== links) {
            c.fail('CONFIG_AMPS_MATCH_CHAIN', `${at}.amps`, `holds ${amps.length} amplitude(s) for the ${links}-link chain "${String(t.chain)}"; one per link is required`);
          }
        }
        return;
      }
      const t = c.object(at, tr, ['bone', 'prop', 'amp', 'period', 'phase'], ['base']);
      if (t === null) return;
      if (typeof t.bone !== 'string' || !bones.has(t.bone)) c.fail('CONFIG_NAME_RESOLVES', `${at}.bone`, `is ${show(t.bone)}; a declared bone is required`);
      if ('prop' in t && !(SINGLE_PROPS as readonly string[]).includes(t.prop as string)) {
        c.fail('CONFIG_FIELD_TYPE', `${at}.prop`, `is ${show(t.prop)}; one of ${SINGLE_PROPS.join(', ')} is required`);
      } else if ('prop' in t && typeof t.bone === 'string' && bones.has(t.bone)) claim(`${t.bone}.${String(t.prop)}`, at);
      if ('amp' in t) c.number(`${at}.amp`, t.amp);
      if ('period' in t) periodFits(`${at}.period`, t.period);
      if ('phase' in t) c.number(`${at}.phase`, t.phase);
      if ('base' in t) c.number(`${at}.base`, t.base);
    });
  }
  if ('blink' in m) {
    const b = c.object(`${p}.blink`, m.blink, ['t', 'eyes', 'squash'], ['brows', 'brow_drop', 'still']);
    if (b === null) return refuseSharedTargets(c, claims);
    if ('t' in b) c.number(`${p}.blink.t`, b.t, 'non-negative');
    if ('squash' in b) c.number(`${p}.blink.squash`, b.squash, 'positive');
    if ('brow_drop' in b) c.number(`${p}.blink.brow_drop`, b.brow_drop);
    if ('brows' in b && !('brow_drop' in b)) {
      c.fail('CONFIG_BLINK_BROWS_PAIRED', `${p}.blink.brow_drop`, 'is absent while config.motion.blink.brows is stated; the brows group drops by brow_drop, so state both or neither');
    }
    if ('brow_drop' in b && !('brows' in b)) {
      c.fail('CONFIG_BLINK_BROWS_PAIRED', `${p}.blink.brows`, `is absent while config.motion.blink.brow_drop is ${show(b.brow_drop)}; nothing would drop, so state both or neither`);
    }
    for (const key of ['eyes', 'brows'] as const) {
      if (key in b && c.array(`${p}.blink.${key}`, b[key], false)) {
        const list = b[key] as Json[];
        // rigc refuses a group with no members (`group "eyes" declares no
        // members`) one stage later, at the gate; the stage whose input is
        // wrong is this one.
        if (list.length === 0) c.fail('CONFIG_BLINK_GROUP_MEMBERS', `${p}.blink.${key}`, BLINK_GROUP_EMPTY[key]);
        const at = new Map<string, number[]>();
        list.forEach((name, k) => {
          if (typeof name !== 'string' || !bones.has(name)) c.fail('CONFIG_NAME_RESOLVES', `${p}.blink.${key}[${k}]`, `is ${show(name)}; a declared bone is required`);
          if (typeof name === 'string') at.set(name, [...(at.get(name) ?? []), k]);
        });
        // The group track keys one property on every member: scaley for the
        // eyes, translatey for the brows — and the brows track is written only
        // when brow_drop is stated beside them (idleMotion). A member named
        // twice is CONFIG_BLINK_GROUP_UNIQUE's, so each bone claims once, at
        // its first index.
        const prop = key === 'eyes' ? 'scaley' : 'translatey';
        if (key === 'eyes' || 'brow_drop' in b) {
          for (const [name, ks] of at) if (bones.has(name)) claim(`${name}.${prop}`, `${p}.blink.${key}[${ks[0]}] (the blink's ${key} group, which keys ${prop} on every member)`);
        }
        // rigc refuses a member named twice (`group "eyes" names member "eye"
        // twice`) at the gate, one stage late — issue #45, the sibling of the
        // empty group above. One refusal per repeated name, in first-seen order.
        for (const [name, ks] of at) {
          if (ks.length > 1) {
            c.fail(
              'CONFIG_BLINK_GROUP_UNIQUE',
              `${p}.blink.${key}`,
              `names ${show(name)} ${ks.length === 2 ? 'twice' : `${ks.length} times`} (at ${ks.map((k) => `[${k}]`).join(', ')}); each bone is named once — the group keys every member it names, so a repeat keys one bone twice, and rigc refuses a group naming a member twice`,
            );
          }
        }
      }
    }
    if ('still' in b) checkBlinkStill(c, b.still, b.eyes, bones, regions);
  }
  refuseSharedTargets(c, claims);
}

/**
 * Two tracks keying one bone property — two single tracks, a single track
 * beside a chain link's rotate or a blink group's member — are one refusal
 * per property, naming every track that keys it (issue #49). rigc refuses the
 * pair at the rig gate (`animation "idle" has two tracks on eye.scaley`), one
 * stage after the input that was wrong; the loader knows every track it
 * writes. The control bones the rig stage adds (`<bone>_ctl`) cannot make two
 * distinct targets one: the rename is the same suffix on every key of a bone,
 * and a declared bone already holding the control's name is the rig stage's
 * refusal, `RIG_CONTROL_NAME_FREE`.
 */
function refuseSharedTargets(c: Check, claims: ReadonlyMap<string, string[]>): void {
  for (const [target, by] of claims) {
    if (by.length < 2) continue;
    c.fail(
      'CONFIG_BONE_PROPERTY_KEYED_ONCE',
      `bone property "${target}"`,
      `is keyed by ${by.length} tracks: ${by.join(' and ')}; one track per bone property is required — the idle would hold ${by.length} timelines on ${target}, and rigc refuses two tracks on one bone property. Merge them into one track, or key another property or bone`,
    );
  }
}

/**
 * `config.constraints` (issue #92): rig-c's own constraint shapes, read
 * for the four things this package owns and nothing else (see the module
 * comment). What each refusal is for:
 *
 * - `CONFIG_FIELD_TYPE` / `CONFIG_FIELD_PRESENT`: not a list, an entry not an
 *   object, a `type` or `name` absent, a `name` not a non-empty string, an
 *   annotation not a string, a bone field holding something that is not a
 *   name (or a list of names).
 * - `CONFIG_CONSTRAINT_TYPE_KNOWN`: a `type` rigc's union does not name.
 *   rigc refuses it too; the stage whose input is wrong is this one.
 * - `CONFIG_CONSTRAINT_NAME_UNIQUE`: two constraints of one kind under one
 *   name. rigc resolves a constraint by its kind and its name
 *   (`SkeletonData.findConstraint(name, type)`), so an ik and a transform may
 *   share a name and two iks may not — the identity rigc keeps.
 * - `CONFIG_NAME_RESOLVES`: a bone a constraint names that `bones` does not
 *   declare, naming the constraint, the field and the name, with the bones
 *   that exist.
 * - `CONFIG_CONSTRAINT_TARGET_DETACHED`: the bone an ik follows (`target`)
 *   or a transform reads (`source`) is one of the bones it drives or sits
 *   under one, so driving them moves the bone they follow. A scene target is
 *   a bone parented to `root`. The rig stage declares the same fact for rigc
 *   (`invariants.detached`, rigc's `A25`), so the gate holds the built rig to
 *   it too. rigc does not refuse this parentage undeclared: measured through
 *   rig-c 2.15.0 on the rig fixture, an ik over `hem0` following `hem1`
 *   and a transform over `hem0` reading `hem1` each gate green with nothing
 *   declared.
 *
 * Every other field — `mix`, `properties`, a path's `slot`, a slider's
 * `animation` — and every value of it is rigc's, refused at the rig stage's
 * gate in rigc's words. So is an ik's `bones` as a shape (issue #103): from
 * rig-c 2.15.0 its rig-spec parser refuses an ik over more than two
 * bones, or over a pair whose second bone is not the first's child, by name
 * (firejune/rigc#1205); this loader refused both itself while rigc's gate
 * passed them (issue #92), and no longer does.
 */
function checkConstraints(c: Check, v: Json, bones: Set<string>, parents: Map<string, string>): void {
  const p = 'config.constraints';
  if (!c.array(p, v, false)) return;
  const kinds = RIG_SKIN_CONSTRAINT_KEYS as readonly string[];
  const declared = [...bones].join(', ');
  const seen = new Map<string, number>();
  // A bone's parents as the config writes them, nearest first.
  const above = (bone: string): string[] => {
    const out: string[] = [];
    for (let up = parents.get(bone); up !== undefined && !out.includes(up); up = parents.get(up)) out.push(up);
    return out;
  };
  (v as Json[]).forEach((entry, i) => {
    const at = `${p}[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      c.fail('CONFIG_FIELD_TYPE', at, `is ${show(entry)}; a constraint object in rig-c's rig-spec shape is required ({"type": …, "name": …, and that kind's fields})`);
      return;
    }
    const o = entry as Record<string, Json>;
    for (const key of Object.keys(o)) {
      if (!isRecordKey(key) && (key === 'note' || key.endsWith('_note')) && typeof o[key] !== 'string') {
        c.fail('CONFIG_FIELD_TYPE', `${at}.${key}`, `is ${show(o[key])}; an annotation is a string — a structured record goes under a key beginning "x-" (any JSON, read by nothing)`);
      }
    }
    let kind: RigSkinConstraintKey | null = null;
    if (!('type' in o)) c.fail('CONFIG_FIELD_PRESENT', `${at}.type`, `is absent and required; one of ${kinds.join(', ')}`);
    else if (typeof o.type !== 'string' || !kinds.includes(o.type)) {
      c.fail('CONFIG_CONSTRAINT_TYPE_KNOWN', `${at}.type`, `is ${show(o.type)}; one of ${kinds.join(', ')} is required — rig-c's rig-spec constraint kinds, spelled as rigc spells them`);
    } else kind = o.type as RigSkinConstraintKey;
    if (!('name' in o)) c.fail('CONFIG_FIELD_PRESENT', `${at}.name`, 'is absent and required; a constraint is found by its kind and its name');
    else if (c.string(`${at}.name`, o.name) && kind !== null) {
      const id = `${kind} ${o.name}`;
      const first = seen.get(id);
      if (first !== undefined) {
        c.fail(
          'CONFIG_CONSTRAINT_NAME_UNIQUE',
          `${at}.name`,
          `names the ${kind} constraint "${o.name}" again (first at constraints[${first}]); a constraint is found by its kind and its name, so two of one kind may not share one (an ik and a transform may: rig-c's identity of a constraint)`,
        );
      } else seen.set(id, i);
    }
    if (kind === null) return;
    const label = typeof o.name === 'string' && o.name !== '' ? `${kind} constraint "${o.name}"` : `the ${kind} constraint`;
    // The bone names, field by field, resolved against the declared bones.
    const named = new Map<string, string[]>();
    for (const [field, arity] of CONSTRAINT_BONE_FIELDS[kind]) {
      if (!(field in o)) continue;
      const value = o[field];
      const fat = `${at}.${field}`;
      if (arity === 'one') {
        if (typeof value !== 'string') {
          c.fail('CONFIG_FIELD_TYPE', fat, `is ${show(value)}; ${label} names a bone here, and a bone name is required`);
        } else if (!bones.has(value)) {
          c.fail('CONFIG_NAME_RESOLVES', fat, `names "${value}", which config.bones does not declare (${label}); the bones that exist: ${declared}`);
        } else named.set(field, [value]);
        continue;
      }
      if (!Array.isArray(value) || !value.every((n) => typeof n === 'string')) {
        c.fail('CONFIG_FIELD_TYPE', fat, `is ${show(value)}; ${label} names bones here, and a list of bone names is required`);
        continue;
      }
      const list = value as string[];
      list.forEach((n, k) => {
        if (!bones.has(n)) c.fail('CONFIG_NAME_RESOLVES', `${fat}[${k}]`, `names "${n}", which config.bones does not declare (${label}); the bones that exist: ${declared}`);
      });
      if (list.every((n) => bones.has(n))) named.set(field, list);
    }
    const driven = named.get('bones');
    const follows = CONSTRAINT_FOLLOWS[kind];
    const target = follows === undefined ? undefined : named.get(follows)?.[0];
    if (follows !== undefined && target !== undefined && driven !== undefined) {
      const line = [target, ...above(target)];
      const hit = driven.find((b) => line.includes(b));
      if (hit !== undefined) {
        const where = hit === target ? `is "${target}", which ${label} also drives` : `is "${target}", which sits under "${hit}" (${line.slice(0, line.indexOf(hit) + 1).join(' < ')}), a bone ${label} drives`;
        c.fail(
          'CONFIG_CONSTRAINT_TARGET_DETACHED',
          `${at}.${follows}`,
          `${where}; the bone a constraint follows must not move with the bones it drives, or driving them moves what they follow — a scene target is a bone parented to "${ROOT_BONE}"`,
        );
      }
    }
  });
}

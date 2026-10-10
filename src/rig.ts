/**
 * The rig stage: a character config and its assembled parts in, a rig spec
 * and a motion spec in rig-c's format out.
 *
 *     config (bones, meshes, regions, motion) + parts.json + parts/*.png
 *       -> images/*.png, rig.json, motion.json, mesh_report.json
 *
 * Everything written is something rig-c takes verbatim; no rigc
 * generator is used. What is authored:
 *
 * - **Bones**, unscaled, at the config's landmarks. A chain
 *   `{chain: "c", points: [p0 .. pn]}` becomes the bones `c0 .. cn`, each the
 *   parent of the next. `root` sits at the bottom centre of the rig canvas.
 *   Each chain link is **turned along its chain** (issue #73): `rotation` is
 *   the direction from its origin to the next link's — the last link's to
 *   the chain's `tip` — in Spine degrees (counter-clockwise, y up, local to
 *   the parent; measured through rigc with a one-bone spec), and `length` is
 *   that distance, so a physics constraint a consumer adds finds a lever
 *   (spine-core's solver reads `bone.data.length`). Under `idleKeys: 'ctl'`
 *   the link's control carries the turn and the length and the link sits at
 *   local rotation 0 under it; under `direct` the link carries them. Every
 *   other bone keeps world rotation 0 — one whose parent is a link is turned
 *   back. Nothing moves: a child's `x, y`, a weight's bind `x, y` and a
 *   region's `x, y` are the landmark carried into the turned frame as written
 *   (rigc's inverse, `src/coords.ts`), a region on a turned bone is turned
 *   back upright by `rotation`, and {@link flattenRig} gives the unturned
 *   numbers the reference wrote. A key the turn would re-aim — a translate
 *   key under a turned parent, a scale or shear key on a turned bone — is
 *   refused (`RIG_KEY_FRAME_UNTURNED`); rotate keys mean what they meant.
 *   A single bone with a `tip` is not turned (its tip is still a segment
 *   end for the weights); giving it a lever would be the same change on
 *   that bone and its children, and is not made here.
 * - **Meshes** over the parts named in `meshes`: a square lattice (`src/mesh.ts`)
 *   weighted by distance to the mesh's candidate segments (`src/weights.ts`),
 *   written in rigc's by-name `weights` form. The slot's bone is the first
 *   segment's bone. A mesh whose entry says `contour` (issue #84) is
 *   `src/contour.ts`'s mesh over the padded image instead, each vertex
 *   weighted by `src/localweights.ts` (its regions' bones by their declared
 *   falloff, the rest by the same segments), every refusal collected with the
 *   others; a lattice mesh writes what it always wrote.
 * - **Regions** for the parts named in `regions`: the image centred where the
 *   part sits, offset from its bone. A part named in `motion.blink.still` is
 *   two regions cut at its row: the rows from `row` down on the part's own
 *   slot and bone (they blink), the rows above on `<part>_still` and the
 *   entry's `bone`, drawn right after it (they do not). The cut row must carry
 *   no art: cut through art, each piece is resampled against its own
 *   transparent edge and the render changes at rest — measured on the demo
 *   example, 36 px of the setup pose (max 7 levels) — while a clear-row cut
 *   changes no pixel outside the blink (issue #26, `RG16`). A `painting:`
 *   patch (`assemble.patches`) is always a region; its slot sits where
 *   parts.json puts it, which is where its `draw` put it.
 * - **The idle** and, under `idleKeys: 'ctl'` (the default), its control
 *   bones (`src/motion.ts`). Under `idleKeys: 'direct'` the keys stay on the
 *   bones the meshes are weighted to, no `<bone>_ctl` is added, and the rig
 *   spec declares `invariants.idleDrivesMeshes` with
 *   {@link IDLE_DRIVES_MESHES_WHY} — rig-c 1.3.0's statement that this
 *   idle deforms meshes on purpose, which `A15_IDLE_NO_MESH_BONE_KEYS` then
 *   reports as a SKIP with its cost instead of refusing each bone. The
 *   declaration is written only when the idle keys at least one mesh-driving
 *   bone: rigc refuses a declaration that switches nothing off.
 * - **Constraints**, only when the config has `constraints` (issue #92):
 *   handed to rigc as `rig.json`'s `constraints`, in the order written, each
 *   as written but its records and annotations. Nothing here solves or
 *   validates them; rigc's gate does, and a field it refuses is its refusal,
 *   in its words (`RIG_RIGC_GREEN`) — a two-bone ik whose child the idle
 *   keys through a control included (rig-c 2.15.0, issue #103). Every
 *   bone a constraint follows is declared detached from the bones it drives
 *   ({@link detachedRules}, `invariants.detached`, rigc's `A25`). Without the
 *   field, no byte of any output moves.
 *
 * Every part image is padded by {@link PAD} transparent pixels on each side
 * before it is meshed or placed, and the padded image is what `images/`
 * holds: a lattice vertex on the part's own edge would otherwise sit on the
 * texture's edge, where filtering samples outside the art.
 *
 * Coordinates in the config and in parts.json are rig pixels, y down. The one
 * y flip goes through `src/coords.ts` (rig-c's `cropToSpineY`); x is
 * measured from the canvas centre, which is where `root` stands.
 *
 * Pure: the caller reads the files and writes the outputs; nothing here
 * touches the disk, and the same inputs give the same bytes (key order is the
 * order the objects are built in, and every number is rounded by `pyRound`).
 */
import { type AutoSpec, type BoneEntry, type WeightRule, type CharacterConfig, type ConfigConstraint, CONSTRAINT_FOLLOWS, constraintForRig, type ContourSpec, type Point, type RibsSpec, ROOT_BONE, weightsABone } from './config.ts';
import { type BoneTransform, computeExactFrameTransforms, cropToSpineY, normaliseDegrees, toBoneLocal, toWorld } from './coords.ts';
import { type Problem, refuseIfAny } from './errors.ts';
import type { MeshCounts, MeshQualityReport, MeshReductionInput, MotionAmplitude, ReducedMesh, Termination } from 'rig-c/mesh';
import { type AmplitudeRow, amplitudeRow, partAmplitude, withAmplitude } from './autoamplitude.ts';
import { type ResidualRow, residualRow, slotEnvelope, withSkinning } from './autoenvelope.ts';
import { type AutoMotionCase, type AutoSearch, DEFORM_MAY_FOLD_WHY, type MotionDeformation } from './automotion.ts';
import { type MultiIntervalRow, refinementSteps, replayVerdict, type ReplayRow } from './autoreplay.ts';
import {
  autoReductionInput,
  autoSource,
  autoVerdict,
  AUTO_THRESHOLD,
  DEFORMATION_UNMEASURED,
  legacyArtCoverage,
  qualityDocument,
  type Reducer,
  type Residual,
  residuals,
  runReduction,
  sourceWeights,
  type StageBOptIns,
  type StageBResult,
  stageBResult,
  worstRegion,
  worstResidual,
} from './automesh.ts';
import { type ContourChainRibs, type ContourReport, contourMesh, type ContourRegion, type ContourRib } from './contour.ts';
import { type LocalInfluence, localInfluences } from './localweights.ts';
import { artCoverage, ART_ALPHA, latticeMesh, ONE_LOOP_PASSES } from './mesh.ts';
import { BLINK, blinkHoldMisses, blinkSpan, CONTROL_SUFFIX, controlledBones, IDLE_FPS, idleMotion, type MotionSpec, moveKeysToControls } from './motion.ts';
import { PAINTING_RUN, type PartsFile, readFrom } from './parts.ts';
import { alphaAbove, crop, pad, type Raster } from './raster/index.ts';
import { pyRound } from './round.ts';
import { boneHeat, heatInfluences, heatRow, type HeatRow, latticeSilhouette, tracedSilhouette } from './heat.ts';
import { DEFAULT_LIMITS, DISTANCE_EXPONENT, type Influence, influences, type Segment } from './weights.ts';

/** Transparent pixels added round every part image — the reference's `PAD`. */
export const PAD = 4;

/**
 * The places a bone's rotation and every local offset (a bone's `x, y`, a
 * weight's bind `x, y`, a region's `x, y` and `rotation`) are written to.
 * The reference wrote offsets to 3, and could: its frames were never turned,
 * so an offset was a difference of two landmarks. Under a turned frame an
 * offset is that difference carried through a rotation, and 3 places would
 * move a world position by up to 0.0007 px — enough that turning it back
 * ({@link flattenRig}, to the reference's 3) would land a value on the other
 * side of a rounding step. Each offset is placed through its parent's frame
 * as written, so the errors do not add down a chain: every world position is
 * within 7.1e-7 of its landmark, and the round trip is exact unless a
 * landmark difference lies within that of a 3-place rounding step, which a
 * difference of whole and half pixels never does. An unturned frame writes
 * the same numbers it always wrote.
 */
export const OFFSET_PLACES = 6;

/** The places the reference wrote an offset to, which {@link flattenRig} gives back. */
export const FLAT_PLACES = 3;

/** {@link pyRound} to `n` places, with a negative zero written as 0. */
function placed(v: number, n: number): number {
  const r = pyRound(v, n);
  return r === 0 ? 0 : r;
}

function places(v: number): number {
  return placed(v, OFFSET_PLACES);
}

/**
 * The weights a contour vertex is written with: a vertex no region reaches is
 * rounded as the lattice rounds (each to 5 places, the last `1 − sum(others)`),
 * one a region reaches by {@link roundShares}.
 */
export function writtenShares(li: LocalInfluence): Influence[] {
  if (li.region >= 0) return roundShares(li.influences);
  const shares = li.influences.map(({ bone, weight }) => ({ bone, weight: pyRound(weight, 5) }));
  let others = 0;
  for (let k = 0; k < shares.length - 1; k++) others += shares[k].weight;
  shares[shares.length - 1].weight = pyRound(1 - others, 5);
  return shares;
}

/**
 * A region-weighted vertex's weights at 5 places (issue #84): each rounded
 * with `pyRound`; an entry that rounds to 0 is dropped (a bone at weight 0
 * pulls nothing); and the rounding remainder goes to the heaviest entry, the
 * first of equals, written as `1 − sum(others)`, so the vertex sums to exactly
 * 1. The lattice writes the remainder into its LAST entry, which is safe only
 * because `influences()` floors every entry at `MIN_WEIGHT`; a region's ramp
 * reaches the shares below that floor (`src/localweights.ts`), and a share
 * near 0 must not absorb a remainder that could take it negative. A vertex no
 * region reaches is rounded exactly as the lattice rounds, not by this.
 */
export function roundShares(list: readonly Influence[]): Influence[] {
  const kept = list.map((e) => ({ bone: e.bone, weight: pyRound(e.weight, 5) })).filter((e) => e.weight > 0);
  let heavy = 0;
  for (let k = 1; k < kept.length; k++) if (kept[k].weight > kept[heavy].weight) heavy = k;
  let others = 0;
  for (let k = 0; k < kept.length; k++) if (k !== heavy) others += kept[k].weight;
  kept[heavy].weight = pyRound(1 - others, 5);
  return kept;
}

interface Bone {
  name: string;
  parent: string | null;
  x: number;
  y: number;
}

export interface RigBone {
  name: string;
  parent?: string;
  /** A chain link and its control: the distance to the next link, or to the chain's tip. */
  length?: number;
  /** Spine degrees, CCW in a y-up world, local to the parent — written on a chain link and its control, and on a bone whose parent is turned. */
  rotation?: number;
  x: number;
  y: number;
}

export interface WeightEntry {
  bone: string;
  x: number;
  y: number;
  weight: number;
}

export interface MeshAttachment {
  type: 'mesh';
  image: string;
  width: number;
  height: number;
  uvs: number[];
  triangles: number[];
  hull: number;
  weights: WeightEntry[][];
}

export interface RegionAttachment {
  image: string;
  x: number;
  y: number;
  /** Written only on a turned bone: the bone's world rotation, cancelled, so the image stays upright. */
  rotation?: number;
}

export interface RigSpec {
  spec: 'rigc-rig/1';
  name: string;
  images: 'images';
  skeleton: { x: number; y: number; width: number; height: number };
  bones: RigBone[];
  slots: Array<{ name: string; bone: string; attachment: string }>;
  skins: { default: Record<string, Record<string, MeshAttachment | RegionAttachment>> };
  /**
   * `config.constraints`, in the order written, each as the config wrote it
   * but its records and annotations ({@link constraintForRig}). Written only
   * when the config has the field.
   */
  constraints?: Array<Record<string, unknown>>;
  /**
   * `idleDrivesMeshes`: written only under `idleKeys: 'direct'`, and only when
   * the idle keys a mesh-driving bone. `detached`: written only when a
   * constraint follows a bone ({@link detachedRules}).
   */
  invariants?: { idleDrivesMeshes?: { why: string }; detached?: DetachedRule[]; deformMayFold?: Array<{ slot: string; why: string }> };
}

/** One `invariants.detached` entry: rig-c's `RigDetachedRule`, checked by its gate rule `A25`. */
export interface DetachedRule {
  bone: string;
  notUnder: string;
  why: string;
}

/**
 * `invariants.detached` for a config's constraints (issue #92): for each
 * constraint that follows a bone — an ik's `target`, a transform's `source`
 * — one rule per bone it drives, `{bone: <followed>, notUnder: <driven>}`,
 * in constraint order and then `bones` order, each pair once. rig-c's
 * `A25_DETACHED_BONE_PARENTAGE` fails a rule whose `bone` is a descendant of
 * its `notUnder` (rig-c 2.10.1, `src/assertions/bodies/a25.ts`):
 * measured on the rig fixture, a target declared detached and parented under
 * the link it drives fails the gate under both `--idle-keys` values, and the
 * same rig with nothing declared gates green with `A25` a SKIP. The loader
 * refuses that parentage first (`CONFIG_CONSTRAINT_TARGET_DETACHED`); the
 * declaration is what keeps it measured on the built rig, which a consumer
 * composes into a scene. Empty when no constraint follows a bone.
 */
export function detachedRules(constraints: readonly ConfigConstraint[]): DetachedRule[] {
  const out: DetachedRule[] = [];
  const seen = new Set<string>();
  constraints.forEach((c, i) => {
    const field = CONSTRAINT_FOLLOWS[c.type];
    if (field === undefined) return;
    const followed = c[field];
    const driven = c.bones;
    if (typeof followed !== 'string' || !Array.isArray(driven)) return;
    for (const b of driven) {
      if (typeof b !== 'string' || seen.has(`${followed}\u0000${b}`)) continue;
      seen.add(`${followed}\u0000${b}`);
      out.push({ bone: followed, notUnder: b, why: `rig-parts: "${followed}" is the ${field} of ${c.type} constraint "${c.name}" (config.constraints[${i}]), and "${b}" is a bone it drives; under it, driving it would move what it follows` });
    }
  });
  return out;
}

/**
 * Where the idle's keys on a mesh-driving bone go (`rig --idle-keys`).
 *
 * - `ctl`: onto a same-origin `<bone>_ctl` parent, which passes
 *   `A15_IDLE_NO_MESH_BONE_KEYS` under every rig-c this package has run
 *   on. It satisfies the rule's wording only — see `src/motion.ts`.
 * - `direct`: onto the bone itself, with `invariants.idleDrivesMeshes`
 *   declared, which needs rig-c 1.3.0 or later (an older rigc refuses
 *   the unknown invariant by name).
 *
 * Measured on the two public examples (rig-parts #13, `tools/idle_cost.ts`):
 * `direct` removes 31 of 72 bones (demo) and 24 of 56 (sample); every shown
 * mesh (8 and 6) has a driving bone whose world transform changes on every
 * idle frame under both, so the meshes a dirty-skip renderer could skip are 0
 * in both; and the per-frame pose time differs only in
 * `updateWorldTransform` (1.2 against 0.7 us on the demo), about 3 % of a
 * frame dominated by `computeWorldVertices`. The controls buy no renderer
 * work. `ctl` stays the default because the examples' expected `rig.json` and
 * `motion.json` are the reference implementation's output, and because the
 * declaration lives in the rig spec only: `rigc validate <build> --profile
 * spine-html`, which has no rig spec to read, refuses a `direct` build once
 * per keyed mesh bone.
 */
export const IDLE_KEYS = ['ctl', 'direct'] as const;
export type IdleKeys = (typeof IDLE_KEYS)[number];
export const DEFAULT_IDLE_KEYS: IdleKeys = 'ctl';

/**
 * `--idle-keys <value>` as `rig` and `build` both take it, or its default: one
 * reading for the two commands, so neither spells the flag its own way. A value
 * not in {@link IDLE_KEYS} is returned as the usage message naming the two.
 */
export function idleKeysOf(value: string | undefined): IdleKeys | string {
  const keys = value ?? DEFAULT_IDLE_KEYS;
  return (IDLE_KEYS as readonly string[]).includes(keys) ? (keys as IdleKeys) : `--idle-keys ${keys}; one of ${IDLE_KEYS.join(', ')} is required`;
}

export function isIdleKeys(v: IdleKeys | string): v is IdleKeys {
  return (IDLE_KEYS as readonly string[]).includes(v);
}

/**
 * The command that ran the rig stage, which the rig stage names when it tells
 * the author which flag to pass beside rigc's refusal of a pair a control
 * splits (`ctlRemedies`, src/build.ts): `rig` and `build` both take
 * `--idle-keys`, and the line has to name the one that was run. It changes no
 * byte the stage writes — only that line's text.
 */
export type RigCommand = 'rig' | 'build';

/** The `why` of the `invariants.idleDrivesMeshes` that `idleKeys: 'direct'` declares. */
export const IDLE_DRIVES_MESHES_WHY = 'painting rig: the idle is meant to deform the meshes it keys (rig-parts rig --idle-keys direct)';

/** One row of `mesh_report.json`: a lattice mesh's row is as it always was; a contour mesh's says so. */
export type MeshReport = LatticeMeshReport | ContourMeshReport | AutoMeshReport;

export interface LatticeMeshReport {
  part: string;
  vertices: number;
  triangles: number;
  hull: number;
  bones: string[];
  max_influences: number;
  mean_influences: number;
  art_coverage: number;
  grid: number;
  /** The distance rule's exponent the mesh declared (issue #161); absent when it declared none and ran at 2. */
  exponent?: number;
  /** Only under `rule: "heat"` (issue #161): the rule and the solve it ran. Absent otherwise, so a distance mesh writes the row it always wrote. */
  heat?: HeatRow;
}

/**
 * A contour mesh's row (issue #84): the lattice row's figures, then the mode,
 * the parameters it ran at, `src/contour.ts`'s report whole, and per region
 * the vertices its bone reaches (g > 0) and holds alone (g = 1).
 * `art_coverage` is over ALL the part's art, stray islands left out included,
 * so a mesh that leaves pixels undrawn does not read 1.
 */
export interface ContourMeshReport {
  part: string;
  vertices: number;
  triangles: number;
  hull: number;
  bones: string[];
  max_influences: number;
  mean_influences: number;
  art_coverage: number;
  mode: 'contour';
  /** The distance rule's exponent the mesh declared (issue #161); absent when it declared none and ran at 2. */
  exponent?: number;
  /** Only when the mesh declared ribs (issue #188): what it declared and what was placed. Absent otherwise, so a mesh without ribs writes the row it always wrote. */
  ribs?: RibsRow;
  params: { tolerance: number; margin: number; spacing: number; budget: number | null; stray: number | null };
  contour: ContourReport;
  regions: Array<{ name: string; bone: string; reached: number; whole: number }>;
  /** Only under `rule: "heat"` (issue #161), as the lattice row's. */
  heat?: HeatRow;
}

/**
 * A mesh's ribs as its row echoes them (issue #188): the stations each chain declared, the ribs placed (one per link
 * joint and station, chain by chain) and the vertices they hold, ends included. Each rib's own vertex list is in the
 * contour report's `ribs` (the source's, in the automatic mode).
 */
export interface RibsRow {
  chains: RibsSpec;
  count: number;
  vertices: number;
}

/** The row's echo of a mesh's ribs (issue #188). */
function ribsRow(spec: RibsSpec, placed: readonly ContourRib[]): RibsRow {
  return { chains: spec, count: placed.length, vertices: placed.reduce((n, r) => n + r.vertices.length, 0) };
}

/** What a declared `source.stray` cleared from an automatic part's art (issue #172): islands, their pixels, and the art they were part of. */
export interface StrayCleared {
  islands: number;
  pixels: number;
  art_pixels: number;
}

/**
 * An automatic mesh's row (issue #126, item 2): the lattice row's figures,
 * then the mode; `settings`, every number the call saw (the effective
 * settings, as rig-c echoes them, are also in the document); the source
 * — the contour mesh's own report and rig-c's counts of it — and the
 * result's counts; every residual, the worst one and the worst region; the
 * termination; what the weights lost to the 5-place rounding; per region the
 * source vertices its bone reaches and holds alone and the result vertices
 * bound to it; `deformation` (below); and the whole
 * `mesh-quality-report/1` document rig-c wrote — inside the row rather
 * than beside it, so the rig stage stays pure and one file holds every part's
 * evidence, as it does for the other modes. `art_coverage` is over alpha above
 * 8, the other modes' reading, of the art every reader of the mesh takes (under
 * a declared `source.stray`, the islands the trace left out are not in it —
 * `stray_cleared`); the threshold-1 coverage is a residual.
 */
export interface AutoMeshReport {
  part: string;
  vertices: number;
  triangles: number;
  hull: number;
  bones: string[];
  max_influences: number;
  mean_influences: number;
  art_coverage: number;
  mode: 'auto';
  /** The distance rule's exponent the mesh declared (issue #161); absent when it declared none and ran at 2. */
  exponent?: number;
  /** Only when the mesh declared ribs (issue #188), as the contour row's; `vertices` counts the source's, which the reduction keeps. */
  ribs?: RibsRow;
  settings: {
    threshold: number;
    source: { tolerance: number; margin: number; spacing: number; stray: number | null };
    sourceBounds: { minCoverage: number; maxOvershoot: number | null; maxUndercut: number | null };
    targets: { artFit: { minCoverage: number; maxOvershoot: number | null; maxUndercut: number | null }; maxBoundaryDeviation: number; minAngle: number | null };
    protect: { hull: boolean; vertices: number[]; edges: Array<[number, number]>; regionBoundaries: string[]; weightJump: number | null; influences: string[] };
    influences: { maxInfluences: number; minWeight: number };
    budget: { maxCandidates: number };
    minArtSamples: number;
    /** A density-only region (issue #155) echoes `bone` and `band` as null: it declares neither. */
    regions: Array<{ name: string; bone: string | null; band: number | null; maxEdgeLength: number; transition: number; grade: number; minArtSamples: number; approximation: { from: string; policy: string; maxError: number } | null }>;
    preset: null;
    /** The amplitude rig-c read and echoed (`effective.motionAmplitude`), after the opt-ins; absent when none was sent. */
    motionAmplitude?: MotionAmplitude;
  } & StageBOptIns;
  source: { contour: ContourReport; counts: MeshCounts | null };
  /**
   * Only on a part whose author declared `source.stray` (issue #172): the islands the trace left out and their pixels,
   * cleared from the art every reader of the mesh takes (the reduction, its source bounds, `art_coverage`, the motion
   * gate), against `art_pixels` — the part's art at alpha 1 and above with those islands counted in. Zero islands
   * when the declaration left nothing out. Absent without the declaration, so such a part writes the row it always wrote.
   */
  stray_cleared?: StrayCleared;
  /** The counts; with a Stage B opt-in set, `boundary_runs` and `retriangulation` after them (`stageBResult`), each only when its opt-in is. */
  result: { counts: MeshCounts; removedVertices: number; insertedVertices: number } & StageBResult;
  residuals: Residual[];
  worst_residual: (Residual & { used: number }) | null;
  worst_region: string | null;
  /**
   * The motion amplitude rig-c's `MQ_ALLOCATION_CONTRAST` and `MQ_DEFORM_LOAD`
   * read (issue #126 Q2; `src/autoamplitude.ts`): `sent` when every track term
   * was derived from the idle and the amplitude — with the author's
   * `motion.gradation`, or null — handed to `reduceMesh` and to the motion
   * gate's comparison, and otherwise each term that stopped it, by path — so a
   * reader of the two rows' `not-measurable` learns which number is missing.
   */
  motion_amplitude: AmplitudeRow;
  /**
   * Only on a part whose author set `motion.residual` (issue #126, rig-c 2.31.0, rigc#1295; `src/autoenvelope.ts`):
   * the envelope sent and the written mesh's `MQ_SKINNING_RESIDUAL` against its bound, or every stop that left the
   * residual not measurable — the veto then not applied. A pose-free bound, not the motion verdict. Absent otherwise,
   * so a part without the field writes the row it always wrote.
   */
  skinning_residual?: ResidualRow;
  termination: Termination;
  weights: { sharesDroppedOnGrid: number; sharesPruned: number; droppedAtFivePlaces: number };
  /** A density-only region (issue #155): `bone` null, and 0 vertices reached, whole and bound — it weights nothing. */
  regions: Array<{ name: string; bone: string | null; reached: number; whole: number; bound_in_result: number }>;
  /**
   * Only on a part whose full reduction the motion gate refused and whose
   * acceptance loop wrote a replayed step instead (`src/autoreplay.ts`): the
   * search — N, I, the step chosen, the replays and the candidates they tried,
   * every probe, and the chosen step's selection and held-out readings. The
   * row's other fields are then that step's (its `termination` is
   * `replayed-to-accepted-step`). Absent on every other row, so a part the
   * gate accepted outright writes the row it always wrote. With the author's
   * `motion.selection` (issue #148) it is the multi-interval search's row,
   * which says `policy` and carries the tested set, the passing and untested
   * intervals, the chosen counts, the termination and the roles.
   */
  replay?: ReplayRow | MultiIntervalRow;
  /**
   * {@link DEFORMATION_UNMEASURED} as `buildRig` writes the row — it measures
   * geometry alone; the rig stage replaces it with the motion gate's rows
   * (`src/automotion.ts`) before anything is written, and adds
   * `motion_report`, rig-c's whole `compare` document, after
   * `quality_report`. A written row never says unmeasured: a part whose motion
   * was not measured and passed is refused.
   */
  deformation: string | MotionDeformation;
  /** Only under `rule: "heat"` (issue #161): the rule and the solve the source's weights came from. */
  heat?: HeatRow;
  quality_report: unknown;
  motion_report?: unknown;
}

export interface RigOutput {
  rig: RigSpec;
  motion: MotionSpec;
  meshReport: MeshReport[];
  /** The padded images, by file name (`<part>.png`), in parts.json order. */
  images: Array<[string, Raster]>;
  /** The bones that got a `<bone>_ctl`, sorted; empty under `idleKeys: 'direct'`. */
  controls: string[];
  /** The idle-keyed bones some mesh is weighted to, sorted — the bones `ctl` moves the keys off, and `direct` keys in place. */
  meshKeyed: string[];
  idleKeys: IdleKeys;
  /** The one-loop passes each mesh took, for the printed report. */
  loopPasses: Record<string, number>;
  /** Per automatic mesh, in parts.json order: what the rig stage's motion gate compares (`src/automotion.ts`). Nothing written. */
  autoMotion: AutoMotionCase[];
}

/**
 * `RIG_BLINK_HOLD_SPANS_A_FRAME` (issue #32): the eyes' hold must put an
 * idle frame inside the closed window for every `blink.t`, or the idle
 * frames, the contact sheet and the loop show a blink that never closes. The
 * three numbers are the tree's own constants (`BLINK.shut`, `BLINK.hold`,
 * `IDLE_FPS`), which the rig stage passes on every build that has a blink;
 * they are parameters so the refusal can be planted without editing them.
 */
export function blinkHoldProblems(shut: number, hold: number, fps: number): Problem[] {
  const m = blinkHoldMisses(shut, hold, fps);
  if (m.misses === 0) return [];
  return [
    {
      code: 'RIG_BLINK_HOLD_SPANS_A_FRAME',
      object: 'BLINK.hold (src/motion.ts)',
      detail:
        `is ${hold} s; the idle is rendered at IDLE_FPS = ${fps}, a frame every ${pyRound(1 / fps, 6)} s, so the closed window [t + ${shut}, t + ${pyRound(shut + hold, 6)}] s holds no frame ` +
        `for ${m.misses} of the ${m.phases} phases a 6-decimal blink.t takes against the frame grid (the first at t = ${m.first} s), and the idle frames and the loop show no closed eye there; ` +
        `a hold of at least one frame, 1/${fps} s, is required`,
    },
  ];
}

/** The slot, attachment and image name suffix of a `motion.blink.still` part's upper piece. */
export const STILL_SUFFIX = '_still';

/** Pixels with alpha above 0 in rows [y0, y1) of `img`. */
function alphaCount(img: Raster, y0: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4 + 3] > 0) n++;
  return n;
}

function same(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function pt(p: Point): string {
  return `[${p[0]}, ${p[1]}]`;
}

/**
 * Build the rig. `images` holds every parts.json part's PNG by part name.
 * Every problem found is thrown at once, as one `PartsError`. `reduce` runs each
 * automatic part's reduction, `runReduction` unless a caller hands one that
 * reuses a reduction it already ran on the same input (issue #135).
 */
export function buildRig(
  cfg: CharacterConfig,
  parts: PartsFile,
  images: ReadonlyMap<string, Raster>,
  maxLoopPasses: number = ONE_LOOP_PASSES,
  idleKeys: IdleKeys = DEFAULT_IDLE_KEYS,
  reduce: Reducer = runReduction,
): RigOutput {
  const problems: Problem[] = [];
  const fail = (code: string, object: string, detail: string): void => {
    problems.push({ code, object, detail });
  };
  const [W, H] = parts.rig_size;
  const CX = W / 2;
  const byPart = new Map(parts.parts.map((p) => [p.name, p]));

  // ---- bones -------------------------------------------------------------
  const B = new Map<string, Bone>();
  B.set(ROOT_BONE, { name: ROOT_BONE, parent: null, x: CX, y: H });
  const tips = new Map<string, Point>();
  const child = new Map<string, Point>();
  const chains = new Map<string, string[]>();
  /** Each chain's points and tip, rig px, as declared (issue #188: the ribs are placed along them). */
  const chainLines = new Map<string, Point[]>();
  cfg.bones.forEach((e: BoneEntry, i) => {
    if ('chain' in e) {
      const names: string[] = [];
      const polyline = [...e.points, e.tip];
      if (e.points.length < 1) {
        fail('RIG_CHAIN_POINTS', `config.bones[${i}] chain "${e.chain}"`, `has ${e.points.length} point(s) and a tip; at least one point and a tip — 2 points — are required to make a link`);
      }
      for (let k = 0; k + 1 < polyline.length; k++) {
        if (same(polyline[k], polyline[k + 1])) {
          fail(
            'RIG_CHAIN_POINTS',
            `config.bones[${i}] chain "${e.chain}" link ${k}`,
            `runs from ${pt(polyline[k])} to ${k + 1 < e.points.length ? `points[${k + 1}]` : 'the tip'} ${pt(polyline[k + 1])}, the same point — the chain has fewer than 2 distinct points along that link, so the link has no direction to weight along; each link must end at a point other than its origin`,
          );
        }
      }
      e.points.forEach(([x, y], k) => {
        const n = `${e.chain}${k}`;
        B.set(n, { name: n, parent: k === 0 ? e.parent : names[names.length - 1], x, y });
        if (names.length > 0) child.set(names[names.length - 1], [x, y]);
        names.push(n);
      });
      if (names.length > 0) tips.set(names[names.length - 1], [e.tip[0], e.tip[1]]);
      chains.set(e.chain, names);
      chainLines.set(e.chain, polyline);
    } else {
      B.set(e.name, { name: e.name, parent: e.parent, x: e.at[0], y: e.at[1] });
      if (e.tip !== undefined) tips.set(e.name, [e.tip[0], e.tip[1]]);
    }
  });

  // ---- segments ----------------------------------------------------------
  const seg = (bone: string, at: string): Segment | null => {
    const b = B.get(bone);
    if (b === undefined) {
      fail('RIG_NAME_RESOLVES', at, `names the bone "${bone}", which config.bones does not declare`);
      return null;
    }
    const end = child.get(bone) ?? tips.get(bone);
    if (end === undefined) {
      fail(
        'RIG_SEGMENT_DEFINED',
        at,
        `names the bone "${bone}", which has no tip and no next chain link, so it has an origin and no segment; give config.bones "${bone}" a "tip", or write the segment out as ["${bone}", [x0, y0], [x1, y1]]`,
      );
      return null;
    }
    return { bone, a: [b.x, b.y], b: end };
  };
  const meshSegments = new Map<string, Segment[]>();
  for (const [part, m] of Object.entries(cfg.meshes)) {
    if ('contour' in m) {
      (m.contour.regions ?? []).forEach((rg, i) => {
        if (!B.has(rg.bone)) fail('RIG_NAME_RESOLVES', `config.meshes.${part}.contour.regions[${i}].bone`, `names the bone "${rg.bone}", which config.bones does not declare`);
      });
    }
    if ('auto' in m) {
      (m.auto.regions ?? []).forEach((rg, i) => {
        if (weightsABone(rg) && !B.has(rg.bone)) fail('RIG_NAME_RESOLVES', `config.meshes.${part}.auto.regions[${i}].bone`, `names the bone "${rg.bone}", which config.bones does not declare`);
      });
    }
    const out: Segment[] = [];
    m.segments.forEach((sp, i) => {
      const at = `config.meshes.${part}.segments[${i}]`;
      if (typeof sp === 'string') {
        const links = chains.get(sp);
        if (links !== undefined) {
          for (const l of links) {
            const s = seg(l, `${at} (chain "${sp}" link "${l}")`);
            if (s !== null) out.push(s);
          }
        } else {
          const s = seg(sp, at);
          if (s !== null) out.push(s);
        }
      } else {
        if (!B.has(sp[0])) fail('RIG_NAME_RESOLVES', `${at}[0]`, `names the bone "${sp[0]}", which config.bones does not declare`);
        else out.push({ bone: sp[0], a: [sp[1][0], sp[1][1]], b: [sp[2][0], sp[2][1]] });
      }
    });
    meshSegments.set(part, out);
  }

  // ---- parts ↔ config ----------------------------------------------------
  const where = (part: string): string => `parts.json holds ${parts.parts.length} part(s): ${parts.parts.map((p) => p.name).join(', ')}`;
  for (const part of Object.keys(cfg.meshes)) if (!byPart.has(part)) fail('RIG_PART_PRESENT', `config.meshes.${part}`, `names the part "${part}", which is not in parts.json; ${where(part)}`);
  for (const [part, bone] of Object.entries(cfg.regions)) {
    if (!byPart.has(part)) fail('RIG_PART_PRESENT', `config.regions.${part}`, `names the part "${part}", which is not in parts.json; ${where(part)}`);
    if (!B.has(bone)) fail('RIG_NAME_RESOLVES', `config.regions.${part}`, `names the bone "${bone}", which config.bones does not declare`);
  }
  for (const p of parts.parts) {
    const inM = p.name in cfg.meshes;
    const inR = p.name in cfg.regions;
    if (!inM && !inR) fail('RIG_PART_ATTACHED', `part "${p.name}"`, 'is in parts.json and has neither a config.meshes nor a config.regions entry; exactly one is required');
    if (inM && inR) fail('RIG_PART_ATTACHED', `part "${p.name}"`, 'has both a config.meshes and a config.regions entry; exactly one is required');
    else if (inM && readFrom(p.from)?.run === PAINTING_RUN) {
      fail('RIG_PART_ATTACHED', `part "${p.name}"`, `is a painting patch (${p.from}) and has a config.meshes entry; a patch is a region — config.regions.${p.name} names its bone`);
    }
    const img = images.get(p.name);
    if (img === undefined) fail('RIG_PNG_PRESENT', `part "${p.name}"`, `has no parts/${p.name}.png`);
    else if (img.width !== p.w || img.height !== p.h) {
      fail('RIG_PNG_MATCHES_BOX', `part "${p.name}"`, `parts/${p.name}.png is ${img.width}x${img.height}; parts.json's box is ${p.w}x${p.h}`);
    }
  }

  // ---- motion ------------------------------------------------------------
  const bl = cfg.motion.blink;
  const span = bl === undefined ? 0 : blinkSpan(bl);
  if (bl !== undefined && !(bl.t > 0 && bl.t + span < cfg.motion.duration)) {
    fail(
      'RIG_BLINK_INSIDE_IDLE',
      'config.motion.blink.t',
      `is ${bl.t} s; the blink's keys run from t to t + ${pyRound(span, 6)} s between the idle's first key at 0 and its last at ${cfg.motion.duration} s, so 0 < t < ${pyRound(cfg.motion.duration - span, 6)} is required`,
    );
  }
  if (bl !== undefined) problems.push(...blinkHoldProblems(BLINK.shut, BLINK.hold, IDLE_FPS));
  // ---- blink.still: a blinking region cut at a row ----------------------
  const stills = bl?.still ?? {};
  const partNames = new Set(parts.parts.map((p) => p.name));
  for (const [part, st] of Object.entries(stills)) {
    const at = `config.motion.blink.still.${part}`;
    const p = byPart.get(part);
    if (!(part in cfg.regions)) fail('RIG_NAME_RESOLVES', at, `names "${part}", which config.regions does not attach; a region part is required`);
    if (!B.has(st.bone)) fail('RIG_NAME_RESOLVES', `${at}.bone`, `names the bone "${st.bone}", which config.bones does not declare`);
    if (p === undefined) continue;
    const still = `${part}${STILL_SUFFIX}`;
    if (partNames.has(still)) fail('RIG_STILL_NAME_FREE', at, `the still piece is drawn by the slot "${still}", and parts.json already holds a part of that name; rename that part`);
    if (!(st.row > p.y && st.row < p.y + p.h)) {
      fail('RIG_STILL_ROW_INSIDE_PART', `${at}.row`, `is ${st.row}; "${part}" spans rows ${p.y}..${p.y + p.h - 1}, so a row with part rows on both sides, ${p.y + 1}..${p.y + p.h - 1}, is required`);
      continue;
    }
    const img = images.get(part);
    if (img === undefined || img.width !== p.w || img.height !== p.h) continue;
    const r = st.row - p.y;
    const crossing: number[] = [];
    for (let x = 0; x < img.width; x++) if (img.data[(r * img.width + x) * 4 + 3] > 0) crossing.push(x);
    if (crossing.length > 0) {
      fail(
        'RIG_STILL_ROW_CLEAR',
        `${at}.row`,
        `is ${st.row}, and "${part}" has ${crossing.length} pixel(s) with alpha above 0 on that row (the first at x = ${p.x + crossing[0]}); a row with no art across the part's whole width is required — two pieces cut through art are each resampled against their own transparent edge, so the render changes at rest, not only while the eye moves`,
      );
      continue;
    }
    const artAbove = alphaCount(img, 0, r);
    const artBelow = alphaCount(img, r, img.height);
    if (artAbove === 0 || artBelow === 0) {
      fail('RIG_STILL_PIECES_HAVE_ART', `${at}.row`, `is ${st.row}; "${part}" has ${artAbove} art pixel(s) above it and ${artBelow} below; both pieces need art, or the cut holds nothing still (or nothing blinks)`);
    }
  }
  refuseIfAny(problems);

  const motion = idleMotion(cfg, chains);
  const meshBones = new Set<string>();
  for (const segs of meshSegments.values()) for (const s of segs) meshBones.add(s.bone);
  // A contour region's control bone is weighted to like a segment's bone (issue #84), so the idle's keys on it move
  // to its control under `ctl` as theirs do. A config with no contour region adds nothing here.
  for (const m of Object.values(cfg.meshes)) if ('contour' in m) for (const rg of m.contour.regions ?? []) meshBones.add(rg.bone);
  for (const m of Object.values(cfg.meshes)) if ('auto' in m) for (const rg of m.auto.regions ?? []) if (weightsABone(rg)) meshBones.add(rg.bone);
  const meshKeyed = controlledBones(motion, meshBones);
  const controls = idleKeys === 'ctl' ? meshKeyed : [];
  for (const k of controls) {
    const ctl = `${k}${CONTROL_SUFFIX}`;
    if (B.has(ctl)) {
      fail('RIG_CONTROL_NAME_FREE', `bone "${k}"`, `is keyed by the idle and weighted to by a mesh, so it needs the control bone "${ctl}", and config.bones already declares a bone of that name`);
    }
  }
  // A two-bone ik over a link and its child link stops being one when the
  // child gets a control: `<child>_ctl` stands between them. rig-c 2.15.0
  // refuses that pair by name (issue #103); the rig stage adds the flag to
  // rigc's line (`ctlRemedies`, src/build.ts).
  refuseIfAny(problems);
  for (const k of controls) {
    const b = B.get(k) as Bone;
    const ctl = `${k}${CONTROL_SUFFIX}`;
    B.set(ctl, { name: ctl, parent: b.parent, x: b.x, y: b.y });
    B.set(k, { ...b, parent: ctl });
  }
  moveKeysToControls(motion, controls);
  // Parents first: a depth-first walk over the table in insertion order, each
  // bone after its parent — which puts every control directly above its bone.
  const ordered: Bone[] = [];
  const done = new Set<string>();
  const visit = (n: string): void => {
    if (done.has(n)) return;
    const b = B.get(n) as Bone;
    if (b.parent !== null) visit(b.parent);
    done.add(n);
    ordered.push(b);
  };
  for (const n of B.keys()) visit(n);

  const spineX = (x: number): number => x - CX;
  const spineY = (y: number): number => cropToSpineY(y, H);

  // ---- direction: every chain link points along its chain (issue #73) ----
  // From the link's origin to the next link's, the last link to the chain's
  // tip, in Spine's axes; a link's control (same origin) points the same way.
  const aim = new Map<string, { rotation: number; length: number }>();
  for (const links of chains.values()) {
    for (const l of links) {
      const b = B.get(l) as Bone;
      const end = (child.get(l) ?? tips.get(l)) as Point;
      const dx = spineX(end[0]) - spineX(b.x);
      const dy = spineY(end[1]) - spineY(b.y);
      const a = { rotation: (Math.atan2(dy, dx) * 180) / Math.PI, length: pyRound(Math.sqrt(dx * dx + dy * dy), 3) };
      aim.set(l, a);
      if (controls.includes(l)) aim.set(`${l}${CONTROL_SUFFIX}`, a);
    }
  }
  // Each bone's local rotation turns it from its parent's world rotation to
  // the one it should have: its chain's direction, or 0 for every other bone,
  // so a named bone under a chain link is turned back upright. `turn` is the
  // world rotation as written, the sum of the written local rotations down the
  // tree. Each local offset is the bone's origin carried into its parent's
  // setup frame as written, through rigc's inverse (`src/coords.ts`).
  const turn = new Map<string, number>();
  const bones: RigBone[] = [];
  for (const b of ordered) {
    if (b.parent === null) {
      bones.push({ name: b.name, x: 0, y: 0 });
      turn.set(b.name, 0);
      continue;
    }
    const up = turn.get(b.parent) as number;
    const a = aim.get(b.name);
    const rotation = places(normaliseDegrees((a?.rotation ?? 0) - up));
    turn.set(b.name, places(up + rotation));
    const frame = computeExactFrameTransforms(bones).get(b.parent) as BoneTransform;
    const [x, y] = toBoneLocal(frame, spineX(b.x), spineY(b.y));
    bones.push({ name: b.name, parent: b.parent, ...(a === undefined ? {} : { length: a.length }), ...(a !== undefined || rotation !== 0 ? { rotation } : {}), x: places(x), y: places(y) });
  }
  const world = computeExactFrameTransforms(bones);

  // ---- keys a turned frame would change ----------------------------------
  // A rotate key turns a bone about its origin whatever its frame, so the
  // idle's chain sways mean what they meant. A translate key moves a bone
  // along its parent's axes and a scale or shear key stretches it along its
  // own: on a turned frame those are other directions than the config wrote.
  const keyFrame: Array<{ bone: string; prop: string; at: string }> = [];
  cfg.motion.tracks.forEach((tr, i) => {
    if (!('chain' in tr)) keyFrame.push({ bone: tr.bone, prop: tr.prop, at: `config.motion.tracks[${i}]` });
  });
  bl?.eyes.forEach((m, i) => keyFrame.push({ bone: m, prop: 'scaley', at: `config.motion.blink.eyes[${i}]` }));
  if (bl?.brow_drop !== undefined) bl.brows?.forEach((m, i) => keyFrame.push({ bone: m, prop: 'translatey', at: `config.motion.blink.brows[${i}]` }));
  for (const k of keyFrame) {
    if (k.prop === 'rotate') continue;
    const own = B.get(k.bone) as Bone;
    const parent = (controls.includes(k.bone) ? (B.get(`${k.bone}${CONTROL_SUFFIX}`) as Bone).parent : own.parent) as string;
    const translate = k.prop.startsWith('translate');
    const frameBone = translate ? parent : k.bone;
    const deg = turn.get(frameBone) as number;
    if (deg === 0) continue;
    const axis = k.prop.slice(-1);
    fail(
      'RIG_KEY_FRAME_UNTURNED',
      `${k.at} (bone "${k.bone}", ${k.prop})`,
      translate
        ? `moves "${k.bone}" along the axes of its parent "${parent}", which is turned ${deg} degrees to point along its chain (issue #73), so the key would move it along that turned axis and not along the picture's ${axis}; a translate key is allowed only on a bone whose parent is not turned — key the chain's own parent, or key rotate`
        : `stretches "${k.bone}" along its own axes, and "${k.bone}" is turned ${deg} degrees to point along its chain (issue #73), so the key would stretch it along that turned axis and not along the picture's ${axis}; a scale or shear key is allowed only on a bone that is not turned — key the chain's own parent, or key rotate`,
    );
  }
  refuseIfAny(problems);

  // ---- attachments -------------------------------------------------------
  const slots: RigSpec['slots'] = [];
  const skin: RigSpec['skins']['default'] = {};
  const meshReport: MeshReport[] = [];
  const outImages: Array<[string, Raster]> = [];
  const loopPasses: Record<string, number> = {};
  const autoMotion: AutoMotionCase[] = [];
  // A region's centre in its bone's setup frame; on a turned bone the image
  // is turned back by the bone's world rotation, so it is drawn upright.
  const region = (image: string, bone: string, cx: number, cy: number): RegionAttachment => {
    const [x, y] = toBoneLocal(world.get(bone) as BoneTransform, spineX(cx), spineY(cy));
    const deg = turn.get(bone) as number;
    return deg === 0 ? { image, x: places(x), y: places(y) } : { image, x: places(x), y: places(y), rotation: places(normaliseDegrees(-deg)) };
  };
  // issue #188: the chains a mesh declared ribs on, in the order its segments name them, each chain's points and tip
  // carried into the part image by the same translation as every other position. No ribs declared, none.
  const chainRibs = (segments: ReadonlyArray<string | readonly [string, Point, Point]>, ribs: RibsSpec | undefined, ox: number, oy: number): ContourChainRibs[] => {
    if (ribs === undefined) return [];
    const named = [...new Set(segments.filter((sp): sp is string => typeof sp === 'string'))];
    return named.flatMap((chain) => {
      const line = chainLines.get(chain);
      const declared = ribs[chain];
      if (line === undefined || declared === undefined) return [];
      return [{ chain, points: line.map(([x, y]) => [x - ox, y - oy] as [number, number]), stations: declared.stations }];
    });
  };
  // A contour mesh (issue #84): `src/contour.ts` over the padded image, every refusal collected with the others;
  // the weights by `src/localweights.ts`; slot, uvs, bind positions and by-name weights written as the lattice's.
  // The config's region numbers are rig px; the part image's are rig px less (p.x − PAD, p.y − PAD) — a
  // translation, so every length (tolerance, margin, spacing, band, r) is the same number in both.
  const contourAttachment = (
    p: PartsFile['parts'][number],
    img: Raster,
    file: string,
    spec: ContourSpec,
    r: number,
    exponent: number | undefined,
    segs: Segment[],
    rule: WeightRule,
    ribSpec: { segments: ReadonlyArray<string | readonly [string, Point, Point]>; ribs?: RibsSpec },
    out: Problem[],
  ): { attachment: MeshAttachment; report: ContourMeshReport } | null => {
    const ox = p.x - PAD;
    const oy = p.y - PAD;
    const w = img.width;
    const h = img.height;
    const alpha = new Uint8Array(w * h);
    for (let i = 0; i < alpha.length; i++) alpha[i] = img.data[i * 4 + 3];
    const regions = spec.regions ?? [];
    const inPart: ContourRegion[] = regions.map((rg) =>
      rg.shape === 'circle'
        ? { name: rg.name, shape: 'circle', cx: rg.cx - ox, cy: rg.cy - oy, r: rg.r, spacing: rg.spacing, band: rg.band }
        : { name: rg.name, shape: 'polygon', points: rg.points.map(([x, y]) => [x - ox, y - oy] as [number, number]), spacing: rg.spacing, band: rg.band },
    );
    const ribs = chainRibs(ribSpec.segments, ribSpec.ribs, ox, oy);
    const cm = contourMesh(p.name, { width: w, height: h, alpha }, { threshold: ART_ALPHA, tolerance: spec.tolerance, margin: spec.margin, spacing: spec.spacing, budget: spec.budget, stray: spec.stray, regions: inPart, ...(ribs.length === 0 ? {} : { ribs }) });
    if (Array.isArray(cm)) {
      out.push(...cm);
      return null;
    }
    // issue #161: under rule "heat", the field over the silhouette the outline was traced from (art above 8, holes
    // filled, grown by the margin), and every vertex's segment shares read off it instead of the distance rule.
    const heat = rule === 'heat' ? boneHeat(`config.meshes.${p.name}`, tracedSilhouette(cm.mask, ART_ALPHA, spec.margin), segs, ox, oy) : null;
    if (Array.isArray(heat)) {
      out.push(...heat);
      return null;
    }
    const weights: WeightEntry[][] = [];
    const reached = regions.map(() => 0);
    const whole = regions.map(() => 0);
    let infl = 0;
    let maxInfl = 0;
    let overlapped = false;
    cm.vertices.forEach(([vx, vy], vi) => {
      const wx = vx + ox;
      const wy = vy + oy;
      const li = localInfluences([wx, wy], segs, r, regions, DEFAULT_LIMITS, exponent ?? DISTANCE_EXPONENT, heat === null ? undefined : heatInfluences(heat, [vx, vy], DEFAULT_LIMITS));
      if ('first' in li) {
        if (!overlapped) {
          out.push({
            code: 'RIG_CONTOUR_REGIONS_OVERLAP',
            object: `config.meshes.${p.name}.contour.regions`,
            detail: `vertex ${vi} at rig (${wx}, ${wy}) takes weight ${pyRound(li.g1, 5)} from region "${regions[li.first].name}" and ${pyRound(li.g2, 5)} from region "${regions[li.second].name}"; each vertex may be reached by one region's falloff (its region and band) — move the regions apart or narrow a band`,
          });
        }
        overlapped = true;
        return;
      }
      if (li.region >= 0) {
        reached[li.region]++;
        if (li.g >= 1) whole[li.region]++;
      }
      const shares = writtenShares(li);
      const ent: WeightEntry[] = shares.map(({ bone, weight }) => {
        const [x, y] = toBoneLocal(world.get(bone) as BoneTransform, spineX(wx), spineY(wy));
        return { bone, x: places(x), y: places(y), weight };
      });
      weights.push(ent);
      infl += ent.length;
      maxInfl = Math.max(maxInfl, ent.length);
    });
    if (overlapped) return null;
    const uvs: number[] = [];
    for (const [x, y] of cm.vertices) uvs.push(pyRound(x / w, 6), pyRound(y / h, 6));
    const bones = new Set(segs.map((s) => s.bone));
    for (const rg of regions) bones.add(rg.bone);
    const rep = cm.report;
    return {
      attachment: { type: 'mesh', image: file, width: w, height: h, uvs, triangles: cm.triangles, hull: cm.hull, weights },
      report: {
        part: p.name,
        vertices: cm.vertices.length,
        triangles: cm.triangles.length / 3,
        hull: cm.hull,
        bones: [...bones].sort(),
        max_influences: maxInfl,
        mean_influences: pyRound(infl / cm.vertices.length, 2),
        art_coverage: pyRound(rep.coveredArtPixels / (rep.artPixels + rep.strayPixels), 5),
        mode: 'contour',
        ...(exponent === undefined ? {} : { exponent }),
        ...(ribSpec.ribs === undefined ? {} : { ribs: ribsRow(ribSpec.ribs, cm.ribs ?? []) }),
        params: { tolerance: spec.tolerance, margin: spec.margin, spacing: spec.spacing, budget: spec.budget ?? null, stray: spec.stray ?? null },
        contour: rep,
        regions: regions.map((rg, k) => ({ name: rg.name, bone: rg.bone, reached: reached[k], whole: whole[k] })),
        ...(heat === null ? {} : { heat: heatRow(heat) }),
      },
    };
  };
  // An automatic mesh (issue #126, item 2): the contour source at alpha 1 and above, rig-c's reduceMesh, and
  // the result used only when accepted (`src/automesh.ts`). Its weights are rig-c's by name — a survivor's are
  // the source's bit for bit, an inserted vertex's interpolated — rounded by roundShares (the author's minWeight
  // replaces the 0.03 floor that makes the lattice's rounding safe, so every vertex closes on its heaviest entry)
  // and bound exactly as a contour vertex is.
  const boneOrder = bones.map((b) => b.name);
  // What the amplitude derivation reads (src/autoamplitude.ts), named here because autoAttachment's own `bones` and `motion` shadow them.
  const rigBones = bones;
  const idle = motion;
  // Each bone's setup joint in crop px (src/autoenvelope.ts reads it as the pivot of the skinning envelope), off the
  // rig's bones as written: x back across the root, y through the one door — cropToSpineY is its own inverse (y ↦ H − y).
  const joints = new Map<string, readonly [number, number]>(bones.map((b) => {
    const m = world.get(b.name) as BoneTransform;
    return [b.name, [m.worldX + CX, cropToSpineY(m.worldY, H)] as const];
  }));
  const autoAttachment = (
    p: PartsFile['parts'][number],
    img: Raster,
    file: string,
    spec: AutoSpec,
    r: number,
    exponent: number | undefined,
    segs: Segment[],
    rule: WeightRule,
    ribSpec: { segments: ReadonlyArray<string | readonly [string, Point, Point]>; ribs?: RibsSpec },
    out: Problem[],
  ): { attachment: MeshAttachment; report: AutoMeshReport; motion: AutoMotionCase } | null => {
    const ox = p.x - PAD;
    const oy = p.y - PAD;
    const w = img.width;
    const h = img.height;
    const alpha = new Uint8Array(w * h);
    for (let i = 0; i < alpha.length; i++) alpha[i] = img.data[i * 4 + 3];
    const mask = { width: w, height: h, alpha };
    const object = `config.meshes.${p.name}.auto`;
    const regions = spec.regions ?? [];
    const source = autoSource(p.name, mask, spec, chainRibs(ribSpec.segments, ribSpec.ribs, ox, oy));
    if (Array.isArray(source)) {
      out.push(...source.map((q) => ({ ...q, detail: `${q.detail} (the automatic mode's source, at alpha ${AUTO_THRESHOLD} and above)` })));
      return null;
    }
    // One mask for every reader of the part (issue #172): under a declared `source.stray` the islands the trace left
    // out are cleared from the art the reduction, its source bounds, the coverage and the motion gate read — the mask
    // `contourMesh` traced. Nothing left out, it is `mask` itself, so a part without stray reads what it always read.
    // The image written for the part is not touched (the reason is in docs/AUTHORING.md's `stray` row).
    const art = source.mask;
    // issue #161: under rule "heat", the field over the silhouette the source was traced from (the same mask, at the
    // automatic mode's alpha 1 and above, holes filled, grown by source.margin).
    const heat = rule === 'heat' ? boneHeat(`config.meshes.${p.name}`, tracedSilhouette(art, AUTO_THRESHOLD - 1, spec.source.margin), segs, ox, oy) : null;
    if (Array.isArray(heat)) {
      out.push(...heat);
      return null;
    }
    const sw = sourceWeights(source.vertices, ox, oy, segs, r, spec, exponent ?? DISTANCE_EXPONENT, heat);
    if ('overlap' in sw) {
      out.push({
        code: 'RIG_CONTOUR_REGIONS_OVERLAP',
        object: `${object}.regions`,
        detail: `source vertex ${sw.vertex} at rig (${sw.at[0]}, ${sw.at[1]}) takes weight ${pyRound(sw.overlap.g1, 5)} from region "${regions[sw.overlap.first].name}" and ${pyRound(sw.overlap.g2, 5)} from region "${regions[sw.overlap.second].name}"; each vertex may be reached by one region's falloff (its region and band) — move the regions apart or narrow a band`,
      });
      return null;
    }
    // rig-c's allocation rows read an amplitude this package derives from its own idle (issue #126 Q2), with the
    // author's gradation or null (rig-c 2.29.0, rigc#1291); sent whenever every track term is derived
    // (src/autoamplitude.ts). The same amplitude goes on the motion gate's comparison (src/automotion.ts).
    const amplitude = partAmplitude({ bones: rigBones, motion: idle, constraints: cfg.constraints?.length ?? 0 }, sw.weights, spec.motion);
    // issue #126 (rig-c 2.31.0, rigc#1295): the skinning residual as a per-step veto, only when the author set
    // motion.residual — its envelope derived from the same idle (src/autoenvelope.ts), the reference the lowest common
    // ancestor of the slot's bone and every bound bone (issue #165; the slot's bone itself when every bound bone hangs
    // below it, Q4). A part whose envelope stops is sent nothing: the veto is not applied and the comparison decides alone.
    const residualSpec = spec.motion?.residual;
    const envelope = residualSpec === undefined ? null : slotEnvelope({ bones: rigBones, joints, motion: idle, constraints: cfg.constraints ?? [] }, segs[0].bone, sw.weights.flatMap((v) => v.map((e) => e.bone)), [ox, oy]);
    const input: MeshReductionInput = withSkinning(withAmplitude(autoReductionInput({ part: p.name, mask: art, ox, oy, spec, source, weights: sw.weights, boneOrder }), amplitude), envelope?.derivation ?? null, residualSpec?.maxResidual);
    const ran = reduce(object, input);
    if ('code' in ran) {
      out.push(ran);
      return null;
    }
    const verdict = autoVerdict(object, ran);
    if (!verdict.accepted) {
      out.push(verdict.problem);
      return null;
    }
    // One binding for the result and for the source the motion gate compares it with: rounded by roundShares, bound in each bone's frame.
    const bind = (points: ReadonlyArray<readonly [number, number]>, lists: ReadonlyArray<ReadonlyArray<{ bone: string; weight: number }>>) => {
      const weights: WeightEntry[][] = [];
      let infl = 0;
      let maxInfl = 0;
      let droppedAtFivePlaces = 0;
      const boundTo = regions.map(() => 0);
      points.forEach(([vx, vy], vi) => {
        const wx = vx + ox;
        const wy = vy + oy;
        const list = lists[vi];
        const shares = roundShares(list);
        droppedAtFivePlaces += list.length - shares.length;
        regions.forEach((rg, k) => {
          if (weightsABone(rg) && shares.some((s) => s.bone === rg.bone)) boundTo[k]++;
        });
        const ent: WeightEntry[] = shares.map(({ bone, weight }) => {
          const [x, y] = toBoneLocal(world.get(bone) as BoneTransform, spineX(wx), spineY(wy));
          return { bone, x: places(x), y: places(y), weight };
        });
        weights.push(ent);
        infl += ent.length;
        maxInfl = Math.max(maxInfl, ent.length);
      });
      return { weights, infl, maxInfl, droppedAtFivePlaces, boundTo };
    };
    // The reference of the motion gate (src/automotion.ts): the source exactly as reduceMesh was handed it — its UVs, its
    // triangles in that winding, its hull — and its own weights, bound as the result's are.
    const srcBound = bind(source.vertices, sw.weights);
    const reference: MeshAttachment = { type: 'mesh', image: file, width: w, height: h, uvs: [...input.source.uvs], triangles: [...input.source.triangles], hull: input.source.hull, weights: srcBound.weights };
    const reached = regions.map(() => 0);
    const whole = regions.map(() => 0);
    if ('local' in sw) {
      for (const li of sw.local) {
        if (li.region < 0) continue;
        reached[li.region]++;
        if (li.g >= 1) whole[li.region]++;
      }
    }
    const bones = new Set(segs.map((s) => s.bone));
    for (const rg of regions) if (weightsABone(rg)) bones.add(rg.bone);
    const pro = input.protect;
    // The attachment and the row of one accepted mesh and the report it came with: the full result's, or a replay's (src/autoreplay.ts).
    // The Stage B opt-ins the author set, echoed after `preset` only when set (rigc#1271): a part that sets none writes the row it always wrote.
    const stageB: StageBOptIns = {
      ...(spec.boundaryRuns === undefined ? {} : { boundaryRuns: { maxVertices: spec.boundaryRuns.maxVertices } }),
      ...(spec.retriangulate === undefined ? {} : { retriangulate: spec.retriangulate }),
      ...(spec.removalOrder === undefined ? {} : { removalOrder: spec.removalOrder }),
    };
    // What the declared stray cleared, against the part's art at alpha 1 and above with the cleared islands counted in.
    const strayCleared: StrayCleared = { islands: source.report.strayIslands, pixels: source.report.strayPixels, art_pixels: source.report.artPixels + source.report.strayPixels };
    const rowOf = (mesh: ReducedMesh, report: MeshQualityReport): { attachment: MeshAttachment; row: AutoMeshReport } => {
      const { weights, infl, maxInfl, droppedAtFivePlaces, boundTo } = bind(mesh.points, mesh.weights as Array<Array<{ bone: string; weight: number }>>);
      const candidate = report.candidates[0];
      const rows = residuals(report);
      return {
        attachment: { type: 'mesh', image: file, width: w, height: h, uvs: [...mesh.uvs], triangles: [...mesh.triangles], hull: mesh.hull, weights },
        row: {
          part: p.name,
          vertices: mesh.points.length,
          triangles: mesh.triangles.length / 3,
          hull: mesh.hull,
          bones: [...bones].sort(),
          max_influences: maxInfl,
          mean_influences: pyRound(infl / mesh.points.length, 2),
          art_coverage: pyRound(legacyArtCoverage(art, mesh.points, mesh.triangles), 5),
          mode: 'auto',
          ...(exponent === undefined ? {} : { exponent }),
          ...(ribSpec.ribs === undefined ? {} : { ribs: ribsRow(ribSpec.ribs, source.ribs ?? []) }),
          settings: {
            threshold: input.art.threshold,
            source: { tolerance: spec.source.tolerance, margin: spec.source.margin, spacing: spec.source.spacing, stray: spec.source.stray ?? null },
            sourceBounds: input.sourceBounds,
            targets: { artFit: input.targets.artFit, maxBoundaryDeviation: input.targets.maxBoundaryDeviation, minAngle: input.targets.minAngle ?? null },
            protect: { hull: pro.hull, vertices: pro.vertices, edges: pro.edges, regionBoundaries: pro.regionBoundaries, weightJump: pro.weightJump, influences: pro.influences },
            influences: input.influences as { maxInfluences: number; minWeight: number },
            budget: input.budget,
            minArtSamples: input.minArtSamples,
            regions: regions.map((rg, k) => ({
              name: rg.name,
              bone: weightsABone(rg) ? rg.bone : null,
              band: weightsABone(rg) ? rg.band : null,
              maxEdgeLength: rg.maxEdgeLength,
              transition: rg.transition,
              grade: rg.grade,
              minArtSamples: rg.minArtSamples,
              approximation: input.targets.regions[k].approximation,
            })),
            preset: null,
            ...stageB,
            // rig-c's own echo of the amplitude it read (`effective.motionAmplitude`, rigc#1287/#1291), only when one was sent.
            ...(report.effective.motionAmplitude === undefined || report.effective.motionAmplitude === null ? {} : { motionAmplitude: report.effective.motionAmplitude }),
          },
          source: { contour: source.report, counts: report.sourceCounts },
          ...(spec.source.stray === undefined ? {} : { stray_cleared: strayCleared }),
          result: { counts: mesh.counts, removedVertices: candidate.changes?.removedVertices ?? 0, insertedVertices: candidate.changes?.insertedVertices ?? 0, ...stageBResult(report, stageB) },
          residuals: rows,
          worst_residual: worstResidual(rows),
          worst_region: worstRegion(rows),
          motion_amplitude: amplitudeRow(amplitude),
          ...(residualSpec === undefined || envelope === null ? {} : { skinning_residual: residualRow(residualSpec.maxResidual, envelope.reference, envelope.derivation, report, segs[0].bone) }),
          termination: report.termination as Termination,
          weights: { sharesDroppedOnGrid: candidate.changes?.sharesDroppedOnGrid ?? 0, sharesPruned: candidate.changes?.sharesPruned ?? 0, droppedAtFivePlaces },
          ...(heat === null ? {} : { heat: heatRow(heat) }),
          regions: regions.map((rg, k) => ({ name: rg.name, bone: weightsABone(rg) ? rg.bone : null, reached: reached[k], whole: whole[k], bound_in_result: boundTo[k] })),
          deformation: DEFORMATION_UNMEASURED,
          quality_report: qualityDocument(report),
        },
      };
    };
    const changes = ran.report.candidates[0]?.changes;
    const acceptedAt = [...(changes?.acceptedAt ?? [])];
    const search: AutoSearch = {
      acceptedAt,
      inserted: refinementSteps(acceptedAt),
      replay: (step) => {
        const replayed = reduce(object, { ...input, stopAfterAccepted: step });
        if ('code' in replayed) return replayed;
        const v = replayVerdict(object, step, acceptedAt, replayed);
        if (!v.accepted) return v.problem;
        return { ...rowOf(v.mesh, replayed.report), candidatesTried: v.candidatesTried };
      },
    };
    const motion: AutoMotionCase = {
      part: p.name,
      object,
      motion: spec.motion,
      reference,
      mask: art,
      sourceBounds: input.sourceBounds,
      artFit: input.targets.artFit,
      minArtSamples: input.minArtSamples,
      regions: input.targets.regions.map((rg, k) => ({ name: rg.name, polygon: rg.polygon.map(([x, y]) => [x, y] as [number, number]), minArtSamples: regions[k].minArtSamples })),
      boundBones: [...new Set(srcBound.weights.flatMap((v) => v.map((e) => e.bone)))].sort(),
      amplitude: 'amplitude' in amplitude ? amplitude.amplitude : null,
      search,
    };
    const full = rowOf(verdict.mesh, ran.report);
    return { motion, attachment: full.attachment, report: full.row };
  };
  for (const p of parts.parts) {
    const img = pad(images.get(p.name) as Raster, PAD, PAD, PAD, PAD, [0, 0, 0, 0]);
    const file = `${p.name}.png`;
    outImages.push([file, img]);
    const mesh = cfg.meshes[p.name];
    if (mesh === undefined) {
      const bone = B.get(cfg.regions[p.name]) as Bone;
      const cx = p.x + p.w / 2;
      const st = stills[p.name];
      if (st !== undefined) {
        // The part cut at st.row: the lower piece keeps the part's slot and
        // blinks; the upper one is drawn right after it, by <part>_still on
        // st.bone. Each piece sits exactly where its rows sat in the part.
        const src = images.get(p.name) as Raster;
        const r = st.row - p.y;
        const still = `${p.name}${STILL_SUFFIX}`;
        const stillFile = `${still}.png`;
        const lower = pad(crop(src, 0, r, p.w, p.h - r), PAD, PAD, PAD, PAD, [0, 0, 0, 0]);
        const upper = pad(crop(src, 0, 0, p.w, r), PAD, PAD, PAD, PAD, [0, 0, 0, 0]);
        const sb = B.get(st.bone) as Bone;
        outImages[outImages.length - 1] = [file, lower];
        outImages.push([stillFile, upper]);
        const cyLow = st.row + (p.h - r) / 2;
        const cyUp = p.y + r / 2;
        skin[p.name] = { [p.name]: region(file, bone.name, cx, cyLow) };
        skin[still] = { [still]: region(stillFile, sb.name, cx, cyUp) };
        slots.push({ name: p.name, bone: bone.name, attachment: p.name }, { name: still, bone: sb.name, attachment: still });
        continue;
      }
      const cy = p.y + p.h / 2;
      skin[p.name] = { [p.name]: region(file, bone.name, cx, cy) };
      slots.push({ name: p.name, bone: bone.name, attachment: p.name });
      continue;
    }
    const segs = meshSegments.get(p.name) as Segment[];
    if ('auto' in mesh) {
      const row = autoAttachment(p, img, file, mesh.auto, mesh.r, mesh.exponent, segs, mesh.rule ?? 'distance', mesh, problems);
      if (row === null) continue;
      skin[p.name] = { [p.name]: row.attachment };
      slots.push({ name: p.name, bone: segs[0].bone, attachment: p.name });
      meshReport.push(row.report);
      autoMotion.push(row.motion);
      continue;
    }
    if ('contour' in mesh) {
      const row = contourAttachment(p, img, file, mesh.contour, mesh.r, mesh.exponent, segs, mesh.rule ?? 'distance', mesh, problems);
      if (row === null) continue;
      skin[p.name] = { [p.name]: row.attachment };
      slots.push({ name: p.name, bone: segs[0].bone, attachment: p.name });
      meshReport.push(row.report);
      continue;
    }
    const art = alphaAbove(img, ART_ALPHA);
    const lm = latticeMesh(p.name, art, mesh.grid, maxLoopPasses);
    if ('code' in lm) {
      problems.push(lm);
      continue;
    }
    loopPasses[p.name] = lm.passes;
    const ox = p.x - PAD;
    const oy = p.y - PAD;
    // issue #161: under rule "heat", the field over the lattice's art (alpha above 8) with its holes filled.
    const heat = mesh.rule === 'heat' ? boneHeat(`config.meshes.${p.name}`, latticeSilhouette(art), segs, ox, oy) : null;
    if (Array.isArray(heat)) {
      problems.push(...heat);
      continue;
    }
    const w = img.width;
    const h = img.height;
    const weights: WeightEntry[][] = [];
    let infl = 0;
    let maxInfl = 0;
    for (const [vx0, vy0] of lm.vertices) {
      const wx = vx0 + ox;
      const wy = vy0 + oy;
      const ent: WeightEntry[] = (heat === null ? influences([wx, wy], segs, mesh.r, undefined, mesh.exponent ?? DISTANCE_EXPONENT) : heatInfluences(heat, [vx0, vy0], DEFAULT_LIMITS)).map(({ bone, weight }) => {
        const [x, y] = toBoneLocal(world.get(bone) as BoneTransform, spineX(wx), spineY(wy));
        return { bone, x: places(x), y: places(y), weight: pyRound(weight, 5) };
      });
      let others = 0;
      for (let k = 0; k < ent.length - 1; k++) others += ent[k].weight;
      ent[ent.length - 1].weight = pyRound(1 - others, 5);
      weights.push(ent);
      infl += ent.length;
      maxInfl = Math.max(maxInfl, ent.length);
    }
    const uvs: number[] = [];
    for (const [x, y] of lm.vertices) uvs.push(pyRound(x / w, 6), pyRound(y / h, 6));
    skin[p.name] = { [p.name]: { type: 'mesh', image: file, width: w, height: h, uvs, triangles: lm.triangles, hull: lm.hull, weights } };
    slots.push({ name: p.name, bone: segs[0].bone, attachment: p.name });
    meshReport.push({
      part: p.name,
      vertices: lm.vertices.length,
      triangles: lm.triangles.length / 3,
      hull: lm.hull,
      bones: [...new Set(segs.map((s) => s.bone))].sort(),
      max_influences: maxInfl,
      mean_influences: pyRound(infl / lm.vertices.length, 2),
      art_coverage: pyRound(artCoverage(lm, art), 5),
      grid: mesh.grid,
      ...(mesh.exponent === undefined ? {} : { exponent: mesh.exponent }),
      ...(heat === null ? {} : { heat: heatRow(heat) }),
    });
  }
  refuseIfAny(problems);

  const name = `${cfg.key}_painting`;
  const rig: RigSpec = {
    spec: 'rigc-rig/1',
    name,
    images: 'images',
    skeleton: { x: -CX, y: 0, width: W, height: H },
    bones,
    slots,
    skins: { default: skin },
  };
  if (cfg.constraints !== undefined) rig.constraints = cfg.constraints.map(constraintForRig);
  const detached = detachedRules(cfg.constraints ?? []);
  if (idleKeys === 'direct' && meshKeyed.length > 0) rig.invariants = { idleDrivesMeshes: { why: IDLE_DRIVES_MESHES_WHY } };
  if (detached.length > 0) rig.invariants = { ...rig.invariants, detached };
  // issue #126 item 3: an automatic part whose author set motion.deformMayFold — written only then, so no other rig moves.
  const mayFold = autoMotion.filter((c) => c.motion?.deformMayFold === true).map((c) => ({ slot: c.part, why: DEFORM_MAY_FOLD_WHY }));
  if (mayFold.length > 0) rig.invariants = { ...rig.invariants, deformMayFold: mayFold };
  return { rig, motion, meshReport, images: outImages, controls, meshKeyed, idleKeys, loopPasses, autoMotion };
}

/**
 * The JSON text of a rig output file. One space of indent, as the reference
 * wrote, and a closing newline; the key order is the order the objects were
 * built in, which `buildRig` fixes.
 */
export function rigJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}

/**
 * The rig as the reference wrote it: every bone unturned, so each local
 * offset is a plain difference of world positions. Each bone's `x, y`, each
 * weight's bind `x, y` and each region's `x, y` is carried out of its frame as
 * written (rigc's `toWorld`, `src/coords.ts`) and back in as a difference from
 * the frame's origin, at the reference's 3 places; `length` and `rotation` are
 * dropped. Everything else is copied.
 *
 * It exists so the reference's outputs stay an oracle: the chain suite and
 * `scripts/rig_oracle.ts` compare `flattenRig(built)` with the reference's
 * `rig.json`. It is the oriented emitter's inverse, and it lives beside it so
 * a change to one is read against the other.
 *
 * ⛔ The flat form cannot draw a turned image. A region whose `rotation` does
 * not cancel its bone's world rotation is refused by name
 * (`FLATTEN_REGION_UPRIGHT`) rather than flattened into an upright one the
 * oriented rig does not draw.
 *
 * `sense` is the direction rotations are read in: 1, always, but for the
 * planted control that shows a flatten turning the wrong way is caught.
 */
export function flattenRig(rig: RigSpec, sense: 1 | -1 = 1): RigSpec {
  const problems: Problem[] = [];
  const read = rig.bones.map((b) => ({ ...b, rotation: (b.rotation ?? 0) * sense }));
  const world = computeExactFrameTransforms(read);
  const turn = new Map<string, number>();
  for (const b of rig.bones) turn.set(b.name, placed((b.parent === undefined ? 0 : (turn.get(b.parent) as number)) + (b.rotation ?? 0), OFFSET_PLACES));
  const origin = (bone: string): BoneTransform => world.get(bone) as BoneTransform;
  const out = (m: BoneTransform, x: number, y: number): [number, number] => {
    const [wx, wy] = toWorld(m, x, y);
    return [placed(wx - m.worldX, FLAT_PLACES), placed(wy - m.worldY, FLAT_PLACES)];
  };
  const bones: RigBone[] = rig.bones.map((b) => {
    if (b.parent === undefined) return { name: b.name, x: b.x, y: b.y };
    const [x, y] = out(origin(b.parent), b.x, b.y);
    return { name: b.name, parent: b.parent, x, y };
  });
  const slotBone = new Map(rig.slots.map((s) => [s.name, s.bone]));
  const skin: RigSpec['skins']['default'] = {};
  for (const [slot, atts] of Object.entries(rig.skins.default)) {
    const bone = slotBone.get(slot) as string;
    const flat: Record<string, MeshAttachment | RegionAttachment> = {};
    for (const [name, att] of Object.entries(atts)) {
      if ('type' in att) {
        flat[name] = { ...att, weights: att.weights.map((v) => v.map((w) => {
          const [x, y] = out(origin(w.bone), w.x, w.y);
          return { bone: w.bone, x, y, weight: w.weight };
        })) };
        continue;
      }
      const left = normaliseDegrees((turn.get(bone) as number) + (att.rotation ?? 0));
      if (Math.abs(left) > 1e-6) {
        problems.push({
          code: 'FLATTEN_REGION_UPRIGHT',
          object: `skins.default.${slot}.${name}`,
          detail: `rides "${bone}", turned ${turn.get(bone)} degrees, with rotation ${att.rotation ?? 'absent'}, so it is drawn turned ${placed(left, OFFSET_PLACES)} degrees; the flat form draws every region upright, so the region's rotation must cancel its bone's turn`,
        });
        continue;
      }
      const [x, y] = out(origin(bone), att.x, att.y);
      flat[name] = { image: att.image, x, y };
    }
    skin[slot] = flat;
  }
  refuseIfAny(problems);
  return { ...rig, bones, skins: { default: skin } };
}

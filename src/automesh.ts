/**
 * The automatic mesh mode (issue #126, item 2): geometry only. A mesh entry
 * that says `auto` is built in three steps, and every number each step reads
 * is one the author wrote in `meshes.<part>.auto` (`AutoSpec`, `src/config.ts`):
 *
 * 1. **The source** ({@link autoSource}) — P8's unreduced, independently gated
 *    reference: this package's own contour mesh (`src/contour.ts`) over the
 *    padded part image at **alpha 1 and above** (`contourMesh(…, { threshold:
 *    0 })` reads `alpha > 0`, P4's final threshold), at the author's
 *    `source.tolerance`, `source.margin` and background `source.spacing`, with
 *    no region (the density a region asks for is rig-c's refinement, step
 *    2). `contourMesh` gates it with this package's own checks before it is
 *    returned — `contourTopologyProblems` and `contourFit` at that threshold,
 *    its overshoot read with the background flooded 8-connected
 *    ({@link AUTO_SOURCE_FIT_CONNECTIVITY}), the fill rig-c's admission reads
 *    — and a refusal there is the part's refusal, in the contour mode's codes.
 *    Its weights are `localInfluences` (`src/localweights.ts`) under the
 *    author's `influences` — no 0.03 floor unless the author wrote it (P19) —
 *    unrounded, so a vertex that survives can be compared bit for bit.
 * 2. **The call** ({@link autoReductionInput}) — rig-c's `reduceMesh`
 *    (`rig-c/mesh`, 2.28.x), refinement inside the declared regions then
 *    reduction, every input from the config or from the source, as the
 *    contract types it (docs/MESH_REDUCTION.md §1): `art` the padded image's
 *    alpha at threshold 1 in the part-local frame with `pageScale` 1 (the
 *    rig's images are the drawing) — under a declared `source.stray`, the
 *    mask the source was traced from (`ContourMesh.mask`, the islands it left
 *    out at alpha 0; issue #172), which the rig stage hands every reader; `protect.hull` false unless the author
 *    wrote true (P20); the region bones added to `protect.influences` (a
 *    density-only region names none and adds none, issue #155), so an
 *    inserted vertex never loses its region's share silently; `boneOrder` the
 *    rig's bone order; `preset` null (no preset exists in this package: a
 *    preset is a later, versioned thing, P5); `deform` and `linkedMeshes`
 *    empty — this package writes no deform key and no linked mesh.
 * 3. **Acceptance** ({@link autoVerdict}) — the result is used only when the
 *    report's termination is `no-further-valid-reduction`, or
 *    `budget-exhausted` with `best-meeting-every-bound`, AND the candidate is
 *    `accepted` AND every row with a declared bound is `pass`. Anything else
 *    refuses the part by name with the report's own reason, code and detail.
 *    There is no fallback: a refused part is not quietly built as a lattice or
 *    as its contour source.
 *
 * ## What is measured, and what is not
 *
 * Geometry only: the report's rows are rig-c's `measureMeshQuality`
 * rows (coverage, overshoot, undercut, boundary deviation from the source
 * hull, orientation, degeneracy, the smallest angle, each region's maximum
 * edge and transition). No pose is taken here, and `buildRig`'s row says so
 * in those words ({@link DEFORMATION_UNMEASURED}); the rig stage then measures
 * the result's motion against this source on the idle (issue #126 item 3,
 * `src/automotion.ts`) and writes the part only when it passes, so a written
 * row never says unmeasured.
 *
 * ## The winding the call is handed
 *
 * rig-c's `SourceMesh.triangles` are counter-clockwise in Spine world,
 * which its `MQ_ORIENTATION` reads through `cropToSpineY`. The contour mesh
 * writes its triangles that way (`src/contour.ts`, issue #126), so the source
 * is handed over exactly as `contourMesh` returns it — no turn here, so none
 * twice (before issue #126 the contour mesh was clockwise in Spine world and
 * this module swapped each triple; the bytes handed to rig-c are the same
 * either way). The result is written as rig-c returns it.
 *
 * ## A circle region (P17)
 *
 * rig-c holds density on a polygon. A circle region is handed over as
 * the regular polygon {@link circlePolygon} names, whose rule and error are
 * echoed in the region's `approximation`. The weights still read the circle.
 *
 * Pure: no clock, no randomness, nothing read or written.
 */
import {
  measureAuthoredMeshFit,
  MeshReductionError,
  reduceMesh,
  type AlphaMask,
  type MeasureRow,
  type MeshCounts,
  type MeshQualityReport,
  type MeshReductionInput,
  type ReducedMesh,
  type RefinementRegion,
  type SourceMesh,
  type Termination,
  writeMeshQualityReport,
} from 'rig-c/mesh';
import { type AutoRegionSpec, type AutoSpec, type AutoWeightRegionSpec, type Point, weightsABone } from './config.ts';
import { type ContourChainRibs, type ContourMesh, contourMesh, type ContourReport, GRID } from './contour.ts';
import { type HeatField, heatInfluences } from './heat.ts';
import type { Problem } from './errors.ts';
import { type LocalInfluence, localInfluences, type RegionOverlap } from './localweights.ts';
import { ART_ALPHA } from './mesh.ts';
import { pyRound } from './round.ts';
import { DISTANCE_EXPONENT, type Influence, type Segment } from './weights.ts';

/** The final threshold of the automatic mode: art is alpha 1 and above (P4). `contourMesh` reads "above", so it is handed one less. */
export const AUTO_THRESHOLD = 1;

/** What the report says about deformation, in so many words. */
export const DEFORMATION_UNMEASURED = 'unmeasured: geometry only — no pose was taken and no motion compared (issue #126 item 3, rigc#1221 stage C)';

/**
 * How far inside the circle no vertex of its polygon may round: the polygon's
 * inscribed radius is `r + CIRCLE_CLEARANCE` before each vertex is put on
 * rig-c's 6-decimal grid, which moves a vertex by at most √2·5e-7 px, so
 * every edge stays outside the circle. Derived from that grid, not chosen.
 */
export const CIRCLE_CLEARANCE = 1e-6;

/** The largest distance √2·5e-7 px that the 6-decimal rounding can move a vertex, rounded up. */
const R6_MOVE = 7.1e-7;

/**
 * A circle region as the polygon rig-c holds density on (P17). **Rule:**
 * the regular polygon with `n` sides circumscribed about the circle of radius
 * `r + CIRCLE_CLEARANCE`, its first vertex at angle 0 (+x) and the rest
 * increasing (clockwise on screen), each on the 6-decimal grid, with `n` the
 * smallest whole number ≥ 3 for which the polygon's boundary lies within one
 * grid unit of the region's numbers (1/{@link GRID} px) of the circle:
 * `(r + CIRCLE_CLEARANCE) / cos(π/n) − r + 7.1e-7 ≤ 1/256`. So the polygon
 * holds the whole circle — every edge that meets the circle meets the polygon
 * and is held to its bound — and asks for density at most 1/256 px further
 * out than the circle does. `maxError` is that left-hand side. What is not
 * exact: `Math.cos`/`Math.sin`, which an engine need not round correctly, can
 * move a vertex by an ulp before the 6-decimal rounding.
 */
export function circlePolygon(cx: number, cy: number, r: number): { polygon: Array<[number, number]>; sides: number; maxError: number } {
  const unit = 1 / GRID;
  let n = 3;
  const errorOf = (k: number): number => (r + CIRCLE_CLEARANCE) / Math.cos(Math.PI / k) - r + R6_MOVE;
  while (errorOf(n) > unit) n++;
  const R = (r + CIRCLE_CLEARANCE) / Math.cos(Math.PI / n);
  const polygon: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    polygon.push([pyRound(cx + R * Math.cos(t), 6), pyRound(cy + R * Math.sin(t), 6)]);
  }
  return { polygon, sides: n, maxError: pyRound(errorOf(n), 9) };
}

/** A region as rig-c is handed it, in part-local px: a polygon, its density, and how a circle was approximated. */
export function refinementRegion(rg: AutoRegionSpec, ox: number, oy: number): RefinementRegion {
  const density = { maxEdgeLength: rg.maxEdgeLength, transition: rg.transition, grade: rg.grade };
  if (rg.shape === 'polygon') {
    return { name: rg.name, polygon: rg.points.map(([x, y]) => [x - ox, y - oy] as [number, number]), ...density, approximation: null };
  }
  const c = circlePolygon(rg.cx - ox, rg.cy - oy, rg.r);
  return {
    name: rg.name,
    polygon: c.polygon,
    ...density,
    approximation: {
      from: `circle (${rg.cx - ox}, ${rg.cy - oy}) r ${rg.r}`,
      policy: `regular ${c.sides}-gon circumscribed about radius r + ${CIRCLE_CLEARANCE}, first vertex at +x, vertices on the 6-decimal grid; sides the fewest >= 3 whose boundary lies within 1/${GRID} px of the circle`,
      maxError: c.maxError,
    },
  };
}

/**
 * How the source's own fit gate floods the background (rig-c 2.23.0's
 * `measureAuthoredMeshFit` `connectivity`, rigc#1262): 8, the fill rig-c's
 * `MQ_OVERSHOOT` reads and `reduceMesh` admits a source by
 * (`REDUCE_SOURCE_FAILS_ITS_ART_BOUNDS`), so a source this package passes is
 * read with the same number rig-c reads it with, and a source that overshoots
 * through a pocket joined to the outside only at a corner is refused here, by
 * this package's code, before the call. The contour mode keeps 4 (its
 * report carries no `fitConnectivity`, its bytes are unchanged).
 */
export const AUTO_SOURCE_FIT_CONNECTIVITY = 8;

/**
 * The source of one automatic mesh: the contour mesh at alpha 1 and above, gated by `contourMesh` with its overshoot
 * read at {@link AUTO_SOURCE_FIT_CONNECTIVITY}, or every problem that refuses it. `ribs` (issue #188) are placed on
 * it as the contour mode places them, at `source.spacing`; none, and the call is the one it always was.
 */
export function autoSource(part: string, mask: AlphaMask, spec: AutoSpec, ribs: readonly ContourChainRibs[] = []): ContourMesh | Problem[] {
  return contourMesh(part, mask, {
    threshold: AUTO_THRESHOLD - 1,
    tolerance: spec.source.tolerance,
    margin: spec.source.margin,
    spacing: spec.source.spacing,
    ...(spec.source.stray === undefined ? {} : { stray: spec.source.stray }),
    regions: [],
    fitConnectivity: AUTO_SOURCE_FIT_CONNECTIVITY,
    ...(ribs.length === 0 ? {} : { ribs }),
  });
}

/**
 * The bound every rib's line is sent with (issue #188), drawing px: 0. A rib's vertices are all in `protect.vertices`,
 * so none is removed and the bound is never what keeps one; the line is sent for what rig-c's `lines` add besides
 * (rig-c 2.33.0, docs/MESH_REDUCTION.md §11): the triangulation post-pass flips no line edge, so the row stays a row of
 * edges in the result, and the result's measurement carries one `MQ_LINE_DEVIATION` row per rib, by its name.
 */
export const RIB_LINE_DEVIATION = 0;

/**
 * The source's weights by bone name, unrounded, or the first vertex two regions both reach. Only the regions
 * that weight a bone are read (issue #155): a density-only region gives no vertex a `g`, so a source vertex
 * inside it is weighted as one no region reaches, it can never be one of an overlap's two, and the weights are
 * the same numbers the part has with the region left out. Region indices in the result (`local[].region`, the
 * overlap's `first` and `second`) are indices into `spec.regions`, every form counted. `exponent` is the mesh's
 * distance-rule exponent (issue #161), which the rig stage always passes. With `heat` (issue #161,
 * `rule: "heat"`), each vertex's segment shares are bone heat's at its pixel, under the author's influence limits.
 */
export function sourceWeights(
  vertices: ReadonlyArray<readonly [number, number]>,
  ox: number,
  oy: number,
  segs: readonly Segment[],
  r: number,
  spec: AutoSpec,
  exponent: number = DISTANCE_EXPONENT,
  heat: HeatField | null = null,
): { weights: Influence[][]; local: LocalInfluence[] } | { overlap: RegionOverlap; vertex: number; at: Point } {
  const all = spec.regions ?? [];
  const index: number[] = [];
  const regions: AutoWeightRegionSpec[] = [];
  all.forEach((rg, k) => {
    if (!weightsABone(rg)) return;
    index.push(k);
    regions.push(rg);
  });
  const weights: Influence[][] = [];
  const local: LocalInfluence[] = [];
  for (let v = 0; v < vertices.length; v++) {
    const at: Point = [vertices[v][0] + ox, vertices[v][1] + oy];
    const li = localInfluences(at, segs, r, regions, spec.influences, exponent, heat === null ? undefined : heatInfluences(heat, [vertices[v][0], vertices[v][1]], spec.influences));
    if ('first' in li) return { overlap: { ...li, first: index[li.first], second: index[li.second] }, vertex: v, at };
    weights.push(li.influences.map((e) => ({ bone: e.bone, weight: e.weight })));
    local.push(li.region < 0 ? li : { ...li, region: index[li.region] });
  }
  return { weights, local };
}

/** Everything `reduceMesh` is handed, each field from the config, the source or the rig — none from this package. */
export function autoReductionInput(args: {
  part: string;
  mask: AlphaMask;
  ox: number;
  oy: number;
  spec: AutoSpec;
  source: ContourMesh;
  weights: Influence[][] | null;
  boneOrder: string[];
}): MeshReductionInput {
  const { part, mask, ox, oy, spec, source } = args;
  const w = mask.width;
  const h = mask.height;
  const regions = spec.regions ?? [];
  const protect = spec.protect ?? {};
  // issue #188: every rib vertex is kept — the author's protected vertices first, as written, then each rib vertex not
  // among them, ascending. No rib, and the list is the author's.
  const ribs = source.ribs ?? [];
  const kept: number[] = [...(protect.vertices ?? [])];
  for (const v of [...new Set(ribs.flatMap((r) => r.vertices))].sort((a, b) => a - b)) if (!kept.includes(v)) kept.push(v);
  const guarded: string[] = [...(protect.influences ?? [])];
  // A density-only region names no bone and guards none (issue #155).
  for (const rg of regions) if (weightsABone(rg) && !guarded.includes(rg.bone)) guarded.push(rg.bone);
  const fit = (f: AutoSpec['sourceBounds']): MeshReductionInput['sourceBounds'] => ({ minCoverage: f.minCoverage, maxOvershoot: f.maxOvershoot, maxUndercut: f.maxUndercut });
  const src: SourceMesh = {
    points: source.vertices.map(([x, y]) => [x, y] as [number, number]),
    uvs: source.vertices.flatMap(([x, y]) => [pyRound(x / w, 6), pyRound(y / h, 6)]),
    triangles: [...source.triangles],
    hull: source.hull,
    weights: args.weights === null ? null : args.weights.map((list) => list.map((e) => ({ bone: e.bone, weight: e.weight }))),
  };
  return {
    attachment: { skin: null, slot: part, attachment: part },
    art: { mask, threshold: AUTO_THRESHOLD, frame: { space: 'part-local-drawing-px-y-down', width: w, height: h, pageScale: 1, conversion: 'texels = px * pageScale' } },
    source: src,
    sourceBounds: fit(spec.sourceBounds),
    targets: {
      artFit: fit(spec.targets.artFit),
      maxBoundaryDeviation: spec.targets.maxBoundaryDeviation,
      ...(spec.targets.minAngle === undefined ? {} : { minAngle: spec.targets.minAngle }),
      regions: regions.map((rg) => refinementRegion(rg, ox, oy)),
    },
    protect: {
      hull: protect.hull ?? false,
      vertices: kept,
      edges: (protect.edges ?? []).map(([a, b]) => [a, b] as [number, number]),
      regionBoundaries: [...(protect.regionBoundaries ?? [])],
      weightJump: protect.weightJump ?? null,
      influences: guarded,
    },
    influences: { maxInfluences: spec.influences.maxInfluences, minWeight: spec.influences.minWeight },
    boneOrder: [...args.boneOrder],
    preset: null,
    budget: { maxCandidates: spec.budget.maxCandidates },
    minArtSamples: spec.minArtSamples,
    regionArtSamples: regions.map((rg) => ({ region: rg.name, minArtSamples: rg.minArtSamples })),
    deform: [],
    linkedMeshes: [],
    // Stage B (rigc#1271), each sent only when the author wrote it: absent, the input is the one it was before rig-c 2.25.0.
    ...(spec.boundaryRuns === undefined ? {} : { boundaryRuns: { maxVertices: spec.boundaryRuns.maxVertices } }),
    ...(spec.retriangulate === undefined ? {} : { retriangulate: spec.retriangulate }),
    ...(spec.removalOrder === undefined ? {} : { removalOrder: spec.removalOrder }),
    ...(ribs.length === 0 ? {} : { lines: ribs.map((r) => ({ name: r.name, vertices: [...r.vertices], closed: false, maxDeviation: RIB_LINE_DEVIATION })) }),
  };
}

/** The Stage B opt-ins a part set (rigc#1271), as `AutoSpec` and the row's `settings` both carry them: each absent when not set. */
export interface StageBOptIns {
  boundaryRuns?: { maxVertices: number };
  retriangulate?: 'delaunay';
  removalOrder?: 'deformation-load';
}

/**
 * What the row's `result` carries about the Stage B opt-ins, each key only
 * when its opt-in is set, so a part that sets none writes the `result` it
 * always wrote: `boundary_runs` — the accepted operations of kind
 * `boundary-run` and the vertices they removed, read off `acceptedAt` —
 * and `retriangulation` — rig-c's `changes.retriangulation` without its fixed
 * sentence (which the `quality_report` keeps): whether the pass was taken, its
 * flips and sweeps, and the row that refused it; null when rig-c returned none.
 */
export interface StageBResult {
  boundary_runs?: { runs: number; vertices: number };
  retriangulation?: { method: 'delaunay'; taken: boolean; flips: number; sweeps: number; refusedBy: string | null } | null;
}

export function stageBResult(report: MeshQualityReport, set: StageBOptIns): StageBResult {
  const ch = report.candidates[0]?.changes;
  const out: StageBResult = {};
  if (set.boundaryRuns !== undefined) {
    const runs = (ch?.acceptedAt ?? []).filter((o) => o.kind === 'boundary-run');
    out.boundary_runs = { runs: runs.length, vertices: runs.reduce((n, o) => n + o.count, 0) };
  }
  if (set.retriangulate !== undefined) {
    const rt = ch?.retriangulation;
    out.retriangulation = rt === undefined ? null : { method: rt.method, taken: rt.taken, flips: rt.flips, sweeps: rt.sweeps, refusedBy: rt.refusedBy };
  }
  return out;
}

/**
 * The build line's clause for the Stage B opt-ins (rigc#1271): empty when the
 * part sets none, so a config that names none prints the line it always
 * printed. Otherwise `; boundary runs <= k: r run(s), v vertex(es)`,
 * `; retriangulate delaunay taken, n flip(s)` or `… refused by <row>`, and
 * `; removal order deformation-load`.
 */
export function stageBClause(set: StageBOptIns, result: StageBResult): string {
  const out: string[] = [];
  if (set.boundaryRuns !== undefined) {
    const b = result.boundary_runs;
    out.push(`boundary runs <= ${set.boundaryRuns.maxVertices}: ${b === undefined ? 'unread' : `${b.runs} run(s), ${b.vertices} vertex(es)`}`);
  }
  if (set.retriangulate !== undefined) {
    const rt = result.retriangulation;
    out.push(rt === undefined || rt === null ? `retriangulate ${set.retriangulate}: not reported` : rt.taken ? `retriangulate ${rt.method} taken, ${rt.flips} flip(s)` : `retriangulate ${rt.method} refused by ${rt.refusedBy ?? 'an unnamed row'}`);
  }
  if (set.removalOrder !== undefined) out.push(`removal order ${set.removalOrder}`);
  return out.map((x) => `; ${x}`).join('');
}

/** The verdict on one call: the mesh to write, or the problem that refuses the part. */
export type AutoVerdict = { accepted: true; mesh: ReducedMesh } | { accepted: false; problem: Problem };

/** The rows with a declared bound that are not `pass` — none on an accepted result. */
export function gatedFailures(report: MeshQualityReport): MeasureRow[] {
  return (report.candidates[0]?.geometry?.rows ?? []).filter((r) => r.bound !== null && r.state !== 'pass');
}

function rowText(r: MeasureRow): string {
  const region = r.object.region === null ? '' : ` [region "${r.object.region}"]`;
  return r.state === 'pass' || r.state === 'fail' ? `${r.code}${region} ${r.state} ${r.value} against ${r.bound?.op} ${r.bound?.value}` : `${r.code}${region} ${r.state}: ${r.reason ?? ''}`;
}

/** The termination in one line, as the report states it. */
export function terminationText(t: Termination | null): string {
  if (t === null) return 'no termination';
  if (t.reason === 'no-further-valid-reduction') return `no-further-valid-reduction after ${t.candidatesTried} candidate(s), blocked by ${t.blockingConstraint}`;
  if (t.reason === 'budget-exhausted') return `budget-exhausted after ${t.candidatesTried} of ${t.budget} candidate(s), ${t.result}`;
  if (t.reason === 'replayed-to-accepted-step') return `replayed-to-accepted-step ${t.acceptedSteps} after ${t.candidatesTried} candidate(s)`;
  return `${t.reason} ${t.code}: ${t.detail}`;
}

/**
 * Acceptance (module header, step 3). `object` names the config entry. A mesh
 * returned with a gated row that does not pass — rig-c returns one, not
 * accepted, when the refined source cannot meet its targets — is refused here
 * as any other result that is not accepted.
 */
export function autoVerdict(object: string, result: { mesh: ReducedMesh | null; report: MeshQualityReport }): AutoVerdict {
  const { mesh, report } = result;
  const t = report.termination;
  const candidate = report.candidates[0];
  if (t === null || t.reason === 'invalid-input' || t.reason === 'unsupported-topology') {
    return { accepted: false, problem: { code: 'AUTO_MESH_TERMINATION', object, detail: `rig-c's reduceMesh ended ${terminationText(t)}; no mesh was returned, and nothing is built in its place` } };
  }
  if (t.reason === 'budget-exhausted' && t.result === 'none-met-the-targets') {
    return {
      accepted: false,
      problem: { code: 'AUTO_MESH_TERMINATION', object, detail: `rig-c's reduceMesh spent its budget of ${t.budget} candidate(s) before any met every target (none-met-the-targets); no mesh was returned — raise budget.maxCandidates or relax a declared bound` },
    };
  }
  const failing = gatedFailures(report);
  if (mesh === null || candidate === undefined || !candidate.accepted || failing.length > 0) {
    return {
      accepted: false,
      problem: {
        code: 'AUTO_MESH_ACCEPTED',
        object,
        detail: `rig-c's reduceMesh ended ${terminationText(t)} and its result is not accepted (${failing.length > 0 ? failing.map(rowText).join('; ') : 'a required measurement is unavailable'}); every declared bound passing is required, and nothing is built in its place`,
      },
    };
  }
  return { accepted: true, mesh };
}

/** What one reduction returns: rig-c's mesh and report, or its refusal of the input as the part's problem. */
export type ReductionResult = { mesh: ReducedMesh | null; report: MeshQualityReport } | Problem;

/**
 * How `buildRig` runs a part's reduction: {@link runReduction} unless a caller
 * hands it another (issue #135). The only other one this package makes is
 * {@link reuseReductions}, which hands back a reduction already run on the
 * very same input — `reduceMesh` is deterministic, so the same input is the
 * same result — and runs the call itself on any other input.
 */
export type Reducer = (object: string, input: MeshReductionInput) => ReductionResult;

/** One call: `reduceMesh`, with a thrown refusal read as the part's problem. */
export function runReduction(object: string, input: MeshReductionInput): ReductionResult {
  try {
    return reduceMesh(input);
  } catch (err) {
    if (!(err instanceof MeshReductionError)) throw err;
    return { code: 'AUTO_MESH_INPUT', object, detail: `rig-c's reduceMesh refused its input: ${err.message}` };
  }
}

/**
 * A reduction input as one string: every field in the order it was built, a
 * typed array (the art mask's alpha) as its plain list of numbers. Two inputs
 * are the same input exactly when their keys are equal; a key order that
 * differs reads as a different input, which costs a call and never a wrong
 * result.
 */
export function reductionKey(input: MeshReductionInput): string {
  return JSON.stringify(input, (_k, v: unknown) => (v instanceof Uint8Array || v instanceof Uint8ClampedArray || v instanceof Float32Array || v instanceof Float64Array ? Array.from(v) : v));
}

/** A {@link Reducer} that reuses reductions already run, and counts what it reused and what it ran. */
export interface ReusingReducer {
  reduce: Reducer;
  /** Calls answered from a reduction already run on the same input. */
  reused: () => number;
  /** Calls whose input matched none, run through `run`. */
  ran: () => number;
}

/**
 * Hand back a reduction already run when the input is the same input — `done`
 * holds each result under its input's {@link reductionKey} — and run `run` (by
 * default {@link runReduction}) on any other. A reused refusal is
 * re-addressed to the asking call's object, so a problem always names the
 * config field that asked. Nothing is guessed: a miss is a call, never a near
 * match.
 */
export function reuseReductions(done: ReadonlyMap<string, ReductionResult>, run: Reducer = runReduction): ReusingReducer {
  const byKey = done;
  let reused = 0;
  let ran = 0;
  return {
    reduce: (object, input) => {
      const hit = byKey.get(reductionKey(input));
      if (hit === undefined) {
        ran++;
        return run(object, input);
      }
      reused++;
      return 'code' in hit ? { ...hit, object } : hit;
    },
    reused: () => reused,
    ran: () => ran,
  };
}

/** The report's whole document, as rig-c writes it (its key order), parsed so it can sit inside `mesh_report.json`. */
export function qualityDocument(report: MeshQualityReport): unknown {
  return JSON.parse(writeMeshQualityReport(report));
}

/** One residual as `mesh_report.json` carries it: every row, its state, value and bound. */
export interface Residual {
  code: string;
  region: string | null;
  state: MeasureRow['state'];
  value: number | null;
  bound: { op: '<=' | '>='; value: number } | null;
  unit: MeasureRow['unit'];
}

export function residuals(report: MeshQualityReport): Residual[] {
  return (report.candidates[0]?.geometry?.rows ?? []).map((r) => ({ code: r.code, region: r.object.region, state: r.state, value: r.value, bound: r.bound, unit: r.unit }));
}

/**
 * The worst residual: of the rows with a declared bound, the one nearest its
 * bound, as the share of the bound used — `value / bound` for a `<=` row,
 * `bound / value` for a `>=` row (coverage, the smallest angle); a bound of 0
 * met exactly is 0, a value of 0 under a `>=` bound above 0 is Infinity. The
 * first in report order wins a tie. Null when no row has a bound.
 */
export function worstResidual(rows: readonly Residual[]): (Residual & { used: number }) | null {
  let best: (Residual & { used: number }) | null = null;
  for (const r of rows) {
    if (r.bound === null || r.value === null) continue;
    const used = r.bound.op === '<=' ? (r.bound.value === 0 ? (r.value === 0 ? 0 : Infinity) : r.value / r.bound.value) : r.value === 0 ? (r.bound.value === 0 ? 0 : Infinity) : r.bound.value / r.value;
    if (best === null || used > best.used) best = { ...r, used };
  }
  return best;
}

/**
 * The art-fit rows whose bound the author declared absent: `MQ_OVERSHOOT`
 * under `targets.artFit.maxOvershoot: null`, `MQ_UNDERCUT` under
 * `maxUndercut: null` — the part-wide row of each (region null), and of the
 * overshoot rows the first, the 8-connected one rig-c gates (a second,
 * 4-connected reading is reported beside it only where a diagonal pinch makes
 * the fills differ, and is never bounded). rig-c measures such a row and
 * reports it `undeclared`, with its value and no bound; it gates nothing, so
 * {@link worstResidual} never picks it. A bound written as a number selects
 * nothing here.
 */
export function unboundedArtRows(rows: readonly Residual[], artFit: { maxOvershoot: number | null; maxUndercut: number | null }): Array<{ label: 'overshoot' | 'undercut'; row: Residual }> {
  const out: Array<{ label: 'overshoot' | 'undercut'; row: Residual }> = [];
  const pick = (code: string): Residual | undefined => rows.find((r) => r.code === code && r.region === null);
  if (artFit.maxOvershoot === null) {
    const r = pick('MQ_OVERSHOOT');
    if (r !== undefined) out.push({ label: 'overshoot', row: r });
  }
  if (artFit.maxUndercut === null) {
    const r = pick('MQ_UNDERCUT');
    if (r !== undefined) out.push({ label: 'undercut', row: r });
  }
  return out;
}

/**
 * The build line's clause for {@link unboundedArtRows}: `; undercut 3.2 (not
 * bounded)` per row, the value as rig-c reported it (or the state, when it
 * could not be measured); empty when every art-fit bound is a number, so a
 * config that declares both bounds prints the line it always printed.
 */
export function unboundedClause(rows: readonly Residual[], artFit: { maxOvershoot: number | null; maxUndercut: number | null }): string {
  return unboundedArtRows(rows, artFit)
    .map(({ label, row }) => `; ${label} ${row.value === null ? row.state : row.value} (not bounded)`)
    .join('');
}

/**
 * The build line's weight-aware allocation readings (rig-c 2.29.0, rigc#1291), each printed only when rig-c measured it:
 * `MQ_DEFORM_LOAD` (D · θ / 4, px — a location reading, not predicted motion) and `MQ_ALLOCATION_CONTRAST` (Δ, only
 * with the author's gradation). Both are `undeclared`: no bound, never required. Nothing is printed for a row that is
 * `not-measurable`, so a part with no amplitude prints the line it printed before.
 */
export function allocationClause(rows: readonly Residual[]): string {
  const at = (code: string): Residual | undefined => rows.find((r) => r.code === code && r.region === null && r.value !== null);
  const load = at('MQ_DEFORM_LOAD');
  const contrast = at('MQ_ALLOCATION_CONTRAST');
  return `${load === undefined ? '' : `; deform load ${load.value} px (undeclared)`}${contrast === undefined ? '' : `; allocation contrast ${contrast.value} (undeclared)`}`;
}

/** The region whose density rows are nearest their bounds (the worst residual among `MQ_MAX_EDGE`/`MQ_TRANSITION` rows), or null without a region. */
export function worstRegion(rows: readonly Residual[]): string | null {
  return worstResidual(rows.filter((r) => r.region !== null))?.region ?? null;
}

/** The share of art (alpha above `ART_ALPHA`, the other modes' reading) a mesh covers — `art_coverage`, comparable across modes. */
export function legacyArtCoverage(mask: AlphaMask, points: Array<[number, number]>, triangles: number[]): number {
  const fit = measureAuthoredMeshFit(mask, ART_ALPHA + 1, points, triangles);
  return fit.artPixels === 0 ? 0 : fit.coveredArt / fit.artPixels;
}

/** The counts the mesh line and the row carry: boundary / interior vertices, triangles, bindings. */
export function countsText(c: MeshCounts | null): string {
  return c === null ? 'unread' : `${c.boundaryVertices}+${c.interiorVertices} v, ${c.triangles} t, ${c.bindings} b`;
}

export type { ContourReport };

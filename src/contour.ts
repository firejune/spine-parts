/**
 * The contour mesh: a part's alpha outline, traced and simplified by
 * rig-c's own functions, with interior vertices placed where they are
 * declared and a triangulation that never crosses the outline (issue #84). The
 * rig stage builds it for a mesh whose config entry says `contour` (step 2,
 * `src/rig.ts`); the lattice (`src/mesh.ts`) is untouched and stays the mode
 * of every entry that says `grid`.
 *
 * ## What it does, in order
 *
 * 1. **Art.** A pixel is art when its alpha is ABOVE `threshold` — the
 *    lattice's reading (`ART_ALPHA` in `src/mesh.ts`, the reference's
 *    `alpha > 8`). rig-c's tracer and fit counter read "at or above", so
 *    they are handed `threshold + 1`, which is the same set of pixels.
 * 2. **Islands and holes.** The art's 4-connected islands are counted
 *    (`connectedComponents`, 4-connectivity, rigc's own island rule); a second
 *    island holding any art pixel is refused with every island's pixel count
 *    (`CONTOUR_ONE_ISLAND`). Nothing is discarded and nothing falls back to the
 *    lattice — unless the caller declares `stray`, the largest island that may
 *    be left out ({@link strayIslands}): then islands other than the largest
 *    at or under that figure are taken out of the art before the trace, and
 *    the report says how many and how many pixels (`strayIslands`,
 *    `strayPixels`). A hole is filled, as rigc's trace and the lattice both
 *    fill it, and its area is reported (`filledHolePixels`).
 * 3. **The outline** ({@link contourOutline}; issue #106 replaced rigc's
 *    `offsetPolygon`, which folded the outline over any notch narrower than
 *    twice the margin): the silhouette F — the kept island with its holes
 *    filled — is read by rigc's `traceAlphaOutline` first (a diagonal pinch in
 *    F itself stays rigc's refusal), then grown by the margin, centre to
 *    centre, and the diagonal pinches the growth made are filled
 *    ({@link growSilhouette}); that silhouette is traced by
 *    `traceAlphaOutline` → `simplifyClosedPolygon(tolerance)` → clamped to the
 *    part window → snapped to the {@link GRID} → `prunePolygon`, rigc's
 *    functions imported and never copied. A grown silhouette is a set of
 *    pixels, so its trace cannot cross itself; a notch narrower than about
 *    twice the margin grows shut. A margin above 0 and below 1 px adds no
 *    pixel and is refused by name. This module does not raise a margin by
 *    itself: a margin that clips art is refused (`CONTOUR_COVERAGE`).
 * 4. **Interior vertices are declared**, never inferred: see
 *    {@link interiorCandidates} for the candidates and {@link KEEP_FRACTION}
 *    for the one rule that keeps or drops each. Where the outline passes
 *    through a region's support, points are inserted on the outline at the
 *    region's spacing ({@link outlineInRegions}, issue #110): exactly on its
 *    edges, so the outline encloses the same set and only gains vertices.
 * 5. **Triangulation**: rigc's `earClip` of the outline (clockwise on screen,
 *    as the outline is), made constrained
 *    Delaunay by flipping; then each kept point inserted in order — the
 *    triangle that holds it is split in three, or the two that share the edge
 *    it lies on in four — and the Delaunay condition restored by flipping
 *    interior edges only. An outline edge belongs to one triangle and is never
 *    flipped, so no triangle crosses the outline. A last pass over every edge
 *    flips whatever is still not locally Delaunay, and the report counts what
 *    is left (`nonDelaunayEdges`, 0 on every mesh this module returns).
 * 6. **Refusals**, each naming the part, the rule, the value found and the
 *    value required (the settled comment on issue #84, §1): coverage — any art
 *    pixel outside the mesh; overshoot — past `margin + tolerance + 1` px;
 *    budget; topology ({@link contourTopologyProblems}); islands; and the
 *    parameters themselves. Every problem found is returned at once.
 * 7. **The report** ({@link ContourReport}): what the settled comment's §2
 *    lists, measured on the mesh that would be written.
 *
 * ## What margin a tolerance needs — measured, not raised
 *
 * `bun tools/contour_survey.ts` sweeps tolerance x margin (0, 1, 1.5, 2, 2.5,
 * 3) over five generated shapes (a disc, a ~70° triangle, a two-horned
 * crescent, a 2 px spike, a diagonal bar). The smallest margin that covers
 * every art pixel, over the five: 0 at tolerance 0.5; 1 at tolerance 1 and
 * 1.5; 1.5 at 2; 3 at 3 (the crescent; the others 1.5). No cell refuses
 * overshoot, and along each row, once a margin passes every larger one in the
 * sweep passes: before simplification a grown pixel lies within the margin of
 * art by definition (selftest `CE09`), where rigc's offset moved an acute
 * corner up to 4 x margin. That is the sweep's shapes; on a real part a
 * larger margin can close a gap whose enclosure lies further from the art than
 * the bound, which the overshoot check refuses (the issue #106 survey: one
 * public part passes at margin 1 and refuses at 1.5). Hence the module never
 * adjusts a margin; it refuses, and the author's figures are the ones it ran
 * at.
 *
 * ## Exactness, and what happens at every tie
 *
 * Every coordinate this module produces is snapped to {@link GRID} — integer
 * multiples of 1/256 px — and every predicate that decides topology runs on
 * those integers: orientation in doubles, exact because a part is at most
 * {@link MAX_SIDE} px a side, so a coordinate difference is under 2^24 units,
 * a product under 2^48 and a difference of two products under 2^49 < 2^53;
 * in-circle and point-to-segment distance in `BigInt`, which is exact at any
 * size. On those coordinates rig-c's own float predicates (`earClip`,
 * `prunePolygon`, `findSelfIntersection`, with their 1e-9 and 1e-12 slacks)
 * are exact too: a non-zero cross product of two grid differences is at least
 * 2^-16 px², far above either slack. So no topological decision here is made
 * by rounding noise. The growth is exact too: a squared pixel distance, a whole
 * number, against the margin's exact binary value ({@link withinMarginSquared}),
 * and the pinch fill is a set operation on pixels. The ties, each decided by a
 * stated rule:
 *
 * - **in-circle = 0** (four cocircular points — every square of a grid): the
 *   edge is NOT flipped, so a cocircular quad keeps the diagonal it had, which
 *   the fixed insertion order decides.
 * - **a point exactly on an interior edge**: the two triangles sharing it are
 *   split into four. A point on an outline edge cannot occur: every kept point
 *   is at least its keep radius (≥ 1 grid unit) from the outline.
 * - **two candidates at once**: none — candidates are tried one at a time in a
 *   fixed order, and the first triangle in index order that holds a point is
 *   the one split.
 * - **keep radius exactly met**: kept (the rule is `≥`).
 * - **smallest angle / largest edge ratio**: the first triangle in output
 *   order with the extreme value.
 *
 * What is NOT exact, said where it is: the circle region's boundary samples use
 * `Math.cos` / `Math.sin`, which an engine need not round correctly, so a
 * different engine could move a sampled point by one grid unit where the
 * value lies within an ulp of a rounding boundary; rigc's
 * `simplifyClosedPolygon` (and `offsetPolygon`, for a polygon region's band)
 * use `Math.hypot`, the same kind of function; and the
 * report's angles use `Math.acos` (reported to 6 decimals, decide nothing). All
 * other arithmetic is IEEE `+ − × ÷ √`, which every conforming engine rounds the
 * same way. Two runs on one engine are byte-identical (selftest `CT20`).
 *
 * ## The output's order
 *
 * Vertices: the outline first, in rigc's walk order (the hull Spine needs:
 * `hull` is a count, and the first `hull` vertices are the outline, in order),
 * then the kept interior points in the order they were kept. The outline's
 * shape does not depend on the regions; its vertices do only where a region's
 * support reaches it, which inserts points on the edges there
 * ({@link outlineInRegions}). So adding a region whose support reaches no
 * outline edge renumbers no hull vertex (`CT21`, `CE14`); one whose support
 * does keeps every hull vertex, in the same cyclic order and position from
 * index 0, and moves a vertex's index only by the points inserted before it in
 * walk order (`CE13`). Triangles: built wound as the outline is (clockwise on
 * screen) — the triangulation's predicates are written for that winding —,
 * rotated to start at its smallest index, and sorted, so the list does not
 * depend on the order the flips happened in; then written with each triple's
 * last two corners swapped (`counterClockwiseInSpineWorld`, `src/mesh.ts`), so
 * every triangle is counter-clockwise in Spine world, the winding rig-c's
 * `MQ_ORIENTATION` and its `SourceMesh` read (issue #126). The y flip does not
 * turn a loop over: before the swap, rig-c 2.20.3 read every triangle of
 * every contour mesh on the three public examples as clockwise in Spine world
 * (2,553 of 2,553 on demo). The swap keeps the order of the list and the first
 * index of every triple, so it is exactly `[a, b, c]` → `[a, c, b]`. The
 * automatic mode hands these triangles to rig-c as they are.
 */
import { type Problem } from './errors.ts';
import { counterClockwiseInSpineWorld } from './mesh.ts';
import { connectedComponents, fillHoles, type Mask } from './raster/index.ts';
import {
  type AlphaMask,
  checkHullOrder,
  earClip,
  findSelfIntersection,
  measureAuthoredMeshFit,
  MeshError,
  offsetPolygon,
  prunePolygon,
  signedArea,
  simplifyClosedPolygon,
  traceAlphaOutline,
  traceOutline,
} from 'rig-c/mesh';

/** Grid units per pixel: every coordinate this module writes is an integer multiple of 1/GRID px. */
export const GRID = 256;

/**
 * The largest part side, in px, the exactness argument above holds for: a
 * coordinate is at most `MAX_SIDE * GRID` = 2^23 units and the outline may sit
 * up to a margin outside the window before the clamp, so every difference
 * stays under 2^24. A larger part is refused by name, not computed inexactly.
 */
export const MAX_SIDE = 32768;

/**
 * The keep rule's one constant — a de-duplication radius, not a quality
 * threshold. **Definition:** a candidate interior point with spacing `s` is
 * kept when it lies strictly inside the outline AND its distance to every
 * outline edge AND to every point already kept is at least
 * `KEEP_FRACTION × s`, that radius snapped to the {@link GRID}
 * (`round(KEEP_FRACTION × s × GRID)` units, which must be at least 1). Each
 * candidate is held to ITS OWN spacing's radius, so a background point keeps a
 * background distance from a region's fine points, and a region's points keep
 * a fine distance from each other.
 */
export const KEEP_FRACTION = 0.5;

/**
 * The largest keep radius, in grid units, whose square is exact in a double
 * (2^26, so the square is at most 2^52): a spacing of 2^19 = 524288 px.
 * Derived, not chosen — a larger spacing is refused, not computed inexactly.
 */
export const MAX_RADIUS = 2 ** 26;

/** A refinement region: a circle in part-image px. */
export interface ContourCircleRegion {
  name: string;
  shape: 'circle';
  /** Centre, part-image px, y down. */
  cx: number;
  cy: number;
  /** Radius, px. */
  r: number;
  /** Interior spacing inside the region and its band, px. */
  spacing: number;
  /** Width of the transition band around the region that gets the region's spacing too, px; 0 is no band. */
  band: number;
}

/** A refinement region: a simple polygon in part-image px, either winding. */
export interface ContourPolygonRegion {
  name: string;
  shape: 'polygon';
  points: Array<[number, number]>;
  spacing: number;
  band: number;
}

export type ContourRegion = ContourCircleRegion | ContourPolygonRegion;

export interface ContourParams {
  /** A pixel is art when its alpha is above this; a whole number in 0..254. */
  threshold: number;
  /** rigc's Douglas–Peucker tolerance, px, 0 or more (0 keeps every traced corner). */
  tolerance: number;
  /** rigc's outward offset, px, 0 or more. */
  margin: number;
  /** The background interior spacing, px, above 0. */
  spacing: number;
  /** Refuse a mesh with more vertices than this; absent is no budget. */
  budget?: number;
  /**
   * The largest island, in art pixels, that may be left out of the mesh (the
   * stray-island amendment on issue #84). Absent, a second island refuses as
   * the settled rule says; there is no default. See {@link strayIslands}.
   */
  stray?: number;
  /** Refinement regions, in the order their points are placed. */
  regions: readonly ContourRegion[];
  /**
   * How {@link contourFit} floods the background to find the filled
   * silhouette overshoot is measured from — rig-c's `measureAuthoredMeshFit`
   * `connectivity` (2.23.0, rigc#1262). Absent is 4, the fill the contour
   * mode has always read, and the report then carries no
   * `fitConnectivity`; `8` is the fill rig-c's `MQ_OVERSHOOT` row reads (P12),
   * so a background pocket joined to the outside only at a corner counts as
   * outside. The automatic mode's source declares 8 ({@link
   * AUTO_SOURCE_FIT_CONNECTIVITY} in `src/automesh.ts`).
   */
  fitConnectivity?: 4 | 8;
  /**
   * The chains a row of vertices is placed across, at each link joint and at
   * `stations` points between (issue #188; {@link placeRibs}). Absent or empty
   * places none, and the mesh is byte for byte the one it was before the field
   * existed.
   */
  ribs?: readonly ContourChainRibs[];
}

/**
 * One chain the ribs are placed along (issue #188): its link origins then its
 * tip, in part-image px, as the config declares them less the part's offset —
 * link k runs from `points[k]` to `points[k + 1]` — and the stations per link.
 */
export interface ContourChainRibs {
  chain: string;
  points: ReadonlyArray<readonly [number, number]>;
  /** Ribs between a link's origin and its end, evenly spaced; a whole number, 0 or more. */
  stations: number;
}

/** One rib as placed (issue #188): its name and its vertices, in mesh vertex indices, from one end across to the other. */
export interface ContourRib {
  name: string;
  vertices: number[];
}

/** A triangle and a figure measured on it, by its index in `triangles`. */
export interface TriangleFigure {
  triangle: number;
  value: number;
}

export interface ContourReport {
  /** Vertices on the outline — Spine's `hull`. */
  boundaryVertices: number;
  /** Kept interior points. */
  interiorVertices: number;
  /** Kept interior points by where they were declared: each region in order, then the background. */
  interiorBySource: Array<{ source: string; vertices: number }>;
  triangles: number;
  /** Corner-lattice vertices rigc's trace produced, before simplification. */
  tracedVertices: number;
  /** Pixels with alpha above the threshold. */
  artPixels: number;
  /** How many of them a triangle covers — rigc's `measureAuthoredMeshFit`: a pixel is covered when its centre is in or on a triangle. */
  coveredArtPixels: number;
  /** `coveredArtPixels / artPixels`, unrounded. */
  coverage: number;
  /** rigc's `measureAuthoredMeshFit` overshoot: the furthest a covered pixel's centre sits from the nearest pixel of the filled silhouette, px. */
  overshoot: number;
  /** `margin + tolerance + 1`, px — the settled bound overshoot is refused past. */
  overshootBound: number;
  /** The fill overshoot was read against, as declared in {@link ContourParams.fitConnectivity}; absent when none was declared (4, the contour mode's). */
  fitConnectivity?: 4 | 8;
  /** The area the outline encloses, px² (exact: the grid's shoelace sum). */
  meshArea: number;
  /** `meshArea − coveredArtPixels`, px²: the transparent area the mesh draws over. */
  enclosedTransparentArea: number;
  /** Transparent pixels enclosed by the island and filled into the outline (rigc's `holePixels`). */
  filledHolePixels: number;
  /** The smallest interior angle of any triangle, degrees (6 decimals), and that triangle. */
  smallestAngle: TriangleFigure;
  /** The largest longest-edge / shortest-edge ratio of any triangle (6 decimals), and that triangle. */
  largestEdgeRatio: TriangleFigure;
  /** Interior edges whose opposite vertex lies strictly inside the neighbouring circumcircle after the last pass — 0 when the triangulation is constrained Delaunay. */
  nonDelaunayEdges: number;
  /** Islands left out of the mesh under a declared `stray` figure — 0 when none is declared or none was left out. */
  strayIslands: number;
  /** The art pixels those islands hold; they are not meshed, so not drawn, and `artPixels` does not count them. */
  strayPixels: number;
  /**
   * Transparent pixels the margin's growth added round the filled silhouette
   * ({@link growSilhouette}): centre within `margin` of a pixel of it. The
   * silhouette the outline is traced from holds, each pixel counted once:
   * `artPixels` + `filledHolePixels` + `grownPixels` + `pinchFilledPixels` +
   * `grownHolePixels`.
   */
  grownPixels: number;
  /** Transparent pixels the pinch fill added after the growth — both clear pixels of every pinch the growth made. */
  pinchFilledPixels: number;
  /** Transparent pixels the grown silhouette encloses without holding them (a notch the growth closed), which the trace fills — rigc's `holePixels` of that trace. Not the art's own holes, which are `filledHolePixels`. */
  grownHolePixels: number;
  /** Only when ribs were declared (issue #188): every rib, in placement order, with its vertices. Absent otherwise, so a mesh without ribs reports what it always reported. */
  ribs?: ContourRib[];
}

export interface ContourMesh {
  /** Part-image px, y down, every value a multiple of 1/{@link GRID}; the first `hull` are the outline, in walk order. */
  vertices: Array<[number, number]>;
  /** Three vertex indices per triangle. */
  triangles: number[];
  hull: number;
  report: ContourReport;
  /**
   * The mask the mesh was traced and measured on: the input mask with every island left out under a declared
   * `stray` set to alpha 0 (issue #172), so a reader of the mesh's art reads the art the trace read. When nothing
   * was left out it is the input mask itself, the same object, so nothing downstream of a part without stray moves.
   */
  mask: AlphaMask;
  /** Only when ribs were declared (issue #188): the report's list, the same objects. */
  ribs?: ContourRib[];
}

// ---------------------------------------------------------------------------
// the parameters
// ---------------------------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The keep radius of a spacing, in grid units. */
export function keepRadius(spacing: number): number {
  return Math.round(KEEP_FRACTION * spacing * GRID);
}

/** Every problem with the mask and the parameters, before anything is traced. */
function parameterProblems(part: string, mask: AlphaMask, p: ContourParams): Problem[] {
  const out: Problem[] = [];
  const bad = (field: string, detail: string): void => {
    out.push({ code: 'CONTOUR_PARAMETER', object: `contour mesh "${part}", ${field}`, detail });
  };
  const { width: w, height: h } = mask;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE) {
    bad('mask', `is ${w}x${h}; whole numbers from 1 to ${MAX_SIDE} px a side are required (the exact predicates are proved up to that size)`);
  } else if (mask.alpha.length !== w * h) {
    bad('mask', `holds ${mask.alpha.length} alpha bytes for a ${w}x${h} part; ${w * h} are required`);
  }
  if (!Number.isInteger(p.threshold) || p.threshold < 0 || p.threshold > 254) bad('threshold', `is ${p.threshold}; a whole number in 0..254 is required (art is alpha above it)`);
  if (!finite(p.tolerance) || p.tolerance < 0) bad('tolerance', `is ${p.tolerance}; a number of px, 0 or more, is required`);
  if (!finite(p.margin) || p.margin < 0) bad('margin', `is ${p.margin}; a number of px, 0 or more, is required`);
  else if (p.margin > 0 && p.margin < 1) bad('margin', `is ${p.margin}; 0, or 1 px or more, is required — the silhouette grows by the pixels whose centre lies within the margin of an art pixel's centre, and no centre lies closer than 1 px, so a margin under 1 px adds nothing`);
  const spacingOk = (field: string, s: number): void => {
    if (!finite(s) || s <= 0) bad(field, `is ${s}; a number of px above 0 is required`);
    else if (keepRadius(s) < 1) bad(field, `is ${s}; its keep radius ${KEEP_FRACTION} x ${s} px snaps to 0 grid units of 1/${GRID} px, and at least 1 is required`);
    else if (keepRadius(s) > MAX_RADIUS) bad(field, `is ${s}; its keep radius is ${keepRadius(s)} grid units, past the ${MAX_RADIUS} (${MAX_RADIUS / GRID} px) whose square is exact in a double`);
  };
  spacingOk('spacing', p.spacing);
  if (p.budget !== undefined && (!Number.isInteger(p.budget) || p.budget < 3)) bad('budget', `is ${p.budget}; a whole number of vertices, 3 or more, is required`);
  if (p.fitConnectivity !== undefined && p.fitConnectivity !== 4 && p.fitConnectivity !== 8) bad('fitConnectivity', `is ${JSON.stringify(p.fitConnectivity)}; 4 or 8 is required (how the background is flooded when overshoot is measured)`);
  if (p.stray !== undefined && (!Number.isInteger(p.stray) || p.stray < 0)) bad('stray', `is ${p.stray}; a whole number of art pixels, 0 or more, is required (the largest island that may be left out)`);
  ribProblems(part, p, out);
  const names = new Set<string>();
  p.regions.forEach((r, i) => {
    const at = `regions[${i}]`;
    if (typeof r.name !== 'string' || r.name === '') bad(`${at}.name`, `is ${JSON.stringify(r.name)}; a non-empty name is required`);
    else if (names.has(r.name)) bad(`${at}.name`, `"${r.name}" is declared twice; each region needs its own name`);
    else names.add(r.name);
    spacingOk(`${at}.spacing`, r.spacing);
    if (!finite(r.band) || r.band < 0) bad(`${at}.band`, `is ${r.band}; a number of px, 0 or more, is required`);
    if (r.shape === 'circle') {
      if (!finite(r.cx) || !finite(r.cy)) bad(`${at}`, `centre (${r.cx}, ${r.cy}); finite px are required`);
      if (!finite(r.r) || r.r <= 0) bad(`${at}.r`, `is ${r.r}; a radius of px above 0 is required`);
    } else if (r.shape === 'polygon') {
      if (!Array.isArray(r.points) || r.points.length < 3 || !r.points.every((q) => Array.isArray(q) && q.length === 2 && finite(q[0]) && finite(q[1]))) {
        bad(`${at}.points`, `has ${Array.isArray(r.points) ? r.points.length : 'no'} point(s); 3 or more [x, y] pairs of finite px are required`);
      } else {
        const ring = r.points.map(([x, y]) => [x, y] as [number, number]);
        const crossing = findSelfIntersection(ring);
        if (Math.abs(signedArea(ring)) === 0) bad(`${at}.points`, 'enclose no area; a simple polygon is required');
        else if (crossing !== null) bad(`${at}.points`, `edge ${crossing[0]} meets edge ${crossing[1]}; a simple polygon (no edge touching another) is required`);
        else if (finite(r.band) && r.band > 0 && findSelfIntersection(bandRing(ring, r.band)) !== null) {
          const c = findSelfIntersection(bandRing(ring, r.band)) as [number, number];
          bad(`${at}.band`, `${r.band} px pushed out of the polygon by rigc's offsetPolygon crosses itself (edge ${c[0]} meets edge ${c[1]}); a band the polygon can be offset by without crossing is required`);
        }
      }
    } else {
      bad(`${at}.shape`, `is ${JSON.stringify((r as { shape: unknown }).shape)}; "circle" or "polygon" is required`);
    }
  });
  return out;
}

/** A polygon wound clockwise on screen (positive `signedArea`), rigc's `offsetPolygon`'s requirement. */
function clockwise(ring: Array<[number, number]>): Array<[number, number]> {
  return signedArea(ring) > 0 ? ring : [...ring].reverse();
}

/** The outer edge of a polygon region's band: rigc's `offsetPolygon` by `band`, on the clockwise ring. */
function bandRing(ring: Array<[number, number]>, band: number): Array<[number, number]> {
  return offsetPolygon(clockwise(ring), band);
}

// ---------------------------------------------------------------------------
// exact predicates on grid units
// ---------------------------------------------------------------------------

/** Twice the signed area of a, b, c in grid units: exact in doubles below 2^24 units a difference. */
function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/**
 * The in-circle determinant of d against a, b, c, in `BigInt`. Positive when d
 * is strictly inside the circle through a, b, c and `orient(a, b, c) > 0`;
 * zero when the four are cocircular.
 */
export function inCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): bigint {
  const adx = BigInt(ax - dx);
  const ady = BigInt(ay - dy);
  const bdx = BigInt(bx - dx);
  const bdy = BigInt(by - dy);
  const cdx = BigInt(cx - dx);
  const cdy = BigInt(cy - dy);
  return (
    (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) +
    (bdx * bdx + bdy * bdy) * (cdx * ady - adx * cdy) +
    (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady)
  );
}

/** Is the squared distance from p to the segment a–b at least `r2`? Exact, in grid units. */
function farFromSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number, r2: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const vx = px - ax;
  const vy = py - ay;
  const along = vx * dx + vy * dy;
  const len2 = dx * dx + dy * dy;
  if (along <= 0) return vx * vx + vy * vy >= r2;
  if (along >= len2) return (px - bx) * (px - bx) + (py - by) * (py - by) >= r2;
  // Inside the span: distance² = cross² / len2, compared without dividing.
  const cross = BigInt(dx * vy - dy * vx);
  return cross * cross >= BigInt(r2) * BigInt(len2);
}

/** Is p strictly inside the closed ring (even–odd crossing rule, exact on grid units)? A point on an edge is not asked. */
function insideRing(px: number, py: number, xs: readonly number[], ys: readonly number[]): boolean {
  let inside = false;
  const n = xs.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ay = ys[j];
    const by = ys[i];
    if (ay > py === by > py) continue;
    const o = orient(xs[j], ay, xs[i], by, px, py);
    if (by > ay ? o > 0 : o < 0) inside = !inside;
  }
  return inside;
}

/** The same rule in plain doubles, for a region's own shape (a membership test, not topology). */
function insideFloatRing(px: number, py: number, ring: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    if (ay > py === by > py) continue;
    const o = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (by > ay ? o > 0 : o < 0) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// interior candidates
// ---------------------------------------------------------------------------

/** One candidate interior point: grid units, the keep radius it is held to, and where it was declared. */
export interface Candidate {
  x: number;
  y: number;
  radius: number;
  source: string;
}

const snap = (v: number): number => Math.round(v * GRID);

/** Points along a closed ring, `ceil(edge length / spacing)` per edge (at least 1), starting at each edge's first vertex. */
function alongRing(ring: ReadonlyArray<readonly [number, number]>, spacing: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let k = 0; k < ring.length; k++) {
    const [ax, ay] = ring[k];
    const [bx, by] = ring[(k + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)) / spacing));
    for (let m = 0; m < n; m++) out.push([ax + ((bx - ax) * m) / n, ay + ((by - ay) * m) / n]);
  }
  return out;
}

/** `max(3, ceil(2πr / spacing))` points round a circle, from angle 0 (+x), increasing (clockwise on screen). */
function alongCircle(cx: number, cy: number, r: number, spacing: number): Array<[number, number]> {
  const n = Math.max(3, Math.ceil((2 * Math.PI * r) / spacing));
  const out: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return out;
}

/** The grid points `(i·s, j·s)` inside a box, row-major. */
function gridIn(x0: number, y0: number, x1: number, y1: number, s: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let j = Math.ceil(y0 / s); j * s <= y1; j++) for (let i = Math.ceil(x0 / s); i * s <= x1; i++) out.push([i * s, j * s]);
  return out;
}

/**
 * Every candidate interior point, in the order the keep rule tries them:
 *
 * 1. each region, in the order declared: points along its boundary at its
 *    spacing; then points along the outer edge of its band at its spacing
 *    (when the band is above 0); then the points `(i·s, j·s)` of its own
 *    spacing's grid, anchored at the part image's origin, that lie in the
 *    region or its band, row-major. A circle's band edge is the circle of
 *    radius `r + band`; a polygon's is rigc's `offsetPolygon` of it by `band`
 *    (mitred, clamped), and "in the band" means inside that ring;
 * 2. the background: `(i·s, j·s)` for the background spacing over the whole
 *    part image, row-major.
 *
 * Each is snapped to the {@link GRID}; nothing here looks at the art.
 */
export function interiorCandidates(width: number, height: number, params: ContourParams): Candidate[] {
  const out: Candidate[] = [];
  const add = (pts: Array<[number, number]>, spacing: number, source: string): void => {
    const radius = keepRadius(spacing);
    for (const [x, y] of pts) out.push({ x: snap(x), y: snap(y), radius, source });
  };
  for (const r of params.regions) {
    const source = `region "${r.name}"`;
    if (r.shape === 'circle') {
      const outer = r.r + r.band;
      add(alongCircle(r.cx, r.cy, r.r, r.spacing), r.spacing, source);
      if (r.band > 0) add(alongCircle(r.cx, r.cy, outer, r.spacing), r.spacing, source);
      add(
        gridIn(r.cx - outer, r.cy - outer, r.cx + outer, r.cy + outer, r.spacing).filter(([x, y]) => (x - r.cx) * (x - r.cx) + (y - r.cy) * (y - r.cy) <= outer * outer),
        r.spacing,
        source,
      );
    } else {
      const ring = r.points.map(([x, y]) => [x, y] as [number, number]);
      const edge = r.band > 0 ? bandRing(ring, r.band) : ring;
      add(alongRing(ring, r.spacing), r.spacing, source);
      if (r.band > 0) add(alongRing(edge, r.spacing), r.spacing, source);
      const xs = edge.map((q) => q[0]);
      const ys = edge.map((q) => q[1]);
      add(gridIn(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), r.spacing).filter(([x, y]) => insideFloatRing(x, y, edge)), r.spacing, source);
    }
  }
  add(gridIn(0, 0, width, height, params.spacing), params.spacing, 'background');
  return out;
}

// ---------------------------------------------------------------------------
// the outline inside a region's support
// ---------------------------------------------------------------------------

/** The greatest common divisor of two whole numbers, by Euclid. */
function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

/**
 * The parameter intervals `[t0, t1]` (0 ≤ t0 < t1 ≤ 1) over which the segment
 * a → b (px) lies in a region's support — the region and its band, the set
 * {@link interiorCandidates} fills: for a circle the disc of radius `r + band`;
 * for a polygon the inside of its band ring (rigc's `offsetPolygon` by `band`),
 * or of the polygon itself when the band is 0.
 */
function supportIntervals(ax: number, ay: number, bx: number, by: number, r: ContourRegion): Array<[number, number]> {
  const dx = bx - ax;
  const dy = by - ay;
  if (r.shape === 'circle') {
    const R = r.r + r.band;
    const fx = ax - r.cx;
    const fy = ay - r.cy;
    const A = dx * dx + dy * dy;
    const B = 2 * (fx * dx + fy * dy);
    const disc = B * B - 4 * A * (fx * fx + fy * fy - R * R);
    if (disc <= 0) return [];
    const sq = Math.sqrt(disc);
    const t0 = Math.max(0, (-B - sq) / (2 * A));
    const t1 = Math.min(1, (-B + sq) / (2 * A));
    return t0 < t1 ? [[t0, t1]] : [];
  }
  const poly = r.points.map(([x, y]) => [x, y] as [number, number]);
  const ring = r.band > 0 ? bandRing(poly, r.band) : poly;
  const ts = [0, 1];
  for (let k = 0; k < ring.length; k++) {
    const [cx, cy] = ring[k];
    const [ex, ey] = ring[(k + 1) % ring.length];
    const den = dx * (ey - cy) - dy * (ex - cx);
    if (den === 0) continue;
    const t = ((cx - ax) * (ey - cy) - (cy - ay) * (ex - cx)) / den;
    const u = ((cx - ax) * dy - (cy - ay) * dx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((p, q) => p - q);
  const out: Array<[number, number]> = [];
  for (let k = 0; k + 1 < ts.length; k++) {
    const [u, v] = [ts[k], ts[k + 1]];
    if (!(u < v) || !insideFloatRing(ax + ((u + v) / 2) * dx, ay + ((u + v) / 2) * dy, ring)) continue;
    const last = out[out.length - 1];
    if (last !== undefined && last[1] === u) last[1] = v;
    else out.push([u, v]);
  }
  return out;
}

/**
 * The outline with points inserted where it passes through a region's support
 * (issue #110). A region's weight ramps from 1 to 0 across its band; where an
 * outline edge crosses that ramp, the art beside the edge is held by the
 * edge's two ends alone (no interior point may sit within its keep radius of
 * the outline), so one long edge with one end at g = 1 and the other at g = 0
 * spreads the region's motion over its whole length. Measured on a public
 * part (demo/hair_front, issue #110): a 35 px edge through a radius-11 region
 * held the worst local pixel in every pose. The outline is therefore sampled
 * there the way the region's own boundary is:
 *
 * - **On the edge, exactly.** The outline's vertices are on the {@link GRID};
 *   the grid points ON an edge a → b are `a + j (b − a) / G`, j = 0..G, with
 *   G the greatest common divisor of the edge's two grid-unit differences.
 *   Every point inserted is one of them, so it is collinear with its edge
 *   exactly and the outline encloses the same set as before: coverage,
 *   overshoot, area and every interior point's keep test are unchanged by it.
 * - **Rule.** For each outline edge, in walk order, and each region, in the
 *   order declared: the intervals `[t0, t1]` of the edge inside the region's
 *   support ({@link supportIntervals}), their ends taken to the nearest grid
 *   points on the edge, `j0 = round(t0 G)` and `j1 = round(t1 G)`; that span
 *   is cut into `k = max(1, ceil(length × (j1 − j0) / G / spacing))` equal
 *   parts at the region's spacing (as {@link interiorCandidates} samples a
 *   region's boundary, `ceil(length / spacing)` per edge), and every cut
 *   `j0 + round(m (j1 − j0) / k)`, m = 0..k, strictly between the edge's
 *   ends (0 < j < G) is a candidate. Reading the span on the grid first makes
 *   the count exact where the span is: on an axis-aligned edge a 16 px span at
 *   spacing 4 is 4 parts, not 5 because a square root rounded up (selftest
 *   `CE10`; the mutant that counts the float span is caught there).
 * - **Kept** by the keep rule's own radius ({@link KEEP_FRACTION} × the
 *   region's spacing): a candidate at least that far from the edge's two ends
 *   and from every point already inserted on the outline, in walk order and,
 *   on one edge, in order of `j` (regions in declared order at a tie).
 *
 * What is not exact: the intervals use `Math.sqrt` (a circle) or rigc's
 * `offsetPolygon` (a polygon's band), so an engine that rounds a square root
 * differently could move a span's end by one grid step, and so a cut, or the
 * count `k` where `length × span / spacing` lies within an ulp of a whole
 * number on a slanted edge (`length` is a square root there); every position written is
 * an exact grid point on the edge whatever `j` is. **The hull's order:** every
 * vertex of the outline without regions is in the outline with them, in the
 * same cyclic order at the same position, and the first one (index 0) is
 * first; an inserted point sits between the two ends of its edge. A hull
 * vertex is renumbered only by the inserted points before it in walk order —
 * none when no region's support reaches the outline, which then is the same
 * list (selftest `CE14`).
 */
export function outlineInRegions(outline: ReadonlyArray<readonly [number, number]>, regions: readonly ContourRegion[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const placed: Array<{ x: number; y: number }> = [];
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = outline[i];
    const [bx, by] = outline[(i + 1) % n];
    out.push([ax, ay]);
    if (regions.length === 0) continue;
    const A = { x: snap(ax), y: snap(ay) };
    const B = { x: snap(bx), y: snap(by) };
    const G = gcd(B.x - A.x, B.y - A.y);
    if (G === 0) continue;
    const length = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
    const cands: Array<{ j: number; radius: number }> = [];
    for (const r of regions) {
      const radius = keepRadius(r.spacing);
      for (const [t0, t1] of supportIntervals(ax, ay, bx, by, r)) {
        const j0 = Math.round(t0 * G);
        const j1 = Math.round(t1 * G);
        if (j1 <= j0) continue;
        const k = Math.max(1, Math.ceil(((j1 - j0) * length) / G / r.spacing));
        for (let m = 0; m <= k; m++) {
          const j = j0 + Math.round((m * (j1 - j0)) / k);
          if (j > 0 && j < G) cands.push({ j, radius });
        }
      }
    }
    cands.sort((p, q) => p.j - q.j);
    for (const c of cands) {
      const x = A.x + (c.j * (B.x - A.x)) / G;
      const y = A.y + (c.j * (B.y - A.y)) / G;
      const r2 = c.radius * c.radius;
      const far = (q: { x: number; y: number }): boolean => (q.x - x) * (q.x - x) + (q.y - y) * (q.y - y) >= r2;
      if (!far(A) || !far(B) || !placed.every(far)) continue;
      placed.push({ x, y });
      out.push([x / GRID, y / GRID]);
    }
  }
  return out;
}

/**
 * The keep rule ({@link KEEP_FRACTION}) over the candidates in order, against
 * an outline in grid units. Exact: inside by the crossing rule on integers,
 * distances compared squared, in `BigInt` where a product could pass 2^53.
 */
export function keepPoints(hx: readonly number[], hy: readonly number[], candidates: readonly Candidate[], ribs: ReadonlyArray<readonly [number, number, number, number]> = []): Candidate[] {
  const kept: Candidate[] = [];
  const n = hx.length;
  for (const c of candidates) {
    const r2 = c.radius * c.radius;
    if (!insideRing(c.x, c.y, hx, hy)) continue;
    let ok = true;
    for (let i = 0; i < n && ok; i++) ok = farFromSegment(c.x, c.y, hx[i], hy[i], hx[(i + 1) % n], hy[(i + 1) % n], r2);
    // issue #188: a rib is held like the outline — no candidate within its keep radius of one, so nothing sits on a rib's row.
    for (let i = 0; i < ribs.length && ok; i++) ok = farFromSegment(c.x, c.y, ribs[i][0], ribs[i][1], ribs[i][2], ribs[i][3], r2);
    for (let k = 0; k < kept.length && ok; k++) {
      const dx = c.x - kept[k].x;
      const dy = c.y - kept[k].y;
      ok = dx * dx + dy * dy >= r2;
    }
    if (ok) kept.push(c);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// ribs along a chain (issue #188)
// ---------------------------------------------------------------------------

/**
 * The declared ribs' own problems, before anything is traced: the shape of
 * each entry (`CONTOUR_PARAMETER`), and each link that cannot carry a rib
 * (`CONTOUR_RIB_LINK`) — one shorter than the outline's `tolerance` (or of no
 * length), where a row would sit within the outline's own simplification error
 * of the next, and a joint where the chain turns straight back on itself,
 * which has no direction across it.
 */
function ribProblems(part: string, p: ContourParams, out: Problem[]): void {
  const object = `contour mesh "${part}"`;
  const names = new Set<string>();
  (p.ribs ?? []).forEach((rb, i) => {
    const at = `${object}, ribs[${i}]`;
    if (typeof rb.chain !== 'string' || rb.chain === '' || names.has(rb.chain)) {
      out.push({ code: 'CONTOUR_PARAMETER', object: `${at}.chain`, detail: `is ${JSON.stringify(rb.chain)}; a chain name, non-empty and given once, is required` });
    } else names.add(rb.chain);
    if (!Number.isInteger(rb.stations) || rb.stations < 0) out.push({ code: 'CONTOUR_PARAMETER', object: `${at}.stations`, detail: `is ${rb.stations}; a whole number, 0 or more, is required (the ribs between a link's origin and its end)` });
    const pts = rb.points;
    if (!Array.isArray(pts) || pts.length < 2 || !pts.every((q) => Array.isArray(q) && q.length === 2 && finite(q[0]) && finite(q[1]))) {
      out.push({ code: 'CONTOUR_PARAMETER', object: `${at}.points`, detail: `has ${Array.isArray(pts) ? pts.length : 'no'} point(s); the chain's points and its tip, 2 or more finite [x, y] pairs, are required` });
      return;
    }
    const unit: Array<[number, number]> = [];
    for (let k = 0; k + 1 < pts.length; k++) {
      const dx = pts[k + 1][0] - pts[k][0];
      const dy = pts[k + 1][1] - pts[k][1];
      const len = Math.sqrt(dx * dx + dy * dy);
      unit.push(len > 0 ? [dx / len, dy / len] : [0, 0]);
      if (!(len > 0) || len < p.tolerance) {
        out.push({
          code: 'CONTOUR_RIB_LINK',
          object: `${object}, chain "${rb.chain}" link ${k}`,
          detail: `runs ${len} px from (${pts[k][0]}, ${pts[k][1]}) to ${k + 2 < pts.length ? `points[${k + 1}]` : 'the tip'} (${pts[k + 1][0]}, ${pts[k + 1][1]}); a link longer than 0 and at least the outline tolerance ${p.tolerance} px (contour.tolerance, or auto.source.tolerance) is required — a row of vertices closer than that to the next sits inside the outline's own simplification error`,
        });
      }
    }
    for (let k = 1; k < unit.length; k++) {
      if (unit[k - 1][0] + unit[k][0] === 0 && unit[k - 1][1] + unit[k][1] === 0 && (unit[k][0] !== 0 || unit[k][1] !== 0)) {
        out.push({ code: 'CONTOUR_RIB_LINK', object: `${object}, chain "${rb.chain}" link ${k}`, detail: `turns straight back along link ${k - 1} at (${pts[k][0]}, ${pts[k][1]}), so the joint has no direction across it; a chain that does not fold back on itself is required` });
      }
    }
  });
}

/** Do the closed segments a–b and c–d (grid units) meet — cross or touch? Exact: orientations of grid integers. */
function segmentsMeet(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o1 = Math.sign(orient(ax, ay, bx, by, cx, cy));
  const o2 = Math.sign(orient(ax, ay, bx, by, dx, dy));
  const o3 = Math.sign(orient(cx, cy, dx, dy, ax, ay));
  const o4 = Math.sign(orient(cx, cy, dx, dy, bx, by));
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  const on = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): boolean => Math.min(px, qx) <= rx && rx <= Math.max(px, qx) && Math.min(py, qy) <= ry && ry <= Math.max(py, qy);
  return (o1 === 0 && on(ax, ay, bx, by, cx, cy)) || (o2 === 0 && on(ax, ay, bx, by, dx, dy)) || (o3 === 0 && on(cx, cy, dx, dy, ax, ay)) || (o4 === 0 && on(cx, cy, dx, dy, bx, by));
}

/** Where the ribs went (issue #188): the outline with their ends on it, their interior points, and their rows. */
export interface RibPlacement {
  /** The outline (px) with every rib's two ends inserted on the edge each lands on. */
  outline: Array<[number, number]>;
  /** The ribs' interior points, grid units, in rib order: they are the first interior vertices, from index `outline.length`. */
  points: Candidate[];
  /** Each rib's segment from end to end, grid units: no other interior point is kept within its keep radius of one. */
  segments: Array<[number, number, number, number]>;
  /** Each rib's vertices, end to end, in the mesh's vertex indices. */
  ribs: ContourRib[];
}

/**
 * The ribs of every declared chain (issue #188): a row of vertices across the
 * part at each link joint and at `stations` points between, placed on the
 * outline the mode traced. **The rule**, in part-image px (y down):
 *
 * 1. **Where.** Link k runs from `points[k]` to `points[k + 1]` (the last to
 *    the tip). Each link carries a rib at its origin (station 0) and at
 *    `points[k] + m/(stations + 1) · (points[k + 1] − points[k])`, m =
 *    1..stations — so a chain of L links carries L × (stations + 1) ribs, in
 *    chain order, then link, then station. The tip carries none: it is the
 *    strand's end, which the outline already holds.
 * 2. **Across.** The rib's direction d is the link's at a station and at the
 *    chain's root; at a joint between two links it is the sum of the two
 *    links' unit directions, the bisector of the bend. The rib is the line
 *    through the point along n = (−d_y, d_x) / |d|.
 * 3. **Clipped to the art.** The point must be on the part's art — its pixel
 *    (the floor of each coordinate) has alpha above the threshold — and
 *    strictly inside the outline (`CONTOUR_RIB_ART` otherwise: a rib that
 *    leaves the art entirely). From it the line runs both ways to the first
 *    point where it meets the outline (an edge or a vertex); those two points,
 *    snapped to the {@link GRID}, are the rib's ends. The outline is the art
 *    at the mode's threshold, holes filled, grown by the margin and simplified
 *    at the tolerance; a rib's ends are on it because a vertex off it would be
 *    no part of the mesh's boundary.
 * 4. **The ends join the outline.** Each end is inserted between the two ends
 *    of the outline edge it lands on (in order along the edge), or is that
 *    edge's vertex when it snaps onto one. Snapping moves an end off its edge
 *    by at most half a grid unit, 1/512 px; the outline is then held to every
 *    check it always was (self-intersection here, coverage and overshoot on the
 *    mesh), so a move that mattered is refused, not hidden.
 * 5. **Between the ends**, at the mode's background spacing s: the rib's own
 *    point (the joint or the station, snapped to the grid) is an interior
 *    vertex, and each half — from an end to the point — of length ℓ is cut
 *    into k = max(1, ⌈ℓ / s⌉) equal parts, whose k − 1 cuts, each snapped,
 *    are interior vertices too. So the joint itself is on its row, where the
 *    two links' weights meet. Each must lie inside the outline at least one
 *    grid unit from every outline edge (`CONTOUR_RIB_ART` otherwise).
 * 6. **No two ribs meet** — cross, touch or share an end, ends as snapped
 *    (`CONTOUR_RIB_CROSSING`, naming both): two rows through one point are no
 *    longer two cross-sections.
 *
 * The triangulation then makes every consecutive pair of a rib an edge and
 * never flips it ({@link Triangulation.constrain}), and keeps every other
 * interior point at least its keep radius from every rib ({@link keepPoints}),
 * so each rib is a row of edges across the strand. Nothing here reads a weight.
 */
export function placeRibs(part: string, outline: ReadonlyArray<readonly [number, number]>, mask: AlphaMask, art: Mask, params: ContourParams): RibPlacement | Problem[] {
  const object = `contour mesh "${part}"`;
  const out: Problem[] = [];
  const n = outline.length;
  const hx = outline.map((q) => snap(q[0]));
  const hy = outline.map((q) => snap(q[1]));
  interface Hit { edge: number; u: number; x: number; y: number }
  interface Planned { name: string; qx: number; qy: number; lo: Hit; hi: Hit }
  const planned: Planned[] = [];
  for (const rb of params.ribs ?? []) {
    const P = rb.points;
    const unit = (k: number): [number, number] => {
      const dx = P[k + 1][0] - P[k][0];
      const dy = P[k + 1][1] - P[k][1];
      const len = Math.sqrt(dx * dx + dy * dy);
      return [dx / len, dy / len];
    };
    for (let k = 0; k + 1 < P.length; k++) {
      for (let m = 0; m <= rb.stations; m++) {
        const name = `rib ${rb.chain} link ${k} station ${m}`;
        let qx: number;
        let qy: number;
        let dx: number;
        let dy: number;
        if (m === 0) {
          [qx, qy] = [P[k][0], P[k][1]];
          if (k === 0) [dx, dy] = unit(0);
          else {
            const a = unit(k - 1);
            const b = unit(k);
            [dx, dy] = [a[0] + b[0], a[1] + b[1]];
          }
        } else {
          const t = m / (rb.stations + 1);
          [qx, qy] = [P[k][0] + (P[k + 1][0] - P[k][0]) * t, P[k][1] + (P[k + 1][1] - P[k][1]) * t];
          [dx, dy] = unit(k);
        }
        const dl = Math.sqrt(dx * dx + dy * dy);
        const nx = -dy / dl;
        const ny = dx / dl;
        const px = Math.floor(qx);
        const py = Math.floor(qy);
        const inWindow = px >= 0 && py >= 0 && px < art.width && py < art.height;
        const onArt = inWindow && art.data[py * art.width + px] !== 0;
        if (!onArt || !insideRing(snap(qx), snap(qy), hx, hy)) {
          out.push({
            code: 'CONTOUR_RIB_ART',
            object: `${object}, ${name}`,
            detail: `${m === 0 ? (k === 0 ? "the chain's root" : 'the joint') : `station ${m} of the link`} is at (${qx}, ${qy}) in the part image (${inWindow ? `pixel (${px}, ${py}), alpha ${mask.alpha[py * art.width + px]}` : `outside its ${art.width}x${art.height} px`})${onArt ? ', on the art but not inside the outline' : `, not art (alpha above ${params.threshold})`}; a rib is the part's cross-section through the chain, so its point must lie on the part's art, inside the outline — move the chain onto the part, or leave the chain "${rb.chain}" out of ribs`,
          });
          continue;
        }
        let lo: Hit | null = null;
        let hi: Hit | null = null;
        let loS = -Infinity;
        let hiS = Infinity;
        for (let i = 0; i < n; i++) {
          const [ax, ay] = outline[i];
          const [bx, by] = outline[(i + 1) % n];
          const ex = bx - ax;
          const ey = by - ay;
          const den = nx * ey - ny * ex;
          if (den === 0) continue;
          const wx = ax - qx;
          const wy = ay - qy;
          const s = (wx * ey - wy * ex) / den;
          const u = (wx * ny - wy * nx) / den;
          if (u < 0 || u > 1 || s === 0) continue;
          if (s > 0 && s < hiS) [hiS, hi] = [s, { edge: i, u, x: snap(qx + s * nx), y: snap(qy + s * ny) }];
          if (s < 0 && s > loS) [loS, lo] = [s, { edge: i, u, x: snap(qx + s * nx), y: snap(qy + s * ny) }];
        }
        if (lo === null || hi === null) {
          out.push({ code: 'CONTOUR_RIB_ART', object: `${object}, ${name}`, detail: `the line across the chain at (${qx}, ${qy}) meets the outline on ${lo === null && hi === null ? 'neither side' : 'one side only'}; a point inside the outline is required` });
          continue;
        }
        planned.push({ name, qx: snap(qx), qy: snap(qy), lo, hi });
      }
    }
  }
  if (out.length > 0) return out;
  for (let i = 0; i < planned.length; i++) {
    for (let j = i + 1; j < planned.length; j++) {
      const a = planned[i];
      const b = planned[j];
      if (segmentsMeet(a.lo.x, a.lo.y, a.hi.x, a.hi.y, b.lo.x, b.lo.y, b.hi.x, b.hi.y)) {
        out.push({
          code: 'CONTOUR_RIB_CROSSING',
          object: `${object}, ${a.name}`,
          detail: `from (${a.lo.x / GRID}, ${a.lo.y / GRID}) to (${a.hi.x / GRID}, ${a.hi.y / GRID}) meets ${b.name}, from (${b.lo.x / GRID}, ${b.lo.y / GRID}) to (${b.hi.x / GRID}, ${b.hi.y / GRID}); ribs that cross, touch or share an end are required to be apart — two rows through one point are not two cross-sections (fewer stations, or a chain that bends less sharply inside a wide part)`,
        });
      }
    }
  }
  if (out.length > 0) return out;

  // The ends onto the outline, edge by edge, in order along each edge (rib, then the lo end first, at a tie).
  const onEdge: Array<Array<{ u: number; x: number; y: number; rib: number; side: 0 | 1 }>> = Array.from({ length: n }, () => []);
  planned.forEach((r, k) => {
    onEdge[r.lo.edge].push({ u: r.lo.u, x: r.lo.x, y: r.lo.y, rib: k, side: 0 });
    onEdge[r.hi.edge].push({ u: r.hi.u, x: r.hi.x, y: r.hi.y, rib: k, side: 1 });
  });
  const next: Array<[number, number]> = [];
  const start: number[] = [];
  const endAt = planned.map(() => [-1, -1]);
  const toNext: Array<{ rib: number; side: 0 | 1; edge: number }> = [];
  for (let i = 0; i < n; i++) {
    start.push(next.length);
    next.push([outline[i][0], outline[i][1]]);
    const list = onEdge[i].sort((p, q) => p.u - q.u || p.rib - q.rib || p.side - q.side);
    for (const e of list) {
      const j = (i + 1) % n;
      if (e.x === hx[i] && e.y === hy[i]) endAt[e.rib][e.side] = start[i];
      else if (e.x === hx[j] && e.y === hy[j]) toNext.push({ rib: e.rib, side: e.side, edge: j });
      else {
        endAt[e.rib][e.side] = next.length;
        next.push([e.x / GRID, e.y / GRID]);
      }
    }
  }
  for (const t of toNext) endAt[t.rib][t.side] = start[t.edge];
  if (signedArea(next) <= 0 || findSelfIntersection(next) !== null) {
    const c = findSelfIntersection(next);
    return [{ code: 'CONTOUR_SELF_INTERSECTION', object, detail: `with the ribs' ends put on it, its outline ${c === null ? 'encloses no positive area' : `edge ${c[0]} meets edge ${c[1]}`}; an outline that touches itself nowhere is required — each end moves at most 1/512 px off its edge, so fewer stations or a lower tolerance` }];
  }
  const H = next.length;
  const nx = next.map((q) => snap(q[0]));
  const ny = next.map((q) => snap(q[1]));
  const points: Candidate[] = [];
  const segments: Array<[number, number, number, number]> = [];
  const ribs: ContourRib[] = [];
  const radius = keepRadius(params.spacing);
  planned.forEach((r, k) => {
    const vertices = [endAt[k][0]];
    // The rib's own point, then each half cut at the spacing: lo end -> point -> hi end, every cut snapped.
    const along: Array<[number, number]> = [];
    const half = (ax: number, ay: number, bx: number, by: number, last: boolean): void => {
      const parts = Math.max(1, Math.ceil(Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)) / GRID / params.spacing));
      for (let j = 1; j < parts; j++) along.push([Math.round(ax + ((bx - ax) * j) / parts), Math.round(ay + ((by - ay) * j) / parts)]);
      if (!last) along.push([bx, by]);
    };
    half(r.lo.x, r.lo.y, r.qx, r.qy, false);
    half(r.qx, r.qy, r.hi.x, r.hi.y, true);
    along.forEach(([x, y], j) => {
      let ok = insideRing(x, y, nx, ny);
      for (let i = 0; i < H && ok; i++) ok = farFromSegment(x, y, nx[i], ny[i], nx[(i + 1) % H], ny[(i + 1) % H], 1);
      if (!ok) {
        out.push({ code: 'CONTOUR_RIB_ART', object: `${object}, ${r.name}`, detail: `its point ${j + 1} of ${along.length} between the ends, (${x / GRID}, ${y / GRID}), is outside the outline or within 1/${GRID} px of it; every point between a rib's ends inside the outline is required` });
        return;
      }
      vertices.push(H + points.length);
      points.push({ x, y, radius, source: 'ribs' });
    });
    vertices.push(endAt[k][1]);
    segments.push([r.lo.x, r.lo.y, r.hi.x, r.hi.y]);
    ribs.push({ name: r.name, vertices });
  });
  if (out.length > 0) return out;
  return { outline: next, points, segments, ribs };
}

// ---------------------------------------------------------------------------
// the triangulation
// ---------------------------------------------------------------------------

/**
 * A triangulation under construction: triangles as vertex triples wound with
 * `orient > 0`, and every directed edge a→b mapped to the triangle that holds
 * it. The neighbour across a→b is the owner of b→a; an outline edge has none,
 * which is what makes it unflippable.
 */
class Triangulation {
  readonly tri: number[] = [];
  private readonly owner = new Map<number, number>();
  /** Edges never flipped, beside the outline's (issue #188: the ribs' rows), by their smaller-index-first key. */
  private readonly locked = new Set<number>();

  constructor(
    readonly X: readonly number[],
    readonly Y: readonly number[],
  ) {}

  private key(a: number, b: number): number {
    return a * this.X.length + b;
  }

  get count(): number {
    return this.tri.length / 3;
  }

  /** Is the undirected edge a–b one {@link constrain} locked? */
  isLocked(a: number, b: number): boolean {
    return this.locked.size > 0 && this.locked.has(this.key(Math.min(a, b), Math.max(a, b)));
  }

  /** Lock the undirected edge a–b, so no flip ever removes it. */
  lock(a: number, b: number): void {
    this.locked.add(this.key(Math.min(a, b), Math.max(a, b)));
  }

  /**
   * Make a–b an edge of the triangulation and lock it (issue #188). While it
   * is not one, the first interior edge in triangle order that crosses the
   * open segment a–b strictly (exact orientations) and whose two triangles form
   * a strictly convex quad is flipped (Sloan's edge recovery). Requires that
   * no vertex lies on the open segment, which the rib rule ensures: every
   * other interior point is kept its keep radius off a rib, and a rib's ends
   * are the outline's first contact on each side. Returns false, without
   * locking, when no crossing edge can be flipped or `limit` flips pass first.
   */
  constrain(a: number, b: number, limit: number): boolean {
    for (let step = 0; step <= limit; step++) {
      if (this.ownerOf(a, b) !== undefined || this.ownerOf(b, a) !== undefined) {
        this.lock(a, b);
        return true;
      }
      let flipped = false;
      for (let t = 0; t < this.count && !flipped; t++) {
        for (let k = 0; k < 3; k++) {
          const u = this.tri[3 * t + k];
          const v = this.tri[3 * t + ((k + 1) % 3)];
          if (u === a || u === b || v === a || v === b) continue;
          const o = this.ownerOf(v, u);
          if (o === undefined || o < t || this.isLocked(u, v)) continue;
          const s1 = Math.sign(this.orient(a, b, u)) * Math.sign(this.orient(a, b, v));
          const s2 = Math.sign(this.orient(u, v, a)) * Math.sign(this.orient(u, v, b));
          if (s1 >= 0 || s2 >= 0) continue;
          const c = this.third(t, u);
          const d = this.third(o, v);
          if (!(this.orient(u, d, c) > 0 && this.orient(v, c, d) > 0)) continue;
          this.flip(t, o, u, v, c, d);
          flipped = true;
          break;
        }
      }
      if (!flipped) return false;
    }
    return false;
  }

  ownerOf(a: number, b: number): number | undefined {
    return this.owner.get(this.key(a, b));
  }

  private link(t: number): void {
    const [a, b, c] = [this.tri[3 * t], this.tri[3 * t + 1], this.tri[3 * t + 2]];
    this.owner.set(this.key(a, b), t);
    this.owner.set(this.key(b, c), t);
    this.owner.set(this.key(c, a), t);
  }

  private unlink(t: number): void {
    const [a, b, c] = [this.tri[3 * t], this.tri[3 * t + 1], this.tri[3 * t + 2]];
    this.owner.delete(this.key(a, b));
    this.owner.delete(this.key(b, c));
    this.owner.delete(this.key(c, a));
  }

  /** Overwrite triangle `t` (or append when `t` is the count). */
  set(t: number, a: number, b: number, c: number): void {
    if (t < this.count) this.unlink(t);
    this.tri[3 * t] = a;
    this.tri[3 * t + 1] = b;
    this.tri[3 * t + 2] = c;
    this.link(t);
  }

  orient(a: number, b: number, c: number): number {
    return orient(this.X[a], this.Y[a], this.X[b], this.Y[b], this.X[c], this.Y[c]);
  }

  /** The vertex of triangle `t` that is not on its directed edge a→b. */
  third(t: number, a: number): number {
    const v = [this.tri[3 * t], this.tri[3 * t + 1], this.tri[3 * t + 2]];
    const k = v.indexOf(a);
    return v[(k + 2) % 3];
  }

  /**
   * Is the edge a→b (of triangle `t`, opposite vertex c) not locally Delaunay —
   * the vertex d across it strictly inside the circumcircle of a, b, c — and
   * flippable (a, d, c and b, c, d both strictly wound)? Exact; a tie (d on the
   * circle) is not a violation.
   */
  illegal(a: number, b: number, c: number, d: number): boolean {
    const { X, Y } = this;
    if (inCircle(X[a], Y[a], X[b], Y[b], X[c], Y[c], X[d], Y[d]) <= 0n) return false;
    return this.orient(a, d, c) > 0 && this.orient(b, c, d) > 0;
  }

  /** Flip the edge a→b shared by t = (a, b, c) and u = (b, a, d) into c–d: t becomes (a, d, c), u becomes (b, c, d). */
  flip(t: number, u: number, a: number, b: number, c: number, d: number): void {
    this.unlink(t);
    this.unlink(u);
    this.tri[3 * t] = a;
    this.tri[3 * t + 1] = d;
    this.tri[3 * t + 2] = c;
    this.tri[3 * u] = b;
    this.tri[3 * u + 1] = c;
    this.tri[3 * u + 2] = d;
    this.link(t);
    this.link(u);
  }

  /** Restore the Delaunay condition around a new point p, from the edges opposite it, last pushed first. */
  legalize(p: number, edges: Array<[number, number]>): void {
    while (edges.length > 0) {
      const [x, y] = edges.pop() as [number, number];
      const t = this.ownerOf(x, y);
      const u = this.ownerOf(y, x);
      if (t === undefined || u === undefined) continue; // an outline edge: never flipped
      if (this.isLocked(x, y)) continue; // a rib's edge (issue #188): never flipped
      if (this.third(t, x) !== p) continue; // the edge was flipped away since it was pushed
      const d = this.third(u, y);
      if (!this.illegal(x, y, p, d)) continue;
      this.flip(t, u, x, y, p, d);
      edges.push([x, d], [d, y]);
    }
  }

  /** Flip every interior edge that is not locally Delaunay, scanning in triangle order, until a pass flips none. Returns the flips. */
  legalizeAll(): number {
    let flips = 0;
    for (let changed = true; changed; ) {
      changed = false;
      for (let t = 0; t < this.count; t++) {
        for (let k = 0; k < 3; k++) {
          const a = this.tri[3 * t + k];
          const b = this.tri[3 * t + ((k + 1) % 3)];
          const u = this.ownerOf(b, a);
          if (u === undefined || u < t || this.isLocked(a, b)) continue;
          const c = this.third(t, a);
          const d = this.third(u, b);
          if (!this.illegal(a, b, c, d)) continue;
          this.flip(t, u, a, b, c, d);
          flips++;
          changed = true;
          break;
        }
      }
    }
    return flips;
  }

  /** Interior edges that are not locally Delaunay — the count the report carries. */
  violations(): number {
    let n = 0;
    for (let t = 0; t < this.count; t++) {
      for (let k = 0; k < 3; k++) {
        const a = this.tri[3 * t + k];
        const b = this.tri[3 * t + ((k + 1) % 3)];
        const u = this.ownerOf(b, a);
        if (u === undefined || u < t || this.isLocked(a, b)) continue;
        const { X, Y } = this;
        const c = this.third(t, a);
        const d = this.third(u, b);
        if (inCircle(X[a], Y[a], X[b], Y[b], X[c], Y[c], X[d], Y[d]) > 0n) n++;
      }
    }
    return n;
  }

  /**
   * Insert vertex p: split the first triangle (in index order) that holds it,
   * in three, or — when it lies on an interior edge — that triangle and its
   * neighbour across the edge, in four; then legalize.
   */
  insert(p: number): void {
    for (let t = 0; t < this.count; t++) {
      const a = this.tri[3 * t];
      const b = this.tri[3 * t + 1];
      const c = this.tri[3 * t + 2];
      const o1 = this.orient(a, b, p);
      const o2 = this.orient(b, c, p);
      const o3 = this.orient(c, a, p);
      if (o1 < 0 || o2 < 0 || o3 < 0) continue;
      const zero = o1 === 0 ? [a, b, c] : o2 === 0 ? [b, c, a] : o3 === 0 ? [c, a, b] : null;
      if (zero === null) {
        this.set(t, a, b, p);
        const t2 = this.count;
        this.set(t2, b, c, p);
        this.set(t2 + 1, c, a, p);
        this.legalize(p, [[a, b], [b, c], [c, a]]);
        return;
      }
      const [e0, e1, e2] = zero; // p on e0→e1, e2 opposite
      const u = this.ownerOf(e1, e0);
      if (u === undefined) throw new Error(`contour: vertex ${p} lies on outline edge ${e0}-${e1}, which the keep radius rules out`);
      const d = this.third(u, e1);
      this.set(t, e2, e0, p);
      this.set(u, e1, e2, p);
      const t3 = this.count;
      this.set(t3, d, e1, p);
      this.set(t3 + 1, e0, d, p);
      this.legalize(p, [[e2, e0], [e1, e2], [d, e1], [e0, d]]);
      return;
    }
    throw new Error(`contour: no triangle holds vertex ${p}, which the keep rule placed strictly inside the outline`);
  }
}

/**
 * Interior edges of a mesh in this module's form that are not locally
 * Delaunay: the vertex across the edge strictly inside the circumcircle of the
 * triangle on this side. Exact on {@link GRID} coordinates; 0 for a
 * constrained Delaunay triangulation (the outline's edges, which have no
 * neighbour, are not asked). Being Delaunay does not depend on winding, so
 * each triangle is read in the order that is clockwise on screen — the order
 * the triangulation's predicates are written for — whichever way it is listed:
 * the module's output (counter-clockwise in Spine world) and a list wound as
 * the outline read the same. A `constrained` edge (issue #188: a rib's) is
 * not asked, as an outline edge is not: it is kept whatever its circle holds.
 */
export function delaunayViolations(vertices: ReadonlyArray<readonly [number, number]>, triangles: readonly number[], constrained: ReadonlyArray<readonly [number, number]> = []): number {
  const X = vertices.map((v) => snap(v[0]));
  const Y = vertices.map((v) => snap(v[1]));
  const mesh = new Triangulation(X, Y);
  for (const [a, b] of constrained) mesh.lock(a, b);
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    if (orient(X[a], Y[a], X[b], Y[b], X[c], Y[c]) < 0) mesh.set(t / 3, a, c, b);
    else mesh.set(t / 3, a, b, c);
  }
  return mesh.violations();
}

/** Each triangle rotated to start at its smallest index (winding kept), and the list sorted. */
function canonicalTriangles(tri: readonly number[]): number[] {
  const rows: Array<[number, number, number]> = [];
  for (let t = 0; t < tri.length; t += 3) {
    const v = [tri[t], tri[t + 1], tri[t + 2]];
    const k = v.indexOf(Math.min(...v));
    rows.push([v[k], v[(k + 1) % 3], v[(k + 2) % 3]]);
  }
  rows.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  return rows.flat();
}

// ---------------------------------------------------------------------------
// the checks a returned mesh is held to
// ---------------------------------------------------------------------------

/** Twice the area a closed ring of grid units encloses, exactly: the shoelace sum in `BigInt`. */
function twiceAreaUnits(xs: readonly number[], ys: readonly number[]): bigint {
  let sum = 0n;
  for (let i = 0; i < xs.length; i++) {
    const j = (i + 1) % xs.length;
    sum += BigInt(xs[i]) * BigInt(ys[j]) - BigInt(xs[j]) * BigInt(ys[i]);
  }
  return sum;
}

/** A twice-area in grid units², as px² for a message or the report (rounded once, at the end). */
const unitsToPx2 = (twice: bigint): number => Number(twice) / 2 / (GRID * GRID);

/**
 * The topology refusals of the settled comment, on any mesh in this module's
 * form (part-image px, y down, the outline first), each naming the part:
 *
 * - `CONTOUR_INDEX` — a triangle index that is not a whole number in range;
 * - `CONTOUR_GRID` — a vertex that is not on the {@link GRID} inside
 *   ±{@link MAX_SIDE} px: every exact predicate below is exact only there;
 * - `CONTOUR_COINCIDENT_VERTICES` — two vertices at the same point;
 * - `CONTOUR_ZERO_AREA_TRIANGLE` — a triangle whose corners are collinear;
 * - `CONTOUR_SELF_INTERSECTION` — the first `hull` vertices, as a ring, meet
 *   themselves (rigc's `findSelfIntersection`, touching included);
 * - `CONTOUR_ONE_LOOP` — rigc's own `traceOutline` and `checkHullOrder`, the
 *   functions its gate runs on an authored mesh: one closed loop, `2V − hull −
 *   2` triangles, the outline first and in order, and a `hull` that agrees;
 * - `CONTOUR_TILING` — a triangle that is not counter-clockwise in Spine world
 *   (y up: a negative area in this module's y-down units), or triangle areas
 *   that do not sum to the area the outline encloses: with every triangle
 *   wound one way and the boundary the outline, the sum is what rules out an
 *   overlap. rigc's
 *   `traceOutline` counts edge USES, so a triangle listed four times over (its
 *   edges then used four times, "interior") passes it; the sum does not
 *   (selftest `CT18`).
 *
 * Orientation is computed on grid integers (exact, see the module header);
 * the two area sums in `BigInt`.
 */
export function contourTopologyProblems(part: string, vertices: ReadonlyArray<readonly [number, number]>, triangles: readonly number[], hull: number): Problem[] {
  const out: Problem[] = [];
  const object = `contour mesh "${part}"`;
  const V = vertices.length;
  const badIndex = triangles.findIndex((i) => !Number.isInteger(i) || i < 0 || i >= V);
  if (triangles.length % 3 !== 0 || badIndex >= 0) {
    out.push({
      code: 'CONTOUR_INDEX',
      object,
      detail:
        triangles.length % 3 !== 0
          ? `has ${triangles.length} triangle indices; a multiple of 3 is required`
          : `triangle ${Math.floor(badIndex / 3)} names vertex ${triangles[badIndex]}; whole numbers in 0..${V - 1} are required`,
    });
    return out;
  }
  const X = vertices.map((v) => v[0] * GRID);
  const Y = vertices.map((v) => v[1] * GRID);
  const off = X.findIndex((x, i) => !Number.isInteger(x) || !Number.isInteger(Y[i]) || Math.abs(x) > MAX_SIDE * GRID || Math.abs(Y[i]) > MAX_SIDE * GRID);
  if (off >= 0) {
    out.push({ code: 'CONTOUR_GRID', object, detail: `vertex ${off} is at (${vertices[off][0]}, ${vertices[off][1]}); every coordinate must be a multiple of 1/${GRID} px within ±${MAX_SIDE} px, where the predicates are exact` });
    return out;
  }
  const seen = new Map<string, number>();
  for (let i = 0; i < V; i++) {
    const k = `${X[i]},${Y[i]}`;
    const j = seen.get(k);
    if (j !== undefined) {
      out.push({ code: 'CONTOUR_COINCIDENT_VERTICES', object, detail: `vertices ${j} and ${i} are both at (${vertices[i][0]}, ${vertices[i][1]}); distinct positions are required` });
      break;
    }
    seen.set(k, i);
  }
  let against = -1;
  let sum = 0n;
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const s = orient(X[a], Y[a], X[b], Y[b], X[c], Y[c]);
    if (s === 0) {
      out.push({ code: 'CONTOUR_ZERO_AREA_TRIANGLE', object, detail: `triangle ${t / 3} (${a}, ${b}, ${c}) has zero area; every triangle needs a non-zero area` });
      break;
    }
    // Counter-clockwise in Spine world is a NEGATIVE orientation in y-down units (the y flip changes the sign).
    if (s > 0 && against < 0) against = t / 3;
    sum -= BigInt(s);
  }
  const ring = vertices.slice(0, hull).map(([x, y]) => [x, y] as [number, number]);
  const crossing = hull >= 3 ? findSelfIntersection(ring) : null;
  if (crossing !== null) {
    out.push({ code: 'CONTOUR_SELF_INTERSECTION', object, detail: `outline edge ${crossing[0]} meets outline edge ${crossing[1]}; an outline that touches itself nowhere is required` });
  }
  try {
    const outline = traceOutline(V, triangles);
    if (outline.hull !== hull) throw new MeshError(`it declares hull ${hull} and its triangles outline ${outline.hull} vertices`);
    checkHullOrder(outline, V);
  } catch (err) {
    if (!(err instanceof MeshError)) throw err;
    out.push({ code: 'CONTOUR_ONE_LOOP', object, detail: `rig-c's traceOutline/checkHullOrder: ${err.message}; one closed loop of the first ${hull} vertices in order, with 2 x ${V} - ${hull} - 2 = ${2 * V - hull - 2} triangles, is required` });
  }
  const listed = twiceAreaUnits(X.slice(0, hull), Y.slice(0, hull));
  const outlineTwice = listed < 0n ? -listed : listed;
  if (against >= 0 || (out.length === 0 && sum !== outlineTwice)) {
    out.push({
      code: 'CONTOUR_TILING',
      object,
      detail:
        against >= 0
          ? `triangle ${against} (${triangles[3 * against]}, ${triangles[3 * against + 1]}, ${triangles[3 * against + 2]}) is clockwise in Spine world; every triangle must be counter-clockwise in Spine world (y up), the winding rig-c reads a mesh in`
          : `its triangles' areas sum to ${unitsToPx2(sum)} px² and its outline encloses ${unitsToPx2(outlineTwice)} px²; equal is required, or triangles overlap`,
    });
  }
  return out;
}

/**
 * Is the whole number `k` (0 ≤ k < 2^53) at most `margin²`, exactly? `margin`
 * is a finite double ≥ 0, which is exactly `n / 2^s` for whole numbers n and
 * s (doubling a double is exact, and a finite one becomes whole within 1074
 * doublings); the comparison is `k · 4^s ≤ n²` in `BigInt`. No square is
 * rounded, so a margin of exactly √2's double, or 1.5, decides the pixel at
 * squared distance 2 by its exact value, not by `margin * margin`'s rounding.
 */
export function withinMarginSquared(k: number, margin: number): boolean {
  let n = margin;
  let s = 0n;
  while (!Number.isInteger(n)) {
    n *= 2;
    s++;
  }
  const whole = BigInt(n);
  return BigInt(k) * 4n ** s <= whole * whole;
}

/**
 * The offsets `(dx, dy)` of the margin's disc: every pair of whole numbers
 * with `dx² + dy² ≤ margin²` ({@link withinMarginSquared}), row-major from
 * (−r, −r), r = ⌊margin⌋. Margin 1: the four neighbours and the centre;
 * √2 ≤ margin < 2: the 3x3 block; margin 2: the 3x3 block and (±2, 0), (0, ±2).
 */
export function marginDisc(margin: number): Array<[number, number]> {
  const r = Math.floor(margin);
  const out: Array<[number, number]> = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (withinMarginSquared(dx * dx + dy * dy, margin)) out.push([dx, dy]);
  return out;
}

/** The silhouette grown by the margin, and what each step added (see {@link growSilhouette}). */
export interface GrownSilhouette {
  mask: Mask;
  /** Pixels the growth added: centre within the margin of a pixel of the filled silhouette, not in it. */
  grownPixels: number;
  /** Pixels the pinch fill added, after the growth. */
  pinchFilledPixels: number;
  /** Passes of the pinch fill that added a pixel (0 when the growth made no pinch). */
  pinchFillPasses: number;
}

/** Every pixel corner where two set pixels meet diagonally with both others clear — rig-c's diagonal pinch — as the clear pixels' indices. */
function pinchPixels(data: Uint8Array, w: number, h: number): number[] {
  const out: number[] = [];
  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const tl = y * w + x;
      const tr = tl + 1;
      const bl = tl + w;
      const br = bl + 1;
      if (data[tl] && data[br] && !data[tr] && !data[bl]) out.push(tr, bl);
      else if (data[tr] && data[bl] && !data[tl] && !data[br]) out.push(tl, br);
    }
  }
  return out;
}

/**
 * The silhouette the outline is traced from (the ruling on issue #106). `filled`
 * is the kept island with its holes filled, F.
 *
 * 1. **Growth.** A pixel joins when its centre lies within `margin` of the
 *    centre of a pixel of F — Euclidean, centre to centre, decided exactly
 *    ({@link withinMarginSquared}). That is the distance `measureAuthoredMeshFit`
 *    measures overshoot in, so every grown pixel has an overshoot of at most
 *    the margin. The pixel of F nearest to a pixel outside it is on F's edge
 *    (a pixel of F whose four neighbours are all in F has one strictly nearer
 *    to the outside pixel), so stamping the {@link marginDisc} at the edge
 *    pixels of F is exact. Margin 0 grows nothing.
 * 2. **Pinch fill.** Growth can leave two grown pixels meeting only at a
 *    corner (a 1 px crack running diagonally between two strands), which
 *    rig-c's tracer refuses. Every such pinch is the growth's: F has none
 *    (a 4-connected island touching itself at a corner encloses one of the two
 *    clear pixels, which is then a hole and filled; selftest `CE08` checks it
 *    over every 4x4 mask), and at margin ≥ 1 a pixel of F would put its four
 *    neighbours in G. **Rule:** one pass finds every pinch of the current set
 *    and adds BOTH clear pixels of each — both, because choosing one of two
 *    symmetric pixels is a choice nothing decides; all of a pass at once, so
 *    no scan order decides anything — and passes repeat until one finds no
 *    pinch. **Termination:** a pass that finds a pinch adds at least two
 *    pixels not yet set, so there are at most `w·h / 2` passes. A filled pixel
 *    is a 4-neighbour of a grown one; how far it lies from the art is what the
 *    overshoot check measures, not assumed.
 */
export function growSilhouette(filled: Mask, margin: number): GrownSilhouette {
  const { width: w, height: h, data } = filled;
  const out = new Uint8Array(data);
  const disc = marginDisc(margin);
  if (disc.length > 1) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!data[i]) continue;
        if (x > 0 && data[i - 1] && x < w - 1 && data[i + 1] && y > 0 && data[i - w] && y < h - 1 && data[i + w]) continue;
        for (const [dx, dy] of disc) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) out[ny * w + nx] = 1;
        }
      }
    }
  }
  let grownPixels = 0;
  for (let i = 0; i < out.length; i++) if (out[i] && !data[i]) grownPixels++;
  let pinchFilledPixels = 0;
  let pinchFillPasses = 0;
  for (let found = pinchPixels(out, w, h); found.length > 0; found = pinchPixels(out, w, h)) {
    for (const i of found) {
      if (out[i]) continue;
      out[i] = 1;
      pinchFilledPixels++;
    }
    pinchFillPasses++;
  }
  return { mask: { width: w, height: h, data: out }, grownPixels, pinchFilledPixels, pinchFillPasses };
}

/** The art a threshold makes: alpha above it, as a 0/1 mask. */
export function artMask(mask: AlphaMask, threshold: number): Mask {
  const data = new Uint8Array(mask.width * mask.height);
  for (let i = 0; i < data.length; i++) data[i] = mask.alpha[i] > threshold ? 1 : 0;
  return { width: mask.width, height: mask.height, data };
}

/**
 * Coverage and overshoot, the two fit refusals, measured by rig-c's
 * `measureAuthoredMeshFit` (the settled comment names it): a pixel is covered
 * when its centre is in or on a triangle, and overshoot is the furthest a
 * covered pixel's centre sits from the nearest pixel of the filled silhouette
 * (all art plus what it encloses), centre to centre. That is the convention
 * the bound's `+ 1` is for — a pixel whose centre lands inside can sit up to a
 * pixel from the true edge (rigc's `contourOvershootBound`, whose `margin`
 * term is `margin × 4`, its offset's miter clamp; the settled bound here is
 * `margin`, and this module's grown silhouette keeps it before simplification).
 * The refusal on coverage is any art pixel uncovered, not rigc's 99.5 %.
 *
 * `connectivity` is how the background is flooded to find that silhouette
 * (rig-c 2.23.0's argument): 4 — the default, every reading this function
 * made before — or 8, the fill rig-c's `MQ_OVERSHOOT` reads, where a pocket
 * of background joined to the outside only at a corner is outside, so a mesh
 * spanning it overshoots. The two agree on every mask without such a pocket.
 * Only the overshoot depends on it; coverage counts art pixels, which no fill
 * moves.
 */
export function contourFit(
  part: string,
  mask: AlphaMask,
  threshold: number,
  bound: { margin: number; tolerance: number },
  vertices: ReadonlyArray<readonly [number, number]>,
  triangles: readonly number[],
  connectivity: 4 | 8 = 4,
): { problems: Problem[]; artPixels: number; coveredArt: number; coverage: number; overshoot: number; overshootBound: number } {
  const fit = measureAuthoredMeshFit(
    mask,
    threshold + 1,
    vertices.map(([x, y]) => [x, y] as [number, number]),
    [...triangles],
    connectivity,
  );
  const overshootBound = bound.margin + bound.tolerance + 1;
  const problems: Problem[] = [];
  const object = `contour mesh "${part}"`;
  if (fit.coveredArt < fit.artPixels) {
    problems.push({
      code: 'CONTOUR_COVERAGE',
      object,
      detail: `${fit.artPixels - fit.coveredArt} of ${fit.artPixels} art pixel(s) (alpha above ${threshold}) lie outside the mesh at tolerance ${bound.tolerance} px and margin ${bound.margin} px; every art pixel inside is required — art is never clipped, so raise the margin or lower the tolerance`,
    });
  }
  if (fit.overshoot > overshootBound) {
    problems.push({
      code: 'CONTOUR_OVERSHOOT',
      object,
      detail: `the mesh reaches ${fit.overshoot} px past the art${connectivity === 8 ? " (the background flooded 8-connected, as rig-c's MQ_OVERSHOOT reads it)" : ''}; at most margin ${bound.margin} + tolerance ${bound.tolerance} + 1 = ${overshootBound} px is required`,
    });
  }
  return { problems, artPixels: fit.artPixels, coveredArt: fit.coveredArt, coverage: fit.artPixels === 0 ? 0 : fit.coveredArt / fit.artPixels, overshoot: fit.overshoot, overshootBound };
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** The smallest angle and the largest edge ratio over the triangles, each with the first triangle that has it. */
export function triangleQuality(vertices: ReadonlyArray<readonly [number, number]>, triangles: readonly number[]): { smallestAngle: TriangleFigure; largestEdgeRatio: TriangleFigure } {
  let minAngle = Infinity;
  let minAt = -1;
  let maxRatio = -Infinity;
  let maxAt = -1;
  for (let t = 0; t < triangles.length; t += 3) {
    const p = [vertices[triangles[t]], vertices[triangles[t + 1]], vertices[triangles[t + 2]]];
    const len2 = [0, 1, 2].map((k) => {
      const a = p[(k + 1) % 3];
      const b = p[(k + 2) % 3];
      return (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]);
    });
    const len = len2.map(Math.sqrt);
    for (let k = 0; k < 3; k++) {
      // The angle at corner k, opposite side k, by the law of cosines.
      const cos = (len2[(k + 1) % 3] + len2[(k + 2) % 3] - len2[k]) / (2 * len[(k + 1) % 3] * len[(k + 2) % 3]);
      const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
      if (deg < minAngle) {
        minAngle = deg;
        minAt = t / 3;
      }
    }
    const ratio = Math.max(...len) / Math.min(...len);
    if (ratio > maxRatio) {
      maxRatio = ratio;
      maxAt = t / 3;
    }
  }
  return { smallestAngle: { triangle: minAt, value: r6(minAngle) }, largestEdgeRatio: { triangle: maxAt, value: r6(maxRatio) } };
}

// ---------------------------------------------------------------------------
// the mesh
// ---------------------------------------------------------------------------

/** The outline stage's result: the outline in walk order (px, on the {@link GRID}) and what the silhouette was. */
export interface ContourOutline {
  outline: Array<[number, number]>;
  /** Corner-lattice points of the traced silhouette, before simplification. */
  tracedVertices: number;
  grown: GrownSilhouette;
  /** rigc's `holePixels` of the grown silhouette's trace (0 at margin 0, where the trace is F's and F has no hole). */
  grownHolePixels: number;
}

/**
 * The outline of a filled silhouette F (a 0/1 mask of the part's size: the
 * kept island with its holes filled), or every problem that refuses it:
 *
 * 1. rig-c's `traceAlphaOutline` reads F itself first, so a diagonal
 *    pinch in F is refused in rigc's words (`CONTOUR_TRACE`) at every margin,
 *    before the growth could hide it — the pinch fill below resolves only the
 *    pinches the growth made. (F built from one 4-connected island by
 *    `fillHoles` has none, `CE08`; this is the guard, and `CE07` plants one.)
 * 2. F grows by `margin` and the growth's pinches are filled
 *    ({@link growSilhouette}); at margin 0 nothing grows and F's own trace is
 *    the one used.
 * 3. That silhouette is traced (`traceAlphaOutline`), simplified at
 *    `tolerance` (`simplifyClosedPolygon`), clamped to the window, snapped to
 *    the {@link GRID} and pruned (`prunePolygon`). There is no offset: the
 *    trace runs on whole pixel corners, so clamp and snap move nothing.
 * 4. Douglas–Peucker can still cross an outline over itself, and an outline
 *    under three vertices or enclosing no area is no outline: both
 *    `CONTOUR_SELF_INTERSECTION`, before any triangle is made.
 */
export function contourOutline(part: string, filled: Mask, threshold: number, tolerance: number, margin: number): ContourOutline | Problem[] {
  const object = `contour mesh "${part}"`;
  const { width: w, height: h } = filled;
  const trace = (m: Mask): ReturnType<typeof traceAlphaOutline> | Problem[] => {
    try {
      return traceAlphaOutline({ width: w, height: h, alpha: m.data }, 1);
    } catch (err) {
      if (!(err instanceof MeshError)) throw err;
      return [{ code: 'CONTOUR_TRACE', object, detail: `rig-c's traceAlphaOutline refused it at alpha above ${threshold}: ${err.message}` }];
    }
  };
  const silhouette = trace(filled);
  if (Array.isArray(silhouette)) return silhouette;
  const grown = growSilhouette(filled, margin);
  const traced = margin === 0 ? silhouette : trace(grown.mask);
  if (Array.isArray(traced)) return traced;
  const simplified = simplifyClosedPolygon(traced.outline, tolerance);
  const snapped = simplified.map(([x, y]) => [snap(Math.min(w, Math.max(0, x))) / GRID, snap(Math.min(h, Math.max(0, y))) / GRID] as [number, number]);
  const outline = prunePolygon(snapped);
  if (outline.length < 3 || signedArea(outline) <= 0 || findSelfIntersection(outline) !== null) {
    const crossing = outline.length < 3 ? null : findSelfIntersection(outline);
    return [
      {
        code: 'CONTOUR_SELF_INTERSECTION',
        object,
        detail:
          crossing !== null
            ? `after margin ${margin} px and tolerance ${tolerance} px its simplified outline's edge ${crossing[0]} meets edge ${crossing[1]}; an outline that touches itself nowhere is required — lower the tolerance`
            : `after margin ${margin} px and tolerance ${tolerance} px its outline has ${outline.length} vertices enclosing ${outline.length < 3 ? 0 : signedArea(outline)} px² (clockwise on screen is positive); 3 or more enclosing a positive area are required — lower the tolerance`,
      },
    ];
  }
  return { outline, tracedVertices: traced.outline.length, grown, grownHolePixels: margin === 0 ? 0 : traced.holePixels };
}

/**
 * The contour mesh of one part, or every problem that refuses it. `part` is
 * the name each refusal carries. Pure: same mask and parameters, same bytes.
 */
export function contourMesh(part: string, mask: AlphaMask, params: ContourParams): ContourMesh | Problem[] {
  const object = `contour mesh "${part}"`;
  const early = parameterProblems(part, mask, params);
  if (early.length > 0) return early;
  const { width: w, height: h } = mask;
  const { threshold, tolerance, margin } = params;

  const art = artMask(mask, threshold);
  const comp = connectedComponents(art, 4);
  const islands = comp.count - 1;
  if (islands === 0) {
    return [{ code: 'CONTOUR_PART_HAS_ART', object, detail: `its ${w}x${h} image has no pixel with alpha above ${threshold}; a mesh needs at least one art pixel` }];
  }
  const split = strayIslands(comp.stats.map((s) => s.area), params.stray);
  if (split.refused !== null) {
    const sizes = comp.stats.slice(1).map((s) => `${s.area} px at (${s.left}, ${s.top})`);
    const declared = params.stray === undefined ? '' : ` With stray ${params.stray} px declared, ${split.refused}.`;
    return [
      {
        code: 'CONTOUR_ONE_ISLAND',
        object,
        detail: `its art (alpha above ${threshold}) is ${islands} separate 4-connected islands — ${sizes.join(', ')}; one island is required, because rig-c takes one closed outline per mesh.${declared} Nothing was discarded; the lattice mode stays available for this part`,
      },
    ];
  }
  // The islands left out are taken out of the art before anything is traced or measured: alpha 0 there, so the
  // trace, the coverage and the overshoot all read the one island that remains. Nothing else of the mask moves.
  let meshed = mask;
  let strayPixels = 0;
  if (split.leave.length > 0) {
    const out = new Set(split.leave);
    const alpha = new Uint8Array(mask.alpha);
    for (let i = 0; i < alpha.length; i++) if (out.has(comp.labels[i])) alpha[i] = 0;
    meshed = { width: w, height: h, alpha };
    for (const l of split.leave) strayPixels += comp.stats[l].area;
  }

  // The silhouette F: the kept island with its holes filled; contourOutline grows it, fills the growth's own
  // pinches, traces and simplifies it.
  const island = artMask(meshed, threshold);
  const filled = fillHoles(island);
  let filledHolePixels = 0;
  for (let i = 0; i < filled.data.length; i++) if (filled.data[i] && !island.data[i]) filledHolePixels++;
  const stage = contourOutline(part, filled, threshold, tolerance, margin);
  if (Array.isArray(stage)) return stage;
  const { grown } = stage;
  let outline = outlineInRegions(stage.outline, params.regions);
  // issue #188: the ribs' ends join the outline, and their interior points come first among the interior vertices.
  // None declared, nothing here runs and every list below is the one it always was.
  let ribs: RibPlacement | null = null;
  if ((params.ribs ?? []).length > 0) {
    const placed = placeRibs(part, outline, meshed, island, params);
    if (Array.isArray(placed)) return placed;
    ribs = placed;
    outline = placed.outline;
  }
  const held = ribs?.points ?? [];

  const hx = outline.map((q) => snap(q[0]));
  const hy = outline.map((q) => snap(q[1]));
  // A candidate outside the part window cannot be inside the outline (clamped to it), and dropping it first keeps
  // every coordinate the predicates see within the window — the exactness bound.
  const kept = keepPoints(hx, hy, interiorCandidates(w, h, params).filter((c) => c.x >= 0 && c.y >= 0 && c.x <= w * GRID && c.y <= h * GRID), ribs?.segments ?? []);
  const X = [...hx, ...held.map((c) => c.x), ...kept.map((c) => c.x)];
  const Y = [...hy, ...held.map((c) => c.y), ...kept.map((c) => c.y)];
  const H = outline.length;

  const mesh = new Triangulation(X, Y);
  const ears = earClip(outline);
  for (let t = 0; t < ears.length; t += 3) mesh.set(t / 3, ears[t], ears[t + 1], ears[t + 2]);
  mesh.legalizeAll();
  for (let k = 0; k < held.length + kept.length; k++) mesh.insert(H + k);
  const ribEdges: Array<[number, number]> = [];
  for (const rib of ribs?.ribs ?? []) {
    for (let k = 0; k + 1 < rib.vertices.length; k++) {
      const [a, b] = [rib.vertices[k], rib.vertices[k + 1]];
      ribEdges.push([a, b]);
      if (!mesh.constrain(a, b, mesh.count * mesh.count)) {
        return [{ code: 'CONTOUR_RIB_EDGE', object: `${object}, ${rib.name}`, detail: `its vertices ${a} and ${b} could not be joined by an edge — no edge crossing the segment between them could be flipped; a rib whose consecutive vertices the triangulation can join is required` }];
      }
    }
  }
  mesh.legalizeAll();

  const vertices = X.map((x, i) => [x / GRID, Y[i] / GRID] as [number, number]);
  const triangles = counterClockwiseInSpineWorld(canonicalTriangles(mesh.tri));
  const problems = contourTopologyProblems(part, vertices, triangles, H);
  const fit = contourFit(part, meshed, threshold, { margin, tolerance }, vertices, triangles, params.fitConnectivity ?? 4);
  problems.push(...fit.problems);
  if (params.budget !== undefined && vertices.length > params.budget) {
    problems.push({
      code: 'CONTOUR_BUDGET',
      object,
      detail: `has ${vertices.length} vertices (${H} on the outline, ${held.length + kept.length} inside); the declared budget is ${params.budget} — nothing is thinned to fit, so raise the spacing or the tolerance, or the budget`,
    });
  }
  if (problems.length > 0) return problems;

  const bySource = new Map<string, number>();
  for (const r of params.regions) bySource.set(`region "${r.name}"`, 0);
  bySource.set('background', 0);
  for (const c of kept) bySource.set(c.source, (bySource.get(c.source) as number) + 1);
  if (ribs !== null) bySource.set('ribs', held.length);
  const meshArea = unitsToPx2(twiceAreaUnits(hx, hy));
  return {
    vertices,
    triangles,
    hull: H,
    mask: meshed,
    ...(ribs === null ? {} : { ribs: ribs.ribs }),
    report: {
      boundaryVertices: H,
      interiorVertices: held.length + kept.length,
      interiorBySource: [...bySource].map(([source, n]) => ({ source, vertices: n })),
      triangles: triangles.length / 3,
      tracedVertices: stage.tracedVertices,
      artPixels: fit.artPixels,
      coveredArtPixels: fit.coveredArt,
      coverage: fit.coverage,
      overshoot: fit.overshoot,
      overshootBound: fit.overshootBound,
      ...(params.fitConnectivity === undefined ? {} : { fitConnectivity: params.fitConnectivity }),
      meshArea,
      enclosedTransparentArea: meshArea - fit.coveredArt,
      filledHolePixels,
      ...triangleQuality(vertices, triangles),
      nonDelaunayEdges: delaunayViolations(vertices, triangles, ribEdges),
      strayIslands: split.leave.length,
      strayPixels,
      grownPixels: grown.grownPixels,
      pinchFilledPixels: grown.pinchFilledPixels,
      grownHolePixels: stage.grownHolePixels,
      ...(ribs === null ? {} : { ribs: ribs.ribs }),
    },
  };
}

/**
 * The stray-island rule (issue #84, the amendment to the settled comment), on
 * the pixel counts of a part's 4-connected art islands — `areas[0]` is the
 * background and is not read, as `connectedComponents` numbers them.
 *
 * - One island: kept, nothing left out, whatever is declared.
 * - `stray` absent: a second island refuses, as the settled rule says.
 * - `stray` declared: the largest island is kept; every OTHER island holding
 *   `stray` art pixels or fewer is left out; any other island above the figure
 *   refuses. **Ties:** when two or more islands share the largest count, none
 *   of them is "the largest" — keeping one of two equal pieces would be a
 *   choice the declaration does not make — so the part refuses, naming the
 *   tie. A stray island that sits inside a hole of the kept island is left out
 *   of the art like any other; the hole it sits in is then filled as every
 *   hole is, so the mesh still spans it (its pixels count as filled hole).
 *
 * `leave` lists the labels left out, in label (raster-scan) order; `refused`
 * is null or the reason, in words a refusal can carry.
 */
export function strayIslands(areas: readonly number[], stray: number | undefined): { keep: number; leave: number[]; refused: string | null } {
  const n = areas.length - 1;
  if (n <= 1) return { keep: 1, leave: [], refused: null };
  if (stray === undefined) return { keep: -1, leave: [], refused: 'no stray figure is declared' };
  let largest = 0;
  for (let l = 1; l <= n; l++) largest = Math.max(largest, areas[l]);
  const tied: number[] = [];
  for (let l = 1; l <= n; l++) if (areas[l] === largest) tied.push(l);
  if (tied.length > 1) return { keep: -1, leave: [], refused: `${tied.length} islands share the largest count, ${largest} px, so no one island is the largest and none of them is left out` };
  const keep = tied[0];
  const leave: number[] = [];
  const above: number[] = [];
  for (let l = 1; l <= n; l++) {
    if (l === keep) continue;
    if (areas[l] <= stray) leave.push(l);
    else above.push(l);
  }
  if (above.length > 0) {
    return { keep: -1, leave: [], refused: `besides the largest (${largest} px) ${above.length} island(s) hold more than ${stray} px — ${above.map((l) => `${areas[l]} px`).join(', ')} — and only an island at or under the figure may be left out` };
  }
  return { keep, leave, refused: null };
}

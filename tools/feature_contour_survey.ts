#!/usr/bin/env bun
/**
 * Issue #160, Stage A: interior feature contours in the automatic source, measured on public inputs before any
 * mechanism. One command writes the evidence page and its picture:
 *
 *     bun run fetch-examples          # once: examples/*\/inputs
 *     bun tools/feature_contour_survey.ts --picture docs/evidence/auto-feature-contours.png > docs/evidence/auto-feature-contours.md
 *
 * Three parts, each a function below and each held by the `auto-mesh` suite's FC01-FC06:
 *
 * 1. **The census** ({@link holeCensus}, {@link footprintsOn}, {@link jointsIn}, {@link verdict}) over every part of
 *    the three public examples, assembled from their fetched inputs: the interior alpha holes the filled-silhouette
 *    trace discards, at alpha >= 1 (the automatic source's reading) and >= 8 (the reading issue #160's addendum
 *    counted with); the art's islands; the footprints of the parts drawn after it on its filled silhouette, with
 *    the length of each footprint's outline inside it; the declared bones whose origin lies inside it; and the
 *    verdict — what supplies a feature contour there.
 * 2. **The fixture** ({@link blinkFixture}, {@link faceFixture}, {@link builds}): a synthetic part with one
 *    interior hole and a lid bone whose weights close it, and the public sample's face with its eyelash, eyewhite and
 *    mouth footprints as the feature contours and a lid bone over the lashes — each built as the lattice source at
 *    the case's spacing, at half and at a quarter of it, and as the feature-ring source with the line protected and
 *    thinned, under the same bounds with the skinning veto on, and each build's feature edge measured against the
 *    dense reference ({@link edgeDisplacement}).
 * 3. **The picture** ({@link picture}): every build's mesh over the art beside the dense reference, set up and
 *    posed, drawn on rig-c's `tools/plate.ts` (whose text is `tools/font5x7.ts`).
 *
 * Nothing under `src/` is changed or extended: every build goes through the package's own `autoSource`,
 * `contourMesh`, `autoReductionInput`, `runReduction` and `autoVerdict`, and rig-c's public `rig-c/mesh` entry.
 *
 * Output: Markdown on standard output; each build's wall time on standard error. Exit 1 when the inputs are missing
 * or a build that must be measured was not; 0 otherwise.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type AlphaMask,
  type BoneMotionRange,
  type MeshReductionInput,
  type ReducedMesh,
  segmentsMeet,
  simplifyClosedPolygon,
  type SkinningEnvelope,
  skinningEnvelopeBone,
  traceAlphaOutline,
} from 'rig-c/mesh';
import { Plate, type RGBA } from 'rig-c/tools/plate.ts';
import { autoReductionInput, autoSource, autoVerdict, runReduction, terminationText } from '../src/automesh.ts';
import { type BoneEntry, type CharacterConfig, loadConfig, type AutoSpec } from '../src/config.ts';
import { type ContourMesh, contourMesh, type ContourRegion, growSilhouette } from '../src/contour.ts';
import type { Problem } from '../src/errors.ts';
import { readParts } from '../src/parts.ts';
import { connectedComponents, fillHoles, type Mask, newMask, type Raster, readPng } from '../src/raster/index.ts';
import { PAD } from '../src/rig.ts';
import { blocks } from '../fixtures/contour.ts';
import { examplePolicy, permissivePolicy, syntheticPolicy } from '../fixtures/automesh.ts';
import { withPolicyMotion } from '../fixtures/automotion.ts';
import { assembleExample, installedRigc, missingInputs, pinnedInputs } from './auto_motion_survey.ts';

const ROOT = resolve(import.meta.dir, '..');

/** The three public examples, in the order the census reads them. */
export const EXAMPLES = ['demo', 'sample', 'scarf'] as const;

type Pt = readonly [number, number];

// ---------------------------------------------------------------------------
// 1. the census instruments
// ---------------------------------------------------------------------------

/** A part's art at a threshold: alpha at or above `threshold` (1 is the automatic source's reading, `alpha > 0`). */
export function artAtOrAbove(img: Raster, threshold: number): Mask {
  const m = newMask(img.width, img.height);
  for (let i = 0; i < m.data.length; i++) m.data[i] = img.data[i * 4 + 3] >= threshold ? 1 : 0;
  return m;
}

/** One interior alpha hole: its pixels and its box (x, y, w, h), part-image px. */
export interface Hole {
  px: number;
  box: [number, number, number, number];
}

/**
 * What the filled-silhouette trace discards at one threshold: the 4-connected components of `fillHoles(art) − art`
 * (`fillHoles` floods the background 4-connected from the image border — the contour mode's fill), largest first,
 * ties by box top then left; and how many 4-connected islands the art is.
 */
export interface HoleReading {
  threshold: number;
  islands: number;
  holes: Hole[];
  holePixels: number;
}

export function holeCensus(img: Raster, threshold: number): HoleReading {
  const art = artAtOrAbove(img, threshold);
  const filled = fillHoles(art);
  const gap = newMask(art.width, art.height);
  for (let i = 0; i < gap.data.length; i++) gap.data[i] = filled.data[i] === 1 && art.data[i] === 0 ? 1 : 0;
  const cc = connectedComponents(gap, 4);
  const holes: Hole[] = cc.stats.slice(1).map((s) => ({ px: s.area, box: [s.left, s.top, s.width, s.height] as [number, number, number, number] }));
  holes.sort((a, b) => b.px - a.px || a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  return { threshold, islands: connectedComponents(art, 4).count - 1, holes, holePixels: holes.reduce((n, h) => n + h.px, 0) };
}

/** A part placed in the rig frame: its record's box origin and its image (the assembled `parts/<name>.png`, unpadded). */
export interface PlacedPart {
  name: string;
  x: number;
  y: number;
  img: Raster;
}

/** One footprint: a part drawn after this one, read on this part's filled silhouette. */
export interface Footprint {
  part: string;
  /** The other part's pixels at alpha >= {@link FOOTPRINT_ALPHA} that lie on this part's filled silhouette. */
  px: number;
  /** 4-neighbour pixel edges from a footprint pixel to a silhouette pixel the footprint does not hold: the footprint's outline inside this part, px. */
  line: number;
}

/** The alpha a footprint's pixels are read at: issue #160 addendum 1's reading ("threshold alpha at 8"), taken as at or above. */
export const FOOTPRINT_ALPHA = 8;

/** The silhouette a footprint is read on: the part's art at alpha >= 1 with its holes filled (the automatic source's F). */
export function silhouetteOf(img: Raster): Mask {
  return fillHoles(artAtOrAbove(img, 1));
}

/** The pixels of `q` at alpha >= {@link FOOTPRINT_ALPHA} that fall on `base`'s filled silhouette, in `base`'s image frame (0/1 per pixel). */
export function footprintMask(base: PlacedPart, q: PlacedPart): Mask {
  const sil = silhouetteOf(base.img);
  const out = newMask(sil.width, sil.height);
  for (let y = 0; y < q.img.height; y++) {
    const by = q.y + y - base.y;
    if (by < 0 || by >= sil.height) continue;
    for (let x = 0; x < q.img.width; x++) {
      const bx = q.x + x - base.x;
      if (bx < 0 || bx >= sil.width) continue;
      if (q.img.data[(y * q.img.width + x) * 4 + 3] < FOOTPRINT_ALPHA) continue;
      const i = by * sil.width + bx;
      if (sil.data[i] === 1) out.data[i] = 1;
    }
  }
  return out;
}

/**
 * The footprints on `base` of the parts drawn after it (`above`, in draw order): {@link footprintMask}'s pixels, and
 * the length of that footprint's outline inside `base`'s silhouette. Parts that put no pixel on the silhouette are
 * left out.
 */
export function footprintsOn(base: PlacedPart, above: readonly PlacedPart[]): Footprint[] {
  const sil = silhouetteOf(base.img);
  const w = sil.width;
  const h = sil.height;
  const out: Footprint[] = [];
  for (const q of above) {
    const on = footprintMask(base, q).data;
    let px = 0;
    let line = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (on[i] === 0) continue;
        px++;
        if (x > 0 && sil.data[i - 1] === 1 && on[i - 1] === 0) line++;
        if (x < w - 1 && sil.data[i + 1] === 1 && on[i + 1] === 0) line++;
        if (y > 0 && sil.data[i - w] === 1 && on[i - w] === 0) line++;
        if (y < h - 1 && sil.data[i + w] === 1 && on[i + w] === 0) line++;
      }
    }
    if (px > 0) out.push({ part: q.name, px, line });
  }
  return out;
}

/** Every declared bone's origin, rig px: a single bone's `at`, each chain link `<chain><i>` at `points[i]` (the loader's naming, `src/config.ts`). */
export function boneOrigins(bones: readonly BoneEntry[]): Array<{ bone: string; at: [number, number] }> {
  const out: Array<{ bone: string; at: [number, number] }> = [];
  for (const b of bones) {
    if ('chain' in b) b.points.forEach((p, i) => out.push({ bone: `${b.chain}${i}`, at: [p[0], p[1]] }));
    else out.push({ bone: b.name, at: [b.at[0], b.at[1]] });
  }
  return out;
}

/** The declared bones whose origin pixel (the floor of its rig px) is a pixel of the part's filled silhouette: the joint lines the bones supply. */
export function jointsIn(part: PlacedPart, origins: ReadonlyArray<{ bone: string; at: [number, number] }>): string[] {
  const sil = silhouetteOf(part.img);
  return origins
    .filter(({ at }) => {
      const x = Math.floor(at[0]) - part.x;
      const y = Math.floor(at[1]) - part.y;
      return x >= 0 && y >= 0 && x < sil.width && y < sil.height && sil.data[y * sil.width + x] === 1;
    })
    .map((o) => o.bone);
}

export type Verdict = 'footprints + joints' | 'footprints' | 'joints' | 'neither';

/** What supplies a feature contour inside the part: footprints (one with an outline inside the part, line above 0), joints (a bone origin inside), both, or neither. */
export function verdict(footprints: readonly Footprint[], joints: readonly string[]): Verdict {
  const f = footprints.some((p) => p.line > 0);
  const j = joints.length > 0;
  return f && j ? 'footprints + joints' : f ? 'footprints' : j ? 'joints' : 'neither';
}

/** The part's mesh mode in the example's config: `grid`, `contour`, `auto`, `region` (a `regions` entry), or `none`. */
export function modeOf(cfg: CharacterConfig, part: string): string {
  const m = (cfg.meshes as Record<string, object>)[part];
  if (m !== undefined) return 'grid' in m ? 'grid' : 'contour' in m ? 'contour' : 'auto' in m ? 'auto' : 'mesh';
  return part in cfg.regions ? 'region' : 'none';
}

/** One census row. */
export interface CensusRow {
  example: string;
  part: string;
  from: string;
  mode: string;
  size: [number, number];
  at1: HoleReading;
  at8: HoleReading;
  footprints: Footprint[];
  joints: string[];
  verdict: Verdict;
}

/** The census of one assembled example: every part of `parts.json`, in its order (assemble writes it back to front). */
export function censusOf(example: string, cfg: CharacterConfig, parts: ReadonlyArray<PlacedPart & { from: string }>): CensusRow[] {
  const origins = boneOrigins(cfg.bones);
  return parts.map((p, i) => {
    const footprints = footprintsOn(p, parts.slice(i + 1));
    const joints = jointsIn(p, origins);
    return { example, part: p.name, from: p.from, mode: modeOf(cfg, p.name), size: [p.img.width, p.img.height], at1: holeCensus(p.img, 1), at8: holeCensus(p.img, 8), footprints, joints, verdict: verdict(footprints, joints) };
  });
}

// ---------------------------------------------------------------------------
// 2. the displacement instruments
// ---------------------------------------------------------------------------

/** A weighted triangle mesh in a part-local frame (px, y down): rig-c's `SourceMesh` and `ReducedMesh` both are one. */
export interface WeightedMesh {
  points: ReadonlyArray<readonly [number, number]>;
  triangles: readonly number[];
  weights: ReadonlyArray<ReadonlyArray<{ bone: string; weight: number }>> | null;
}

/** The triangle that carries `p` at setup — the first by index whose barycentric coordinates are all >= −1e-9 (rig-c's predicate epsilon) — and the coordinates; null when none does. */
export function carry(mesh: WeightedMesh, p: Pt): { triangle: number; bary: [number, number, number] } | null {
  const { points, triangles } = mesh;
  for (let t = 0; t * 3 + 2 < triangles.length; t++) {
    const A = points[triangles[t * 3]];
    const B = points[triangles[t * 3 + 1]];
    const C = points[triangles[t * 3 + 2]];
    if (p[0] < Math.min(A[0], B[0], C[0]) - 1e-9 || p[0] > Math.max(A[0], B[0], C[0]) + 1e-9 || p[1] < Math.min(A[1], B[1], C[1]) - 1e-9 || p[1] > Math.max(A[1], B[1], C[1]) + 1e-9) continue;
    const det = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
    if (det === 0) continue;
    const l0 = ((B[1] - C[1]) * (p[0] - C[0]) + (C[0] - B[0]) * (p[1] - C[1])) / det;
    const l1 = ((C[1] - A[1]) * (p[0] - C[0]) + (A[0] - C[0]) * (p[1] - C[1])) / det;
    const l2 = 1 - l0 - l1;
    if (l0 >= -1e-9 && l1 >= -1e-9 && l2 >= -1e-9) return { triangle: t, bary: [l0, l1, l2] };
  }
  return null;
}

/** A vertex's share of `bone` (0 when it does not bind it). */
export function shareOf(mesh: WeightedMesh, v: number, bone: string): number {
  return mesh.weights?.[v]?.find((e) => e.bone === bone)?.weight ?? 0;
}

/** The share of `bone` a mesh carries at `p`: Σ βᵢ wᵢ over the carrying triangle; null when no triangle carries `p`. */
export function carriedShare(mesh: WeightedMesh, bone: string, p: Pt): number | null {
  const c = carry(mesh, p);
  if (c === null) return null;
  let s = 0;
  for (let i = 0; i < 3; i++) s += c.bary[i] * shareOf(mesh, mesh.triangles[c.triangle * 3 + i], bone);
  return s;
}

/**
 * The largest displacement of a set of edge samples, a mesh against the dense reference, for a motion in which one
 * bone (`bone`) translates by `T` relative to everything else (every other bone the mesh binds stays at its setup).
 * A sample p is drawn by the mesh at Σ βᵢ (xᵢ + wᵢ T) = p + w̄(p) T and by the dense reference — the weight rule
 * evaluated at every point, the limit of an infinitely fine mesh under the same rule — at p + field(p) T, so the
 * distance is |w̄(p) − field(p)| · |T|; under a translation it grows linearly with the pose, so the largest over the
 * motion is at the full `T`. Samples no triangle carries are counted, never read as 0.
 */
export function edgeDisplacement(mesh: WeightedMesh, bone: string, samples: readonly Pt[], field: (p: Pt) => number, T: Pt): { max: number; at: Pt | null; carried: number; uncarried: number } {
  const len = Math.hypot(T[0], T[1]);
  let max = 0;
  let at: Pt | null = null;
  let carried = 0;
  let uncarried = 0;
  for (const p of samples) {
    const s = carriedShare(mesh, bone, p);
    if (s === null) {
      uncarried++;
      continue;
    }
    carried++;
    const d = Math.abs(s - field(p)) * len;
    if (d > max || at === null) {
      if (d > max || at === null) at = p;
      max = Math.max(max, d);
    }
  }
  return { max, at, carried, uncarried };
}

/**
 * The comparison's quantity for the same translation, a candidate against its own unreduced source: the largest over
 * `samples` (the art pixel centres) of |w̄_candidate(p) − w̄_source(p)| · |T| — what rig-c's `compareMeshesInMotion`
 * measures between the two builds under this one motion, computed here on the meshes themselves, not on compiled
 * builds. Samples either mesh does not carry are counted.
 */
export function motionAgainstSource(candidate: WeightedMesh, source: WeightedMesh, bone: string, samples: readonly Pt[], T: Pt): { max: number; uncarried: number } {
  const len = Math.hypot(T[0], T[1]);
  let max = 0;
  let uncarried = 0;
  for (const p of samples) {
    const a = carriedShare(candidate, bone, p);
    const b = carriedShare(source, bone, p);
    if (a === null || b === null) {
      uncarried++;
      continue;
    }
    max = Math.max(max, Math.abs(a - b) * len);
  }
  return { max, uncarried };
}

/** Points every `step` px along a closed ring, starting at each vertex: `ceil(edge / step)` per edge, evenly spaced. */
export function ringSamples(ring: ReadonlyArray<readonly [number, number]>, step: number): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let m = 0; m < n; m++) out.push([a[0] + ((b[0] - a[0]) * m) / n, a[1] + ((b[1] - a[1]) * m) / n]);
  }
  return out;
}

/** The centre of every pixel at alpha >= 1 of a mask: the comparison's art samples (§3 of rig-c's contract). */
export function artCentres(mask: AlphaMask): Pt[] {
  const out: Pt[] = [];
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) if (mask.alpha[y * mask.width + x] >= 1) out.push([x + 0.5, y + 0.5]);
  return out;
}

/** Distance from `p` to the union of closed unit pixel squares listed (x, y of each square's top-left corner); 0 inside. */
export function distanceToPixels(p: Pt, pixels: ReadonlyArray<readonly [number, number]>): number {
  let best = Infinity;
  for (const [x, y] of pixels) {
    const dx = p[0] < x ? x - p[0] : p[0] > x + 1 ? p[0] - x - 1 : 0;
    const dy = p[1] < y ? y - p[1] : p[1] > y + 1 ? p[1] - y - 1 : 0;
    const d = Math.hypot(dx, dy);
    if (d < best) best = d;
    if (best === 0) return 0;
  }
  return best;
}

/** The traced outline of every 4-connected island of a 0/1 mask (rig-c's `traceAlphaOutline`, pixel corners), largest island first; a trace rig-c refuses is returned as its message. */
export function islandOutlines(m: Mask): Array<{ px: number; outline: Array<[number, number]> } | { px: number; refused: string }> {
  const cc = connectedComponents(m, 4);
  const order = cc.stats.slice(1).sort((a, b) => b.area - a.area || a.top - b.top || a.left - b.left);
  return order.map((s) => {
    const alpha = new Uint8Array(m.width * m.height);
    for (let i = 0; i < alpha.length; i++) if (cc.labels[i] === s.label) alpha[i] = 255;
    try {
      return { px: s.area, outline: traceAlphaOutline({ width: m.width, height: m.height, alpha }, 1).outline };
    } catch (err) {
      return { px: s.area, refused: err instanceof Error ? err.message : String(err) };
    }
  });
}

// ---------------------------------------------------------------------------
// 3. the fixture
// ---------------------------------------------------------------------------

/** A zero-motion declared range for a bone (keys of a bone the fixture does not move). */
function stillRange(bone: string, pivot: Pt): BoneMotionRange {
  return { bone, source: 'keys', pivot: [pivot[0], pivot[1]], rotate: [0, 0], scaleX: [1, 1], scaleY: [1, 1], translate: 0, setup: { scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, inherit: 'normal' } };
}

/** One fixture case: a part, its lid bone and weight rule, its feature rings, and the edge the displacement is read on. */
export interface FixtureCase {
  name: string;
  /** The part image's alpha, part-local px (the rig stage's padded image for a public part). */
  mask: AlphaMask;
  /** The colours the picture draws, the same frame as `mask`: the part with the features drawn over it; absent, flat grey. */
  art?: Raster;
  /** The policy at a spacing: the same bounds for all three builds. */
  policy: (spacing: number) => AutoSpec;
  spacing: number;
  /** The slot's bone (the envelope's reference) and its ancestry, root first; every one still. */
  referenceChain: string[];
  lid: string;
  /** The lid's setup joint, part-local px. */
  pivot: Pt;
  /** The lid's translation at the closed pose, part-local px, y down. */
  T: Pt;
  /** The weight rule: the lid's share at a point; the reference takes the rest. */
  field: (p: Pt) => number;
  /** The feature rings: each feature's traced outline at pixel corners, unsimplified — the line itself — part-local px. */
  rings: Array<Array<[number, number]>>;
  /** The vertices of each ring simplified at the source tolerance: what build (iv) protects. */
  anchors: Array<[number, number]>;
  /** The edge whose displacement is read: points along the traced (unsimplified) feature outlines the lid moves. */
  edge: Pt[];
}

/** The lid's share and the reference's as a weight list: the lid alone at 1, the reference alone at 0, else both. */
function weightsAt(c: FixtureCase, p: Pt): Array<{ bone: string; weight: number }> {
  const ref = c.referenceChain[c.referenceChain.length - 1];
  const s = c.field(p);
  if (s >= 1) return [{ bone: c.lid, weight: 1 }];
  if (s <= 0) return [{ bone: ref, weight: 1 }];
  return [
    { bone: c.lid, weight: s },
    { bone: ref, weight: 1 - s },
  ];
}

/** The envelope of a fixture case: the lid below the reference, translating by |T|, through rig-c's own helper. */
export function fixtureEnvelope(c: FixtureCase): SkinningEnvelope {
  const ref = c.referenceChain[c.referenceChain.length - 1];
  const lid = { ...stillRange(c.lid, c.pivot), translate: Math.hypot(c.T[0], c.T[1]) };
  return { reference: ref, bones: [skinningEnvelopeBone({ referenceChain: c.referenceChain.map((b) => stillRange(b, c.pivot)), chain: [lid] })] };
}

/** The source vertices on each ring (within one 1/256 px grid unit of one of its edges), in order along the ring. */
export function onRings(vertices: ReadonlyArray<readonly [number, number]>, rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): number[][] {
  return rings.map((ring) => {
    const lengths = ring.map((a, k) => Math.hypot(ring[(k + 1) % ring.length][0] - a[0], ring[(k + 1) % ring.length][1] - a[1]));
    const hits: Array<{ v: number; along: number }> = [];
    vertices.forEach((p, v) => {
      let base = 0;
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        const L = lengths[k];
        const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (L * L)));
        if (Math.hypot(p[0] - (a[0] + t * (b[0] - a[0])), p[1] - (a[1] + t * (b[1] - a[1]))) <= 1 / 256) {
          hits.push({ v, along: base + t * L });
          return;
        }
        base += L;
      }
    });
    hits.sort((p, q) => p.along - q.along);
    return hits.map((h) => h.v);
  });
}

/** Every undirected edge of a triangle list, as "a,b" with a < b. */
function edgeKeys(triangles: readonly number[]): Set<string> {
  const out = new Set<string>();
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      out.add(`${Math.min(a, b)},${Math.max(a, b)}`);
    }
  }
  return out;
}

/** The ring edges (consecutive on-ring vertices, the loop closed) a triangulation contains, and how many ring edges there are. */
export function ringEdges(triangles: readonly number[], rings: readonly number[][]): { present: Array<[number, number]>; of: number } {
  const keys = edgeKeys(triangles);
  const present: Array<[number, number]> = [];
  let of = 0;
  for (const r of rings) {
    if (r.length < 2) continue;
    for (let k = 0; k < r.length; k++) {
      const a = r[k];
      const b = r[(k + 1) % r.length];
      of++;
      if (keys.has(`${Math.min(a, b)},${Math.max(a, b)}`)) present.push([a, b]);
    }
  }
  return { present, of };
}

/** One build's figures. */
export interface Build {
  label: string;
  /** What the source is, in words. */
  what: string;
  source: { hull: number; interior: number } | null;
  /** On-ring vertices in the source, the ring edges its triangulation contains, of how many, and how many vertices were protected. */
  ring: { vertices: number; edges: number; of: number; protectedVertices: number } | null;
  result: { hull: number; interior: number; triangles: number } | null;
  termination: string;
  verdict: string;
  /** The source's own edge displacement against the dense reference. */
  sourceEdge: number | null;
  /** The result's edge displacement against the dense reference, and where. */
  edge: { max: number; at: Pt | null; uncarried: number } | null;
  /** The result against its source on the art samples (the comparison's quantity), px. */
  motion: { max: number; uncarried: number } | null;
  /** rig-c's MQ_SKINNING_RESIDUAL on the result: value, bound, state. */
  residual: string;
  /** The meshes, for the picture. */
  sourceMesh: WeightedMesh | null;
  mesh: WeightedMesh | null;
  wallMs: number;
  problem: string | null;
}

/** The bound every build's edge and motion are read against: the policies' own `maxLocalDeformation` (fixtures/automotion.ts), 1 px. */
export const EDGE_BOUND = 1;

/** The skinning veto's bound for every build: 1 px, the policy's motion bound (the Stage B survey's `motion.residual.maxResidual`). */
export const RESIDUAL_BOUND = 1;

/** How a ring build protects: every on-ring vertex and every ring edge the triangulation contains (`line`), or only the traced ring's own vertices (`traced`). */
export type RingProtection = 'line' | 'traced';

/** What a ring build protects on a source: `protect.vertices` (and `protect.edges` for `line`), and the ring's figures. */
export function ringProtection(c: FixtureCase, made: ContourMesh, how: RingProtection): { protect: NonNullable<AutoSpec['protect']>; ring: NonNullable<Build['ring']> } {
  const rings = onRings(made.vertices, c.rings);
  const edges = ringEdges(made.triangles, rings);
  const all = [...new Set(rings.flat())].sort((p, q) => p - q);
  const traced = new Set(c.anchors.map(([x, y]) => `${x},${y}`));
  const vertices = how === 'line' ? all : all.filter((v) => traced.has(`${made.vertices[v][0]},${made.vertices[v][1]}`));
  return { protect: how === 'line' ? { vertices, edges: edges.present } : { vertices }, ring: { vertices: all.length, edges: edges.present.length, of: edges.of, protectedVertices: vertices.length } };
}

/** One build: the source's weights by the case's rule, the reduction with the veto, acceptance, and every figure. */
function oneBuild(c: FixtureCase, label: string, what: string, made: ContourMesh | Problem[], how: RingProtection | null): Build {
  const started = performance.now();
  const blank: Build = { label, what, source: null, ring: null, result: null, termination: '—', verdict: '—', sourceEdge: null, edge: null, motion: null, residual: '—', sourceMesh: null, mesh: null, wallMs: 0, problem: null };
  if (Array.isArray(made)) return { ...blank, problem: made.map((p) => `${p.code}: ${p.detail}`).join(' / '), wallMs: performance.now() - started };
  const weights = made.vertices.map((p) => weightsAt(c, p));
  const sourceMesh: WeightedMesh = { points: made.vertices, triangles: made.triangles, weights };
  const guard = how === null ? null : ringProtection(c, made, how);
  const spec: AutoSpec = { ...c.policy(c.spacing), ...(guard === null ? {} : { protect: guard.protect }) };
  const base = autoReductionInput({ part: c.name, mask: c.mask, ox: 0, oy: 0, spec, source: made, weights, boneOrder: [...c.referenceChain, c.lid] });
  const input: MeshReductionInput = { ...base, targets: { ...base.targets, skinning: { envelope: fixtureEnvelope(c), maxResidual: RESIDUAL_BOUND } } };
  const ran = runReduction(`fixture ${c.name} ${label}`, input);
  const sourceEdge = edgeDisplacement(sourceMesh, c.lid, c.edge, c.field, c.T).max;
  const common: Build = { ...blank, source: { hull: made.hull, interior: made.vertices.length - made.hull }, ring: guard?.ring ?? null, sourceEdge, sourceMesh };
  if ('code' in ran) return { ...common, problem: `${ran.code}: ${ran.detail}`, wallMs: performance.now() - started };
  const v = autoVerdict(`fixture ${c.name} ${label}`, ran);
  const row = (ran.report.candidates[0]?.geometry?.rows ?? []).find((r) => r.code === 'MQ_SKINNING_RESIDUAL' && r.object.region === null);
  const residual = row === undefined ? 'no row' : row.value === null ? row.state : `${row.value} / <= ${row.bound?.value ?? '—'} (${row.state})`;
  const verdictText = v.accepted ? 'accepted' : `refused ${v.problem.code}`;
  const mesh: ReducedMesh | null = ran.mesh;
  if (mesh === null) return { ...common, termination: terminationText(ran.report.termination), verdict: verdictText, residual, wallMs: performance.now() - started };
  const edge = edgeDisplacement(mesh, c.lid, c.edge, c.field, c.T);
  return {
    ...common,
    result: { hull: mesh.counts.boundaryVertices, interior: mesh.counts.interiorVertices, triangles: mesh.counts.triangles },
    termination: terminationText(ran.report.termination),
    verdict: verdictText,
    edge: { max: edge.max, at: edge.at, uncarried: edge.uncarried },
    motion: motionAgainstSource(mesh, sourceMesh, c.lid, artCentres(c.mask), c.T),
    residual,
    mesh,
    wallMs: performance.now() - started,
  };
}

/** The ring source: `contourMesh` at the case's policy and spacing with each feature ring handed in as a polygon region (band 0) at `ringSpacing`. */
export function ringSource(c: FixtureCase, ringSpacing: number): ContourMesh | Problem[] {
  const regions: ContourRegion[] = c.rings.map((r, i) => ({ name: `feature${i}`, shape: 'polygon', points: r.map(([x, y]) => [x, y] as [number, number]), spacing: ringSpacing, band: 0 }));
  const p = c.policy(c.spacing);
  return contourMesh(c.name, c.mask, { threshold: 0, tolerance: p.source.tolerance, margin: p.source.margin, spacing: c.spacing, ...(p.source.stray === undefined ? {} : { stray: p.source.stray }), regions, fitConnectivity: 8 });
}

/** The most halvings of the case's spacing the ring spacing search tries: down to 1/64 of it. */
export const RING_HALVINGS = 6;

export type RingTrial = { spacing: number; edges: number; of: number } | { spacing: number; refused: string };

/**
 * The ring spacing: the largest `spacing / 2^k` (k = 0 .. {@link RING_HALVINGS}) at which the builder's triangulation
 * contains every ring edge — the density at which Delaunay alone makes the line a line, since the builder takes no
 * constraint. When none does, the last tried, and the trials say how many each contained.
 */
export function ringSpacingFor(c: FixtureCase): { spacing: number; found: boolean; tried: RingTrial[] } {
  const tried: RingTrial[] = [];
  for (let k = 0; k <= RING_HALVINGS; k++) {
    const s = c.spacing / 2 ** k;
    const made = ringSource(c, s);
    if (Array.isArray(made)) {
      tried.push({ spacing: s, refused: made.map((p) => p.code).join(', ') });
      continue;
    }
    const e = ringEdges(made.triangles, onRings(made.vertices, c.rings));
    tried.push({ spacing: s, edges: e.present.length, of: e.of });
    if (e.of > 0 && e.present.length === e.of) return { spacing: s, found: true, tried };
  }
  return { spacing: c.spacing / 2 ** RING_HALVINGS, found: false, tried };
}

/**
 * The four builds of a fixture case, under the same policy bounds and the same skinning veto (`targets.skinning`,
 * maxResidual {@link RESIDUAL_BOUND}):
 *
 * - (i) `autoSource` at the case's spacing — the current lattice source;
 * - (ii) `autoSource` at half the spacing;
 * - (iii) {@link ringSource} at the spacing {@link ringSpacingFor} finds, every on-ring vertex protected
 *   (`protect.vertices`) and every ring edge protected as an edge (`protect.edges`): the line kept as a line, with
 *   every vertex the builder placed on it;
 * - (iv) the same source with only the traced ring's own vertices protected: the reduction may remove the points the
 *   builder placed between them, each removal held to the veto — the nearest today's API comes to thinning a line
 *   under a bound.
 */
export function builds(c: FixtureCase): { builds: Build[]; ringSpacing: ReturnType<typeof ringSpacingFor> } {
  const at = (spacing: number): ContourMesh | Problem[] => autoSource(c.name, c.mask, c.policy(spacing));
  const half = c.spacing / 2;
  const rs = ringSpacingFor(c);
  const ring = ringSource(c, rs.spacing);
  return {
    builds: [
      oneBuild(c, '(i)', `lattice source, spacing ${c.spacing}`, at(c.spacing), null),
      oneBuild(c, '(ii)', `lattice source, spacing ${half}`, at(half), null),
      oneBuild(c, '(ii-q)', `lattice source, spacing ${c.spacing / 4}`, at(c.spacing / 4), null),
      oneBuild(c, '(iii)', `ring source, rings at ${rs.spacing}, line protected`, ring, 'line'),
      oneBuild(c, '(iv)', `ring source, rings at ${rs.spacing}, traced vertices protected`, ring, 'traced'),
    ],
    ringSpacing: rs,
  };
}

// --- the synthetic case -------------------------------------------------------

/** The synthetic part: a 56x40 block at (4, 4) in 64x48 with one interior hole, 24x6 px at (20, 19) — rows 19 to 24, so its upper edge is the line y = 19 and its lower edge y = 25. */
export const BLINK = { w: 64, h: 48, block: [4, 4, 56, 40] as const, hole: [20, 19, 24, 6] as const };

/** The synthetic part's alpha: {@link BLINK}'s block with its hole cleared. */
export function blinkMask(): AlphaMask {
  const m = blocks(BLINK.w, BLINK.h, [BLINK.block]);
  const [hx, hy, hw, hh] = BLINK.hole;
  for (let y = hy; y < hy + hh; y++) for (let x = hx; x < hx + hw; x++) m.alpha[y * BLINK.w + x] = 0;
  return m;
}

/**
 * The blink's weight rule, by hand: the lid's share is 1 at and above the hole's upper edge (y <= 19), 0 at and below
 * its lower edge (y >= 25), and (25 − y) / 6 between — so a translation of the lid by the hole's height, 6 px down,
 * carries the upper edge onto the lower one: the hole closes, and nothing below it moves.
 */
export function blinkShare(p: Pt): number {
  const top = BLINK.hole[1];
  const bottom = BLINK.hole[1] + BLINK.hole[3];
  return p[1] <= top ? 1 : p[1] >= bottom ? 0 : (bottom - p[1]) / (bottom - top);
}

/** The hole's traced edge: the rectangle at pixel corners, clockwise on screen from its top-left corner. */
export function blinkRing(): Array<[number, number]> {
  const [x, y, w, h] = BLINK.hole;
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/** The edge samples: every {@link EDGE_STEP} px along a traced loop. */
export const EDGE_STEP = 0.25;

export function blinkFixture(): FixtureCase {
  const ring = blinkRing();
  return {
    name: 'blink',
    mask: blinkMask(),
    policy: (s) => withPolicyMotion(syntheticPolicy(s)),
    spacing: 8,
    referenceChain: ['root'],
    lid: 'lid',
    pivot: [BLINK.hole[0] + BLINK.hole[2] / 2, BLINK.hole[1]],
    T: [0, BLINK.hole[3]],
    field: blinkShare,
    rings: [ring],
    anchors: ring,
    edge: ringSamples(ring, EDGE_STEP),
  };
}

// --- the public sample's face ---------------------------------------------------

/** The face fixture's parts on the public sample: the face, the lid's two lashes, and the other feature footprints. */
export const FACE = { example: 'sample', part: 'face', lashes: ['lash_l', 'lash_r'], others: ['eyewhite_l', 'eyewhite_r', 'mouth'], eyewhites: ['eyewhite_l', 'eyewhite_r'] } as const;

/** The bones from the root down to a bone, read off the config (root first). */
export function ancestry(cfg: CharacterConfig, bone: string): string[] {
  const parent = new Map<string, string>();
  for (const b of cfg.bones) {
    if ('chain' in b) b.points.forEach((_p, i) => parent.set(`${b.chain}${i}`, i === 0 ? b.parent : `${b.chain}${i - 1}`));
    else parent.set(b.name, b.parent);
  }
  const out = [bone];
  for (let b = parent.get(bone); b !== undefined; b = parent.get(b)) out.unshift(b);
  return out;
}

/** Do two closed rings share a point (rig-c's `segmentsMeet` over every pair of their edges)? */
export function ringsMeet(a: ReadonlyArray<readonly [number, number]>, b: ReadonlyArray<readonly [number, number]>): boolean {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) if (segmentsMeet(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  return false;
}

/** The face case's derivation, in numbers, for the page. */
export interface FaceDerivation {
  spacing: number;
  spacingFrom: string;
  T: number;
  band: number;
  rings: Array<{ footprint: string; px: number; vertices: number; anchors: number } | { footprint: string; px: number; refused: string }>;
  lashPixels: number;
}

/**
 * The sample face: the rig stage's padded part image (PAD transparent px round `parts/face.png`), the lashes' and the
 * other features' footprints read on it, and a lid bone. Every number by a stated rule:
 *
 * - spacing: the median of the sample's tracked grids on its head-run mesh parts (the face itself is a region
 *   attachment in the example and tracks none);
 * - policy: the evaluation matrix's permissive policy (`fixtures/automesh.ts`): the strict policy refuses the face
 *   by name before any build (`CONTOUR_ONE_ISLAND`: a 1 px island beside the face at alpha 1 and above);
 * - footprints: {@link footprintMask} on the face, holes filled and diagonal pinches filled by the contour mode's rule
 *   (`growSilhouette` at margin 0), so rig-c's tracer takes each island;
 * - the lid's share: 1 on the lashes' footprints (closed unit pixel squares), falling linearly to 0 at `band` px from
 *   them; `band` = |T|;
 * - T: straight down, by the taller of the two eyewhite footprints' box heights — the lid travels the eye opening;
 * - the rings: every 4-connected island of each footprint (lashes, eyewhites, mouth) traced by rig-c's
 *   `traceAlphaOutline` and simplified at the policy's source tolerance by `simplifyClosedPolygon`; an island rig-c
 *   refuses to trace, or one that simplifies to fewer than three points, carries no ring and is listed;
 * - the edge: the lashes' traced outlines (unsimplified), every {@link EDGE_STEP} px.
 */
export function faceFixture(cfg: CharacterConfig, parts: readonly PlacedPart[]): { fixture: FixtureCase; derivation: FaceDerivation } {
  const byName = new Map(parts.map((p) => [p.name, p]));
  const need = (n: string): PlacedPart => {
    const p = byName.get(n);
    if (p === undefined) throw new Error(`feature_contour_survey: the assembled ${FACE.example} has no part ${n}`);
    return p;
  };
  const face = need(FACE.part);
  const w = face.img.width + 2 * PAD;
  const h = face.img.height + 2 * PAD;
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < face.img.height; y++) for (let x = 0; x < face.img.width; x++) alpha[(y + PAD) * w + x + PAD] = face.img.data[(y * face.img.width + x) * 4 + 3];
  const mask: AlphaMask = { width: w, height: h, alpha };
  // The picture's colours: the face, then every part drawn after it, alpha over, on the face's pixels only.
  const rgb = new Float64Array(w * h * 3);
  const over = (p: PlacedPart): void => {
    for (let y = 0; y < p.img.height; y++) {
      for (let x = 0; x < p.img.width; x++) {
        const fx = p.x - face.x + x + PAD;
        const fy = p.y - face.y + y + PAD;
        if (fx < 0 || fy < 0 || fx >= w || fy >= h) continue;
        const s = (y * p.img.width + x) * 4;
        const a = p.img.data[s + 3] / 255;
        for (let k = 0; k < 3; k++) rgb[(fy * w + fx) * 3 + k] = p.img.data[s + k] * a + rgb[(fy * w + fx) * 3 + k] * (1 - a);
      }
    }
  };
  parts.slice(parts.indexOf(face)).forEach(over);
  const art = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let i = 0; i < w * h; i++) {
    for (let k = 0; k < 3; k++) art.data[i * 4 + k] = Math.round(rgb[i * 3 + k]);
    art.data[i * 4 + 3] = alpha[i];
  }
  const padded = (m: Mask): Mask => {
    const out = newMask(w, h);
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) out.data[(y + PAD) * w + x + PAD] = m.data[y * m.width + x];
    return out;
  };
  const grids = Object.entries(cfg.meshes as Record<string, { grid?: number }>)
    // A cut's piece (assemble.cuts) is of its from part's run.
    .filter(([name, m]) => m.grid !== undefined && (cfg.assemble.plan.find((e) => e[0] === (cfg.assemble.cuts?.find((q) => q.into === name)?.from ?? name))?.[1] ?? '') === 'head')
    .map(([name, m]) => ({ name, grid: m.grid as number }))
    .sort((a, b) => a.grid - b.grid || (a.name < b.name ? -1 : 1));
  if (grids.length === 0) throw new Error('feature_contour_survey: the sample tracks no grid on a head-run mesh part');
  const spacing = grids[(grids.length - 1) >> 1].grid;
  const spacingFrom = `the median of ${grids.map((g) => `${g.name} ${g.grid}`).join(', ')}`;
  const tolerance = examplePolicy(spacing).source.tolerance;
  // A footprint as its outline can be traced: its holes filled (`fillHoles`) and its diagonal pinches filled by the
  // contour mode's own rule (`growSilhouette` at margin 0 grows nothing and fills both clear pixels of every pinch).
  const footprintOf = (n: string): Mask => growSilhouette(fillHoles(padded(footprintMask(face, need(n)))), 0).mask;
  const lashPixels: Array<[number, number]> = [];
  for (const n of FACE.lashes) {
    const m = footprintOf(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m.data[y * w + x] === 1) lashPixels.push([x, y]);
  }
  let height = 0;
  for (const n of FACE.eyewhites) {
    const m = footprintOf(n);
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m.data[y * w + x] === 1) {
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    if (y1 >= y0) height = Math.max(height, y1 - y0 + 1);
  }
  const band = height;
  const rings: Array<Array<[number, number]>> = [];
  const anchors: Array<[number, number]> = [];
  const ringOwners: string[] = [];
  const derivation: FaceDerivation['rings'] = [];
  const edge: Pt[] = [];
  for (const n of [...FACE.lashes, ...FACE.others]) {
    for (const isl of islandOutlines(footprintOf(n))) {
      if ('refused' in isl) {
        derivation.push({ footprint: n, px: isl.px, refused: isl.refused });
        continue;
      }
      const simple = simplifyClosedPolygon(isl.outline, tolerance);
      if (simple.length < 3) {
        derivation.push({ footprint: n, px: isl.px, refused: `simplifies to ${simple.length} point(s) at tolerance ${tolerance}` });
        continue;
      }
      const line = isl.outline.map(([x, y]) => [x, y] as [number, number]);
      const crossed = ringOwners.findIndex((_o, k) => ringsMeet(rings[k], line));
      if (crossed >= 0) {
        derivation.push({ footprint: n, px: isl.px, refused: `its outline meets the ${ringOwners[crossed]} ring, and two lines that cross need their crossing as a vertex, which no builder here places` });
        continue;
      }
      rings.push(line);
      anchors.push(...simple);
      ringOwners.push(n);
      derivation.push({ footprint: n, px: isl.px, vertices: line.length, anchors: simple.length });
      if ((FACE.lashes as readonly string[]).includes(n)) edge.push(...ringSamples(isl.outline, EDGE_STEP));
    }
  }
  const field = (p: Pt): number => Math.max(0, 1 - distanceToPixels(p, lashPixels) / band);
  let cx0 = Infinity;
  let cx1 = -Infinity;
  let cy0 = Infinity;
  let cy1 = -Infinity;
  for (const [x, y] of lashPixels) {
    cx0 = Math.min(cx0, x);
    cx1 = Math.max(cx1, x + 1);
    cy0 = Math.min(cy0, y);
    cy1 = Math.max(cy1, y + 1);
  }
  const fixture: FixtureCase = {
    name: 'sample face',
    mask,
    art,
    policy: (s) => withPolicyMotion(permissivePolicy(s)),
    spacing,
    referenceChain: ancestry(cfg, cfg.regions[FACE.part]),
    lid: 'lid',
    pivot: [(cx0 + cx1) / 2, (cy0 + cy1) / 2],
    T: [0, height],
    field,
    rings,
    anchors,
    edge,
  };
  return { fixture, derivation: { spacing, spacingFrom, T: height, band, rings: derivation, lashPixels: lashPixels.length } };
}

// ---------------------------------------------------------------------------
// 4. the picture
// ---------------------------------------------------------------------------

const INK: RGBA = [20, 20, 20, 255];
const ART: RGBA = [200, 200, 200, 255];
const POSED: RGBA = [150, 170, 210, 255];
const WIRE: RGBA = [40, 90, 200, 255];
const RING: RGBA = [220, 40, 40, 255];
const PAPER: RGBA = [255, 255, 255, 255];

/** One panel: the art at setup with a mesh's wireframe and the feature edge, and under it the art posed at the closed lid. */
function panel(plate: Plate, ox: number, oy: number, scale: number, c: FixtureCase, mesh: WeightedMesh | null, caption: string[]): void {
  const { width: w, height: h, alpha } = c.mask;
  const colour = (x: number, y: number, flat: RGBA): RGBA => {
    if (c.art === undefined) return flat;
    const i = (y * w + x) * 4;
    const d = c.art.data;
    // Washed towards white so the wireframe and the edges stay legible over it.
    return [Math.round((d[i] + 255) / 2), Math.round((d[i + 1] + 255) / 2), Math.round((d[i + 2] + 255) / 2), 255];
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] >= 1) plate.rect(ox + x * scale, oy + y * scale, scale, scale, colour(x, y, ART));
  if (mesh !== null) {
    for (let t = 0; t + 2 < mesh.triangles.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = mesh.points[mesh.triangles[t + k]];
        const b = mesh.points[mesh.triangles[t + ((k + 1) % 3)]];
        plate.line(ox + a[0] * scale, oy + a[1] * scale, ox + b[0] * scale, oy + b[1] * scale, 1, WIRE);
      }
    }
  }
  for (const p of c.edge) plate.set(Math.round(ox + p[0] * scale), Math.round(oy + p[1] * scale), RING);
  // Posed: the art carried to where the mesh (or, without one, the dense reference) draws it at T — one sample per
  // output pixel at setup, each drawn 2x2 so a stretch below 2 leaves no gap.
  const py = oy + h * scale + 4;
  const share = (p: Pt): number | null => (mesh === null ? c.field(p) : carriedShare(mesh, c.lid, p));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] < 1) continue;
      for (let j = 0; j < scale; j++) {
        for (let i = 0; i < scale; i++) {
          const p: Pt = [x + (i + 0.5) / scale, y + (j + 0.5) / scale];
          const s = share(p);
          if (s === null) continue;
          plate.rect(Math.floor(ox + (p[0] + s * c.T[0]) * scale), Math.floor(py + (p[1] + s * c.T[1]) * scale), 2, 2, colour(x, y, POSED));
        }
      }
    }
  }
  // The dense reference's edge in ink, the mesh's in red over it: where they part is the displacement.
  for (const p of c.edge) plate.set(Math.round(ox + (p[0] + c.field(p) * c.T[0]) * scale), Math.round(py + (p[1] + c.field(p) * c.T[1]) * scale), INK);
  for (const p of c.edge) {
    const s = share(p);
    if (s === null) continue;
    plate.set(Math.round(ox + (p[0] + s * c.T[0]) * scale), Math.round(py + (p[1] + s * c.T[1]) * scale), RING);
  }
  caption.forEach((line, i) => plate.text(line, ox, py + h * scale + 4 + i * 10, 1, INK));
}

/** A build's first caption line: its label and its source in a few words. */
function sourceCaption(c: FixtureCase, b: Build): string {
  if (b.label === '(i)') return `(I) LATTICE S ${c.spacing}`;
  if (b.label === '(ii)') return `(II) LATTICE S ${c.spacing / 2}`;
  if (b.label === '(ii-q)') return `(II-Q) LATTICE S ${c.spacing / 4}`;
  if (b.label === '(iii)') return '(III) RING, LINE KEPT';
  return '(IV) RING, THINNED';
}

/** The picture: one row per case, one panel per build and one for the dense reference — the art at setup with the mesh above, posed at the closed lid below. */
export function picture(cases: ReadonlyArray<{ c: FixtureCase; builds: readonly Build[]; scale: number }>): Plate {
  const gap = 12;
  const captionH = 4 * 10 + 6;
  const widths = cases.map(({ c, builds: bs, scale }) => (bs.length + 1) * (c.mask.width * scale + gap));
  const W = Math.max(...widths) + gap;
  const H = cases.reduce((n, { c, scale }) => n + 2 * c.mask.height * scale + 4 + captionH + gap + 14, gap);
  const plate = new Plate(W, H);
  plate.rect(0, 0, W, H, PAPER);
  let oy = gap;
  for (const { c, builds, scale } of cases) {
    plate.text(c.name.toUpperCase(), gap, oy, 1, INK);
    oy += 12;
    const pw = c.mask.width * scale + gap;
    builds.forEach((b, i) => {
      const verts = b.result === null ? 'NOT BUILT' : `${b.result.hull + b.result.interior} V (${b.result.hull}+${b.result.interior})`;
      const edge = b.edge === null ? '-' : `${b.edge.max.toFixed(2)} PX`;
      panel(plate, gap + i * pw, oy, scale, c, b.mesh, [sourceCaption(c, b), verts, `EDGE ${edge}`, b.verdict.toUpperCase().slice(0, 24)]);
    });
    panel(plate, gap + builds.length * pw, oy, scale, c, null, ['DENSE REFERENCE', 'WEIGHT RULE AT', 'EVERY POINT', `T ${Math.hypot(c.T[0], c.T[1])} PX`]);
    oy += 2 * c.mask.height * scale + 4 + captionH + gap;
  }
  return plate;
}

// ---------------------------------------------------------------------------
// 5. the page
// ---------------------------------------------------------------------------

const f = (v: number | null | undefined, d = 3): string => (v === null || v === undefined ? '—' : Number.isFinite(v) ? String(Number(v.toFixed(d))) : String(v));

function holeCell(r: HoleReading): string {
  if (r.holes.length === 0) return '0';
  const big = r.holes[0];
  return `${r.holes.length} / ${r.holePixels} px; largest ${big.px} px at (${big.box[0]}, ${big.box[1]}) ${big.box[2]}x${big.box[3]}`;
}

export function censusTable(rows: readonly CensusRow[]): string[] {
  const out = [
    '| example | part | from | mode | size | holes at alpha >= 1 (count / px; largest) | holes at alpha >= 8 | islands (>= 1 / >= 8) | footprints on it: part px/line | bone origins inside | verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    const fp = r.footprints.length === 0 ? '—' : r.footprints.map((p) => `${p.part} ${p.px}/${p.line}`).join(', ');
    out.push(`| ${r.example} | ${r.part} | ${r.from} | ${r.mode} | ${r.size[0]}x${r.size[1]} | ${holeCell(r.at1)} | ${holeCell(r.at8)} | ${r.at1.islands} / ${r.at8.islands} | ${fp} | ${r.joints.length === 0 ? '—' : r.joints.join(', ')} | ${r.verdict} |`);
  }
  return out;
}

export function buildTable(c: FixtureCase, builds: readonly Build[]): string[] {
  const out = [
    `| ${c.name}: build | source (hull+interior) | ring: on-ring vertices; ring edges in the triangulation; protected vertices | result: hull+interior = vertices; triangles | termination | verdict | MQ_SKINNING_RESIDUAL (result) | result vs its source on the art, px | source edge vs dense, px | **result edge vs dense, px** | edge within ${EDGE_BOUND} px |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const b of builds) {
    const src = b.source === null ? '—' : `${b.source.hull}+${b.source.interior}`;
    const ring = b.ring === null ? '—' : `${b.ring.vertices}; ${b.ring.edges} of ${b.ring.of}; ${b.ring.protectedVertices}`;
    const res = b.result === null ? (b.problem ?? 'no mesh') : `${b.result.hull}+${b.result.interior} = **${b.result.hull + b.result.interior}**; ${b.result.triangles}`;
    const within = b.edge === null ? '—' : b.edge.max <= EDGE_BOUND ? 'yes' : 'no';
    out.push(`| ${b.label} ${b.what} | ${src} | ${ring} | ${res} | ${b.termination} | ${b.verdict} | ${b.residual} | ${b.motion === null ? '—' : f(b.motion.max, 6)} | ${f(b.sourceEdge, 6)} | **${b.edge === null ? '—' : f(b.edge.max, 6)}** | ${within} |`);
  }
  return out;
}

/** The lattice builds' labels and the ring builds'. */
export const LATTICE_BUILDS = ['(i)', '(ii)', '(ii-q)'] as const;
export const RING_BUILDS = ['(iii)', '(iv)'] as const;

/** A build closes the feature: accepted, and its edge within {@link EDGE_BOUND} of the dense reference. */
export function closes(b: Build): boolean {
  return b.verdict === 'accepted' && b.edge !== null && b.edge.max <= EDGE_BOUND;
}

/** The claim's reading on one case: which lattice and which ring builds close, with their vertex counts. */
export function claimReading(builds: readonly Build[]): { lattice: Array<{ label: string; vertices: number }>; ring: Array<{ label: string; vertices: number }> } {
  const vertsOf = (b: Build): number => (b.result === null ? Infinity : b.result.hull + b.result.interior);
  const pick = (labels: readonly string[]): Array<{ label: string; vertices: number }> => builds.filter((b) => labels.includes(b.label) && closes(b)).map((b) => ({ label: b.label, vertices: vertsOf(b) }));
  return { lattice: pick(LATTICE_BUILDS), ring: pick(RING_BUILDS) };
}

/** The ring spacing search, in words. */
function trialsText(rs: ReturnType<typeof ringSpacingFor>): string {
  const t = rs.tried.map((r) => ('refused' in r ? `${r.spacing}: refused ${r.refused}` : `${r.spacing}: ${r.edges} of ${r.of}`)).join('; ');
  return `${t} — ${rs.found ? `every ring edge is a triangulation edge at ${rs.spacing}` : `no spacing tried made every ring edge a triangulation edge; the last, ${rs.spacing}, is used`}`;
}

function main(): void {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--picture');
  const picturePath = pi >= 0 ? args[pi + 1] : null;
  const missing = missingInputs([...EXAMPLES]);
  if (missing.length > 0) {
    console.error(`feature_contour_survey: no fetched inputs for ${missing.map((k) => `examples/${k}/inputs`).join(', ')}; run \`bun run fetch-examples\` first`);
    process.exit(1);
  }
  const work = mkdtempSync(join(tmpdir(), 'rig-parts-feature-contour-survey-'));
  const lines: string[] = [];
  let failed = 0;
  try {
    const census: CensusRow[] = [];
    let sampleParts: PlacedPart[] = [];
    let sampleCfg: CharacterConfig | null = null;
    for (const k of EXAMPLES) {
      const t = performance.now();
      const asm = assembleExample(work, k);
      const cfg = loadConfig(join(ROOT, 'examples', k, 'config.json'));
      const parts = readParts(join(asm, 'parts.json')).parts.map((p) => ({ name: p.name, from: p.from, x: p.x, y: p.y, img: readPng(join(asm, 'parts', `${p.name}.png`)) }));
      census.push(...censusOf(k, cfg, parts));
      if (k === FACE.example) {
        sampleParts = parts;
        sampleCfg = cfg;
      }
      console.error(`feature_contour_survey: census ${k}: ${parts.length} parts, ${Math.round(performance.now() - t)} ms (assemble included)`);
    }
    if (sampleCfg === null) throw new Error('feature_contour_survey: the sample was not read');
    const blink = blinkFixture();
    const blinkRun = builds(blink);
    const { fixture: face, derivation } = faceFixture(sampleCfg, sampleParts);
    const faceRun = builds(face);
    for (const [c, run] of [
      [blink, blinkRun],
      [face, faceRun],
    ] as const) {
      for (const b of run.builds) {
        console.error(`feature_contour_survey: ${c.name} ${b.label}: ${Math.round(b.wallMs)} ms`);
        if (b.result === null) {
          failed++;
          console.error(`feature_contour_survey: ${c.name} ${b.label} built no mesh: ${b.problem ?? b.termination}`);
        }
      }
    }
    if (picturePath !== null) {
      picture([
        { c: blink, builds: blinkRun.builds, scale: 4 },
        { c: face, builds: faceRun.builds, scale: 3 },
      ]).writePng(picturePath);
    }
    lines.push(...page(census, { c: blink, run: blinkRun }, { c: face, run: faceRun }, derivation));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(lines.join('\n'));
  if (failed > 0) process.exit(1);
}

type CaseRun = { c: FixtureCase; run: ReturnType<typeof builds> };

/** The page, as a function of the rows alone: no time, no path, no machine. */
export function page(census: readonly CensusRow[], blink: CaseRun, face: CaseRun, derivation: FaceDerivation): string[] {
  const out: string[] = [];
  out.push('# Interior feature contours, measured before any mechanism (issue #160, Stage A)', '');
  out.push(`Generated by \`bun tools/feature_contour_survey.ts\`; every figure below is the tool's, none typed. The installed rig-c ${installedRigc()}. The picture, read first: [auto-feature-contours.png](auto-feature-contours.png) — per case, one panel per build and one for the dense reference; above, the art at setup with the mesh and the feature edge (red); below, the art posed at the closed lid with the mesh's edge (red) over the dense reference's (ink).`, '');
  out.push('## 1. The census', '');
  out.push(
    "Every part of the three public examples, assembled from their fetched inputs (`assemble`, the parts the rig stage reads; `from` names the run and tag each came from). **Holes**: the 4-connected components of the part's filled art minus its art — what the filled-silhouette trace (`src/contour.ts`, the automatic source) spans and discards — at alpha >= 1, the source's reading, and at alpha >= 8, the reading issue #160's addendum counted with. **Islands**: 4-connected art islands at each threshold. **Footprints**: each part drawn after this one in `parts.json` order (assemble writes it back to front), its pixels at alpha >= 8 that lie on this part's filled silhouette — px, and the length of that footprint's outline inside the silhouette (`line`, unit pixel edges). **Bone origins**: the example's declared bones (a chain link `<chain><i>` at `points[i]`) whose origin pixel is on the filled silhouette. **Verdict**: `footprints` when a footprint's line is above 0, `joints` when a bone origin is inside, both, or `neither`. No floor is applied to either count: the figures are printed so a reader can apply one.",
    '',
  );
  out.push(...censusTable(census), '');
  const big = (r: CensusRow): number => r.at1.holes[0]?.px ?? 0;
  const byVerdict = (v: Verdict): number => census.filter((r) => r.verdict === v).length;
  out.push(
    `- Parts: ${census.length}. With at least one interior hole at alpha >= 1: ${census.filter((r) => r.at1.holes.length > 0).length}; at alpha >= 8: ${census.filter((r) => r.at8.holes.length > 0).length}. Parts whose largest hole at alpha >= 1 is over 30 px (the addendum's floor): ${
      census
        .filter((r) => big(r) > 30)
        .map((r) => `${r.example}/${r.part} (${r.mode}) ${big(r)} px`)
        .join(', ') || 'none'
    }.`,
    `- Faces: ${census
      .filter((r) => r.part === 'face')
      .map((r) => `${r.example} ${r.at1.holes.length} hole(s), largest ${big(r)} px`)
      .join('; ')} — on a See-through face the features arrive as footprints of other parts, not as holes.`,
    `- Verdicts: footprints + joints ${byVerdict('footprints + joints')}, footprints ${byVerdict('footprints')}, joints ${byVerdict('joints')}, neither ${byVerdict('neither')}.`,
    "- Hands are not parts of their own: each example's hands are the tip of a merged arm layer (`sleeves`, `handwear_*`), past the last declared link's origin, with no part drawn over them; per the card's correction they count as neither. The arm part's verdict above comes from its sleeve and torso joints and footprints, not from the hand.",
    '- Public editor exports: no public export read. The installed rig-c package carries no exported skeleton with meshes (its files are TypeScript sources, documents and two plugin manifests), nor does the development dependency `@esotericsoftware/spine-core` (its distribution only); this repository tracks none, and the private corpus is not read.',
    '',
  );
  out.push('## 2. The fixture', '');
  out.push(
    `**The claim, as the card states it:** the lattice cannot close the hole within the bound at any spacing the budget allows, and the contour source can, at fewer vertices. **The bound**: ${EDGE_BOUND} px — the policies' own \`maxLocalDeformation\` (fixtures/automotion.ts). Every build is reduced by rig-c's \`reduceMesh\` under the case's policy with the skinning veto on (\`targets.skinning\`, maxResidual ${RESIDUAL_BOUND} px; the envelope from rig-c's \`skinningEnvelopeBone\`, the lid translating by |T| below the slot's bone and every other bone still) and accepted or refused by this package's \`autoVerdict\`.`,
    '',
    `**The dense reference, and how displacement is measured**: the case's weight rule evaluated at every point — the limit of an infinitely fine mesh under the same rule. Under the lid's translation T a mesh draws a setup point p at p + w̄(p)·T (w̄ the lid's share interpolated in the triangle that carries p) and the dense reference at p + rule(p)·T, so the edge displacement is the largest |w̄(p) − rule(p)|·|T| over samples every ${EDGE_STEP} px along the feature edge, at the closed pose (it is linear in the pose, so the closed pose is the motion's largest). "Result vs its source" is the motion comparison's quantity for this motion — the result against its own unreduced source over every art pixel centre, computed here on the meshes (rig-c's \`compareMeshesInMotion\` over compiled builds is not run: a fixture has no rig); under a pure translation it is the same quantity as the residual row, which is rig-c's.`,
    '',
    "**The builds.** (i) the current lattice source (`autoSource`) at the case's spacing; (ii) at half of it; (ii-q) at a quarter, added to read \"any spacing the budget allows\" one step further; (iii) and (iv), the feature-ring source, built as far as the public API allows (section 3: neither builder nor reducer takes an interior constrained line): `contourMesh` with each feature ring handed in as a polygon region (band 0), whose points it places along the ring and triangulates Delaunay with the lattice. The ring spacing is searched, not chosen: the largest of the case's spacing halved 0 to 6 times at which the triangulation contains every ring edge — Delaunay making the line a line, since nothing constrains it. (iii) protects every on-ring vertex and every ring edge (`protect.vertices`, `protect.edges`): the line kept, with every vertex the builder put on it. (iv) protects only the on-ring vertices that are vertices of the ring simplified at the source tolerance: the reduction may remove the others, each removal held to the veto — the nearest today's API comes to thinning a line under a bound, and not that: the veto bounds the drift from the source over the art, not the line's deviation from itself.",
    '',
  );
  const b = blink.c;
  out.push('### The synthetic blink', '');
  out.push(
    `A ${BLINK.block[2]}x${BLINK.block[3]} block at (${BLINK.block[0]}, ${BLINK.block[1]}) in ${BLINK.w}x${BLINK.h}, alpha 255, with one ${BLINK.hole[2]}x${BLINK.hole[3]} hole at (${BLINK.hole[0]}, ${BLINK.hole[1]}) (${BLINK.hole[2] * BLINK.hole[3]} px; upper edge y = ${BLINK.hole[1]}, lower edge y = ${BLINK.hole[1] + BLINK.hole[3]}). Bones: \`root\` (the slot's) and \`lid\` below it. The rule: the lid's share is 1 at and above the upper edge, 0 at and below the lower, (${BLINK.hole[1] + BLINK.hole[3]} − y)/${BLINK.hole[3]} between, so T = (0, ${BLINK.hole[3]}) carries the upper edge onto the lower: the hole closes. Inside the hole, which draws nothing, the linear ramp is the rule most favourable to a lattice — a lattice point there interpolates the two edges exactly — so the lattice rows below are its best case. By hand, a row of lattice points at spacing s straddling a kink of the rule at distance a from the row above interpolates it with an error of a(s − a)/s px of displacement: 3·5/8 = 1.875 at s = 8 and 3·1/4 = 0.75 at s = 4 (the upper edge sits 3 px below a lattice row at both) — the "source edge" column. Policy: withPolicyMotion(syntheticPolicy(s)) (tolerance 0, margin 1); s = ${b.spacing}. Ring: the hole's rectangle. Ring spacing search: ${trialsText(blink.run.ringSpacing)}. Edge: the hole's loop, ${b.edge.length} samples.`,
    '',
    ...buildTable(b, blink.run.builds),
    '',
  );
  const c = face.c;
  out.push('### The public sample face', '');
  out.push(
    `The sample's \`face\` (a region attachment in the example), as the rig stage pads it (${c.mask.width}x${c.mask.height}). Spacing ${derivation.spacing}: ${derivation.spacingFrom} — the sample's tracked grids on its head-run mesh parts; the face tracks none. Policy: withPolicyMotion(permissivePolicy(s)) (fixtures/automesh.ts; tolerance 1, margin 1, stray 4) — the strict policy refuses the face by name before any build (\`CONTOUR_ONE_ISLAND\`, a 1 px island at alpha >= 1). Bones: the face's own chain (${c.referenceChain.join(' → ')}), every one still, and a \`lid\` below \`${c.referenceChain[c.referenceChain.length - 1]}\` — the fixture's weights, not the example's. The rule: the lid's share is 1 on the two lash footprints (${derivation.lashPixels} px, as closed unit squares), falling linearly to 0 at ${derivation.band} px from them (the addendum's "owns the face under the footprint, falling off across a band", the band = |T|); T = (0, ${derivation.T}), the taller eyewhite footprint's box height — the lid travels the eye opening. Footprints: each part's pixels at alpha >= 8 on the face's filled silhouette, holes filled and diagonal pinches filled by the contour mode's own rule (\`growSilhouette\` at margin 0) so rig-c's tracer takes each island. Rings, every island of each footprint traced at pixel corners (the line itself), lashes first:`,
    '',
    ...derivation.rings.map((r) => `- ${r.footprint}, ${r.px} px: ${'refused' in r ? `no ring — ${r.refused}` : `${r.vertices} traced vertices, ${r.anchors} after simplification at tolerance 1`}`),
    '',
    `Ring spacing search: ${trialsText(face.run.ringSpacing)}. Edge: the two lashes' traced outlines, ${c.edge.length} samples.`,
    '',
    ...buildTable(c, face.run.builds),
    '',
  );
  out.push('### The claim, read off the two tables', '');
  for (const [name, run] of [
    [b.name, blink.run],
    [c.name, face.run],
  ] as const) {
    const r = claimReading(run.builds);
    const list = (xs: Array<{ label: string; vertices: number }>): string => (xs.length === 0 ? 'none' : xs.map((x) => `${x.label} at ${x.vertices} vertices`).join(', '));
    out.push(`- ${name}: lattice builds that close within ${EDGE_BOUND} px and are accepted — ${list(r.lattice)}; ring builds that do — ${list(r.ring)}.`);
  }
  out.push(
    '',
    "Every build above is accepted by the pipeline's own gates: the skinning veto and the motion comparison hold the result to its **source**, and no gate measures the source against the dense reference. A lattice source that cannot place a vertex on the feature line passes every gate with its edge wherever the lattice puts it.",
    '',
  );
  out.push('## 3. What rig-c accepts today', '');
  out.push(
    `Read off the installed rig-c ${installedRigc()} (\`src/meshreduce.ts\`, \`src/mesh.ts\`) and this package's \`src/contour.ts\`:`,
    '',
    "- `reduceMesh` (`rig-c/mesh`): `protect.edges` takes any pair of source indices that is an edge of a source triangle (`REDUCE_INPUT_MISSING` otherwise) — interior edges included — and a step that leaves a protected edge no longer an edge is refused (`protect (a)`); the Delaunay post-pass never flips one. Both ends of a protected edge join the protected vertices (`protectionOf`), so a protected line keeps every vertex it has: nothing along it is thinned, and nothing holds a line's vertices to a deviation bound the way `MQ_BOUNDARY_DEVIATION` holds the hull's (build (iii)).",
    '- The source must be one loop (`REDUCE_SOURCE_NOT_ONE_LOOP`, `unsupported-topology`): an interior opening has to be spanned by triangles, as the filled-silhouette source spans it.',
    "- No contour builder takes an interior line. rig-c's `buildContourMesh` triangulates the traced outline alone (`earClip`). This package's `contourMesh` places declared interior points (regions, the background lattice) and triangulates them constrained-Delaunay against the outline only; a polygon region's boundary gets points on it, and its edges are not constraints — at the case's spacing the triangulation contains only part of each ring (the search above), and two footprints whose outlines cross (a lash over an eyewhite) cannot both be lines without a vertex at each crossing, which nothing places.",
    '- The gap, in two halves: (a) a source builder that takes named interior polylines as constrained edges with their vertices — crossings resolved into vertices; (b) in `reduceMesh`, a declaration that keeps a line as a line while its vertices are thinned under a deviation bound, as the hull is. `protect.edges` is the all-or-nothing half of (b).',
    '',
  );
  out.push('## Re-running this evidence', '');
  out.push(
    `Inputs: the public examples ${EXAMPLES.join(', ')} of https://github.com/firejune/spine-parts-examples at commit ${pinnedInputs()} (the pin in \`scripts/fetch-examples.sh\`; \`bun run fetch-examples\` copies them into the gitignored \`examples/<key>/inputs\`), each with its tracked \`examples/<key>/config.json\`; rig-c ${installedRigc()} as \`bun install --frozen-lockfile\` installs it from \`bun.lock\`. Nothing is written but standard output and the picture (the stages run in a temporary directory, removed afterwards). Each build's wall time goes to standard error and is not part of this document.`,
    '',
    '```sh',
    'bun install --frozen-lockfile',
    'bun run fetch-examples',
    'timeout 600 bun tools/feature_contour_survey.ts --picture docs/evidence/auto-feature-contours.png > docs/evidence/auto-feature-contours.md',
    '```',
  );
  return out;
}

if (import.meta.main) main();

/**
 * Generated alpha masks for the contour mesh (`src/contour.ts`, issue #84):
 * flat blocks whose art, outline and interior points are computed by hand in
 * the comments, so a control's expected figure comes from here and not from a
 * run. Nothing about appearance is claimed from them.
 *
 * Every mask is part-image px, y down; art is alpha above 8 (`ART_ALPHA`)
 * unless a case says otherwise. The shared parameters are {@link BASE}:
 * tolerance 0 px, margin 1 px, background spacing 8 px — so the keep radius is
 * 4 px. Margin 1 grows the filled silhouette by the pixels whose centre lies
 * 1 px from an art pixel's centre: its four neighbours, not its diagonals
 * (issue #106). Tolerance 0 keeps every traced corner, so a block's outline is
 * exactly the trace of that grown silhouette: its rectangle one pixel larger on
 * every side, less the four corner pixels — 12 vertices, the walk starting at
 * the top-left corner of the first grown pixel in row order and running
 * clockwise on screen. A W x H block at (x0, y0) (x1 = x0 + W, y1 = y0 + H)
 * outlines as
 *
 *     (x0, y0−1) (x1, y0−1) (x1, y0) (x1+1, y0) (x1+1, y1) (x1, y1)
 *     (x1, y1+1) (x0, y1+1) (x0, y1) (x0−1, y1) (x0−1, y0) (x0, y0)
 *
 * enclosing W·H + 2W + 2H px²; every grown pixel's centre is 1 px from an art
 * centre, so the overshoot is 1.
 */
import type { AlphaMask } from 'rig-c/mesh';
import type { ContourParams } from '../src/contour.ts';

/** Rectangles `[x, y, w, h]` of one alpha over a `w`x`h` transparent image; a later block overwrites an earlier one. */
export function blocks(w: number, h: number, rects: ReadonlyArray<readonly [number, number, number, number, number?]>): AlphaMask {
  const alpha = new Uint8Array(w * h);
  for (const [x0, y0, bw, bh, a] of rects) for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) alpha[y * w + x] = a ?? 255;
  return { width: w, height: h, alpha };
}

/** The parameters every case below starts from. */
export const BASE: ContourParams = { threshold: 8, tolerance: 0, margin: 1, spacing: 8, regions: [] };

/** The 12-vertex outline of a W x H block at (x0, y0) under {@link BASE}, by the formula above. */
export function blockOutline(x0: number, y0: number, w: number, h: number): Array<[number, number]> {
  const x1 = x0 + w;
  const y1 = y0 + h;
  return [[x0, y0 - 1], [x1, y0 - 1], [x1, y0], [x1 + 1, y0], [x1 + 1, y1], [x1, y1], [x1, y1 + 1], [x0, y1 + 1], [x0, y1], [x0 - 1, y1], [x0 - 1, y0], [x0, y0]];
}

export interface ContourCase {
  name: string;
  mask: AlphaMask;
  params: ContourParams;
}

/**
 * CONVEX: a 24x16 block at (4, 4) in 32x24. Art 384 px. Outline
 * `blockOutline(4, 4, 24, 16)`, 12 vertices from (4, 3), area 384 + 48 + 32 =
 * 464 px², so 80 px² of it is transparent (the 80 grown pixels). Interior: the
 * spacing-8 grid points at least 4 px from every outline edge — x 8, 16, 24 (5
 * px from x = 3 or x = 29 at the nearest) and y 8, 16 (5 px from y = 3 or
 * y = 21); the nearest outline vertex to (8, 8) is (4, 4), √32 px away: 6
 * points, so V = 18 and T = 2·18 − 12 − 2 = 22. Overshoot 1.
 */
export const CONVEX: ContourCase = { name: 'convex', mask: blocks(32, 24, [[4, 4, 24, 16]]), params: { ...BASE } };

/**
 * CONCAVE: a U — arms 8x24 at (4, 4) and (28, 4), a base 32x8 at (4, 20), in
 * 40x32; background spacing 6 (keep radius 3). Art 192 + 192 + 256 − 64 − 64
 * = 512 px; the notch is x 12..27, y 4..19. Margin 1 grows a row over each arm
 * (y 3, 8 + 8 px), the columns x 3 and x 36 (y 4..27, 24 + 24), the row y 28
 * (32), and into the notch its columns x 12 and x 27 (y 4..19, 16 + 16) and its
 * floor y 19 (x 13..26, 14): 142 px, none at a corner. Outline, 20 vertices:
 * (4,3) (12,3) (12,4) (13,4) (13,19) (27,19) (27,4) (28,4) (28,3) (36,3)
 * (36,4) (37,4) (37,28) (36,28) (36,29) (4,29) (4,28) (3,28) (3,4) (4,4); area
 * 512 + 142 = 654 px². Interior: x = 6 sits exactly 3 px from x = 3, the keep
 * radius, and is kept (the rule is ≥) — except at y = 6, where (6, 6) is √8 <
 * 3 px from the outline vertex (4, 4), and likewise (30, 6) from (28, 4); x = 12
 * is 1 px from x = 13. So (6, 12) (30, 12) (6, 18) (30, 18) and (6, 24) (12, 24)
 * (18, 24) (24, 24) (30, 24): 9 points, V = 29, T = 2·29 − 20 − 2 = 36. The
 * notch is 14 px wide, wider than any triangle the points alone would make, so
 * a triangulation that ignored the outline would bridge it.
 */
export const CONCAVE: ContourCase = { name: 'concave', mask: blocks(40, 32, [[4, 4, 8, 24], [28, 4, 8, 24], [4, 20, 32, 8]]), params: { ...BASE, spacing: 6 } };

/**
 * SPIKE: a 30x16 base at (4, 20) and a spike 2 px wide, 18 tall, at (16, 2),
 * in 48x40. Art 480 + 36 = 516 px. Margin 1 grows the spike's sides (x 15 and
 * x 18, y 2..19, 18 + 18 px) and its tip (y 1, 2 px), the base's top row (y 19,
 * x 4..33 less the four spike columns: 26), its bottom row (y 36, 30) and its
 * sides (x 3 and x 34, y 20..35, 16 + 16): 126 px. Outline, 20 vertices:
 * (16,1) (18,1) (18,2) (19,2) (19,19) (34,19) (34,20) (35,20) (35,36) (34,36)
 * (34,37) (4,37) (4,36) (3,36) (3,20) (4,20) (4,19) (15,19) (15,2) (16,2);
 * area 516 + 126 = 642 px². The spike is 4 px wide after the growth, under
 * twice the keep radius, so it holds no interior point; the base holds x 8,
 * 16, 24 at y 24 and 32 (x 32 is 3 px from x = 35): 6 points, V = 26, T = 30.
 */
export const SPIKE: ContourCase = { name: 'spike', mask: blocks(48, 40, [[4, 20, 30, 16], [16, 2, 2, 18]]), params: { ...BASE } };

/**
 * FEATHERED: a 16x16 core at alpha 255 inside a 2 px ring at alpha 100
 * (20x20 at (6, 6)) inside a 2 px ring at alpha 6 (24x24 at (4, 4)), in 32x32.
 * Above 8, the art is the 20x20 square, 400 px, outlined
 * `blockOutline(6, 6, 20, 20)`; above 100 it is the core, 256 px, outlined
 * `blockOutline(8, 8, 16, 16)`. The alpha-6 ring is never art.
 */
export const FEATHERED: ContourCase = { name: 'feathered', mask: blocks(32, 32, [[4, 4, 24, 24, 6], [6, 6, 20, 20, 100], [8, 8, 16, 16, 255]]), params: { ...BASE } };

/** The feathered case's core alone, above alpha 100. */
export const FEATHERED_CORE: ContourCase = { name: 'feathered-core', mask: FEATHERED.mask, params: { ...BASE, threshold: 100 } };

/**
 * HOLE: a 32x32 block at (4, 4) with a 12x12 hole at (14, 14), in 40x40. Art
 * 1024 − 144 = 880 px; the hole's 144 px are filled. Outline
 * `blockOutline(4, 4, 32, 32)`, area 1024 + 128 = 1152 px², 272 px² of it
 * transparent: the hole's 144 (`filledHolePixels`) and the growth's 128
 * (`grownPixels`), each counted once.
 */
export const HOLE: ContourCase = { name: 'hole', mask: blocks(40, 40, [[4, 4, 32, 32], [14, 14, 12, 12, 0]]), params: { ...BASE } };

/** ISLANDS: 10x10 at (2, 2) and 6x6 at (20, 2) in 40x20 — 100 px and 36 px, refused. */
export const ISLANDS: ContourCase = { name: 'islands', mask: blocks(40, 20, [[2, 2, 10, 10], [20, 2, 6, 6]]), params: { ...BASE } };

/** EMPTY: 10x10 with no pixel above alpha 8 (one at exactly 8, which is not art). */
export const EMPTY: ContourCase = { name: 'empty', mask: blocks(10, 10, [[4, 4, 1, 1, 8]]), params: { ...BASE } };

/**
 * PINCH: one 4-connected island that touches itself at pixel corner (4, 4):
 * pixels (4, 3) and (3, 4) are art, (3, 3) and (4, 4) are not, and the two
 * arms join through the top row. rigc's tracer refuses the island as it is;
 * but (3, 3) is in the enclosed pocket, so the filled silhouette — the island
 * with its holes filled, the mask the outline is traced from — has (3, 3) set
 * and no pinch (issue #106).
 *
 *     ......
 *     .####.
 *     .#..#.
 *     .#..#.   (the 2x2 pocket at (2, 2) is enclosed)
 *     .###..
 *     ......
 */
export const PINCH: ContourCase = {
  name: 'pinch',
  mask: blocks(6, 6, [[1, 1, 4, 1], [1, 2, 1, 2], [4, 2, 1, 2], [1, 4, 3, 1]]),
  params: { ...BASE },
};

/**
 * REGION: a 56x40 block at (4, 4) in 64x48, background spacing 12 (keep
 * radius 6), and one circle region at (40, 24), radius 8, spacing 3, band 4.
 * Outline `blockOutline(4, 4, 56, 40)`, the same with or without the region.
 * Background grid points inside the outline and 6 px from it: x 12, 24, 36, 48
 * and y 12, 24, 36 — 12 of them. The region's points reach 12 px from its
 * centre, so a background point further than 12 + 6 = 18 px from (40, 24)
 * cannot be within the keep radius of one: those are (12,12) (24,12) (12,24)
 * (12,36) (24,36), 30.5, 20, 28, 30.5 and 20 px out. Every other background
 * point lies within 16 px of the centre, inside the band's reach.
 */
export const REGION: ContourCase = {
  name: 'region',
  mask: blocks(64, 48, [[4, 4, 56, 40]]),
  params: { ...BASE, spacing: 12, regions: [{ name: 'soft', shape: 'circle', cx: 40, cy: 24, r: 8, spacing: 3, band: 4 }] },
};

/**
 * STRIP: {@link REGION}'s block (56x40 at (4, 4) in 64x48, outline
 * `blockOutline(4, 4, 56, 40)`, background spacing 12) with no region; the
 * issue #110 controls (`CE10`–`CE16`) add regions whose support crosses its top
 * edge, the line y = 3 from (4, 3) to (60, 3) — outline vertices 0 and 1 —
 * where every point inserted on it is computed by hand.
 */
export const STRIP: ContourCase = { name: 'strip', mask: blocks(64, 48, [[4, 4, 56, 40]]), params: { ...BASE, spacing: 12, regions: [] } };

/** The background points of {@link REGION} the region cannot reach, by hand. */
export const REGION_FAR_BACKGROUND: ReadonlyArray<readonly [number, number]> = [
  [12, 12],
  [24, 12],
  [12, 24],
  [12, 36],
  [24, 36],
];

/** FULL: a 10x8 image all art — no pixel to grow into, so its outline is the window, with no interior point at spacing 8. */
export const FULL: ContourCase = { name: 'full', mask: blocks(10, 8, [[0, 0, 10, 8]]), params: { ...BASE } };

/**
 * NOTCH: a U with a 2 px notch — arms 6x20 at (2, 2) and (10, 2), a base 14x6
 * at (2, 18), in 20x26; the notch is x 8..9, y 2..17. Art 240 + 84 − 48 = 276
 * px. At margin 1 every notch pixel is a 4-neighbour of an arm, so the notch
 * grows shut (32 px) — it is neither folded over nor left as a hole; only its
 * mouth's corner row (8, 1) and (9, 1), √2 from the nearest arm pixel, stays
 * out. With the rows y 1 (6 + 6), y 24 (14) and the columns x 1 and x 16
 * (y 2..23, 22 + 22), the growth adds 102 px. Outline at tolerance 0, 16
 * vertices: (2,1) (8,1) (8,2) (10,2) (10,1) (16,1) (16,2) (17,2) (17,24)
 * (16,24) (16,25) (2,25) (2,24) (1,24) (1,2) (2,2); area 276 + 102 = 378 px².
 */
export const NOTCH: ContourCase = { name: 'notch', mask: blocks(20, 26, [[2, 2, 6, 20], [10, 2, 6, 20], [2, 18, 14, 6]]), params: { ...BASE } };

/**
 * BOTTLE: a 16x16 block at (2, 2) in 20x20 with a chamber 4x6 at (8, 6) and a
 * mouth 2x4 at (9, 2) cleared, so the chamber opens to the outside through the
 * mouth and is no hole of the art. Art 256 − 24 − 8 = 224 px. At margin 1 the
 * mouth grows shut (its 8 px are 4-neighbours of (8, y) and (11, y)), the
 * chamber's walls grow in by one pixel (x 8 and x 11 for y 6..11: 12 px; its
 * floor (9, 11) and (10, 11): 2 px), and the chamber's middle — x 9..10, y
 * 6..10, 10 px, none within 1 px of an art centre — is enclosed by the grown
 * silhouette without being in it: `grownHolePixels` 10. Round the outside the
 * growth adds the row y 1 (x 2..8 and 11..17, 14 px — not x 9..10, whose
 * pixels below are the mouth), the row y 18 (16) and the columns x 1 and x 18
 * (16 + 16): `grownPixels` 14 + 16 + 32 + 8 + 12 + 2 = 84. No pinch: the
 * pinch fill adds 0. The traced silhouette holds 224 + 0 + 84 + 0 + 10 = 318
 * px, which is the outline's area at tolerance 0: the 18x18 square less its
 * four corner pixels and the two mouth pixels of row y 1.
 */
export const BOTTLE: ContourCase = { name: 'bottle', mask: blocks(20, 20, [[2, 2, 16, 16], [8, 6, 4, 6, 0], [9, 2, 2, 4, 0]]), params: { ...BASE } };

/**
 * STRAND (issue #188): a 10x60 bar at (10, 4) in 30x70, the strand a chain
 * hangs down. At margin 1 and tolerance 0 its outline is the rectangle x 9..21,
 * y 3..65 less its four corner pixels — 12 vertices, as CONVEX's. {@link
 * STRAND_CHAIN} runs down its middle, x 15: link 0 from y 10 to 30, link 1 to
 * 50, link 2 to the tip at 62. Every link is vertical, so every rib is the row
 * y = const from the outline's right edge x 21 to its left edge x 9, 12 px; at
 * spacing 8 it is cut into ⌈12 / 8⌉ = 2 parts, so each rib is (21, y) (15, y)
 * (9, y). With stations 1 the ribs are at y 10, 20 (link 0's middle), 30, 40,
 * 50 and 56 (link 2's middle): 6 ribs, 12 ends on the outline and 6 points
 * inside. A background point (16, j·8) is kept only 4 px or more from every
 * rib row and from the outline: (16, 16) and (16, 24). Vertices 24 + 6 + 2 =
 * 32, triangles 2·32 − 24 − 2 = 38. With stations 0 the rows are y 10, 30 and
 * 50, and the background keeps (16, 16), (16, 24), (16, 40) and (16, 56):
 * vertices 18 + 3 + 4 = 25.
 */
export const STRAND: ContourCase = { name: 'strand', mask: blocks(30, 70, [[10, 4, 10, 60]]), params: { ...BASE } };

/** The chain down {@link STRAND}'s middle: its points then its tip, part-image px. */
export const STRAND_CHAIN: ReadonlyArray<readonly [number, number]> = [
  [15, 10],
  [15, 30],
  [15, 50],
  [15, 62],
];

/**
 * NOTCHED (issue #188): a 40x50 block at (10, 4) in 60x60 with its top-left
 * 10x14 corner cleared (x 10..19, y 4..17), and a one-link chain from (30, 20)
 * down to (30, 50). At margin 1, tolerance 0 the outline has 18 vertices; the
 * concave corner the growth leaves is (19, 17). The rib at y 20 runs from
 * (51, 20) through the joint (30, 20) to (9, 20), each 21 px half one part at
 * spacing 32; no background point is kept (none of (32, 32), (32, 48), … is
 * 16 px from the rib and the outline). Its left edge (30, 20)–(9, 20) has the
 * apexes (19, 17) above and (10, 54) below, and the circle through (9, 20),
 * (30, 20), (19, 17) — centre (19.5, 36.83), r² 393.6 — holds (10, 54) (d²
 * 385.1): the edge is not locally Delaunay, and a triangulation free to flip it
 * would.
 */
export const NOTCHED: ContourCase = { name: 'notched', mask: blocks(60, 60, [[10, 4, 40, 50], [10, 4, 10, 14, 0]]), params: { ...BASE, spacing: 32 } };

/**
 * The cases that build, in order. The gate proof (selftest `CT27`) carries all
 * but FULL, whose PNG has no transparent texel — which rig-c's spine-html
 * profile refuses for the image (A19), whatever attachment draws it.
 */
export const BUILDING: readonly ContourCase[] = [CONVEX, CONCAVE, SPIKE, FEATHERED, HOLE, REGION, FULL];

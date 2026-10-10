/**
 * The assemble stage: two See-through runs over one painting — a FULL-body run
 * and a HEAD-crop run — merged into one set of rig-space parts, each part one
 * RGBA image cropped to its own alpha box, plus the `parts.json` measurement
 * record (`src/parts.ts`) and a flat recomposite to compare with the painting.
 *
 * Rig space is source pixels times `assemble.rig_scale`, y down, origin
 * top-left; the rig canvas is `trunc(w * s) x trunc(h * s)`. The painting is
 * resampled into it once (`sourceInRig`) and every "source" pixel below is a
 * pixel of that resample.
 *
 * Each See-through layer goes through five steps, each its own function with
 * its invariant stated where it is written:
 *
 *   1. `cleanGhosts`      — drop sub-threshold specks from a run-space layer;
 *   2. `layerToRig`       — resample the layer into rig space through its run's geometry;
 *   3. `projectSource`    — where the layer is the top-most opaque layer of its run,
 *                           take the painting's pixel instead of See-through's repaint;
 *   4. `mergeBelowCrop`   — a head-run part below the head crop is continued from a
 *                           full-run layer (whole components, `belowCrop`), and its
 *                           seam closed by `growRim`;
 *   4b. `pushBackFringe`  — a fringe below alpha 250 that keeps the stack off the
 *                           painting where a part beneath holds the pixel in the
 *                           painting's colour is cleared (not in the reference);
 *   5. `seamOverride`     — where the flat composite of the parts still differs from
 *                           the painting, the top-most part takes the painting's colour.
 *
 * This is a port of a reference implementation, and it is faithful to it by
 * default — measured against its outputs (ORACLE_assemble.md at the root of
 * the change that added this file). The places it deliberately is NOT are
 * named here, so none is found by accident:
 *
 * - **Refusals where the reference guessed or skipped.** A plan or extend
 *   entry naming a tag its run does not hold (the reference raised a KeyError),
 *   a part left with no opaque pixel (the reference printed `EMPTY` and wrote a
 *   `parts.json` without it), a head box outside the painting (the reference
 *   read row `-1` as the last row), a run whose canvas is not the configured
 *   resolution (the reference assumed 1024).
 * - **A landscape painting is mapped back, not refused.** The reference
 *   refused one as a bare exit; here the full run's input is the painting on a
 *   square of its longer side (`squarePad`, `src/inputs.ts`), and the full
 *   run's map carries the vertical pad exactly as it carries the horizontal
 *   one. A portrait painting's vertical pad is 0, so its map is the
 *   reference's.
 * - **`seamRule: 'silhouette'`** is available beside the faithful
 *   `'near-white'` rule. The reference's seam override skips every pixel whose
 *   painting colour is near-white (min channel above 235), which protects the
 *   background and also every white garment. The silhouette rule skips a
 *   near-white pixel only OUTSIDE the figure (`figureSilhouette`). Which one
 *   is the default is decided by measurement, recorded beside
 *   `DEFAULT_SEAM_RULE`.
 * - **`projectRule: 'visible'`** is available beside the faithful `'core'`
 *   rule (`ProjectRule`): the reference erodes every layer's top-most opaque
 *   area before projecting, so a part a few pixels wide takes nothing from the
 *   painting; `visible` erodes only along a rim with a later layer in front.
 * - **The visibility counts** (`visible_px`, `occluded_px`,
 *   `visible_not_projected_px`) are this port's, derived from the masks
 *   `projectSource` and `mergeBelowCrop` already build (`visibilityCounts`).
 * - **The recomposite's holes and error map** (`uncoveredHoles`,
 *   `recompositeErrorMap`) are this port's: the reference printed the
 *   uncovered count alone, which says a hole exists but not where.
 * - **The fringe push-back** (`pushBackFringe`, issue #119) is this port's,
 *   and it is on by default: the reference left a fringe below alpha 250 in
 *   another part's colour on the rig, where neither projection nor the seam
 *   override (both at alpha >= 250) could reach it. Its effect on the public
 *   examples is counted in the pull request that added it; a stack it does
 *   not touch assembles to the reference's bytes.
 * - **Patches** (`assemble.patches`, `cutPatch`) are this port's: an extra
 *   part cut from the painting itself, for a piece of the figure no layer
 *   holds, recorded as `painting:<name>` and 100 % source.
 * - **Cuts** (`assemble.cuts`, `cutPart`, issue #170) are this port's: a
 *   declared polygon takes a plan part's pixels out of it into a new part,
 *   recorded with the same `<run>:<tag>` (its pixels came from that layer).
 *   The cut is made after step 4, so the new part takes the merged pixels and
 *   every later step treats it as a part of its own.
 *
 * Pure: no clock, no randomness, no file access. The CLI reads and writes.
 */
import type { CharacterConfig, Cut, EarlyConfig, Extend, Patch, PlanEntry, Run, SeeThrough } from './config.ts';
import { type Problem, refuseIfAny } from './errors.ts';
import { figuresPhrase, implausibleRules, type Layer, type LayerFigures, layerFigures, type LayerSet, NEAR_WHITE_MIN, OPAQUE_ALPHA_ABOVE, ruleSummary } from './layers.ts';
import { squarePad } from './inputs.ts';
import { PAINTING_RUN, type PartRecord, type PartsFile, type RecompositeRecord } from './parts.ts';
import {
  alphaComposite,
  connectedComponents,
  crop,
  dilate,
  erode,
  fillHoles,
  gaussianBlur,
  type Mask,
  morphClose,
  newFloatImage,
  newMask,
  newRaster,
  type Raster,
  resize,
  warpAffine,
} from './raster/index.ts';
import { pyRound } from './round.ts';

const f32 = Math.fround;

// ---------------------------------------------------------------------------
// the reference's constants, each named once
// ---------------------------------------------------------------------------

/** Alpha at or above this is "opaque" for ownership, projection cores and the seam override. `>= 250`, not `== 255`: See-through leaves alpha-254 speckle. */
export const CORE_ALPHA = 250;
/** A ghost component is kept when its area is at least this many pixels … */
export const GHOST_MIN_AREA = 40;
/** … and at least this fraction of the layer's largest component. */
export const GHOST_MIN_FRACTION = 0.01;
/** The side of the square erosion that makes a projection core, and of the closing that fills speckle refusals. */
export const CORE_KERNEL = 5;
/** Projection is refused where See-through's pixel and the painting's differ by more than this, max channel. */
export const DRIFT_LIMIT = 90;
/** The Gaussian sigma that feathers the projection weight. */
export const FEATHER_SIGMA = 1.0;
/** Head-run projection stays this many rig pixels inside the head crop. */
export const HEAD_WINDOW_INSET = 3;
/** The head crop's bottom line in rig pixels is `trunc(y1 * s) - HEAD_BOTTOM_INSET`. */
export const HEAD_BOTTOM_INSET = 4;
/** `belowCrop` probes the head part this many rows above the crop line … */
export const CROP_PROBE_ROWS = 2;
/** … seeds components in this many rows from the crop line down … */
export const CROP_SEED_ROWS = 6;
/** … within this many columns of a column where the head part reaches the line. */
export const CROP_SEED_COLUMNS = 12;
/** Alpha above this counts as "the head part reaches the crop line". */
export const CROP_PROBE_ALPHA = 128;
/** Alpha at or above this in a later plan part keeps `growRim`'s ring off the pixel. */
export const FRONT_ALPHA = 128;
/** A painting pixel whose min channel is above this is "near-white" (the faithful rim and seam guard). Defined beside the layer reader, which applies the same test to a layer's colour (`layerFigures`). */
export { NEAR_WHITE_MIN };
/** The seam override acts where the flat composite differs from the painting by more than this, max channel. */
export const SEAM_LIMIT = 60;
/** `--propose-plan` drops a tag with fewer run-space opaque pixels than this after ghost clean-up. */
export const PROPOSE_MIN_PX = 150;
/** The recomposite's "error pixel": max-channel difference from the painting above this. */
export const ERROR_LIMIT = 40;
/** The recomposite's "within" figure: mean-channel difference at or below this. */
export const WITHIN_LIMIT = 8;
/**
 * An error pixel is "uncovered" when no part has alpha above this there. The
 * definition is the one the reference's own demo report measured with, and it
 * reproduces that report's figure exactly (1,564 on the reference's demo
 * output; with "no part has alpha above 0" the same output reads 105).
 */
export const COVERED_ALPHA = 128;
/** `figureSilhouette`: the border ring whose median colour is the background, in rig pixels. */
export const SILHOUETTE_BORDER = 8;
/** `figureSilhouette`: a pixel is figure where it differs from that median by more than this, max channel. */
export const SILHOUETTE_LIMIT = 40;

export type SeamRule = 'near-white' | 'silhouette';
export const SEAM_RULES: readonly SeamRule[] = ['near-white', 'silhouette'];

/**
 * The seam rule a run uses when none is named. Set by measurement, not taste:
 * the silhouette rule ships as the default only if it lowers the error pixel
 * count on every oracle character without raising mean |d| on any
 * (ORACLE_assemble.md, *faithful vs silhouette*).
 */
export const DEFAULT_SEAM_RULE: SeamRule = 'near-white';

/**
 * Where a layer may take the painting's pixel (`projectSource`). `core` is the
 * reference's rule: the layer's top-most `alpha >= 250` pixels eroded by a 5x5
 * square, so a part a few pixels wide has no core and none of its visible
 * pixels is projected. `visible` keeps the erosion only where it guards
 * something — along a rim where a later layer of the run is in front — and
 * projects every other top-most `alpha >= 250` pixel of the layer.
 */
export type ProjectRule = 'core' | 'visible';
export const PROJECT_RULES: readonly ProjectRule[] = ['core', 'visible'];

/**
 * The projection rule a run uses when none is named: the reference's, so the
 * examples stay comparable with it. `visible` was measured on both public
 * examples against it (the change that added the flag); it is opt-in.
 */
export const DEFAULT_PROJECT_RULE: ProjectRule = 'core';

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

export interface Geometry {
  /** The painting's size in source pixels. */
  sourceW: number;
  sourceH: number;
  /** `seethrough.resolution`: both runs' canvas side. */
  resolution: number;
  /** `seethrough.head_box`, source pixels. */
  headBox: [number, number, number, number];
  /** `assemble.rig_scale`: rig pixels per source pixel. */
  rigScale: number;
}

export interface AssembleInput {
  /** The painting. Its alpha is ignored, as the reference's `convert("RGB")` drops it. */
  source: Raster;
  full: LayerSet;
  head: LayerSet;
  resolution: number;
  headBox: [number, number, number, number];
  rigScale: number;
  plan: PlanEntry[];
  extend: Extend[];
  /** `assemble.patches`: extra parts cut from the painting, placed per their `draw` (`placePatches`). */
  patches: Patch[];
  /** `assemble.cuts`: plan parts' pixels taken into new parts by polygon (`cutPart`), placed per their `draw`. */
  cuts: Cut[];
  seamRule: SeamRule;
  projectRule: ProjectRule;
}

/** The derived numbers of the two runs' geometry. */
interface Frame {
  W: number;
  H: number;
  S: number;
  /** Full run: the painting was centred on a white `side x side` square (`squarePad`), padded this much on the left… */
  fullPad: number;
  /** …and this much on top, in source px. At most one of the two is non-zero. */
  fullPadTop: number;
  fullK: number;
  headBox: [number, number, number, number];
  headK: number;
  /** The crop line in rig pixels. */
  headBottom: number;
}

/**
 * Check the geometry and derive the frame, refusing by name what the
 * reference would have mis-read. Every problem is collected.
 */
export function checkGeometry(g: Geometry, runs?: { full: LayerSet; head: LayerSet }): Frame {
  const problems: Problem[] = [];
  const fail = (code: string, object: string, detail: string): void => {
    problems.push({ code, object, detail });
  };
  const { sourceW: w, sourceH: h, resolution, headBox, rigScale: S } = g;
  const pad = squarePad(w, h);
  const W = Math.trunc(w * S);
  const H = Math.trunc(h * S);
  if (W < 1 || H < 1) fail('ASSEMBLE_RIG_SIZE', 'config.assemble.rig_scale', `${S} makes a ${W}x${H} rig from a ${w}x${h} painting; at least 1x1 is required`);
  const [x0, y0, x1, y1] = headBox;
  if (!(x0 >= 0 && y0 >= 0 && x1 <= w && y1 <= h && x1 > x0 && y1 > y0)) {
    fail('ASSEMBLE_HEAD_BOX_INSIDE', 'config.seethrough.head_box', `is [${headBox.join(', ')}]; a non-empty box inside the ${w}x${h} painting is required`);
  }
  const headBottom = Math.trunc(y1 * S) - HEAD_BOTTOM_INSET;
  if (headBottom - CROP_PROBE_ROWS < 0 && y1 > y0) {
    fail(
      'ASSEMBLE_HEAD_BOX_INSIDE',
      'config.seethrough.head_box',
      `bottom ${y1} is rig row ${Math.trunc(y1 * S)}; the crop line (that row - ${HEAD_BOTTOM_INSET}) probes ${CROP_PROBE_ROWS} rows above itself, so a bottom at rig row ${HEAD_BOTTOM_INSET + CROP_PROBE_ROWS} or further down is required`,
    );
  }
  if (runs !== undefined) {
    for (const run of ['full', 'head'] as const) {
      const c = runs[run].canvas;
      if (c.w !== resolution || c.h !== resolution) {
        fail('ASSEMBLE_RUN_CANVAS', `the ${run} run (${runs[run].source})`, `has a ${c.w}x${c.h} canvas; config.seethrough.resolution ${resolution} makes ${resolution}x${resolution} required`);
      }
    }
  }
  refuseIfAny(problems);
  return {
    W,
    H,
    S,
    fullPad: pad.left,
    fullPadTop: pad.top,
    fullK: pad.side / resolution,
    headBox,
    headK: (x1 - x0) / resolution,
    headBottom,
  };
}

// ---------------------------------------------------------------------------
// step 1 — ghost clean-up
// ---------------------------------------------------------------------------

/**
 * Place a layer's pixels on its run's `resolution x resolution` canvas.
 * `readWrapperLayers`/`readPsdLayers` already refused a box outside it.
 */
export function placeLayer(layer: Layer, resolution: number): Raster {
  const out = newRaster(resolution, resolution);
  const p = layer.pixels;
  for (let y = 0; y < p.height; y++) {
    out.data.set(p.data.subarray(y * p.width * 4, (y + 1) * p.width * 4), ((layer.top + y) * resolution + layer.left) * 4);
  }
  return out;
}

/**
 * Step 1. See-through writes every tag, and an empty tag still carries a few
 * dozen sub-threshold pixels scattered at the canvas edge.
 *
 * ⚖️ Invariant: afterwards the layer's alpha is non-zero only on the 8-connected
 * components of `alpha > 8` whose area is at least `GHOST_MIN_AREA` and at
 * least `GHOST_MIN_FRACTION` of the largest component's; every other pixel —
 * including every pixel of alpha 8 or less — has alpha 0. Colour channels are
 * untouched. `ghostPx` counts the `alpha > 8` pixels removed. A layer with no
 * `alpha > 8` pixel comes back fully transparent with `ghostPx` 0.
 * (`assemble_parts.py` `clean`.)
 */
export function cleanGhosts(canvas: Raster): { canvas: Raster; ghostPx: number } {
  const { width: w, height: h } = canvas;
  const out: Raster = { width: w, height: h, data: new Uint8ClampedArray(canvas.data) };
  const m = newMask(w, h);
  let any = false;
  for (let i = 0; i < w * h; i++) {
    if (canvas.data[i * 4 + 3] > OPAQUE_ALPHA_ABOVE) {
      m.data[i] = 1;
      any = true;
    }
  }
  if (!any) {
    for (let i = 0; i < w * h; i++) out.data[i * 4 + 3] = 0;
    return { canvas: out, ghostPx: 0 };
  }
  const cc = connectedComponents(m, 8);
  let big = 0;
  for (let l = 1; l < cc.count; l++) big = Math.max(big, cc.stats[l].area);
  const keep = new Uint8Array(cc.count);
  for (let l = 1; l < cc.count; l++) keep[l] = cc.stats[l].area >= Math.max(GHOST_MIN_AREA, GHOST_MIN_FRACTION * big) ? 1 : 0;
  let ghostPx = 0;
  for (let i = 0; i < w * h; i++) {
    const l = cc.labels[i];
    if (keep[l] === 0) {
      if (m.data[i] === 1) ghostPx++;
      out.data[i * 4 + 3] = 0;
    }
  }
  return { canvas: out, ghostPx };
}

export interface RunLayer {
  tag: string;
  /** The cleaned run-space canvas. */
  canvas: Raster;
  drawOrder: number;
  ghostPx: number;
  /** `alpha > 8` pixels after clean-up, in run pixels. */
  opaqueRunPx: number;
}

/** Every layer of a run, placed and cleaned, in draw order (back to front). */
export function runLayers(set: LayerSet, resolution: number): RunLayer[] {
  return set.layers.map((layer) => {
    const { canvas, ghostPx } = cleanGhosts(placeLayer(layer, resolution));
    let opaqueRunPx = 0;
    for (let i = 3; i < canvas.data.length; i += 4) if (canvas.data[i] > OPAQUE_ALPHA_ABOVE) opaqueRunPx++;
    return { tag: layer.name, canvas, drawOrder: layer.drawOrder, ghostPx, opaqueRunPx };
  });
}

// ---------------------------------------------------------------------------
// step 2 — resample into rig space
// ---------------------------------------------------------------------------

/** The run-to-rig map: `rig = k * run + (tx, ty)`, in float32 as the reference's `np.float32` matrix holds it. */
export function runMap(frame: Frame, run: Run): { k: number; sx: number; tx: number; ty: number } {
  if (run === 'full') {
    const k = frame.fullK * frame.S;
    // A portrait painting's top pad is 0, and its ty is the reference's literal 0 rather than f32(-0).
    return { k, sx: f32(k), tx: f32(-frame.fullPad * frame.S), ty: frame.fullPadTop === 0 ? 0 : f32(-frame.fullPadTop * frame.S) };
  }
  const k = frame.headK * frame.S;
  return { k, sx: f32(k), tx: f32(frame.headBox[0] * frame.S), ty: f32(frame.headBox[1] * frame.S) };
}

/**
 * Step 2. Warp a run-space layer into the `W x H` rig, premultiplied.
 *
 * ⚖️ Invariant: the result is `cv2.warpAffine` of the premultiplied layer
 * through `runMap` — bicubic when the map enlarges (`k >= 1`), and the
 * reference's `INTER_AREA` otherwise, which `warpAffine` answers with its
 * bilinear filter (`src/raster/warp.ts` measured that) — clipped to 0..255,
 * un-premultiplied, and truncated to 8 bits. Premultiplying and
 * un-premultiplying are done in float32, as numpy does them on a float32
 * array. A layer with no non-zero alpha maps to a fully transparent rig layer
 * without being warped: every tap would read 0.
 * (`assemble_parts.py` `to_rig`.)
 */
export function layerToRig(canvas: Raster, frame: Frame, run: Run): Raster {
  const { W, H } = frame;
  const n = canvas.width * canvas.height;
  let any = false;
  for (let i = 0; i < n && !any; i++) if (canvas.data[i * 4 + 3] !== 0) any = true;
  if (!any) return newRaster(W, H);
  const pre = newFloatImage(canvas.width, canvas.height, 4);
  for (let i = 0; i < n; i++) {
    const a = canvas.data[i * 4 + 3];
    const af = f32(a / 255);
    for (let c = 0; c < 3; c++) pre.data[i * 4 + c] = f32(canvas.data[i * 4 + c] * af);
    pre.data[i * 4 + 3] = a;
  }
  const m = runMap(frame, run);
  const wr = warpAffine(pre, { sx: m.sx, sy: m.sx, tx: m.tx, ty: m.ty }, W, H, m.k < 1 ? 'bilinear' : 'bicubic');
  const out = newRaster(W, H);
  const eps = f32(1e-3);
  const clip = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let i = 0; i < W * H; i++) {
    const a = f32(clip(wr.data[i * 4 + 3]));
    for (let c = 0; c < 3; c++) {
      const v = f32(clip(wr.data[i * 4 + c]));
      out.data[i * 4 + c] = a > 0 ? Math.trunc(clip(f32(f32(v * 255) / Math.max(a, eps)))) : 0;
    }
    out.data[i * 4 + 3] = Math.trunc(a);
  }
  return out;
}

/**
 * The painting in rig space: `PIL.Image.resize(..., LANCZOS)` of its RGB, as
 * an opaque raster. (`src/raster/resize.ts` `lanczos3` is PIL's, bit-exact;
 * with alpha 255 its premultiply round trip is the identity.)
 */
export function sourceInRig(source: Raster, W: number, H: number): Raster {
  const rgb: Raster = { width: source.width, height: source.height, data: new Uint8ClampedArray(source.data) };
  for (let i = 3; i < rgb.data.length; i += 4) rgb.data[i] = 255;
  return resize(rgb, W, H, 'lanczos3');
}

// ---------------------------------------------------------------------------
// step 3 — source projection
// ---------------------------------------------------------------------------

export interface ProjectionStats {
  core: number;
  taken: number;
  refused: number;
  /**
   * Where no later layer of the run is opaque (`alpha >= 250`) in front of
   * this one: the run's owner of the pixel is this layer or one behind it. A
   * pixel of this layer with alpha above 8 is VISIBLE exactly where this is
   * set, and OCCLUDED everywhere else.
   */
  clear: Mask;
  /** The pixels counted in `taken`: the accepted set, cut to the core. */
  takenMask: Mask;
  /** The pixels counted in `core`, and in `refused`; null when the layer has no top-most pixel (both counts 0). A cut splits the counts by these. */
  coreMask: Mask | null;
  refusedMask: Mask | null;
}

function maxDiff(a: Uint8ClampedArray, i: number, b: Uint8ClampedArray, j: number): number {
  return Math.max(Math.abs(a[i] - b[j]), Math.abs(a[i + 1] - b[j + 1]), Math.abs(a[i + 2] - b[j + 2]));
}

/**
 * Step 3, over one run's layers in draw order. Modifies each rig layer's
 * colour in place and returns its counts.
 *
 * ⚖️ Invariant: a layer's CORE is where it is the top-most `alpha >= 250`
 * layer of its own run, eroded by a 5x5 square. Inside the core, the pixels
 * that agree with the painting (max channel difference <= `DRIFT_LIMIT`),
 * closed by 5x5 and cut back to the core — and, for the head run, kept
 * `HEAD_WINDOW_INSET` pixels inside the head crop — are the ACCEPTED set. The
 * colour becomes `w * painting + (1 - w) * layer`, truncated, with `w` the
 * accepted set blurred by a Gaussian of sigma 1 and zeroed outside the core;
 * outside the core nothing changes, alpha never changes, and occluded pixels
 * keep See-through's synthesis. `core`, `taken` (accepted) and `refused` (core
 * pixels over the drift limit, before closing) are counted.
 * (`assemble_parts.py` `main`, the per-run loop.)
 *
 * With `rule: 'visible'` (NOT in the reference) the core is the top-most
 * `alpha >= 250` set less every pixel within the 5x5 square of a pixel where a
 * LATER layer of the run is the owner — the erosion kept only along a rim with
 * a neighbour in front, where the painting's pixel may be that neighbour's
 * edge. Every other step is the same. Fringe pixels (alpha below 250) are not
 * projected under either rule: the painting there is this layer blended with
 * what is behind it.
 *
 * Both rules return `clear` (no later layer is the owner) and `takenMask`, the
 * masks the part counts in `parts.json` are derived from; `takenMask` is a
 * subset of the top-most set, and so of `clear`.
 */
export function projectSource(rigLayers: Raster[], srcr: Raster, frame: Frame, run: Run, rule: ProjectRule = DEFAULT_PROJECT_RULE): ProjectionStats[] {
  const { W, H } = frame;
  const owner = new Int32Array(W * H).fill(-1);
  rigLayers.forEach((r, i) => {
    for (let p = 0; p < W * H; p++) if (r.data[p * 4 + 3] >= CORE_ALPHA) owner[p] = i;
  });
  let win: Mask | null = null;
  if (run === 'head') {
    win = newMask(W, H);
    const [bx0, by0, bx1, by1] = frame.headBox;
    const x0 = Math.max(0, Math.trunc(bx0 * frame.S) + HEAD_WINDOW_INSET);
    const y0 = Math.max(0, Math.trunc(by0 * frame.S) + HEAD_WINDOW_INSET);
    const x1 = Math.min(W, Math.trunc(bx1 * frame.S) - HEAD_WINDOW_INSET);
    const y1 = Math.min(H, Math.trunc(by1 * frame.S) - HEAD_WINDOW_INSET);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) win.data[y * W + x] = 1;
  }
  return rigLayers.map((r, i) => {
    const top = newMask(W, H);
    const clear = newMask(W, H);
    const takenMask = newMask(W, H);
    let anyTop = false;
    for (let p = 0; p < W * H; p++) {
      if (owner[p] <= i) clear.data[p] = 1;
      if (owner[p] === i && r.data[p * 4 + 3] >= CORE_ALPHA) {
        top.data[p] = 1;
        anyTop = true;
      }
    }
    if (!anyTop) return { core: 0, taken: 0, refused: 0, clear, takenMask, coreMask: null, refusedMask: null };
    let core: Mask;
    if (rule === 'core') core = erode(top, CORE_KERNEL);
    else {
      const front = newMask(W, H);
      for (let p = 0; p < W * H; p++) if (owner[p] > i) front.data[p] = 1;
      const rim = dilate(front, CORE_KERNEL);
      core = newMask(W, H);
      for (let p = 0; p < W * H; p++) if (top.data[p] === 1 && rim.data[p] === 0) core.data[p] = 1;
    }
    const ok = newMask(W, H);
    const refusedMask = newMask(W, H);
    let coreN = 0;
    let refused = 0;
    for (let p = 0; p < W * H; p++) {
      if (core.data[p] === 0) continue;
      coreN++;
      if (maxDiff(r.data, p * 4, srcr.data, p * 4) <= DRIFT_LIMIT) ok.data[p] = 1;
      else {
        refused++;
        refusedMask.data[p] = 1;
      }
    }
    const closed = morphClose(ok, CORE_KERNEL);
    const okf = newFloatImage(W, H, 1);
    let taken = 0;
    for (let p = 0; p < W * H; p++) {
      const v = closed.data[p] === 1 && core.data[p] === 1 && (win === null || win.data[p] === 1) ? 1 : 0;
      okf.data[p] = v;
      takenMask.data[p] = v;
      taken += v;
    }
    const blurred = gaussianBlur(okf, FEATHER_SIGMA);
    for (let p = 0; p < W * H; p++) {
      if (core.data[p] === 0) continue;
      const w = blurred.data[p];
      const rest = f32(1 - w);
      for (let c = 0; c < 3; c++) {
        const v = f32(f32(w * srcr.data[p * 4 + c]) + f32(rest * r.data[p * 4 + c]));
        r.data[p * 4 + c] = Math.trunc(v < 0 ? 0 : v > 255 ? 255 : v);
      }
    }
    return { core: coreN, taken, refused, clear, takenMask, coreMask: core, refusedMask };
  });
}

// ---------------------------------------------------------------------------
// step 4 — merge below the head crop
// ---------------------------------------------------------------------------

/**
 * The pixels of `extra` (a full-run layer in rig space) that continue `part`
 * below the crop line.
 *
 * ⚖️ Invariant: the result is every 8-connected component of `extra`'s
 * `alpha > 8` pixels at or below row `headBottom` that has a pixel in rows
 * `headBottom .. headBottom + 5` within `CROP_SEED_COLUMNS` columns of a column
 * where `part` has alpha above 128 on row `headBottom - 2`. Whole components,
 * so a long lock keeps its own outline to the tip. Empty when `part` does not
 * reach the line or `extra` has nothing below it.
 * (`assemble_parts.py` `below_crop`.)
 */
export function belowCrop(part: Raster, extra: Raster, headBottom: number): Mask {
  const { width: W, height: H } = part;
  const sel = newMask(W, H);
  const below = newMask(W, H);
  let anyBelow = false;
  for (let y = Math.max(0, headBottom); y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (extra.data[(y * W + x) * 4 + 3] > OPAQUE_ALPHA_ABOVE) {
        below.data[y * W + x] = 1;
        anyBelow = true;
      }
    }
  }
  const probe = headBottom - CROP_PROBE_ROWS;
  const near = new Uint8Array(W);
  let anyCol = false;
  for (let x = 0; x < W; x++) {
    if (part.data[(probe * W + x) * 4 + 3] > CROP_PROBE_ALPHA) {
      anyCol = true;
      for (let c = Math.max(0, x - CROP_SEED_COLUMNS); c <= Math.min(W - 1, x + CROP_SEED_COLUMNS); c++) near[c] = 1;
    }
  }
  if (!anyCol || !anyBelow) return sel;
  const cc = connectedComponents(below, 8);
  const chosen = new Uint8Array(cc.count);
  for (let y = Math.max(0, headBottom); y < Math.min(H, headBottom + CROP_SEED_ROWS); y++) {
    for (let x = 0; x < W; x++) {
      const l = cc.labels[y * W + x];
      if (l > 0 && near[x] === 1) chosen[l] = 1;
    }
  }
  for (let p = 0; p < W * H; p++) if (chosen[cc.labels[p]] === 1 && extra.data[p * 4 + 3] > 0) sel.data[p] = 1;
  return sel;
}

/**
 * Close the half-pixel seam round a merged-in piece: the full run's silhouette
 * is a few pixels narrower than the painting, and a renderer's sub-pixel
 * resample shows the layer beneath along that edge.
 *
 * ⚖️ Invariant: the RING is the 3x3 dilation of `sel`'s `alpha >= 250` pixels,
 * restricted to pixels where `part` has alpha below 250, the painting is not
 * near-white (min channel <= 235) and no later plan part covers
 * (`front`, alpha >= 128). Every ring pixel takes the painting's colour at
 * alpha 255, so the flat composite there equals the painting; the count is
 * returned. Nothing changes when `sel` is empty. When `touched` is given,
 * every ring pixel written is set in it.
 * (`assemble_parts.py` `grow_rim`.)
 */
export function growRim(part: Raster, sel: Mask, srcr: Raster, front: Mask | null, touched?: Mask): number {
  const { width: W, height: H } = part;
  const core = newMask(W, H);
  let anySel = false;
  for (let p = 0; p < W * H; p++) {
    if (sel.data[p] === 1) {
      anySel = true;
      if (part.data[p * 4 + 3] >= CORE_ALPHA) core.data[p] = 1;
    }
  }
  if (!anySel) return 0;
  const ring = dilate(core, 3);
  let grown = 0;
  for (let p = 0; p < W * H; p++) {
    if (ring.data[p] === 0 || part.data[p * 4 + 3] >= CORE_ALPHA) continue;
    const s = p * 4;
    if (Math.min(srcr.data[s], srcr.data[s + 1], srcr.data[s + 2]) > NEAR_WHITE_MIN) continue;
    if (front !== null && front.data[p] === 1) continue;
    part.data[s] = srcr.data[s];
    part.data[s + 1] = srcr.data[s + 1];
    part.data[s + 2] = srcr.data[s + 2];
    part.data[s + 3] = 255;
    if (touched !== undefined) touched.data[p] = 1;
    grown++;
  }
  return grown;
}

/**
 * Step 4 for one part. Modifies `part` in place and returns `merged_px`.
 *
 * ⚖️ Invariant: for each `extend_below_crop` entry naming this part, the
 * `belowCrop` pixels are copied from the extend layer (colour and alpha), then
 * `growRim` closes their seam against the later plan parts. `merged_px` is the
 * copied pixels plus the ring of the LAST such entry — the reference assigns
 * rather than adds, and that is kept (a part with one entry, the only case the
 * reference's corpus has, is unaffected).
 *
 * When `trace` is given, every pixel an entry wrote (copied or ring) has
 * `trace.from` set to that entry's index in `extras`, a later entry
 * overwriting an earlier one — the layer whose run says whether the pixel is
 * visible — and `trace.ring` set when the last write was the ring's.
 */
export function mergeBelowCrop(part: Raster, extras: Raster[], front: Mask, srcr: Raster, headBottom: number, trace?: MergeTrace): number {
  let merged = 0;
  extras.forEach((extra, e) => {
    const sel = belowCrop(part, extra, headBottom);
    let copied = 0;
    for (let p = 0; p < sel.data.length; p++) {
      if (sel.data[p] === 0) continue;
      copied++;
      part.data.set(extra.data.subarray(p * 4, p * 4 + 4), p * 4);
      if (trace !== undefined) {
        trace.from[p] = e;
        trace.ring.data[p] = 0;
      }
    }
    const ring = newMask(part.width, part.height);
    merged = copied + growRim(part, sel, srcr, front, ring);
    if (trace !== undefined) {
      trace.lastSel = sel;
      trace.lastRing = ring;
      for (let p = 0; p < ring.data.length; p++) {
        if (ring.data[p] === 1) {
          trace.from[p] = e;
          trace.ring.data[p] = 1;
        }
      }
    }
  });
  return merged;
}

/** Which extend entry last wrote each pixel (-1: none), and whether that write was the ring's. */
export interface MergeTrace {
  from: Int32Array;
  ring: Mask;
  /**
   * The last entry's copied pixels and its ring: `merged_px` is their two
   * counts added (the reference assigns per entry), so a cut splits it by
   * where these lie. Absent when no entry ran.
   */
  lastSel?: Mask;
  lastRing?: Mask;
}

export interface VisibilityCounts {
  visible_px: number;
  occluded_px: number;
  visible_not_projected_px: number;
  /** The part's projected pixels, the part layer's and any a merge copied in. */
  projected: number;
}

/**
 * The visibility counts of one part, from the masks its pixels were made
 * with, refusing — as a bug, not a report — when they do not add up.
 *
 * ⚖️ Invariant: `opaque` is the part's `alpha > 8` pixels; `visible` the pixels
 * set in `visible`; `occluded` the opaque pixels NOT set in it; `projected` the
 * pixels set in `projected`. Required: `visible + occluded = opaque` (so every
 * visible pixel is opaque) and every projected pixel is visible;
 * `visible_not_projected = visible - projected`. The assembler builds
 * `visible` as the opaque pixels no later layer of their run is in front of,
 * and `projected` as the accepted set of `projectSource`, so both hold by
 * construction and a refusal here names a mask that escaped its definition.
 */
export function visibilityCounts(object: string, part: Raster, visible: Mask, projected: Mask): VisibilityCounts {
  const n = part.width * part.height;
  let opaque = 0;
  let vis = 0;
  let occ = 0;
  let proj = 0;
  let projHidden = 0;
  for (let p = 0; p < n; p++) {
    const o = part.data[p * 4 + 3] > OPAQUE_ALPHA_ABOVE;
    if (o) opaque++;
    if (visible.data[p] === 1) vis++;
    else if (o) occ++;
    if (projected.data[p] === 1) {
      proj++;
      if (visible.data[p] !== 1) projHidden++;
    }
  }
  const problems: Problem[] = [];
  if (vis + occ !== opaque) {
    problems.push({
      code: 'ASSEMBLE_COUNTS_ADD_UP',
      object,
      detail: `visible ${vis} + occluded ${occ} = ${vis + occ}, opaque (alpha above ${OPAQUE_ALPHA_ABOVE}) ${opaque}; equal is required — the visible mask holds ${vis + occ - opaque} pixel(s) that are not opaque (a bug in the assembler, not in the inputs)`,
    });
  }
  if (projHidden > 0) {
    problems.push({
      code: 'ASSEMBLE_COUNTS_ADD_UP',
      object,
      detail: `${projHidden} of ${proj} projected pixel(s) are not visible; projected <= visible, pixel by pixel, is required — a pixel a later layer covers was taken from the painting (a bug in the assembler, not in the inputs)`,
    });
  }
  refuseIfAny(problems);
  return { visible_px: vis, occluded_px: occ, visible_not_projected_px: vis - proj, projected: proj };
}

// ---------------------------------------------------------------------------
// step 5 — seam override
// ---------------------------------------------------------------------------

/**
 * The figure, as a mask over the rig: the pixels whose colour differs from
 * the median colour of the painting's outer `SILHOUETTE_BORDER`-pixel ring by
 * more than `SILHOUETTE_LIMIT` (max channel), opened twice by a 3x3 square
 * (erode twice, dilate twice) to drop edge noise, with every enclosed hole
 * filled — so a white blouse inside the figure's outline is figure, and the
 * white page round it is not. Computed once, from the painting alone.
 *
 * This is NOT in the reference. It is the input of `seamRule: 'silhouette'`.
 */
export function figureSilhouette(srcr: Raster): Mask {
  const { width: W, height: H } = srcr;
  const ring: number[][] = [[], [], []];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (y >= SILHOUETTE_BORDER && y < H - SILHOUETTE_BORDER && x >= SILHOUETTE_BORDER && x < W - SILHOUETTE_BORDER) continue;
      for (let c = 0; c < 3; c++) ring[c].push(srcr.data[(y * W + x) * 4 + c]);
    }
  }
  const median = ring.map((v) => {
    const s = [...v].sort((a, b) => a - b);
    const n = s.length;
    return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  });
  const fig = newMask(W, H);
  for (let p = 0; p < W * H; p++) {
    const d = Math.max(...[0, 1, 2].map((c) => Math.abs(srcr.data[p * 4 + c] - median[c])));
    if (d > SILHOUETTE_LIMIT) fig.data[p] = 1;
  }
  const opened = dilate(dilate(erode(erode(fig, 3), 3), 3), 3);
  return fillHoles(opened);
}

export interface PlacedPart {
  record: PartRecord;
  image: Raster;
}

/** The seam pass's view of a stack of parts, before anything is recoloured (`seamCandidates`). */
export interface SeamCandidates {
  /** Per rig pixel: the index of the top-most part with alpha above 0 there, or -1. */
  top: Int32Array;
  /** Per rig pixel: the index of the top-most part with alpha >= `CORE_ALPHA` there, or -1. */
  holder: Int32Array;
  /** Per rig pixel: 1 where the seam rule admits the pixel as a candidate (`seamOverride`'s invariant). */
  cand: Uint8Array;
}

/**
 * The candidates of the seam pass over `parts` in draw order, exactly as
 * `seamOverride` defines them (its invariant): the flat composite on white,
 * in float as the reference composites; a candidate differs from the
 * painting by more than `SEAM_LIMIT` (max channel), is covered by some part
 * (alpha > 0) and is admitted by the rule. Also returned: which part is the
 * top-most cover of each pixel, and which is the top-most at alpha >=
 * `CORE_ALPHA` — the part that holds the pixel.
 */
export function seamCandidates(parts: PlacedPart[], srcr: Raster, rule: SeamRule, silhouette: Mask | null): SeamCandidates {
  const { width: W, height: H } = srcr;
  const top = new Int32Array(W * H).fill(-1);
  const holder = new Int32Array(W * H).fill(-1);
  const can = new Float64Array(W * H * 3).fill(255);
  parts.forEach(({ record: p, image }, i) => {
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const s = (y * p.w + x) * 4;
        const d = (p.y + y) * W + p.x + x;
        const alpha = image.data[s + 3];
        if (alpha > 0) top[d] = i;
        if (alpha >= CORE_ALPHA) holder[d] = i;
        const a = f32(alpha / 255);
        const one = f32(1 - a);
        for (let c = 0; c < 3; c++) can[d * 3 + c] = can[d * 3 + c] * one + f32(image.data[s + c] * a);
      }
    }
  });
  const cand = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    if (top[p] < 0) continue;
    const s = p * 4;
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(can[p * 3 + c] - srcr.data[s + c]));
    if (!(d > SEAM_LIMIT)) continue;
    const painted = Math.min(srcr.data[s], srcr.data[s + 1], srcr.data[s + 2]) <= NEAR_WHITE_MIN;
    const admitted = rule === 'near-white' ? painted : painted || (silhouette !== null && silhouette.data[p] === 1);
    if (admitted) cand[p] = 1;
  }
  return { top, holder, cand };
}

/** Pixels of one part's fringe that `pushBackFringe` cleared, counted by the part that holds them. */
export interface FringePushed {
  /** The part drawn beneath, at alpha >= `CORE_ALPHA`, that the painting shows there. */
  part: string;
  px: number;
}

/** The art mask the contour mesher reads (alpha above 8), and its 4-connected islands. */
function artIslands(image: Raster): { labels: Int32Array; count: number; core: Uint8Array; area: Int32Array } {
  const n = image.width * image.height;
  const art = newMask(image.width, image.height);
  for (let q = 0; q < n; q++) if (image.data[q * 4 + 3] > OPAQUE_ALPHA_ABOVE) art.data[q] = 1;
  const cc = connectedComponents(art, 4);
  const core = new Uint8Array(cc.count);
  const area = new Int32Array(cc.count);
  for (let q = 0; q < n; q++) {
    const l = cc.labels[q];
    if (l === 0) continue;
    area[l]++;
    if (image.data[q * 4 + 3] >= CORE_ALPHA) core[l] = 1;
  }
  return { labels: cc.labels, count: cc.count, core, area };
}

/** One pixel `pushBackFringe` cleared: its index in the part's box, its RGBA before, its holder's index in the stack, and whether it is still clear. */
interface Cleared {
  q: number;
  rgba: number[];
  h: number;
  on: boolean;
}

/**
 * `pushBackFringe`'s after-step on one part: clearing a fringe never splits
 * an island of the part's art. The art is the contour mesher's reading —
 * alpha above 8, 4-connected (`src/contour.ts`, `CONTOUR_ONE_ISLAND`) — and
 * the islands before the clearing are the part's islands with every cleared
 * pixel put back.
 *
 * ⚖️ Invariant: afterwards every island the part had before is at most one
 * island. Where the clearing left one in several pieces, the largest piece
 * (by area; the first in scan order on a tie) stays, and each other piece is
 * either
 * - a CRUMB — every pixel below `CORE_ALPHA`, and every pixel either held
 *   by some part at alpha >= `CORE_ALPHA` (`holderAt` >= 0) or not covering
 *   (alpha <= `COVERED_ALPHA`), so clearing it uncovers nothing — which is
 *   cleared too: a piece of the same fringe, cut off from its part. Its
 *   pixels are counted against the holder of the first cleared pixel beside
 *   it, the clearing that cut it off; or
 * - anything else (it holds a pixel at alpha >= `CORE_ALPHA`, or a covering
 *   pixel nothing holds), in which case every cleared pixel 4-adjacent to it
 *   is put back as it was.
 * Repeated until no island is split: the pieces were joined only through
 * cleared pixels, and each round clears a crumb or puts a pixel back, so the
 * loop ends.
 * So the part's island count never rises, and `CONTOUR_ONE_ISLAND` reads
 * the islands it read before. Without the bridge put back, the clearing cut a
 * 7 px piece of opaque art off demo's `sleeves` (the pull request that added
 * this step); a fringe cleared along a long edge leaves a crumb wherever the
 * edge was two pixels wide, and selftest `AS47` plants both.
 */
function keepArtWhole(part: PlacedPart, cleared: Cleared[], holderAt: (q: number) => number): void {
  if (cleared.length === 0) return;
  const { image } = part;
  const { width: w, height: h } = image;
  const n = w * h;
  const whole: Raster = { width: w, height: h, data: new Uint8ClampedArray(image.data) };
  for (const c of cleared) whole.data.set(c.rgba, c.q * 4);
  const before = artIslands(whole);
  for (;;) {
    const after = artIslands(image);
    // Per piece: its island before, and whether it is a crumb; per island before: its pieces and the largest.
    const islandOf = new Int32Array(after.count).fill(-1);
    const crumb = new Uint8Array(after.count).fill(1);
    const pieces = new Int32Array(before.count);
    const largest = new Int32Array(before.count).fill(-1);
    for (let q = 0; q < n; q++) {
      const l = after.labels[q];
      if (l === 0) continue;
      if (islandOf[l] < 0) {
        const b = before.labels[q];
        islandOf[l] = b;
        pieces[b]++;
        if (largest[b] < 0 || after.area[l] > after.area[largest[b]]) largest[b] = l;
      }
      const a = image.data[q * 4 + 3];
      if (a >= CORE_ALPHA || (a > COVERED_ALPHA && holderAt(q) < 0)) crumb[l] = 0;
    }
    const split = (l: number): boolean => l > 0 && pieces[islandOf[l]] > 1 && largest[islandOf[l]] !== l;
    const beside = (c: Cleared): number[] => {
      const x = c.q % w;
      const y = (c.q - x) / w;
      return [x > 0 ? c.q - 1 : -1, x < w - 1 ? c.q + 1 : -1, y > 0 ? c.q - w : -1, y < h - 1 ? c.q + w : -1].filter((m) => m >= 0 && split(after.labels[m])).map((m) => after.labels[m]);
    };
    // A crumb is counted against the holder of the first cleared pixel beside it: the clearing that cut it off.
    const cutBy = new Int32Array(after.count).fill(-1);
    for (const c of cleared) if (c.on) for (const l of beside(c)) if (crumb[l] === 1 && cutBy[l] < 0) cutBy[l] = c.h;
    for (let l = 1; l < after.count; l++) if (cutBy[l] < 0) crumb[l] = 0;
    const restore = cleared.filter((c) => c.on && beside(c).some((l) => crumb[l] === 0));
    let changed = 0;
    for (let q = 0; q < n; q++) {
      const l = after.labels[q];
      if (!split(l) || crumb[l] === 0) continue;
      cleared.push({ q, rgba: Array.from(image.data.subarray(q * 4, q * 4 + 4)), h: cutBy[l], on: true });
      image.data.fill(0, q * 4, q * 4 + 4);
      changed++;
    }
    for (const c of restore) {
      image.data.set(c.rgba, c.q * 4);
      c.on = false;
      changed++;
    }
    if (changed === 0) break;
  }
}

/**
 * Step 4b (issue #119), over every part in draw order, before the seam
 * override. Modifies the part images in place and returns, per part, the
 * pixels it cleared, by holder.
 *
 * ⚖️ Invariant: a pixel is PUSHED BACK in a part when, over the stack as it
 * stands (`seamCandidates`): (1) the pixel is a seam candidate — the flat
 * composite differs from the painting by more than `SEAM_LIMIT` (max
 * channel) and the seam rule admits it; (2) this part is drawn after the
 * pixel's HOLDER — the top-most part at alpha >= `CORE_ALPHA` there — with
 * alpha above 0, which makes it a fringe (below `CORE_ALPHA`, or it would be
 * the holder) that the seam override, recolouring only at alpha >=
 * `CORE_ALPHA`, cannot reach; and (3) the holder is in the painting's colour
 * — its own RGB within `SEAM_LIMIT` of the painting's (max channel): the
 * painting shows the holder there. Every such pixel becomes transparent (all
 * four channels 0). Then `keepArtWhole` holds each part's art to the islands
 * it had: a crumb the clearing cut off is cleared too, and a cleared bridge
 * to opaque art is put back. No constant is new: (1) and (2) are the seam
 * override's own candidate set and alpha, (3) is the seam override's own
 * limit, applied to the part the pixel falls back to, and the islands are the
 * contour mesher's reading of the art. Where the holder is itself the top
 * cover, nothing is drawn after it and nothing is cleared: a pixel at alpha
 * >= `CORE_ALPHA` is the seam override's, as before.
 *
 * Why (3) asks for the holder's colour: without it a fringe that is too
 * faint rather than the wrong colour — an earring's edge over hair, where the
 * painting shows the earring — is cleared too, and the seam override then
 * paints the earring's colour onto the hair beneath, which moves with the
 * hair: the sliver this rule exists to remove, moved to the other part.
 * Measured on the public examples (the pull request that closed issue #119):
 * without (3) the holders' `seam_override_px` rose from 47 to 617 on demo's
 * `hair_back` and from 20 to 222 on sample's `bottomwear`; with it, and with
 * the crumbs `keepArtWhole` clears, no part's `seam_override_px` moved by
 * more than 1 on either example under either seam rule.
 *
 * Why it is right to clear rather than to recolour: the holder is opaque
 * there, so no pixel loses cover (`COVERED_ALPHA` is below `CORE_ALPHA`) and
 * no uncovered error pixel appears; and the colour the painting shows there
 * belongs to the holder, which moves with the holder's bones. A fringe
 * recoloured to the painting would carry the holder's colour on the part in
 * front, as a translucent rim that leaves the holder when the two move apart.
 *
 * Left alone: a pixel whose stack composites to within `SEAM_LIMIT` of the
 * painting (an anti-aliased edge that is the painting's edge); a fringe no
 * part holds beneath (the figure's outline over the page — nothing would
 * hold the pixel after it); and every pixel at alpha >= `CORE_ALPHA`, which
 * is the seam override's.
 */
export function pushBackFringe(parts: PlacedPart[], srcr: Raster, rule: SeamRule, silhouette: Mask | null): FringePushed[][] {
  const { width: W } = srcr;
  const { holder, cand } = seamCandidates(parts, srcr, rule, silhouette);
  const at = (i: number, d: number): number => {
    const p = parts[i].record;
    const x = (d % W) - p.x;
    const y = Math.floor(d / W) - p.y;
    return x >= 0 && x < p.w && y >= 0 && y < p.h ? (y * p.w + x) * 4 : -1;
  };
  /** The holder shows the painting at rig pixel `d`: it exists and its own colour is within `SEAM_LIMIT` of the painting's. */
  const shows = (d: number): boolean => holder[d] >= 0 && maxDiff(parts[holder[d]].image.data, at(holder[d], d), srcr.data, d * 4) <= SEAM_LIMIT;
  /** Per part, every pixel cleared: its index in the part's box, its colour before, its holder, and whether it is still clear. */
  const cleared: Cleared[][] = parts.map(() => []);
  for (let d = 0; d < cand.length; d++) {
    // Every part drawn after the holder is below CORE_ALPHA there, by the holder's definition; when the holder is the top
    // cover itself the loop below has nothing to clear, and the seam override acts on the pixel as before.
    if (cand[d] === 0 || !shows(d)) continue;
    for (let i = holder[d] + 1; i < parts.length; i++) {
      const s = at(i, d);
      if (s < 0) continue;
      const img = parts[i].image.data;
      if (img[s + 3] === 0) continue;
      cleared[i].push({ q: s / 4, rgba: Array.from(img.subarray(s, s + 4)), h: holder[d], on: true });
      img.fill(0, s, s + 4);
    }
  }
  parts.forEach((part, i) => keepArtWhole(part, cleared[i], (q) => {
    const d = (part.record.y + Math.floor(q / part.record.w)) * W + part.record.x + (q % part.record.w);
    return holder[d];
  }));
  const counts: Array<Map<number, number>> = parts.map(() => new Map());
  cleared.forEach((list, i) => {
    for (const c of list) if (c.on) counts[i].set(c.h, (counts[i].get(c.h) ?? 0) + 1);
  });
  return counts.map((m) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([h, px]) => ({ part: parts[h].record.name, px })),
  );
}

/**
 * Step 5, over every part in plan order. Modifies the part images in place and
 * sets each record's `seam_override_px`.
 *
 * ⚖️ Invariant: over the flat composite of the parts on white (float, as the
 * reference composites), a CANDIDATE is a pixel differing from the painting by
 * more than `SEAM_LIMIT` (max channel) that some part covers (alpha > 0) and
 * that the rule admits — `near-white` (the reference's): the painting's min
 * channel is <= 235; `silhouette`: that, OR the pixel is inside
 * `figureSilhouette` — so a near-white painting pixel is protected only
 * outside the figure, which is the background the reference's guard exists
 * to protect. (Replacing the whiteness test by the silhouette outright was
 * measured and rejected: the opened mask loses figure-edge pixels the
 * whiteness test admits, and error px rose on eight of ten oracle
 * characters — ORACLE_assemble.md.)
 * Each candidate is recoloured to the painting's colour in the TOP-MOST part
 * covering it, and only where that part's alpha is >= 250; alpha never
 * changes. Candidates are chosen once, before any recolouring.
 * (`assemble_parts.py` `main`, "5. seam override".)
 */
export function seamOverride(parts: PlacedPart[], srcr: Raster, rule: SeamRule, silhouette: Mask | null): void {
  const { width: W } = srcr;
  const { top, cand } = seamCandidates(parts, srcr, rule, silhouette);
  parts.forEach(({ record: p, image }, i) => {
    let n = 0;
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const d = (p.y + y) * W + p.x + x;
        const s = (y * p.w + x) * 4;
        if (cand[d] === 0 || top[d] !== i || image.data[s + 3] < CORE_ALPHA) continue;
        image.data[s] = srcr.data[d * 4];
        image.data[s + 1] = srcr.data[d * 4 + 1];
        image.data[s + 2] = srcr.data[d * 4 + 2];
        n++;
      }
    }
    p.seam_override_px = n;
  });
}

// ---------------------------------------------------------------------------
// the recomposite
// ---------------------------------------------------------------------------

export interface RecompositeFigures {
  /** Mean over pixels of the mean-channel |recomposite - painting|. */
  meanAbs: number;
  /** Fraction of pixels whose mean-channel difference is <= `WITHIN_LIMIT`. */
  within: number;
  /** Pixels whose max-channel difference is > `ERROR_LIMIT`. */
  errorPx: number;
  /** Of those, the ones no part covers (no part has alpha above `COVERED_ALPHA`). */
  uncoveredErrorPx: number;
  /** The 8-connected components of the uncovered error pixels: how many there are … */
  holeCount: number;
  /** … and the largest `HOLES_LISTED` of them, largest first (`uncoveredHoles`). */
  holes: RecompositeHole[];
}

/** How many uncovered holes the assemble summary and `parts.json` list, largest first. */
export const HOLES_LISTED = 5;

/** A part beside an uncovered hole: how many of its covered pixels touch the hole. */
export interface HoleBorder {
  part: string;
  px: number;
}

/** One 8-connected component of the uncovered error pixels, in rig pixels (y down, origin top-left). */
export interface RecompositeHole {
  px: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Every part bordering the hole, most border pixels first, then plan order; empty when it borders none. */
  borders: HoleBorder[];
}

/** The parts composited in plan order onto opaque white, as `PIL.Image.alpha_composite` does it. */
export function recomposite(parts: PlacedPart[], W: number, H: number): Raster {
  let can = newRaster(W, H);
  can.data.fill(255);
  for (const { record: p, image } of parts) can = alphaComposite(can, image, p.x, p.y);
  return can;
}

/** Per rig pixel: 1 where some part has alpha above `COVERED_ALPHA`. */
function coveredMask(parts: PlacedPart[], W: number, H: number): Uint8Array {
  const covered = new Uint8Array(W * H);
  for (const { record: p, image } of parts) {
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (image.data[(y * p.w + x) * 4 + 3] > COVERED_ALPHA) covered[(p.y + y) * W + p.x + x] = 1;
  }
  return covered;
}

/** Per rig pixel: 1 where the recomposite's max-channel difference from the painting is above `ERROR_LIMIT`. */
function errorMask(can: Raster, srcr: Raster): Uint8Array {
  const n = srcr.width * srcr.height;
  const err = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    let m = 0;
    for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(can.data[p * 4 + c] - srcr.data[p * 4 + c]));
    if (m > ERROR_LIMIT) err[p] = 1;
  }
  return err;
}

/**
 * The uncovered error pixels as holes: every 8-connected component of the
 * pixels whose recomposite differs from the painting by more than
 * `ERROR_LIMIT` (max channel) and that no part covers (alpha above
 * `COVERED_ALPHA`) — the pixels `uncoveredErrorPx` counts, so the components'
 * areas sum to it.
 *
 * ⚖️ Invariant: a hole's box is its pixels' bounding box; its `borders` are
 * the parts with a covered pixel 8-adjacent to one of its pixels, each with
 * the number of such pixels it covers (a pixel two parts cover counts for
 * both), most first and then in plan order. Holes are sorted by area, largest
 * first, then by the box's top row and left column, so the order is a
 * function of the pixels and not of a labelling scan. 8-connectivity is the
 * reference's own for blobs (`cv2.connectedComponentsWithStats(…, 8)` in
 * ghost clean-up): a hole joined only at a corner is one hole.
 *
 * This is not in the reference, whose report stopped at the count. The count
 * cannot say where to look; a box and the parts round it can.
 */
export function uncoveredHoles(can: Raster, srcr: Raster, parts: PlacedPart[]): { count: number; holes: RecompositeHole[] } {
  const { width: W, height: H } = srcr;
  const covered = coveredMask(parts, W, H);
  const err = errorMask(can, srcr);
  const mask = newMask(W, H);
  for (let p = 0; p < W * H; p++) if (err[p] === 1 && covered[p] === 0) mask.data[p] = 1;
  const cc = connectedComponents(mask, 8);
  const all = cc.stats.slice(1).filter((s) => s.area > 0);
  all.sort((a, b) => b.area - a.area || a.top - b.top || a.left - b.left);
  const listed = all.slice(0, HOLES_LISTED);
  const holes = listed.map((s): RecompositeHole => {
    const borders: HoleBorder[] = [];
    parts.forEach(({ record: p, image }) => {
      let n = 0;
      // A part pixel can touch the hole only inside the hole's box grown by one.
      const x0 = Math.max(p.x, s.left - 1);
      const x1 = Math.min(p.x + p.w - 1, s.left + s.width);
      const y0 = Math.max(p.y, s.top - 1);
      const y1 = Math.min(p.y + p.h - 1, s.top + s.height);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (image.data[((y - p.y) * p.w + (x - p.x)) * 4 + 3] <= COVERED_ALPHA) continue;
          let touches = false;
          for (let dy = -1; dy <= 1 && !touches; dy++) {
            for (let dx = -1; dx <= 1 && !touches; dx++) {
              const u = x + dx;
              const v = y + dy;
              if (u >= 0 && u < W && v >= 0 && v < H && cc.labels[v * W + u] === s.label) touches = true;
            }
          }
          if (touches) n++;
        }
      }
      if (n > 0) borders.push({ part: p.name, px: n });
    });
    // Array.prototype.sort is stable, so equal counts keep plan order.
    borders.sort((a, b) => b.px - a.px);
    return { px: s.area, x: s.left, y: s.top, w: s.width, h: s.height, borders };
  });
  return { count: all.length, holes };
}

export function measureRecomposite(can: Raster, srcr: Raster, parts: PlacedPart[]): RecompositeFigures {
  const { width: W, height: H } = srcr;
  const covered = coveredMask(parts, W, H);
  let sum = 0;
  let within = 0;
  let errorPx = 0;
  let uncoveredErrorPx = 0;
  for (let p = 0; p < W * H; p++) {
    let s = 0;
    let m = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(can.data[p * 4 + c] - srcr.data[p * 4 + c]);
      s += d;
      m = Math.max(m, d);
    }
    const mean = s / 3;
    sum += mean;
    if (mean <= WITHIN_LIMIT) within++;
    if (m > ERROR_LIMIT) {
      errorPx++;
      if (covered[p] === 0) uncoveredErrorPx++;
    }
  }
  const { count, holes } = uncoveredHoles(can, srcr, parts);
  return { meanAbs: sum / (W * H), within: within / (W * H), errorPx, uncoveredErrorPx, holeCount: count, holes };
}

/** The error map's colour for an uncovered error pixel: no part is there, so the page shows through. */
export const MAP_UNCOVERED: readonly [number, number, number] = [255, 0, 0];
/** … for a covered error pixel: a part is there, in a colour more than `ERROR_LIMIT` off the painting's. */
export const MAP_MISMATCHED: readonly [number, number, number] = [0, 0, 255];

/**
 * The error map, `recomposite_error_rig.png`: the rig canvas, opaque, with
 * every uncovered error pixel `MAP_UNCOVERED` (red), every covered error pixel
 * `MAP_MISMATCHED` (blue), and every other pixel the painting in grey, dimmed
 * to the top quarter of the range — `192 + floor(luma / 4)`, luma the integer
 * BT.601 `(299 R + 587 G + 114 B + 500) / 1000` truncated.
 *
 * Why the painting dimmed rather than transparent: the map is read at contact-
 * sheet size, and a red blob on nothing says a hole exists but not where on
 * the figure it is; on a faint grey figure it sits between the legs it falls
 * between. Why grey and light: no pixel of the dimmed painting can be either
 * flag colour (a grey has equal channels, and at 192..255 it is lighter than
 * both), so the two colours mean exactly the two masks. Integer arithmetic
 * only, so the bytes are deterministic.
 */
export function recompositeErrorMap(can: Raster, srcr: Raster, parts: PlacedPart[]): Raster {
  const { width: W, height: H } = srcr;
  const covered = coveredMask(parts, W, H);
  const err = errorMask(can, srcr);
  const map = newRaster(W, H);
  for (let p = 0; p < W * H; p++) {
    const s = p * 4;
    let rgb: readonly [number, number, number];
    if (err[p] === 1) rgb = covered[p] === 0 ? MAP_UNCOVERED : MAP_MISMATCHED;
    else {
      const luma = Math.floor((299 * srcr.data[s] + 587 * srcr.data[s + 1] + 114 * srcr.data[s + 2] + 500) / 1000);
      const g = 192 + Math.floor(luma / 4);
      rgb = [g, g, g];
    }
    map.data[s] = rgb[0];
    map.data[s + 1] = rgb[1];
    map.data[s + 2] = rgb[2];
    map.data[s + 3] = 255;
  }
  return map;
}

export function figuresLine(f: RecompositeFigures): string {
  return (
    `recomposite vs source: mean |d|=${f.meanAbs.toFixed(2)}, within ${WITHIN_LIMIT}: ${(100 * f.within).toFixed(1)}%, ` +
    `error px > ${ERROR_LIMIT}: ${f.errorPx}, uncovered error px: ${f.uncoveredErrorPx}`
  );
}

/** A hole's box as the part lines and refusals print a box: `x,y wxh`. */
export function holeBox(h: RecompositeHole): string {
  return `${h.x},${h.y} ${h.w}x${h.h}`;
}

/**
 * The hole lines under `figuresLine`: the count, then one line per listed
 * hole — `uncovered hole 1: 2340 px at 412,1088 30x78 (between "legwear_r"
 * 120 px, "legwear_l" 96 px)`, or `(borders no part)`.
 */
export function holeLines(f: RecompositeFigures): string[] {
  const head = `uncovered holes (8-connected): ${f.holeCount}${f.holeCount > f.holes.length ? `, the largest ${f.holes.length} listed` : ''}`;
  return [
    head,
    ...f.holes.map(
      (h, i) =>
        `  uncovered hole ${i + 1}: ${h.px} px at ${holeBox(h)} (${h.borders.length === 0 ? 'borders no part' : `between ${h.borders.map((b) => `"${b.part}" ${b.px} px`).join(', ')}`})`,
    ),
  ];
}

/** The `parts.json` `recomposite` block: the four figures, the limits they were measured at, and the listed holes. */
export function recompositeRecord(f: RecompositeFigures): RecompositeRecord {
  return {
    mean_abs: pyRound(f.meanAbs, 3),
    within_limit: WITHIN_LIMIT,
    within_share: pyRound(f.within, 4),
    error_limit: ERROR_LIMIT,
    error_px: f.errorPx,
    covered_alpha: COVERED_ALPHA,
    uncovered_error_px: f.uncoveredErrorPx,
    hole_count: f.holeCount,
    holes_listed: HOLES_LISTED,
    holes: f.holes.map((h) => ({ px: h.px, x: h.x, y: h.y, w: h.w, h: h.h, borders: h.borders.map((b) => ({ part: b.part, px: b.px })) })),
  };
}

// ---------------------------------------------------------------------------
// patches — extra parts cut from the painting
// ---------------------------------------------------------------------------

/**
 * One `assemble.patches` entry as a part: the painting's own pixels over its
 * box, taken where its alpha rule says.
 *
 * ⚖️ Invariant: a pixel of the rig is in the patch exactly when it lies in
 * `box` (`[x0, y0, x1, y1]`, rig pixels, `x1`/`y1` exclusive) and, for
 * `alpha: "silhouette"`, `figureSilhouette(srcr)` holds it; there its colour
 * is the painting's (`srcr`) and its alpha 255, everywhere else the pixel is
 * transparent. The silhouette is the painting's, not the union of the
 * layers' alpha: the pixels a patch exists for are exactly the ones no layer
 * holds, so the layers' union is empty over them by definition. The record is
 * the patch's alpha box and its counts, all of them `opaque_px` or 0 — a
 * patch is 100 % source (`src/parts.ts`). `seam_override_px` is set later by
 * `seamOverride`, as for every part.
 */
export function cutPatch(patch: Patch, srcr: Raster, silhouette: Mask | null): { record: PartRecord; image: Raster } | null {
  const { width: W, height: H } = srcr;
  const [bx0, by0, bx1, by1] = patch.box;
  const r = newRaster(W, H);
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  let n = 0;
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const p = y * W + x;
      if (patch.alpha === 'silhouette' && (silhouette === null || silhouette.data[p] === 0)) continue;
      r.data.set(srcr.data.subarray(p * 4, p * 4 + 3), p * 4);
      r.data[p * 4 + 3] = 255;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (n === 0) return null;
  const record: PartRecord = {
    name: patch.name,
    from: `${PAINTING_RUN}:${patch.name}`,
    x: x0,
    y: y0,
    w: x1 - x0 + 1,
    h: y1 - y0 + 1,
    opaque_px: n,
    visible_px: n,
    occluded_px: 0,
    projected_core_px: n,
    source_px_taken: n,
    visible_not_projected_px: 0,
    refused_drift_px: 0,
    merged_px: 0,
    seam_override_px: 0,
  };
  return { record, image: crop(r, x0, y0, record.w, record.h) };
}

/** One place in the draw order: a plan part, a patch or a cut's new part, by its index in its list. */
export type DrawSlot = { plan: number } | { patch: number } | { cut: number };

/**
 * The draw order of plan parts, patches and cuts together, back to front:
 * every `"back"` patch in `patches` order, then every `"back"` cut in `cuts`
 * order; then each plan part preceded by the patches drawn `{before: <that
 * part>}` in `patches` order and then the cuts drawn so in `cuts` order; then
 * every `"front"` patch, then every `"front"` cut. With no cuts it is the
 * order of plan parts and patches it always was. The loader has already
 * refused a `before` that names no plan part.
 */
export function drawOrder(plan: readonly string[], patches: readonly Patch[], cuts: readonly Cut[] = []): DrawSlot[] {
  const out: DrawSlot[] = [];
  const place = (at: (draw: Patch['draw']) => boolean): void => {
    patches.forEach((q, i) => {
      if (at(q.draw)) out.push({ patch: i });
    });
    cuts.forEach((q, i) => {
      if (at(q.draw)) out.push({ cut: i });
    });
  };
  place((d) => d === 'back');
  plan.forEach((name, pi) => {
    place((d) => typeof d === 'object' && d.before === name);
    out.push({ plan: pi });
  });
  place((d) => d === 'front');
  return out;
}

// ---------------------------------------------------------------------------
// cuts — a plan part's pixels taken into a new part by a declared polygon
// ---------------------------------------------------------------------------

/**
 * The rig pixels a polygon holds: pixel `(x, y)` is inside when its centre
 * `(x + 0.5, y + 0.5)` is inside the polygon by the even-odd rule: on each
 * row, the polygon's edges cross the centre line at sorted x, and the centres
 * strictly between the first and second crossing, the third and fourth, …
 * are inside. An edge crosses when exactly one of its ends lies below the
 * line; the vertices are integers and the line is at a half, so no vertex
 * lies on it and a horizontal edge never crosses. A centre exactly on a
 * crossing is outside. Pure arithmetic on the declared integers: the same
 * polygon holds the same pixels on every machine.
 */
export function pixelsInPolygon(polygon: ReadonlyArray<readonly [number, number]>, W: number, H: number): Mask {
  const m = newMask(W, H);
  const n = polygon.length;
  for (let y = 0; y < H; y++) {
    const cy = y + 0.5;
    // The crossings of this row's centre line, sorted; pixels between pairs are inside.
    const xs: number[] = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
    }
    if (xs.length === 0) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // Centres x + 0.5 with xs[k] < x + 0.5 < xs[k + 1]; a centre exactly on a crossing is outside.
      const from = Math.max(0, Math.floor(xs[k] - 0.5) + 1);
      const to = Math.min(W - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let x = from; x <= to; x++) m.data[y * W + x] = 1;
    }
  }
  return m;
}

/** What one cut did, counted when it was made: the from part's opaque pixels before, what it kept, what the cut took. */
export interface CutCount {
  from: string;
  into: string;
  /** The from part's `alpha > 8` pixels before any of its cuts. */
  before: number;
  /** What the from part kept after all its cuts; the same on every cut of one part. */
  kept: number;
  /** What this cut took. */
  taken: number;
  /** Of `taken`, the band the from part keeps as well (`cutBand`); counted in neither `kept` nor `before` twice. */
  band: number;
}

/**
 * The cut lines the assemble stage prints, one per plan part with cuts, in
 * the `pixels:` line's shape: `  cut: "<from>" opaque <before> = "<from>"
 * <kept> + "<into>" <taken> …`. Empty without cuts, so a config with none
 * prints what it printed before.
 */
export function cutLines(cuts: readonly CutCount[]): string[] {
  const byFrom = new Map<string, CutCount[]>();
  for (const c of cuts) byFrom.set(c.from, [...(byFrom.get(c.from) ?? []), c]);
  return [...byFrom.entries()].map(
    ([from, cs]) => `  cut: "${from}" opaque ${cs[0].before} = "${from}" ${cs[0].kept} + ${cs.map((c) => `"${c.into}" ${c.taken}`).join(' + ')}; band ${cs.reduce((a, c) => a + c.band, 0)} px held by both`,
  );
}

/**
 * A cut's band (issue #170, `overlap`): the polygon's pixels within `overlap`
 * rig px of its edge, distance read as Chebyshev distance — a pixel of the
 * polygon is in the band when the `(2 * overlap + 1)`-square centred on it
 * holds a pixel the polygon does not, i.e. the polygon's mask less its
 * `erode` by that square (`cv2.erode`'s border: the rig's edge is not the
 * polygon's edge). Empty at `overlap` 0. The base part keeps its pixels there
 * as well as the piece, so the piece's resampled edge has art under it.
 */
export function cutBand(polygonMask: Mask, overlap: number): Mask {
  const band = newMask(polygonMask.width, polygonMask.height);
  if (overlap === 0) return band;
  const inner = erode(polygonMask, 2 * overlap + 1);
  for (let p = 0; p < band.data.length; p++) band.data[p] = polygonMask.data[p] === 1 && inner.data[p] === 0 ? 1 : 0;
  return band;
}

// ---------------------------------------------------------------------------
// the stage
// ---------------------------------------------------------------------------

export interface AssembleResult {
  parts: PartsFile;
  /** In plan order, each cropped to its record's box. */
  images: PlacedPart[];
  recomposite: Raster;
  /** `recompositeErrorMap`: uncovered error pixels red, covered ones blue, the painting dimmed grey. */
  errorMap: Raster;
  figures: RecompositeFigures;
  /** What each `assemble.cuts` entry took, counted when it was made (`cutLines`); empty without cuts. */
  cuts: CutCount[];
  seamRule: SeamRule;
  projectRule: ProjectRule;
}

function tagsOf(set: LayerSet): Set<string> {
  return new Set(set.layers.map((l) => l.name));
}

/**
 * Refuse, by name, every plan and extend entry whose tag its run does not
 * hold. Collected before any pixel work.
 */
export function checkPlanAgainstRuns(plan: PlanEntry[], extend: Extend[], full: LayerSet, head: LayerSet): void {
  const tags = { full: tagsOf(full), head: tagsOf(head) };
  const problems: Problem[] = [];
  const known = (run: Run): string => [...tags[run]].sort().join(', ');
  plan.forEach(([name, run, tag], i) => {
    if (!tags[run].has(tag)) {
      problems.push({
        code: 'ASSEMBLE_PLAN_TAG_IN_RUN',
        object: `config.assemble.plan[${i}] (part "${name}")`,
        detail: `takes ${run}:${tag}; the ${run} run has no layer "${tag}" — it holds ${known(run)}`,
      });
    }
  });
  extend.forEach((e, i) => {
    if (!tags[e.run].has(e.tag)) {
      problems.push({
        code: 'ASSEMBLE_EXTEND_TAG_IN_RUN',
        object: `config.assemble.extend_below_crop[${i}] (part "${e.part}")`,
        detail: `takes ${e.run}:${e.tag}; the ${e.run} run has no layer "${e.tag}" — it holds ${known(e.run)}`,
      });
    }
  });
  refuseIfAny(problems);
}

/**
 * Run the stage in memory. Everything that can be refused is refused before
 * this returns; nothing here writes a file, so a caller that writes only
 * after this returned writes only after green.
 */
export function assemble(input: AssembleInput): AssembleResult {
  const { source, full, head, plan, extend, patches, cuts, seamRule, projectRule } = input;
  const frame = checkGeometry(
    { sourceW: source.width, sourceH: source.height, resolution: input.resolution, headBox: input.headBox, rigScale: input.rigScale },
    { full, head },
  );
  checkPlanAgainstRuns(plan, extend, full, head);
  const { W, H } = frame;
  const srcr = sourceInRig(source, W, H);

  const rig = new Map<string, Raster>();
  const stats = new Map<string, ProjectionStats>();
  const ghost: Record<string, number> = {};
  for (const [run, set] of [['full', full], ['head', head]] as const) {
    const layers = runLayers(set, input.resolution);
    const rigLayers = layers.map((l) => layerToRig(l.canvas, frame, run));
    const st = projectSource(rigLayers, srcr, frame, run, projectRule);
    layers.forEach((l, i) => {
      rig.set(`${run}:${l.tag}`, rigLayers[i]);
      stats.set(`${run}:${l.tag}`, st[i]);
      ghost[`${run}:${l.tag}`] = l.ghostPx;
    });
  }

  // Patches are checked against the rig before any pixel work, like the plan.
  const patchProblems: Problem[] = [];
  patches.forEach((q, i) => {
    const [, , bx1, by1] = q.box;
    if (bx1 > W || by1 > H) {
      patchProblems.push({
        code: 'ASSEMBLE_PATCH_BOX_INSIDE',
        object: `config.assemble.patches[${i}] (patch "${q.name}")`,
        detail: `box is [${q.box.join(', ')}]; the rig is ${W}x${H} (the painting times rig_scale ${frame.S}), so x1 <= ${W} and y1 <= ${H} are required — the box is in rig pixels, x1 and y1 exclusive`,
      });
    }
  });
  // Cuts too: a polygon past the rig is in some other space (source pixels,
  // most likely), and two cuts of one part that share a pixel would give it
  // to both. Every pair is named.
  const cutMasks = cuts.map((q) => pixelsInPolygon(q.polygon, W, H));
  cuts.forEach((q, i) => {
    const out = q.polygon.filter(([x, y]) => x > W || y > H);
    if (out.length > 0) {
      patchProblems.push({
        code: 'ASSEMBLE_CUT_INSIDE',
        object: `config.assemble.cuts[${i}] (part "${q.into}")`,
        detail: `polygon point(s) ${out.map(([x, y]) => `[${x}, ${y}]`).join(', ')} lie past the ${W}x${H} rig (the painting times rig_scale ${frame.S}); x <= ${W} and y <= ${H} are required — the polygon is in rig pixels, the space of parts.json`,
      });
    }
    for (let j = 0; j < i; j++) {
      if (cuts[j].from !== q.from) continue;
      let shared = 0;
      let first = -1;
      for (let p = 0; p < W * H; p++) {
        if (cutMasks[i].data[p] === 1 && cutMasks[j].data[p] === 1) {
          shared++;
          if (first < 0) first = p;
        }
      }
      if (shared > 0) {
        patchProblems.push({
          code: 'ASSEMBLE_CUT_OVERLAP',
          object: `config.assemble.cuts[${i}] (part "${q.into}")`,
          detail: `shares ${shared} rig pixel(s) with cuts[${j}] (part "${cuts[j].into}"), the first at ${first % W},${Math.floor(first / W)}; both cut "${q.from}", and a pixel goes to one part — polygons of one part that do not overlap are required`,
        });
      }
    }
  });
  refuseIfAny(patchProblems);

  interface Built {
    key: string;
    r: Raster;
    st: ProjectionStats;
    extendKeys: string[];
    trace: MergeTrace;
    merged: number;
    /** The rig pixels this piece of the layer owns when the layer is cut, null when it is not: the counts are split by it. */
    region: Mask | null;
  }
  const built: Array<Built | null> = plan.map(() => null);
  const empty: Problem[] = [];
  /** The part's alpha box and its `alpha > 8` count, over the whole rig. */
  const measureBox = (r: Raster): { x0: number; y0: number; x1: number; y1: number; opaque: number } => {
    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    let opaque = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const a = r.data[(y * W + x) * 4 + 3];
        if (a > OPAQUE_ALPHA_ABOVE) opaque++;
        if (a > 0) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return { x0, y0, x1, y1, opaque };
  };
  plan.forEach(([name, run, tag], pi) => {
    const key = `${run}:${tag}`;
    const src = rig.get(key) as Raster;
    const r: Raster = { width: W, height: H, data: new Uint8ClampedArray(src.data) };
    const st = stats.get(key) as ProjectionStats;
    const extendKeys = extend.filter((e) => e.part === name).map((e) => `${e.run}:${e.tag}`);
    const extras = extendKeys.map((k) => rig.get(k) as Raster);
    let merged = 0;
    const trace: MergeTrace = { from: new Int32Array(W * H).fill(-1), ring: newMask(W, H) };
    if (extras.length > 0) {
      const front = newMask(W, H);
      for (const [, run2, tag2] of plan.slice(pi + 1)) {
        const f = rig.get(`${run2}:${tag2}`) as Raster;
        for (let p = 0; p < W * H; p++) if (f.data[p * 4 + 3] >= FRONT_ALPHA) front.data[p] = 1;
      }
      merged = mergeBelowCrop(r, extras, front, srcr, frame.headBottom, trace);
    }
    const { x1, opaque } = measureBox(r);
    if (opaque === 0) {
      empty.push({
        code: 'ASSEMBLE_PART_OPAQUE',
        object: `part "${name}" (${key}, config.assemble.plan[${pi}])`,
        detail: `has 0 pixels with alpha above ${OPAQUE_ALPHA_ABOVE} in the rig (${x1 < 0 ? 'no pixel at all' : 'only fringe below it'}; ${ghost[key]} ghost px removed in the run); a part with at least one opaque pixel is required — drop it from the plan or take the tag from the other run`,
      });
      return;
    }
    built[pi] = { key, r, st, extendKeys, trace, merged, region: null };
  });
  const silhouette = seamRule === 'silhouette' || patches.some((q) => q.alpha === 'silhouette') ? figureSilhouette(srcr) : null;
  const cut = patches.map((q, i) => {
    const c = cutPatch(q, srcr, silhouette);
    if (c === null) {
      empty.push({
        code: 'ASSEMBLE_PATCH_OPAQUE',
        object: `patch "${q.name}" (config.assemble.patches[${i}])`,
        detail: `takes 0 pixels: ${q.alpha === 'silhouette' ? `the painting's figure silhouette does not reach its box [${q.box.join(', ')}]` : 'its box is empty'}; a patch with at least one pixel is required — move the box onto the figure, or take "alpha": "box"`,
      });
    }
    return c;
  });

  // The cuts (issue #170), after step 4 so a piece takes the merged pixels
  // too: every pixel of the part with alpha above 0 whose centre a cut's
  // polygon holds moves to that cut's piece, colour and alpha, and is cleared
  // in the part. The polygons of one part are disjoint (refused above), so
  // each pixel goes to exactly one piece, and the counts printed are taken
  // here, before steps 4b and 5.
  const count = (m: Mask | null, region: Mask): number => {
    if (m === null) return 0;
    let n = 0;
    for (let p = 0; p < W * H; p++) if (m.data[p] === 1 && region.data[p] === 1) n++;
    return n;
  };
  const opaqueOf = (r: Raster): number => {
    let n = 0;
    for (let p = 0; p < W * H; p++) if (r.data[p * 4 + 3] > OPAQUE_ALPHA_ABOVE) n++;
    return n;
  };
  const mergedIn = (b: Built, region: Mask): number => count(b.trace.lastSel ?? null, region) + count(b.trace.lastRing ?? null, region);
  const pieces: Array<Built | null> = cuts.map(() => null);
  const cutCounts: CutCount[] = [];
  plan.forEach(([name], pi) => {
    const mine = cuts.map((q, i) => i).filter((i) => cuts[i].from === name);
    const b = built[pi];
    if (mine.length === 0 || b === null) return;
    const before = opaqueOf(b.r);
    const rest = newMask(W, H);
    rest.data.fill(1);
    // The base's own pixels: `rest`, and every cut's band, which it keeps as well as the piece.
    const own = newMask(W, H);
    const bands: number[] = [];
    const taken = mine.map((i) => {
      const m = cutMasks[i];
      const band = cutBand(m, cuts[i].overlap);
      const r = newRaster(W, H);
      let n = 0;
      let nb = 0;
      for (let p = 0; p < W * H; p++) {
        rest.data[p] &= 1 - m.data[p];
        if (band.data[p] === 1) own.data[p] = 1;
        const a = b.r.data[p * 4 + 3];
        if (m.data[p] === 0 || a === 0) continue;
        r.data.set(b.r.data.subarray(p * 4, p * 4 + 4), p * 4);
        if (band.data[p] === 0) b.r.data.fill(0, p * 4, p * 4 + 4);
        if (a > OPAQUE_ALPHA_ABOVE) {
          n++;
          if (band.data[p] === 1) nb++;
        }
      }
      pieces[i] = { ...b, r, region: m, merged: mergedIn(b, m) };
      bands.push(nb);
      return n;
    });
    for (let p = 0; p < W * H; p++) if (rest.data[p] === 1) own.data[p] = 1;
    const bandSum = bands.reduce((a, n) => a + n, 0);
    // What the base kept of the strict partition; its image also holds the bands.
    const kept = opaqueOf(b.r) - bandSum;
    const sum = taken.reduce((a, n) => a + n, 0);
    const object = `part "${name}" (${b.key}, config.assemble.plan[${pi}])`;
    // By construction: the pieces partition the layer, so their counts add up to the layer's. A refusal here is a bug.
    const split = [
      ['opaque px', before, kept + sum],
      ['merged_px', b.merged, mergedIn(b, rest) + mine.reduce((a, i) => a + (pieces[i] as Built).merged, 0)],
      ['projected_core_px', b.st.core, count(b.st.coreMask, rest) + mine.reduce((a, i) => a + count(b.st.coreMask, cutMasks[i]), 0)],
      ['source_px_taken', b.st.taken, count(b.st.takenMask, rest) + mine.reduce((a, i) => a + count(b.st.takenMask, cutMasks[i]), 0)],
      ['refused_drift_px', b.st.refused, count(b.st.refusedMask, rest) + mine.reduce((a, i) => a + count(b.st.refusedMask, cutMasks[i]), 0)],
    ] as const;
    for (const [what, whole, parts] of split) {
      if (whole !== parts) empty.push({ code: 'ASSEMBLE_COUNTS_ADD_UP', object, detail: `${what}: ${whole} before its cuts, ${parts} over the pieces; equal is required (a bug in the assembler, not in the inputs)` });
    }
    mine.forEach((i, k) => {
      if (taken[k] === 0) {
        empty.push({
          code: 'ASSEMBLE_CUT_PIXELS',
          object: `config.assemble.cuts[${i}] (part "${cuts[i].into}")`,
          detail: `takes 0 of "${name}"'s ${before} opaque pixel(s) (alpha above ${OPAQUE_ALPHA_ABOVE}); its polygon holds ${count(cutMasks[i], cutMasks[i])} rig pixel(s) and none is that layer's art — a cut that takes at least one is required: draw the polygon over the art (parts/${name}.png, placed at its parts.json x, y, is the layer in rig pixels)`,
        });
      }
    });
    if (kept === 0) {
      empty.push({
        code: 'ASSEMBLE_CUT_PIXELS',
        object,
        detail: `keeps 0 of its ${before} opaque pixel(s): ${mine.map((i, k) => `cuts[${i}] ("${cuts[i].into}") takes ${taken[k]}`).join(', ')}; a part that keeps at least one is required — to move the whole layer, rename the plan part instead`,
      });
    }
    b.region = own;
    b.merged = mergedIn(b, own);
    mine.forEach((i, k) => cutCounts.push({ from: name, into: cuts[i].into, before, kept, taken: taken[k], band: bands[k] }));
  });
  refuseIfAny(empty);
  // In cut order, as the config lists them.
  cutCounts.sort((a, b) => cuts.findIndex((q) => q.into === a.into) - cuts.findIndex((q) => q.into === b.into));
  const order = drawOrder(
    plan.map((e) => e[0]),
    patches,
    cuts,
  );
  const pieceAt = (d: { plan: number } | { cut: number }): { name: string; b: Built } =>
    'plan' in d ? { name: plan[d.plan][0], b: built[d.plan] as Built } : { name: cuts[d.cut].into, b: pieces[d.cut] as Built };

  // Step 4b: push back a fringe the painting shows another part through, over
  // the plan parts still uncropped and the patches, in draw order.
  const stack: PlacedPart[] = order.map((d) => {
    if ('patch' in d) return cut[d.patch] as PlacedPart;
    const { name, b } = pieceAt(d);
    const whole: PartRecord = { name, from: b.key, x: 0, y: 0, w: W, h: H, opaque_px: 0, projected_core_px: 0, source_px_taken: 0, refused_drift_px: 0, merged_px: 0, seam_override_px: 0 };
    return { record: whole, image: b.r };
  });
  const pushedBy = pushBackFringe(stack, srcr, seamRule, seamRule === 'silhouette' ? silhouette : null);
  const pushedOf: FringePushed[][] = plan.map(() => []);
  const pushedOfCut: FringePushed[][] = cuts.map(() => []);
  order.forEach((d, i) => {
    if ('plan' in d) pushedOf[d.plan] = pushedBy[i];
    if ('cut' in d) pushedOfCut[d.cut] = pushedBy[i];
  });

  const planned: Array<PlacedPart | null> = plan.map(() => null);
  const cutPlaced: Array<PlacedPart | null> = cuts.map(() => null);
  const pieceList: Array<{ name: string; b: Built; pushed: FringePushed[]; at: string; set: (p: PlacedPart) => void }> = [
    ...plan.map(([name], pi) => ({ name, b: built[pi] as Built, pushed: pushedOf[pi], at: `config.assemble.plan[${pi}]`, set: (q: PlacedPart) => (planned[pi] = q) })),
    ...cuts.map((q, i) => ({ name: q.into, b: pieces[i] as Built, pushed: pushedOfCut[i], at: `config.assemble.cuts[${i}]`, set: (pp: PlacedPart) => (cutPlaced[i] = pp) })),
  ];
  pieceList.forEach(({ name, b, pushed: pushedHere, at, set }) => {
    const { key, r, st, extendKeys, trace, merged, region } = b;
    // A pixel the merge wrote is judged in the extend layer's run, every other
    // in the part's own. Projected = the colour came from projectSource's
    // accepted set: the part layer's, or for a copied pixel the extend
    // layer's (its rig layer was projected before it was copied). A ring pixel
    // is growRim's, counted in merged_px, and is not projection.
    const visible = newMask(W, H);
    const projected = newMask(W, H);
    for (let p = 0; p < W * H; p++) {
      const e = trace.from[p];
      const own = e < 0 ? st : (stats.get(extendKeys[e]) as ProjectionStats);
      if (r.data[p * 4 + 3] > OPAQUE_ALPHA_ABOVE && own.clear.data[p] === 1) visible.data[p] = 1;
      if (trace.ring.data[p] === 0 && own.takenMask.data[p] === 1 && (region === null || region.data[p] === 1)) projected.data[p] = 1;
    }
    const { x0, y0, x1, y1, opaque } = measureBox(r);
    if (opaque === 0) {
      const pushed = pushedHere.reduce((a, q) => a + q.px, 0);
      empty.push({
        code: 'ASSEMBLE_PART_OPAQUE',
        object: `part "${name}" (${key}, ${at})`,
        detail: `has 0 pixels with alpha above ${OPAQUE_ALPHA_ABOVE} in the rig once its fringe is pushed back: every one of its pixels was below alpha ${CORE_ALPHA} where the painting shows another part (${pushed} px pushed back, held by ${pushedHere.map((q) => `"${q.part}" ${q.px} px`).join(', ')}); a part with at least one opaque pixel is required — drop it from the plan or take the tag from the other run`,
      });
      return;
    }
    const vc = visibilityCounts(`part "${name}" (${key})`, r, visible, projected);
    const record: PartRecord = {
      name,
      from: key,
      x: x0,
      y: y0,
      w: x1 - x0 + 1,
      h: y1 - y0 + 1,
      opaque_px: opaque,
      visible_px: vc.visible_px,
      occluded_px: vc.occluded_px,
      projected_core_px: region === null ? st.core : count(st.coreMask, region),
      source_px_taken: region === null ? st.taken : count(st.takenMask, region),
      visible_not_projected_px: vc.visible_not_projected_px,
      refused_drift_px: region === null ? st.refused : count(st.refusedMask, region),
      merged_px: merged,
      seam_override_px: 0,
    };
    if (pushedHere.length > 0) record.fringe_pushed_back = pushedHere;
    set({ record, image: crop(r, x0, y0, record.w, record.h) });
  });
  refuseIfAny(empty);
  const placed: PlacedPart[] = order.map((d) => ('plan' in d ? planned[d.plan] : 'cut' in d ? cutPlaced[d.cut] : cut[d.patch]) as PlacedPart);

  seamOverride(placed, srcr, seamRule, seamRule === 'silhouette' ? silhouette : null);
  const can = recomposite(placed, W, H);
  const figures = measureRecomposite(can, srcr, placed);
  return {
    parts: { rig_size: [W, H], scale_rig_per_source: frame.S, parts: placed.map((p) => p.record), ghost_px: ghost, recomposite: recompositeRecord(figures) },
    images: placed,
    recomposite: can,
    errorMap: recompositeErrorMap(can, srcr, placed),
    figures,
    cuts: cutCounts,
    seamRule,
    projectRule,
  };
}

// ---------------------------------------------------------------------------
// --propose-plan
// ---------------------------------------------------------------------------

/**
 * The tags the reference proposes from the HEAD run. Its own set, kept
 * verbatim — it is not `src/tags.ts`'s head group: it adds the hair and the
 * neck, and it holds only the split forms of the eye, brow and ear tags, and
 * neither `eyewear` nor `nose`. So an unsplit `eyebrow`, or `eyewear`, is
 * proposed from the full run.
 */
export const PROPOSE_HEAD_TAGS: readonly string[] = [
  'back hair',
  'front hair',
  'face',
  'ears-r',
  'ears-l',
  'headwear',
  'earwear',
  'mouth',
  'neck',
  'eyewhite-r',
  'eyewhite-l',
  'irides-r',
  'irides-l',
  'eyelash-r',
  'eyelash-l',
  'eyebrow-r',
  'eyebrow-l',
];

/** The part name the reference proposes for a tag; any other tag becomes its own name with spaces and hyphens as underscores. */
export const PROPOSE_ALIAS: Readonly<Record<string, string>> = {
  'back hair': 'hair_back',
  'front hair': 'hair_front',
  footwear: 'shoes',
  'irides-r': 'iris_r',
  'irides-l': 'iris_l',
  'eyelash-r': 'lash_r',
  'eyelash-l': 'lash_l',
  'eyebrow-r': 'brow_r',
  'eyebrow-l': 'brow_l',
  'ears-r': 'ear_r',
  'ears-l': 'ear_l',
  headwear: 'hairpin',
  earwear: 'earring',
};

function aliasOf(tag: string): string {
  return PROPOSE_ALIAS[tag] ?? tag.replaceAll(' ', '_').replaceAll('-', '_');
}

export interface PlanProposal {
  plan: PlanEntry[];
  extend_below_crop: Extend[];
  notes: string[];
}

/** Python's `%.0f`: round half to even on the binary value. */
function fmt0(v: number): string {
  const f = Math.floor(v);
  const d = v - f;
  const r = d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  return String(r);
}

/**
 * A default `assemble.plan` and `extend_below_crop` from the two runs, with
 * notes on every choice that was not the default.
 *
 * ⚖️ Invariant (`assemble_parts.py` `propose_plan`): a tag is proposable when
 * it is not `nose` and holds at least `PROPOSE_MIN_PX` run pixels of alpha
 * above 8 after ghost clean-up. Head tags (`PROPOSE_HEAD_TAGS`) come from the
 * head run, the rest from the full run. Order, back to front: `back hair`;
 * the body layers in the full run's draw order, with `neck` placed just before
 * the first of topwear, bottomwear or neckwear; then the remaining head layers
 * in the head run's draw order. A `headwear`/`earwear` the head run drops or
 * shrinks (its rig-pixel area below 0.8 of the full run's) is taken from the
 * full run instead, drawn right after `back hair` — noted. `front hair` and
 * `back hair` taken from the head run are extended below the crop from the
 * full run when the full run's layer reaches more than 8 rig pixels below the
 * crop line. A lone `handwear` layer is named `sleeves`.
 *
 * ⚖️ This port's, not the reference's: a layer that crosses a plausibility
 * rule (`implausibleRules` in `src/layers.ts` — mostly translucent, a pale
 * background-coloured haze, or out of proportion with the rest of its run's
 * figure) is neither proposed, nor taken as the head-run fallback, nor extended
 * below the crop, and a note names the layer, its three figures and every rule
 * it crossed with the bar. Those notes follow the reference's. [observed] No
 * layer of either public example crosses a rule, so their proposals are the
 * reference's byte for byte.
 */
export function proposePlan(full: LayerSet, head: LayerSet, g: Geometry, minPx = PROPOSE_MIN_PX): PlanProposal {
  const frame = checkGeometry(g, { full, head });
  const runs = { full: runLayers(full, g.resolution), head: runLayers(head, g.resolution) };
  const find = (run: Run, tag: string): RunLayer | undefined => runs[run].find((l) => l.tag === tag);
  const figures: Record<Run, LayerFigures[]> = { full: layerFigures(full), head: layerFigures(head) };
  const dropNotes: string[] = [];
  const noted = new Set<string>();
  /** The plausibility rules `run:tag` crosses; the first time a consulted layer crosses any, a note says so. */
  const implausible = (run: Run, tag: string, what: string): boolean => {
    const f = figures[run].find((x) => x.name === tag);
    const rules = f === undefined ? [] : implausibleRules(f);
    if (f === undefined || rules.length === 0) return false;
    if (!noted.has(`${run}:${tag}`)) {
      noted.add(`${run}:${tag}`);
      dropNotes.push(`${tag}: ${run} run layer ${figuresPhrase(f)} -> ${what} by ${rules.map((r) => `${r} (${ruleSummary(r)})`).join(', ')}`);
    }
    return true;
  };
  const ok = (run: Run, tag: string): boolean => {
    const l = find(run, tag);
    return tag !== 'nose' && l !== undefined && l.opaqueRunPx >= minPx && !implausible(run, tag, 'not proposed');
  };
  const body = runs.full.filter((l) => !PROPOSE_HEAD_TAGS.includes(l.tag) && ok('full', l.tag)).map((l) => l.tag);
  const heads = runs.head.filter((l) => PROPOSE_HEAD_TAGS.includes(l.tag) && ok('head', l.tag)).map((l) => l.tag);
  const hw = body.filter((t) => t.startsWith('handwear'));
  const plan: PlanEntry[] = [];
  const drop = (t: string): void => {
    const i = heads.indexOf(t);
    if (i >= 0) heads.splice(i, 1);
  };
  if (heads.includes('back hair')) {
    plan.push([PROPOSE_ALIAS['back hair'], 'head', 'back hair']);
    drop('back hair');
  }
  let neckDone = !heads.includes('neck');
  for (const t of body) {
    if (!neckDone && (t === 'topwear' || t === 'bottomwear' || t === 'neckwear')) {
      plan.push(['neck', 'head', 'neck']);
      drop('neck');
      neckDone = true;
    }
    plan.push([t.startsWith('handwear') && hw.length === 1 ? 'sleeves' : aliasOf(t), 'full', t]);
  }
  const notes: string[] = [];
  const headArea = (frame.headK * frame.S) ** 2;
  const fullArea = (frame.fullK * frame.S) ** 2;
  for (const t of ['headwear', 'earwear']) {
    const hl = find('head', t);
    const fl = find('full', t);
    const hp = hl !== undefined ? hl.opaqueRunPx * headArea : 0;
    const fp = fl !== undefined ? fl.opaqueRunPx * fullArea : 0;
    if (ok('full', t) && hp < 0.8 * fp) {
      drop(t);
      const at = plan.length > 0 && plan[0][2] === 'back hair' ? 1 : 0;
      plan.splice(at, 0, [PROPOSE_ALIAS[t], 'full', t]);
      notes.push(`${t}: head run ${fmt0(hp)} rig px < 0.8 x full run ${fmt0(fp)} -> full-run layer, drawn behind the face`);
    }
  }
  for (const t of heads) plan.push([aliasOf(t), 'head', t]);
  const extend: Extend[] = [];
  for (const t of ['front hair', 'back hair']) {
    const fl = find('full', t);
    if (fl === undefined || !plan.some((p) => p[1] === 'head' && p[2] === t)) continue;
    if (implausible('full', t, 'not extended below the crop')) continue;
    let last = -1;
    const n = g.resolution;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (fl.canvas.data[(y * n + x) * 4 + 3] > OPAQUE_ALPHA_ABOVE) {
          last = y;
          break;
        }
      }
    }
    // The run row maps to the rig as the warp maps it: k * row, less the top pad in rig px.
    if (last >= 0 && (last + 1) * frame.fullK * frame.S - frame.fullPadTop * frame.S > frame.headBottom + 8) extend.push({ part: PROPOSE_ALIAS[t], run: 'full', tag: t });
  }
  return { plan, extend_below_crop: extend, notes: [...notes, ...dropNotes] };
}

// ---------------------------------------------------------------------------
// what the stage reads from a config
// ---------------------------------------------------------------------------

/**
 * The config fields the stage reads: `seethrough.resolution` and `.head_box`,
 * `assemble.rig_scale`, `.plan`, `.extend_below_crop`, `.patches` and `.cuts` — and
 * nothing of the rig. The CLI hands it a config from
 * `parseEarlyConfig(raw, 'assemble')`; a config the full loader accepted is
 * the same shape with more in it. The head box is refused here rather than by
 * the loader, because `inputs` runs before it exists; `seethrough` too, for a
 * full-loader config, where it is optional.
 */
export function stageFields(cfg: Pick<CharacterConfig, 'seethrough' | 'assemble'>): {
  resolution: number;
  headBox: [number, number, number, number];
  rigScale: number;
  plan: PlanEntry[];
  extend: Extend[];
  patches: Patch[];
  cuts: Cut[];
} {
  const problems: Problem[] = [];
  if (cfg.seethrough === undefined) {
    problems.push({ code: 'ASSEMBLE_FIELD_PRESENT', object: 'config.seethrough', detail: 'is absent; assemble reads seethrough.resolution and seethrough.head_box, which place the two runs on the painting' });
  } else if (cfg.seethrough.head_box === undefined) {
    problems.push({ code: 'ASSEMBLE_FIELD_PRESENT', object: 'config.seethrough.head_box', detail: 'is absent; the head run cannot be placed on the painting without the box it was cropped from' });
  }
  refuseIfAny(problems);
  const st = cfg.seethrough as SeeThrough;
  return {
    resolution: st.resolution,
    headBox: st.head_box as [number, number, number, number],
    rigScale: cfg.assemble.rig_scale,
    plan: cfg.assemble.plan,
    extend: cfg.assemble.extend_below_crop ?? [],
    patches: cfg.assemble.patches ?? [],
    cuts: cfg.assemble.cuts ?? [],
  };
}

/**
 * The three numbers `--propose-plan` reads, from a config that does not have a
 * plan yet. The config comes through `parseEarlyConfig` (`src/config.ts`), the
 * one partial entry point, which has already checked the fields with the full
 * loader's rules; what is left here is that this stage needs the head box,
 * which that loader leaves optional.
 */
export function proposeFields(cfg: EarlyConfig): { resolution: number; headBox: [number, number, number, number]; rigScale: number } {
  if (cfg.seethrough.head_box === undefined) {
    refuseIfAny([{ code: 'ASSEMBLE_FIELD_PRESENT', object: 'config.seethrough.head_box', detail: 'is absent; the plan is proposed from both runs, and the head run cannot be placed on the painting without the box it was cropped from — run `propose --head-box` first' }]);
  }
  return { resolution: cfg.seethrough.resolution, headBox: cfg.seethrough.head_box as [number, number, number, number], rigScale: cfg.assemble.rig_scale };
}

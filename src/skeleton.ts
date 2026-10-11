/**
 * OpenPose body-18 skeletons for the painting's structural control.
 *
 * The generation adapter (`src/comfy/painting.ts`) can condition the painting
 * on an AUTHORED pose: one of the skeletons below, or the points of a pose file
 * the config names (issue #198, read by `src/config.ts`), drawn at the latent
 * size and applied through an OpenPose ControlNet. One skeleton is one figure with its
 * head and feet placed inside the frame, which is the reason it exists — a pose
 * asked for in words alone is a pose the sampler is free to ignore.
 *
 * Pure raster: no network, no clock. The adapter uploads what this draws.
 *
 * ⚖️ **The drawing convention is the annotator's, not a free choice.** A
 * skeleton drawn in a different style is a different conditioning
 * distribution, so this copies `comfyui_controlnet_aux`'s `draw_bodypose` as
 * the reference implementation did: limbs first, as filled rotated ellipses
 * at 0.6 x the limb colour, then every keypoint as a radius-4 full-colour disc
 * on top. The stick's half-width is `4 * stickScale(max side)`, and for xinsir's
 * `controlnet-openpose-sdxl-1.0` the scale is `min(2 + max_side // 1000, 7)`
 * (1 below 500 px) — 12 px at the 832x1216 latent, three times the canonical
 * 4 px, which is the trap the rule exists to avoid.
 *
 * 🔬 **Rasterised the way PIL rasterises**, because the reference drew with
 * `ImageDraw.polygon` / `ImageDraw.ellipse` and a ControlNet sees every pixel:
 * polygon vertices TRUNCATED to integers (`_imaging.c` `_draw_polygon`), the
 * scanline fill of `libImaging/Draw.c` `polygon_generic` in float32 with its
 * corner rule, consecutive horizontal edges merged as `ImagingDrawPolygon`
 * does, and the disc from `ellipseNew`'s integer quarter walk. Transcribed from
 * Pillow 12.2.0's sources; the measurement against Pillow 12.2.0 itself is in
 * the doc comment of `renderSkeleton`.
 *
 * Proportions (canvas 832x1216, centre x = 416): head top ~ y 85, chin ~ 228,
 * ankles at 1100 — about seven heads, an adult; ~85 px above the head and ~75
 * px under the feet so neither the crown nor a hem touches the frame. Another
 * latent size scales every point by `w / 832`, `h / 1216`.
 */
import { newRaster, type Raster } from './raster/types.ts';

export type SkeletonName = 'stand_sides' | 'stand_clasp';

/** The built-in skeletons' names, in the order the config's refusal lists them. */
export const SKELETON_NAMES: readonly SkeletonName[] = ['stand_sides', 'stand_clasp'];

/** Whether `v` names a built-in skeleton; any other string in `generation.control.skeleton` is a pose file's path. */
export function isSkeletonName(v: unknown): v is SkeletonName {
  return typeof v === 'string' && (SKELETON_NAMES as readonly string[]).includes(v);
}

/** Body-18 order. "r"/"l" are the SUBJECT's sides, so r_shoulder is on the image left for a front-facing figure. */
export const KEYPOINT_NAMES = [
  'nose', 'neck',
  'r_shoulder', 'r_elbow', 'r_wrist',
  'l_shoulder', 'l_elbow', 'l_wrist',
  'r_hip', 'r_knee', 'r_ankle',
  'l_hip', 'l_knee', 'l_ankle',
  'r_eye', 'l_eye', 'r_ear', 'l_ear',
] as const;
export type KeypointName = (typeof KEYPOINT_NAMES)[number];

/** Upstream `limbSeq`, 1-indexed into `KEYPOINT_NAMES`, in drawing order. */
export const LIMB_SEQ: ReadonlyArray<readonly [number, number]> = [
  [2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [2, 9], [9, 10],
  [10, 11], [2, 12], [12, 13], [13, 14], [2, 1], [1, 15], [15, 17], [1, 16], [16, 18],
];

/** Upstream colours: limb i and keypoint i share `COLORS[i]`. */
export const COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0],
  [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255],
  [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85],
];

/** The canvas the points are authored on. */
export const SKELETON_BASE: readonly [number, number] = [832, 1216];

/** The 18 body-18 keypoints of one figure, by name, in canvas pixels (x right, y down). */
export type PosePoints = Record<KeypointName, readonly [number, number]>;

const HEAD = {
  nose: [416, 176], r_eye: [398, 160], l_eye: [434, 160], r_ear: [378, 170], l_ear: [454, 170], neck: [416, 252],
} as const;
/** Ankles 56 px apart, the feet close together. */
const LEGS = {
  r_hip: [378, 612], l_hip: [454, 612], r_knee: [384, 862], l_knee: [448, 862], r_ankle: [388, 1100], l_ankle: [444, 1100],
} as const;

export interface SkeletonPose {
  /**
   * The pose in words, appended to the positive prompt when the config gives
   * no `generation.pose`. These words and the framing words in
   * `src/graphs.ts` are the whole of what a skeleton adds to a prompt.
   */
  words: string;
  note: string;
  points: PosePoints;
}

export const SKELETONS: Record<SkeletonName, SkeletonPose> = {
  stand_sides: {
    words: 'standing, arms at sides, relaxed arms, relaxed pose',
    note: 'Arms relaxed at the sides, hands by the thighs; elbows just off the waist so a wide sleeve reads as its own shape.',
    points: { ...HEAD, ...LEGS, r_shoulder: [340, 272], l_shoulder: [492, 272], r_elbow: [320, 462], l_elbow: [512, 462], r_wrist: [318, 640], l_wrist: [514, 640] },
  },
  stand_clasp: {
    words: 'standing, hands clasped in front of waist, own hands together, relaxed pose',
    note: 'Hands lightly clasped in front at the waist; the wrists meet on the midline just above the hip line.',
    points: { ...HEAD, ...LEGS, r_shoulder: [340, 272], l_shoulder: [492, 272], r_elbow: [318, 462], l_elbow: [514, 462], r_wrist: [402, 566], l_wrist: [430, 566] },
  },
};

/** xinsir's stick-scale rule for `controlnet-openpose-sdxl-1.0`: 1 below 500 px, else `min(2 + max_side // 1000, 7)`. */
export function stickScale(maxSide: number): number {
  return maxSide < 500 ? 1 : Math.min(2 + Math.floor(maxSide / 1000), 7);
}

/** A skeleton's points at a `w`x`h` canvas: each authored point times `w / 832`, `h / 1216`. */
export function scaledPoints(name: SkeletonName, w: number, h: number): PosePoints {
  const sx = w / SKELETON_BASE[0];
  const sy = h / SKELETON_BASE[1];
  const src = SKELETONS[name].points;
  const out = {} as Record<KeypointName, readonly [number, number]>;
  for (const k of KEYPOINT_NAMES) out[k] = [src[k][0] * sx, src[k][1] * sy];
  return out;
}

// ---------------------------------------------------------------------------
// PIL's rasteriser, the parts this drawing uses
// ---------------------------------------------------------------------------

const f32 = Math.fround;

/** CPython's `math.radians` / `math.degrees`: one multiplication by a precomputed constant, which is not `x * 180 / pi`. */
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** C's `(int)` on a double: truncation toward zero. */
const cint = (v: number): number => Math.trunc(v);

/** `ROUND_UP` / `ROUND_DOWN` of Draw.c: half away from zero / half toward zero, on a float. */
const roundUp = (v: number): number => (v >= 0 ? Math.floor(v + 0.5) : -Math.floor(Math.abs(v) + 0.5));
const roundDown = (v: number): number => (v >= 0 ? Math.ceil(v - 0.5) : -Math.ceil(Math.abs(v) - 0.5));
/** C's `roundf`: half away from zero. */
const roundf = (v: number): number => f32(v >= 0 ? Math.floor(v + 0.5) : -Math.floor(-v + 0.5));

interface Edge {
  x0: number;
  y0: number;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  dx: number;
}

function addEdge(x0: number, y0: number, x1: number, y1: number): Edge {
  return {
    x0,
    y0,
    xmin: Math.min(x0, x1),
    xmax: Math.max(x0, x1),
    ymin: Math.min(y0, y1),
    ymax: Math.max(y0, y1),
    dx: y0 === y1 ? 0 : f32((x1 - x0) / (y1 - y0)),
  };
}

function hline(r: Raster, x0: number, y: number, x1: number, rgb: readonly [number, number, number]): void {
  if (y < 0 || y >= r.height) return;
  if (x0 < 0) x0 = 0;
  else if (x0 >= r.width) return;
  if (x1 < 0) return;
  if (x1 >= r.width) x1 = r.width - 1;
  for (let x = x0; x <= x1; x++) {
    const i = (y * r.width + x) * 4;
    r.data[i] = rgb[0];
    r.data[i + 1] = rgb[1];
    r.data[i + 2] = rgb[2];
    r.data[i + 3] = 255;
  }
}

/** `polygon_generic` for an opaque RGB target (`hasAlpha == 0`): float32 scanline intersections and the corner rule. */
function polygonGeneric(r: Raster, e: Edge[], rgb: readonly [number, number, number]): void {
  if (e.length === 0) return;
  let ymin = r.height - 1;
  let ymax = 0;
  const table: Edge[] = [];
  for (const edge of e) {
    if (ymin > edge.ymin) ymin = edge.ymin;
    if (ymax < edge.ymax) ymax = edge.ymax;
    if (edge.ymin === edge.ymax) {
      hline(r, edge.xmin, edge.ymin, edge.xmax, rgb);
      continue;
    }
    table.push(edge);
  }
  if (ymin < 0) ymin = 0;
  if (ymax > r.height) ymax = r.height;
  const at = (edge: Edge, y: number): number => f32(f32((y - edge.y0) * edge.dx) + edge.x0);
  for (; ymin <= ymax; ymin++) {
    const xx: number[] = [];
    for (let i = 0; i < table.length; i++) {
      const cur = table[i];
      if (!(ymin >= cur.ymin && ymin <= cur.ymax)) continue;
      xx.push(at(cur, ymin));
      const j = xx.length;
      if (ymin === cur.ymax && ymin < ymax) {
        xx.push(xx[j - 1]);
      } else if ((ymin === cur.ymin || ymin === cur.ymax) && cur.dx !== 0) {
        for (let k = 0; k < i; k++) {
          const other = table[k];
          if ((ymin !== other.ymin && ymin !== other.ymax) || other.dx === 0) continue;
          if (roundf(xx[j - 1]) !== roundf(at(other, ymin))) continue;
          const offset = ymin === cur.ymax ? -1 : 1;
          const adj = at(cur, ymin + offset);
          if (ymin + offset >= other.ymin && ymin + offset <= other.ymax) {
            const adjOther = at(other, ymin + offset);
            if (xx[j - 1] > adj + 1 && xx[j - 1] > adjOther + 1) xx[j - 1] = f32(roundf(Math.max(adj, adjOther)) + 1);
            else if (xx[j - 1] < adj - 1 && xx[j - 1] < adjOther - 1) xx[j - 1] = f32(roundf(Math.min(adj, adjOther)) - 1);
            break;
          }
        }
      }
    }
    xx.sort((a, b) => a - b);
    for (let i = 1; i < xx.length; i += 2) hline(r, roundUp(xx[i - 1]), ymin, roundDown(xx[i]), rgb);
  }
}

/** `ImageDraw.polygon(points, fill=rgb)`: vertices truncated to int, consecutive horizontal edges merged, then `polygon_generic`. */
export function pilFillPolygon(r: Raster, points: ReadonlyArray<readonly [number, number]>, rgb: readonly [number, number, number]): void {
  const xy: number[] = [];
  for (const [x, y] of points) xy.push(cint(x), cint(y));
  const count = points.length;
  const e: Edge[] = [];
  let i = 0;
  for (; i < count - 1; i++) {
    const x0 = xy[i * 2];
    const y0 = xy[i * 2 + 1];
    const x1 = xy[i * 2 + 2];
    const y1 = xy[i * 2 + 3];
    if (y0 === y1 && i !== 0 && y0 === xy[i * 2 - 1]) {
      const last = e[e.length - 1];
      if (x1 > x0 && x0 > xy[i * 2 - 2]) {
        last.xmax = x1;
        continue;
      } else if (x1 < x0 && x0 < xy[i * 2 - 2]) {
        last.xmin = x1;
        continue;
      }
    }
    e.push(addEdge(x0, y0, x1, y1));
  }
  if (xy[i * 2] !== xy[0] || xy[i * 2 + 1] !== xy[1]) e.push(addEdge(xy[i * 2], xy[i * 2 + 1], xy[0], xy[1]));
  polygonGeneric(r, e, rgb);
}

interface Quarter {
  cx: number;
  cy: number;
  ex: number;
  ey: number;
  a2: number;
  b2: number;
  a2b2: number;
  finished: boolean;
}

function quarterInit(a: number, b: number): Quarter {
  if (a < 0 || b < 0) return { cx: 0, cy: 0, ex: 0, ey: 0, a2: 0, b2: 0, a2b2: 0, finished: true };
  return { cx: a, cy: b % 2, ex: a % 2, ey: b, a2: a * a, b2: b * b, a2b2: a * a * b * b, finished: false };
}

function quarterNext(s: Quarter): [number, number] | null {
  if (s.finished) return null;
  const ret: [number, number] = [s.cx, s.cy];
  if (s.cx === s.ex && s.cy === s.ey) s.finished = true;
  else {
    const delta = (x: number, y: number): number => Math.abs(s.a2 * y * y + s.b2 * x * x - s.a2b2);
    let nx = s.cx;
    let ny = s.cy + 2;
    let nd = delta(nx, ny);
    if (nx > 1) {
      let d = delta(s.cx - 2, s.cy + 2);
      if (nd > d) {
        nx = s.cx - 2;
        ny = s.cy + 2;
        nd = d;
      }
      d = delta(s.cx - 2, s.cy);
      if (nd > d) {
        nx = s.cx - 2;
        ny = s.cy;
      }
    }
    s.cx = nx;
    s.cy = ny;
  }
  return ret;
}

/** `ImageDraw.ellipse([x0, y0, x1, y1], fill=rgb)`: the box truncated to int, then `ellipseNew` filled (`width = a + b`). */
export function pilFillEllipse(r: Raster, box: readonly [number, number, number, number], rgb: readonly [number, number, number]): void {
  const [x0, y0, x1, y1] = box.map(cint);
  const a = x1 - x0;
  const b = y1 - y0;
  if (a < 0 || b < 0) return;
  const w = a + b;
  const outer = quarterInit(a, b);
  const leftmost = a % 2;
  const spans: Array<[number, number, number]> = [];
  const first = quarterNext(outer);
  if (w < 1 || first === null) return;
  let pr = first[0];
  let py = first[1];
  const inner = quarterInit(a - 2 * (w - 1), b - 2 * (w - 1));
  let pl = leftmost;
  let finished = false;
  while (!finished) {
    const y = py;
    let l = pl;
    const rr = pr;
    let next: [number, number] | null;
    while ((next = quarterNext(outer)) !== null && next[1] <= y) {
      /* advance */
    }
    if (next === null) finished = true;
    else {
      pr = next[0];
      py = next[1];
    }
    let inext: [number, number] | null;
    let cx = 0;
    while ((inext = quarterNext(inner)) !== null && inext[1] <= y) l = inext[0];
    if (inext !== null) cx = inext[0];
    pl = inext === null ? leftmost : cx;
    const buf: Array<[number, number, number]> = [];
    if ((l > 0 || l < rr) && y > 0) buf.push([l === 0 ? 2 : l, y, rr]);
    if (y > 0) buf.push([-rr, y, -l]);
    if (l > 0 || l < rr) buf.push([l === 0 ? 2 : l, -y, rr]);
    buf.push([-rr, -y, -l]);
    // ellipse_next hands the buffer back last-in first-out
    for (let k = buf.length - 1; k >= 0; k--) spans.push(buf[k]);
  }
  // C's integer division truncates toward zero
  const half = (v: number): number => Math.trunc(v / 2);
  for (const [X0, Y, X1] of spans) hline(r, x0 + half(X0 + a), y0 + half(Y + b), x0 + half(X1 + a), rgb);
}

/** The reference's `ellipse2poly`: 360 points, one per degree, of the rotated ellipse — float64, unrounded. */
export function ellipsePoly(cx: number, cy: number, ax: number, ay: number, angleDeg: number): Array<[number, number]> {
  const a = angleDeg * DEG_TO_RAD;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const pts: Array<[number, number]> = [];
  for (let t = 0; t < 360; t++) {
    const tr = t * DEG_TO_RAD;
    const ct = Math.cos(tr);
    const st = Math.sin(tr);
    pts.push([cx + ax * ct * ca - ay * st * sa, cy + ax * ct * sa + ay * st * ca]);
  }
  return pts;
}

/**
 * Draw one skeleton at `w`x`h`: black RGB (alpha 255), limbs at 0.6 x colour,
 * keypoints on top. `pose` is a built-in's name, whose authored points are
 * scaled to the canvas ({@link scaledPoints}), or the points of a pose file
 * (issue #198), already in this canvas's pixels and drawn as given — the same
 * drawing either way, so a file holding a built-in's points at this size draws
 * the built-in's image byte for byte.
 *
 * Measured bit-exact against Pillow 12.2.0 running the reference's own
 * renderer: both skeletons at 832x1216, 1024x1024, 600x900, 1216x832,
 * 400x640 and 2048x2048 — 16,124,608 pixels, 0 different. (`math.radians` /
 * `math.degrees` there are one multiplication by a constant, as here; the
 * `x * 180 / pi` spelling is a different double.) The selftest's `SK` controls
 * hold the properties that can be stated without PIL.
 *
 * `stickHalfWidth` is the limb ellipse's semi-minor axis; its default is the
 * xinsir rule above. Passing the canonical 4 px draws the skeleton the
 * selftest plants to show its width control goes red.
 */
export function renderSkeleton(pose: SkeletonName | PosePoints, w: number, h: number, stickHalfWidth: number = 4 * stickScale(Math.max(w, h))): Raster {
  const r = newRaster(w, h);
  for (let i = 3; i < r.data.length; i += 4) r.data[i] = 255;
  const pts = typeof pose === 'string' ? scaledPoints(pose, w, h) : pose;
  const kp = KEYPOINT_NAMES.map((k) => pts[k]);
  const sw = stickHalfWidth;
  LIMB_SEQ.forEach(([i1, i2], i) => {
    const [x1, y1] = kp[i1 - 1];
    const [x2, y2] = kp[i2 - 1];
    const angle = Math.atan2(y1 - y2, x1 - x2) * RAD_TO_DEG;
    const poly = ellipsePoly((x1 + x2) / 2, (y1 + y2) / 2, Math.hypot(x1 - x2, y1 - y2) / 2, sw, angle);
    const c = COLORS[i];
    pilFillPolygon(r, poly, [Math.trunc(c[0] * 0.6), Math.trunc(c[1] * 0.6), Math.trunc(c[2] * 0.6)]);
  });
  kp.forEach(([x, y], i) => pilFillEllipse(r, [x - 4, y - 4, x + 4, y + 4], COLORS[i]));
  return r;
}

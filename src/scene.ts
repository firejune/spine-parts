/**
 * `compose` (issue #74): several finished single-character builds bound into
 * one rig, with an optional background plate and a declared draw order
 * between the characters' slots.
 *
 *     scene.json (spine-parts-scene/1) + each character's green `build` --out
 *       -> rig/{rig.json, motion.json, images/}, scene.json, check/
 *
 * ⭐ **The definitions are #74's, settled before this was written** (its
 * comment "Settled before implementation"): the scene file, what refuses, how
 * the result is gated, and what does not move. Nothing here infers an order,
 * an overlap, a scale or a person; the order is the author's, and the plate's
 * provenance is recorded and judged by nothing.
 *
 * What is composed, from each character's `rig/rig.json`, `rig/motion.json`,
 * `rig/images/`, `parts.json` and `check/check.json`:
 *
 * - **Names, totally.** Every bone, slot, attachment (skin entry), constraint
 *   (its name and every bone or slot it names), `invariants.detached` bone,
 *   track, group and easing of character `<id>` is renamed `<id>:<name>`
 *   ({@link prefixed}); `root` is the one shared root. A name resolves to
 *   exactly one character, and nothing resolves across characters without its
 *   prefix: a constraint naming a bone its own build does not declare is
 *   refused (`SCENE_NAME_PREFIXED` when another character has it,
 *   `SCENE_NAME_RESOLVES` when none does).
 * - **Images are the one name that cannot carry `:`.** rig-c names an
 *   atlas region by its PNG's basename, and an atlas region line holding a
 *   colon is read as a `key: value` line — measured through rig-c 2.15.0
 *   on the demo example renamed `demo:<name>` with images `demo:<file>`:
 *   `A07_ATLAS_TEXT_SHAPE` fails once per region, while the same rig with
 *   images under a `demo/` folder gates green (and draws the page byte for
 *   byte) but keeps the bare basename as the region, so two characters' `face`
 *   would collide. So an image is `<id>.<file>` ({@link imageName}); a
 *   composed image name that two files would take is refused
 *   (`SCENE_IMAGE_NAME_FREE`).
 * - **The offset, once.** A character's `offset` places its rig px on the
 *   canvas by a translation (its rig px are the canvas's px at scale 1, so
 *   every character must share one `rig_scale`). The translation is applied
 *   to what the character places in `root`'s own frame — its first-level
 *   bones (the bones whose parent is `root`), and a region on a slot `root`
 *   carries or a mesh weight bound to `root` (both examples' `shoes` ride
 *   `root`) — and nowhere else: every other offset, weight bind and region
 *   is local to a bone the shift already moved. In Spine's axes it is the
 *   character's stage corner carried to the canvas's ({@link rootShift}),
 *   through `src/coords.ts`. The root is shared, so a character whose idle
 *   keys it, or whose constraint names it, is refused (`SCENE_ROOT_SHARED`):
 *   it would move every character.
 * - **The order.** `order` lists character ids (all of that character's
 *   slots not named elsewhere, in its own order) and prefixed slots; each
 *   slot is drawn exactly once. The plate, if any, is drawn first.
 * - **The plate**: a region on the bone `plate` under `root`, its image at
 *   canvas (0, 0), the canvas's size exactly. Its `provenance` (`observed`,
 *   `generated`, `unknown`) is copied into `scene.json` and nothing reads it.
 * - **The idle**: one `idle` holding every character's tracks, which needs
 *   every character's idle to be the same length (`SCENE_DURATION_AGREES`).
 *
 * Every refusal is collected and thrown at once. A key a build's rig or
 * motion carries that this module does not know is refused rather than
 * copied blind (`SCENE_BUILD_FIELD_KNOWN`): `compose` reads what `build`
 * writes, and a rig written by something else is `check`'s to measure (#77),
 * not this module's to merge.
 *
 * Pure in the sense `src/` is held to: it reads files and returns values; no
 * clock, no randomness, no network, no child process. The rigc gate and the
 * check are run by {@link composeStage} through an injected `RigcRunner`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkStage, gateThroughRigc, type Log } from './build.ts';
import { BARS, type CheckReport, DEFAULT_PACK_SHAPE, DEFAULT_PAGE_EDGES, type PackMode, type RigcRunner } from './check.ts';
import { CONSTRAINT_BONE_FIELDS, ROOT_BONE } from './config.ts';
import { cropToSpineY } from './coords.ts';
import { PartsError, type Problem, problemLine, refuseIfAny } from './errors.ts';
import type { MotionSpec } from './motion.ts';
import { readPng } from './raster/png.ts';
import { readRequirements, type RequirementsFile } from './requirements.ts';
import { OFFSET_PLACES, rigJsonText, type RigSpec } from './rig.ts';
import { pyRound } from './round.ts';

/** The scene file's `spec`. */
export const SCENE_SPEC = 'spine-parts-scene/1';

/** `scene.json`'s `spec`: what `compose` writes beside its outputs. */
export const SCENE_REPORT_SPEC = 'spine-parts-scene-report/1';

/** The file `compose` writes beside `rig/` and `check/`. */
export const SCENE_REPORT_FILE = 'scene.json';

/** Between a character's id and a name it owns. */
export const PREFIX_SEP = ':';

/** Between a character's id and an image file it owns — see the module comment for why not {@link PREFIX_SEP}. */
export const IMAGE_SEP = '.';

/** The plate's bone, slot and attachment name, and its image file. */
export const PLATE = 'plate';
export const PLATE_IMAGE = 'plate.png';

/** What the author says the plate's pixels are. Recorded; judged by nothing. */
export const PROVENANCES = ['observed', 'generated', 'unknown'] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** Every path `compose` writes under `--out`, relative — and so every path it clears first. */
export const COMPOSE_OWNS: readonly string[] = ['rig', 'check', SCENE_REPORT_FILE];

/** `<id>:<name>`. */
export function prefixed(id: string, name: string): string {
  return `${id}${PREFIX_SEP}${name}`;
}

/** `<id>.<file>`. */
export function imageName(id: string, file: string): string {
  return `${id}${IMAGE_SEP}${file}`;
}

// ---------------------------------------------------------------------------
// the scene file
// ---------------------------------------------------------------------------

export interface SceneCharacter {
  id: string;
  /** As written, and resolved against the scene file's directory. */
  build: string;
  buildDir: string;
  offset: [number, number];
}

export interface ScenePlate {
  image: string;
  imagePath: string;
  provenance: Provenance;
  note: string | null;
}

export interface SceneFile {
  path: string;
  canvas: { width: number; height: number };
  plate: ScenePlate | null;
  characters: SceneCharacter[];
  order: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/** An annotation (`note`, `*_note`, a string) or a project's record (`x-…`, any value): read by nothing, as in the config and the requirements file. */
function freeKey(key: string, value: unknown): boolean {
  if (key.length > 2 && key.startsWith('x-')) return true;
  return (key === 'note' || key.endsWith('_note')) && typeof value === 'string';
}

/**
 * Why `id` cannot be a character's id, or null. Empty, or holding the
 * {@link PREFIX_SEP} — settled in #74: a prefixed name splits at its first
 * colon, so an id holding one would read as another. And, because an id
 * begins an image file's name ({@link imageName}), a `/` or `\` or a leading
 * `.` — the rule `parts.json` holds a part name to.
 */
export function idProblem(id: string): string | null {
  if (id === '') return 'is empty; an id names its character in every prefixed name, so one is required';
  if (id.includes(PREFIX_SEP)) return `holds "${PREFIX_SEP}", which separates an id from the name it prefixes, so "${id}${PREFIX_SEP}x" would not read back as one id and one name`;
  if (/[\\/]/.test(id) || id.startsWith('.')) return `begins every image file of its character ("${id}${IMAGE_SEP}<file>.png"), so a "/", a "\\" or a leading "." is refused, as in a part name`;
  return null;
}

/**
 * Read and shape-check a scene file. Every problem is collected before one
 * refusal: the file, `spec`, `canvas` (two positive integers), `plate`
 * (optional: `image`, `provenance`, an optional `note`), `characters` (at
 * least one; each `id`, `build`, `offset`), `order` (a list of strings), and
 * any key the format does not read. Resolving the ids and slots `order`
 * names is {@link composeScene}'s, which has the builds.
 */
export function loadScene(path: string): SceneFile {
  const at = resolve(path);
  if (!existsSync(at) || !statSync(at).isFile()) refuseIfAny([{ code: 'SCENE_FILE', object: at, detail: `no such file; a ${SCENE_SPEC} file is required` }]);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(at, 'utf8'));
  } catch (err) {
    refuseIfAny([{ code: 'SCENE_FILE', object: at, detail: `${(err as Error).message}; a JSON object is required` }]);
  }
  if (!isRecord(raw)) refuseIfAny([{ code: 'SCENE_FILE', object: at, detail: `is ${show(raw)}; a JSON object is required` }]);
  const o = raw as Record<string, unknown>;
  const base = dirname(at);
  const problems: Problem[] = [];
  const fail = (code: string, object: string, detail: string): void => {
    problems.push({ code, object, detail });
  };
  const known = (obj: Record<string, unknown>, where: string, keys: readonly string[]): void => {
    for (const [k, v] of Object.entries(obj)) {
      if (!keys.includes(k) && !freeKey(k, v)) fail('SCENE_KEY_KNOWN', `${where}.${k}`, `is a key ${SCENE_SPEC} does not read; it reads ${keys.join(', ')} (and "note", "…_note" strings and "x-…" records, which nothing reads)`);
    }
  };
  known(o, 'scene', ['spec', 'canvas', 'plate', 'characters', 'order']);
  if (o.spec !== SCENE_SPEC) fail('SCENE_SPEC', 'scene.spec', `is ${show(o.spec)}; "${SCENE_SPEC}" is required`);

  // canvas
  let canvas = { width: 0, height: 0 };
  if (!('canvas' in o)) fail('SCENE_FIELD_PRESENT', 'scene.canvas', 'is absent and required; {"width": W, "height": H}, the shared stage in canvas px');
  else if (!isRecord(o.canvas)) fail('SCENE_FIELD_TYPE', 'scene.canvas', `is ${show(o.canvas)}; {"width": W, "height": H} is required`);
  else {
    known(o.canvas, 'scene.canvas', ['width', 'height']);
    for (const k of ['width', 'height'] as const) {
      const v = o.canvas[k];
      if (!(k in o.canvas)) fail('SCENE_FIELD_PRESENT', `scene.canvas.${k}`, 'is absent and required; a positive integer of canvas px');
      else if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) fail('SCENE_FIELD_TYPE', `scene.canvas.${k}`, `is ${show(v)}; a positive integer of canvas px is required`);
      else canvas = { ...canvas, [k]: v };
    }
  }

  // plate
  let plate: ScenePlate | null = null;
  if ('plate' in o) {
    const p = o.plate;
    if (!isRecord(p)) fail('SCENE_FIELD_TYPE', 'scene.plate', `is ${show(p)}; {"image": "<png>", "provenance": ${PROVENANCES.map((x) => `"${x}"`).join(' | ')}} is required when the key is present`);
    else {
      known(p, 'scene.plate', ['image', 'provenance', 'note']);
      const image = p.image;
      const prov = p.provenance;
      if (!('image' in p)) fail('SCENE_FIELD_PRESENT', 'scene.plate.image', 'is absent and required; the plate PNG, relative to the scene file');
      else if (typeof image !== 'string' || image === '') fail('SCENE_FIELD_TYPE', 'scene.plate.image', `is ${show(image)}; a path is required`);
      if (!('provenance' in p)) fail('SCENE_FIELD_PRESENT', 'scene.plate.provenance', `is absent and required; one of ${PROVENANCES.join(', ')} — what the plate's pixels are, which the author states and nothing judges`);
      else if (typeof prov !== 'string' || !(PROVENANCES as readonly string[]).includes(prov)) fail('SCENE_PLATE_PROVENANCE', 'scene.plate.provenance', `is ${show(prov)}; one of ${PROVENANCES.join(', ')} is required`);
      if (typeof image === 'string' && image !== '' && typeof prov === 'string' && (PROVENANCES as readonly string[]).includes(prov)) {
        plate = { image, imagePath: resolve(base, image), provenance: prov as Provenance, note: typeof p.note === 'string' ? p.note : null };
      }
    }
  }

  // characters
  const characters: SceneCharacter[] = [];
  if (!('characters' in o)) fail('SCENE_FIELD_PRESENT', 'scene.characters', 'is absent and required; a list of {"id", "build", "offset"}, at least one');
  else if (!Array.isArray(o.characters) || o.characters.length === 0) fail('SCENE_FIELD_TYPE', 'scene.characters', `is ${show(o.characters)}; a list of at least one {"id", "build", "offset"} is required`);
  else {
    const seen = new Map<string, number>();
    o.characters.forEach((c, i) => {
      const where = `scene.characters[${i}]`;
      if (!isRecord(c)) {
        fail('SCENE_FIELD_TYPE', where, `is ${show(c)}; {"id", "build", "offset"} is required`);
        return;
      }
      known(c, where, ['id', 'build', 'offset']);
      let ok = true;
      for (const k of ['id', 'build', 'offset']) {
        if (!(k in c)) {
          fail('SCENE_FIELD_PRESENT', `${where}.${k}`, `is absent and required${k === 'offset' ? '; [x, y], the translation from the build\'s rig px to canvas px — (0, 0) is written, never assumed' : ''}`);
          ok = false;
        }
      }
      const id = c.id;
      if ('id' in c && typeof id !== 'string') {
        fail('SCENE_FIELD_TYPE', `${where}.id`, `is ${show(id)}; a string is required`);
        ok = false;
      } else if (typeof id === 'string') {
        const why = idProblem(id);
        if (why !== null) {
          fail('SCENE_ID_FORM', `${where}.id`, `"${id}" ${why}`);
          ok = false;
        }
        const first = seen.get(id);
        if (first !== undefined) {
          fail('SCENE_ID_UNIQUE', `${where}.id`, `is "${id}", the id of scene.characters[${first}] too; an id is the prefix that keeps a name to one character, so each must be unique`);
          ok = false;
        } else seen.set(id, i);
      }
      if ('build' in c && (typeof c.build !== 'string' || c.build === '')) {
        fail('SCENE_FIELD_TYPE', `${where}.build`, `is ${show(c.build)}; the directory a green \`rig-parts build\` wrote (its --out), relative to the scene file, is required`);
        ok = false;
      }
      const off = c.offset;
      if ('offset' in c && !(Array.isArray(off) && off.length === 2 && off.every((v) => typeof v === 'number' && Number.isFinite(v)))) {
        fail('SCENE_FIELD_TYPE', `${where}.offset`, `is ${show(off)}; [x, y], two finite numbers of canvas px, is required`);
        ok = false;
      }
      if (ok) characters.push({ id: id as string, build: c.build as string, buildDir: resolve(base, c.build as string), offset: [(off as number[])[0], (off as number[])[1]] });
    });
  }

  // order
  const order: string[] = [];
  if (!('order' in o)) fail('SCENE_FIELD_PRESENT', 'scene.order', 'is absent and required; the declared draw order, back to front: character ids and "<id>:<slot>" entries, every slot once — nothing infers it');
  else if (!Array.isArray(o.order)) fail('SCENE_FIELD_TYPE', 'scene.order', `is ${show(o.order)}; a list of strings is required`);
  else {
    o.order.forEach((e, i) => {
      if (typeof e !== 'string' || e === '') fail('SCENE_FIELD_TYPE', `scene.order[${i}]`, `is ${show(e)}; a character id or "<id>${PREFIX_SEP}<slot>" is required`);
      else order.push(e);
    });
  }
  refuseIfAny(problems);
  return { path: at, canvas, plate, characters, order };
}

// ---------------------------------------------------------------------------
// a character's build
// ---------------------------------------------------------------------------

/** What `compose` reads from one character's `build --out`. */
export interface CharacterBuild {
  id: string;
  dir: string;
  rig: RigSpec;
  motion: MotionSpec;
  /** `parts.json`'s `rig_size`, `scale_rig_per_source`, and the union of its part boxes (rig px, [x0, y0, x1, y1], x1 and y1 exclusive). */
  rigSize: [number, number];
  rigScale: number;
  artBox: [number, number, number, number];
  /** Every image the build's skin names, as `rig/images/<file>` holds it, in the order the skin names them. */
  images: Array<[string, Uint8Array]>;
}

const BONE_KEYS = ['name', 'parent', 'length', 'rotation', 'x', 'y'];
const SLOT_KEYS = ['name', 'bone', 'attachment'];
const ATTACHMENT_KEYS = ['type', 'image', 'width', 'height', 'uvs', 'triangles', 'hull', 'weights', 'x', 'y', 'rotation'];
const RIG_KEYS = ['spec', 'name', 'images', 'skeleton', 'bones', 'slots', 'skins', 'constraints', 'invariants'];
const INVARIANT_KEYS = ['idleDrivesMeshes', 'detached'];
const MOTION_KEYS = ['spec', 'archetype', 'cut', 'easings', 'groups', 'animations'];
const IDLE_KEYS = ['duration', 'loop', 'note', 'tracks'];
const TRACK_KEYS = ['bone', 'group', 'property', 'keys'];
const KEY_KEYS = ['t', 'v', 'curve', 'ease'];

/** One animation of a motion.json: the idle, or one beside it as the file `motion.animations_from` named it (issue #183). */
type SceneAnimation = { duration: number; loop?: boolean; note?: string; tracks: MotionSpec['animations']['idle']['tracks'] };

/** Every animation a motion.json holds, the idle first, in its own order. */
function animationsOf(motion: MotionSpec): Record<string, SceneAnimation> {
  return motion.animations as unknown as Record<string, SceneAnimation>;
}

function readJson(path: string, what: string, problems: Problem[]): unknown {
  if (!existsSync(path)) {
    problems.push({ code: 'SCENE_BUILD_PRESENT', object: path, detail: `no such file; ${what}` });
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    problems.push({ code: 'SCENE_BUILD_PRESENT', object: path, detail: `${(err as Error).message}; ${what}` });
    return undefined;
  }
}

/**
 * Read one character's build, collecting every problem: the files `build`
 * writes (`SCENE_BUILD_PRESENT`), its own check green (`SCENE_BUILD_GREEN`:
 * `check/check.json` with `PASS` and `gate_spine_html_green` both true — a
 * build stopped at check has a check.json saying so), and every key of its
 * rig and motion one this module knows (`SCENE_BUILD_FIELD_KNOWN`).
 */
export function readCharacterBuild(c: SceneCharacter, problems: Problem[]): CharacterBuild | null {
  const before = problems.length;
  const dir = c.buildDir;
  const who = `character "${c.id}" (${c.build})`;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    problems.push({ code: 'SCENE_BUILD_PRESENT', object: who, detail: `${dir} is not a directory; the --out of a green \`rig-parts build\` is required` });
    return null;
  }
  const check = readJson(join(dir, 'check', 'check.json'), "the build's own check; a build that ran its check writes it", problems);
  if (check !== undefined) {
    const ck = isRecord(check) ? check : {};
    if (ck.PASS !== true || ck.gate_spine_html_green !== true) {
      problems.push({
        code: 'SCENE_BUILD_GREEN',
        object: who,
        detail: `check/check.json says PASS ${show(ck.PASS)}, gate_spine_html_green ${show(ck.gate_spine_html_green)}; a build whose own check is green on both is required — compose binds finished characters, it does not finish them`,
      });
    }
  }
  const parts = readJson(join(dir, 'parts.json'), "assemble's parts.json, which holds the rig_scale and the art's place", problems);
  const rigRaw = readJson(join(dir, 'rig', 'rig.json'), "the rig stage's rig.json", problems);
  const motionRaw = readJson(join(dir, 'rig', 'motion.json'), "the rig stage's motion.json", problems);
  const unknown = (where: string, obj: unknown, keys: readonly string[]): void => {
    if (!isRecord(obj)) {
      problems.push({ code: 'SCENE_BUILD_FIELD_KNOWN', object: `${who} ${where}`, detail: `is ${show(obj)}; an object is required` });
      return;
    }
    for (const k of Object.keys(obj)) {
      if (!keys.includes(k)) problems.push({ code: 'SCENE_BUILD_FIELD_KNOWN', object: `${who} ${where}.${k}`, detail: `is a key compose does not know how to prefix or place (it knows ${keys.join(', ')}); what build writes is composed, and a key nobody prefixes could name a bone of the wrong character` });
    }
  };
  let rigScale = Number.NaN;
  let rigSize: [number, number] = [0, 0];
  let artBox: [number, number, number, number] = [0, 0, 0, 0];
  if (parts !== undefined) {
    const p = isRecord(parts) ? parts : {};
    const list = Array.isArray(p.parts) ? (p.parts as unknown[]).filter(isRecord) : [];
    if (typeof p.scale_rig_per_source !== 'number' || !Array.isArray(p.rig_size) || list.length === 0) {
      problems.push({ code: 'SCENE_BUILD_PRESENT', object: `${who} parts.json`, detail: 'needs scale_rig_per_source, rig_size and at least one part; assemble writes all three' });
    } else {
      rigScale = p.scale_rig_per_source;
      rigSize = [Number(p.rig_size[0]), Number(p.rig_size[1])];
      const xs = list.map((q) => Number(q.x));
      const ys = list.map((q) => Number(q.y));
      artBox = [Math.min(...xs), Math.min(...ys), Math.max(...list.map((q) => Number(q.x) + Number(q.w))), Math.max(...list.map((q) => Number(q.y) + Number(q.h)))];
    }
  }
  const images: Array<[string, Uint8Array]> = [];
  if (rigRaw !== undefined) {
    unknown('rig.json', rigRaw, RIG_KEYS);
    const r = rigRaw as Record<string, unknown>;
    if (isRecord(r)) {
      const bones = Array.isArray(r.bones) ? r.bones : [];
      bones.forEach((b, i) => unknown(`rig.json bones[${i}]`, b, BONE_KEYS));
      const root = bones[0] as Record<string, unknown> | undefined;
      if (root === undefined || root.name !== ROOT_BONE || root.x !== 0 || root.y !== 0 || Object.keys(root).length !== 3) {
        problems.push({ code: 'SCENE_BUILD_FIELD_KNOWN', object: `${who} rig.json bones[0]`, detail: `is ${show(root)}; {"name": "${ROOT_BONE}", "x": 0, "y": 0}, as the rig stage writes it, is required — the composed root is shared, so a character's root must carry no transform of its own` });
      }
      (Array.isArray(r.slots) ? r.slots : []).forEach((s, i) => unknown(`rig.json slots[${i}]`, s, SLOT_KEYS));
      if (isRecord(r.invariants)) unknown('rig.json invariants', r.invariants, INVARIANT_KEYS);
      const skins = isRecord(r.skins) ? r.skins : {};
      unknown('rig.json skins', skins, ['default']);
      const seen = new Set<string>();
      for (const [slot, atts] of Object.entries(isRecord(skins.default) ? skins.default : {})) {
        for (const [name, att] of Object.entries(isRecord(atts) ? atts : {})) {
          unknown(`rig.json skins.default.${slot}.${name}`, att, ATTACHMENT_KEYS);
          const file = isRecord(att) ? att.image : undefined;
          if (typeof file !== 'string' || seen.has(file)) continue;
          seen.add(file);
          const png = join(dir, 'rig', 'images', file);
          if (!existsSync(png)) problems.push({ code: 'SCENE_BUILD_PRESENT', object: `${who} skins.default.${slot}.${name}`, detail: `names the image "${file}", and ${png} does not exist` });
          else images.push([file, new Uint8Array(readFileSync(png))]);
        }
      }
    }
  }
  if (motionRaw !== undefined) {
    unknown('motion.json', motionRaw, MOTION_KEYS);
    const m = motionRaw as Record<string, unknown>;
    if (isRecord(m)) {
      const anims = isRecord(m.animations) ? m.animations : {};
      // Every animation beside the idle (motion.animations_from, issue #183) is read with the idle's own key lists,
      // so each name it carries is one compose prefixes; its loop is the file's, not the rig stage's.
      for (const [n, a] of Object.entries(anims)) {
        if (n === 'idle') continue;
        unknown(`motion.json animations.${n}`, a, IDLE_KEYS);
        const tracks = isRecord(a) && Array.isArray(a.tracks) ? a.tracks : [];
        tracks.forEach((t, i) => {
          unknown(`motion.json animations.${n}.tracks[${i}]`, t, TRACK_KEYS);
          const keys = isRecord(t) && Array.isArray(t.keys) ? t.keys : [];
          keys.forEach((k, j) => unknown(`motion.json animations.${n}.tracks[${i}].keys[${j}]`, k, KEY_KEYS));
        });
      }
      if (isRecord(anims.idle)) {
        unknown('motion.json animations.idle', anims.idle, IDLE_KEYS);
        if (anims.idle.loop !== true) problems.push({ code: 'SCENE_BUILD_FIELD_KNOWN', object: `${who} motion.json animations.idle.loop`, detail: `is ${show(anims.idle.loop)}; the rig stage writes true` });
        const tracks = Array.isArray(anims.idle.tracks) ? anims.idle.tracks : [];
        tracks.forEach((t, i) => {
          unknown(`motion.json animations.idle.tracks[${i}]`, t, TRACK_KEYS);
          const keys = isRecord(t) && Array.isArray(t.keys) ? t.keys : [];
          keys.forEach((k, j) => unknown(`motion.json animations.idle.tracks[${i}].keys[${j}]`, k, KEY_KEYS));
        });
      } else problems.push({ code: 'SCENE_BUILD_PRESENT', object: `${who} motion.json animations.idle`, detail: 'is absent; the rig stage writes one idle, which the scene holds every character\'s tracks in' });
    }
  }
  if (problems.length > before) return null;
  return { id: c.id, dir, rig: rigRaw as RigSpec, motion: motionRaw as MotionSpec, rigSize, rigScale, artBox, images };
}

// ---------------------------------------------------------------------------
// composing
// ---------------------------------------------------------------------------

/**
 * The translation, in Spine's axes, that carries a character's first-level
 * bones from its own stage to the canvas: its stage's top-left corner
 * (`skeleton.x`, `skeleton.y + height`) is placed at canvas px `offset`,
 * whose Spine point is (`canvas.x + offset[0]`, `cropToSpineY(offset[1], H)`).
 * Zero for a character at (0, 0) on a canvas of its own stage's size.
 */
export function rootShift(stage: RigSpec['skeleton'], scene: RigSpec['skeleton'], offset: readonly [number, number]): [number, number] {
  const dx = scene.x + offset[0] - stage.x;
  const dy = scene.y + cropToSpineY(offset[1], scene.height) - (stage.y + cropToSpineY(0, stage.height));
  return [dx, dy];
}

/** The composed rig's stage: the canvas, x measured from its centre and y up from its bottom, as the rig stage writes a character's. */
export function sceneStage(canvas: SceneFile['canvas']): RigSpec['skeleton'] {
  return { x: -canvas.width / 2, y: 0, width: canvas.width, height: canvas.height };
}

/** One character's row of `scene.json`. */
export interface SceneCharacterReport {
  id: string;
  build: string;
  offset: [number, number];
  rig_size: [number, number];
  rig_scale: number;
  /** The union of the character's part boxes, placed: canvas px, [x0, y0, x1, y1], x1 and y1 exclusive. */
  bounds: [number, number, number, number];
  /** {@link rootShift}: what was added to the x and y of everything the character places in root's frame, in Spine units (canvas px, y up). */
  shift: [number, number];
  /** What the shift was added to: the first-level bones, the slots on `root` whose regions moved, and the count of mesh weights bound to `root`. */
  shifted: { bones: string[]; root_regions: string[]; root_weights: number };
  bones: number;
  slots: number;
  tracks: number;
  constraints: number;
  idle_duration: number;
}

export interface SceneReport {
  spec: typeof SCENE_REPORT_SPEC;
  scene: string;
  canvas: { width: number; height: number };
  rig_name: string;
  pack_mode: { page_edges: string; pack_shape: string };
  plate: { image: string; provenance: Provenance; note: string | null; bone: string; slot: string; size: [number, number]; judged_by: 'nothing' } | null;
  characters: SceneCharacterReport[];
  order: { declared: string[]; slots: string[]; judged_by: 'nothing' };
  idle_duration: number;
}

export interface ComposedScene {
  rig: RigSpec;
  motion: MotionSpec;
  /** Every image file of the composed rig, by its composed name: the plate's first, then each character's. */
  images: Array<[string, Uint8Array]>;
  report: SceneReport;
}

/** The plate image's bytes and size, read by the caller. */
export interface PlateImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

type Attachment = Record<string, unknown>;

/**
 * Compose the scene from its characters' builds. `builds` holds every
 * character the scene names, in its order, or null where its build could not
 * be read (its problems already collected in `problems`): what can be checked
 * without it — the order's ids, the other characters — still is, so one run
 * names everything. Throws one PartsError holding `problems` and every
 * problem found here.
 */
export function composeScene(
  scene: SceneFile,
  builds: ReadonlyArray<CharacterBuild | null>,
  plate: PlateImage | null,
  problems: Problem[],
  mode: PackMode = { pageEdges: DEFAULT_PAGE_EDGES, packShape: DEFAULT_PACK_SHAPE },
  requirements: RequirementsFile | null = null,
): ComposedScene {
  const fail = (code: string, object: string, detail: string): void => {
    problems.push({ code, object, detail });
  };
  const { canvas } = scene;
  const stage = sceneStage(canvas);
  const ready = builds.filter((b): b is CharacterBuild => b !== null);
  const byId = new Map(ready.map((b) => [b.id, b]));
  const ids = scene.characters.map((c) => c.id);

  // ---- the plate ----------------------------------------------------------
  if (scene.plate !== null && plate !== null && (plate.width !== canvas.width || plate.height !== canvas.height)) {
    fail('SCENE_PLATE_SIZE', `scene.plate.image (${scene.plate.image})`, `is ${plate.width}x${plate.height}; the canvas's size, ${canvas.width}x${canvas.height}, is required — the plate is drawn at canvas (0, 0) and is never scaled`);
  }

  // ---- one rig_scale, one idle length -------------------------------------
  const scales = ready.map((b) => `"${b.id}" ${b.rigScale}`);
  if (new Set(ready.map((b) => b.rigScale)).size > 1) {
    fail('SCENE_RIG_SCALE_AGREES', 'scene.characters', `were built at assemble.rig_scale ${scales.join(', ')} (parts.json's scale_rig_per_source); one rig_scale is required — offsets are canvas px and a character's rig px are canvas px at scale 1, and scaling a character in composition is not offered`);
  }
  const durations = ready.map((b) => b.motion.animations.idle.duration);
  if (new Set(durations).size > 1) {
    fail('SCENE_DURATION_AGREES', 'scene.characters', `have idles of ${ready.map((b, i) => `"${b.id}" ${durations[i]} s`).join(', ')}; one idle holds every character's tracks, so one duration is required — rebuild with one motion.duration`);
  }

  // ---- placed bounds --------------------------------------------------------
  const rows: SceneCharacterReport[] = [];
  scene.characters.forEach((c, i) => {
    const b = byId.get(c.id);
    if (b === undefined) return;
    const [x0, y0, x1, y1] = b.artBox;
    const bounds: [number, number, number, number] = [x0 + c.offset[0], y0 + c.offset[1], x1 + c.offset[0], y1 + c.offset[1]];
    if (bounds[0] < 0 || bounds[1] < 0 || bounds[2] > canvas.width || bounds[3] > canvas.height) {
      fail(
        'SCENE_CHARACTER_INSIDE_CANVAS',
        `scene.characters[${i}] "${c.id}"`,
        `its parts' boxes (rig px [${x0}, ${y0}, ${x1}, ${y1}]) at offset [${c.offset.join(', ')}] cover canvas px [${bounds.join(', ')}], which leaves the ${canvas.width}x${canvas.height} canvas; 0 <= x0, 0 <= y0, x1 <= ${canvas.width} and y1 <= ${canvas.height} are required`,
      );
    }
    const shift = rootShift(b.rig.skeleton, stage, c.offset);
    rows.push({
      id: c.id,
      build: c.build,
      offset: [...c.offset],
      rig_size: [...b.rigSize],
      rig_scale: b.rigScale,
      bounds,
      shift,
      shifted: {
        bones: b.rig.bones.filter((x) => x.parent === ROOT_BONE).map((x) => prefixed(c.id, x.name)),
        root_regions: b.rig.slots.filter((s) => s.bone === ROOT_BONE && Object.values(b.rig.skins.default[s.name] ?? {}).some((a) => !('weights' in a))).map((s) => prefixed(c.id, s.name)),
        root_weights: Object.values(b.rig.skins.default).flatMap((atts) => Object.values(atts)).reduce((n, a) => n + ('weights' in a ? a.weights.flat().filter((w) => w.bone === ROOT_BONE).length : 0), 0),
      },
      bones: b.rig.bones.length - 1,
      slots: b.rig.slots.length,
      tracks: b.motion.animations.idle.tracks.length,
      constraints: b.rig.constraints?.length ?? 0,
      idle_duration: b.motion.animations.idle.duration,
    });
  });

  // ---- the order ------------------------------------------------------------
  const slotsOf = new Map(ready.map((b) => [b.id, b.rig.slots.map((s) => s.name)]));
  const explicit = new Map<string, number>();
  const idAt = new Map<string, number>();
  scene.order.forEach((e, i) => {
    const at = `scene.order[${i}]`;
    const cut = e.indexOf(PREFIX_SEP);
    if (cut < 0) {
      if (!ids.includes(e)) {
        fail('SCENE_ORDER_RESOLVES', at, `is "${e}", which names no character; the ids are ${ids.map((x) => `"${x}"`).join(', ')}, and a slot is written "<id>${PREFIX_SEP}<slot>"`);
        return;
      }
      const first = idAt.get(e);
      if (first !== undefined) fail('SCENE_ORDER_ONCE', at, `names the character "${e}" again (first at scene.order[${first}]); its slots would be drawn twice — each slot is drawn exactly once`);
      else idAt.set(e, i);
      return;
    }
    const id = e.slice(0, cut);
    const slot = e.slice(cut + 1);
    if (!ids.includes(id)) {
      fail('SCENE_ORDER_RESOLVES', at, `is "${e}", whose id "${id}" names no character; the ids are ${ids.map((x) => `"${x}"`).join(', ')}`);
      return;
    }
    const own = slotsOf.get(id);
    if (own === undefined) return;
    if (!own.includes(slot)) {
      fail('SCENE_ORDER_RESOLVES', at, `is "${e}"; character "${id}" has no slot "${slot}" — its slots are ${own.map((s) => `"${s}"`).join(', ')}`);
      return;
    }
    const first = explicit.get(e);
    if (first !== undefined) fail('SCENE_ORDER_ONCE', at, `names the slot "${e}" again (first at scene.order[${first}]); each slot is drawn exactly once`);
    else explicit.set(e, i);
  });
  for (const id of ids) {
    const own = slotsOf.get(id);
    if (own === undefined || idAt.has(id)) continue;
    const missing = own.filter((s) => !explicit.has(prefixed(id, s)));
    if (missing.length > 0) {
      fail('SCENE_ORDER_COMPLETE', `scene.order (character "${id}")`, `names ${missing.length} of the ${own.length} slot(s) of "${id}" nowhere: ${missing.map((s) => `"${prefixed(id, s)}"`).join(', ')}; every slot is drawn exactly once — name "${id}" (its remaining slots, in its own order) or each slot`);
    }
  }
  const drawn: string[] = [];
  for (const e of scene.order) {
    if (e.includes(PREFIX_SEP)) {
      if (explicit.has(e)) drawn.push(e);
      continue;
    }
    for (const s of slotsOf.get(e) ?? []) if (!explicit.has(prefixed(e, s))) drawn.push(prefixed(e, s));
  }

  // ---- names: within a character, every name its own ------------------------
  const bonesOf = new Map(ready.map((b) => [b.id, new Set(b.rig.bones.map((x) => x.name))]));
  const owners = (name: string, own: string): string[] => ready.filter((b) => b.id !== own && (bonesOf.get(b.id)?.has(name) ?? false)).map((b) => b.id);
  const ownBone = (id: string, name: unknown, where: string): void => {
    if (typeof name !== 'string') {
      fail('SCENE_NAME_RESOLVES', where, `is ${show(name)}; a bone name is required`);
      return;
    }
    if (bonesOf.get(id)?.has(name) ?? false) return;
    const other = owners(name, id);
    if (other.length > 0) {
      fail('SCENE_NAME_PREFIXED', where, `names the bone "${name}", which character "${id}" does not declare and ${other.map((x) => `"${x}"`).join(', ')} does${other.length > 1 ? ' each' : ''}; a name crosses characters only with its prefix — ${other.map((x) => `"${prefixed(x, name)}"`).join(' or ')} — and a build's constraint may name only its own bones`);
    } else fail('SCENE_NAME_RESOLVES', where, `names the bone "${name}", which no character of the scene declares`);
  };
  for (const b of ready) {
    (b.rig.constraints ?? []).forEach((con, k) => {
      const type = con.type as keyof typeof CONSTRAINT_BONE_FIELDS;
      const where = `character "${b.id}" rig.json constraints[${k}] (${String(con.type)} "${String(con.name)}")`;
      for (const [field, arity] of CONSTRAINT_BONE_FIELDS[type] ?? []) {
        if (!(field in con)) continue;
        const v = con[field];
        if (arity === 'one') ownBone(b.id, v, `${where}.${field}`);
        else if (Array.isArray(v)) v.forEach((n, j) => ownBone(b.id, n, `${where}.${field}[${j}]`));
        else ownBone(b.id, v, `${where}.${field}`);
      }
      if (type === 'path' && typeof con.slot === 'string' && !(slotsOf.get(b.id) ?? []).includes(con.slot)) {
        fail('SCENE_NAME_RESOLVES', `${where}.slot`, `names the slot "${con.slot}", which character "${b.id}" does not declare`);
      }
    });
    for (const [k, d] of (b.rig.invariants?.detached ?? []).entries()) {
      ownBone(b.id, d.bone, `character "${b.id}" rig.json invariants.detached[${k}].bone`);
      ownBone(b.id, d.notUnder, `character "${b.id}" rig.json invariants.detached[${k}].notUnder`);
    }
  }
  // The root is shared: a character that drives it would move every character.
  for (const b of ready) {
    const where = `character "${b.id}"`;
    for (const [an, anim] of Object.entries(animationsOf(b.motion))) anim.tracks.forEach((t, k) => {
      const tr = t as unknown as Record<string, unknown>;
      const members = typeof tr.group === 'string' ? (b.motion.groups[tr.group] ?? []) : [];
      if (tr.bone === ROOT_BONE || members.includes(ROOT_BONE)) {
        fail('SCENE_ROOT_SHARED', `${where} motion.json animations.${an}.tracks[${k}]`, `keys "${ROOT_BONE}"${typeof tr.group === 'string' ? ` through the group "${tr.group}"` : ''} (${String(tr.property)}); the scene's root is shared by every character, so a key on it would move them all — key a bone of the character's own`);
      }
    });
    (b.rig.constraints ?? []).forEach((con, k) => {
      const named = (CONSTRAINT_BONE_FIELDS[con.type as keyof typeof CONSTRAINT_BONE_FIELDS] ?? []).flatMap(([field]) => {
        const v = con[field];
        return Array.isArray(v) ? v : [v];
      });
      if (named.includes(ROOT_BONE)) fail('SCENE_ROOT_SHARED', `${where} rig.json constraints[${k}] (${String(con.type)} "${String(con.name)}")`, `names "${ROOT_BONE}", which the scene shares by every character; a constraint on it, or following it, would reach every character — name a bone of the character's own`);
    });
  }
  const whys = [...new Set(ready.map((b) => b.rig.invariants?.idleDrivesMeshes?.why).filter((w): w is string => w !== undefined))];
  if (whys.length > 1) {
    fail('SCENE_INVARIANT_AGREES', 'invariants.idleDrivesMeshes', `is declared with ${whys.length} different whys across the characters (${whys.map(show).join(', ')}); the composed rig declares it once, so one why is required`);
  }

  // ---- image names ------------------------------------------------------------
  const taken = new Map<string, string>();
  if (scene.plate !== null) taken.set(PLATE_IMAGE, 'the plate');
  for (const b of ready) {
    for (const [file] of b.images) {
      const n = imageName(b.id, file);
      const who = taken.get(n);
      if (who !== undefined) fail('SCENE_IMAGE_NAME_FREE', `character "${b.id}" image "${file}"`, `composes to the image "${n}", which ${who} already takes; rig-c names an atlas region by its PNG's basename, so two files may not share one — rename an id`);
      else taken.set(n, `character "${b.id}" image "${file}"`);
    }
  }
  if (requirements !== null) problems.push(...requirementPrefixProblems(requirements, ready, scene.plate !== null));
  refuseIfAny(problems);

  // ---- the rig ----------------------------------------------------------------
  const P = (id: string, n: string): string => (n === ROOT_BONE ? n : prefixed(id, n));
  // A first-level bone's x or y plus its character's shift, at the places the rig stage writes an offset to
  // (OFFSET_PLACES); a shift of 0 leaves the number as written, so a character at its own stage moves no byte.
  const shifted = (v: number, d: number): number => {
    if (d === 0) return v;
    const r = pyRound(v + d, OFFSET_PLACES);
    return r === 0 ? 0 : r;
  };
  const bones: RigSpec['bones'] = [{ name: ROOT_BONE, x: 0, y: 0 }];
  const slotDefs = new Map<string, RigSpec['slots'][number]>();
  const skin: Record<string, Record<string, Attachment>> = {};
  const images: Array<[string, Uint8Array]> = [];
  if (scene.plate !== null && plate !== null) {
    bones.push({ name: PLATE, parent: ROOT_BONE, x: 0, y: 0 });
    // The image's centre, canvas (W/2, H/2), in the plate bone's frame (the root's, unturned).
    skin[PLATE] = { [PLATE]: { image: PLATE_IMAGE, x: stage.x + canvas.width / 2, y: cropToSpineY(canvas.height / 2, canvas.height) } };
    images.push([PLATE_IMAGE, plate.bytes]);
  }
  const constraints: Array<Record<string, unknown>> = [];
  const detached: NonNullable<NonNullable<RigSpec['invariants']>['detached']> = [];
  scene.characters.forEach((c) => {
    const b = byId.get(c.id) as CharacterBuild;
    const id = c.id;
    const [dx, dy] = rootShift(b.rig.skeleton, stage, c.offset);
    for (const bone of b.rig.bones) {
      if (bone.name === ROOT_BONE) continue;
      const first = bone.parent === ROOT_BONE;
      bones.push({ ...bone, name: P(id, bone.name), ...(bone.parent === undefined ? {} : { parent: P(id, bone.parent) }), ...(first ? { x: shifted(bone.x, dx), y: shifted(bone.y, dy) } : {}) });
    }
    for (const s of b.rig.slots) slotDefs.set(prefixed(id, s.name), { ...s, name: prefixed(id, s.name), bone: P(id, s.bone), attachment: prefixed(id, s.attachment) });
    // Everything the character places in root's own frame moves with it: a region on a slot root carries, and a
    // weight bound to root. Every other offset is local to a bone the shift already moved.
    const slotBone = new Map(b.rig.slots.map((s) => [s.name, s.bone]));
    for (const [slot, atts] of Object.entries(b.rig.skins.default)) {
      const out: Record<string, Attachment> = {};
      const onRoot = slotBone.get(slot) === ROOT_BONE;
      for (const [name, att] of Object.entries(atts as unknown as Record<string, Attachment>)) {
        const a: Attachment = { ...att, image: imageName(id, att.image as string) };
        if (Array.isArray(att.weights)) {
          a.weights = (att.weights as Array<Array<Record<string, unknown>>>).map((v) =>
            v.map((w) => (w.bone === ROOT_BONE ? { ...w, x: shifted(w.x as number, dx), y: shifted(w.y as number, dy) } : { ...w, bone: P(id, w.bone as string) })),
          );
        } else if (onRoot) {
          a.x = shifted(att.x as number, dx);
          a.y = shifted(att.y as number, dy);
        }
        out[prefixed(id, name)] = a;
      }
      skin[prefixed(id, slot)] = out;
    }
    for (const [file, bytes] of b.images) images.push([imageName(id, file), bytes]);
    for (const con of b.rig.constraints ?? []) {
      const type = con.type as keyof typeof CONSTRAINT_BONE_FIELDS;
      const out: Record<string, unknown> = { ...con, name: prefixed(id, String(con.name)) };
      for (const [field, arity] of CONSTRAINT_BONE_FIELDS[type] ?? []) {
        if (!(field in con)) continue;
        out[field] = arity === 'one' ? P(id, con[field] as string) : (con[field] as string[]).map((n) => P(id, n));
      }
      if (type === 'path' && typeof con.slot === 'string') out.slot = prefixed(id, con.slot);
      constraints.push(out);
    }
    for (const d of b.rig.invariants?.detached ?? []) detached.push({ ...d, bone: P(id, d.bone), notUnder: P(id, d.notUnder) });
  });
  const slots: RigSpec['slots'] = [];
  if (scene.plate !== null && plate !== null) slots.push({ name: PLATE, bone: PLATE, attachment: PLATE });
  for (const s of drawn) slots.push(slotDefs.get(s) as RigSpec['slots'][number]);

  const name = ids.join('+');
  const rig: RigSpec = { spec: 'rigc-rig/1', name, images: 'images', skeleton: stage, bones, slots, skins: { default: skin as unknown as RigSpec['skins']['default'] } };
  if (constraints.length > 0) rig.constraints = constraints;
  const invariants: NonNullable<RigSpec['invariants']> = {};
  if (whys.length === 1) invariants.idleDrivesMeshes = { why: whys[0] };
  if (detached.length > 0) invariants.detached = detached;
  if (Object.keys(invariants).length > 0) rig.invariants = invariants;

  // ---- the motion ---------------------------------------------------------------
  const easings: MotionSpec['easings'] = {};
  const groups: MotionSpec['groups'] = {};
  const tracks: MotionSpec['animations']['idle']['tracks'] = [];
  // Every animation beside a character's idle rides along under its character's prefix (issue #183), its tracks
  // prefixed as the idle's are and nothing else changed: the scene plays the idle, and schedules none of these.
  const beside: Record<string, SceneAnimation> = {};
  const notes = new Set(ready.map((b) => b.motion.animations.idle.note));
  for (const c of scene.characters) {
    const b = byId.get(c.id) as CharacterBuild;
    const id = c.id;
    for (const [k, v] of Object.entries(b.motion.easings)) easings[prefixed(id, k)] = v;
    for (const [k, v] of Object.entries(b.motion.groups)) groups[prefixed(id, k)] = v.map((n) => P(id, n));
    const prefixTrack = (t: MotionSpec['animations']['idle']['tracks'][number]): MotionSpec['animations']['idle']['tracks'][number] => {
      const tr = { ...t } as Record<string, unknown>;
      if (typeof tr.bone === 'string') tr.bone = P(id, tr.bone);
      if (typeof tr.group === 'string') tr.group = prefixed(id, tr.group);
      tr.keys = (t.keys as unknown as Array<Record<string, unknown>>).map((k) => (typeof k.ease === 'string' ? { ...k, ease: prefixed(id, k.ease) } : k));
      return tr as unknown as MotionSpec['animations']['idle']['tracks'][number];
    };
    for (const t of b.motion.animations.idle.tracks) tracks.push(prefixTrack(t));
    for (const [n, a] of Object.entries(animationsOf(b.motion))) if (n !== 'idle') beside[prefixed(id, n)] = { ...a, tracks: a.tracks.map(prefixTrack) };
  }
  const note = notes.size === 1 ? [...notes][0] : ready.map((b) => `${b.id}: ${b.motion.animations.idle.note}`).join(' | ');
  const motion: MotionSpec = { spec: 'rigc-motion/1', archetype: name, cut: name, easings, groups, animations: { idle: { duration: durations[0], loop: true, note, tracks }, ...beside } };

  const report: SceneReport = {
    spec: SCENE_REPORT_SPEC,
    scene: scene.path,
    canvas: { ...canvas },
    rig_name: name,
    pack_mode: { page_edges: mode.pageEdges, pack_shape: mode.packShape },
    plate: scene.plate === null || plate === null ? null : { image: scene.plate.image, provenance: scene.plate.provenance, note: scene.plate.note, bone: PLATE, slot: PLATE, size: [plate.width, plate.height], judged_by: 'nothing' },
    characters: rows,
    order: { declared: [...scene.order], slots: slots.map((s) => s.name), judged_by: 'nothing' },
    idle_duration: durations[0],
  };
  return { rig, motion, images, report };
}

// ---------------------------------------------------------------------------
// requirements across characters
// ---------------------------------------------------------------------------

/**
 * `SCENE_NAME_PREFIXED` for a `--requirements` file read against the composed
 * rig: a bone, constraint, slot or attachment the file names that the composed
 * rig does not hold, but that some character holds under that bare name, is
 * refused naming the prefixed names it could have meant. Any other miss is
 * left to `check`'s own `REQUIREMENTS_RESOLVES`, which names it in its words.
 */
export function requirementPrefixProblems(file: RequirementsFile, builds: readonly CharacterBuild[], plate: boolean): Problem[] {
  const out: Problem[] = [];
  const bare = {
    bone: (b: CharacterBuild) => b.rig.bones.map((x) => x.name).filter((n) => n !== ROOT_BONE),
    constraint: (b: CharacterBuild) => (b.rig.constraints ?? []).map((c) => String(c.name)),
    slot: (b: CharacterBuild) => b.rig.slots.map((s) => s.name),
    attachment: (b: CharacterBuild) => Object.values(b.rig.skins.default).flatMap((a) => Object.keys(a)),
  } as const;
  // What the composed rig will hold, by kind: each character's names under its prefix, and the shared root and plate.
  const own = (kind: keyof typeof bare): Set<string> => new Set([...builds.flatMap((b) => bare[kind](b).map((n) => prefixed(b.id, n))), ...(kind === 'bone' ? [ROOT_BONE] : []), ...(plate && kind !== 'constraint' ? [PLATE] : [])]);
  const kinds = {
    bone: { have: own('bone'), bare: bare.bone },
    constraint: { have: own('constraint'), bare: bare.constraint },
    slot: { have: own('slot'), bare: bare.slot },
    attachment: { have: own('attachment'), bare: bare.attachment },
  } as const;
  const look = (kind: keyof typeof kinds, name: unknown, where: string): void => {
    if (typeof name !== 'string' || kinds[kind].have.has(name)) return;
    const who = builds.filter((b) => kinds[kind].bare(b).includes(name)).map((b) => b.id);
    if (who.length === 0) return;
    out.push({
      code: 'SCENE_NAME_PREFIXED',
      object: `${file.path} ${where}`,
      detail: `names the ${kind} "${name}", which the composed rig holds only with a character's prefix: ${who.map((x) => `"${prefixed(x, name)}"`).join(' or ')}; a name crosses characters only with its prefix`,
    });
  };
  file.targets.forEach((t, i) => look('bone', t.bone, `targets[${i}].bone`));
  for (const r of file.requirements) {
    const at = `requirement "${r.name}"`;
    if ('bone' in r) look('bone', r.bone, `${at} bone`);
    if ('target' in r && 'bone' in r.target) look('bone', r.target.bone, `${at} target.bone`);
    if (r.kind === 'follow') look('constraint', r.constraint, `${at} constraint`);
    if (r.kind === 'stretch') {
      look('slot', r.slot, `${at} slot`);
      look('attachment', r.attachment, `${at} attachment`);
    }
    if (r.kind === 'seam') {
      look('slot', r.part, `${at} part`);
      look('slot', r.neighbour, `${at} neighbour`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// what is left unprefixed
// ---------------------------------------------------------------------------

/**
 * Every name in a composed rig and motion that is neither `root`, the plate's
 * (when `plate`), nor prefixed by one of `ids` — the grep the prefix-totality
 * control runs over what `compose` wrote. Each entry is `<where> "<name>"`.
 * Images are held to `<id>.` the same way.
 */
export function unprefixedNames(rig: RigSpec, motion: MotionSpec, ids: readonly string[], plate: boolean): string[] {
  const bad: string[] = [];
  const ok = (n: string, allowPlate: boolean): boolean => n === ROOT_BONE || (allowPlate && plate && n === PLATE) || ids.some((id) => n.startsWith(`${id}${PREFIX_SEP}`) && n.length > id.length + 1);
  const name = (where: string, n: unknown, allowPlate = true): void => {
    if (typeof n !== 'string' || !ok(n, allowPlate)) bad.push(`${where} ${show(n)}`);
  };
  for (const b of rig.bones) {
    name('bone', b.name);
    if (b.parent !== undefined) name(`bone ${b.name} parent`, b.parent);
  }
  for (const s of rig.slots) {
    name('slot', s.name);
    name(`slot ${s.name} bone`, s.bone);
    name(`slot ${s.name} attachment`, s.attachment);
  }
  for (const [slot, atts] of Object.entries(rig.skins.default)) {
    name('skin slot', slot);
    for (const [a, att] of Object.entries(atts)) {
      name(`skin ${slot} attachment`, a);
      const img = (att as unknown as Attachment).image;
      if (typeof img !== 'string' || !((plate && img === PLATE_IMAGE) || ids.some((id) => img.startsWith(`${id}${IMAGE_SEP}`)))) bad.push(`skin ${slot} ${a} image ${show(img)}`);
      const w = (att as unknown as Attachment).weights;
      if (Array.isArray(w)) for (const v of w as Array<Array<{ bone: string }>>) for (const e of v) name(`skin ${slot} ${a} weight bone`, e.bone, false);
    }
  }
  for (const c of rig.constraints ?? []) {
    name('constraint', c.name, false);
    for (const [field, arity] of CONSTRAINT_BONE_FIELDS[c.type as keyof typeof CONSTRAINT_BONE_FIELDS] ?? []) {
      const v = c[field];
      if (arity === 'one') name(`constraint ${String(c.name)} ${field}`, v, false);
      else if (Array.isArray(v)) for (const n of v) name(`constraint ${String(c.name)} ${field}`, n, false);
    }
    if (c.type === 'path') name(`constraint ${String(c.name)} slot`, c.slot, false);
  }
  for (const d of rig.invariants?.detached ?? []) {
    name('invariants.detached bone', d.bone, false);
    name('invariants.detached notUnder', d.notUnder, false);
  }
  for (const [k, v] of Object.entries(motion.easings)) name('easing', k, false);
  for (const [g, members] of Object.entries(motion.groups)) {
    name('group', g, false);
    for (const m of members) name(`group ${g} member`, m, false);
  }
  for (const t of Object.values(animationsOf(motion)).flatMap((a) => a.tracks)) {
    const tr = t as unknown as Record<string, unknown>;
    if ('bone' in tr) name('track bone', tr.bone, false);
    if ('group' in tr) name('track group', tr.group, false);
    for (const k of (tr.keys as Array<Record<string, unknown>>) ?? []) if (typeof k.ease === 'string') name('key ease', k.ease, false);
  }
  return bad;
}

// ---------------------------------------------------------------------------
// the stage
// ---------------------------------------------------------------------------

/**
 * Everything before the gate, from the files: the scene, every character's
 * build, the plate and the `--requirements` file, each read with its problems
 * collected, then {@link composeScene} — one refusal naming every problem the
 * files hold. Pure but for the reads.
 */
export function composeFromFiles(scenePath: string, requirementsPath?: string, mode: PackMode = { pageEdges: DEFAULT_PAGE_EDGES, packShape: DEFAULT_PACK_SHAPE }): ComposedScene {
  const scene = loadScene(scenePath);
  const problems: Problem[] = [];
  const builds = scene.characters.map((c) => readCharacterBuild(c, problems));
  let plate: PlateImage | null = null;
  if (scene.plate !== null) {
    const where = `scene.plate.image (${scene.plate.image})`;
    if (!existsSync(scene.plate.imagePath)) problems.push({ code: 'SCENE_PLATE_PRESENT', object: where, detail: `${scene.plate.imagePath} does not exist; a PNG of the canvas's size is required` });
    else {
      try {
        const r = readPng(scene.plate.imagePath);
        plate = { bytes: new Uint8Array(readFileSync(scene.plate.imagePath)), width: r.width, height: r.height };
      } catch (err) {
        problems.push({ code: 'SCENE_PLATE_PRESENT', object: where, detail: `${(err as Error).message}; a PNG is required` });
      }
    }
  }
  let req: RequirementsFile | null = null;
  if (requirementsPath !== undefined) {
    try {
      req = readRequirements(requirementsPath);
    } catch (err) {
      if (!(err instanceof PartsError)) throw err;
      problems.push(...err.problems);
    }
  }
  return composeScene(scene, builds, plate, problems, mode, req);
}

export interface ComposeInput {
  scene: string;
  out: string;
  requirements?: string;
}

export interface ComposeRunners {
  rig: RigcRunner;
  check: RigcRunner;
  checkBin: string;
  /** A directory the gate may stage in; emptied before and after. */
  scratch: string;
}

export type ComposeStage = 'compose' | 'check';

export interface ComposeResult {
  stoppedAt: ComposeStage | null;
  composed: ComposedScene | null;
  check: CheckReport | null;
}

/**
 * Load the scene and every build, compose, gate the result through rig-c
 * exactly as `rig` and `build` gate theirs ({@link gateThroughRigc}: `build
 * --profile spine-html --pack`, the compile and the packed pages on disk),
 * write `rig/` and `scene.json` only when that is green, then run `check` over
 * the composed rig (it reads a rig it did not build, #77; `--requirements`
 * forwarded, #93). Lines go to `log` under `[compose]` and `[check]`, as
 * `build` prints its stages. The paths {@link COMPOSE_OWNS} names are cleared
 * first. A crash that is not a refusal is rethrown.
 */
export function composeStage(input: ComposeInput, run: ComposeRunners, log: Log): ComposeResult {
  const prefix = (stage: ComposeStage): Log => (line) => log(`[${stage}] ${line}`);
  const say = prefix('compose');
  const refused = (stage: ComposeStage, err: unknown, composed: ComposedScene | null = null): ComposeResult => {
    if (!(err instanceof PartsError)) throw err;
    const p = prefix(stage);
    for (const x of err.problems) p(`  FAIL  ${problemLine(x)}`);
    p(`refused: ${err.problems.length} problem(s)`);
    log(`compose: stopped at ${stage}; nothing ${stage === 'compose' ? 'was written' : 'after the check was written'}`);
    return { stoppedAt: stage, composed, check: null };
  };
  mkdirSync(input.out, { recursive: true });
  for (const p of COMPOSE_OWNS) rmSync(join(input.out, p), { recursive: true, force: true });
  const mode: PackMode = { pageEdges: DEFAULT_PAGE_EDGES, packShape: DEFAULT_PACK_SHAPE };
  log(`rig-parts compose: ${input.scene} -> ${input.out}, page edges ${mode.pageEdges}, pack shape ${mode.packShape}`);
  let composed: ComposedScene;
  try {
    composed = composeFromFiles(input.scene, input.requirements, mode);
  } catch (err) {
    return refused('compose', err);
  }
  const r = composed.report;
  r.scene = input.scene;
  say(`${r.characters.length} character(s) on a ${r.canvas.width}x${r.canvas.height} canvas, rig "${r.rig_name}"${r.plate === null ? ', no plate' : `, plate ${r.plate.image} (provenance ${r.plate.provenance}, judged by nothing)`}`);
  for (const c of r.characters) {
    say(`  ${c.id}: ${c.build} at offset [${c.offset.join(', ')}], bounds [${c.bounds.join(', ')}], shift [${c.shift.join(', ')}] on ${c.shifted.bones.length} first-level bone(s), ${c.shifted.root_regions.length} region(s) on root and ${c.shifted.root_weights} weight(s) bound to root; ${c.bones} bone(s), ${c.slots} slot(s), ${c.tracks} track(s), ${c.constraints} constraint(s), rig_scale ${c.rig_scale}, idle ${c.idle_duration} s`);
  }
  say(`  order (declared, judged by nothing): ${r.order.declared.join(', ')} -> ${r.order.slots.length} slot(s), back to front`);
  const texts: Array<[string, string]> = [
    ['rig.json', rigJsonText(composed.rig)],
    ['motion.json', rigJsonText(composed.motion)],
  ];
  const gate = gateThroughRigc(composed.images, texts, run.rig, run.scratch, mode);
  for (const g of gate) {
    say(`  rigc ${g.label}: exit ${g.status}`);
    for (const l of g.lines) say(`    ${l.trim()}`);
  }
  const red = gate.filter((g) => g.status !== 0);
  if (red.length > 0) {
    return refused(
      'compose',
      new PartsError(
        red.map((g) => ({
          code: 'COMPOSE_RIGC_GREEN',
          object: `rigc ${g.label}`,
          detail: `exited ${g.status}${g.lines.length > 0 ? `: ${g.lines.map((l) => l.trim()).join(' | ')}` : ', and it printed nothing'}; exit 0 is required before anything is written, and nothing was`,
        })),
      ),
    );
  }
  const rigDir = join(input.out, 'rig');
  mkdirSync(join(rigDir, 'images'), { recursive: true });
  for (const [file, bytes] of composed.images) writeFileSync(join(rigDir, 'images', file), bytes);
  for (const [file, text] of texts) writeFileSync(join(rigDir, file), text);
  writeFileSync(join(input.out, SCENE_REPORT_FILE), rigJsonText(r));
  say(`wrote ${join(rigDir, 'rig.json')}, motion.json and ${composed.images.length} image(s) under ${join(rigDir, 'images')}, and ${join(input.out, SCENE_REPORT_FILE)}`);
  let report: CheckReport;
  try {
    report = checkStage({ rig: rigDir, out: join(input.out, 'check'), pageEdges: mode.pageEdges, packShape: mode.packShape, ...(input.requirements === undefined ? {} : { requirements: input.requirements }) }, run.check, run.checkBin, prefix('check'));
  } catch (err) {
    return refused('check', err, composed);
  }
  if (!report.figures.PASS) {
    log(`compose: stopped at check; ${report.problems.length} bar(s) or requirement(s) not met (the composed rig and scene.json are written, as build writes its rig before its check)`);
    return { stoppedAt: 'check', composed, check: report };
  }
  log(`compose: PASS — ${report.bars.measured.length} of ${BARS.length} bar(s) measured; the packed atlas under ${join(input.out, 'check', 'build')} is the artifact`);
  return { stoppedAt: null, composed, check: report };
}


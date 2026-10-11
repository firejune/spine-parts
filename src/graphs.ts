/**
 * The ComfyUI graphs the optional adapter submits, built without touching the
 * network: the prompt words, the painting graph, the See-through template
 * filled in, and the check of a graph against a box's `/object_info`.
 *
 * Everything here is pure so the purity scan (`TY06`) covers it; the HTTP
 * that carries these graphs to a box lives in `src/comfy/`, and nothing there
 * decides a word or a node.
 *
 * ## The prompt
 *
 * positive = the quality head, then `trigger`, `identity`, `costume`, the pose
 * words and `style`, split on commas and re-joined with every `DUP_WORDS` term
 * and every empty term dropped. negative = the negative head, `negative_extra`
 * and `negative_pose`, joined with ", " (an empty `negative_extra` is left
 * out). With a non-empty `negative_extra` both strings are the reference's
 * byte for byte.
 *
 * 🚨 **The pose words come from the config or from the skeleton, and from
 * nothing else.** `generation.pose`, when it is set, is the whole of them.
 * When it is absent the config loader has already required a
 * `generation.control`, and the pose words are `FRAMING` followed by that
 * skeleton's own `words` (`src/skeleton.ts`). The reference appended
 * expression and costume words of one private cast after the skeleton's words
 * in that case; none of them is a property of a skeleton, so none is here, and
 * the selftest plants one to show the control goes red.
 *
 * The two heads are the reference's verbatim, including the safety terms of
 * the negative head (no nudity, no minors): they are a guard, not a cast.
 */
import type { Control, Generation, Lora, Sampler } from './config.ts';
import type { Problem } from './errors.ts';
import { isSkeletonName, SKELETONS } from './skeleton.ts';

export const POSITIVE_HEAD = 'score_9, score_8_up, score_7_up, source_anime, masterpiece, best quality, highly detailed';
export const NEGATIVE_HEAD =
  'score_4, score_3, score_2, score_1, worst quality, low quality, lowres, blurry, jpeg artifacts, ' +
  'nsfw, nude, naked, cleavage, underwear, sexual, suggestive, child, loli, shota, kid, toddler, ' +
  'text, watermark, signature, logo, bad anatomy, bad hands, extra fingers, deformed, mutated';

/** Camera framing for a full-body figure, prepended to a skeleton's words. Framing, not pose and not costume. */
export const FRAMING = 'full body, head to toe, entire body in frame, front view, facing viewer, looking at viewer';

/**
 * Terms that ask for a mirrored or repeated layout, dropped from every
 * positive (compared case-insensitively, per comma-separated term). With an
 * identity LoRA they tipped the reference's prompt-only batches into two
 * figures side by side in 21 of 24 images.
 */
export const DUP_WORDS: readonly string[] = ['symmetrical composition', 'symmetry', 'symmetrical', 'multiple views', 'reference sheet', 'character sheet'];

/** The ControlNet a skeleton is drawn for: xinsir's, whose stick-scale rule `src/skeleton.ts` follows. Used when `control.model` is absent. */
export const CONTROL_MODEL = 'controlnet-openpose-sdxl-1.0.safetensors';
export const UPSCALE_MODEL = '4x-AnimeSharp.pth';
/** 4x model then 0.5 = a painting twice the latent size. */
export const UPSCALE_THEN = 0.5;

/** The reference's `strip_words`: split on commas, trim, drop DUP_WORDS and empty terms, re-join with ", ". */
export function stripWords(text: string, words: readonly string[] = DUP_WORDS): { text: string; dropped: string[] } {
  const keep: string[] = [];
  const dropped: string[] = [];
  for (const t of text.split(',').map((s) => s.trim())) (words.includes(t.toLowerCase()) ? dropped : keep).push(t);
  return { text: keep.filter((t) => t !== '').join(', '), dropped };
}

export function poseWords(g: Pick<Generation, 'pose' | 'control'>): { words: string; from: string } {
  if (g.pose !== undefined) return { words: g.pose, from: 'generation.pose' };
  if (g.control !== undefined && isSkeletonName(g.control.skeleton)) return { words: `${FRAMING}, ${SKELETONS[g.control.skeleton].words}`, from: `the ${g.control.skeleton} skeleton` };
  // parseConfig refuses both other cases — no pose and no control, and a pose file (which carries no words, issue #198)
  // with no pose; reaching here means a config that skipped the loader.
  throw new Error('poseWords: generation has neither pose nor a built-in control skeleton; load the config through parseConfig');
}

export interface Prompts {
  positive: string;
  negative: string;
  dropped: string[];
  poseFrom: string;
}

export function buildPrompts(g: Generation): Prompts {
  const pose = poseWords(g);
  const raw = [POSITIVE_HEAD, g.trigger, g.identity, g.costume, pose.words, g.style].join(', ');
  const { text, dropped } = stripWords(raw);
  const negative = [NEGATIVE_HEAD, g.negative_extra, g.negative_pose].filter((s) => s !== '').join(', ');
  return { positive: text, negative, dropped, poseFrom: pose.from };
}

// ---------------------------------------------------------------------------
// graphs
// ---------------------------------------------------------------------------

export type Link = [string, number];
export type InputValue = string | number | boolean | Link;
export interface GraphNode {
  class_type: string;
  inputs: Record<string, InputValue>;
}
export type Graph = Record<string, GraphNode>;

/** A LoRA as the graph uses it: `strength_clip` defaults to `strength`, which is what ComfyUI's LoraLoader was given in the reference. */
export function resolvedLoras(loras: readonly Lora[]): Array<Required<Lora>> {
  return loras.map((l) => ({ name: l.name, strength: l.strength, strength_clip: l.strength_clip ?? l.strength }));
}

export function resolvedControl(c: Control): Required<Control> {
  return { skeleton: c.skeleton, strength: c.strength, end_percent: c.end_percent, model: c.model ?? CONTROL_MODEL };
}

/**
 * The sampler as the graph uses it: its four fields by name, in this order.
 * The config's own object also carries whatever annotations and `x-` records
 * its author wrote, and the loader vouches for the four fields only, so a
 * writer that copied the object whole would carry those into an output.
 */
export function resolvedSampler(s: Sampler): Sampler {
  return { steps: s.steps, cfg: s.cfg, sampler: s.sampler, scheduler: s.scheduler };
}

/**
 * The painting graph: checkpoint -> LoRAs in order -> the two text encoders ->
 * (ControlNetApplyAdvanced over the uploaded skeleton) -> KSampler -> VAE
 * decode -> 4x-AnimeSharp -> 0.5 lanczos -> SaveImage. Node ids are the
 * reference's, so a graph can be diffed against its records.
 */
export function paintingGraph(g: Generation, seed: number, prompts: Prompts, prefix: string, skeletonRef: string | null): Graph {
  const [w, h] = g.latent;
  const n: Graph = {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: g.checkpoint } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompts.positive, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: prompts.negative, clip: ['4', 1] } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: g.sampler.steps,
        cfg: g.sampler.cfg,
        sampler_name: g.sampler.sampler,
        scheduler: g.sampler.scheduler,
        denoise: 1.0,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '12': { class_type: 'UpscaleModelLoader', inputs: { model_name: UPSCALE_MODEL } },
    '13': { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['12', 0], image: ['8', 0] } },
    '14': { class_type: 'ImageScaleBy', inputs: { upscale_method: 'lanczos', scale_by: UPSCALE_THEN, image: ['13', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['14', 0] } },
  };
  let model: Link = ['4', 0];
  let clip: Link = ['4', 1];
  resolvedLoras(g.loras).forEach((lo, i) => {
    const id = String(20 + i);
    n[id] = { class_type: 'LoraLoader', inputs: { lora_name: lo.name, strength_model: lo.strength, strength_clip: lo.strength_clip, model, clip } };
    model = [id, 0];
    clip = [id, 1];
  });
  n['3'].inputs.model = model;
  n['6'].inputs.clip = clip;
  n['7'].inputs.clip = clip;
  if (g.control !== undefined) {
    if (skeletonRef === null) throw new Error('paintingGraph: generation.control is set and no skeleton was uploaded');
    const c = resolvedControl(g.control);
    n['30'] = { class_type: 'LoadImage', inputs: { image: skeletonRef } };
    n['31'] = { class_type: 'ControlNetLoader', inputs: { control_net_name: c.model } };
    n['32'] = {
      class_type: 'ControlNetApplyAdvanced',
      inputs: { positive: ['6', 0], negative: ['7', 0], control_net: ['31', 0], image: ['30', 0], strength: c.strength, start_percent: 0.0, end_percent: c.end_percent },
    };
    n['3'].inputs.positive = ['32', 0];
    n['3'].inputs.negative = ['32', 1];
  }
  return n;
}

export interface SeeThroughParams {
  image: string;
  seed: number;
  resolution: number;
  steps: number;
  quant: 'none' | 'nf4';
  offload: boolean;
  lama: boolean;
  prefix: string;
}

/**
 * Fill `workflows/seethrough.json`: a string that IS a placeholder becomes the
 * typed value; `%PREFIX%` inside a longer string is substituted in place.
 * Top-level keys starting with `_` are annotations and are dropped, since
 * `/prompt` reads every top-level key as a node. A placeholder the template
 * holds and this call does not fill is refused rather than sent.
 */
export function fillSeeThrough(template: unknown, p: SeeThroughParams): Graph {
  const values: Record<string, string | number | boolean> = {
    '%IMAGE%': p.image,
    '%SEED%': p.seed,
    '%RESOLUTION%': p.resolution,
    '%STEPS%': p.steps,
    '%QUANT%': p.quant,
    '%OFFLOAD%': p.offload,
    '%LAMA%': p.lama,
    '%PREFIX%': p.prefix,
  };
  const left: string[] = [];
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    if (typeof v === 'string') {
      if (v in values) return values[v];
      const out = v.replaceAll('%PREFIX%', p.prefix);
      const stray = /%[A-Z_]+%/.exec(out);
      if (stray !== null) left.push(stray[0]);
      return out;
    }
    return v;
  };
  if (typeof template !== 'object' || template === null || Array.isArray(template)) throw new Error('fillSeeThrough: the template is not an object of nodes');
  const graph: Record<string, unknown> = {};
  for (const [id, node] of Object.entries(template)) if (!id.startsWith('_')) graph[id] = walk(node);
  if (left.length > 0) throw new Error(`fillSeeThrough: the template holds ${[...new Set(left)].join(', ')}, which nothing fills`);
  return graph as Graph;
}

// ---------------------------------------------------------------------------
// the graph against a box
// ---------------------------------------------------------------------------

/** One node class as `/object_info` describes it; only what the check reads. */
interface NodeSpec {
  input?: { required?: Record<string, unknown>; optional?: Record<string, unknown>; hidden?: Record<string, unknown> };
}

/** The choices of an enum input, in either spelling `/object_info` uses (`[[...]]` or `["COMBO", {options}]`), or null. */
function enumChoices(spec: unknown): string[] | null {
  if (!Array.isArray(spec) || spec.length === 0) return null;
  if (Array.isArray(spec[0])) return spec[0].map(String);
  if (spec[0] === 'COMBO' && typeof spec[1] === 'object' && spec[1] !== null) {
    const options = (spec[1] as Record<string, unknown>).options;
    if (Array.isArray(options)) return options.map(String);
  }
  return null;
}

/**
 * Every problem a box would have with this graph, found before anything is
 * queued: a node class the box does not have (the See-through wrapper not
 * installed is exactly this), an input the class does not take, a required
 * input left unset, and an enum value — a checkpoint, a LoRA, an upscale
 * model — the box does not list. `uploaded` names the node inputs whose value
 * is an image this run uploads, whose enum is not checked.
 */
export function checkGraph(graph: Graph, objectInfo: Record<string, unknown>, host: string, uploaded: ReadonlySet<string> = new Set()): Problem[] {
  const problems: Problem[] = [];
  for (const [id, node] of Object.entries(graph)) {
    const spec = objectInfo[node.class_type] as NodeSpec | undefined;
    if (spec === undefined) {
      problems.push({
        code: 'COMFY_NODE_PRESENT',
        object: `graph node ${id}`,
        detail: `is a ${node.class_type}, which ${host}/object_info does not list; a box with that node class installed is required`,
      });
      continue;
    }
    const required = spec.input?.required ?? {};
    const optional = { ...(spec.input?.hidden ?? {}), ...(spec.input?.optional ?? {}) };
    for (const [name, value] of Object.entries(node.inputs)) {
      const inSpec = name in required ? required[name] : name in optional ? optional[name] : undefined;
      if (inSpec === undefined) {
        problems.push({
          code: 'COMFY_INPUT_KNOWN',
          object: `graph node ${id} (${node.class_type}) input "${name}"`,
          detail: `is not an input of ${node.class_type} on this box; it takes ${[...Object.keys(required), ...Object.keys(optional)].join(', ')}`,
        });
        continue;
      }
      const choices = enumChoices(inSpec);
      if (choices !== null && typeof value === 'string' && !uploaded.has(`${id}.${name}`) && !choices.includes(value)) {
        const shown = choices.length > 12 ? `${choices.slice(0, 12).join(', ')}, … (${choices.length} in all)` : choices.join(', ');
        problems.push({
          code: 'COMFY_CHOICE_PRESENT',
          object: `graph node ${id} (${node.class_type}) input "${name}"`,
          detail: `is "${value}", which this box does not list; one of ${shown} is required`,
        });
      }
    }
    for (const name of Object.keys(required)) {
      if (!(name in node.inputs)) {
        problems.push({ code: 'COMFY_INPUT_SET', object: `graph node ${id} (${node.class_type}) input "${name}"`, detail: 'is required by the box and the graph does not set it' });
      }
    }
  }
  return problems;
}

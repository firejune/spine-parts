# rig-parts

**AI-authored 2D character rigs from one anime painting, verified before they
are written.** rig-parts takes a single character painting and the layers
[See-through](https://github.com/shitagaki-lab/see-through) decomposed it into,
merges them into measured rig-space parts, authors weighted meshes, bone chains
and a looping idle over them in [rig-c](https://github.com/firejune/rigc)'s
spec, and hands that spec to rig-c to compile, gate, pack, render and check.
It is built for agents that cannot see the image: every stage prints named,
numeric findings, a refusal names the object, the value found and the value
required, nothing is written after a red, and no value is invented where the
input is silent.

## What you get

<p align="center">
  <img src="https://raw.githubusercontent.com/firejune/rig-parts/main/assets/demo-source.png" alt="The demo painting: a generated full-body character in a white and pink frilled dress with long pink twin tails, standing with her hands clasped" height="420" />
  <img src="https://raw.githubusercontent.com/firejune/rig-parts/main/assets/demo-idle.png" alt="The same character rigged, breathing, blinking once and swaying her hair, sleeves and skirt in a four-second loop" height="420" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/firejune/rig-parts/main/assets/demo-parts.png" alt="Contact sheet of the painting and the 22 assembled parts it was split into: hair, dress, sleeves, shoes, face, eyes, brows, mouth and ornaments" width="100%" />
</p>

<p align="center"><em>
The painting was generated for this repository with a public checkpoint (Pony
Diffusion V6 XL) and no LoRA; its generation record, See-through layers and licence
are in <a href="https://github.com/firejune/spine-parts-examples">spine-parts-examples</a>
(that repository keeps the name it was published under before this package's rename).
See-through ran twice, once on the whole figure and once on a square head crop.
Then one command: <code>rig-parts build --seam silhouette --loop</code>. The
proposer's bones, meshes, regions and motion were used <b>unedited</b>. Two input-stage
edits were made by hand for the reference run this example reproduces: the head box
was shifted down into the canvas (its proposal ran 118 px above the top edge;
<code>propose --head-box</code> now makes that shift itself), and <code>hair_back</code>
is taken from the full run, because the twin tails leave the head crop sideways
(a plan edit). <code>check</code> printed, verbatim:<br/>
<code>50 assertions: 24 measured (24 passed, 0 failed), 26 skipped, 0 not in profile "spine-html"</code><br/>
<code>loop: idle 49 frame(s) at 12 fps, f0000 vs f0048 (t = 4s): max |d| 0 (0 required)</code><br/>
<code>seam: setup pose at 714x1216, scale 0.9422: mean |d| 0.324 (&lt;= 1.0), 2 px over 40 (&lt;= 50), 0 px over 80 (reported)</code><br/>
<code>pack: skeleton.png 922x1348, 22 region(s), 95.0% covered, padding 2, page edges free, shape polygon</code><br/>
<code>--seam silhouette</code> repaired the navy blobs the default rule leaves on the white
blouse (recomposite error pixels 11,050 → 9,540); the default stays
<code>near-white</code>, the reference implementation's rule, so the examples stay
comparable with it. The loop is <code>rig-parts loop --palette</code>'s indexed APNG, 48 frames at
12 fps, 1,706,719 bytes, one 256-entry palette at a measured error of max 57, mean 1.601
per channel over every frame (the lossless APNG beside it, the exactness record, is
13,645,503 bytes; the GIF, at the same error, 1,812,288). Frame 29 (2.417 s) is the
closed eye: the blink holds for 0.084 s, one 12 fps frame rounded up, where the
reference implementation held 0.04 s and no frame of its loop showed the eyes shut
(issue #32); the painting is shown at half size, resampled and written
by this package's PNG codec (nothing here encodes JPEG). <code>rig-parts sheet</code>
made the contact sheet.
</em></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/firejune/rig-parts/main/assets/sample-parts.png" alt="Contact sheet of the sample character's painting and its 20 parts" width="560" />
</p>

<p align="center"><em>
The plain fixture, <code>examples/sample</code>: same checkpoint, no LoRA, and a rig
built from its own proposal with no hand edit at all —
<code>seam: … mean |d| 0.207 (&lt;= 1.0), 0 px over 40 (&lt;= 50)</code>, loop max |d| 0.
</em></p>

<p align="center"><em>
The hanging element, <code>examples/scarf</code>: same checkpoint, no LoRA, a very long
red scarf whose ends hang free, and the first character run through this pipeline
with its proposal used unedited — the only hand corrections are four
<code>assemble.patches</code>, each answering an <code>uncovered hole</code> line.
<code>check</code> passes 9 of 9 with every mesh on the lattice and with every mesh
switched to the contour mode. It has no reference output: its <code>expected/</code>
is this port's own build (<a href="examples/scarf/README.md">examples/scarf</a>).
</em></p>

## What it takes in

- **One painting** — a PNG of one character, front-facing, full body, taller than
  wide.
- **Its See-through layers, twice**: one run on the whole figure (the painting padded
  white to a square) and one on a square crop around the head, because the eyes of a
  full-figure run are too small to separate. Either form See-through reaches you in
  is read:
  - the **ComfyUI wrapper form** — a directory holding `layers.json` and one RGBA PNG
    per layer (flat beside the manifest, or under `parts/<tag>.png`);
  - an **upstream `.psd`** — one pixel layer per tag, the layer name being the tag,
    the stacking order being the draw order.
- **A character config** (`config.json`) — the part plan, the head box, the bones,
  which bones may pull which layer, the idle's sines, and optionally `constraints`
  in rig-c's own rig-spec shape (ik, transform, path, physics, slider), handed
  to rigc as written once every bone they name resolves; a scene target is a bone
  under `root` a constraint names. `src/config.ts` is its
  schema and documents every field; the loader refuses an unknown or a missing field
  by name, and reads nothing under `note`, a `<name>_note` (a string) or a key
  beginning `x-` (any JSON — a project's own records, such as a past build's gate
  results). [docs/AUTHORING.md](docs/AUTHORING.md) says where each value comes from.

## What it gives out

`rig-parts build` ends the way a Spine editor export does — with **one packed atlas
page** (issue #2):

| path under `--out` | what |
| --- | --- |
| `check/build/skeleton.json`, `skeleton.atlas`, `skeleton.png` | **the artifact** — Spine 4.3 skeleton data and one packed page, written by `rigc build --pack --page-edges free --pack-shape polygon` and gated under `spine-html`, which holds every rule `spine` measures (on the demo, rigc 2.1.3 and 2.10.1: the 14 rules `validate --profile spine` measures are among the build's 24; 16 are not in `spine`) |
| `parts/*.png`, `parts.json`, `recomposite_rig.png`, `recomposite_error_rig.png` | the loose parts, each cropped to its alpha box; the record of where every part came from, how many of its pixels were re-taken from the painting, and the recomposite's uncovered holes with their boxes; the flat stack of parts; its error map — red where no part covers a pixel the painting has, blue where a part covers it in the wrong colour |
| `rig/` | `rig.json` and `motion.json` in rig-c's spec, `mesh_report.json`, the padded `images/` |
| `check/` | both gate files verbatim, the idle's frames and their `geometry.json` (skinned vertices per frame), `contact.png`, `motion_heat.png`, `check.json` (with `pack_mode`, the `--page-edges` and `--pack-shape` the page was packed under) |
| `idle.png`, `idle-indexed.png`, `idle.gif` | with `--loop`: the idle as a lossless APNG (the exactness record), an indexed APNG with one shared palette (the small one) and a GIF; the last two print their palette error |

The last lines of a green build are the pack line, printed beside the Spine example
export's `spineboy.png` as a yardstick (a reference, not a bar), and the three
artifact paths — here for `examples/sample`:

```
build: PASS — the packed atlas is the artifact; parts/ and rig/ are the intermediates it was made from
  pack: skeleton.png 477x1151, 20 region(s), 95.0% covered, padding 2, page edges free, shape polygon; page opaque 54.8% (alpha > 0) — spineboy yardstick 1024x256, 40 region(s), 45.8% opaque (alpha > 0), a reference and not a bar
  out/check/build/skeleton.json
  out/check/build/skeleton.atlas
  out/check/build/skeleton.png
```

The page's edges are free by default: rigc picks the least-area page the parts need,
not the next power of two. On the two examples, packed by rectangles, that is 967x1338
and 479x1166, where a power-of-two page is 1024x2048 and 512x2048, and covered goes from 56.3 % to 91.2 % and
from 49.7 % to 93.4 %. The cost is the one rigc's help states: *"region attachments
sampling within 1 LSB of the loose build rather than exactly"*. Measured on both
examples, every idle frame stays within 1 level of the power-of-two build's. The atlas says
`filter: Linear, Linear` and has no `repeat` line, so `--page-edges pot` is for a
consumer that mipmaps or repeats the page; it writes exactly the page builds wrote
before the flag existed. The measurements are in
[AUTHORING §5, *Page edges*](docs/AUTHORING.md#5-after-each-stage-what-to-read).

The pack shape is `polygon` by default (rig-c 2.1): a region only meshes draw is
packed by its emitted hull, so a neighbour may sit inside its rectangle where the hull
is not; a region attachment stays its rectangle. On the two examples that takes the
free page from 967x1338 to 922x1348 (covered 91.2 % to 95.0 %, 3.9 % less area) and
from 479x1166 to 477x1151 (93.4 % to 95.0 %, 1.7 % less), at the cost class `free`
already has: every idle frame within 1 level of the `rect` build's, and no figure in
`check.json` but `pack_mode` moves. `--pack-shape rect` writes the page and atlas
0.7.0 wrote. The measurements are in
[AUTHORING §5, *Pack shape*](docs/AUTHORING.md#5-after-each-stage-what-to-read).

The packer is rig-c's, and no other: a packed region is a lossless copy, and an
atlas written by anything else would have no oracle behind it.

## Painting → parts → rig → browser

| stage | tool | what it owns |
| --- | --- | --- |
| painting + See-through layers → parts and specs | **rig-parts** | the merge of two runs, the measurements, the rig spec and motion spec |
| specs → Spine skeleton data | **[rig-c](https://github.com/firejune/rigc)** | compile, the gate (rigc's own validator in an install; the round trip through `spine-core` where the runtime is beside it, as in this repository's CI), the named assertions, the packer, the renderer |
| skeleton data → a page | **[rig-play](https://github.com/firejune/rig-play)** (formerly spine-html), a sibling project | a DOM renderer; rigc's `spine-html` profile is its policy, and every build here is gated under that profile as well as under `spine` |

rig-parts never writes Spine data itself. Everything on disk under `check/build/`
was written by rig-c after its own gate passed.

## Getting See-through layers

See-through is required; how you run it is not. rig-parts does not vendor, embed or
redistribute See-through code or weights — run it by any of these and point
rig-parts at what it wrote:

| Route | Where | Output rig-parts reads |
| --- | --- | --- |
| Hugging Face Space | [24yearsold/see-through-demo](https://huggingface.co/spaces/24yearsold/see-through-demo) (ZeroGPU; upstream states 1-2 extractions a day for a registered user) | the `.psd` it produces |
| ModelScope demo | [ljsabc/See-Through](https://modelscope.cn/studios/ljsabc/See-Through), linked from the upstream README | the `.psd` it produces |
| Upstream CLI | `python inference/scripts/inference_psd.py --srcp <image> --save_to_psd` in a checkout of [shitagaki-lab/see-through](https://github.com/shitagaki-lab/see-through) | the `.psd` in `workspace/layerdiff_output/` |
| ComfyUI wrapper | [jtydhr88/ComfyUI-See-through](https://github.com/jtydhr88/ComfyUI-See-through) on your own ComfyUI box; the optional `comfy` adapter (`rig-parts comfy seethrough`) drives it | the `layers.json` + PNGs it writes |

**The head run is needed on every route that was read.** See-through's model
already separates the head in a second stage of its own: it crops the head the
first stage found, runs the face tags on that crop at the same `resolution`, and
pastes the result back **resized to the full image's scale**. So the face comes
back at the full run's pixel density whichever route ran it, and the separate
head run on `st_input_head.png` is what gives the eyes more pixels
(read on 2026-09-28 at see-through `a25a549` and wrapper 0.5.0 `98d754b`):

- *Hugging Face Space* — the same two-stage code, with `resolution` capped at
  1280 (768 by default): the head run is still needed.
- *ModelScope demo* — its code was not read, so what the head run adds on that
  route has not been measured.
- *Upstream CLI* — the `.psd` frame is the `resolution`-sided square the first
  stage ran on (1280 by default), and the head stage is pasted into it at that
  scale: the head run is still needed.
- *ComfyUI wrapper* — `SeeThrough_GenerateLayers` runs both stages with no input
  to change the second, at most `resolution` 2048, which on the examples' 2432 px
  square is 1.19 source px per layer px against 0.77 and 0.47 for their head
  crops; at the 1024 the examples ran, the full run's right eye white is 22×13 px
  and the head run's 60×38: the head run is still needed.

**See-through is required; ComfyUI is not.** The wrapper is one route among
four, and `rig-parts comfy` is only a convenience for that route: every
stage after See-through reads files, whichever route wrote them. On the two
public examples each run took 171–199 s through the wrapper (each run's
`meta.json`, in [spine-parts-examples](https://github.com/firejune/spine-parts-examples)).

### The two images See-through is fed: `inputs`

```sh
rig-parts inputs --source painting.png --config config.json --out <dir>
```

cuts the two images See-through is fed: the painting centred on a white square
(`st_input_full.png`) and, when the config sets `seethrough.head_box`, that
box at its exact size (`st_input_head.png`). Pure raster, no GPU.

### The optional ComfyUI adapter

For a user who has a ComfyUI box, two
commands drive it; nothing else in the pipeline needs one:

```sh
rig-parts comfy paint --config config.json --out <dir> --host http://<box>:8188
rig-parts comfy seethrough --image st_input_full.png --out layers/full --host http://<box>:8188 --offload
```

`comfy paint` generates `painting_<seed>.png` from the config's inline
`generation` block — checkpoint, LoRAs, sampler, and an optional OpenPose
control skeleton it draws itself — and records the prompts verbatim beside it.
`comfy seethrough` runs the [ComfyUI-See-through](https://github.com/jtydhr88/ComfyUI-See-through)
wrapper on one image and writes the wrapper form `layers` reads. The host comes
from `--host` or `COMFY_HOST` and has no default; before anything is uploaded
the graph is checked against the box's `/object_info`, so a missing node class
or model is refused by name, and the adapter waits for an empty queue rather
than queueing behind someone else's job.

## The loop, for an agent

```sh
rig-parts inputs --source painting.png --config config.json --out inputs   # st_input_full.png
#    See-through on st_input_full.png (external, or `rig-parts comfy seethrough`) -> layers/full
rig-parts layers layers/full                      # every layer: box, opaque px, depth, plausibility figures; WARN lines
rig-parts propose --head-box --full layers/full --canvas 1664x2432
#    -> seethrough.head_box into config.json
rig-parts inputs --source painting.png --config config.json --out inputs   # now st_input_head.png too
#    See-through on st_input_head.png (external, or `rig-parts comfy seethrough`) -> layers/head
rig-parts sheet --source painting.png --layers layers/full --layers layers/head --out sheets/layers.png
rig-parts assemble --propose-plan --source painting.png --full layers/full --head layers/head --config config.json
#    -> assemble.plan and extend_below_crop
rig-parts assemble --source painting.png --full layers/full --head layers/head --config config.json --out work
#    -> work/rig: parts.json and parts/; the config holds no bones, meshes, regions or motion yet
#    -> read the `uncovered hole N:` lines and look at work/render/recomposite_error_rig.png:
#       red is painting that no part holds, and no later gate can see it
#    -> a large red hole neither run holds? add an assemble.patches entry (cut from the painting) and assemble again
rig-parts propose --parts work/rig --source painting.png --out work
#    -> proposal.json, basis.json (what each bone rests on) and render/landmarks.png; per-bone coverage lines;
#       correct it, copy bones/meshes/regions/motion into config.json
rig-parts propose --parts work/rig --source painting.png --out work --from-config config.json
#    -> LINT lines; exit 1 while any remain
rig-parts build --config config.json --source painting.png --full layers/full --head layers/head --out out --loop
#    -> read out/check/check.json; every FAIL line names what has to change
```

At each step the config holds only what that step reads; the one table of what
that is, step by step, is [docs/AUTHORING.md §4](docs/AUTHORING.md#4-the-command-order).
The selftest runs this block in order, command by command, on each fetched example,
from a config holding only what the first step reads (`RL01`). On `scarf` the
proposal pasted uncorrected stops at the last step, naming its `bottomwear` on
`CHECK_TIP_OVER_ROOT` — the one correction its tracked config records, a mesh mode
(issue #118, [its README](examples/scarf/README.md)).

`propose` is deliberately not a step of `build`: the proposal is a draft to correct
against its overlay, and a config with bones is `build`'s input. `rig`, `check` and
`loop` are the same stages one at a time. [docs/AUTHORING.md](docs/AUTHORING.md) is
the guide an agent authors from — every config field, what to look at after each
stage, what each refusal means and which field it points at — and
[`skills/rig-parts/SKILL.md`](skills/rig-parts/SKILL.md) is the same loop as an
agent skill.

## Commands

| command | does |
| --- | --- |
| `inputs --source <png> --config <json> --out <dir>` | the two images See-through is fed: the painting on a white square, and the head box's crop once the config has one |
| `comfy paint --config --out [--host]` | optional: generate the painting on a ComfyUI box from the config's `generation` block |
| `comfy seethrough --image --out [--host]` | optional: run the ComfyUI See-through wrapper on one image and write the form `layers` reads |
| `layers <dir \| layers.json \| file.psd>` | print every layer of a decomposition: draw order, name, tag group, box, size, opaque pixels, depth, and its translucent, background and area figures; a `WARN` line for a layer `--propose-plan` will leave out |
| `sheet --source <png> --layers <path>… --out <png>` | a labelled contact sheet of the painting and every layer or part |
| `assemble --propose-plan …` | propose `assemble.plan` and `extend_below_crop` from the two runs, leaving out an implausible layer with a note naming the rule |
| `assemble --source --full --head --config --out [--seam] [--project]` | merge the two runs into rig-space parts, `parts.json`, the recomposite and its error map, and list the uncovered holes |
| `propose --head-box --full <run> --canvas WxH` | propose `seethrough.head_box` from the full run, held inside the painting |
| `propose --parts --source --out [--compare <config>]` | propose bones, meshes, regions and an idle; draw the overlay; print, per bone, which check read it or that none did and why (its role, its kind of segment), and write `basis.json` beside the proposal — what each bone rests on (a joint, a part's mask, a ratio, other bones) and, with `--compare`, whether the config's bone differs |
| `propose … --keypoints <file> [--person <id>]` | read a posed figure's joints from one explicit file (space, image size, people, each joint observed, occluded or missing, its source): a joint with a position places the neck, hip, chest or a sleeve chain as given, a note says how every joint was used or which rule stood in, and LINT reads the torso and sleeves along the joints instead of by screen y ([AUTHORING §3](docs/AUTHORING.md)) |
| `propose … --from-config <config>` | draw and LINT the config's current bones (by the joints too, given `--keypoints`) |
| `compare --left <file> --right <file> [--map <bonemap.json>]` | compare two skeletons — a config, a proposal or a `rig.json` — bone by bone: origin, parent, tip, length and direction per pair, the bones neither side pairs, the required ones missing, and each side's roles read off the spec; no frame is guessed, and nothing pairs by resemblance (`propose --compare` reads origins only) |
| `rig --config --parts --out [--idle-keys ctl\|direct]` | author `rig.json` + `motion.json`, written only after rig-c's gate is green; each mesh is in the mode its config entry names — `grid` (the lattice, what `propose` writes), `contour` (the traced outline with declared interior points) or `auto` (the contour mesh at alpha 1 and above, reduced and locally refined by rig-c's `reduceMesh` under the author's declared bounds, written only when its motion against the unreduced source on the idle passes the author's `motion` bounds through rig-c's `compareMeshesInMotion`; [AUTHORING §3](docs/AUTHORING.md)); every chain link is turned along its chain and carries its `length`, so a physics constraint added later has a lever, with every offset under it in the turned frame so nothing moves; `--idle-keys` says whether the idle's keys on mesh-driving bones go through `<bone>_ctl` parents (default) or stay on the bones with `invariants.idleDrivesMeshes` declared; the config's `constraints` go to rigc as written, and a two-bone ik over keyed links needs `--idle-keys direct` (on `rig` or `build`) |
| `check --rig --out [--parts] [--source] [--requirements]` | build packed, gated under `spine-html`, render the idle, measure seam, loop and the six judgement lines (mesh texture stretch among them, from the idle's `render --geometry`), and report the recomposite's holes from `parts.json`; on a rig spec with no `parts.json` or no `idle` (a merged rig, issue #77) the gate still runs and every line that needs the missing input says SKIP by name; `--source <painting.png>` adds `SETUP_POSE_VS_SOURCE`, the setup pose against the painting by assemble's recomposite figures; `--requirements <scene.json>` measures what a scene declares of the motion — a contact, a follow fraction, an aim, a joint range, a mesh's stretch, the seam between two parts over the motion — each against the author's own bar, from rig-c's posed frames, one line each, PASS, FAIL or NOT MEASURABLE (AUTHORING §7, *Declared requirements*) |
| `loop --frames <dir> --out <file.gif \| file.png> [--palette]` | encode a rendered idle as a looping GIF, lossless APNG, or indexed APNG (`--palette`) |
| `build --config --source --full --head --out [--seam] [--project] [--loop] [--requirements] [--idle-keys ctl\|direct]` | assemble, rig and check in one process, stopping at the first refusal; `--requirements` is forwarded to check, `--idle-keys` to rig |
| `compose --scene <scene.json> --out [--requirements]` | bind several characters' green builds into one rig: every name prefixed `<id>:` under one shared root, each character's offset added at its first-level bones, an optional background plate (its provenance recorded, judged by nothing) drawn first, and the draw order between the characters' slots as the scene file declares it — nothing inferred, nothing scaled; gated through rig-c as `rig` is, then checked ([AUTHORING §7](docs/AUTHORING.md), *Composing several characters*) |

`rig-parts --help` has every flag. Exit codes: 0 done, 1 input refused (every
reason is a FAIL line), 2 a usage error or a command this version does not implement.

What 1.0.0 holds stable — these commands and their flags, the config
fields, the files a build writes and their spec ids, the environment, and what this
package relies on in rig-c — and what is not, is [docs/STABILITY.md](docs/STABILITY.md).
Coming from 0.16.0: [docs/MIGRATION.md](docs/MIGRATION.md).

## What it does not do

These are limits of the approach, stated so nobody reads more into a green run:

- **One depth value per layer.** See-through gives each layer a single depth, so a
  layer that is in front of another in one place and behind it in another is drawn
  right in the still (the painting's own pixels are projected onto it) and wrong once
  it moves.
- **No expression or lip-sync.** The mouth is one layer; there is no mouth-shape set
  and no expression axis.
- **Occluded pixels are See-through's synthesis**, not the artist's. How much of a rig
  that is, is below.
- **No success rate is claimed.** Ten characters have been measured stage by stage
  against the reference implementation this package ports — the two public examples
  here and eight private ones, one See-through seed each — and all ten check green
  on the gates, the seam and the loop. The judgement lines `check` added since
  (issue #11) have been measured on the three public examples only (the third,
  `scarf`, was made after the port and has no reference output). That is an
  existence proof, not a rate.
- **`loop` writes GIF and APNG (lossless and indexed), not WebP**: an animated WebP needs a VP8/VP8L
  encoder, which this package does not carry.
- **The proposer assumes a standing figure unless it is told the pose.** Its ratios
  put the hip below the chest and hang the sleeves from the shoulders. A seated or
  reclining figure needs `propose --keypoints`, a file of its joints from any pose
  estimator or a hand; this package does not estimate a pose itself, and its
  keypoint support has been measured on generated figures and on files read off the
  examples' own configs, never on an estimator's output.
- **The proposer reads tags, not pictures.** A swinging element painted inside another
  layer (a sash tail in the skirt), hair that is none of the shapes it knows, and
  whether an accessory swings are the corrector's to add. The one accessory shape it
  measures is a hanging strand on a headwear or earwear layer: each gets a pendulum
  chain, and a strand it cannot chain is named in a note rather than left stiff.

### How much of a rig the model painted

`parts.json` splits each part's opaque pixels (`opaque_px`) into `visible_px` — no
later layer of its See-through run is opaque in front of them — and `occluded_px`,
and counts the visible ones whose colour was not taken from the painting
(`visible_not_projected_px`). On the three public examples, from the totals of their
`expected/parts.json` (the default `--project core`; `scarf`'s painting patches are
whole painting pixels, so they count as taken):

| | opaque px | occluded | visible, not projected | taken from the painting |
| --- | --- | --- | --- | --- |
| `sample` | 298,363 | 79,122 (26.5 %) | 35,979 (12.1 %) | 183,262 (61.4 %) |
| `demo` | 765,924 | 202,343 (26.4 %) | 75,626 (9.9 %) | 487,955 (63.7 %) |
| `scarf` | 283,813 | 78,503 (27.7 %) | 56,699 (20.0 %) | 148,611 (52.4 %) |

The occluded share is art the painting does not show — a back-hair layer, a neck, the
parts of an ear under the hair — and is See-through's synthesis by necessity; it is
what the decomposition is for. The visible-but-not-projected share is synthesis where
the painting was there to be taken: a part too thin for the reference rule's 5x5
eroded core, an anti-aliased fringe below alpha 250, a rim beside a layer in front, a
pixel refused for drift. `--project visible` keeps the erosion only along a rim with a
layer in front, which takes that share to 22,476 (7.5 %) on `sample` and 49,672 (6.5 %)
on `demo` (from the `parts.json` of a `--project visible` build). On the eleven thin
head parts — brows, lashes, irises, eye whites, ears, mouth — it takes 296 of
`sample`'s 1,289 visible pixels where `core` takes 110, and 824 of `demo`'s 2,162
where `core` takes 343. What neither rule takes is the fringe: a per-pixel
classification of those parts under `visible`, recorded with the change that added
the flag, puts 813 of `sample`'s 993 still-unprojected pixels and 879 of `demo`'s
1,338 below alpha 250. Where such a fringe keeps the stack off the painting and a part
beneath holds the pixel in the painting's colour, `assemble` clears it instead, and
the assemble line and `parts.json` say how many pixels, of which part, over which
(AUTHORING §5, *The fringe push-back*; the figures in this section were measured
before it, at v0.14.0).

## Requirements

[Bun](https://bun.sh) 1.2 or later. `npm install -g rig-parts` installs the
`rig-parts` command; it hands off to Bun and says so in one sentence if Bun is not
on `PATH`. **`rig-parts` is the package's name; versions up to 0.16.0 were published
as `spine-parts`, its former name**, and the install keeps a `spine-parts` command
beside `rig-parts` for the transition, the same launcher under both names. On npm
the alias `spine-parts` stays published beside `rig-parts` at every version,
carrying the same files with only the `name` in `package.json` changed, so a
project that depends on the former name keeps receiving every release; a new
install names `rig-parts` ([RELEASING.md](RELEASING.md), *The registry side*). rig-c
comes with it as a dependency. No Spine runtime does: since
rig-c 2.0 the installed `rigc` gates every build with its own validator over the
compiled model document, and `rigc --version` says `entry: cli_core.ts —
@esotericsoftware/spine-core absent`. With `@esotericsoftware/spine-core` installed
beside it, the same `rigc` runs the spine-core round trip instead, as this repository's
selftest and CI do; `check.json`'s `rigc_entry` records which one gated a build.

## Licence posture

rig-parts is MIT, and it depends on rig-c, whose output is Spine skeleton data:
using what it produces in a product requires a Spine Editor licence, as any Spine data
does. Neither package installs Esoteric Software's `spine-core` any more; this
repository uses it in development, for the round trip in its selftest and CI. [NOTICE.md](NOTICE.md) records that chain and every other
third-party term this package touches, See-through's included.

## Development

```sh
bun install
bun run typecheck        # tsc --noEmit, strict
bun run lint             # one rule: no explicit any
bun run fetch-examples   # the public examples' paintings and layers, into examples/*/inputs (needs a network)
bun run selftest         # every gate's controls; with the examples fetched, build on each of them against its expected/
bun run smoke            # pack, install into an empty directory, run from the install (needs a network)
```

[CLAUDE.md](CLAUDE.md) is the doctrine, [CONTRIBUTING.md](CONTRIBUTING.md) the
practice, [RELEASING.md](RELEASING.md) the cut, [docs/STABILITY.md](docs/STABILITY.md)
the interface it holds.

## Licence

MIT — see [LICENSE](LICENSE). Third-party terms: [NOTICE.md](NOTICE.md).

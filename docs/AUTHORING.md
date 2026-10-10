# Authoring a character with rig-parts

This is the guide an agent authors from. It assumes you cannot see the painting,
the layers or the rig: what you have is this page, the tool's printed lines, and
the files it writes. Every refusal the tool prints names a rule, an object, the
value found and the value required — §6 maps each rule to the field or input that
has to change.

The worked example throughout is [`examples/sample`](../examples/sample): its
`config.json` is a complete, loading config, `proposal.json` is what the proposer
wrote for it, and `expected/` is what the reference implementation produced from
the same inputs — except `check.json`, which this port's `build` regenerates since
the reference has no judgement lines (§7). `bun run fetch-examples` puts its painting and See-through layers
into `examples/sample/inputs/`.

## 1. Prerequisites

| what | why | how |
| --- | --- | --- |
| [Bun](https://bun.sh) 1.2 or later | rig-parts and rig-c are Bun programs | `npm install -g rig-parts` installs the command; it says so if Bun is missing |
| [rig-c](https://www.npmjs.com/package/rig-c) | compiles, gates, packs and renders every rig; rig-parts writes no Spine data itself | installed with rig-parts as a dependency (`node_modules/.bin/rigc`); with no Spine runtime beside it, it gates with its own validator, and `rigc --version` says `entry: cli_core.ts` |
| [See-through](https://github.com/shitagaki-lab/see-through), somewhere | the layer decomposition is the input | any route in README *Getting See-through layers*; it runs twice per character, outside this tool |
| a GPU, wherever See-through runs | See-through is a diffusion model | nothing in rig-parts itself uses a GPU |

The painting is yours to bring: a PNG of one character, front-facing, full body,
taller than wide, on a plain light background. How it was made is not read by any
stage (`config.generation` is recorded for the optional adapter only).

## 2. The folder

Nothing in rig-parts requires a layout; every command takes paths. The one the
examples use, and the one this guide assumes:

```
<key>/
  config.json               the character config (§3)
  inputs/painting.png       the painting
  inputs/st_input_full.png  what See-through's full run was fed: the painting, white-padded to a square
  inputs/st_input_head.png  what its head run was fed: the square crop at seethrough.head_box
  inputs/layers/full/       the full run (wrapper form: layers.json + parts/<tag>.png), or full.psd
  inputs/layers/head/       the head run, the same
  proposal.json             what `propose` wrote (§4, step 7)
  basis.json                what each proposed bone rests on, written beside proposal.json (§4, step 7)
  keypoints.json            optional: where the figure's joints are, for `propose --keypoints` (§3, *A posed figure*)
  out/                      what `build` writes (§5)
```

## 3. `config.json`, field by field

`src/config.ts` is the schema and the loader. Every key is known or refused
(`CONFIG_KEY_KNOWN`); a required key that is missing is `CONFIG_FIELD_PRESENT`.
There are two open doors, and nothing reads what stands behind either. An
annotation: `note`, and any key ending in `_note`, may hold a string anywhere an
object is — write a hand correction's reason there, beside the value it corrected
(the examples do). A record: any key beginning `x-` with a name after it may hold
any JSON value in the same places — a project's own provenance, such as the gate
results of a past build (`"x-status": {…}`) or the seeds a search rejected, with
reasons (`generation.x-seeds_tried`). The record test comes first, so
`x-seed_note` is a record. `xstatus`, `x_status`, `X-status` and a bare `x-` are
not record names and are refused like any unknown key. The doors are not open in
`meshes`, `regions` or `motion.blink.still`: their keys are part names, and an
`x-` key there is a part like any other. Every refusal of an unknown key, of a
retired one and of an annotation that is not a string says where a record goes.

**Coordinates** in `bones`, `meshes` and `motion` are **rig pixels, y down, origin
top-left** — the parts' own space, which is the painting times `assemble.rig_scale`.
`root` is added by the rig stage at the bottom centre of the rig canvas; never
declare it.

"Where it comes from" is one of: **proposed** (a command prints or writes a value
you copy and check), **authored** (you decide it), **recorded** (a fact about a run,
read by no CPU stage).

| field | read by | where it comes from |
| --- | --- | --- |
| `key` | every stage's report | authored; the examples use the directory name |
| `generation.*` | the optional `comfy` adapter only; no CPU stage | recorded: checkpoint, LoRAs, sampler, prompt parts, `latent`, `seed`, `control` |
| `seethrough.resolution` | assemble — each run's canvas must be `resolution` square (`ASSEMBLE_RUN_CANVAS`) | recorded from the See-through runs; 1024 in both examples |
| `seethrough.steps`, `.seed`, `.offload` | no CPU stage | recorded from the runs |
| `seethrough.head_box` | inputs (cuts the head image there; optional at the first call); assemble — where the head run sits on the painting | **proposed** by `propose --head-box` from the full run, square, source pixels, shifted inside the painting when needed; the head run must then be fed exactly that crop |
| `assemble.rig_scale` | assemble | authored; rig pixels per source pixel. 0.5 in both examples (a 1664x2432 painting makes an 832x1216 rig) |
| `assemble.plan` | assemble; also the list every `meshes`/`regions` key must come from | **proposed** by `assemble --propose-plan`. `[part name, "full" \| "head", See-through tag]`, in draw order back to front. Names are free; roles come from the tag |
| `assemble.extend_below_crop` | assemble | **proposed** with the plan: `{part, run, tag}` — a head-run part that reaches the bottom of the head crop is continued from a full-run layer, whole connected components |
| `assemble.patches` | assemble; `meshes`/`regions` keys may name them too | **authored**, optional: `[{name, box, alpha, draw}]` — an extra part cut from the **painting** itself, for figure no See-through layer holds (a hem both runs dropped). `box` is `[x0, y0, x1, y1]` in **rig** pixels, `x1`/`y1` exclusive — the space of `parts.json` and `recomposite_rig.png`, where the hole is found; `alpha` is `"silhouette"` (the painting's figure silhouette inside the box, the one `--seam silhouette` uses) or `"box"` (the whole box); `draw` is `"back"`, `"front"` or `{"before": "<plan part>"}`. A patch is always a region: its bone is `regions.<name>`, in the one place every region's bone lives, and a `meshes` entry for it is refused. See §5 for how to place one |
| `assemble.cuts` | assemble; `meshes`/`regions` keys may name the new parts too, and must (each is a part like any other) | **authored**, optional (issue #170): `[{from, into, polygon, draw, overlap}]` — a plan part's layer cut by a polygon the author draws: the pixels of plan part `from` whose **centre** lies inside `polygon` (even-odd; a centre exactly on an edge is outside) leave `from` and make the new part `into`, colour and alpha, so every pixel of the layer ends in exactly one of the two. `polygon` is `[[x, y], …]`, at least three points, non-negative integer **rig** pixels — the space of `parts.json` and of the patches' boxes. The file that shows the layer in those coordinates is `assemble`'s own `rig/parts/<from>.png`, placed at its `parts.json` `x`, `y` (the PNG's pixel `(i, j)` is rig pixel `(x + i, y + j)`), or `render/recomposite_rig.png`, the whole rig 1:1; the contact sheets (`sheet`) are scaled and carry no coordinates. `draw` is `"back"`, `"front"` or `{"before": "<plan part>"}`, as for a patch (to keep the setup pose, put it beside `from`: `{"before": "<from>"}`, or before the plan part after it). `from` must be a plan part (`CONFIG_NAME_RESOLVES`; a patch or another cut's piece is refused), `into` a new name (`CONFIG_PART_UNIQUE`), the polygon three or more integer points (`CONFIG_FIELD_TYPE`). The piece's `parts.json` record carries `from`'s `<run>:<tag>` and its own counts, each split from the layer's by where the pixel lies; it is a mesh or a region under its own name, and the coverage rule holds it like a plan part. What the config cannot know the stage refuses: a polygon point past the rig (`ASSEMBLE_CUT_INSIDE`), two cuts of one part sharing a pixel (`ASSEMBLE_CUT_OVERLAP`), a cut that takes none of the layer's opaque pixels or leaves `from` none (`ASSEMBLE_CUT_PIXELS`). `overlap` is required, a non-negative integer of rig pixels with no default (`CONFIG_FIELD_TYPE`): the **band** — the polygon's pixels within `overlap` px of its edge by Chebyshev distance (the polygon's mask less its erosion by a `2 * overlap + 1` square) — stays in `from` as well as going to the piece, so the piece's resampled edge has art under it; the counts stay a strict partition and the band is the base's extra copy, printed on the `cut:` line. At `0` the two abut and `check`'s seam bar judges the edge between them (`CHECK_SEAM_WITHIN_BAR`, §5). A band only covers the edge at rest: a piece that swings well clear of where it was painted shows the hole it leaves, and a thin piece's band shows a ghost of the piece — an authored fill for what lies under a piece is issue #193 |
| `bones` | rig; `propose --from-config` | **proposed** by `propose`, then corrected. A single bone `{name, parent, at, tip?}` or a chain `{chain, parent, points, tip}` whose links are named `<chain>0 … <chain>n`. Parents come before children. In `rig.json` each link is **turned along its chain** — `rotation` is the direction from its origin to the next link's (the last link's to `tip`) and `length` that distance (issue #73), so a physics constraint added downstream finds a lever; under `--idle-keys ctl` the link's `<link>_ctl` carries the turn and the length and the link sits at local rotation 0 beneath it. A single bone is never turned; one whose parent is a link is turned back upright |
| `meshes.<part>` | rig | **proposed**, then corrected. Exactly one of `grid` (the lattice: cell size, px — what `propose` writes), `contour` (the outline mode, authored; the next row and "A contour mesh" below) or `auto` (the automatic mode, authored; "An automatic mesh" below) — two, or none, is `CONFIG_MESH_MODE`. In every mode: `r` (added to every distance before weighting: `w = 1/(d + r)²`), `segments` (a chain name, a bone name with a `tip`, or `[bone, [x0,y0], [x1,y1]]`), and, **authored**, optional, `exponent` (issue #161): a number above 0 that replaces the 2 in that rule, `w = 1/(d + r)^exponent` — a larger one hands each vertex more fully to its nearest bone; absent is 2 and changes no byte, a value that is not a number above 0 is `CONFIG_FIELD_TYPE` at `meshes.<part>.exponent`, and a declared one is echoed as `exponent` in the mesh's `mesh_report.json` row; the exponent is the distance rule's, so declared beside `rule: "heat"` it is refused (`CONFIG_FIELD_TYPE` at `meshes.<part>.exponent`). The segment list is the one authored decision about a layer: which bones may pull it. The slot's bone is the first segment's. Optional `rule` (issue #161): `"distance"` — the rule above, and what an absent `rule` means (every byte is the same) — or `"heat"`, bone heat over the part's own silhouette, in every mode: the lattice's art (alpha above 8) with holes filled, or for `contour` and `auto` the silhouette their outline is traced from (that mode's art — alpha above 8 for `contour`, alpha 1 and above for `auto` — less any island a declared `stray` left out, holes filled, grown by its `margin`); each bound bone's sources are the silhouette pixels whose centre lies within 0.75 px of its segment (a pixel two bones reach goes to the nearer, a tie to the first listed), held at 1 for that bone and 0 for the others; the field is solved by row-major Gauss–Seidel over-relaxation to a sweep change under 1e-7 within 20000 sweeps; a vertex reads the nearest silhouette pixel and takes the same cap and floor (and `regions`) as the distance rule; `r` is not read. The mesh's `mesh_report.json` row gains `heat` (the constants, each bone's sources and sweeps, the residual). Any other value is `CONFIG_FIELD_TYPE`; a bound bone with no source pixel is `RIG_HEAT_BONE_SOURCE`, an island no bone has a source in `RIG_HEAT_ISLAND_SOURCE`, a solve past its sweep bound `RIG_HEAT_CONVERGED` — none is weighted 0 |
| `meshes.<part>.contour` | rig | **authored**, optional (issue #84): `{tolerance, margin, spacing, budget?, stray?, regions?}`. `tolerance` — rig-c's Douglas–Peucker tolerance on the traced outline, px, 0 or more; `margin` — how far the silhouette grows before it is traced, px: 0, or 1 or more (a pixel joins when its centre lies within `margin` of an art pixel's centre; a value above 0 and below 1 adds nothing and is refused, `CONFIG_FIELD_TYPE`); `spacing` — the background interior spacing, px, above 0; `budget` — the most vertices the mesh may have (refused above it, nothing thinned); `stray` — the largest island, in art pixels, that may be left out of the mesh (absent: none is); `regions` — local deformation regions, each `{name, shape, bone, spacing, band}` with `shape` `"circle"` (`cx, cy, r`) or `"polygon"` (`points`, 3 or more): `bone` is the region's control bone (any bone `bones` declares), `spacing` the interior spacing inside the region and its band, `band` the width the bone's weight falls across. Every length and position is **rig px**, like every other in the config; the part image is the rig less `(x − 4, y − 4)` (its box less the pad), a translation, so a length is the same number in both. A region's `cx`, `cy`, `r`, `band` and `points` are multiples of 1/256 px (`CONFIG_FIELD_TYPE` otherwise); region names are unique per mesh (`CONFIG_REGION_NAME_UNIQUE`). The alpha threshold is not a field: art is alpha above 8, the lattice's and `check`'s |
| `meshes.<part>.ribs` | rig | **authored**, optional (issue #188), in the `contour` and `auto` modes: `{<chain>: {stations}, …}`, each key a chain this mesh's `segments` name. Each link of the chain gets a row of vertices across the part at its origin and at `stations` points evenly between its origin and its end (`stations`, a whole number, 0 or more, required; a chain of L links carries L × (stations + 1) ribs) — so a strand can fold where its chain bends; the rule is "Ribs along a chain" under "A contour mesh". Absent places none and changes no byte. Refused: a lattice mesh with ribs (`CONFIG_RIBS_MODE` — its vertices are its grid's corners), a key that is not one of the mesh's chains (`CONFIG_NAME_RESOLVES`), an object naming no chain or a `stations` that is not a whole number from 0 (`CONFIG_FIELD_TYPE`); at the rig stage `CONTOUR_RIB_ART`, `CONTOUR_RIB_LINK`, `CONTOUR_RIB_CROSSING`, `CONTOUR_RIB_EDGE` (the contour refusals). The mesh's `mesh_report.json` row gains `ribs` — the declaration, the ribs placed and the vertices they hold — and its contour report (the source's, in `auto`) lists each rib's vertices |
| `regions.<part>` | rig | **proposed**: the bone a rigid part rides. Every plan part is exactly one of a mesh or a region (`CONFIG_PART_ATTACHED`) |
| `motion.duration` | rig; check (the loop is measured at this time) | proposed as 4 s; a whole number of 1/12 s ticks, because `check` renders at 12 fps |
| `motion.tracks` | rig | **proposed**, then tuned. Single `{bone, prop, amp, period, phase, base?}` or chain `{chain, amps, period, phase, lag}` — one amplitude per link, link `i` at phase `phase + lag·i`. Every `period` must divide `duration` (`CONFIG_PERIOD_DIVIDES_DURATION`). A bone property is keyed by one track (`CONFIG_BONE_PROPERTY_KEYED_ONCE`): a chain keys `rotate` on every link, the blink's `eyes` group `scaley` and its `brows` group `translatey` on every member, so a single track on any of those is a second track on it — rigc would refuse it one stage later, `animation "idle" has two tracks on eye.scaley`. A chain link is turned along its chain (the `bones` row), so a `translatex`/`translatey` key on a bone whose parent is a turned link, or a `scale`/`shear` key on a turned link, would move or stretch along the link and not along the picture's axis: the rig stage refuses it (`RIG_KEY_FRAME_UNTURNED`); `rotate` is keyed on any bone |
| `motion.blink` | rig | **proposed**: `{t, eyes, brows, squash, brow_drop}`; the whole blink, `t` to `t + 0.364` s (`t + 0.314` s without brows: the brows' keys are the ones that end last), must fit inside the idle (`RIG_BLINK_INSIDE_IDLE`). The `eyes` group's `scaley` squashes every part on the eye bones about the bone's origin, the eyewhite's centre. Optional: a figure with no `eyewhite-r`/`-l` part has no eye bone, so `propose` writes no `blink` and notes `no blink: no eyewhite part (looked for: eyewhite-r, eyewhite-l), …`; with eyes and no `eyebrow-r`/`-l` part it writes the blink without `brows` and `brow_drop` and notes `blink without brows: …`. `brows` and `brow_drop` are stated together or not at all (`CONFIG_BLINK_BROWS_PAIRED`), and a group that names no bone is refused (`CONFIG_BLINK_GROUP_MEMBERS`) — rigc would refuse it one stage later, `group "eyes" declares no members` — as is a group that names one bone twice (`CONFIG_BLINK_GROUP_UNIQUE`; rigc: `group "eyes" names member "eye" twice`). An `irides-*` or `eyelash-*` part on a side with no eyewhite has no eye bone to ride: `propose` places it on `head` as a region, which the blink does not move, and notes `no eyewhite part for eye_r (looked for: eyewhite-r): iris (head:irides-r) is placed on head as a region, …`. The timing is fixed, not a field (table below) |
| `motion.blink.still` | rig | **proposed** only for a lash `propose` notes (below), then checked: `{<part>: {row, bone}}` — the rows of that region part above `row` (rig px, y down) are drawn by a second slot `<part>_still` on `bone` and do not blink; rows from `row` down keep the part's slot and blink. The part must be a region on a bone `eyes` names, `bone` one it does not (`CONFIG_STILL_OFF_THE_BLINK`), and `row` a row of the part with no art across its whole width (`RIG_STILL_ROW_CLEAR`) |
| `motion.animations_from` | rig; check (named, not measured) | optional, never proposed (issue #183): a path, relative to the config file's directory, to a file in rig-c's motion-spec shape, `{"spec": "rigc-motion/1", "animations": {"<name>": {"duration": …, "tracks": [...]}, …}}` — an expression, a gesture, anything beside the idle. On every `rig` and `build` each of its animations is written into `rig/motion.json` after `idle`, as read: nothing added, re-keyed or judged here, and each is rigc's to accept or refuse at the rig stage's gate, in rigc's words. It may name what `motion.json` already holds — the bones `bones` declares, the easings `shut` and `open`, the groups `eyes` and `brows` when the blink writes them — and nothing else from the file reaches it. The loader refuses, every problem at once: no such file or one that cannot be read (`CONFIG_FILE_PRESENT`), text that is not JSON (`CONFIG_IS_JSON`), a file that is not an object, a `spec` other than `"rigc-motion/1"`, an `animations` that is not a table of objects (`CONFIG_FIELD_TYPE`), any other key — rig-c's `easings`, `groups`, `setup`, `physics`, `mix`, `archetype` and `cut` included, which would be read and not written (`CONFIG_KEY_KNOWN`), an animation named `idle` (`CONFIG_ANIMATION_NAME_FREE`), and a key written twice in one object of the file, which JSON would fold into its last value without a word (`CONFIG_KEY_UNIQUE`). `check` measures the idle alone and prints one line naming the others (`beside the idle: …`). Absent, `motion.json` holds the idle alone, byte for byte as before |
| `constraints` | rig (handed to rig-c as `rig.json`'s `constraints`); `compare` and the coverage lines (roles) | **authored**, optional; `propose` writes none. A list of constraints in **rig-c's own rig-spec shape** (`RigConstraint`: `ik`, `transform`, `path`, `physics`, `slider` — rig-c's `src/rig.ts` documents every field), in the order rigc applies them. The loader checks only what this package owns: each entry is an object with a `type` rigc names (`CONFIG_CONSTRAINT_TYPE_KNOWN`) and a non-empty `name`, unique within its kind as rigc finds constraints (`CONFIG_CONSTRAINT_NAME_UNIQUE`; an ik and a transform may share one); every bone it names — `bones`, an ik's `target`, a transform's `source`, a physics or slider constraint's `bone` — is a bone `bones` declares, a chain link as `<chain><i>` (`CONFIG_NAME_RESOLVES`); the bone a constraint follows does not sit under a bone it drives (`CONFIG_CONSTRAINT_TARGET_DETACHED`). Every other field (`mix`, `softness`, `properties`, a path's `slot`, a slider's `animation`) and every value is rigc's to accept or refuse at the rig stage's gate, in rigc's words (`RIG_RIGC_GREEN`) — an ik's `bones` as a shape too: from rig-c 2.15.0 rigc refuses an ik over more than two bones, or over a pair whose second bone is not the first's child (issue #103; this loader refused both itself until then). A note and an `x-` record may ride on an entry; the rig stage leaves them out of what it hands rigc. Under the default `--idle-keys ctl` a two-bone ik whose child link the idle keys is split by that link's control, and rigc refuses the pair: run `rig --idle-keys direct` or `build --idle-keys direct` (the rig stage adds that sentence, naming the flag on the command that ran, to rigc's line; `build` forwards it to its rig stage, issue #95). Each bone a constraint follows is declared to rigc as `invariants.detached` from every bone it drives, which rigc's gate rule `A25` checks |

**A scene target is an ordinary bone.** A target the scene places — a point a hand
reaches for, a face something turns toward — is a single bone parented to `root`,
`{"name": "tgt", "parent": "root", "at": [x, y]}`, that a constraint names as its
`target` (an ik) or `source` (a transform). There is no other bone kind: it binds no
art, nothing in the idle keys it, and `compare` and the coverage lines call it a
`target`. Its `at` is where it rests; the scene moves it later. The rig stage declares
it detached from the bones its constraint drives (`invariants.detached`), so rigc's
gate refuses the built rig if it is ever re-parented under them. What `--idle-keys`
does to a constraint, measured through rig-c 2.10.1 on the selftest's rig
fixture (a two-link chain whose links the idle keys and a mesh is weighted to, its
4 s idle rendered at 12 fps), the first row again through 2.15.0 (issue #103); the
selftest's `RG56`–`RG58` hold every row on the installed rigc:

| constraint on the chain | `--idle-keys ctl` | `--idle-keys direct` |
| --- | --- | --- |
| ik over both links, target under `root` | refused by rigc (from 2.15.0; `RIG_RIGC_GREEN`): `<link1>_ctl` stands between the links, so the pair is not a parent and its child — at 2.10.1 it gated green and the tip missed the target by 2.58 rig px in every frame. rigc's sentence ends with a remedy a config cannot follow (it names the control); the rig stage adds one naming `--idle-keys direct` on the command that ran | gates green; tip on the target in every frame (largest gap 1.7e-7) |
| ik over one link (an aim) | gates green | gates green; the same per-frame tip distances as `ctl` (0.67 to 0.90 rig px; an aim is not a reach) |
| physics on a link (`rotate`) | gates green | gates green; the link's world rotation within 1.7e-9 degrees of `ctl`'s in every frame |
| transform on a link (`rotate` from the target) | gates green; the link's world rotation is the target's | the same |

The blink's timing is the tree's (`BLINK` in `src/motion.ts`), in seconds after
`motion.blink.t`:

| phase | eyes (`scaley` 1 → `squash` → 1) | brows (`translatey` 0 → `-brow_drop` → 0) | easing |
| --- | --- | --- | --- |
| shut | 0.07 | 0.08 | `shut` |
| hold | **0.084** (the reference: 0.04) | **0.084** (the reference: 0.04) | none |
| open | 0.16 | 0.20 | `open` |

The holds are the one departure from the reference implementation, and the reason is
the loop (issue #32). `check` renders the idle at 12 fps, a frame every 0.083333 s, and
the loop is encoded from those frames. A 0.04 s hold is shorter than a frame, so it
held a frame only for some `t`: at the examples' 2.3 s the eyes were shut from 2.37 s to
2.41 s, between frames 28 (2.333 s, `scaley` 0.8356) and 29 (2.417 s, 0.2435), and over
every key time the 6-decimal grid can write, 129,999 of the 250,000 phases against the
frame grid showed no closed frame. A closed window at least one frame long holds a frame
wherever it starts, so the hold is 1/12 s rounded up to the third place; the brows' hold
grew by the same 0.044 s, so they still reach their drop 0.01 s after the lids shut and
leave it 0.01 s after the lids open. The rig stage refuses a hold under one frame by
name (`RIG_BLINK_HOLD_SPANS_A_FRAME`, §6), counted over the same 250,000 phases.

The proposer's reach (from `src/propose.ts`): roles come from each part's tag —
`face` makes `hip`/`chest`/`neck`/`head`, the eyewhites make the eye bones (irides and
lashes ride them, or `head` on a side with no eyewhite), brows are
told apart by position, `bottomwear` makes the hip and three skirt chains,
`handwear` makes sleeve chains (one blob or two), `front hair` makes fringe chains
and a lock chain for each strand that hangs below the chin, `back hair` makes a bun
bone or two hanging chains, and `headwear`/`earwear` get a rigid bone and a pendant
chain — or, when the accessory has hanging strands, one pendulum chain per strand
(below). What it cannot know — something painted inside another layer that should
swing, hair of another shape, whether an accessory swings — is yours to add, and
`notes` in `proposal.json` says where it guessed.

**A posed figure: `propose --keypoints`.** The proposer's ratios assume a
standing figure: the hip below the chest, sleeves hanging from the shoulders. A
seated, reclining or otherwise posed figure is told where its joints are with one
explicit file (issue #75, `src/keypoints.ts`):

```json
{
  "spec": "spine-parts-keypoints/1",
  "space": { "units": "painting-px", "origin": "top-left", "y": "down" },
  "width": 1664, "height": 2432,
  "source": "what produced this file (recorded, never interpreted)",
  "people": [
    { "id": "a", "joints": {
        "neck":    { "state": "observed", "at": [826, 464] },
        "l_elbow": { "state": "occluded", "at": [1030, 926], "score": 0.4 },
        "r_ear":   { "state": "missing" } } }
  ]
}
```

The space is stated and any other is refused (`KEYPOINTS_SPACE_STATED`); `width`
and `height` are the painting's and are held to `--source` (`KEYPOINTS_IMAGE_SIZE`).
Joint names are the body-18 names of `src/skeleton.ts` (`nose`, `neck`,
`r_shoulder` … `l_ear`), and `r` / `l` are the **subject's** sides. Each joint is
`observed` (with `at`), `occluded` (`at` optional — when given it is the producer's
estimate and said as that) or `missing` (no `at`); a joint the file does not list is
missing. A `score` is the producer's and is printed beside the joint; nothing here
computes one. With more than one person, `--person <id>` names one; nothing picks.
Painting px reach rig px by the overlay's own map, `x * W/width`, `y * H/height`
(0.5 for both examples).

What a joint with a position places, as given — no ratio is applied over it:

| bone | from | when the joint has no position |
| --- | --- | --- |
| `neck` | `neck` | the rule: half way from the chin to the neck part's bottom (or 0.12 face heights below the chin), on the eye axis |
| `hip` | the midpoint of `r_hip` and `l_hip` — a point between two joints, said as that | the hip rule (bottomwear top, the waist, or 0.32 of the figure); one hip alone is said to be unused |
| `chest` | its rule, half way from neck to hip, taken along the line between the placed ends | the rule as before when neither end is a joint |
| `sleeve_<s>` | `<s>_shoulder` → `<s>_elbow` (two links), tip at `<s>_wrist`, with the two-blob rule's first two amplitudes and its chest stub laid along the upper arm — when every handwear part over 500 px holds one such wrist within 15 px of its art | the sleeve rule places every sleeve chain, and each arm joint's note says why |
| `eye_<s>`, `head`, the face box | not moved: they are measured off the parts | the note prints the eye joint's distance from the eye bone, with no bar |

Every other joint (`nose`, knees, ankles, ears; the eyes with no eyewhite) is named
with its state in one note: no bone is authored from it. Every joint the proposer
could use gets its own note — `used as given for bone X`, `used as the producer's
estimate for bone X`, or `missing: the rule "…" placed bone X instead` — after every
note the rules wrote. LINT then reads the torso by the relations the joints declare:
where `neck`, `r_hip` and `l_hip` all have a position, along the line from the neck
to the hips' midpoint the chest must fall strictly between them, the hip past the
chest, and the hip nearer the hips than the neck — these replace the two screen-y
torso lines; and each `sleeve_<s>` chain's links and tip must advance from
`<s>_shoulder` toward `<s>_wrist`. The first lines say which rule set ran and on what
basis (`lint rule set: joints …` or `lint rule set: screen — …`). The off-art check is
unchanged, and `--from-config … --keypoints` lints a corrected config the same way.
Without `--keypoints` nothing changes, byte for byte. Two rules still read the screen
under keypoints and are not this file's to change: the skirt chains hang down from
the hip, and a part no rule claims rides the trunk bone its centre is nearest by y.

**A figure with no `face` part** (turned away, or half hidden behind a partner,
so See-through found hair and a neck and no face) still gets a proposal. The face
box every rule scales by is derived from the head run's hair (`front hair`,
`back hair`: their highest top) and its `neck` (its top, and its centre x for the
axis): with `L` the span from the hair's top to the neck's top, the face is
1.067 `L` tall, its top 0.131 `L` below the hair's, its width 0.798 of its height.
Those ratios are the means of the two public examples (`demo` 1.073 / 0.105 /
0.820, `sample` 1.061 / 0.158 / 0.777) — a sample of two. On each example
re-assembled without its face, the derived box put `head` and `neck` within
5.0 px (0.038 face heights) of the with-face proposal's, `chest` and `hip` at
the same pixel. The first note says so —
`no face part: face box derived from the head run's hair (…; top y=…) and neck (…), a span of … px — … (ratios measured on the two public examples); …`
— and names each face-reading rule left with nothing to read (eye bones and blink,
brows, mouth). Correct `head` and `neck` against the overlay. With no head-run
hair or neck there is nothing to derive from, and `PROPOSE_FACE_PRESENT` still
refuses (§6).

Two rules read the figure rather than one tag, and each says so in a note:

- **The hip.** It sits 0.14 face heights below `bottomwear`'s top edge — unless
  that is above 0.25 of the figure's height (every part's union, top row to bottom
  row), which is a long robe tagged `bottomwear` that starts at the collar. Then
  the note `hip: <part> (<from>) starts at y=…, so its top + 0.14 face heights
  (y=…) is above 0.25 of the figure height (y=…, figure y …): its top edge is not
  the waist` is followed by one of `hip from the waist: silhouette narrowest at
  y=170 (width 51 px, shoulders 80 px at y=96), hip 0.14 face heights below it` —
  the torso layers (`neck`, `neckwear`, `topwear`, `bottomwear`, `legwear`,
  `footwear`) at their narrowest between the shoulder line (their widest row
  within one face height below the neck) and the figure's middle, and at most
  0.8 of the shoulders — or `hip from 0.32 of figure height (no waist found: …)`,
  naming why. Without `bottomwear` the hip is 0.32 of the figure height, as before
  (`no bottomwear: hip from 0.32 of figure height`). Neither published example
  meets either branch: their hips sit at 0.436 (`demo`) and 0.342 (`sample`) of
  their figures.
- **Clasped hands.** When every `handwear` part together is one blob (over
  500 px) at most half the shoulders' width and centred within a quarter of it
  of the eye axis, it is the hands clasped in front, not two sleeves: it rides
  `hip` as a region, no sleeve chain is made, and the note reads `handwear is one
  blob (<parts>) WxH px centred at x=…: at most 0.5 of the shoulder width (… px
  at y=…) and within 0.25 of it of the eye axis x=…, so clasped hands: a region on
  hip, no sleeve chains`. Two sleeves hanging from the shoulders are at least as
  wide as them: the examples' one-blob sleeves are 1.51 and 1.58 shoulder widths,
  and keep their two chains.

**Hanging strands** (tassels, cords, drop earrings) on a `headwear` or `earwear`
layer — the two tags the proposer has an accessory rule for; any other tag rides a
trunk bone as a region and says so in its own note. A strand is an 8-connected
sub-shape of the layer's **pendant rows** (the run of rows at the bottom narrower
than 35 % of its widest row; the whole layer for `earwear` or a layer that is over
80 % pendant) that is at least **3×** as tall as wide, at least **0.2** of the
layer's height and at least **10** rows. On the public examples nothing is one: the
demo's hairpin pendant sub-shapes measure 0.54 and 0.89 tall-per-wide and its
earrings 1.04 and 1.08, so both proposals are unchanged. Every layer with strands
gets exactly one note carrying each strand's column centroid, first–last row and
width, and what became of it (two of the selftest's fixtures, PR12 and PR15):

    crown (head:headwear): 2 hanging strands at x=7,92, y 16-55,16-55, width 5,5 -> pendulum chains hairpin_strand0_, hairpin_strand1_
    veil (full:headwear): 1 hanging strand at x=20, y 120-159, width 5 -- no chain proposed (it rides the head as a region)

`-- no chain proposed` is the line to act on: that strand hangs stiff unless you add
a chain. It is written for a second layer of the tag (a region cannot swing) and for
a strand whose chain would leave the art (`...; no chain proposed at x=151 (a chain
down it would run off the art)`). The chain rule: `<bone>_strand<k>_` (links
`<bone>_strand<k>_0`, `_1`), two links at the strand's top row and 0.45 of the way
down, each at the strand's column centroid in a 24-row band, tip on its last row —
the reference tassel's shape and sway (`amps [4, 7]`, period 2, phase 0.2, lag
0.12). On a layer with a body it hangs from the layer's bone, as the tassel does,
and the mesh adds one segment of that bone across the body's full width at its mean
row, so the body stays on its bone (on the selftest's crown: 0.55 px off it over the
idle with that segment, 1.07 without; the tassel tips swing 5.0). On an all-pendant
layer each chain hangs from `head`, with a `head` stub above each strand. Strands
replace the single pendant chain: a chain at the mean x of two strands hangs between
them.

**The lash that carries a crease** (issue #26). See-through sometimes paints the
double-eyelid crease into the `eyelash` layer, and the blink squashes the whole layer
about the eye bone — so the crease is squashed with it, on one eye and not the other.
`propose` notes an `eyelash-r`/`-l` part that reaches more than 35 % of its own height
above its eyewhite's top, or is more than 1.2 times the height of its pair; on the two
examples the four lashes reach 17-26 % (4-6 px, the lash line itself) and the pairs are
1.00 and 1.04 apart, so neither is noted. When such a lash has a row between its top and
the eyewhite's top with no art across its whole width, the lowest such row is proposed as
`motion.blink.still` on `head`, and the rows above it stop blinking; when it has none, the
note says so and nothing is cut — clear a row between the crease and the lash line in the
part, or leave the crease to blink. The cut has to be a clear row: two pieces cut through
art are each resampled against their own transparent edge, and on the demo example a cut
through its lash line changed 36 px of the setup-pose render (up to 7 levels, at render
scale 0.942) and up to 21 levels in the idle frames where the head rolls; a clear-row cut
changed none, at rest or rolled. The eye bone is not moved: scaling about the eyewhite's
top edge instead would close the eye upward onto the upper lid and still move whatever sits
above it by (1 − squash) × its height above the pivot, so the cut, not the pivot, is what
holds the crease.

### A contour mesh (`meshes.<part>.contour`, issue #84)

The lattice keeps every grid cell that holds an art pixel, so its boundary and its interior
density are one number: a finer `grid` tightens the outline and densifies the whole part at
once. A contour mesh separates them. Its outline is rig-c's own trace of the part's
silhouette — the art with its holes filled, grown by `margin` (a pixel joins when its centre lies
within `margin` of an art pixel's centre: at 1 its four neighbours, from √2 its 3x3 block), with
any diagonal pinch the growth made filled (both clear pixels of it, repeated until none is left)
— then `simplifyClosedPolygon(tolerance)` (issue #106: this replaced rigc's `offsetPolygon`,
which folded the outline over any notch narrower than twice the margin; a grown silhouette is a
set of pixels and its trace cannot cross itself — a narrow notch grows shut instead). Its
interior vertices are the ones declared — each region's boundary, its band's outer edge and its
own `spacing` grid inside region and band, then the background `spacing` grid — and the
triangulation is a constrained Delaunay one that never crosses the outline (`src/contour.ts`).
Where the outline passes through a region and its band, the outline is cut there at the
region's `spacing` too (issue #110): points are inserted exactly on its edges, held to the same
keep radius (half the spacing) from the edge's ends and from each other, so the outline encloses
the same pixels and only gains vertices. Without it an outline edge crossing the band is held by
its two ends alone — no interior point may sit within half a spacing of the outline — and one
long edge from inside the region (`g` = 1) to past its band (`g` = 0) spreads the region's
motion along its whole length. A region whose band reaches no outline edge changes no hull
vertex; one that does keeps every hull vertex in the same order from index 0, and a vertex moves
up only by the points inserted before it.

**Weights.** A region's bone takes `g` at a vertex: 1 inside the region (its edge included),
`1 − d/band` at a distance `d` past it, 0 at `d ≥ band` (with `band` 0, a step) — linear, no
curve. The rest, `1 − g`, is shared among the segment bones exactly as the lattice shares a
vertex (`w = 1/(d + r)²`, at most 4 bones, the 0.03 floor inside that share). A vertex no
region reaches is weighted and rounded exactly as a lattice vertex at the same point would be.
With a region present: a region bone that is also a segment bone is one entry,
`g + (1 − g)·share`; when the segment share already holds 4 bones and the region's bone is not
one of them, the lightest segment bone is dropped (never `g`); the 0.03 floor is not applied
again to the scaled shares; the weights are rounded to 5 places, an entry rounding to 0 is
dropped, and the remainder goes to the heaviest entry, so each vertex sums to exactly 1
(`src/localweights.ts`, `roundShares` in `src/rig.ts`). The 1 and the 0 are decided exactly on
the 1/256 px grid; only a value in between is a floating-point figure. A region's bone counts
as a mesh bone, so an idle key on it moves to `<bone>_ctl` under `--idle-keys ctl` like a
segment bone's.

**What it reports.** `mesh_report.json`'s row for a contour mesh carries `mode: "contour"`, the
parameters it ran at, `src/contour.ts`'s whole report (outline and interior vertex counts,
triangles, coverage, overshoot and its bound, enclosed transparent area, the smallest angle and
largest edge ratio with their triangles, the islands and pixels left out, and what the traced
silhouette holds besides the art, each pixel counted once: `filledHolePixels` (the art's own
holes), `grownPixels` (added by the margin), `pinchFilledPixels` (added by the pinch fill) and
`grownHolePixels` (transparent pixels the grown silhouette encloses — a notch whose mouth grew
shut))
and, per region, the vertices its bone reaches (`g > 0`) and holds alone (`g = 1`).
`art_coverage` is over all the part's art, stray islands included (in the automatic mode it is
not: there the islands `source.stray` leaves out are cleared from every reader's art, see
`source.stray` below). A lattice mesh's row is
unchanged.

**Refusals** — every one names the part, the value found and the value required, and every
contour refusal in a run is listed together; nothing falls back to the lattice:

| rule | means | change |
| --- | --- | --- |
| `CONTOUR_COVERAGE` | an art pixel lies outside the mesh after the margin and simplification | raise `margin` or lower `tolerance` |
| `CONTOUR_OVERSHOOT` | the mesh reaches further than `margin + tolerance + 1` px past the art | lower `margin` or `tolerance`; a grown pixel is within `margin` of art by definition, so what passes the bound is simplification, or a transparent pocket the grown silhouette closed (counted in `grownHolePixels`) |
| `CONTOUR_BUDGET` | more vertices than `budget` | coarser `spacing` or region `spacing`, or a larger `budget` |
| `CONTOUR_ONE_ISLAND` | the art is more than one 4-connected island (every island's pixel count named); with `stray` declared, an island other than the largest above it, or a tie for the largest | `stray`, if the extra islands are stray pixels you accept not drawing; a part that is two pieces stays a lattice part, or is split |
| `CONTOUR_TRACE` | rigc's tracer refuses a diagonal pinch (two pixels meeting at one corner) in the silhouette before it grows, in its words. A pinch through a hole is not one (the hole is filled first), and no island with its holes filled has one (selftest `CE08`, over every island of every 4x4 mask), so this is a guard; a pinch the growth makes is filled, not refused | the lattice, or the art |
| `CONTOUR_SELF_INTERSECTION` | the simplified outline crosses itself, or too few vertices are left | lower `tolerance` |
| `CONTOUR_INDEX`, `CONTOUR_GRID`, `CONTOUR_COINCIDENT_VERTICES`, `CONTOUR_ZERO_AREA_TRIANGLE`, `CONTOUR_ONE_LOOP`, `CONTOUR_TILING` | the built mesh fails a topology check (a bug, not an authoring error) | report it |
| `CONTOUR_PART_HAS_ART` | no pixel above alpha 8 | re-run assemble |
| `CONTOUR_PARAMETER` | a parameter `src/contour.ts` cannot run at: a margin above 0 and below 1 px (it would add no pixel), a spacing whose keep radius (half of it) snaps to 0, a polygon whose band folds it, a part over 32768 px | the named field |
| `RIG_CONTOUR_REGIONS_OVERLAP` | a vertex two regions both reach (`g > 0`); the detail names the vertex and both regions | move the regions apart or narrow a band |
| `CONTOUR_RIB_ART` | a rib's point (a link origin or a station) is not on the part's art (its pixel at or below the threshold) or not inside the outline, or a point between its ends falls within 1/256 px of the outline — a rib that leaves the art | move the chain onto the part, or leave the chain out of `ribs` |
| `CONTOUR_RIB_LINK` | a chain link shorter than the outline's `tolerance` (or of no length), or a joint where the chain turns straight back on itself; the detail names the chain, the link and the tolerance field | fewer, longer links, or a lower `tolerance` |
| `CONTOUR_RIB_CROSSING` | two ribs cross, touch or share an end (both named, with their ends) | fewer `stations`, or a chain that bends less sharply inside a wide part |
| `CONTOUR_RIB_EDGE` | a rib's consecutive vertices could not be joined by an edge (no edge across them could be flipped) — a guard: the rule keeps every other point off a rib | report it |

**Ribs along a chain** (`meshes.<part>.ribs`, issue #188). A long thin part that hangs from a
chain — a tie, a strand of hair, a scarf end — bends at the chain's joints, and a mesh with no
row of vertices across the strand there cannot fold at the joint: the bend is taken up by
whatever triangles happen to span it. For each chain `ribs` names, `src/contour.ts`
(`placeRibs`) places, in part-image px:

- **where**: on each link k (from `points[k]` to `points[k + 1]`, the last to the tip) a rib at
  its origin and at `points[k] + m/(stations + 1) · (end − origin)`, m = 1..`stations`; the tip
  carries none;
- **across**: along n = (−d_y, d_x)/|d|, d the link's direction — at a joint between two links
  the sum of their unit directions, the bend's bisector;
- **clipped to the art**: the point must be on the part's art (its pixel above the mode's
  threshold) and inside the outline; from it the line runs both ways to the first point where it
  meets the outline the mode traced (art, holes filled, grown by `margin`, simplified at
  `tolerance`), and those two points, on the 1/256 px grid, are the rib's ends. Each end joins
  the hull on the edge it lands on (or is that edge's vertex), moved off the edge by at most
  1/512 px; coverage, overshoot and self-intersection then read the outline with them;
- **between**: the point itself (so the joint is a vertex), and each half from an end to the
  point cut into ⌈half / spacing⌉ equal parts at the mode's background `spacing`
  (`auto.source.spacing` in the automatic mode);
- **kept a row**: no other interior point is kept within half a spacing of a rib, every
  consecutive pair of a rib is made an edge of the triangulation (edges across it are flipped
  until it is one) and locked, as an outline edge is — so `nonDelaunayEdges` does not count it.

Nothing reads a weight: every vertex is weighted as any other at its point. The rib on a strand
painted inside a wider layer runs across the whole opaque run there, sleeve and body included —
cutting the strand out is #170's. In the automatic mode every rib vertex is added to
`protect.vertices` (after the author's, as written) and each rib is sent to rig-c's
`reduceMesh` as a named line (`lines`, rig-c 2.33.0; `maxDeviation` 0), so the reduction keeps
every rib vertex and its post-pass flips no rib edge; the result's measurement carries one
`MQ_LINE_DEVIATION` row per rib.

**The window between coverage and overshoot**, measured in #106 (`tools/contour_survey.ts`, five
generated shapes, margins 0, 1, 1.5, 2, 2.5, 3): the smallest margin that covered every art
pixel was 0 at tolerance 0.5, 1 at tolerance 1 and 1.5, 1.5 at 2, and 3 at 3 (a two-horned
crescent; the other four 1.5 or less). No cell refused overshoot, and along each tolerance, once
a margin passed every larger one passed — where the offset this replaced moved an acute corner
up to 4 × margin and closed the window from above. That is the generated shapes: on a real part
a larger margin can close a gap whose enclosed pocket lies further from the art than the bound,
which the overshoot check refuses (the demo's hairpin builds at margin 1 and refuses at 1.5, 2
and 3: 5.39 px). On the public examples at tolerance 1, margin 1, `stray` 4 and spacing = the
part's grid, 13 of the 14 mesh parts build; the 14th is the demo's earring, two pieces.

**When not to use it.** A part that is two pieces (the demo's earring: 411 and 358 px) — keep
the lattice, which bridges islands, or split the part. And a part nothing deforms locally: at
tolerance 1 the contour outline is dense, and on the examples' 13 parts the contour mesh used
more vertices than the lattice at the same spacing (demo 1785 against 1431, sample 974 against
852) while enclosing 5.8 and 9.8 times less transparent area (demo 25078 against 144782 px², sample
6563 against 64445), with thinner triangles — smallest angles 2.46°–11.31° against the lattice's
12.09°–45° (#106). Switched, every part that builds: the sample passes `check` (9 of 9;
`TEXTURE_STRETCH` 1.227 → 1.384, ceiling 1.927); the demo's gate is green but `check` refuses
`TEXTURE_STRETCH` on its back hair (2.535: an edge of a contour triangle squeezed to 0.394 of
its length in the idle), and with the back hair left on the lattice it passes 9 of 9 (1.388 →
1.68).

**Why the demo's back hair fails, and what passes** (issue #115). The squeezed edge is an
outline edge 2 px long, near the hair's tip, whose two ends sit either side of a step in the
weight field: one end keeps `hairback_l1` at 0.031, the other drops it, because a weight under
0.03 is dropped (`src/weights.ts`, the reference's `>= 0.03`). `hairback_l1` and `hairback_r2`
swing half a period apart, so that 0.03 step moves the two ends 1.2 px against each other — on
a 2 px edge, a ratio of 0.394 to 1.639. Re-deriving every vertex's weights by the same formula
with the drop and the four-bone cut both left out (an off-tree measurement, not a proposal)
gives 1.316 on the contour mesh and 1.336 on the lattice: the lattice's 36 px edges hide the
step, the outline's 2 px edges show it. Interior vertices cannot change it — an outline edge is
in every triangulation — so the background spacing does not move the figure (36, 24, 18 and
12 px all give 2.535). Raising `tolerance` to 1.5 removes every short edge across a step (the
shortest is then 8.2 px) and the part passes (1.345; with every buildable demo part switched,
`check` passes 9 of 9 at 1.68), at 313 vertices against the lattice's 268 and 18155.5 px²
enclosed against 58346. The window is one value wide on this part: 1.25 keeps the same 2 px
edge (2.535) and 1.75 leaves art uncovered at margin 1. No other switched part of either
example comes near it: the largest length change on any edge under 5 px is 1.349 px on the
back hair and 0.784 px at most elsewhere, where a 2 px edge fails once it shortens by
0.962 px (2 − 2 / 1.926544). The mode is for a part with a declared soft region inside a stable surround; on the
generated fixture of `tools/local_compare.ts` it reached a local shape error (0.336 px at most,
63 vertices) the lattice reached only at grid 2, with 1025 vertices (re-run on the grown outline
in #106, the same figures).

**On real parts the generated result did not carry over unchanged** (issues #107 and #110,
`bun tools/real_compare.ts --work <dir> --examples demo,sample --builds --sweep`, a declared test region on two demo
parts — a place to measure, not a claim about the painting; the region spacing chosen by vertex
count alone). On `bottomwear` (a region of radius 65 px inside the part) the contour mesh passes
the same rule: 336 vertices against the lattice's 352, largest local shape error 1.535 px against
7.613. On `hair_front` (radius 11 px, beside the part's own outline) it did not until the outline
was cut inside the region's band: one 35 px outline edge ran from inside the region (`g` = 1) to
past its band (`g` = 0), and every pose's worst pixel sat in a 7.1° triangle on it, 0.74 px from
the outline — 4.481 px against the lattice's 2.453, at 119 vertices against 123, at every
tolerance that builds (1, 1.25, 1.5; 1.75 and up leave art uncovered at margin 1, 0.5 and below
cannot fit 123 vertices). With the outline cut there it passes: 120 vertices, 0.333 px against
2.453, transition 1.335 against 2.543, deformation outside 0.997 against 2.168; the lattice
needs grid 2 (2590 vertices) to match it. Moving a region still opens the seam with the part
drawn beside it — over the idle, translated, by 5.19 px (lattice with the region's weights) and
5.76 px (contour) on `hair_front` against the face, 6.91 and 5.84 px on `bottomwear` against the
shoes, beyond what the same idle opens without the region — and `check`'s seam bar does not see
it (0.326 or 0.327 in every variant: it compares the setup pose). A declared `seam` requirement
does (§7, *Declared requirements*; the region translated, the idle at 12 fps): `hair_front`
against `face` reads 3.022 px on the tracked build and on the lattice variant — the idle's own
sway, at frame 23 — and 6.809 (lattice + region) or 6.888 (contour) at frame 0, at pixel
372,135 or 373,130 inside the region; `bottomwear` against `shoes` reads 6.478 (frame 8) and
11.410 or 10.489 at frame 27, pixel 375,1192. `TEXTURE_STRETCH` does: the
translated region fails it in both modes on `bottomwear` (2.314 lattice, 2.448 contour) and in the
contour mode on `hair_front` (2.183; lattice 1.552), where the face half of `STILL_REGIONS_DARK`
failed in both (its pixel reading, until issue #123; not re-measured since). The ceiling is 1.927. The outline cut moved the stretch little (`hair_front`
contour, per pose, before → after: still 1.152 → 1.149, rotate 1.444 → 1.415, translate 2.186 →
2.183, scale 1.771 → 1.670) and the translated seam from 5.70 to 5.76 px.

### An automatic mesh (`meshes.<part>.auto`, issue #126)

The third mode asks for an economical mesh under declared quality bounds instead of a spacing.
It is opt-in per mesh: `propose` still writes `grid`, a config that names no `auto` builds byte
for byte as before, and the top-level default does not change. The reduction itself is chosen
on geometry alone; the result is then written only when its **motion** is measured against its
unreduced source on the rig's idle and passes the author's bounds (step 4). The steps
(`src/automesh.ts`, `src/automotion.ts`):

1. **The source** — this package's contour mesh over the padded part image at **alpha 1 and
   above** (the threshold rig-c's authored-fit gate uses; the lattice and contour modes stay
   at alpha above 8), at `source.tolerance`, `source.margin` and the background `source.spacing`,
   with no region. It is gated by the contour mode's own checks, and their refusals
   (`CONTOUR_*`, the detail ending "the automatic mode's source, at alpha 1 and above") refuse the
   part. One reading differs from the contour mode's: the source's overshoot is measured with the
   background flooded **8-connected** (rig-c 2.23.0's `measureAuthoredMeshFit` at connectivity 8,
   the fill rig-c's `MQ_OVERSHOOT` and `reduceMesh`'s admission read), so a pocket of background
   joined to the outside only at a corner counts as outside and a source spanning it is refused
   here (`CONTOUR_OVERSHOOT`, "the background flooded 8-connected"), with the number rig-c would
   read, rather than by rig-c's admission after the call. The row's `source.contour` says so
   (`fitConnectivity: 8`); the contour mode keeps its 4-connected reading and writes no such key. Its weights are the contour mode's — segments and region falloff — under the author's
   `influences`, with no 0.03 floor unless the author writes one.
2. **The call** — rig-c's `reduceMesh` (`rig-c/mesh`, 2.28.x) refines inside the declared
   regions, then removes vertices while every declared bound still holds. Every number it is
   handed is one of the fields below; `preset` is null (no preset exists yet: a preset will be a
   named, versioned set of these numbers, expanded into the report), and no deform key or linked
   mesh is passed (this package writes none). The three Stage B opt-ins (below) are handed over
   only when written.
3. **Acceptance** — the result is written only when rig-c's report ends
   `no-further-valid-reduction`, or `budget-exhausted` with `best-meeting-every-bound`, and its
   candidate is `accepted` with every row that has a declared bound at `pass`. Anything else
   refuses the part (below); nothing falls back to the lattice or to the source.
4. **Motion** — the rig stage builds the rig twice through rigc's gate: as written (the
   **candidate**, the reduced mesh, packed as `--out` receives it) and with that one attachment
   swapped for the unreduced source — its UVs, triangles and hull as `reduceMesh` was handed them,
   its own weights bound the same way (the **reference**, `build --profile spine-html` without
   `--pack`: the same gate over the compile, and nothing reads a reference's pages). rig-c's
   `compareMeshesInMotion` (`rig-c/meshcompare`) poses both model documents on the idle
   exactly as `check` renders it — `idle` at 12 fps over its duration, physics reset at 0 and
   stepped by 1/12 s, no warm-up — at the render's frames (`grid`, i/12 s) and a frame interval's 0.381966 past each (`irr`, frames the render never
   draws), and measures how far the reduced mesh carries each art pixel from where the source
   carries it (`MQ_LOCAL_DEFORMATION`, world units = rig px), its triangles' stretch and squash
   from the setup pose, and the triangles it turns over (`MQ_INVERSION`). The part is written
   only when rig-c's verdict is `accepted` (geometry and motion both pass). Nothing chooses the
   full reduction by motion, so every frame of this comparison is held out from selection. A part the idle cannot deform
   is refused before anything is compiled: the idle has to key, with changing values, a bone that
   moves some of the bones the part is weighted to and not all of them (a key on their shared
   ancestor, or on the one bone a single-bone part binds, moves every vertex by one affine map and
   would read 0 over nothing). Constraints are not read for this: a part only a constraint moves
   is refused, never passed.
5. **The acceptance loop** (rig-c 2.24.0, rigc#1266 mechanism 2; `src/autoreplay.ts`) — only
   when step 4 refuses the full reduction on motion (`AUTO_MESH_MOTION`). rig-c reports every
   accepted **operation** of the call (`acceptedAt`: N entries `{ step, kind, count,
   sourceVertices }` since rig-c 2.25.0 — the attempt number, `insertion`, `removal` or
   `boundary-run`, the vertices it inserted or removed and their source indices; the first I of
   them, up to the last of kind `insertion`, are the refinement's, the rest removals and boundary
   runs) and replays the call to any operation n by `stopAfterAccepted: n`, byte for byte the mesh
   the call held after that operation. A boundary run is one step however many vertices it
   removes, so every count below — N, I, the chosen step, ⌈log₂(N − I)⌉ — is in operations. The stage first compares the source with
   itself on the idle's `grid` frames (a source the gate would refuse leaves the part refused as
   in step 4, and nothing is searched), then **bisects** over the removal steps strictly between
   I and N: each probe replays step n, holds it to step 3's acceptance (the termination rig-c
   promised, `replayed-to-accepted-step` with that step, and every declared geometry row
   passing), builds the rig with that step through rigc's gate without packing, and compares it
   with the source on the `grid` frames only — the irr frames are not walked at all, so they
   cannot inform the choice. It keeps the largest step it saw pass. Validity along the order is
   not monotone (the contract measured it), so the search finds *a* passing prefix, not
   necessarily the last, and at most ⌈log₂(N − I)⌉ replays are taken — derived from the steps,
   not an author number. The one field that changes the search is the opt-in
   `motion.selection` (*The multi-interval selection*, below); without it the search is this
   bisection and the stage writes the bytes it wrote before the field existed. The chosen step is then
   written into the rig, which goes through rigc's gate again exactly as written, and is
   compared with the source on the **whole** idle with the grid frames declared `selection` and
   the irr frames held out; it is written only when that comparison is `accepted` on every
   frame, the held-out ones included. A step at or below I (the source, refined or not) is never
   written as an automatic result: when no removal step passes, the part is refused with "no
   reduction passes the motion bound". A part the gate accepts in step 4 runs no replay. Since
   rig-c 2.24.0 the report carries `acceptedAt`, last in `changes`; since 2.25.0 one entry per
   operation; since 2.26.0 five more geometry rows (below).

**The multi-interval selection** (issue #148; opt-in, `motion.selection: { "policy":
"multi-interval", "maxProbes": <n> }`). The bisection keeps the step it lands on; where validity
is not monotone, a later step with fewer vertices may pass in an interval it never visits (the
synthetic fixture shows one: control `MO52`). With the field, step 5's search becomes:

- **The order.** The bisection first, whole — its own result is always among the tested — then,
  while fewer than `maxProbes` distinct steps have been replayed, the midpoint (rounded down) of
  the longest run of removal steps not yet replayed, the lower run when two are equally long.
  It depends only on the answers, so two runs make the same probes. Each step is replayed at
  most once: the budget counts distinct replays, never a repeat.
- **The budget** is the author's whole number (1 or more; never defaulted, never derived). It
  must hold the bisection: below ⌈log₂(N − I)⌉ the part is refused
  `AUTO_MESH_SELECTION_BUDGET`, naming N, I and the number required, before any replay. There
  is no unbounded walk: at most `maxProbes` replays, each one unpacked gated build and one
  comparison.
- **The choice.** Among the tested steps that passed on the `grid` frames, the fewest vertices —
  each replay's own count, read off its mesh, never inferred from the step number (a boundary run
  removes several vertices in one operation) — and the lower step on a tie. The source (step I,
  refined or not) and the full result (step N) bound the domain and are never candidates. It is
  the **best among tested candidates**: never the last, the minimal or a complete walk, unless
  the row's `termination` says `every-removal-step-tested`.
- **The roles.** Every frame a probe reads is a `grid` frame, declared `selection` in the final
  comparison; the irr frames are read once, by that final comparison on the whole idle, and are
  held out. A chosen step that fails held out is refused as under the bisection, and **no second
  candidate is taken** — nothing reads a held-out result to choose. A probe that read a frame the
  final comparison holds out (or does not declare) is refused `AUTO_MESH_SELECTION_ROLES` and the
  held-out claim withdrawn; the shipped search never does this.
- **Nothing tested passed**: refused `AUTO_MESH_MOTION`, "no reduction passes the motion bound
  among the tested candidates", every probe named; a step never replayed is not claimed to fail.

It cannot skip an operation inside a prefix — every candidate is the call's own mesh after its
n-th accepted operation — and it does not change what the economy of the automatic mode is
measured against; it only looks at more prefixes of the same call.

**The skinning residual as a per-step veto** (issue #126, rig-c 2.31.0; opt-in,
`motion.residual: { "maxResidual": <px> }`). Without the field nothing is sent and the stage is
byte for byte what it was. With it, rig-c's `reduceMesh` receives `targets.skinning` — the
envelope below and the author's bound — and, in rig-c's words, "every removal, boundary run and
post-pass is held to `MQ_SKINNING_RESIDUAL` against the call's own source and refused by name
when over it": a step whose result's residual exceeds the bound is a refusal like any other
(`MQ_SKINNING_RESIDUAL: <value> against <= <bound>`), the working mesh as it was, the search going
on within the budget. Refinement insertions are not vetoed one by one; the refinement's outcome is
held to it whole before any removal. `acceptedAt` records accepted operations only, so a replay
(step 5) under the veto is the same call's mesh after its n-th accepted operation, byte for byte.

- **What the value is.** "The largest over the samples carried by both meshes of
  Σk εk·|Δsk| + Σk |Δw̄k|·(εk·|p − ck| + τk): a bound, under the declared envelope only, on how
  far the candidate draws a UV from where the source draws it — positions only; it certifies no
  orientation, stretch or squash, no motion outside the envelope, and replaces no motion
  comparison" (rig-c's `SKINNING_READING`). Drawing px: the part's own pixels (pageScale 1), the
  same unit as `maxLocalDeformation`. It is **not the motion verdict**: the motion comparison of
  step 4 still runs on every written candidate and still decides, so a residual that passes
  never writes a part the comparison refuses. It is conservative, never understating the posed
  error rig-c measured, and loose on scale and multi-bone chains (rig-c measured 0.26–0.72 of
  the posed error there, 1.000 on a pure rotation).
- **The envelope is derived, never written** (`src/autoenvelope.ts`). The reference is the
  lowest common ancestor of the slot's bone (`segments[0]`'s) and every bone the part's source
  weights bind — the deepest bone on all their ancestries, read off the rig as written (#165).
  When every bound bone hangs below the slot's bone that is the slot's bone itself, and the
  envelope is the one derived before #165, byte for byte. When a bound bone hangs in a sibling
  subtree — a skirt link beside the chest, the hip above it — the reference is the bone they
  share, and the slot's bone is sent as one more bone, with its own range, **only when the
  weights bind it**: rig-c's envelope holds every bone either mesh binds and no other, and
  refuses one neither binds (`SKINNING_BONE_UNKNOWN`). The row's `reference` names the bone
  used and its `rule` says which of the two cases it is. For every bone sent, rig-c's
  `skinningEnvelopeBone({ referenceChain, chain })` composes the chain from the root to the
  reference and from the reference's child down to the bone, each bone's range read off the
  idle this package writes: rotation and scale as the [min, max] of every key value and Bézier
  control value, translation as the length of the largest |x| and |y| offsets, the pivot the
  bone's setup joint in the part's drawing frame, and the setup the rig's (no scale, shear or
  inherit mode is written). An author cannot supply one (`CONFIG_KEY_KNOWN`).
- **Not measurable** — the veto is then **not applied** and the comparison accepts or refuses
  the part alone, as without the field; no number is invented. Each stop is named with its bone
  and code: a bone a constraint drives (an ik's, transform's or path's `bones`, a physics
  constraint's `bone`) is handed to rig-c with that kind as its source and refused by rig-c,
  `SKINNING_RANGE_UNSUPPORTED` in its words — rig-c certifies only ranges declared by keys and
  exposes no range read off a posed walk; a shear key (`ENVELOPE_SHEAR_KEYED`: rig-c's range has
  no shear field); a slider in the rig (`ENVELOPE_SLIDER_UNREAD`: it drives an animation's bones,
  which are not read). `ENVELOPE_BONE_NOT_BELOW_REFERENCE` — a bound bone with no chain to the
  reference, which the helper cannot compose — keeps its name and its check, and is
  **unreachable by construction** since #165: a common ancestor is above every bound bone, and
  in one skeleton (one root) a common ancestor always exists. It would fire only on a bone
  list with two roots, which is not a skeleton; the selftest plants that case so the check is
  seen to fire.
- **The bound is the author's** number, 0 or more, never defaulted. The tracked evidence uses 1,
  the policy's motion bound: the residual bounds the same displacement the motion row measures,
  without posing, so the distance already accepted for the posed reading is its first reading.
- **What it costs.** Every step the rows let through is measured once more, carried rather than
  recomputed (rig-c measured the carried call at 1.4–5.8 times the call without it on recorded
  inputs, under a stand-in envelope); a veto changes the trajectory, so the result is a different
  reduction, not the same steps checked twice.
- rig-c's report does not count the steps the veto refused; `tools/veto_tally.ts` counts them
  over the very call (the survey prints them).

The public examples' evidence is re-run from the tree: `bun run fetch-examples`, then
`bun tools/auto_motion_survey.ts` switches each part item 2 accepted on geometry to `auto`, alone,
under `examplePolicy` (`fixtures/automesh.ts`) plus `policyMotion` (`fixtures/automotion.ts`), runs
the real rig stage with the motion gate and the acceptance loop, and prints two tables — the full
reduction's comparison and the loop's outcome per part (N, the chosen step, the replays, the
candidates they tried, the selection and held-out values) — every row from rig-c's report, the
schedule walked and each refusal's text, the same bytes on every run of one tree (each part's
wall time goes to standard error, not into the table).

| field | means |
| --- | --- |
| `source.tolerance`, `source.margin`, `source.spacing` | the contour mode's parameters for the source, px (margin 0, or 1 or more) |
| `source.stray` | optional: the largest island, in art pixels at alpha 1 and above, that may be left out, as in the contour mode (absent: none is; an island other than the largest above it is still `CONTOUR_ONE_ISLAND`). Unlike the contour mode, the islands left out are cleared from the art **every reader of the mesh takes** (issue #172): the reduction's `art` and its `sourceBounds`, the result's `targets.artFit`, `art_coverage`, and the motion gate's art bounds all read the mask the outline was traced from, so a part whose only extra islands are at or under the figure builds where it refused (`REDUCE_SOURCE_FAILS_ITS_ART_BOUNDS`) before. What was cleared is named: the row's `stray_cleared` — `islands`, `pixels`, and `art_pixels` (the part's art at alpha 1 and above with those islands counted in), present whenever `stray` is declared (zeros when nothing was left out), absent otherwise — and the part's mesh line prints `stray cleared N island(s), P of A art px` when N is above 0. The image is not touched: `rig/images/<part>.png` is the part as assembled, so a cleared pixel the written mesh's triangles reach is still drawn and one outside them is not. That is the one answer every reader of the image gives: `check` reads `parts/<part>.png` as assembled, through the attachment's rest triangles (`CHECK_TIP_OVER_ROOT`, `CHECK_STILL_REGIONS_DARK`, a `seam` requirement's pairs) or composited flat against the render (`CHECK_SEAM_WITHIN_BAR`), and the runtime draws the rig's image through the same triangles; clearing the rig's image alone would make `check` count pixels the runtime no longer draws. On the public examples the declared crumbs carry alpha 24 or less (docs/evidence/production-trial-stray.md) |
| `sourceBounds.{minCoverage, maxOvershoot, maxUndercut}` | what the source must already meet at alpha 1 and above: the share of art pixel centres covered (0..1), the furthest a covered pixel may sit outside the filled silhouette (px, or `null`), the furthest an uncovered art pixel may sit from the covered set (px, or `null`) |
| `targets.artFit.{minCoverage, maxOvershoot, maxUndercut}` | the same three for the result |
| `targets.maxBoundaryDeviation` | the largest Hausdorff distance between the result's outline and the source's, px |
| `targets.minAngle` | optional: the smallest triangle angle, degrees; absent, it is reported and not gated |
| `influences.{maxInfluences, minWeight}` | the cap on bindings per vertex (1 or more) and the floor below which a share is dropped (0 up to 1; 0 drops only shares that are 0 on the weight grid) — for the source's weights and every inserted vertex |
| `budget.maxCandidates` | the most steps rig-c may try (each insertion and each removal attempt counts one); 0 returns the source |
| `minArtSamples` | the fewest art pixels a raster row is taken over, 1 or more |
| `motion` | **required**: `maxLocalDeformation` (rig px, 0 or more — how far the reduced mesh may carry any art pixel from where its source carries it, at any frame); optional `maxStretch` / `minStretch` (ratios; absent, the rows are reported and not gated); optional `deformMayFold` (absent is **false**: a triangle that turns over refuses the part; true declares the slot in `invariants.deformMayFold` and lists every fold instead); optional `gradation` (px per px, 0 or more, or `null`; the author's G for `MQ_ALLOCATION_CONTRAST`, never derived — absent or `null`, the contrast reads `not-measurable` naming it; see *The allocation rows* below); optional `selection` (`{ "policy": "multi-interval", "maxProbes": <whole number, 1 or more> }`; absent, the acceptance loop is the bisection — see *The multi-interval selection* above); optional `residual` (`{ "maxResidual": <px, 0 or more> }`; absent, nothing is sent — see *The skinning residual as a per-step veto* above) |
| `protect` | optional; each field optional: `hull` (true keeps every source outline vertex; absent is **false**, the default agreed for this mode), `vertices` and `edges` (source vertex indices and pairs that must survive), `regionBoundaries` (region names whose outline vertices must survive), `weightJump` (an L1 weight difference above which a source edge is kept; absent is none), `influences` (bones never pruned from a vertex; every region's bone is added) |
| `regions` | optional, each `{name, shape, bone?, band?, maxEdgeLength, transition, grade, minArtSamples}` with `shape` `"circle"` (`cx, cy, r`) or `"polygon"` (`points`): `bone` and `band` are the control bone and its weight falloff exactly as a contour region's (rig px, multiples of 1/256 px), written together (the region weights its bone and asks for density) or not at all (density only, issue #155; one without the other is refused by name); `maxEdgeLength` is L0, the longest an edge meeting the region may be, px; outside it, across `transition` px, the bound relaxes as `L0 + grade·d`; `transition` 0 is a hard edge; `minArtSamples` is the region's own sample floor |
| `boundaryRuns` | optional, `{ maxVertices }`, a whole number 2 or more, no default: each removal pass first tries to replace a run of 2 to `maxVertices` consecutive source-hull vertices with one chord, as one step held to every declared row (below) |
| `retriangulate` | optional, `"delaunay"`: once the reduction ends, the kept vertices are re-triangulated by Delaunay flips, taken whole only when every declared row still passes (below) |
| `removalOrder` | optional, `"deformation-load"`: the single removals are tried in ascending predicted load instead of ascending source index (below) |

**A bound declared absent.** `maxOvershoot` and `maxUndercut`, in `sourceBounds` and in
`targets.artFit`, each take a number of px 0 or more or `null`. `null` means *measured and
reported, not bounded*: rig-c (2.21.0 and later) still measures the row, reports it `undeclared`
with its value and no bound, and never refuses the part or stops a reduction step on it. Leaving
the field out is not the same thing and is still refused by name (`CONFIG_FIELD_PRESENT`), as
rig-c refuses it: an omission cannot be told from a forgotten field. `minCoverage` has no such
form. Write `null` where the policy deliberately accepts loss the distance cannot express — for
instance a coverage floor below 1, where every uncovered pixel is at least 1 px from the covered
set, so an undercut of 0 cannot hold beside it — rather than a large number, which would read as a
measured limit. The row in `mesh_report.json` echoes the `null` in `settings`, carries the
residual as rig-c reports it (`state: "undeclared"`, the value, `bound: null`), and
`worst_residual` never picks it; the `build` line prints it after the worst residual as
`overshoot <value> (not bounded)` / `undercut <value> (not bounded)`. The motion gate holds the
reference and the candidate to the same bounds, `null` included.

**Stage B opt-ins** (rigc#1271, rig-c 2.25.0–2.28.0). Three fields, each the author's and each
absent by default: left out, it is not sent and the call — mesh and report — is the one it was
before the field existed. What each promises and does not is rig-c's (its docs/MESH_REDUCTION.md
§8, the three *Stage B* subsections):

- `boundaryRuns: { maxVertices }` — the boundary half of the reduction. A traced source hull is
  simplified at about the same 1 px the deviation bound is measured at, so a single removal
  almost always leaves a sagitta over it; one chord for a run of vertices can meet it. A run is
  2 to `maxVertices` surviving source-hull vertices, removed as **one** operation held to every
  declared row exactly as a single removal is, before that pass's single removals; it is one
  `acceptedAt` entry (`kind: "boundary-run"`, `count` ≥ 2), so the acceptance loop replays to it
  like any step. Each run tried costs a candidate against `budget.maxCandidates`.
- `retriangulate: "delaunay"` — the interior half. After the reduction ends (a replay's
  included) the kept vertices are re-triangulated by Lawson flips toward Delaunay: no vertex
  added, moved or removed, so UVs and weights are the removals'; no outline edge, protected edge
  or edge a region holds is flipped. The pass is taken whole only when every declared row still
  passes, and otherwise the mesh is returned as the removals left it with the row that refused
  it named. It is not a step: `acceptedAt` and the replay are the call's without it, and a replay
  to step k is byte for byte the budget cut at that step followed by the same pass (`MO43`
  holds it on this package's inputs). rig-c does not promise that passing motion is monotone
  along the steps under it; the acceptance loop finds a passing prefix, not necessarily the last,
  as it always did.
- `removalOrder: "deformation-load"` — each pass tries its single removals in ascending
  L · Δshare (the longest edge the removal's hole adds, times half the L1 weight difference
  across it), ties by source index; boundary runs keep their own order. It reads weights only:
  on an unweighted source it is the default order.

A malformed value — `maxVertices` 1 or 2.5, `null`, another spelling — is refused by the loader by
name (`CONFIG_FIELD_TYPE`, `CONFIG_FIELD_PRESENT`, `CONFIG_KEY_KNOWN`). The row echoes each field
set in `settings` (after `preset`) and, in `result`, `boundary_runs` (the runs taken and the
vertices they removed) and `retriangulation` (`taken`, `flips`, `sweeps`, `refusedBy`); the
`build` line adds `; boundary runs <= k: r run(s), v vertex(es)`, `; retriangulate delaunay taken,
n flip(s)` (or `refused by <row>`) and `; removal order deformation-load`. A part that sets none
writes none of these. `bun tools/auto_motion_survey.ts --config
baseline,boundaryRuns,retriangulate,removalOrder,all` runs the eight public parts under each
(`docs/evidence/auto-stageb-survey.md`).

**The allocation rows** (rig-c 2.26.0, rigc#1280). rig-c reports five more geometry rows on every
reduction: `MQ_GRADE` (the sharpest change of local edge size across an edge), `MQ_MIN_ANGLE_P10`
(the tenth percentile of the triangles' smallest angles), `MQ_ALLOCATION_CONTRAST` (Δ, density no
declared need explains, with economy E), `MQ_DEFORM_LOAD` (the largest L · Δshare · θ / 4 — a
location reading, not predicted motion) and `MQ_BOUNDARY_NECESSARY` (B\*, the fewest source-hull
vertices an outline can keep with every static row held). Every one is `undeclared`: no field
declares a bound on any of them (a `targets.maxGrade` or the like is refused,
`CONFIG_KEY_KNOWN`), none is ever required or the `worst_residual`, and each lands in the row's
`residuals` as rig-c reports it. Δ and the load read a **motion amplitude** — per idle track,
θ = ‖M − I‖ for each pair of bound bones the track turns or scales against each other, an ε in
px, and an attachment-wide gradation G (rig-c 2.29.0). The tracks are not an author field: the
rig stage derives them from the idle it writes (`src/autoamplitude.ts` — θ from each track's
keys, 2 sin(α/2) for a rotation, |s − 1| for a scale, 0 for a translation; ε the part's
`motion.maxLocalDeformation`). **G is the author's**, `motion.gradation`, because nothing a rig
declares fixes it (rig-c measured every candidate derivation, rigc#1291). In rig-c's own words,
G (px per px, 0 or more) "is how fast the mesh may coarsen away from something that needs
density — an edge of the B\* outline, a triangle whose weights turn under the declared motion.
At d px from a need of size h the reading allows edges up to h + G · d, exactly the form of a
region's `grade` … if the author would grade a region at some rate on this mesh, that rate is the
G to declare." A larger G lets a need relax sooner, so more dense vertices read as removable and Δ
and E rise; at 0 nothing reads as removable. rig-c's fixtures used 0.75, "a value those fixtures
chose, not a default rigc holds", and this package holds none either.

The amplitude is sent to `reduceMesh` and to the motion gate's comparison whenever its tracks are
derived, with `gradation` as written or `null` when the config leaves it out. Then:

- `MQ_DEFORM_LOAD` is **measured** — the largest L · Δshare · θ / 4, px, a location reading and
  not predicted motion; it never reads G. It is `undeclared` (no bound, never the
  `worst_residual`), and the build line prints it after the unbounded art rows:
  `; deform load <value> px (undeclared)`.
- `MQ_ALLOCATION_CONTRAST` (Δ, with economy E in its `allocation.contrast`) is `not-measurable`
  naming `motionAmplitude.gradation` unless the author set one; with one it is measured,
  `undeclared`, and printed as `; allocation contrast <value> (undeclared)`.
- On the comparison, each build's setup section measures the load; Δ there stays
  `not-measurable` (naming the gradation when it is null, and otherwise
  `targets.maxBoundaryDeviation`, which a comparison does not declare).
- The row's `settings.motionAmplitude` is rig-c's echo of what it read, and `motion_amplitude`
  says `{ "sent": true, "stops": [] }`.

No mesh, step, verdict or acceptance reads either row, so writing a gradation changes the report
and nothing the rig writes. A shear track, a constraint, a motion bound of 0, or a pair moved by
two bones of one group still stop the tracks by name (`"sent": false`, each term in `stops`), and
then nothing is sent and both rows read `not-measurable`.

A circle is handed to rig-c as the regular polygon with the fewest sides, 3 or more,
circumscribed about the circle, whose outline lies within 1/256 px of it (the grid the region's
numbers are on); the rule and its error are echoed in the region's `approximation`. The weights
still read the circle.

A region takes one of two forms, told apart by `bone` (issue #155):

- **Weight and density** — `bone` and `band` written. Inside the shape the bone takes weight 1,
  falling off across `band` as in the contour mode, and rig-c refines the mesh there to the
  region's density. Use it where a control bone should move that patch of the part on its own
  (a pinch, a fold) and the mesh needs the vertices to carry it.
- **Density only** — neither written. rig-c refines the mesh there to the same density, and the
  weights are untouched: no vertex takes a share from the region, the row's bone list and
  `protect.influences` gain nothing, and every source vertex is weighted exactly as with the
  region left out. A vertex rig-c inserts there carries rig-c's interpolation of the source
  triangle that holds it (its contract §6), the rule every inserted vertex follows in either
  form. Use it to place density by itself — where the art's shading, a joint or a field says
  the mesh needs vertices — so that a change in the vertex count or the motion verdict against
  the same part without the region is a change in density alone. The row writes its `bone` and
  `band` as `null`, and its counts of vertices reached and bound as 0.

`bone` without `band`, or `band` without `bone`, is neither form and is refused by name. Two
regions that both weight a bone and both reach one source vertex is `RIG_CONTOUR_REGIONS_OVERLAP`,
as in the contour mode. A density-only region decides no weight, so it may overlap any region:
rig-c holds each region's density rows on its own, the smallest bound applying to an edge two of
them hold.

**What it reports.** `mesh_report.json`'s row carries `mode: "auto"`, `settings` (every number
the call saw, the threshold and the circle approximations included), `source` (the contour
mesh's report and rig-c's counts of it), `stray_cleared` — only when `source.stray` is
declared: the islands and pixels cleared from every reader's art, and the art pixels they were
part of — `result` (boundary and interior vertices,
triangles, bindings, vertices removed and inserted), every `residuals` row with its state, value
and bound, `worst_residual` (the declared row nearest its bound, as the share of the bound used)
and `worst_region`, the `termination` with its reason and `candidatesTried`, what the weights
lost to the grid (`sharesDroppedOnGrid`, `sharesPruned`, `droppedAtFivePlaces`), per region the
source vertices its bone reaches and the result vertices bound to it, `motion_amplitude` (whether
the allocation rows' amplitude was sent, and every term that stopped it; what was sent is rig-c's
echo in `settings.motionAmplitude`), `skinning_residual` — only under `motion.residual`: `rule`
(what the residual is and that it is not the motion verdict), `max_residual`, `sent` (whether the
veto was applied), `reference`, `envelope` (each bone's `linear`, `pivot` and `translation` as
sent, or null), `stops` (each bone and code that left it not measurable), and `measured` (the
written mesh's own `MQ_SKINNING_RESIDUAL`: state, value, bound, the worst sample's UV and pixel
with the value's covariance and lever sums there, the samples carried); the row is also among
`residuals`, declared with its bound — `replay` — only on a part
the acceptance loop wrote at a replayed step (step 5): `rule` (the search in words, "a passing
prefix, not necessarily the last"), `accepted_steps` (N, in operations), `refinement_steps` (I), `chosen_step`,
`replays` and `max_replays`, `candidates_tried` across the replays, `full` (the full result's
reading that the gate refused), every probe (step, pass/fail, value and frame on the grid frames),
and `selection` and `held_out` (the chosen step's value and worst frame per role). Under
`motion.selection` the `replay` object is the multi-interval search's instead: `rule` ("the best
among tested candidates"), `policy`, `max_probes`, `accepted_steps`, `refinement_steps`,
`chosen_step`, `bisection_step` (the bisection's own result inside the search), `replays`,
`candidates_tried`, `termination` (`every-removal-step-tested` or `budget-exhausted`), `tested`
(the replayed steps, ascending), `passing_intervals` (runs of tested passing steps with no tested
failure between), `untested_intervals` (runs of removal steps never replayed), `chosen`
(`vertices`, `boundary`, `interior`, `triangles`, `bindings` of the written mesh), `full`, every
probe with its `vertices`, `roles` (`selection: "grid"`, `held_out: "irr"`, and the distinct
frames the probes read), then `selection` and `held_out`. The row's other
fields are then that step's, its `termination` `replayed-to-accepted-step` — `deformation` — the motion
gate's verdict, the bounds echoed (`deformMayFold` included), each motion row (`MQ_INVERSION`,
`MQ_LOCAL_DEFORMATION` and one per region, `MQ_SQUASH`, `MQ_STRETCH`) with its state, value, bound,
worst frame and sample counts, and the schedule walked (frames per phase, held out, selection) —
`quality_report`, the whole `mesh-quality-report/1` document of the reduction, and
`motion_report`, the whole `compare` document of the motion gate, inside the row so one file holds
every part's evidence. `art_coverage` is over alpha above 8, comparable with the
other modes; the alpha-1 coverage is a residual. `build` prints one line per auto mesh: source →
result counts (hull + interior), bindings, the termination, the worst residual, each art bound
declared `null` with its value and `(not bounded)`, under `motion.residual`
`; residual <value> <= <bound> (a pose-free bound, not the motion verdict)` or
`; residual not measurable: <bone> <code>, … (veto not applied; the motion comparison decides)`, and
`motion <value> <= <bound> at <frame>` (the frame id is `idle@<phase>@<time>`), and the reference
build's gate lines after the candidate's. A part written at a replayed step adds
`; replayed to accepted step <n> of <N> after <k> replay(s); selection <value> <= <bound> at
<frame>; held out <value> <= <bound> at <frame>`, and the stage prints one `replay "<part>"` line
with every probe, then the gate of the rig as written and its references. Under
`motion.selection` that line reads `replay "<part>": multi-interval selection over the removal
steps …, <k> replay(s) of at most <maxProbes> (maxProbes), ended <termination>: <step> <verdict>
<value> v=<vertices>, …; the bisection kept step <b>; the fewest vertices among the tested
passing steps: step <n>, <v> vertices (best among tested candidates)`. Weights are written by `roundShares` on every vertex (5 places, zeros
dropped, the heaviest entry closes): the 0.03 floor that makes the lattice's last-entry close
safe is the author's to choose here.

**Refusals** — every one names the part and the rule; nothing falls back:

| rule | means |
| --- | --- |
| `CONFIG_MESH_MODE` | `auto` beside `grid` or `contour`, or no mode at all |
| `CONFIG_FIELD_PRESENT`, `CONFIG_FIELD_TYPE`, `CONFIG_NAME_RESOLVES`, `CONFIG_REGION_NAME_UNIQUE` | a missing or out-of-range number, an unknown bone or region name, a region named twice, a Stage B opt-in that is not exactly a value rig-c accepts — every one named in one run |
| `CONFIG_REGION_BAND_NEEDS_BONE`, `CONFIG_REGION_BONE_NEEDS_BAND` | a region with a `band` and no `bone`, or a `bone` and no `band`: write both for a region that weights its bone, neither for a density-only region (issue #155) |
| `CONFIG_KEY_KNOWN` | a field the mode does not have — a bound on one of the five allocation rows, or an authored `motionAmplitude` (it is derived, never written) |
| `CONTOUR_*` | the source is refused by the contour mode's own checks at alpha 1 and above — most often `CONTOUR_ONE_ISLAND`: faint pixels the alpha-above-8 modes never saw are islands here |
| `AUTO_MESH_INPUT` | rig-c refused the call's input by throwing (a protected vertex the source does not have), in its words and code |
| `AUTO_MESH_TERMINATION` | rig-c returned no mesh: `invalid-input` (the source fails its own `sourceBounds`, a region it refuses, protected influences over the cap), `unsupported-topology`, or `budget-exhausted` with `none-met-the-targets`; or, in the acceptance loop, a replay that does not end as rig-c's contract promises (`replayed-to-accepted-step` at the step asked, `candidatesTried` the full run's `acceptedAt[n − 1].step`, its `acceptedAt` the full run's first n operations, each the same `step`, `kind`, `count` and `sourceVertices`) |
| `AUTO_MESH_ACCEPTED` | rig-c returned a mesh that is not accepted; the detail names every declared row not passing and the constraint that stopped it |
| `AUTO_MESH_NO_STIMULUS` | the idle keys no bone that moves some of the part's bound bones against the others, so no frame deforms it — missing stimulus is not a pass; put the part in `contour` or `grid` mode, or key a bone it binds |
| `AUTO_MESH_MOTION` | the reduced mesh against its source on the idle is not accepted and the acceptance loop wrote no step in its place: "no reduction passes the motion bound" (the full result's failing rows and every probe named; under `motion.selection`, "… among the tested candidates", with `maxProbes` and the termination), or the chosen step passes on the grid frames and not on the whole idle (its selection and held-out values and worst frames named); when the source itself is not accepted against itself, the full result's rows as before |
| `AUTO_MESH_SELECTION_BUDGET` | `motion.selection.maxProbes` is below ⌈log₂(N − I)⌉, the bisection the multi-interval search runs whole first; N, I and the number required named; nothing replayed |
| `AUTO_MESH_SELECTION_ROLES` | a multi-interval choice whose probes read a frame the final comparison holds out, or one it does not declare `selection`; the frames named, the held-out claim withdrawn |
| `AUTO_MESH_MOTION_INPUT` | the comparison could not be made: rig-c refused its input (its code carried — `COMPARE_REFERENCE_FAILS` when the source fails its own `sourceBounds`, `COMPARE_INPUTS_DIFFER`, …), the reference build is red at rigc's gate, or a gate build wrote no `skeleton.model.json`; in the acceptance loop, a replayed step's build that rigc's gate refuses |

**What rig-c cannot refine.** Refinement inserts only inside a region and its band (the
contract's P16). rig-c 2.19.0 stopped by name when an edge's far end lay further beyond the
band than the edge's bound; 2.19.1 and later implement the decision on issue #126 that an edge leaving the
band at a point is not held to it, so a coarse source refines. With `transition` 0 the authored
boundary stays held, and an edge from the region to a vertex further out than its bound — or one
that crosses the region with no point of it inside to split at — is still stopped by name
(`AUTO_MESH_ACCEPTED`, the detail naming P16).

### Recipe: expressions and other named animations

The package proposes no expression and keys nothing but the idle; what it gives is a rig whose
face is bones (`eye_r`, `eye_l`, `brow_r`, `brow_l`, `mouth` on `sample`) and one door for
animations you write over them, `motion.animations_from` (the row above, issue #183). Write a
file in rig-c's motion-spec shape beside the config and name it:

```jsonc
// config.json
"motion": { "duration": 4.0, "tracks": [ … ], "blink": { … },
            "animations_from": "expressions.json" }

// expressions.json — the bones the config declares, keyed as rig-c keys them
{ "spec": "rigc-motion/1",
  "animations": {
    "surprised": { "duration": 0.5, "tracks": [
      { "bone": "brow_r", "property": "translatey", "keys": [ { "t": 0, "v": [0] }, { "t": 0.25, "v": [2] }, { "t": 0.5, "v": [0] } ] },
      { "bone": "brow_l", "property": "translatey", "keys": [ { "t": 0, "v": [0] }, { "t": 0.25, "v": [2] }, { "t": 0.5, "v": [0] } ] },
      { "bone": "mouth",  "property": "scaley",     "keys": [ { "t": 0, "v": [1] }, { "t": 0.25, "v": [1.4] }, { "t": 0.5, "v": [1] } ] } ] } } }
```

`build` writes `surprised` into `rig/motion.json` after `idle`, gates it with the rig, and
`check` names it on a line of its own (`examples/sample` carries one, `animations.json` with `hop`, the
recipe below). With exactly this file beside `examples/sample`'s config in its place,
`build` printed (this tree, rig-c as `package.json` pins it):

```
[rig]   animations beside the idle, from …/expressions.json as written: surprised
[check]   beside the idle: 1 animation(s), surprised — built and gated by rigc with the rig, not measured: every bar here reads the idle
[check] check: PASS; 9 of 9 bar(s) measured, 0 skipped
```

A bone the rig lacks is rigc's refusal at the rig stage, in rigc's words (`RIG_RIGC_GREEN`); a
fault in the file itself is the loader's (the row above names each one).

**Limits.** Every slot holds one attachment, the part's own image, so an expression moves,
turns and scales the face's parts and never swaps one for another: there is no second mouth
shape to key, and no lip-sync. `check` measures the idle alone: an animation beside it has
passed rigc's gate and nothing else — no seam, stretch or hole bar has read it.

### Recipe: a soft region driven by physics

A jiggle (a bust, the hips) is a patch of one part that lags behind the body. The package
proposes none and judges none; what it gives is the three pieces to build one, all in the
config. `examples/sample` carries a worked one (issue #183, PR #187), and its config is the
fragment below, cut to the bust:

```jsonc
"bones": [ …,
  { "name": "chest_jiggle", "parent": "chest", "at": [419, 320] }, … ],
"meshes": { "topwear": {
  "contour": { "tolerance": 1, "margin": 1, "spacing": 18, "stray": 4,
    "regions": [ { "name": "bust", "shape": "circle", "cx": 419, "cy": 320, "r": 28,
                   "bone": "chest_jiggle", "spacing": 6, "band": 16 } ] },
  "r": 8, "segments": [ ["chest", [419, 223], [419, 437]], ["hip", [419, 437], [419, 557]] ] } },
"constraints": [
  { "type": "physics", "name": "bust_phys", "bone": "chest_jiggle",
    "x": 0.5, "y": 1, "inertia": 0.25, "strength": 120, "damping": 0.92, "mass": 1, "mix": 1 } ]
```

- **A bone the config authors**, under the bone the patch rides on. `propose` writes no such
  bone and no constraint; it is yours, and nothing keys it — the constraint moves it.
- **A region in a `contour` (or `auto`) mesh** that hands the patch to that bone: weight 1
  inside the shape, falling to 0 across `band` (*A contour mesh*, above). A `grid` mesh carries
  no region, so the part moves from the lattice to the outline mode first; `sample` traced
  `topwear` at its former grid spacing (18) and `bottomwear` at 28. Place the shape on the
  patch alone: on `sample` one circle at the hip centre reached the clasped hands, painted
  inside `bottomwear`, so the hips are two side circles (`hip_r`, `hip_l`) on one bone.
- **A `physics` constraint** on that bone in `constraints`, in rig-c's shape; every field but
  the bone is rigc's to accept.

`build` on `sample` as tracked (PR #187; the values above are the ones tuned for its `hop`, issue #183):

```
check: PASS; 9 of 9 bar(s) measured, 0 skipped
loop physics: 2 physics constraint(s) left out of the loop's frames, reported, not judged — "bust_phys" on bone "chest_jiggle" (rig.json), "hip_phys" on bone "hip_jiggle" (rig.json)
loop: idle 49 frame(s) at 12 fps, f0000 vs f0048 (t = 4s): max |d| 0 (0 required)
```

The `loop physics:` line is the loop bar saying what it did not read (§7, *loop*): rig-c's
render resets physics at frame 0 and steps it, so the idle's last frame differs from its first
by whatever the spring is still doing; the bar is read off the same rig with every physics
constraint left out, and the constraints left out are listed, reported and not judged
(`check.json`'s `loop_physics`, PR #184). It is not a measure of the jiggle.

**Limits.** The idle drives the spring, and a slow idle barely moves it. Measured on `sample`
(PR #187, rig-c `render --geometry`, the physics build against the same build with
`constraints` removed): under its 4 s breath (`chest` `translatey` amplitude 1.3 px), the bust
moves at most 0.155 rig px (idle frame 3, t 0.25 s); the hips move 0.000 at all 49 frames,
because the idle keys `chest` and never `hip`, so a child of `hip` receives no motion. A spring
of strength 100 trails a parent moving at about 2 px/s by the order of speed over its angular
frequency, about 0.2 px (PR #187, from the definition): no setting makes a 4 s breath read as a
jiggle (with the values tracked now, `bust_phys` inertia 0.25, strength 120, damping 0.92, the
idle moves the bust at most 0.066 rig px, idle frame 2). Faster keys on the parent bone — a hop,
a turn, in a named animation (the recipe above) or a consumer's own — are what the spring
answers. `sample`'s `animations.json` holds one, `hop` (1 s: `hip` `translate` y down 5, up 24,
landing at -6 at 0.45 s, settling at 0.55 s; nothing keys the jiggle bones): rendered at 30 fps
against the same build without its constraints, the bust moves at most 6.583 rig px and the hips
(`hip_phys` inertia 0.2, strength 160, damping 0.88, mass 1.5) at most 4.432 (frame 13, the fall
into the landing), and both overshoot after it, 3.38 and 1.38 rig px (frames 21 and 22;
`docs/evidence/sample-hop.png`). No bar here judges the jiggle, and two limits follow from that:

- **The region's `band` caps the displacement.** The patch moves as one piece and the band is
  where the mesh stretches to follow it, so physics values that carry the patch further than
  its band absorbs squeeze or stretch the band's triangles past the texture-stretch ceiling.
  `check` reads the idle alone and does not see it; check's own reading applied to `hop`'s
  geometry with PR #187's values (inertia 0.5, strength 100, damping 0.85, mass 1, a bone
  displacement of 9.85 rig px against bands of 16 and 12) gives
  `CHECK_TEXTURE_STRETCH: mesh "bottomwear" triangle 13 (vertices 5 183 6), edge 6-5, idle frame 13 — the edge is 0.233 times its rest length (max(ratio, 1/ratio) 4.29); <= 1.926544 is required`
  and `topwear` 2.597; with the values tracked now it reads 1.697 (`topwear`) and 1.566
  (`bottomwear`). Tune the constraint against the animation that drives it, not the idle.
- **An added animation can move the idle's figures.** The render's viewport is fitted over
  every animation, and the idle frames share it, so an animation that travels further than the
  idle redraws the idle at another size: adding `hop` to `sample` narrowed the idle render from
  201 to 198 px wide and moved `check.json`'s `BREATH_VISIBLE` `torso_heat_mean` from 7.8 to
  7.705, every status unchanged, although `check` reads the idle alone.

## 4. The command order

Two steps are external: the See-through runs (by any route; the optional `comfy seethrough` adapter is only a client for a ComfyUI box). Everything else is this tool.

**What the config holds at each step.** The config fills in as the loop runs, and
each step reads it through the loader for that point, which requires exactly what
the step reads. `src/config.ts` states it once (`CONFIG_REQUIRES`), the loaders take
their required keys from there, and the selftest compares this table with it
(`AS15`). Every loader refuses unknown and retired keys and checks `generation`
whenever it is present; a section a later step writes may already be there, and an
early loader does not read it.

| loader | steps | requires | the step also refuses without |
| --- | --- | --- | --- |
| `paint` | 0 `comfy paint` | `key`, `generation` | — |
| `layers` | 1 and 4 `inputs`, 6 `assemble --propose-plan` | `key`, `seethrough`, `assemble.rig_scale` | `seethrough.head_box`, for `--propose-plan` only (`ASSEMBLE_FIELD_PRESENT`) |
| `assemble` | 7 `assemble` | `key`, `seethrough`, `assemble.rig_scale`, `assemble.plan` | `seethrough.head_box` (`ASSEMBLE_FIELD_PRESENT`) |
| `full` | 8 `propose --from-config`, `propose --compare`, `compare` (a side that states a `key`), `rig`, 9 `build` | `key`, `assemble.rig_scale`, `assemble.plan`, `bones`, `meshes`, `regions`, `motion` | for `build`, the `assemble` row's too: its assemble stage reads through that loader after this one |

A missing field is `CONFIG_FIELD_PRESENT` naming it; a missing `generation` names
the fields the block holds, and a missing `assemble.plan` names
`assemble --propose-plan`, which prints one. `build` runs `rig`, so it asks the
full loader before its assemble stage writes anything.

0. **The painting (optional).** `rig-parts comfy paint --config config.json --out inputs --host <url>`
   generates `painting_<seed>.png` on a ComfyUI box; any other route to a painting
   skips this step and leaves `generation` out. Config: the `paint` row.
1. **The full image.** `rig-parts inputs --source inputs/painting.png --config config.json --out inputs`
   writes `st_input_full.png`, the painting centred on a white square of its longer
   side: white left and right of a portrait painting, above and below a landscape
   one. The pad is See-through's input only; `propose --head-box` and `assemble` map
   the full run back through it, so the rig stays in the painting's pixels — unlike
   a painting padded to a square by hand, whose padding becomes part of the rig.
   Config: the `layers` row, `head_box` not yet. A translucent painting is refused
   (`INPUTS_PAINTING_OPAQUE`).
2. **See-through, full run** (external).
3. `rig-parts layers inputs/layers/full` — read it. A refusal here is about the
   files, not the art (§6, *Reading the inputs*). A `WARN` line is about the art: a
   layer See-through made that is not plausibly part of the figure, which step 6
   leaves out (§6, *Plausibility*). It refuses nothing.
4. `rig-parts propose --head-box --full inputs/layers/full --canvas <W>x<H>` →
   `seethrough.head_box`. Run `rig-parts inputs` again: it now also writes
   `st_input_head.png`, the painting cropped to that box at its exact size.
5. **See-through, head run** (external), on that crop. See-through's own second,
   head stage does not replace it: that stage's layers are pasted back at the full
   run's scale on every route that was read (README *Getting See-through layers*),
   so the full run's eyes stay at its density — 22×13 px for the demo's right eye
   white at `resolution` 1024, against 60×38 px in the head run.
6. `rig-parts assemble --propose-plan --source … --full … --head … --config config.json`
   → paste `plan` and `extend_below_crop` into `config.assemble`. Config: the
   `layers` row, with `head_box`.
   Read `notes`: a layer left out by a plausibility rule is named there with its
   figures and the rule (§6, *Plausibility*).
7. `rig-parts assemble … --out work` — read its `uncovered hole` lines and look at
   `work/render/recomposite_error_rig.png` (§5): red is painting no part holds, which
   no later stage can see — then
   `rig-parts propose --parts work/rig --source inputs/painting.png --out work` →
   `work/proposal.json` and `work/render/landmarks.png` (+ `_head`). Copy
   `bones`, `meshes`, `regions` and `motion` into the config. Then read what
   was looked at. After the LINT summary, one `coverage <bone> [<role>]:` line
   per bone says `checked, clean` (and which checks read it), `checked, LINT`,
   or `not checked` and why — its role (a `control` binds nothing and may sit
   off the art by design; the role is `src/structure.ts`'s, as `compare`
   prints it), a single bone named as a segment or an explicit
   `[bone, from, to]` segment (the off-art check reads only chain links), a
   region, a mesh that names no part, a torso bone absent, a chain the joints
   declare no line for — and a `coverage:` summary counts the three apart.
   A `not checked` bone is one nothing verified: look at it on
   `landmarks.png`. `work/basis.json` (spec `spine-parts-basis/1`) says, per
   proposed bone, what its origin and its stated tip rest on: `joint` (which,
   with its state and score as the keypoint file declared them), `mask` (which
   part, which measure), `ratio` (which rule, which constants) or `derived`
   (which bones), and `fallback` when a rule stood a value in because what it
   reads was empty; `frame` says where the face box, the eye axis and line,
   the figure and the torso came from. A `ratio` bone or one with a
   `fallback` is a guess to check first. Add `--compare config.json` to have
   each bone also say whether the config's differs (origin, tip, parent, in
   px) or is `proposal only`, and `config_only` list the bones the proposal
   lacks. No confidence is computed. Config for
   `assemble`: the `assemble` row — no rig section yet, because this `propose`
   drafts them from the parts `assemble` writes.
   For a posed figure (seated, reclining), add `--keypoints keypoints.json` (and
   `--person <id>` when the file holds more than one person): the joints it gives
   place the neck, hip, chest and sleeves (§3, *A posed figure*).
8. Correct, then `rig-parts propose … --from-config config.json` to redraw the
   config's own bones and LINT them — every chain link against its mesh's art, and
   the single bones `hip` and `chest` against each other and the figure (a config
   without them prints a `note:` that those lines did not run); repeat until it
   prints no LINT line (exit 0). Add the same `--keypoints` to lint by the joints.
   Config from here on: the `full` row.
   `rig-parts compare --left work/proposal.json --right config.json` says what the
   correction changed, bone by bone: each origin, parent, tip, length and direction
   as its own figure, and the bones renamed, added or removed by name (§5). It reads
   no parts and no painting, and fails only on a bone a `--map` file's `required`
   list names that is missing (exit 1). A proposal is read under the loader's own
   rules for `bones`, `meshes`, `regions` and `motion`.
9. `rig-parts build --config config.json --source inputs/painting.png --full … --head … --out out [--loop]`
   — assemble, rig and check in one process. `propose` is not part of it, on purpose:
   a proposal is a draft, and the config you corrected is the input.
   `--idle-keys direct` is forwarded to the rig stage as `rig` takes it; a config
   with a two-bone ik over chain links the idle keys needs it (§3, `constraints`).
   `rig-parts compare --left config.json --right out/rig/rig.json` reads the rig
   the build wrote against the config it came from: the rig's stage carries it into
   rig px, so every origin reads 0, each chain link's tip, length and direction its
   config's, and every `<bone>_ctl` the rig stage inserted is the bone between a
   keyed mesh bone and its parent (§5).
10. **What a scene requires (optional).** When the motion a scene asks of the rig
    is known — a hand that stays on a cup, a sleeve that takes half an arm's turn, a
    joint that must stay inside a range — write it into a
    `spine-parts-requirements/1` file and hand it to `check` (or `build`):
    `rig-parts check --rig out/rig --parts out --out out/scene --requirements scene.json`.
    Every bar in it is yours; `check` supplies none, solves nothing and poses every
    frame through rig-c (§7, *Declared requirements*). A rig composed of
    several characters is measured the same way, `--rig` naming the composed spec.
11. **Several characters in one rig (optional).** Run steps 0–9 for each
    character on its own, isolated input, to a green `build`. Then write a
    `spine-parts-scene/1` file — the canvas, each character's build and offset,
    an optional background plate with its provenance, and the draw order between
    the characters' slots — and run
    `rig-parts compose --scene scene.json --out scene [--requirements req.json]`
    (§7, *Composing several characters*). Nothing in steps 0–9 changes for it, and
    nothing is inferred from the art: the order, the offsets and the plate's
    provenance are yours.

The selftest runs this order, with the README's flags, on each fetched example from
a config holding only `key`, `seethrough` and `assemble.rig_scale`, pasting each
proposal in as the steps above say (`RL01`); every step must exit 0.

## 5. After each stage: what to read

| stage | read | green looks like | a common red |
| --- | --- | --- | --- |
| `layers` | the table, then the `WARN` lines | every tag the plan will need has opaque pixels; one `face` in the head run; `0 WARN line(s)` | a run whose layer PNG is not its box's size (`LAYERS_PNG_MATCHES_BBOX`); a `WARN  PLAN_LAYER_…` line (§6, *Plausibility*) |
| `sheet` of both runs | the tile list (and the sheet, if you can see) | eyes, irises, lashes and brows as left/right pairs in the head run | a head box that cut off an ornament: move `head_box`, re-run the head crop |
| `assemble` | one line per part, the `pixels:` totals (opaque = visible + occluded; taken; visible but not projected), then `recomposite vs source: mean \|d\|, within 8, error px > 40, uncovered error px`, then `uncovered holes (8-connected): N` and the largest five as `uncovered hole K: <px> px at x,y wxh (between "<part>" <px> px, …)`; and look at `render/recomposite_error_rig.png`. Between the part lines and the totals, one `cut: "<part>" opaque <n> = "<part>" <kept> + "<piece>" <taken> …` line per part an `assemble.cuts` entry cut (below), then one `fringe pushed back: "<part>" <px> px, where the painting shows "<holder>" <px> px, …` line per part whose fringe was cleared (below) | on the examples: `sample` 0.83 / 98.0 % / 4,359 / 1,185, 259 holes, the largest 94 px; `demo` 2.34 / 95.8 % / 10,340 / 1,564, 453 holes, the largest 70 px (default rule) — many slivers along part edges, no hole a region could hide | one large hole: part of the figure is in no layer — a plan entry is missing, hair left the head crop sideways (the demo's `hair_back` is taken from the full run for that reason), or See-through split one garment into two and left the space between them in neither (a skirt as two trouser legs); the `between` parts say where. When neither run holds it at all, an `assemble.patches` entry cuts it from the painting (below) |
| `propose` | `note:` lines, `LINT` lines, the `coverage` lines, `landmarks.png`, `basis.json` | no LINT line: every chain link lies on its mesh's art, and the hip is below the chest and the figure's top quarter; the `coverage:` summary says how many bones that verdict covers — a `not checked` bone was read by no check (its line says why), and a `ratio` or `fallback` bone in `basis.json` is a guess | a link off the art (a bone on the background) — move it onto the layer; `LINT hip at [x, y] is not below chest at [x, y]: …` or `LINT hip at [x, y] is above 0.25 of the figure height (figure y T..B, so hip y must be at least L): a hip at the shoulders` — move `hip` down to the waist (and `chest` between it and the neck); a `hanging strand … -- no chain proposed` note — that strand hangs stiff until you add a chain down the x and rows it names (§3); a `no blink: …` or `blink without brows: …` note — the idle will not blink (or its brows will not drop), because no part came from an `eyewhite` (or `eyebrow`) layer; the note names the tags looked for; a `no eyewhite part for eye_<s> …` note — the iris and lash parts it names ride `head` and do not blink, because no `eyewhite-<s>` part made that side's eye bone: take the eyewhite from the other run, or keep them on `head`; a `no face part: face box derived from …` note (always the first) — `head`, `neck` and every face-height scale come from a box guessed off the hair and neck (§3): check `head` and `neck` on `landmarks_head.png` and move them; when it adds `the blink shuts the eyes over no face part`, read `BLINK_NO_HOLE` after `check` — an eye with no face under it can open a hole (the `sample` with only its face removed: 587 px). Under `--keypoints`: the `lint rule set:` line first (joints, or screen and why), then the joint notes — `missing: the rule "…" placed bone X instead` is a bone still guessed; `not used — …` names why an arm's joints did not place its sleeve; `LINT chest at … is not between the neck joint …`, `LINT hip at … is not past chest …`, `LINT hip at … is nearer the neck joint …` and `LINT <chain><i> at … does not advance from <s>_shoulder toward <s>_wrist` are the joint-frame lines: move that bone between, past or along the joints they name |
| `compare` | one line per pair (origin, parent, tip, length, direction — or SKIP and why), then the per-row summary, the unmapped bones of each side, `required:`, each side's roles and the `controls:` line | proposal against the config you corrected: the rows you changed and no others. Config against the `rig.json` `build` writes for it: measured on both examples, every origin within 6.19e-7 px (the rig's offsets are written to 6 places) and every chain link's tip and length within 4.99e-4 px (`length` is written to 3), printed to three places as `0.000` (a signed figure as `+0.000` or `-0.000`); `parent … is the right's ancestor at depth 2, <bone>_ctl between` for every keyed mesh bone, no `DIFFERENT` and no `NOT MAPPED` | `parent DIFFERENT: left a, right b` — a bone hangs from another parent than the other side's; `frames not related` — a rig with no stage (`skeleton.width`/`height`), two configs at different `rig_scale`: the distance rows SKIP, so declare the frame in a `--map` file if the author knows it; `FAIL  STRUCTURE_REQUIRED_PRESENT` — a bone the map requires is missing through its pairs |
| `rig` (inside `build`) | one line per mesh: vertices, triangles, bones, influences, `cover`; the `bones` line; the `idle keys` line; then rigc's gate lines (with A15's declared SKIP under `--idle-keys direct`); in `rig.json`, each chain link's (or its `_ctl`'s) `length` and `rotation` | `cover 1.00000` on every mesh, both gate summaries `0 failed` (the compile and the packed pages); every link's `length` the distance to the next link and `rotation` its direction (Spine degrees, counter-clockwise, y up, local to the parent), every offset under it — a child bone's `x, y`, a weight's bind `x, y`, a region's `x, y` — in that turned frame, and a region on a link carrying `rotation` that turns it back upright. Nothing moved: `flattenRig` (`src/rig.ts`) turns every offset back and gives the unturned numbers | `RIG_LATTICE_ONE_LOOP`: change that mesh's `grid` |
| `check` (inside `build`) | the gate lines verbatim, the pack line, `loop:` (and `loop physics:` when the rig declares a physics constraint, §7), `seam:`, the six judgement lines, `RECOMPOSITE_HOLES` and, under `--source`, `SETUP_POSE_VS_SOURCE` (§7), `check.json`; the last line says how many of the nine bars measured and names the ones that said SKIP | `check: PASS; 9 of 9 bar(s) measured, 0 skipped` on the examples, and a judgement line SKIP only where the character lacks what it reads; on a rig spec with no `parts.json` or no `idle` (a merged rig, §7 *Measuring a rig rig-parts did not assemble*), PASS with the skipped bars named | `CHECK_SEAM_WITHIN_BAR` or `CHECK_LOOP_CLOSES` (§6) |
| `check --requirements` (and `build --requirements`) | after the lines above, one line per declared requirement, `NAME: PASS`, `FAIL` or `NOT MEASURABLE — …` with its figures, the bar as declared and the worst frame; then `requirements: N declared — M measured (P PASS, F FAIL), K NOT MEASURABLE; not declared: <kinds>`; `check.json`'s `requirements` block; the renders under `requirements/` (§7, *Declared requirements*) | every line PASS and `0 NOT MEASURABLE`; a follow's `released_copy` says whether rigc's consumer-driven door was taken on the throwaway copy | `CHECK_REQUIREMENT_MET` (a figure past its bar; the line names the frame) or `CHECK_REQUIREMENT_MEASURABLE` (the quantity is undefined in the frames: a tip or an axis on a bone of length 0, an aim with no line, a follow no frame of which reaches its least drive); the last line then reads `check: FAIL — B bar(s) not met, R declared requirement(s) not PASS` |
| `compose` | the `[compose]` lines: one per character (its offset, its placed bounds, the shift and how many first-level bones, regions on `root` and weights bound to `root` it moved, its bone, slot, track and constraint counts, its `rig_scale` and idle), the declared order and the slot count it expands to, rigc's gate lines; then the `[check]` lines as for `check`, and `scene.json` | both gate summaries `0 failed`, `check: PASS` with the bars that measured and the ones that said SKIP named — on a composed rig `4 of 9`: the gate, the loop, `CHAIN_LAG` and `TEXTURE_STRETCH` (there is no `parts.json`; each character's own `build` measured all nine). `scene.json`'s `order.slots` is the order the compiled skeleton draws | a `SCENE_*` refusal (§6, *compose*) — the scene file, a build, or the order; `COMPOSE_RIGC_GREEN` — rigc's own line, quoted |
| `loop` (inside `build --loop`, or `loop --frames … --out …`) | the dropped-duplicate line, each file's line, then `loop: idle.png N B (lossless); idle-indexed.png N B (max …, mean …); idle.gif N B (max …, mean …)` | `f0048.png equals f0000.png byte for byte, so it is dropped` | `LOOP_ENCODE` (§6) |

`loop` writes three files from one frame set, and they are not interchangeable.
`idle.png` (`loop --out x.png`) is the lossless APNG: every frame decodes to the
rendered frame byte for byte, so it is the exactness record. `idle-indexed.png`
(`loop --out x.png --palette`) is an indexed APNG — colour type 3, one palette for
every frame (255 median-cut colours and one transparent entry, alpha graded per
entry, no dithering, filter None) — and is the small file to show. `idle.gif`
(`loop --out x.gif`) is the same median cut in a GIF. The indexed APNG and the GIF
print their palette error, per channel over R, G and B of every frame (and alpha's
max for the APNG); a figure is a measurement of the file, not a bar. On the demo:
13,645,503 B lossless, 1,706,719 B indexed and 1,812,288 B GIF, both palette files at
max 57, mean 1.601 — the two share one quantiser, so their error is the same by
construction and the size is the difference. That is `--seam silhouette` (the README's
animation, rig-c 2.1.3, and 2.10.1 to the byte); with `--pack-shape rect` the same
build writes 13,645,350, 1,706,520 and 1,812,238 B, and with `--page-edges pot
--pack-shape rect` 13,645,519, 1,706,785 and 1,812,625 B, all at the same error (2.10.1
reproduces both). The loop shows the blink closed: the
eyes' hold is at least one 12 fps frame (below), so whatever `motion.blink.t` is, one
idle frame lands inside it, and `check.json`'s `BLINK_NO_HOLE.idle_frames_closed`
names it — `[29]` on both examples.

`--seam near-white` (the default) is the reference implementation's rule: where the
flat stack of parts differs from the painting by more than 60, the top part takes the
painting's colour — except where the painting is near-white, which protects the page
and also every white garment. `--seam silhouette` protects near-white pixels only
outside the figure. On the demo it lowered recomposite error pixels from 11,050 to
9,540 and changed no check bar; on the sample it changed nothing. The default stays
the reference's so the examples stay comparable with it.

**The fringe push-back** (issue #119; under either seam rule, no flag). Both places
that write the painting's colour into a part act only at alpha 250 and above, so a
part's anti-aliased fringe in another garment's colour — a scarf's red left on the
edge of a sweater layer, over the sleeve — reaches the rig as See-through drew it,
and `check`'s seam cannot see it (it compares the setup pose with the same parts).
Before the seam override, `assemble` clears a part's pixel when the stack there
differs from the painting by more than 60 (the seam override's own test, and its
rule's near-white guard), the part is drawn after the pixel's holder — the top-most
part at alpha 250 or above — and the holder's own colour is within 60 of the
painting's: the painting shows the holder there, so the pixel is the holder's to
draw. A pixel nothing holds stays (clearing it would open the page), and so does one
over a holder in another colour (clearing it would hand the holder the front part's
colour). The clearing never splits a part's art: a crumb it cuts off is cleared too,
and a cleared bridge to opaque art is put back, so no part gains an island
(`CONTOUR_ONE_ISLAND` reads the islands it read before). `parts.json` records each part's cleared pixels by holder
(`fringe_pushed_back`), the counts in it are taken after, and the assemble line above
names them. On the examples (default flags, measured against the v0.14.0 build of
the same inputs): `demo` 1,193 px over 16 parts, recomposite error pixels 11,050 →
10,340; `sample` 276 px over 15 parts, 4,512 → 4,359; uncovered error pixels and
holes unchanged on both, `check` 9 of 9 on both. The `--seam` and `--project`
comparisons in this section and the `SETUP_POSE_VS_SOURCE` example figures in §7
were measured before it, at v0.14.0.

**Page edges.** `rig`, `check` and `build` pack through `rigc build --pack
--page-edges <v>`, and hand the value to rigc verbatim. The default is `free`,
the least-area page the parts need. `--page-edges pot` is the opt-out: a power of
two on both edges, which is the page every build wrote before this flag. The pack
line says which one ran, because rigc writes `, page edges free` after the padding under
`free`. Measured on the two examples by `tools/atlas_population.ts` with rigc 1.5.1, and
again with rigc 2.0.3, 2.1.3 and 2.10.1 under `--pack-shape rect` (the frames table
by the same idle render), which reproduced every figure in both tables and the one
check figure below (2.10.1: pages, atlases, idle frames and `check.json` byte-identical
to 2.1.3's):

| build | page | covered | page opaque | page / figure |
| --- | --- | --- | --- | --- |
| demo, `pot` | 1024x2048 | 56.3 % | 36.8 % | 2.651 |
| demo, `free` | 967x1338 | 91.2 % | 59.7 % | 1.636 |
| sample, `pot` | 512x2048 | 49.7 % | 28.7 % | 3.294 |
| sample, `free` | 479x1166 | 93.4 % | 53.9 % | 1.755 |

rigc's help states the cost: *"a smaller page, at the cost of region attachments
sampling within 1 LSB of the loose build rather than exactly"*. On these builds
every one of the 49 idle frames differs from the `pot` build, by at most 1 level
in any channel:

| example | idle frames that differ | pixels that differ (all 49 frames) | max \|d\| |
| --- | --- | --- | --- |
| demo | 49 of 49 | 2,373 | 1 |
| sample | 49 of 49 | 651 | 1 |

Only one check figure moved. It had no bar: sample's reported screen-space face
mean in `STILL_REGIONS_DARK`, 11.475 under `pot` and 11.472 under `free` (a pixel
figure the line no longer reports since issue #123; it reads geometry, which the page
does not enter). Every
barred figure and every status is the same under both. The atlas rigc writes says
`filter: Linear, Linear` and has no `repeat` line, so choose `pot` for a consumer
that mipmaps or repeats the page.

**Pack shape.** `rig`, `check` and `build` also hand rigc `--pack-shape <v>`
verbatim (rig-c 2.1.0 and later). `rect` keeps every region's cell apart, the
only packing before 2.1. `polygon`, the default here (rigc's own is `rect`), packs a
region that only meshes draw by its emitted hull, so a neighbour may sit inside its
rectangle where the hull is not, with the padding kept between footprints; a region
attachment stays its rectangle. rigc gates the result on the packed pages with
`A49_PACKED_FOOTPRINTS_DO_NOT_OVERLAP` (SKIP on the compile pass, where every part has
its own page; PASS on the packed pass, both shapes, both examples). The pack line ends
`, shape rect` or `, shape polygon` under either, and `check.json`'s `pack_mode` records
both flags. Measured on the two examples with rig-c 2.1.3, and again with 2.10.1,
whose pages, atlases, idle frames and `check.json` are byte-identical to 2.1.3's under
both shapes and both edges (the full entry, spine-core 4.3.13 beside it),
`rig-parts build` with `--page-edges free` and each shape, the table columns by
`tools/atlas_population.ts`:

| build | page | page area | covered | page opaque | page / figure |
| --- | --- | --- | --- | --- | --- |
| demo, `rect` | 967x1338 | 1,293,846 | 91.2 % | 59.7 % | 1.636 |
| demo, `polygon` | 922x1348 | 1,242,856 (−3.9 %) | 95.0 % | 62.1 % | 1.571 |
| sample, `rect` | 479x1166 | 558,514 | 93.4 % | 53.9 % | 1.755 |
| sample, `polygon` | 477x1151 | 549,027 (−1.7 %) | 95.0 % | 54.8 % | 1.725 |

Covered is Σ region rectangles over page area, as rigc prints it; under `polygon` the
rectangles may overlap where a hull leaves room, so it is not a union and can exceed
100 %. Page opaque is the measure of what the page holds. Under `--page-edges pot` the
shape changes nothing on these two examples: both shapes write 1024x2048 and 512x2048,
and the idle frames are identical.

The cost, from `rect` to `polygon` (the idle `check` renders, `rigc render --animation
idle --fps 12 --max 640`, compared frame by frame, max over R, G, B and A):

| example | idle frames that differ | pixels that differ (all 49 frames) | max \|d\| |
| --- | --- | --- | --- |
| demo | 49 of 49 | 2,594 | 1 |
| sample | 49 of 49 | 740 | 1 |

That is the class `free` already costs (the table above, measured by the same
comparison), a little larger. No figure in `check.json` moved but `pack_mode`: every
bar, every status and every reported figure is the same under both shapes.
`--pack-shape rect` gives back the page and atlas 0.7.0 wrote: on both examples
they are byte-identical to rigc 2.0.3's `--page-edges free` build of the same rig (the
skeleton JSON differs only in its relative `images` path), and selftest `CK53` holds
`rect` to rigc's own rectangle page.

The hull ceiling (rig-parts #58: hull area over rectangle area, 0.812 on demo and
0.814 on sample) is not what the packer realises here: the hollows inside the meshes'
rectangles are worth only what fits into them. On the polygon pages, read off the
atlas, demo's packed rectangles overlap in 21 pairs (17 a region attachment inside a
mesh's rectangle, 4 a mesh inside another's) and sample's in 12 (10 and 2); no two
region attachments overlap. Meshes in place of regions would be rigc's stage 2 of
polygon packing (firejune/rigc#1093), which rigc measured and folded: on the three
production rigs most favourable to it, it adds 0.15 % of the rectangle area over
stage 1 at tolerance 0, and nothing at the mesher's tolerance 1 or under `pot`; on
these two examples −0.3 to −1.3 points. No build converts a region attachment.

`--project core` (the default) is the reference's projection rule: a layer takes the
painting's pixel only inside its top-most `alpha >= 250` area eroded by a 5x5 square,
so a part a few pixels wide (a lash, a brow, an iris) takes none. `--project visible`
keeps the erosion only along a rim where a later layer of the run is in front, and
takes every other top-most `alpha >= 250` pixel; neither rule takes a fringe pixel
(alpha below 250). On the examples it lowered the pixels that are visible but not
projected from 36,227 to 22,476 (`sample`) and 76,801 to 49,672 (`demo`), recomposite
error pixels from 4,512 to 4,116 and 11,050 to 9,820, and the check seam from 0.207 to
0.206 and 0.326 to 0.325, with no other check figure changed. The default stays the
reference's so the examples stay comparable with it. `build` takes both flags.

**`rig --idle-keys ctl|direct`** (and `build --idle-keys`, which forwards the
value to its rig stage; without the flag, or with `ctl`, a build writes and prints
what it did before `build` took the flag). rig-c's `A15_IDLE_NO_MESH_BONE_KEYS`
(profile `spine-html`) refuses an idle that keys a bone a mesh is weighted to. `ctl`
(the default, the reference's answer) gives every such bone a same-origin
`<bone>_ctl` parent and moves its keys there, which passes A15 on any rig-c;
the stage prints `idle keys ctl: N mesh-driving bone(s) keyed …`. `direct` keys the
bones themselves and writes `invariants.idleDrivesMeshes: { "why": … }` into
`rig.json` (rig-c 1.3.0 or later), so A15 reports
`SKIP  A15_IDLE_NO_MESH_BONE_KEYS: declared by the rig (…): idle keys N bone(s) that
drive M mesh attachment(s) totalling V vertices …`, which the stage prints; with no
mesh-driving bone keyed it declares nothing, because rigc refuses a declaration
that switches nothing off. The two write the same slots, skins and keys (`RG18`).
Measured on the examples with `bun tools/idle_cost.ts` (rig-parts #13): `direct`
has 41 bones for the demo's 72 and 32 for the sample's 56; every shown mesh moves on
every idle frame under both (8 of 8 and 6 of 6, so 0 a dirty-skip renderer could
skip); the pose costs 14.8 against 15.3 us per frame (demo) and 8.3 against 8.8 us
(sample), the difference all in `updateWorldTransform`; the rendered idle frames
differ by at most one level in a channel. The default stays `ctl`: the examples'
`expected/rig.json` and `motion.json` are the reference's output, and the
declaration is in the rig spec only, so `rigc validate <build> --profile spine-html`
run on a `direct` build (it has no rig spec to read) refuses A15 once per keyed
bone. No stage runs `validate`: the gate is `rigc build`, which reads the rig spec
and its declaration, and is green on both (`RG19`).

**Patching a hole no layer holds.** When an `uncovered hole` stays large after the
plan is right — both See-through runs dropped a piece of the figure, red in
`recomposite_error_rig.png` — add an `assemble.patches` entry:
the box round the hole in rig pixels, `alpha: "silhouette"` so the page round the
figure is not taken, and a `regions.<name>` bone. Draw it `"back"` (or
`{"before": …}` the part it belongs under) and let the box **reach under its
neighbours**: on the selftest's hem fixture a box that only abutted them raised
`check`'s seam from 0.323 to 0.86 with 16 px over 40, and one reaching two rows
under each measured 0.267 with none [observed] — two regions that merely meet
leave a resampled edge between them in the render. The patch is config, so every
`build` cuts it again; it is never a file added after the build. Re-run `assemble`
and read `uncovered error px` again: a patch covering `n` of the uncovered error
pixels lowers it by exactly `n` (the selftest's `AS17` plants that and counts it).

**Cutting a piece out of a layer.** When one See-through layer holds two things that
must move apart — a scarf end painted into the sweater's `topwear`, both arms in one
`handwear` — add an `assemble.cuts` entry (§3): open `rig/parts/<part>.png` from an
earlier `assemble`, add its `parts.json` `x`, `y` to a pixel's column and row to get
rig pixels, and draw the polygon round the piece. The stage prints, between the part
lines and the `fringe pushed back` lines, one line per cut part in the `pixels:`
line's shape, counted when the cut is made (before the fringe push-back and the seam
pass, which the records are counted after):

    cut: "topwear" opaque 134452 = "topwear" 118973 + "scarf" 15479; band 593 px held by both

Give the piece a `meshes` entry over the bones that should carry it, and take those
bones out of the part it left: on the public `scarf`, the scarf end `robe_r` runs down,
cut out of `topwear` into its own mesh on `robe_r` (and `robe_r` dropped from `topwear`'s
segments) leaves every `topwear` vertex still at wind 6 where the uncut mesh moved
one by 101.5 px [observed, `docs/evidence/scarf-cut.png`]. Where the cut runs through
opaque art, `overlap` decides the seam: at 0 the pieces abut, each edge is resampled
against transparency, and on that cut the seam bar read 170 px over 40 against 50
allowed (`CHECK_SEAM_WITHIN_BAR`); at 1 it read 8, at 2 it read 3, at 4 it read 2
(the uncut build reads 2) [observed].

`parts.json` holds one record per part, in draw order: the plan's, with each patch
and each cut's piece where its `draw` puts it (`"back"` patches first in their own
order, then `"back"` pieces; each `{"before": X}` patch, then each such piece,
immediately behind `X`; `"front"` patches last, then `"front"` pieces). Its counts:

| field | counts |
| --- | --- |
| `opaque_px` | the part PNG's pixels with alpha above 8 |
| `visible_px` | of those, the ones no later layer of their See-through run is opaque (alpha >= 250) in front of — a pixel copied in below the head crop is judged in its extend layer's run |
| `occluded_px` | the rest of `opaque_px`: art the painting does not show, See-through's synthesis by necessity |
| `projected_core_px` | the projection rule's candidates: top-most `alpha >= 250`, eroded (`core`) or kept off a front rim (`visible`) |
| `source_px_taken` | of those, the ones that took the painting's pixel (the reference's count, before any merge) |
| `visible_not_projected_px` | visible pixels whose colour did not come from projection — too thin for the core, a fringe, a rim, refused for drift, or a merge ring |
| `refused_drift_px` | candidates refused because See-through's pixel and the painting's differ by more than 90 |
| `merged_px` | pixels brought in below the head crop, and the ring that closes their seam |
| `seam_override_px` | pixels the seam pass recoloured to the painting |

A part's `from` is `<full|head>:<tag>` — the See-through run and tag, which every
role (`propose`) and every judgement-line region (`check`) is read from — or, for a
patch, `painting:<its own name>`; a cut's piece carries the `<run>:<tag>` of the part
it was cut from, so two records may share one. **A patch is 100 % source**: every pixel is the
painting's, so it is all visible and all taken — `visible_px`, `projected_core_px`
and `source_px_taken` equal `opaque_px`, and `occluded_px`,
`visible_not_projected_px`, `refused_drift_px` and `merged_px` are 0. The reader
refuses a `painting:` record that says anything else, or that names another part
(`PARTS_FROM_KNOWN`, `PARTS_COUNTS_ADD_UP`). No tag rule reads a patch: `propose`
puts it on the nearest trunk bone as a region with a note, and `check` counts it
in no region.

`visible_px + occluded_px = opaque_px`, and every projected pixel is visible; the stage
refuses (`ASSEMBLE_COUNTS_ADD_UP`) rather than write counts that break either, and the
reader refuses a record that breaks them (`PARTS_COUNTS_ADD_UP`). The three visibility
counts are this port's: a `parts.json` the reference wrote has none of them and still
reads, but a record with only some of them is refused. The `pixels:` line after the
per-part lines prints their totals.

After the records, `parts.json` holds a `recomposite` block (this port's too; the
reference's files have none and still read): the flat stack of every part, composited
on white in plan order, against the painting resampled into the rig.

| field | holds |
| --- | --- |
| `mean_abs` | mean over pixels of the mean-channel \|d\|, to 3 places |
| `within_limit`, `within_share` | the share of pixels (to 4 places) whose mean-channel \|d\| is at most `within_limit` (8) |
| `error_limit`, `error_px` | pixels whose max-channel \|d\| is above `error_limit` (40) |
| `covered_alpha`, `uncovered_error_px` | of those, the ones where no part has alpha above `covered_alpha` (128) |
| `hole_count` | the 8-connected components of the uncovered error pixels |
| `holes_listed`, `holes` | the largest `holes_listed` (5) of them, largest first (ties: top row, then left column), each `{px, x, y, w, h, borders}`: its area, its box in rig pixels (y down), and every part with a covered pixel 8-adjacent to it, as `{part, px}` — how many such pixels it covers — most first, then plan order; `borders` is empty for a hole that touches no part |

The areas of every hole sum to `uncovered_error_px`; the reader refuses a block whose
figures disagree (`PARTS_COUNTS_ADD_UP`), whose holes are not largest first
(`PARTS_HOLES_LARGEST_FIRST`), whose box leaves the rig (`PARTS_BOX_INSIDE_RIG`) or
whose border names no part of the file (`PARTS_HOLE_PART_KNOWN`).

`recomposite_error_rig.png`, beside `recomposite_rig.png` (`render/` under `assemble
--out`, the top of `build --out`), is the same measurement as a picture at rig size:
**red** (255, 0, 0) is an uncovered error pixel — painting that no part holds;
**blue** (0, 0, 255) a covered error pixel — a part there, in a colour more than 40
off; every other pixel is the painting in light grey (`192 + luma / 4`, so 192 to
255). The painting is dimmed rather than dropped so a hole reads against the figure it
falls in at contact-sheet size, and grey so no painting pixel can be either flag
colour. Opaque, and the same bytes on every run.

## 6. Refusals: the rule, and what has to change

Every refusal is `FAIL  RULE: object — detail`. Inside `build` it is printed under the
stage's prefix (`[assemble]   FAIL  …`), and the build stops there.

### Reading the inputs

| rule | means | change |
| --- | --- | --- |
| `LAYERS_INPUT_KIND` | the path is neither a directory with `layers.json`, a `layers.json`, nor a `.psd` | the `--full`/`--head` path |
| `LAYERS_MANIFEST_PRESENT`, `LAYERS_MANIFEST_IS_JSON`, `LAYERS_FIELD_PRESENT`, `LAYERS_KEY_KNOWN` | the wrapper's `layers.json` is missing, unparsable, or not the wrapper's shape | the run's output directory; re-export it |
| `LAYERS_PNG_PRESENT`, `LAYERS_PNG_UNAMBIGUOUS`, `LAYERS_PNG_DECODES`, `LAYERS_PNG_MATCHES_BBOX` | a layer's PNG is missing, found in two places, not a PNG, or not its box's size | the run's files |
| `LAYERS_TAG_KNOWN`, `LAYERS_NAME_UNIQUE`, `LAYERS_BBOX_INSIDE_CANVAS` | a layer name that is no See-through v3 tag, a repeated name, a box off the canvas | the run (these are See-through's own outputs) |
| `PSD_FILE_PRESENT`, `PSD_PARSES`, `PSD_IS_RGB8`, `PSD_HAS_LAYERS`, `PSD_LAYER_PLAIN`, `PSD_LAYER_HAS_PIXELS` | the `.psd` is missing, unreadable, not 8-bit RGB, has no layer, or has a layer that is hidden, not at full opacity, or without pixels | the `.psd` |
| `ASSEMBLE_SOURCE_PRESENT`, `ASSEMBLE_SOURCE_DECODES` | the painting is missing or not a PNG | `--source` |
| `SHEET_SOURCE_PRESENT`, `SHEET_PNG_PRESENT` | `sheet`'s painting, or a part PNG a `parts.json` lists, is missing | `--source`, `--layers` |

### Plausibility (`WARN` in `layers`, a note in `assemble --propose-plan`)

See-through writes every tag, and on some seeds it paints a layer the character does
not have: **[observed]** on one full-figure seed (issue #21), a `wings` layer of
490,296 px, mostly translucent grey that had absorbed the white background, on a
character with no wings. Proposed as an ordinary part it became an 832 x 1096 part and
the recomposite error rose to mean |d| 15.01. These are not refusals — the files are
fine — so `layers` prints a `WARN` line and exits 0, and `--propose-plan` leaves the
layer out of the plan, out of the head-run fallback and out of `extend_below_crop`.

`layers` prints three figures for every layer, each over its **opaque** pixels (alpha
above 8, the table's `opaque_px`), on the layer as read:

| column | figure |
| --- | --- |
| `translucent` | the share of opaque pixels with alpha below 128 |
| `background` | the share of opaque pixels whose own colour (straight alpha) has a min channel above 235 — the seam rule's "near-white", applied to the layer |
| `area` | opaque pixels over the opaque pixels of the union of every **other** layer of the run ("the rest of the figure"); `-` when no other layer has any |

Not over alpha above 0: See-through hazes whole canvases at alpha 1..8 (the demo's
full-run face is 99.1 % translucent that way and 4.2 % over its opaque pixels). Not
over the whole union: a layer is part of it, so it could never be more than 1x.

| rule | crossed when | [observed] on the two examples' 116 layers (four runs) |
| --- | --- | --- |
| `PLAN_LAYER_TRANSLUCENT` | judged, and `translucent` above 50 % | the most translucent judged layer is 17.8 % (sample, full run, `front hair`) |
| `PLAN_LAYER_BACKGROUND` | judged, `background` above 50 %, and `translucent` above 25 % | the most background-coloured judged layer is 21.9 % (demo, head run, `topwear`, a white dress); of judged layers above 10 % background, the most translucent is 5.6 % (demo, full run, `handwear-r`) |
| `PLAN_LAYER_OVERSIZED` | `area` above 4x | the largest is 1.681x (demo, head run, `back hair`, which fills the crop) |

**Judged** means `area` at least 0.05x (or `-`). The two colour rules skip smaller
layers on purpose: **[observed]** all 27 example layers of 150 px or more that are above
25 % translucent are small features — lashes, brows, mouths, noses, ears, irises, eye
whites, an earring — antialiased strokes that are mostly rim, and the largest of them is
0.011x; 23 of the 116 layers are judged. The background rule needs translucency too,
because an opaque white garment has the page's colour and is a real part.

No example layer crosses a rule, so their proposals are unchanged. For the haze the
selftest plants (`PL03`, `PL06`: near-white, four pixels in five at alpha 40, 2.000x the
rest of the figure), the `WARN` line and the note say the same thing:

```
  WARN  PLAN_LAYER_TRANSLUCENT: layer "wings" — 80.0% translucent, 100.0% background-coloured, 2.000x the rest of the figure; at most 50% translucent (alpha below 128) for a layer at least 0.05x the rest of the figure is required, so --propose-plan leaves it out
"wings: full run layer 80.0% translucent, 100.0% background-coloured, 2.000x the rest of the figure -> not proposed by PLAN_LAYER_TRANSLUCENT (…), PLAN_LAYER_BACKGROUND (…)"
```

A full-run hair layer the head-run hair would have been extended from says `-> not
extended below the crop by …` instead. **Change:** nothing, when the character does not
have that part. When it does (a real translucent veil, a real white cape that the run
drew faintly), the layer is See-through's best attempt at it: add the entry to
`assemble.plan` by hand and read `assemble`'s `recomposite vs source` figures — or re-run
See-through with another seed.

### The config

| rule | means | change |
| --- | --- | --- |
| `CONFIG_FILE_PRESENT`, `CONFIG_IS_JSON` | no such file, or not JSON | `--config` |
| `CONFIG_KEY_KNOWN`, `CONFIG_KEY_RETIRED`, `CONFIG_FIELD_PRESENT`, `CONFIG_FIELD_TYPE` | an unknown key (a retired one says what replaces it), a missing one, a wrong type; a project's own record under a plain key, or an annotation (`note`, `<name>_note`) holding something other than a string | the named field; a record goes under a key beginning `x-` (any JSON, read by nothing), a remark under `note` or `<name>_note` (a string) — §3 |
| `CONFIG_HEAD_BOX_SQUARE` | `seethrough.head_box` is not a non-empty square | `head_box` — take `propose --head-box`'s |
| `CONFIG_TAG_KNOWN`, `CONFIG_PART_NAME`, `CONFIG_PART_UNIQUE` | a plan entry names no v3 tag, a part name that is not a file name, or a part or layer twice — a patch named like a plan part or another patch, and a cut's `into` named like a plan part, a patch or another cut's, included | `assemble.plan`, `assemble.patches`, `assemble.cuts` |
| `CONFIG_NAME_RESOLVES` | a parent, segment, region, track, blink member, blink still part or bone, extend part, patch or cut `draw.before`, or cut `from` names nothing declared above it (a cut's `from` must be a plan part); or a constraint's `bones`, `target`, `source` or `bone` names a bone `bones` does not declare (the detail names the constraint and lists the bones that exist) | the named reference, or the declaration it needs |
| `CONFIG_BONE_UNIQUE` | a bone or chain declared twice, or `root` declared | `bones` |
| `CONFIG_PART_ATTACHED` | a plan part or a cut's piece with neither or both of a mesh and a region; a patch with a mesh, or with no region | `meshes` / `regions` |
| `CONFIG_RIBS_MODE` | `meshes.<part>.ribs` on a lattice (`grid`) mesh: its vertices are its grid's corners, which no row can move (issue #188) | put the part in `contour` or `auto`, or remove `ribs` |
| `CONFIG_PATCH_BOX` | an `assemble.patches` box with `x1 <= x0` or `y1 <= y0` | that patch's `box` (`x1`, `y1` are exclusive) |
| `CONFIG_AMPS_MATCH_CHAIN` | a chain track's `amps` is not one per link | that track's `amps` |
| `CONFIG_PERIOD_DIVIDES_DURATION` | a period that is not a whole fraction of the idle — the loop could not close | that track's `period`, or `motion.duration` |
| `CONFIG_BLINK_GROUP_MEMBERS` | `motion.blink.eyes` or `motion.blink.brows` is `[]`: a group with no members, which rigc refuses at the gate | a figure with no eyewhite part has nothing to blink: leave `motion.blink` out; one with no eyebrow part: leave `brows` and `brow_drop` out |
| `CONFIG_BLINK_GROUP_UNIQUE` | `motion.blink.eyes` or `motion.blink.brows` names one bone more than once; the detail gives the bone and every index it sits at. rigc refuses it at the gate (`group "eyes" names member "eye" twice`) | name each bone once: the group keys every member it names |
| `CONFIG_BONE_PROPERTY_KEYED_ONCE` | two tracks key one bone property: two single tracks, a single track on a chain link's `rotate`, or a single track on a blink member's `scaley` (`eyes`) or `translatey` (`brows`); the detail names the property and every track by its config path. rigc refuses it at the gate (`animation "idle" has two tracks on eye.scaley; merge them into one track`) | merge them into one track, or key another property or bone |
| `CONFIG_BLINK_BROWS_PAIRED` | `motion.blink.brows` without `brow_drop`, or `brow_drop` without `brows` | state both or neither |
| `CONFIG_STILL_OFF_THE_BLINK` | a `motion.blink.still` entry names a region on a bone the blink's `eyes` does not name (nothing to hold still), or its `bone` is one the blink's `eyes` names (the still piece would blink) | that entry's part, or its `bone` — the eye bone's parent, `head` as proposed |
| `CONFIG_CONSTRAINT_TYPE_KNOWN` | a `constraints` entry's `type` is not one of rig-c's five: `ik`, `transform`, `path`, `physics`, `slider` (spelled as rigc spells them; `IK` is not `ik`) | that entry's `type` |
| `CONFIG_CONSTRAINT_NAME_UNIQUE` | two `constraints` entries of one kind share a `name`; rigc finds a constraint by its kind and its name, so an ik and a transform may share one | rename one |
| `CONFIG_CONSTRAINT_TARGET_DETACHED` | the bone an ik follows (`target`) or a transform reads (`source`) is one of the bones that constraint drives, or sits under one (the detail gives the line of parents) — driving them would move what they follow. This package's refusal: rig-c 2.15.0 gates such a rig green when nothing declares the parentage (measured on the selftest's rig fixture, issue #103) | a bone beside the chain; a scene target is a single bone parented to `root` (§3) |

### inputs

| rule | means | change |
| --- | --- | --- |
| `INPUTS_SOURCE_PRESENT` | no such painting | `--source` |
| `INPUTS_PAINTING_OPAQUE` | the painting has a pixel below alpha 255 | the painting |
| `INPUTS_HEAD_BOX_INSIDE` | `seethrough.head_box` leaves the painting (the crop is not padded) | `head_box` — take `propose --head-box`'s |

### The optional ComfyUI adapter (`comfy paint`, `comfy seethrough`)

| rule | means | change |
| --- | --- | --- |
| `COMFY_HOST_GIVEN`, `COMFY_REACHABLE`, `COMFY_REQUEST_OK` | no `--host`/`COMFY_HOST`, nothing answering there, or a non-200 answer | the host, or the box |
| `COMFY_NODE_PRESENT`, `COMFY_INPUT_KNOWN`, `COMFY_INPUT_SET`, `COMFY_CHOICE_PRESENT` | the box's `/object_info` lacks a node class the graph uses, an input it sets, an input it must set, or a model file it names | install the node or model on the box, or the config value naming it |
| `COMFY_QUEUE_EMPTY`, `COMFY_PROMPT_ACCEPTED`, `COMFY_HISTORY_WITHIN`, `COMFY_RUN_OK` | someone else's job kept the queue busy past `--wait`, the box rejected the graph, the job did not finish within `--timeout`, or it ended in error (quoted) | `--wait`/`--timeout`, or what the quoted error names |
| `COMFY_HISTORY_OUTPUTS`, `COMFY_VIEW_PRESENT`, `COMFY_MANIFEST_NAMED`, `COMFY_MANIFEST_IS_THIS_RUN`, `COMFY_LAYER_NAME` | the job's outputs are missing, unreadable, belong to another run, or name a layer that is not a plain file name | the wrapper's version on the box; report it |
| `COMFY_IMAGE_PRESENT`, `COMFY_OUT_EMPTY`, `COMFY_OUT_FREE` | no `--image`, an `--out` that already holds files, or a seed whose painting is already on disk | `--image`, `--out`, `--seed0` |
| `CONFIG_FIELD_PRESENT` on `config.generation`, `COMFY_PAINTING_SIZE` | `comfy paint` was given a config with no `generation` block (the line names the fields it holds), or the painting that came back is not twice the latent | `config.generation` |

### assemble

| rule | means | change |
| --- | --- | --- |
| `ASSEMBLE_FIELD_PRESENT` | `seethrough.head_box` is missing | `propose --head-box` proposes it (§3) |
| `ASSEMBLE_RIG_SIZE` | `rig_scale` makes an empty rig | `assemble.rig_scale` |
| `ASSEMBLE_HEAD_BOX_INSIDE` | the head box is outside the painting | `head_box` — `propose --head-box` holds it inside |
| `ASSEMBLE_RUN_CANVAS` | a run's canvas is not `resolution` square | `seethrough.resolution`, or the run |
| `ASSEMBLE_PLAN_TAG_IN_RUN`, `ASSEMBLE_EXTEND_TAG_IN_RUN` | an entry takes a tag its run does not hold (the detail lists what it does hold) | that entry's run or tag |
| `ASSEMBLE_PART_OPAQUE` | a part ended with no opaque pixel | drop the entry, or take the tag from the other run |
| `ASSEMBLE_PATCH_BOX_INSIDE` | a patch's box reaches past the rig (the painting times `rig_scale`; the detail gives the size) | that patch's `box` — it is in rig pixels, not painting pixels |
| `ASSEMBLE_PATCH_OPAQUE` | a patch takes no pixel: a `"silhouette"` patch whose box holds none of the figure | move the box onto the figure, or `"alpha": "box"` |
| `ASSEMBLE_CUT_INSIDE` | a cut's polygon has a point past the rig (the detail gives the points and the size) | that cut's `polygon` — it is in rig pixels, not painting pixels |
| `ASSEMBLE_CUT_OVERLAP` | two cuts of one part share a rig pixel (the detail gives the count and the first, `x,y`) | one of the two polygons: a pixel goes to one part |
| `ASSEMBLE_CUT_PIXELS` | a cut takes none of its part's opaque pixels (alpha above 8), or a part's cuts leave it none | draw the polygon over the art; to move the whole layer, rename the plan part instead |
| `ASSEMBLE_COUNTS_ADD_UP` | a part's visible and occluded counts do not add up to its opaque pixels, or a projected pixel is not visible, or a cut part's pieces do not add up to it — an assembler bug, not an input problem | report it with the part named; nothing was written |

### propose

| rule | means | change |
| --- | --- | --- |
| `HEADBOX_FACE_PRESENT`, `HEADBOX_RUN_SQUARE`, `HEADBOX_CANVAS_SIZE`, `HEADBOX_FITS_CANVAS` | the full run has no face or is not square; `--canvas` is not a positive size; or the painting cannot hold the proposed box at its size — its shorter side is the bound (shrinking it would cut the head) | `--full`, `--canvas`, or the painting |
| `PROPOSE_SOURCE_PRESENT`, `PROPOSE_PNG_PRESENT`, `PROPOSE_PNG_MATCHES_BOX` | the painting or a part PNG is missing, or a PNG is not its box | `--source`, `--parts` (re-run assemble) |
| `PROPOSE_FACE_PRESENT` | no part comes from a `face` layer, and the face-less fallback cannot derive a face box either: it needs the head run's `neck` and at least one head-run `front hair`/`back hair` part whose top is above the neck's, and the message names the half that is missing. With both, `propose` does not refuse — it derives the box and says so in its first note (§5) | `assemble.plan`: take the face, or the head run's hair and neck |
| `PROPOSE_ACCESSORY_BODY` | an accessory has nothing above its pendant rows to hang its bone on | that part's plan entry, or author its bones by hand |
| `KEYPOINTS_FILE_PRESENT`, `KEYPOINTS_IS_JSON`, `KEYPOINTS_KEY_KNOWN`, `KEYPOINTS_FIELD_PRESENT`, `KEYPOINTS_FIELD_TYPE` | the `--keypoints` file is absent, not JSON, has a key this reader does not know, lacks one of `spec`, `space`, `width`, `height`, `source`, `people`, or holds a value of the wrong type (a size that is not a whole positive px count, an empty `source`, no people) | the keypoint file (§3, *A posed figure*) |
| `KEYPOINTS_SPEC_KNOWN`, `KEYPOINTS_SPACE_STATED` | the file is not `spine-parts-keypoints/1`, or states a space other than painting-px, origin top-left, y down | convert the file to that space; it is not read as if it were in it |
| `KEYPOINTS_JOINT_KNOWN`, `KEYPOINTS_JOINT_STATE`, `KEYPOINTS_POSITION_STATED`, `KEYPOINTS_POSITION_INSIDE` | a joint name outside body-18, a state outside observed / occluded / missing, an observed joint with no `at` or a missing one with one, or a position outside the `width`x`height` image | that joint |
| `KEYPOINTS_PERSON_UNIQUE`, `KEYPOINTS_PERSON_CHOSEN` | two people share an id; or the file holds more than one person and no `--person` names one, or `--person` names none of them (the message lists the ids) | `--person <id>` |
| `KEYPOINTS_IMAGE_SIZE` | the file's `width`x`height` is not the `--source` painting's | a file measured on this painting |
| `PARTS_*` (`PARTS_FILE_PRESENT`, `PARTS_IS_JSON`, `PARTS_KEY_KNOWN`, `PARTS_FIELD_PRESENT`, `PARTS_FIELD_TYPE`, `PARTS_NAME_UNIQUE`, `PARTS_FROM_KNOWN`, `PARTS_BOX_INSIDE_RIG`, `PARTS_COUNTS_ADD_UP`, `PARTS_HOLES_LARGEST_FIRST`, `PARTS_HOLE_PART_KNOWN`) | the `parts.json` read is not assemble's contract (`PARTS_COUNTS_ADD_UP`: `visible_px + occluded_px` is not `opaque_px`, `visible_not_projected_px` is above `visible_px`, or the `recomposite` block's figures disagree — more uncovered than error pixels, a hole larger than its box, the wrong number of holes listed, listed areas that do not sum to `uncovered_error_px`; the last two codes are the block's order and its border names, §5) | re-run assemble; do not edit `parts.json` |

### rig

| rule | means | change |
| --- | --- | --- |
| `RIG_PART_PRESENT`, `RIG_PART_ATTACHED` | a `meshes`/`regions` key that is not in `parts.json`, a part with neither, or a `painting:` part with a mesh | the config and the plan must name the same parts; a patch is a region |
| `RIG_PNG_PRESENT`, `RIG_PNG_MATCHES_BOX`, `RIG_PART_HAS_ART` | a part's PNG is missing, the wrong size, or has no art pixel | re-run assemble |
| `RIG_NAME_RESOLVES`, `RIG_SEGMENT_DEFINED`, `RIG_CHAIN_POINTS` | a segment names an undeclared bone, a bone with no `tip` and no next link, or a chain too short to make a link | that bone's `tip`, or write the segment out as `[bone, [x0,y0], [x1,y1]]` |
| `RIG_LATTICE_ONE_LOOP` | the lattice over a part does not close into one outline even after the repair passes | that mesh's `grid` |
| `RIG_CONTROL_NAME_FREE` | a keyed, mesh-weighted bone needs `<bone>_ctl` and that name is taken | rename the declared bone |
| `RIG_KEY_FRAME_UNTURNED` | a `translate` key on a bone whose parent is a chain link turned along its chain, or a `scale`/`shear` key (a track, or the blink's `eyes`/`brows` group) on a turned link: the key would act along the link's axis, not the picture's; the detail names the track, the bone and the turn | key the chain's own parent, or key `rotate`; a link whose turn is 0 (a level chain) keeps every key |
| `RIG_BLINK_INSIDE_IDLE` | the blink runs outside the idle | `motion.blink.t` |
| `RIG_BLINK_HOLD_SPANS_A_FRAME` | the tree's `BLINK.hold` is shorter than one frame at `IDLE_FPS`, so for some `motion.blink.t` no idle frame — and no frame of the loop — shows the closed eye; the detail counts the phases that miss and names the first | nothing in the config: `BLINK.hold` in `src/motion.ts`, at least `1/IDLE_FPS` s (§3) |
| `RIG_STILL_ROW_INSIDE_PART`, `RIG_STILL_ROW_CLEAR`, `RIG_STILL_PIECES_HAVE_ART`, `RIG_STILL_NAME_FREE` | a `motion.blink.still` row that is not strictly inside the part, that crosses art (a cut through art changes the render even at rest), that leaves one piece with no art, or whose `<part>_still` slot name another part already has | that entry's `row` — a row with no art between the crease and the lash line — or rename the other part |
| `RIG_RIGC_GREEN` | rig-c refused the rig; its own FAIL or compile-error line is quoted, and nothing was written. A `constraints` field rigc does not read, or a value it refuses, is this line in rigc's words (`constraint "aim" (ik) has a key this compiler does not read: "mixx" (did you mean "mix"?)`), as is `A25_DETACHED_BONE_PARENTAGE` on a declared scene target. So is an ik whose `bones` are more than two, or two of which the second is not the first's child: from rig-c 2.15.0 its rig-spec parser refuses both by name (`ik constraint "reach" names 3 bones …`, `ik constraint "reach": "hem1" is not a child of "body" ("hem0" stands between) …`; firejune/rigc#1205), and this package no longer refuses them itself (issue #103; it did from #92 while rigc's gate passed them). Under `--idle-keys ctl` a two-bone ik over a chain link and its child link is that second refusal too, because the child's `<link>_ctl` stands between them; rigc's remedy names the control, which a config cannot, so when rigc's line says that control alone stands between, the rig stage adds a sentence naming `--idle-keys direct` on the command that ran | the field rigc's line names; for the split pair, `rig --idle-keys direct` or `build --idle-keys direct`, as the line says, which keys the link in place — rig-c's own AUTHORING §5 maps each of its assertions (`node_modules/rig-c/docs/AUTHORING.md`) |

### check and build

| rule | means | change |
| --- | --- | --- |
| `CHECK_RIGC_PRESENT` | no `rigc` binary found (every place looked is listed) | `bun install` |
| `CHECK_INPUT_PRESENT` on `…/parts.json` | `--parts` named a directory without `parts.json` — most often `parts/` itself — or, without `--parts`, the rig directory has none while the directory above it does (build's layout, `<out>/rig` under `<out>/parts.json`). The detail says it: "--parts names the directory holding parts.json and parts/, not parts/ itself (after build, that is build's --out, whose rig is <out>/rig); without --parts it is --rig", and names the parent when the parent holds `parts.json`. With neither (no `--parts`, and no `parts.json` beside `rig.json` or above it), the rig is measured without parts and nothing is refused (§7) | `--parts` — the directory above `parts/` |
| `CHECK_INPUT_PRESENT`, `CHECK_INPUT_IS_JSON`, `CHECK_PART_PNG_PRESENT`, `CHECK_PART_PNG_MATCHES_BOX`, `CHECK_PART_SLOT_PRESENT`, `CHECK_RIG_STAGE_PRESENT`, `CHECK_RIG_STAGE_IS_THE_CANVAS`, `CHECK_RIG_ROOT_BONE`, `CHECK_IDLE_PRESENT` | the rig directory is incomplete or disagrees with `parts.json` (`CHECK_PART_SLOT_PRESENT`: a part with no slot of its own name, which the judgement lines render it by). `motion.json` is required even with no animation in it, because `rigc build` takes `--motion` (a spec with `"animations": {}` builds green); `CHECK_IDLE_PRESENT` is an `idle` that is there with no positive `duration` — an absent `idle` is measured around (§7) | re-run rig (`build` does both) |
| `CHECK_SOURCE_SIZE` | the painting `--source` names is not this rig's: no single `rig_scale` takes its width and height to the stage's (assemble makes the canvas `trunc(w × rig_scale)` x `trunc(h × rig_scale)`), or, with `parts.json` read, its `scale_rig_per_source` does not; or the stage is not whole pixels. Refused before anything is built | the painting the rig was made from — the stage's own size, or the painting `assemble` was given |
| `CHECK_SOURCE_PNG` | `--source` names a file that does not read as a PNG | a PNG |
| `CHECK_SOURCE_GRID` | the setup-pose still and its black-tinted twin (the coverage `SETUP_POSE_VS_SOURCE` reads) did not come back on one grid over one opaque background | a rigc problem; report it |
| `CHECK_RIGC_VERSION` | `rigc --version` is below 1.4.0, or prints no version: its `render` has no `--geometry`, which `TEXTURE_STRETCH` reads. Refused before anything is built | `bun install` (this package depends on rig-c ^2.20.4), or put a newer `rigc` first on `PATH` |
| `CHECK_RIGC_ENTRY`, `CHECK_RIGC_ENTRY_READS` | `rigc --version` names no entry (a rigc below 2.0.0), or names one in neither launcher form (`entry: cli.ts — @esotericsoftware/spine-core <v> present`, `entry: cli_core.ts — @esotericsoftware/spine-core absent — …`); `check.json`'s `rigc_entry` records the one that gated the build | `bun install` |
| `CHECK_RIGC_GREEN` | a rigc step failed; its line is quoted | as `RIG_RIGC_GREEN` |
| `CHECK_LOOP_LAST_FRAME_AT_DURATION` | the idle's last frame does not sit at `duration` | `motion.duration` — a whole number of 1/12 s |
| `CHECK_LOOP_CLOSES` | frame 0 and the frame at `duration` differ (max and first pixel quoted); with a physics constraint, the frames of the rig with every physics constraint left out, and the object says so (§7, *loop*) | a track whose last key is not its first |
| `CHECK_SEAM_WITHIN_BAR` | the setup pose does not reproduce the flat stack of parts | usually a region or mesh placed off its part; compare with `recomposite_rig.png` |
| `CHECK_BREATH_VISIBLE` | the torso (`topwear`), rendered alone, barely moves over the idle — or the feet (`footwear`), rendered alone, move at all | the chest's breath tracks (`motion.tracks` on `chest`), or the torso mesh's `segments`; for the feet, the bone their region rides (`regions.<part>`, `root` in both examples) |
| `CHECK_BLINK_NO_HOLE` | with the blink held shut, the eyewhite box shows the page where the open eye had art | the layer under the eye: the `face` part has no art there. Take the face from the other run, or add a part under the eye; `motion.blink.squash` only hides the hole less |
| `CHECK_CHAIN_LAG` | a rotate track leads (or does not lag) the keyed bone above it, or a chain link swings less than the link above | that chain track's `phase`/`lag` (a positive `lag`, a child `phase` above its parent's) or its `amps` (non-decreasing toward the tip) |
| `CHECK_TIP_OVER_ROOT` | a `handwear`/`bottomwear` part's art in the lower half of its box travels less than 1.4725 times as far as in the upper half, measured from the idle's posed geometry (rig px quoted) | the chain track's `amps` (grow toward the tip), or the mesh's `segments` (the chain must be among them), or its mode: on `scarf`'s short skirt the proposal's lattice reads 1.207 and the same part in `contour` mode 1.738 with the same segments and idle (issue #118) |
| `CHECK_STILL_REGIONS_DARK` | a slot of the face's still set (the `face` slots and every slot drawn over the face that the head bone alone carries) moves relative to the bone the face's slot rides, or a `footwear` slot moves on the screen, by more than the arithmetic's own rounding — measured from the idle's posed geometry (the slot, its largest displacement in rig px, the idle frame and the tolerance quoted) | on the face: a face mesh with a weight on a bone other than the head (`segments`), or one deformed by another bone; on the feet: a mesh weighted to a swinging bone, or a region on the wrong bone. A bang swinging over the face is not this line's failure: its depth is reported (`crossing`), with no bar |
| `CHECK_TEXTURE_STRETCH` | a mesh triangle's edge, in some idle frame, is more than 1.926544 times its rest length or less than 1/1.926544 of it (the mesh, triangle, its three vertices, the edge and the frame are named); or a rest edge has length 0 | the chain tracks' `amps` on the bones that mesh is weighted to (the stretch grows with them), or the mesh's `segments` — a vertex blending two bones that swing against each other |
| `CHECK_SEAM_FRAME_SIZE`, `FRAMES_SIDECAR`, `CHECK_GEOMETRY_FILE` | rigc's render is not what its `frames.json` says, or its `geometry.json` is not a whole `rigc-geometry/1` export of the frames beside it (a frame count, a mesh whose vertex count differs from its rest entry; for the face half, another viewport than `frames.json`'s, other frame indices, the head bone or a feature's bone missing from a frame, a non-finite transform or time) | a rigc problem; report it |
| `LOOP_ENCODE` | the loop encoder refused a frame (translucent pixel in a GIF, a size change) | the frames; for a translucent frame write the lossless or the indexed APNG, which keep alpha |
| `CHECK_PACK_LINE_READS` | rigc printed a `pack:` line that is not `pack: <page> <W>x<H>, <N> region(s), <P>% covered, padding <D>`, then `, page edges free` or nothing, then `, shape rect`, `, shape polygon` or nothing (rig-c 2.1 prints the shape; 1.5–2.0 printed none, read as `rect`); an unknown shape is this refusal; the line is quoted | a rigc this package does not know the output of; report it, with `rigc --version` |
| `CHECK_PACK_PAGE_EDGES` | the pack line disagrees with the `--page-edges` the build was run with — its `, page edges free` clause is there under `pot` or missing under `free`, or a `pot` page is not a power of two on both edges | a rigc problem; report it, with `rigc --version` |
| `CHECK_PACK_SHAPE` | the pack line disagrees with the `--pack-shape` the build was run with — it ends `, shape rect` under `polygon` or `, shape polygon` under `rect`, or it has no shape clause (the 1.5–2.0 form, read as `rect`) under `polygon` | a rigc older than 2.1.0 on `PATH`: rigc 2.0.3 takes `--pack-shape` without a word, packs by rectangles and prints the form with no shape clause, so this refusal is what catches it — `bun install` (this package depends on rig-c ^2.20.4); otherwise a rigc problem, report it with `rigc --version` |
| `BUILD_ARTIFACT_PRESENT` | the packed build lacks its `.json`, `.atlas` or page | a rigc problem; report it |
| `REQUIREMENTS_FILE` | `--requirements` names no file, or one that does not parse as a JSON object. Refused before anything is built (by `build`, before assemble) | the path of a `spine-parts-requirements/1` file |
| `REQUIREMENTS_FIELD` | a field of the file is missing, of the wrong type, or not one the format reads: `spec`, `fps` (no default), `requirements`, each requirement's `name` (letters, digits, underscores; once each), `kind`, `animation` and its kind's fields — every bar among them (`within_px`, `fraction`, `tolerance`, `least_drive` above 0, `within_degrees` from 0 to 180, `lo_degrees` ≤ `hi_degrees`, `within_ratio` ≥ 1) — and each target's `bone`, `animation` and exactly one of `at` and `keys` (times strictly increasing). `note`, `*_note` (strings) and `x-…` (any value) are read by nothing, as in the config | write the field; the bar is yours |
| `REQUIREMENTS_RESOLVES` | a bone, an `ik` or `transform` constraint (by name and `constraint_type`, as rig-c resolves it), a slot, a mesh attachment or an animation the file names is not in `rig.json` or `motion.json`, or a seam's part is not in `parts.json` — the detail lists the ones that are; or an animation whose name cannot be a directory. Refused before anything is built | the name as the rig spells it |
| `REQUIREMENTS_CONSTRAINT_DRIVES` | a `follow` names a bone its constraint does not constrain, or a property it does not drive: an `ik` drives `rotate` only; a `transform` drives `rotate` when a `to` names `rotate`, `translate` when one names `x` or `y` | the constraint's own bone and property |
| `REQUIREMENTS_TARGET_PARENT` | a scene target's bone is the root or is not parented to it, or the root is not at rest at the origin, or the animation keys the root — a stage point is a bone's position only under a root that stands still at the origin | a bone under the root for the scene to place |
| `REQUIREMENTS_TARGET` | a scene target places one bone twice for one animation, places it for an animation no requirement measures, has a key outside the animation's `[0, duration]`, or sits in a group the animation translates | one placement per bone and animation, inside it, for an animation a requirement reads |
| `CHECK_REQUIREMENTS_FRAMES` | a requirement render did not write every frame rigc sampled, or the as-declared, released and full renders of a follow sampled different frames | a rigc problem; report it |
| `CHECK_REQUIREMENT_MET` | a declared requirement measured outside its bar; the figure, its frame and the bar are quoted | the rig or its motion (§7, *Declared requirements*) — or the bar, if the scene asks less |
| `CHECK_REQUIREMENT_MEASURABLE` | a declared requirement is NOT MEASURABLE: what it asks is undefined in the frames, and the reason is quoted. Not a pass | the declaration (a bone with a length, a target off the bone's origin, a least drive the constraint reaches) or the rig |
| `REQUIREMENTS_SEAM` | a `seam` cannot be read against the rig: there is no `parts.json` (a merged rig, §7 *Measuring a rig rig-parts did not assemble*), or the two parts' art does not meet at the setup pose (no 4-adjacent pair). Refused before anything is built | two parts whose art touches, on a rig with its `parts.json` |

### compose

Every refusal below is collected with the others and printed at once, under
`[compose]`; nothing is written (`rig/`, `scene.json` and `check/` are cleared first
and stay absent).

| rule | means | change |
| --- | --- | --- |
| `SCENE_FILE`, `SCENE_SPEC`, `SCENE_FIELD_PRESENT`, `SCENE_FIELD_TYPE`, `SCENE_KEY_KNOWN` | the scene file is missing, not a JSON object, not `spine-parts-scene/1`, or a field is missing, of the wrong type or not one the format reads (`canvas` two positive integers; `characters` at least one, each `id`, `build`, `offset` — an offset is never assumed (0, 0); `order` a list of strings). `note`, `*_note` (strings) and `x-…` (any value) are read by nothing | the field |
| `SCENE_ID_UNIQUE`, `SCENE_ID_FORM` | an `id` repeated, empty, or holding `:` — the separator of a prefixed name — or `/`, `\` or a leading `.`, because an id begins every image file of its character | another id |
| `SCENE_PLATE_PROVENANCE`, `SCENE_PLATE_PRESENT`, `SCENE_PLATE_SIZE` | the plate's `provenance` is not `observed`, `generated` or `unknown`; its image is missing or not a PNG; it is not the canvas's size (it is drawn at canvas (0, 0) and never scaled) | the plate |
| `SCENE_BUILD_PRESENT` | a build directory, or a file `build` writes in it (`parts.json`, `rig/rig.json`, `rig/motion.json` with an `idle`, an image its skin names, `check/check.json`), is missing | run `build` for that character |
| `SCENE_BUILD_GREEN` | the build's own `check/check.json` does not say `PASS` and `gate_spine_html_green` | finish that character first: compose binds finished characters |
| `SCENE_BUILD_FIELD_KNOWN` | a build's `rig.json` or `motion.json` carries a key compose does not know how to prefix or place, or a root with a transform of its own | a rig `build` wrote; a rig written by something else is `check`'s to measure (§7, *Measuring a rig rig-parts did not assemble*), not compose's to merge |
| `SCENE_RIG_SCALE_AGREES` | the characters' `parts.json` `scale_rig_per_source` differ (each named) | one `assemble.rig_scale` for every character; scaling a character in composition is not offered |
| `SCENE_DURATION_AGREES` | the characters' idles are of different durations (each named) | one `motion.duration` |
| `SCENE_CHARACTER_INSIDE_CANVAS` | a character's part boxes, placed at its offset, leave the canvas (the boxes and the canvas px quoted) | the offset, or the canvas |
| `SCENE_ORDER_RESOLVES` | an order entry names no character, or `<id>:<slot>` names a slot that character does not have (its slots listed) | the entry |
| `SCENE_ORDER_ONCE`, `SCENE_ORDER_COMPLETE` | a slot is drawn twice (a slot entry repeated, or an id listed twice), or never (the character's id is absent and some of its slots are named nowhere — they are listed) | name each slot once, or the id for the slots not named elsewhere |
| `SCENE_NAME_PREFIXED`, `SCENE_NAME_RESOLVES` | a build's constraint or `invariants.detached` names a bone its own character does not declare — one another character does (`…_PREFIXED`, naming the prefixed names it could have meant) or none does (`…_RESOLVES`); or a `--requirements` name (bone, target bone, constraint, slot, attachment, seam part) is a bare name some character holds, which the composed rig holds only prefixed | a bone of the same character; in a requirements file, `<id>:<name>` |
| `SCENE_ROOT_SHARED` | a character's idle keys `root` (a track, or a group holding it), or one of its constraints names `root`: the root is every character's, so either would move or reach them all | key or constrain a bone of the character's own |
| `SCENE_INVARIANT_AGREES` | two characters declare `invariants.idleDrivesMeshes` with different `why`s | rebuild with this package's `--idle-keys direct`, whose `why` is one sentence |
| `SCENE_IMAGE_NAME_FREE` | two images compose to one file name (`<id>.<file>`: an id `x` with an image `y.cloth.png`, and an id `x.y` with `cloth.png`) | another id |
| `COMPOSE_RIGC_GREEN` | rig-c refused the composed rig; its line is quoted. A field compose carries as written (a constraint's `mix`, a slot's setup attachment) is rigc's to judge | the build whose field it names |
| `REQUIREMENTS_*` | the `--requirements` file, as for `check` | as for `check` |

## 7. The bars `check` enforces, and what only an eye answers today

`check.json`'s `PASS` is true exactly when all of these hold (the reference
implementation's bars) — each one that measured; a rig with no `parts.json` or no
`idle` skips the ones that read it, by name (*Measuring a rig rig-parts did not
assemble*, at the end of this section):

- `gate_spine-html.txt`: every summary line `(N passed, 0 failed)` — the packed build
  under the `spine-html` profile, gated once over the compile and once over the packed
  pages on disk. There is no `spine` gate of its own: `spine-html` holds every rule
  `spine` measures (on the demo, rigc 1.5.1 and 2.0.3: `validate --profile spine`'s 14
  measured rules are all among the build's 23, the 15 others not in `spine`; rigc
  2.1.3 and 2.10.1: the same 14 among the build's 24, which adds
  `A49_PACKED_FOOTPRINTS_DO_NOT_OVERLAP` on the packed pass, 16 not in `spine`; `CH09`
  holds it on every fetched example);
- **seam**: the setup-pose render against the flat composite of `parts/`: mean
  max-channel |d| ≤ 1.0 of 255, and at most 50 pixels over 40;
- **loop**: idle frame 0 against the frame at `t = duration`: max |d| exactly 0. The bar
  measures the keys (issue #183): a rig that declares a physics constraint — a `rig.json`
  `constraints` entry of `type` `"physics"`, or an entry of `motion.json`'s `physics`
  table — has the two frames read from the same rig and motion with every one left out
  (with a skin's `physics` list and any track keying one), built and rendered as the idle
  is, because rig-c's render resets physics at frame 0 and steps it, so the last frame
  differs from the first by what the simulation is still doing. The constraints left out
  are printed on one line of their own, `loop physics: … "<name>" on bone "<bone>"
  (rig.json|motion.json)`, and written as `check.json`'s `loop_physics` after
  `loop_max_diff`; they are reported, not judged. A rig with none is measured from the
  idle render itself, exactly as before, and writes no such line or key.

On the examples: `sample` 23/23, seam 0.207 with 0 pixels over 40, loop 0;
`demo` (default rule) 23/23, seam 0.326 with 2 pixels over 40, loop 0.

A green gate cannot see a wrong animation, so `check` also writes six **judgement
lines** (issue #11; `TEXTURE_STRETCH`, issue #31), each a key of `check.json` and a console line
`NAME: PASS|FAIL|SKIP — <figures and bars>`, read the same way as the lines above: a
FAIL makes `PASS` false and prints its own `FAIL  CHECK_<NAME>` line (§6); a SKIP
says why the rig gave the line nothing to read, and is neither a pass nor a failure —
report it as not verified. Every region is chosen by the See-through tag in
`parts.json`'s `from`, never by a part's name. Heat is a pixel's largest per-channel
change from idle frame 0, in levels of 255, on the idle's 640-pixel grid.

Each bar follows one rule: a floor is half the weaker example's figure and a ceiling
twice the worse one's, so the weaker example clears it by a factor of two; a bar the
model itself fixes (a part on an unkeyed bone does not move, a lag is above 0, a hole
is 0 pixels) is that value, not a margin — and where the model's value is an error
the model fixes at "nothing moves" and the instrument reads exactly (the still regions,
from geometry since issue #123), the bar is the arithmetic's own rounding, derived, not
measured. A bar is set once, from the figures of the day it was set, and is not chased: the torso floor 3.809 is half of sample's 7.618, which reads 7.617 since the chain links are turned (issue #73), a factor of 1.9997. The figures are this port's, measured on
the two examples [observed]:

| line | measures | bar | `demo` | `sample` | SKIP when |
| --- | --- | --- | --- | --- | --- |
| `BREATH_VISIBLE` | `topwear` parts rendered alone (`rigc render --slot`): heat mean over their box; `footwear` parts alone: heat max over theirs | torso mean ≥ 3.809; feet max ≤ 0 | 15.251; 0 | 7.617; 0 | no `topwear` or no `footwear` part |
| `BLINK_NO_HOLE` | the setup pose with every `scaley` track on the eyewhite slots' bones held at its closed value, against the setup pose, at full size: pixels in the eyewhite box that show the page where the open eye had art | 0 px | 0 | 0 | no `eyewhite` part, or no `scaley` track on its bones goes below its first key |
| ″ (reported) | the same box: each closed-eye pixel's max-channel distance to the nearest colour the open eye's box holds — max, and pixels over 40 | none | 15; 0 | 11; 0 | as above |
| `CHAIN_LAG` | `motion.json`'s rotate tracks read as sines (DFT of the keys: period, amplitude, phase) and arranged by the bone tree — a keyed bone's parent is its nearest keyed ancestor | every lag ≥ 0.001 cycle; amplitude non-decreasing down each unbranched chain | lags 0.040 (neck to head) to 0.120; 12 chains | lags 0.040 to 0.100; 9 chains | no rotate track under another of the same period |
| `TIP_OVER_ROOT` | each `handwear`/`bottomwear` part: how far the centroid of its art travels in the lower half of its box against the upper half — the art's AREA centroid inside each fixed half (cut at h/2), every art pixel (alpha above 8) carried through its attachment's posed triangles from the idle's `geometry.json` and clipped to the half exactly, rig px; `instrument: "geometry"` in the line (issue #118) | ratio ≥ 1.4725 | `bottomwear` 3.222, `sleeves` 4.721 | `bottomwear` 4.956, `sleeves` 11.830 | no such part |
| `STILL_REGIONS_DARK` | from the idle's posed geometry (`geometry.json`), `instrument: "geometry"` in each half (issue #123). **Face:** the still set — the `face` slots, and every slot drawn after the first of them whose art overlaps a face part's at the setup pose, that the head bone alone carries (a region on it, or a mesh whose every weight is it) and that the idle does not key by slot (`deform`, `sequence`, a slot track: `driven_slots`). The head bone is the bone the `face` parts' slot rides in `rig.json`. Each still slot's art (alpha above 8), carried through its posed attachment and back through the head bone's setup-to-frame map on every idle frame, against its setup position: `max_rig_px` (and where, `at`, when it is a motion), `rms_rig_px`, per slot in `still_slots`. **Feet:** the `footwear` slots the same way in screen space — they ride the root, which the idle does not key, so the screen is their own frame. **Reported, no bar:** `crossing` — per slot drawn after the still set's first slot and not in it, how deep its art reaches into the region (`face` on top at the setup pose, clear of where `eyewhite`, `irides`, `eyelash`, `eyebrow` and `mouth` go in the head's frame; for the feet, `footwear` on top), `depth_rig_px`, and the most of it covered on one frame, `area_rig_px2` | each half's `max_rig_px` ≤ its `tolerance_rig_px`: nothing moves, up to the arithmetic's rounding, √2 × 2 × 35 × M² × ulp(C) (below) | face 4.202e-13 ≤ 2.286e-11; `hair_front` crossing 2.816 rig px deep, 89.395 rig px² (frame 47); feet 0 ≤ 2.814e-12 | face 4.418e-13 ≤ 2.286e-11 (`face`, `ear_l`, `ear_r`); `hair_front` 2.194 deep, 50.605 rig px² (frame 23); feet 0 ≤ 2.814e-12 | no `face` and no `footwear` part (one of the two absent leaves that half unmeasured; so do face parts on two slot bones, or idle frames with no `geometry.json`) |
| `TEXTURE_STRETCH` | every mesh triangle's three edges in every idle frame, read from the `geometry.json` the idle render writes (`rigc render --geometry`, rig-c 1.4.0 or later): skinned length over rest length, the rest being the setup pose's bones with no deform. The figure is the rig's worst max(ratio, 1/ratio); each mesh's largest and smallest ratio, with triangle, vertices, edge and frame, is the detail | max(ratio, 1/ratio) ≤ 1.926544 | 1.388: `hair_back` triangle 449, edge 42-43 at 0.720 in frame 26 (largest stretch 1.291, frame 2) | 1.227: `sleeves` triangle 169, edge 126-51 at 0.815 in frame 28 (largest stretch 1.196, frame 5) | the rig draws no mesh, or the render wrote no `geometry.json` |

**`TIP_OVER_ROOT` is measured from geometry, not pixels (issue #118).** Until #118 the
line rendered each part alone at `--max 640` and took, per half of its frame box, the
centroid of every pixel that was not the background; its fields were `root_px` and
`tip_px`, frame px. A half that travels under a frame pixel puts that centroid at the
mercy of which edge pixels the grid flips: over `--max` 620–660 the pixel figure
scattered around the exact one by up to 0.3 frame px whatever the travel [observed,
13 half-bands on the three examples and a variant], and every **root** half on every
example travels 0.04–0.6 frame px, so the ratio's denominator was noise — sample's
`bottomwear` read 4.187–6.849 over the sweep, demo's `sleeves` 2.960–6.503, and sample
with its skirt amplitudes ×0.1 read 0.512–13.53, FAIL or PASS by the grid. The exact
reading of the same definition is the same at every size (4.007 on that skirt, a PASS).
The fields are now `root_rig_px` and `tip_rig_px`, rig px, beside `instrument:
"geometry"`, so an old and a new `check.json` are not read as one instrument. The bar
is the one set from the pixel instrument (half of demo's `bottomwear` 2.945, by the
rule above, not chased); demo's exact 3.222 clears it 2.19 times. The figures the two
instruments give the examples, and `scarf` (whose `bottomwear` is tracked in contour
mode because its lattice fails the line — its README):

| part | pixel, `--max 640` (until #118) | geometry |
| --- | --- | --- |
| `demo` `bottomwear`, `sleeves` | 2.990, 3.287 | 3.222, 4.721 |
| `sample` `bottomwear`, `sleeves` | 4.396, 12.475 | 4.956, 11.830 |
| `scarf` `handwear_r`, `handwear_l` | 6.242, 5.558 | 6.683, 5.345 |
| `scarf` `bottomwear`, lattice / contour | 4.537 / 2.661 | 1.207 / 1.738 |

The part rendered alone at up to `--max 8000` — the motion spanning pixels — converges
on the geometric figure (`scarf`'s lattice `bottomwear` 1.337, 1.316, 1.285, 1.270 at
1200, 2400, 4800, 8000), with one gap not explained: `sample`'s `bottomwear` tip reads
2.342 rig px there against 2.596 from geometry, its root agreeing to 0.4 %.

**`STILL_REGIONS_DARK` is measured from geometry too, and its scope changed (issue #123).**

**What it read until #123.** The face half compared two pixel figures on the idle's
640-pixel grid:
- the heat mean over the face outline carried into the head's frame;
- twice the same mean taken off a calibration render, which moved the whole rig rigidly
  with the head.

Both were means of about one level, and both moved with the grid. Over `--max` 620–660
on the three examples:
- demo read 1.03–1.16 times its calibration;
- sample read 0.95–1.07;
- scarf read 0.99–1.38, with its head-frame mean between 1.350 and 1.869.

The feet half was a screen-space heat mean held to 3.244.

**What the old figures actually read.** Measured exactly from the geometry, they read
nothing that moved.

In all three examples `hair_front` is drawn over the face and weighted to `head` and six
bang bones. Its art swings into the face outline, relative to the head, on every idle
frame:

| | `demo` | `sample` | `scarf` |
| --- | --- | --- | --- |
| deepest reach into the face | 2.816 rig px | 2.194 rig px | 2.479 rig px |
| most face area covered on one frame | 89.395 rig px² | 50.605 rig px² | 31.908 rig px² |

The pixel region dropped a rim of `1 + 1/scale` rig px around every pixel that was not
face. That rim measured 2.83–3.09 rig px over the sweep, which is wider than the bangs
ever reach. Inside it, nothing but the face was on top, and the face moves exactly 0.

So:
- the old wording, "a bang whose art crosses the face outline", passed the examples only
  because the region trimmed the band the bangs swing in;
- the old figure was resampler noise divided by resampler noise.

An exact reading of that wording fails all three examples. Every allowed depth between 0
and about 2.7 rig px would be a number chosen to keep them green.

**What it asks now.** The question is whether the face, and the parts over it that the
head carries, keep their place relative to the head bone.

The still set is derived from the rig and the motion, never from a list:
- the `face` slots;
- every slot drawn after the first of them, overlapping a face part's art at the setup
  pose, carried by the head bone alone, and not keyed by slot in the idle.

A blink or a brow moves on a bone of its own, so it is not in the set; its motion is
intended. A bang weighted to its chain is not in the set either. How deep it swings into
the face is reported per slot as `crossing`, with no bar.

The feet half is the same reading for the `footwear` slots, in screen space.

**The bar is 0 in meaning.** The figure may exceed 0 only by the arithmetic's own
rounding. That rounding is derived, not measured:
- **The arithmetic is double precision.** rigc's core poser reads vertex coordinates and
  weights through `Math.fround`, computes in doubles, and `geometry.json` carries the
  doubles. The float32 inputs are the same in the rest vertex and the posed one, so they
  cancel.
- **35 roundings stand on the longest path to one coordinate:**
  - 4 for the rest vertex and 4 for the posed vertex;
  - 11 for the head's setup-to-frame map;
  - 15 for carrying the vertex back through it;
  - 1 for the difference.
- **Each rounding is bounded.** It is at most 2 M² ulp(C), where M is the largest matrix
  entry (at least 1) and C the largest coordinate.
- **The tolerance follows:** √2 × 2 × 35 × M² × ulp(C). On the three examples it is
  2.286e-11 rig px for the face and 1.407e-12 to 2.814e-12 for the feet.

The examples read 4.2e-13 to 4.4e-13 on the face and exactly 0 on the feet. The
tolerance is a numerical one only; no visual allowance is in it.

**Which other lines see the eyes and the bangs.** `BLINK_NO_HOLE` checks one thing: with
the blink held shut, no background shows inside the eyewhite box. It does not look at
what covers the eyes. Nothing in `check` judges a bang over an eye or over the face; the
reported `crossing` depth is the only instrument for it.

**Before and after, the same builds, only `IDLE_MAX_PX` changed** (scratch copies of the
tree):

| `--max` | before: face mean / calibration (ratio), feet mean, demo · sample · scarf | after: face `max_rig_px`, feet `max_rig_px`, all three |
| --- | --- | --- |
| 620 | 1.283 / 1.196 (1.07), 1.504 · 0.933 / 0.900 (1.04), 0 · 1.350 / 1.360 (0.99), 0 | 4.202e-13, 0 · 4.418e-13, 0 · 4.224e-13, 0 |
| 640 | 1.328 / 1.145 (1.16), 1.619 · 0.898 / 0.897 (1.00), 0 · 1.869 / 1.352 (1.38), 0 | the same |
| 660 | 1.297 / 1.118 (1.16), 1.606 · 0.882 / 0.887 (0.99), 0 · 1.578 / 1.310 (1.20), 0 | the same |

The `STILL_REGIONS_DARK` line is byte-identical at 620, 630, 640, 650 and 660 on every
example.

The selftest's planted cases (by hand):

| plant | before (every size) | after (every size) |
| --- | --- | --- |
| a foot whose root moves `fround(0.05)` rig px | PASS, heat 0.779–0.785 | FAIL, 0.05 rig px |
| a face mesh weighted to a bone sliding `fround(0.05)` under a rolling head | PASS, 0.851–0.855 against 0.936–0.948 | FAIL, 0.05 rig px |

After them, one **reported line** with no bar:

| line | reports | bar | `demo` | `sample` | SKIP when |
| --- | --- | --- | --- | --- | --- |
| `RECOMPOSITE_HOLES` | `parts.json`'s `recomposite` block (§5), read rather than measured: `error_px`, `uncovered_error_px`, `hole_count`, and the largest hole's `px`, `box` (`x,y wxh`) and `borders` (`<part> <px> px`) | none — status `REPORTED`, never FAIL, and `PASS` does not read it | 1,564 px in 453 holes; largest 70 px at 351,155 6x22, `hair_back` 53 px, `hair_front` 12 px | 1,185 px in 259 holes; largest 94 px at 479,412 7x34, `sleeves` 42 px, `topwear` 40 px, `bottomwear` 6 px | `parts.json` has no `recomposite` block (the reference's files) |

It exists because no gate can see what it reports. The seam compares the setup pose
with the flat stack **of the parts**, so a pixel of the painting that no part holds is
missing from both sides and the seam passes over it — a white gap between two legs
See-through made of one skirt built green with 7,671 uncovered pixels (issue #25). The line puts that class of defect into
`check.json`, where an agent that reads only `check.json` sees it. It is not a bar for
the reason the colour-patch half of `BLINK_NO_HOLE` is not one: no threshold is
derivable from the examples — both hold hundreds of holes of a few dozen pixels along
part edges, and whether a hole matters depends on where it is, which the box and the
bordering parts say and a count cannot. Read it as a figure, quote it in a report, and
look at `recomposite_error_rig.png` when the largest hole is more than a sliver.

Under `--source <painting.png>`, a second reported line, also never a FAIL
(issue #77):

| line | reports | bar | `demo` | `sample` | SKIP when |
| --- | --- | --- | --- | --- | --- |
| `SETUP_POSE_VS_SOURCE` | the setup pose against the painting, by `assemble`'s own `measureRecomposite` over the stage's pixels — `mean_abs` and `within_share` (mean channel, within 8), `error_px` (max channel over 40), `uncovered_error_px` (of those, where the pose has alpha 128 or less), `hole_count` and the largest hole's box — with `painting_px`, `stage_px`, `render_px` and `render_scale` beside them. The painting is resampled onto the stage as assemble resamples it (lanczos3, alpha dropped). rigc renders onto an opaque grey, so the pose over white and its alpha are read off a second still of the same pose with every slot tinted black; both are carried onto the stage with the seam's map turned round (bilinear) | none — status `REPORTED`; assemble applies no bar to the figures it measures, so none is derived here | 3.146 / 93.43 % / 12,399 / 1,732, 518 holes, the largest 61 px at 351,157 6x20 (assemble's recomposite: 2.391 / 95.81 % / 11,050 / 1,564, 453) | 1.095 / 97.30 % / 5,348 / 1,239, 313 holes, the largest 88 px at 479,416 6x29 (assemble's: 0.835 / 97.95 % / 4,512 / 1,185, 259) | not written without `--source` |

The figures are assemble's by construction, not a second definition beside them;
what differs is what they are taken of — the pose rigc draws, not the flat stack —
and the gap between the two columns above is that drawing: the render's resampling at
its scale (0.942 on the demo, 1.012 on the sample) and the warp back onto the stage,
which soften every part edge by a pixel or two. It moves with the render's grid
[observed, the demo's still rendered at four sizes: mean 2.663 at scale 1.0003, 3.091
at 1.0073, 3.146 at 0.942, 3.186 at 1.884], so compare the line with itself across
rigs or edits, and with `RECOMPOSITE_HOLES` for where a hole is, not digit for digit
with the recomposite. On the examples the line reads the same with and without
`parts.json` (the still's grid does not move).

What each figure is, and is not:

- **The seam is the answer to "at rest, no gap, white rim or doubled line between
  layers".** A gap shows the page, a rim a colour no part has there, a doubled line a
  part drawn off its place; each changes the setup-pose render against the flat stack,
  which is what the seam bar measures. No separate line is written for it.
- **The blink is measured at the setup pose, not in an idle frame.** Since issue #32
  an idle frame does fall inside the closed window — on both examples the eyes are
  fully shut from 2.37 s to 2.454 s and `idle_frames_closed` is `[29]` (2.417 s) — but
  that frame also carries the idle's sway, so it is not a comparison of what the blink
  alone changed. rigc's `render` takes no time, so the closed pose is a throwaway
  animation holding the blink tracks' closed value, built and rendered beside the
  seam's still on the same grid. `idle_frames_closed` is what says the loop shows the
  closed eye; before #32 it was `[]` on both examples, with the 0.04 s hold between
  frames 28 and 29.
- **The colour-patch figure is not reliable enough for a bar.** "Nearest colour in the
  open eye's box" counts a legitimate colour the open eye never showed (skin under the
  lid) as a patch, and a patch the open eye happened to contain as none. It is
  reported, and 15 and 11 on the examples are what a clean lid looks like.
- **A lag is read modulo half a cycle.** A sine's sign is half a cycle of phase, and
  the keys cannot tell `amp −0.6, phase 0.2` from `amp 0.6, phase 0.7` — the mirrored
  chains of both examples are written the first way — so the reading folds a step into
  (−¼, ¼] of a cycle and reports amplitudes unsigned. A lag of a quarter cycle or more
  cannot be told from a lead. Tracks whose keys are not a sampled sine are listed as
  `unread`, and a keyed bone under a keyed ancestor of another period (the demo's
  tassel under the head) is listed in `other_period` and not compared.
- **Tip over root is a centroid, not a displacement.** Art entering or leaving a half
  moves its centroid too. The halves' mean heat was the brief's first choice and was
  rejected: heat is texture times motion, and on the demo's sleeves the lower half's
  mean heat is 1.1 times the upper half's while its centroid travels 3.7 times as far.
  The halves split the box across its rows, which assumes the part hangs — true of a
  front-facing standing figure, the only input this tool takes.
- **Stretch is read on edges, both ways, and the ceiling doubles |ln r|.** Compression
  distorts a texture as much as stretch — an edge at half its rest length squeezes
  the texels on it by the factor an edge at twice its length spreads them — so the
  figure is max(ratio, 1/ratio), and on both examples the worst triangle is a
  compression (demo 0.720, sample 0.815). The ceiling rule is applied to the quantity
  whose zero means "nothing happened", as it is for heat: for a ratio that is |ln r|,
  so twice demo's |ln 1.388| is ln(1.388²) = ln 1.926544 and sample clears it by 3.2
  times. Doubling the ratio itself (2.776) was rejected: its zero is not at 1, and it
  passes an edge drawn at 2.7 times its rest length. The rest is the art's own
  proportions — on both examples every rest edge equals its `uvs` edge times the
  attachment's size to within 2.4e-5, the uvs' six-decimal rounding.
- **The face is measured in the head's frame (issue #33), from geometry (issue #123).**
  - **Until #33** the face half read the screen-space heat map. There the head's
    intended roll lit the outline on both examples, 16.988 and 11.475.
  - **#33 moved the reading into the head bone's frame.** Its ceiling became twice a
    calibration render's resampler error: the whole rig moved rigidly as the idle
    moves the head.
  - **That reading's region dropped a rim** of `1 + 1/scale` rig px around every
    pixel that was not face. Measured over the rim instead, both examples sat at 1.31
    and 1.34 times their calibration, and the excess was the bangs' art sliding over
    the rim.
  - **Issue #123 measured the same question exactly** and found the trimmed rim was
    the whole story: the bangs reach 2.2–2.8 rig px into the face outline. The rim
    was wider than that, so the pixel figure only ever read resampler noise
    (*`STILL_REGIONS_DARK` is measured from geometry too*, above).
  - **The line now asks what it can answer exactly:** whether the still set keeps its
    place relative to the head bone, up to the arithmetic's rounding.
  - **The line still does not judge a face that moves with the bone its own slot
    rides.** That is the head moving, whatever the bone. A face region on the wrong
    bone is for the feet half and the eye lines to catch.
- **What the still set leaves out, and why.** The blink and the brows move features on
  bones of their own, by design, so those slots are not in the set. A slot the idle keys
  by slot (`deform`, `sequence`, a slot track) moves by design too, and is listed in
  `driven_slots` instead. A bang weighted to its chain moves over the face by design;
  its depth is reported per slot in `crossing`, which no bar reads.
- **The feet are measured in screen space.** They ride the root, which the idle does not
  key, so the screen is their own frame.
  - Until #123 the feet half read the screen-space heat. On the demo the long skirt,
    drawn under the shoes, swings beside them and lit their rim to 1.622.
  - From the geometry, nothing drawn over the shoes enters them on any example, and
    the shoes move exactly 0.
  - A foot moved `fround(0.05)` rig px read a heat mean of 0.78 against the old
    ceiling of 3.244 at every grid, a PASS. It now fails by its 0.05.

Nothing is left that only an eye answers. "No visible texture stretch" left this list
with issue #31 (`TEXTURE_STRETCH`), and "the face outline held still in the head's own
frame" with issue #33 (the face half of `STILL_REGIONS_DARK`, above, read from geometry
since issue #123). A bang over the face or the eyes is still an eye's to judge: `check`
reports how deep it swings (`crossing`) and nothing more.

### Measuring a rig rig-parts did not assemble

`check` takes a rig spec — `rig.json` and `motion.json`, the `rigc-rig/1` and
`rigc-motion/1` pair `rigc build` compiles — not a compiled `skeleton.json`, because
the gate is `rigc build`. A rig merged from several rig-parts outputs — by
`compose` (below), or outside the package (prefixed names, one root, a plate region
at slot 0) — is such a spec, with no
`parts.json` beside it and possibly no `idle`. Each bar then measures exactly when what
it reads is there, and says SKIP with the reason when it is not:

| bar or line | reads | SKIP when |
| --- | --- | --- |
| the gate | the rig spec | never — it always runs, on whatever the spec declares |
| loop | the `idle` | no `idle` in `motion.json` (`check.json`: `loop_max_diff` null, `skipped.loop` the reason) |
| seam | `parts.json` and `parts/` | no `parts.json` (`seam_*` null, `skipped.seam` the reason) |
| `BREATH_VISIBLE`, `BLINK_NO_HOLE`, `TIP_OVER_ROOT`, `STILL_REGIONS_DARK` | `parts.json`'s tags and the idle | either missing, or as in the table above |
| `CHAIN_LAG`, `TEXTURE_STRETCH` | the idle (and `rig.json`) | no `idle`, or as in the table above |
| `RECOMPOSITE_HOLES` | `parts.json`'s `recomposite` block | no `parts.json`, or no block |
| `SETUP_POSE_VS_SOURCE` | the rig spec and the painting | no `--source` |

`PASS` reads every bar that measured, and the last console line says how many did:
`check: PASS; 1 of 9 bar(s) measured, 8 skipped (loop, seam, …)` is a rig whose gate is
green and nothing else was looked at. Without an idle no idle is rendered
(`idle_frames/`, `contact.png` and `motion_heat.png` are not written). The demo's own
rig directory, copied away from its `parts.json`, reads `4 of 9`: the gate, the loop,
`CHAIN_LAG` and `TEXTURE_STRETCH`.

### Composing several characters (`compose`, issue #74)

`rig-parts compose --scene <scene.json> --out <dir> [--requirements <file.json>]`
binds characters this package already built into one rig. Each character runs the
single-character path (§4, steps 0–9) on its own, already isolated input to a green
`build` first; compose reads what that build wrote and changes nothing in it.

```
{ "spec": "spine-parts-scene/1",
  "canvas": { "width": 1664, "height": 1216 },
  "plate": { "image": "plate.png", "provenance": "generated", "note": "…" },
  "characters": [
    { "id": "demo",   "build": "out-demo",   "offset": [0, 0] },
    { "id": "sample", "build": "out-sample", "offset": [832, 0] } ],
  "order": [ "demo", "sample" ] }
```

| field | what it is |
| --- | --- |
| `canvas` | the shared stage, canvas px, y down. The composed rig's stage is the canvas, `root` at its bottom centre, as a single character's is its own |
| `plate` | optional. `image` (relative to the scene file) is a PNG of exactly the canvas's size; `provenance` is `observed` (the painting's own pixels), `generated` or `unknown` (a residual after the people were removed is `unknown` where they stood, and the author says so); `note` is free text. Both are copied into `scene.json` and **judged by nothing** |
| `characters[].id` | the prefix: every bone, slot, attachment (skin entry), constraint (its name, and every bone and path slot it names), `invariants.detached` bone, track, group and easing of that character is renamed `<id>:<name>`. `root` is the one shared root. A name resolves to exactly one character, and nothing resolves across characters without its prefix |
| `characters[].build` | a `build --out` directory (relative to the scene file) whose own `check/check.json` is green |
| `characters[].offset` | `[x, y]`, a translation from the build's rig px to canvas px. Every character is built at one `assemble.rig_scale`, so its rig px are canvas px at scale 1 |
| `order` | the draw order, back to front: a character id (its slots not named elsewhere, in its own order) or one `<id>:<slot>`. Every slot of every character is drawn exactly once. Interleaving is written by naming slots: `["a", "b:arm_l", "b"]` draws `b`'s left arm between `a` and the rest of `b` |

What is composed:

- **Images are `<id>.<file>`, not `<id>:<file>`.** rig-c names an atlas region
  by its PNG's basename, and an atlas region line that holds `:` is read as a
  `key: value` line: measured through rig-c 2.15.0 on the demo renamed
  `demo:<name>` with images `demo:<file>`, `A07_ATLAS_TEXT_SHAPE` fails once per
  region; with the images under a `demo/` folder the rig gates green but the region
  keeps the bare basename, so two characters' `face` would collide. So the
  attachment is `demo:face` and its region `demo.face`, and the compiled skeleton
  carries Spine's `path` for each attachment where the two names differ.
- **The offset is applied once,** to what the character places in `root`'s own
  frame: its first-level bones (the bones whose parent is `root`), and a region on a
  slot `root` carries or a mesh weight bound to `root` — both public examples'
  `shoes` ride `root`. Every other offset, weight bind and region in a rig spec is
  local to a bone the shift already moved. In Spine's axes the shift is the
  character's stage corner carried to its canvas place — `scene.json` records it per
  character, with what it moved. The root is shared, so a character whose idle keys
  it, or whose constraint names it, is refused (`SCENE_ROOT_SHARED`): it would move
  every character.
- **The plate** is a region on the bone `plate` under `root`, the first slot, its
  image at canvas (0, 0).
- **One `idle`** holds every character's tracks; the characters' idles must be of one
  duration. Constraints are carried in character order with their
  `invariants.detached`; `invariants.idleDrivesMeshes` once, when any character
  declares it.
- **Every animation beside a character's idle** — what `motion.animations_from`
  wrote into its `motion.json` (§3) — rides along as `<id>:<name>` after the idle,
  its tracks' bones, groups and easings prefixed as the idle's are and every other
  value as written; the scene schedules none of them, they are the consumer's to
  play. Each is read with the idle's own key lists, so a key compose does not know
  how to prefix is `SCENE_BUILD_FIELD_KNOWN`, as it is on the idle, and a track of
  one that keys `root` is `SCENE_ROOT_SHARED` (issue #183).
- **Gated as `rig` gates its own:** `rigc build --profile spine-html --pack`, the
  compile and the packed pages on disk, in a scratch directory; `--out` receives
  `rig/` (`rig.json`, `motion.json`, `images/`) and `scene.json` only when it is
  green. Then `check` runs over `rig/` into `check/`, as on any rig it did not
  build: without a `parts.json` the seam, `BREATH_VISIBLE`, `BLINK_NO_HOLE`,
  `TIP_OVER_ROOT`, `STILL_REGIONS_DARK` and `RECOMPOSITE_HOLES` say SKIP and why,
  and the gate, the loop, `CHAIN_LAG` and `TEXTURE_STRETCH` measure.
  `--requirements` is forwarded, and its names are `<id>:<name>`.
- **`scene.json`** (`spine-parts-scene-report/1`): the scene file's path as given,
  the canvas, the rig's name (the ids joined by `+`), the pack flags, the plate (its
  image, provenance, note, bone, slot, size, `judged_by: "nothing"`), per character
  its build, offset, `rig_size`, `rig_scale`, placed bounds (the union of its part
  boxes, canvas px), shift and what it moved (`shifted`: the first-level bones, the
  regions on `root`, the count of weights bound to `root`), and its counts, and the
  order —
  as declared and as the slot list it expands to, `judged_by: "nothing"`.

A scene of one character at offset (0, 0) on a canvas of its own size, with no
plate, composes to that character's own build renamed only: on both public
examples `rig.json`, `motion.json`, every image, the atlas, the packed page and
every idle frame are byte-identical once `<id>:` and `<id>.` are taken off, and
`skeleton.json` and `skeleton.model.json` equal as values but for Spine's `path`
and the model's `spine.sha256`, which on each side is the sha256 of its own
`skeleton.json` and so changes with the names (selftest `SC33`).

**Not offered.** Scaling a character in composition (one `rig_scale` is required);
any order, overlap or occlusion inferred from an image — the order is the author's,
and a per-pixel vote that holds for a still pose would not hold once the bodies
move; person detection, segmentation, isolation or occlusion completion (each
character's input arrives isolated); a composed `parts.json`, so the bars that
read See-through tags are measured per character by its own `build`, not over the
scene; a rig `build` did not write.

### Declared requirements (`--requirements`)

The bars above are this package's. What a *scene* asks of the rig's motion — that
a hand stays on a cup, that a sleeve takes half of what an arm's constraint asks of
it, that a joint stays inside a range — is the scene's knowledge (issue #87), so it
travels in a file `check` is given, `--requirements <file>` (`build` forwards it).
Every bar in it is the author's; a missing one is refused by name. Nothing here
solves, guesses a value or chooses a bar: every pose is rig-c's, read from the
world transforms `rigc render --geometry` writes (`rigc-geometry/1`). Coordinates in
the file are stage px, y down, as in the config; a stage pixel is one Spine world
unit (the stage box maps to the world by a translation and the y flip,
`src/coords.ts`); angles are degrees.

```json
{
  "spec": "spine-parts-requirements/1",
  "fps": 12,
  "targets": [{ "bone": "cup", "animation": "reach", "keys": [{ "t": 0, "at": [44, 32] }, { "t": 1, "at": [50, 32] }] }],
  "requirements": [
    { "name": "HAND_ON_CUP", "kind": "contact", "animation": "reach", "bone": "forearm", "point": "tip", "target": { "bone": "cup", "point": "origin" }, "within_px": 0.5 },
    { "name": "SLEEVE_HALF", "kind": "follow", "animation": "reach", "constraint": "sleeve_tf", "constraint_type": "transform", "bone": "sleeve", "property": "rotate", "fraction": 0.5, "tolerance": 0.05, "least_drive": 2 },
    { "name": "EYES_ON_CUP", "kind": "aim", "animation": "reach", "bone": "gaze", "target": { "bone": "cup", "point": "origin" }, "within_degrees": 3 },
    { "name": "ELBOW", "kind": "range", "animation": "reach", "bone": "forearm", "lo_degrees": -10, "hi_degrees": 150 },
    { "name": "SLEEVE_SKIN", "kind": "stretch", "animation": "reach", "slot": "sleeve", "attachment": "sleeve", "within_ratio": 1.3 },
    { "name": "CUFF_ON_HAND", "kind": "seam", "animation": "reach", "part": "sleeve", "neighbour": "hand", "within_px": 1 }
  ]
}
```

**Four outcomes, never merged** (#87):

| outcome | when | what it does to the run |
| --- | --- | --- |
| not declared | the file states no requirement of that kind | the summary line names the kind; not a pass, not a skip of something asked. Without `--requirements` nothing is read, written or printed for it |
| refused | the file cannot be read against the rig (§6, `REQUIREMENTS_*`) | refused by name before anything is built (exit 1) |
| not measurable | it reads and the rig builds, and the quantity is undefined in the frames | `NAME: NOT MEASURABLE — <why>` with the figures that show it, `CHECK_REQUIREMENT_MEASURABLE`; the run does not PASS |
| measured | otherwise | `PASS` or `FAIL` against the author's bar, with the figures and the worst frame; a FAIL is `CHECK_REQUIREMENT_MET` |

**The six kinds**, each over every frame of its animation sampled at the file's `fps`:

| kind | declares | measures | not measurable when |
| --- | --- | --- | --- |
| `contact` | `bone`, `point` (`origin` or `tip`), `target` (`{ "bone", "point" }` or `{ "stage": [x, y] }`), `within_px` | the largest distance between the two points, and its frame; a tip is the origin plus `length` along the bone's x axis | a tip on a bone of length 0, on either side |
| `aim` | `bone`, `target`, `within_degrees` | the largest angle between the bone's axis and the line from its origin to the target; the distance is not judged | the bone has length 0; a frame whose target sits on the origin has no line and is not counted, and with no line on any frame the requirement is not measurable |
| `range` | `bone`, `lo_degrees`, `hi_degrees` | the bone's world rotation less its parent's (the world's, for the root), less the same at the setup pose, as a signed shortest angle: the least and the greatest, and their frames | — |
| `stretch` | `slot`, `attachment` (a mesh), `within_ratio` | `TEXTURE_STRETCH`'s own per-mesh measure (imported, not rewritten): the mesh's worst max(ratio, 1/ratio) over the frames | a rest edge of length 0; no frame shows the mesh |
| `follow` | `constraint`, `constraint_type` (`ik` or `transform`), `bone`, `property` (`rotate` or `translate`), `fraction`, `tolerance`, `least_drive` | below | no frame's drive reaches `least_drive` (the line prints the largest drive there was) |
| `seam` | `part`, `neighbour` (two part names: each is drawn by the slot of its name), `within_px` | below | no seam pair reads on any frame (each pixel off its attachment's rest geometry, or the slot shows nothing) |

**`follow`**, #87's definition to the letter: "bone A takes a fraction `f` of what
constraint C asks of it" is measured from three poses of the same rig over the same
frames, each posed by rig-c and differing in one thing only — *as declared*, the
rig as written, `A(t)`; *released*, C's mix for that property forced to 0 and every
key of that mix in the animation removed, `A0(t)`; *full*, forced to 1, keys removed,
`A1(t)`. For `translate` A is the bone's world origin; for `rotate`, `atan2(c, a)` in
degrees, every difference a signed shortest angle (the line notes a largest drive
over 90°: a drive beyond 180° is not told from its complement). The drive is
`d(t) = A1(t) − A0(t)`; a frame counts when `|d(t)| ≥ least_drive`; the measured
fraction is `F = Σ⟨A(t) − A0(t), d(t)⟩ / Σ|d(t)|²` over the frames that count; PASS
when `|F − fraction| ≤ tolerance`. The line also carries the frames that counted, the
largest drive and its frame, and the largest residual `|A − A0 − F·d|` and its frame
— figures with no bar. It measures the realised follow, not the number in `mix`: a
keyed mix, a later constraint on the bone or physics on it show up in `A(t)` alone.
"Keys removed" is written as every key of that mix holding the forced value (its
curve channel's two value numbers with it), which poses what removing them under a
setup mix of that value poses, while every other field those keys state stays as
written. An ik's mix is `mix`; a transform's is `mixRotate` for `rotate`, and `mixX`
and `mixY` for `translate`.

The released copy rests muted throughout whenever no other animation keys that mix,
and rig-c's gate refuses that — `A47_IK_CONSTRAINT_NOT_MUTED_THROUGHOUT`,
`A48_TRANSFORM_CONSTRAINT_NOT_MUTED_THROUGHOUT`. When rigc refuses the released copy
for that constraint and for nothing else, the copy — never the rig under test —
declares it in `invariants.consumerDrivenMix`, rigc's own door for a mix the consumer
drives, and the line's `released_copy` says so; the full copy drops the constraint's
own declaration if the rig has one, since at 1 it rests live. Any other red line from
a copy is refused, `CHECK_RIGC_GREEN`, quoting rigc.

**`seam`** (issue #111): the seam bar (§7) compares the setup pose with the flat stack
of parts, so it cannot see two parts part in motion. A `seam` requirement can. Its
pairs are read off `parts.json`'s art at the setup pose: every pair (a, b) of
4-adjacent stage pixels with a an art pixel of `part` (alpha above 8, the threshold
meshes are built from) and b an art pixel of `neighbour` that is not `part`'s. On
each frame, each pixel centre's displacement from rest is read off its attachment in
`geometry.json` — the rest triangle holding it and the same barycentric mix of that
triangle's posed vertices (a region is the runtime's two triangles) — and a pair's
opening is the distance between the two displacements: how far the two sides moved
apart or across, in stage px. The line carries the largest opening, its frame and
its pair (`"part" pixel x,y against "neighbour" pixel x,y`), the pair count, and the
pair-frames not read: a pixel no rest triangle holds, or a slot showing nothing, is
counted, never read as 0. It is an upper bound on any gap: what shows through
depends on what is drawn under the seam. Two parts turning together by θ read
2 sin(θ/2) px across a pair one pixel apart (0.105 px at 6°), not 0. A part on a
bone's sway opens its seams by that sway, so the bar is the scene's: what it
declares is how far that pair may part.

**Scene targets.** A `targets` entry names a bone whose parent is the root and gives
it a stage point (`"at": [x, y]`) or stage points at stated times (`"keys"`), linear
between them, the first held before and the last after, for one named animation.
`check` writes it onto a throwaway copy — the bone's setup position is the first
point, the rest are translate keys from it, through the one y door, and the
animation's own translation tracks on that bone are dropped — and poses the copy
through rig-c; a follow's released and full copies carry the same placement. A
root that is not at rest at the origin, or that the animation moves, is refused,
because the stage point would not be the bone's position. In a rig composed of
several characters, a target can simply be another character's bone, named as the
composed rig names it.

**Where it is written**, under `--out`: `requirements/as-declared/<animation>/` (the
render each requirement on that animation reads: the rig under test's own build, or a
copy with its scene targets placed), and, per follow, `requirements/released/<name>/`
and `requirements/full/<name>/` — each a `rigc render` frame set with its
`geometry.json`. The copies' specs and builds are scratch, removed before the stage
returns. `check.json` gains `requirements` — `fps`, the summary and each line by name
— before `PASS`, and `PASS` needs every declared requirement to PASS.

The selftest holds each kind and outcome to a hand value on a generated rig
(`fixtures/reqrig.ts`): a two-bone ik that reaches its scene target holds its contact
and one 5 px short fails it at the frame it is short; an aim-only one-bone ik with a
far target passes and is not judged on distance; a follow at mix 0.5 measures 0.5 on
an ik and on a transform, and the same ik with its mix keyed 0, 1, 1 measures
3.5 / 5 = 0.7 and fails a declared 0.5; a follow whose target asks nothing and a tip
on a bone of length 0 are NOT MEASURABLE and the run is not PASS (`CK68`–`CK79`,
`RQ01`–`RQ22`). A seam between two parts on one rolling bone holds and reads only
2 sin(θ/2) px; the same back part sliding 3 px under its bone opens it by 3 at the
frame the slide peaks; a seam on a rig with no `parts.json` is refused before anything
is built (`CK83`–`CK85`, `RQ30`–`RQ35`).

## 8. What one character costs

| step | sample | demo | source |
| --- | --- | --- | --- |
| painting (GPU) | 20.2 s | 18.3 s | `generation.json` `elapsed_s`, in [spine-parts-examples](https://github.com/firejune/spine-parts-examples) |
| See-through full run (GPU) | 194.9 s | 198.5 s | `inputs/layers/full/meta.json` `elapsed_s` |
| See-through head run (GPU) | 170.9 s | 171.4 s | `inputs/layers/head/meta.json` `elapsed_s` |
| `build` (CPU, user + sys) | 14.6 s | 30.7 s | measured with `/usr/bin/time -p` on an Apple M4 machine under other load, rigc's child processes included; wall clock 12.7 s and 27.5 s |

About 6.5 minutes of GPU and under a minute of CPU per character, before any hand
correction. The GPU figures are one run each on one machine; the painting's figure
excludes choosing among seeds (the demo was chosen from eighteen candidates).
Since issue #33 `check` runs one more `rigc build` and one more idle render (the face
calibration, §7); the idle's `geometry.json` is the one issue #31 already writes. The `build` row
was not re-measured: A/B against the tree before that change, alternating on one
machine under a load average of 5 to 11, the difference in user + sys was +5.6 and
+0.8 s on the demo and +6.5 and −1.6 s on the sample over two rounds — inside what
the load moves the same build by (the pre-change demo build alone took 43.6 to
45.8 s there). Since issue #123 that build and render are gone again — the still regions read the
idle's geometry — and the `build` row was not re-measured for it either.

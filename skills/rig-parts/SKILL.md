---
name: rig-parts
description: Turn one anime character painting and its See-through layer decomposition into a verified 2D character rig (Spine 4.3 skeleton data) — measured parts, weighted meshes, bone chains and a looping idle — with rig-parts, which gates everything through rig-c before it is written. Use for a request to rig or animate a single character painting, to run or read rig-parts layers, sheet, assemble, propose, rig, check, loop or build, or to write or fix a rig-parts config.json. Not for cutting art into parts by hand, for authoring a rig from loose PNGs (that is the rigc skill), for lip-sync or swapping a part's image, or for running See-through itself.
license: MIT
compatibility: Requires Bun 1.2 or later. The tool is the npm package rig-parts (bunx rig-parts, or bun add -d rig-parts); rig-c is installed with it. See-through is run separately.
---

# rig-parts — a painting to a Spine rig, for agents

rig-parts merges See-through's two layer runs over one painting into rig-space
parts, authors a rig spec and a motion spec over them, and hands those to
rig-c, which compiles, gates, packs and renders. You cannot see the painting,
the layers or the rig. The printed lines, `docs/AUTHORING.md` and the files each
stage writes are the whole interface.

## Non-negotiables

- **rig-c's gate is never bypassed.** rig-parts writes no Spine data
  itself; `rig` writes only after rigc's `build` gate is green, and `build`'s
  artifact is what rigc wrote. There is no flag that skips it, and none may be added.
  `check.json`'s `rigc_entry` names which gate ran: rigc's own validator in an
  install, the spine-core round trip where the runtime is installed beside rigc.
- **No value is invented.** A missing config field is a refusal naming it. Take a
  value from the command that proposes it (`propose --head-box`,
  `assemble --propose-plan`, `propose`) or decide it yourself — never guess one
  because the tool refused.
- **The refusal is the instruction.** `FAIL  RULE: object — detail` names the object,
  the value found and the value required; AUTHORING §6 maps every rule to the field
  or input that has to change.
- **Green is not "looks right".** `check` measures the gates, the seam, the loop and
  six judgement lines (`BREATH_VISIBLE`, `BLINK_NO_HOLE`, `CHAIN_LAG`,
  `TIP_OVER_ROOT`, `STILL_REGIONS_DARK` — its face half in the head's own frame —
  and `TEXTURE_STRETCH`) (AUTHORING §7). A judgement line that says
  SKIP was not verified: report it as such, with its reason, never as passed.
  No line judges a bang over the face or the eyes: `STILL_REGIONS_DARK`'s
  `crossing` reports how deep each one swings, and only an eye can say whether
  that reads right.
- **What a scene asks is declared, not assumed.** When the request says what the
  motion must do — a hand on a cup, a sleeve taking half an arm's turn, a joint
  inside a range, a fringe that must not part from the face — write it into a `spine-parts-requirements/1` file and pass
  `check --requirements <file>` (or `build --requirements`); every bar in it is the
  requester's, never yours to invent (AUTHORING §7, *Declared requirements*). Each
  line is PASS, FAIL or NOT MEASURABLE; a NOT MEASURABLE is not green, and a kind the
  file does not declare was not measured — say so, never "passed".
- **A hole in the layers is invisible to every bar.** Painting that no part holds is
  missing from the setup pose and from the flat stack alike, so the seam passes over
  it. `assemble` lists it (`uncovered hole N: <px> px at x,y wxh (between …)`) and
  paints it red in `recomposite_error_rig.png`; `check` copies it into `check.json` as
  `RECOMPOSITE_HOLES`, a REPORTED line with no bar. Read it; never report it as a
  pass.

## The loop

1. `rig-parts inputs --source <painting> --config config.json --out <dir>` writes
   `st_input_full.png`, the painting on a white square. The config needs only `key`,
   `seethrough` and `assemble.rig_scale` at this point. Run See-through on it — any
   route; the optional `comfy seethrough` adapter only talks to a ComfyUI box.
2. `rig-parts layers <full run>` — read the table. A `WARN  PLAN_LAYER_…` line names
   a layer See-through invented (a translucent haze, or one out of proportion);
   the plan step leaves it out and says so in its `notes`.
3. `rig-parts propose --head-box --full <full run> --canvas <W>x<H>` → put
   `head_box` in the config, run `inputs` again (it now also writes
   `st_input_head.png`, the crop at that box), and run See-through on the crop.
4. `rig-parts assemble --propose-plan …` → `config.assemble.plan` and
   `extend_below_crop`.
5. `rig-parts assemble … --out work` — read the `uncovered hole` lines and look at
   `work/render/recomposite_error_rig.png`; a large red hole between two parts is a
   gap See-through left (a skirt split into two legs), fixed in the plan or the layers,
   not in the rig. Then `rig-parts propose --parts work/rig
   --source <painting> --out work` → copy `bones`, `meshes`, `regions`, `motion`
   from `proposal.json` into the config. `assemble` needs the plan and none of
   those four; do not stub them to get past it (AUTHORING §4 says what each step
   requires). If an `uncovered hole` stays large with the plan right — a piece
   of the figure neither run holds, red in `recomposite_error_rig.png` — add an
   `assemble.patches` entry (a rig-pixel box, `alpha: "silhouette"`, drawn
   `"back"` and reaching under its neighbours, its bone in `regions`) and assemble
   again; never add a part to `rig/` or `parts/` by hand (AUTHORING §5).
   A seated or reclining figure: add `--keypoints <file>` (body-18 joints in
   painting px, each observed, occluded or missing; AUTHORING §3, *A posed
   figure*) so the neck, hip, chest and sleeves follow the pose and LINT reads
   the joints, not screen y. Never write a joint you did not get from an
   estimator or the painting: say `missing` and let the rule stand in.
6. Correct against `render/landmarks.png` and `note:` lines; a
   `coverage … not checked` line is a bone no check read (the line says why),
   and `basis.json` beside the proposal says what each bone rests on — check
   the `ratio` bones and any with a `fallback` first. `propose …
   --from-config config.json` (with the same `--keypoints`) until it prints no
   `LINT` line. `rig-parts compare
   --left work/proposal.json --right config.json` lists what the correction changed,
   bone by bone — origin, parent, tip, length, direction (AUTHORING §4).
   A constraint the motion needs (an ik reaching a scene target, physics on a
   link) goes in `config.constraints`, in rig-c's own rig-spec shape: the
   loader resolves the bones it names and nothing else, and rigc's gate refuses
   the rest in its words. A scene target is a single bone under `root`. A two-bone
   ik over links the idle keys needs `--idle-keys direct` on `rig` or `build`
   (rigc refuses the pair the link's control splits, and the line names the flag
   on the command that ran; AUTHORING §3).
7. `rig-parts build --config … --source … --full … --head … --out out --loop`
   (add `--idle-keys direct` when step 6 said so).
   It stops at the first stage that refuses, printing that stage's lines under
   `[assemble]`, `[rig]` or `[check]`. Fix what the FAIL line names and build again.
8. Read `out/check/check.json` — the six judgement lines the same way as the seam
   and the loop: a FAIL names the field to change (AUTHORING §6);
   `TEXTURE_STRETCH` names the worst mesh triangle (slot, triangle, vertices, edge,
   frame), so quote it even on a PASS. Quote
   `RECOMPOSITE_HOLES` (uncovered px, hole count, the largest hole's box) in the
   report whatever `PASS` says. The artifact is the three paths the build prints
   last: `check/build/skeleton.json`, `skeleton.atlas` and the packed page. Report
   them with the pack line and the check figures verbatim.

Several characters in one rig: build each one green on its own, then
`rig-parts compose --scene scene.json --out scene` (spec `spine-parts-scene/1`:
the canvas, each character's `build` and `offset`, an optional plate with its
`provenance`, and the `order` of the characters' slots, back to front). You write
the order and the offsets; nothing infers them, nothing scales a character, and
nothing detects or separates people. Report the plate's provenance as you declared
it and the order as `scene.json` records it (AUTHORING §7, *Composing several
characters*).

`--seam silhouette` repairs more of the seam on white garments than the default
`near-white` (the demo: 11,050 → 9,540 recomposite error pixels); the default is
the reference implementation's rule. `--project visible` lets thin visible parts
(lashes, brows, irises) take the painting's pixels, which the default `core` rule
erodes away. Name both rules you used in your report, and quote the assemble
`pixels:` line: its occluded share is hidden art, its "visible but not projected"
share is synthesis where the painting was there to be taken.

## What this will not do

- Run See-through or generate the painting itself. The optional `comfy seethrough`
  and `comfy paint` commands drive a ComfyUI box you name; nothing else here reaches
  a GPU or the network.
- Give a layer two depths: a layer in front of another in one place and behind it in
  another is right in the still and wrong in motion.
- Propose, key or judge any animation but the looping `idle`, or lip-sync: every slot
  holds one attachment, so nothing swaps a part's image. Expressions and a jiggle are
  yours to build on top (below).
- Write animated WebP: `loop` writes GIF and APNG.
- Know what the art does not tag: a swinging element painted inside another layer,
  hair of an unfamiliar shape, whether an accessory swings. Those are yours to add.
- Promise a success rate. Three public characters and eight private ones check green;
  that is all that has been measured.

## Where to read next

[docs/AUTHORING.md](https://github.com/firejune/rig-parts/blob/main/docs/AUTHORING.md)
first — every config field, the command order, what to read after each stage, every
refusal. It is in the installed package at `node_modules/rig-parts/docs/AUTHORING.md`,
the copy that matches the version you run. Two recipes there cover what this package
leaves to you:

- An expression or any other named animation: AUTHORING §3, *Recipe: expressions and other
  named animations* (`motion.animations_from`; built and gated with the rig, not measured).
- A jiggle (a bust, the hips): AUTHORING §3, *Recipe: a soft region driven by physics* (a
  config-only bone, a `contour` region on it, a `physics` constraint; `examples/sample`
  carries one, and its slow idle barely moves it).

A `RIG_RIGC_GREEN` or `CHECK_RIGC_GREEN`
line quotes rig-c's own assertion; rig-c's guide for those is
`node_modules/rig-c/docs/AUTHORING.md`, and its `rigc` skill covers the compiler.

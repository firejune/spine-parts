# Interface stability

This page states what **1.0.0 holds stable**, and what it does not. Every item is
read off the tree: the command and flag lists below are held to
`cli.ts`, and the config field list to the loader in `src/config.ts`, by the
selftest's `TY13` and `TY14` (the `tree` suite), so neither list can drift from the
code without a red run. What changed for an author coming from 0.16.0 is
[MIGRATION.md](MIGRATION.md).

## What "stable" means here

From 1.0.0 the package follows semantic versioning over the items on this page. A
stable item is not removed, renamed, or given another meaning inside a major
version; a new command, flag, optional config field, report key or refusal may
arrive in a minor version, because a reader written against the old surface still
reads it. A refusal may be retired in a minor version when what it refused becomes
accepted (0.13.0 retired two ik refusals that way, when rig-c's parser took them
over).

The list was frozen for review at the release candidate 1.0.0-rc.1, and 1.0.0 was
promoted from it after the owner's acceptance of the production evidence (issue #126,
item 7; `docs/evidence/production-trial.md` in the repository). Every interface
change between the two is additive, and [MIGRATION.md](MIGRATION.md)'s *Since
1.0.0-rc.1* names each one, with the build bytes that moved.

Bytes are a separate promise, and a narrower one: **one version of this package
with one installed rig-c writes the same bytes for the same inputs** (*Determinism*
below). A build's bytes are not promised across versions. A later version may move
them, and when it does, the change that moves them declares which bytes and why (the
winding change of #133 is the example: [MIGRATION.md](MIGRATION.md)).

## Commands and flags

Exit codes are part of the interface: **0** the command did what it says, **1** it
refused its input (every reason a `FAIL` line), **2** a usage error or a command
this version does not implement. No command is unimplemented at 1.0.0 (`LATER`
in `cli.ts` is empty). A refusal line has the shape
`  FAIL  <RULE>: <object> — <value found>; <value required>`: the rule name is a
stable identifier, and the detail after it is prose that may be reworded. A command
also answers to the alias `spine-parts` as long as the install keeps it
([MIGRATION.md](MIGRATION.md)). `-h`, `help` and `-v` are the short forms of
`--help` and `--version`. The flags' meanings are `rig-parts --help`'s; their
defaults are the help's too, and none is guessed from the art.

<!-- stable:commands -->
| command | flags |
| --- | --- |
| `layers` | one positional path: a wrapper directory, a `layers.json` or a `.psd` |
| `sheet` | `--source`, `--layers` (repeatable), `--out`; optional `--cell`, `--cols` |
| `inputs` | `--source`, `--config`, `--out` |
| `comfy` | `paint`: `--config`, `--out`; optional `--seeds`, `--seed0`, `--host`, `--wait`, `--timeout`, `--poll` |
| `comfy` | `seethrough`: `--image`, `--out`; optional `--resolution`, `--steps`, `--seed`, `--prefix`, `--offload`, `--lama`, `--nf4`, `--host`, `--wait`, `--timeout`, `--poll` |
| `assemble` | `--propose-plan` with `--source`, `--full`, `--head`, `--config`; or `--source`, `--full`, `--head`, `--config`, `--out`, optional `--seam` (near-white, silhouette), `--project` (core, visible) |
| `propose` | `--head-box` with `--full`, `--canvas` |
| `propose` | `--parts`, `--source`, `--out`; optional `--compare` or `--from-config` (one of them), `--keypoints`, `--person` (with `--keypoints`) |
| `compare` | `--left`, `--right`; optional `--map` |
| `rig` | `--config`, `--parts`, `--out`; optional `--idle-keys` (ctl, direct), `--page-edges` (pot, free), `--pack-shape` (rect, polygon) |
| `check` | `--rig`, `--out`; optional `--parts`, `--source`, `--page-edges`, `--pack-shape`, `--requirements` |
| `loop` | `--frames`, `--out`; optional `--palette` |
| `build` | `--config`, `--source`, `--full`, `--head`, `--out`; optional `--seam`, `--project`, `--page-edges`, `--pack-shape`, `--loop`, `--requirements`, `--idle-keys` |
| `compose` | `--scene`, `--out`; optional `--requirements` |
| (none) | `--version`, `--help` |
<!-- /stable:commands -->

`TY13` holds the first column to the commands `cli.ts` dispatches and the set of
flags named anywhere in the table to the set of flags `cli.ts` spells. It holds the
names, not which command takes which flag: that pairing is the CLI's, and the `cli`
suite's controls read it from the help.

## The config contract

`src/config.ts` is the schema and the loader, and
[AUTHORING §3](AUTHORING.md#3-configjson-field-by-field) explains every field. The
rules that make the contract:

- **Every key is known or refused** (`CONFIG_KEY_KNOWN`), a required key that is
  missing is refused by name (`CONFIG_FIELD_PRESENT`), and nothing is defaulted
  from the art. A field absent where absence means "none" (a contour's `stray`, an
  automatic mesh's `minAngle`) is written as that in the report, never filled in.
- **Two open doors, and nothing reads behind them**: `note` and any key ending in
  `_note` hold a string anywhere an object is; any key beginning `x-` with a name
  after it holds any JSON value in the same places. They are not open in `meshes`,
  `regions` or `motion.blink.still`, whose keys are part names.
- **Coordinates** in `bones`, `meshes` and `motion` are rig pixels, y down, origin
  top-left.
- **A mesh is one of three modes**: `grid` (the lattice, what `propose` writes),
  `contour` (the traced outline with declared interior points) or `auto` (the
  automatic mode: the contour mesh at alpha 1 and above reduced by rig-c's
  `reduceMesh` under declared bounds, written only when its motion against the
  unreduced source passes the author's bounds). Two, or none, is
  `CONFIG_MESH_MODE`. The top-level default does not change: `propose` writes
  `grid`, and a config that names no `auto` builds as it did before the mode
  existed.
- **`constraints`** are rig-c's own rig-spec constraints (`RigConstraint` in
  rig-c's `src/rig.ts`), handed to rigc as written; this loader checks their
  `type`, their `name` and that every bone they name resolves.

The fields, object by object (a bold path is where the object sits; `<part>` is a
part name, `[i]` an entry of a list):

<!-- stable:config -->
- **config** — required by the full loader, in front of rig and build: `key`, `assemble`, `bones`, `meshes`, `regions`, `motion`; optional: `generation`, `seethrough`, `constraints`
- **generation** — required: `checkpoint`, `loras`, `trigger`, `identity`, `sampler`, `costume`, `negative_extra`, `style`, `negative_pose`, `latent`, `seed`; optional: `pose`, `control`
- **generation.loras[i]** — required: `name`, `strength`; optional: `strength_clip`
- **generation.sampler** — required: `steps`, `cfg`, `sampler`, `scheduler`
- **generation.control** — required: `skeleton`, `strength`, `end_percent`; optional: `model`
- **seethrough** — required: `resolution`, `steps`, `seed`, `offload`; optional: `head_box`
- **assemble** — required: `rig_scale`, `plan` (from plain `assemble` on); optional: `extend_below_crop`, `patches`, `cuts`
- **assemble.extend_below_crop[i]** — required: `part`, `run`, `tag`
- **assemble.patches[i]** — required: `name`, `box`, `alpha`, `draw`
- **assemble.patches[i].draw**, when an object — required: `before`
- **assemble.cuts[i]** — required: `from`, `into`, `polygon`, `draw`, `overlap`
- **assemble.cuts[i].draw**, when an object — required: `before`
- **bones[i]**, a single bone — required: `name`, `parent`, `at`; optional: `tip`
- **bones[i]**, a chain — required: `chain`, `parent`, `points`, `tip`
- **meshes.&lt;part&gt;** — exactly one of `grid`, `contour`, `auto`; required in every mode: `r`, `segments`; optional in every mode: `exponent`, `rule`; optional with `contour` or `auto`: `ribs`
- **meshes.&lt;part&gt;.ribs.&lt;chain&gt;** — required: `stations`
- **meshes.&lt;part&gt;.contour** — required: `tolerance`, `margin`, `spacing`; optional: `budget`, `stray`, `regions`
- **meshes.&lt;part&gt;.contour.regions[i]** — required: `name`, `shape`, `bone`, `spacing`, `band`, and `cx`, `cy`, `r` for a circle or `points` for a polygon
- **meshes.&lt;part&gt;.auto** — required: `source`, `sourceBounds`, `targets`, `influences`, `budget`, `minArtSamples`, `motion`; optional: `protect`, `regions`, and the three Stage B opt-ins `boundaryRuns`, `retriangulate`, `removalOrder`
- **meshes.&lt;part&gt;.auto.source** — required: `tolerance`, `margin`, `spacing`; optional: `stray`
- **meshes.&lt;part&gt;.auto.sourceBounds** and **meshes.&lt;part&gt;.auto.targets.artFit** — required: `minCoverage`, `maxOvershoot`, `maxUndercut` (each of the last two a number or null, the bound declared absent)
- **meshes.&lt;part&gt;.auto.targets** — required: `artFit`, `maxBoundaryDeviation`; optional: `minAngle`
- **meshes.&lt;part&gt;.auto.influences** — required: `maxInfluences`, `minWeight`
- **meshes.&lt;part&gt;.auto.budget** — required: `maxCandidates`
- **meshes.&lt;part&gt;.auto.motion** — required: `maxLocalDeformation`; optional: `maxStretch`, `minStretch`, `deformMayFold`, `gradation`, `selection`, `residual`
- **meshes.&lt;part&gt;.auto.motion.selection** — required: `policy`, `maxProbes`
- **meshes.&lt;part&gt;.auto.motion.residual** — required: `maxResidual`
- **meshes.&lt;part&gt;.auto.protect** — optional: `hull`, `vertices`, `edges`, `regionBoundaries`, `weightJump`, `influences`
- **meshes.&lt;part&gt;.auto.regions[i]** — required: `name`, `shape`, `maxEdgeLength`, `transition`, `grade`, `minArtSamples`, and `cx`, `cy`, `r` for a circle or `points` for a polygon; optional: `bone`, `band` (both or neither; with neither the region is density only)
- **meshes.&lt;part&gt;.auto.boundaryRuns** — required: `maxVertices`
- **regions.&lt;part&gt;** — a bone name
- **motion** — required: `duration`, `tracks`; optional: `blink`, `animations_from`
- **motion.tracks[i]**, a single track — required: `bone`, `prop`, `amp`, `period`, `phase`; optional: `base`
- **motion.tracks[i]**, a chain track — required: `chain`, `amps`, `period`, `phase`, `lag`
- **motion.blink** — required: `t`, `eyes`, `squash`; optional: `brows`, `brow_drop`, `still`
- **motion.blink.still.&lt;part&gt;** — required: `row`, `bone`
- **motion.animations_from**, the file it names — required: `spec`, `animations`
- **proposal.json**, the file propose writes — `bones`, `meshes`, `regions`, `motion` under the rules above, and `notes`
<!-- /stable:config -->

`TY14` holds the set of field names in backticks above to the set of names the
loader's object checks spell (every `c.object(…)` in `src/config.ts`, with the lists
they name), in both directions, and refuses an object check whose key list it cannot
read. It holds the names, not their nesting or which are required: the `config`
suite's controls hold those, refusal by refusal.

The values a field takes (`retriangulate` is "delaunay", `removalOrder`
"deformation-load", `selection.policy` "multi-interval"; the units and ranges of
every number) are AUTHORING §3's tables, and the loader refuses any other by name.

## Files this package writes

| file | written by | what is stable |
| --- | --- | --- |
| `parts.json`, `parts/<name>.png` | `assemble`, `build` | one record per part: `from`, the box `x`, `y`, `w`, `h` (rig px), the pixel counts `src/parts.ts` documents (`opaque_px`, `visible_px`, `occluded_px`, `projected_core_px`, `source_px_taken`, `visible_not_projected_px`, `refused_drift_px`, `merged_px`, `seam_override_px`, and `fringe_pushed_back` when not empty); `rig_size`, `scale_rig_per_source`, `ghost_px`, `recomposite` |
| `rig/rig.json`, `rig/motion.json`, `rig/images/` | `rig`, `build`, `compose` | rig-c's rig spec and motion spec, `spec` `rigc-rig/1` and `rigc-motion/1`: the format is rig-c's, and this package writes only what rig-c's parser accepts |
| `rig/mesh_report.json` | `rig`, `build` | one row per mesh: `part`, `vertices`, `triangles`, `hull`, `bones`, `max_influences`, `mean_influences`, `art_coverage`, then `grid` (a lattice); `mode` "contour" with `params`, `contour`, `regions`; or `mode` "auto" with `settings`, `source`, `result`, `residuals`, `worst_residual`, `worst_region`, `motion_amplitude`, `termination`, `weights`, `regions`, `deformation`, `quality_report` (rig-c's `mesh-quality-report/1` document whole), `motion_report`, and, only when they apply, `stray_cleared` (after `source`, when `source.stray` is declared), `skinning_residual` and `replay` (`AutoMeshReport` in `src/rig.ts`); in every mode, `exponent` when the mesh declares one (after `grid`, or after `mode`); `ribs` when a contour or auto mesh declares them (after `exponent`, or after `mode`), and then `contour.ribs` (`source.contour.ribs` in the automatic mode) |
| `check/check.json` and the rest of `check/` | `check`, `build`, `compose` | the reference's fields in its order (`gate_spine_html_green`, `rigc_entry`, `pack_mode`, `loop_max_diff`, the seam figures), `loop_physics` after `loop_max_diff` when the rig declares a physics constraint, then the judgement lines (`BREATH_VISIBLE`, `BLINK_NO_HOLE`, `CHAIN_LAG`, `TIP_OVER_ROOT`, `STILL_REGIONS_DARK`, `TEXTURE_STRETCH`), `RECOMPOSITE_HOLES`, `SETUP_POSE_VS_SOURCE`, `skipped`, a `requirements` block under `--requirements`, and `PASS`; `check/build/skeleton.json`, `.atlas` and `.png` are the packed artifact rig-c writes |
| `proposal.json`, `render/landmarks*.png` | `propose` | the config's four rig sections and `notes` |
| `basis.json` | `propose` | spec `spine-parts-basis/1` |
| the scene report | `compose` | spec `spine-parts-scene-report/1` |
| `idle.png`, `idle-indexed.png`, `idle.gif` | `loop`, `build --loop` | APNG and GIF encodings of the rendered idle |

Files authors write for this package, each with a spec id the reader holds:
`spine-parts-requirements/1` (`check --requirements`), `spine-parts-scene/1`
(`compose --scene`), `spine-parts-keypoints/1` (`propose --keypoints`),
`spine-parts-bonemap/1` (`compare --map`). The spec ids keep the package's former
name on purpose: they name a file format, not the tool, and a file written before
the rename still reads. They do not change at 1.0.

## Environment

The installed package reads two environment variables and no other: `PATH`, where
the launcher finds Bun and the CLI finds the `rigc` its own `node_modules` holds,
and `COMFY_HOST`, which `comfy paint` and `comfy seethrough` read when `--host` is
not given (it has no default). `RIG_PARTS_CORPUS` and `RIG_PARTS_SELFTEST_JOBS`,
with their former `SPINE_PARTS_` names read when they are not set, are the
selftest's, a development interface of this repository: the selftest does not ship
in the package.

## rig-c

`dependencies` takes `rig-c` `^2.33.0`: 2.33.0 or any later 2.x. Bun 1.2 or later
runs the package (`engines`). What this package relies on in rig-c, every import
read off `src/` and `cli.ts`:

- the named entries `rig-c/mesh` (the outline functions, `measureAuthoredMeshFit`,
  `reduceMesh`, `skinningEnvelopeBone`, `writeMeshQualityReport` and their types)
  and `rig-c/meshcompare` (`compareMeshesInMotion`);
- the deep paths its `exports` map carries: `rig-c/src/rig.ts` (`parseRigSpec`,
  `RIG_SPEC_VERSION`, the constraint keys), `rig-c/src/errors.ts`,
  `rig-c/src/png.ts`, `rig-c/src/transform.ts` (the y flip, through
  `src/coords.ts` only), `rig-c/tools/plate.ts` (the PNG codec) and
  `rig-c/tools/font5x7.ts`;
- the `rigc` command: `build` and `render`, and `--version`, whose `entry:` line
  says which validator gated a build (`check.json`'s `rigc_entry`).

A rig-c release that moves any of these breaks this package by name, and the
install smoke is where that shows first. No Spine runtime is a dependency: an
install is gated by rigc's own validator, and `@esotericsoftware/spine-core` is a
development dependency of this repository only.

## What is not stable

- **The evidence documents** under `docs/evidence/`: their layout, columns and
  figures are a measurement record of one tree on one rig-c, regenerated when the
  tools or rig-c move.
- **The tools** under `tools/` (the matrix, the surveys, the comparisons) and their
  command lines, and the scripts under `scripts/`.
- **The selftest**: its control names, counts and line wording.
- **Console prose** beyond the shapes above: the detail after a rule name, the
  wording of a note, the order of informational lines.
- **The examples' `expected/` outputs**: they are this repository's regression
  record and move with any change that declares a byte move.
- **Bytes across versions**, as stated at the top.

## Bounded time, and what the checks cost

The automatic mode's search is bounded by counts the author declares or the call
derives, never by a clock (`src/` reads none): rig-c's `reduceMesh` tries at most
`budget.maxCandidates` steps, the acceptance loop replays at most ⌈log₂(N − I)⌉
removal steps (N the call's accepted operations, I the refinement's), and the
multi-interval selection at most `motion.selection.maxProbes`, each replay one
unpacked gated build and one motion comparison. Wall time is therefore a property of
the input and the machine. Measured: the evidence tools run every cell under a
600 s cap and a whole matrix under 2,700 s (`docs/evidence/auto-mesh-matrix.md`,
*re-running*); one `reduceMesh` call on the public parts took 0.7 s to 10.7 s at
rig-c 2.23.0 (the same document's quiet timing table, a remote WSL runner, pool,
load under 2); at rig-c 2.31.0 the whole rig stage of one automatic part, motion
gate and acceptance loop included, took 1.1 s to 61.6 s on the eight parts the
surveys switch, demo `bottomwear` the slowest at 12 gated builds, with a run-to-run
spread of ±15 % on that part (pull request #152's paired exclusive timing, remote
20-core runner; the surveys print wall time to standard error, not into the
documents). On CI (`ubuntu-latest`), the last two green runs on `main` took 4 min
54 s and 8 min 28 s for the full selftest (842 controls over 45 suites at
`22b2c5a`, with the public examples fetched; the job's limit is 20 minutes) and
42 s and 41 s for the install smoke (6 cases; limit 10 minutes), at `8be4cd1` and
`22b2c5a` respectively. None of these figures is a promise: they are what the named
runs measured.

## Determinism

The same inputs, with the same version of this package and the same installed
rig-c, write the same bytes: fixed key order in every JSON written, stable sorts, no
clock, no randomness and no locale-sensitive formatting. `src/` is pure outside
`src/comfy/` (`TY06` refuses a clock, randomness or network call anywhere else under
`src/`). The selftest holds it by running the same thing twice and comparing the bytes:
`PN01` (the PNG codec), `PT01` (`parts.json` round trip), `AS07` (`assemble`
from the CLI), `SK04` (the skeleton), `RG03` (two lattice builds), `CW20` and
`CT20` (a contour rig and a contour mesh), `AM24` (an automatic mesh), `MO11`,
`MO27`, `MO44`, `MO50`, `MO63` and `MO74` (the motion gate, the acceptance
loop's replay, every Stage B opt-in, a gradation, the multi-interval selection's
policy path and the residual veto), `CK02`, `CK33` and `CK79` (`check`, its
stretch geometry, and `check --requirements`), `DG13` (`basis.json`), `LP08`
(the indexed APNG) and `ST26` (the `compare` printout). With the public examples
fetched, the `chain` suite builds each of them and holds `parts.json`
(`CH02`), `rig.json`, `motion.json` and `mesh_report.json` (`CH03`),
`check.json` (`CH04`) and the gate file (`CH05`) to its tracked `expected/`,
field by field, with the tolerances `CH07` plants against.

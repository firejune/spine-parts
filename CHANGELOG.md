# Changelog

## [1.1.1](https://github.com/firejune/rig-parts/compare/v1.1.0...v1.1.1) (2026-10-10)


### Bug Fixes

* **docs:** the headline says what the tool makes, and names Spine once as the format ([#181](https://github.com/firejune/rig-parts/issues/181)) ([9c4d3f3](https://github.com/firejune/rig-parts/commit/9c4d3f38c89e9c7ff51cc29b8de9cece1af979a1))

## [1.1.0](https://github.com/firejune/rig-parts/compare/v1.0.0...v1.1.0) (2026-10-10)


### Features

* **weights:** add bone heat as an opt-in per-mesh weight rule ([#180](https://github.com/firejune/rig-parts/issues/180)) ([69e6041](https://github.com/firejune/rig-parts/commit/69e6041b4d56bfe89c9259d9894dbdfdceacf25b))
* **weights:** let a mesh declare the distance rule's exponent, w = 1/(d + r)^exponent ([#178](https://github.com/firejune/rig-parts/issues/178)) ([e6d6a2f](https://github.com/firejune/rig-parts/commit/e6d6a2f9dd0fa7922531e535e6d4140541c68a62))

## [1.0.0](https://github.com/firejune/rig-parts/compare/v1.0.0-rc.1...v1.0.0) (2026-10-10)


### Features

* **mesh:** add a density-only auto region that refines without a bone or a band and leaves every source weight as without it ([#156](https://github.com/firejune/rig-parts/issues/156)) ([ee4e363](https://github.com/firejune/rig-parts/commit/ee4e363e8721455ceb1e97c275c4e4e1ddb8fd3d)), closes [#155](https://github.com/firejune/rig-parts/issues/155)
* **mesh:** clear the islands a declared stray leaves out from every reader of an automatic part, and name what was cleared ([#176](https://github.com/firejune/rig-parts/issues/176)) ([56b0c8b](https://github.com/firejune/rig-parts/commit/56b0c8bce5ab45f06482799d3ed8a68e7e08ae6d)), closes [#172](https://github.com/firejune/rig-parts/issues/172)
* **mesh:** derive the skinning envelope against the lowest common ancestor of the slot's bone and every bound bone, so the residual veto reaches parts skinned across sibling subtrees ([#169](https://github.com/firejune/rig-parts/issues/169)) ([6df4d90](https://github.com/firejune/rig-parts/commit/6df4d90ea186f73e71b2a3f95eac983a5ddfe47b)), closes [#165](https://github.com/firejune/rig-parts/issues/165)
* **release:** say that 1.0.0 holds the interface stable, and write the migration from 0.16.0 to 1.0.0 ([#177](https://github.com/firejune/rig-parts/issues/177)) ([7ee080b](https://github.com/firejune/rig-parts/commit/7ee080bbebaf5be403bdbf1fa74bc23ad7888fac)), closes [#172](https://github.com/firejune/rig-parts/issues/172)


### Bug Fixes

* **deps:** move to rig-c 2.32.1, which refuses a degenerate refinement insertion by name and cuts the reduction's wall time ([#163](https://github.com/firejune/rig-parts/issues/163)) ([0e836b9](https://github.com/firejune/rig-parts/commit/0e836b95f28cc06186070576a938ada84f7eb4f3)), closes [#159](https://github.com/firejune/rig-parts/issues/159)
* **deps:** move to rig-c 2.32.2, which no longer misrefuses a shared-edge tie in the motion comparison, and re-run the six spacing-survey cells it refused ([#166](https://github.com/firejune/rig-parts/issues/166)) ([5f8cccf](https://github.com/firejune/rig-parts/commit/5f8cccfb66e73ad19c02fbc1af25185277c43dff)), closes [#159](https://github.com/firejune/rig-parts/issues/159)
* **deps:** move to rig-c 2.33.0, the pin 1.0 ships with; every existing build byte-identical ([#173](https://github.com/firejune/rig-parts/issues/173)) ([3c207ac](https://github.com/firejune/rig-parts/commit/3c207acf3b2fdb604735872d45977ccb65b00415)), closes [#172](https://github.com/firejune/rig-parts/issues/172)
* **release:** say that 1.0.0, not the release candidate, holds the interface stable ([#158](https://github.com/firejune/rig-parts/issues/158)) ([b91d167](https://github.com/firejune/rig-parts/commit/b91d167317df03e444597b3dfc916fb7681135f9)), closes [#126](https://github.com/firejune/rig-parts/issues/126)

## [1.0.0-rc.1](https://github.com/firejune/rig-parts/compare/v0.16.0...v1.0.0-rc.1) (2026-10-09)


### Features

* **mesh:** a motion gate on the automatic mesh — the reduced mesh against its unreduced source on the idle through spine-rigc 2.20.3's compareMeshesInMotion, written only when it passes ([#134](https://github.com/firejune/rig-parts/issues/134)) ([8eb2989](https://github.com/firejune/rig-parts/commit/8eb298991ba470cdfdbc2f1fb0f7282f3e62c034))
* **mesh:** add an opt-in multi-interval replay selection that keeps the fewest-vertex passing step among a budgeted, deduplicated set of probes ([#151](https://github.com/firejune/rig-parts/issues/151)) ([8be4cd1](https://github.com/firejune/rig-parts/commit/8be4cd1778363f56661b2024aaeea3d6a248b60e))
* **mesh:** an automatic mesh mode — the contour mesh at alpha 1 and above reduced and locally refined by spine-rigc 2.19.0's reduceMesh, geometry only ([#131](https://github.com/firejune/rig-parts/issues/131)) ([c03dd8a](https://github.com/firejune/rig-parts/commit/c03dd8a7b547e88c3995134750711ccf61fa9a38)), closes [#126](https://github.com/firejune/rig-parts/issues/126)
* **mesh:** move to rig-c 2.20.4 under its new npm name, and regenerate the automatic-mesh evidence on it under per-cell caps with a re-running section ([#138](https://github.com/firejune/rig-parts/issues/138)) ([f405678](https://github.com/firejune/rig-parts/commit/f405678a7849800b12eead0a5463747e221a5fce))
* **mesh:** move to rig-c 2.22.0 and declare the permissive policy's undercut bound absent (null) instead of a stand-in number ([#139](https://github.com/firejune/rig-parts/issues/139)) ([95e0f61](https://github.com/firejune/rig-parts/commit/95e0f61b00b751588505473f493c4daa319d77d7))
* **mesh:** move to rig-c 2.23.0 and read the automatic source's overshoot 8-connected, and measure rigc[#1266](https://github.com/firejune/rig-parts/issues/1266) Q7 on the three motion-refused parts ([#140](https://github.com/firejune/rig-parts/issues/140)) ([926f433](https://github.com/firejune/rig-parts/commit/926f4336df800003262cdbdf3a9b7266e594162d))
* **mesh:** move to rig-c 2.24.0 and replay a less-reduced step when the motion gate refuses an automatic mesh's full reduction ([#141](https://github.com/firejune/rig-parts/issues/141)) ([952155c](https://github.com/firejune/rig-parts/commit/952155c19c0b4f59aefc46bdade40e59a6971f76)), closes [#126](https://github.com/firejune/rig-parts/issues/126)
* **mesh:** move to rig-c 2.28.0, read acceptedAt per operation, and take the Stage B opt-ins as author fields with the public inputs rerun under each ([#147](https://github.com/firejune/rig-parts/issues/147)) ([9420934](https://github.com/firejune/rig-parts/commit/942093437904530f86c27210a2fbdb88b1c6600e)), closes [#126](https://github.com/firejune/rig-parts/issues/126)
* **mesh:** move to rig-c 2.29.0, send the motion amplitude with the author's gradation or null on the reduction and the comparison, and carry MQ_DEFORM_LOAD measured ([#150](https://github.com/firejune/rig-parts/issues/150)) ([8e3553a](https://github.com/firejune/rig-parts/commit/8e3553af207b5c8c022282fe204a6fd20ce861f2))
* **mesh:** move to rig-c 2.31.0 and take the skinning residual as an opt-in per-step veto, with the envelope derived from the idle and the motion comparison still deciding ([#152](https://github.com/firejune/rig-parts/issues/152)) ([22b2c5a](https://github.com/firejune/rig-parts/commit/22b2c5ab78bc2f7a5a519234c9fb30274f1c447f)), closes [#126](https://github.com/firejune/rig-parts/issues/126)
* **package:** rename the package to rig-parts, keeping spine-parts as a transition command and the SPINE_PARTS_* variables as fallbacks ([#142](https://github.com/firejune/rig-parts/issues/142)) ([96f28b1](https://github.com/firejune/rig-parts/commit/96f28b1f77d022828096ff198972cc1ccc3fb830)), closes [#126](https://github.com/firejune/rig-parts/issues/126)
* **release:** publish spine-parts as an alias of rig-parts from the one gated tree, and confirm both names on the registry ([#144](https://github.com/firejune/rig-parts/issues/144)) ([84a951e](https://github.com/firejune/rig-parts/commit/84a951ed1fed22afafe0cb10c672eeadd06ac3dc)), closes [#126](https://github.com/firejune/rig-parts/issues/126)
* **release:** state the 1.0.0-rc.1 interface and the migration from 0.16.0, and hold the stability page to the CLI and the config loader ([#154](https://github.com/firejune/rig-parts/issues/154)) ([c911e48](https://github.com/firejune/rig-parts/commit/c911e48a6cb186997caffa5f9eb9a2df9540a00b)), closes [#126](https://github.com/firejune/rig-parts/issues/126)


### Bug Fixes

* **deps:** move to rig-c 2.24.1, and measure rigc[#1271](https://github.com/firejune/rig-parts/issues/1271) Q8 on the public examples with Q1 option (ii) tried ([#146](https://github.com/firejune/rig-parts/issues/146)) ([542da46](https://github.com/firejune/rig-parts/commit/542da4695f6f56df0433f572da85990a83d5ef19)), closes [#126](https://github.com/firejune/rig-parts/issues/126)
* **mesh:** write every lattice and contour triangle counter-clockwise in Spine world, and hand the automatic mode's source to spine-rigc untouched ([#133](https://github.com/firejune/rig-parts/issues/133)) ([4a126fe](https://github.com/firejune/rig-parts/commit/4a126fefd1a7a960b10c2ebc3da0d866a42589ca)), closes [#126](https://github.com/firejune/rig-parts/issues/126)


### Performance Improvements

* **build:** compile the motion gate's reference without packing, and run each matrix cell's reduction once ([#137](https://github.com/firejune/rig-parts/issues/137)) ([494c919](https://github.com/firejune/rig-parts/commit/494c9195ec0e25113a30015432cd8e05b2db4353))

## [0.16.0](https://github.com/firejune/spine-parts/compare/v0.15.2...v0.16.0) (2026-10-07)


### Features

* **compose:** bind finished single-character builds into one rig with prefixed names, a background plate and a declared slot order ([#129](https://github.com/firejune/spine-parts/issues/129)) ([55a7adc](https://github.com/firejune/spine-parts/commit/55a7adc20154031295899bbbf62db63b6da88b4d)), closes [#74](https://github.com/firejune/spine-parts/issues/74)

## [0.15.2](https://github.com/firejune/spine-parts/compare/v0.15.1...v0.15.2) (2026-10-07)


### Bug Fixes

* **check:** read STILL_REGIONS_DARK from the posed geometry — the still set keeps its place relative to the head bone to the arithmetic's rounding, and the bangs' swing over the face is reported ([#127](https://github.com/firejune/spine-parts/issues/127)) ([7850291](https://github.com/firejune/spine-parts/commit/7850291c86e088dcbeca6432deb68b4dd8d63bc3)), closes [#123](https://github.com/firejune/spine-parts/issues/123) [#118](https://github.com/firejune/spine-parts/issues/118)

## [0.15.1](https://github.com/firejune/spine-parts/compare/v0.15.0...v0.15.1) (2026-10-07)


### Bug Fixes

* **check:** measure TIP_OVER_ROOT from the posed geometry, exactly, so the render grid no longer decides it ([#124](https://github.com/firejune/spine-parts/issues/124)) ([165c0bd](https://github.com/firejune/spine-parts/commit/165c0bdb842280a7bcf976c46dd059bc880ab50e)), closes [#118](https://github.com/firejune/spine-parts/issues/118) [#108](https://github.com/firejune/spine-parts/issues/108)

## [0.15.0](https://github.com/firejune/spine-parts/compare/v0.14.0...v0.15.0) (2026-10-07)


### Features

* **examples:** add `scarf`, a third public example with a hanging scarf, its proposal unedited and four painting patches, held to its own build ([#122](https://github.com/firejune/spine-parts/issues/122)) ([98f76ca](https://github.com/firejune/spine-parts/commit/98f76ca94589e22e8cae8c7b0ea4478168cdf256)), closes [#108](https://github.com/firejune/spine-parts/issues/108) [#118](https://github.com/firejune/spine-parts/issues/118)


### Bug Fixes

* **assemble:** push back a fringe below alpha 250 where the painting shows the part beneath it, so another garment's colour no longer draws as a line down it ([#120](https://github.com/firejune/spine-parts/issues/120)) ([d1df125](https://github.com/firejune/spine-parts/commit/d1df12525f5796a338c2fee15545f465105f1521)), closes [#119](https://github.com/firejune/spine-parts/issues/119) [#108](https://github.com/firejune/spine-parts/issues/108)

## [0.14.0](https://github.com/firejune/spine-parts/compare/v0.13.1...v0.14.0) (2026-10-07)


### Features

* **check:** a declared `seam` requirement measures how far two parts' art parts over an animation, naming the pair and the frame ([#116](https://github.com/firejune/spine-parts/issues/116)) ([6cae59a](https://github.com/firejune/spine-parts/commit/6cae59a306ba9eba9d1224b54635823838b61fe8))

## [0.13.1](https://github.com/firejune/spine-parts/compare/v0.13.0...v0.13.1) (2026-10-06)


### Bug Fixes

* **contour:** cut the outline at a region's spacing where it passes through the region's band, so one long edge no longer carries the whole falloff ([#114](https://github.com/firejune/spine-parts/issues/114)) ([5567970](https://github.com/firejune/spine-parts/commit/5567970e83c20e38422d9ddd44adbe9fa900e958)), closes [#110](https://github.com/firejune/spine-parts/issues/110) [#108](https://github.com/firejune/spine-parts/issues/108)
* **contour:** grow the filled silhouette by the margin and trace it, instead of offsetting the outline, so a narrow notch grows shut rather than folding ([#112](https://github.com/firejune/spine-parts/issues/112)) ([d2d961c](https://github.com/firejune/spine-parts/commit/d2d961c6a3a4c905ba8431992853f0187a77be87)), closes [#106](https://github.com/firejune/spine-parts/issues/106)

## [0.13.0](https://github.com/firejune/spine-parts/compare/v0.12.0...v0.13.0) (2026-10-06)


### Features

* **constraints:** take spine-rigc ^2.15.0, whose parser refuses an ik's bones as a shape, retire this package's two ik refusals and add --idle-keys direct to rigc's line where a control splits the pair ([#105](https://github.com/firejune/spine-parts/issues/105)) ([b1e4df1](https://github.com/firejune/spine-parts/commit/b1e4df1a9adee233ee83398b923d4b998b81f999)), closes [#103](https://github.com/firejune/spine-parts/issues/103)
* **contour:** build a contour mesh from rigc's outline with declared interior points and an exact constrained Delaunay triangulation ([#100](https://github.com/firejune/spine-parts/issues/100)) ([c6f38c3](https://github.com/firejune/spine-parts/commit/c6f38c3878077ed1644dde7557d2c424a9382b7d)), closes [#84](https://github.com/firejune/spine-parts/issues/84)
* **rig:** wire the contour mesh mode — config, stray islands, local region weights, and the lattice comparison ([#104](https://github.com/firejune/spine-parts/issues/104)) ([14eeb2c](https://github.com/firejune/spine-parts/commit/14eeb2c8ce9a11a6f02740f82b9780f208843652)), closes [#84](https://github.com/firejune/spine-parts/issues/84)

## [0.12.0](https://github.com/firejune/spine-parts/compare/v0.11.0...v0.12.0) (2026-10-06)


### Features

* **build:** take --idle-keys ctl|direct and forward it to the rig stage, so a two-bone ik over keyed chain links builds in one process ([#98](https://github.com/firejune/spine-parts/issues/98)) ([ad774c1](https://github.com/firejune/spine-parts/commit/ad774c10e8b7146fd1a4e8f0fe80f52d884f02c3)), closes [#95](https://github.com/firejune/spine-parts/issues/95)
* **check:** measure a scene's declared motion requirements from spine-rigc's posed frames under --requirements ([#97](https://github.com/firejune/spine-parts/issues/97)) ([4ac2e8a](https://github.com/firejune/spine-parts/commit/4ac2e8a72ad043c95d7c0f37bc93a267d2383464)), closes [#93](https://github.com/firejune/spine-parts/issues/93)
* **config:** pass spine-rigc's own constraints through the config, resolve their bones by name, and declare scene targets detached ([#94](https://github.com/firejune/spine-parts/issues/94)) ([818c627](https://github.com/firejune/spine-parts/commit/818c6278cf1ca42096ae3cd31b19ff7c33aa2375)), closes [#92](https://github.com/firejune/spine-parts/issues/92)

## [0.11.0](https://github.com/firejune/spine-parts/compare/v0.10.0...v0.11.0) (2026-10-06)


### Features

* **compare:** compare two skeletons by structure through an explicit bone map ([#88](https://github.com/firejune/spine-parts/issues/88)) ([2452dc6](https://github.com/firejune/spine-parts/commit/2452dc6079c8a2e84370302b091e221717191acb)), closes [#85](https://github.com/firejune/spine-parts/issues/85)
* **propose:** read a posed figure's joints from one explicit keypoint file, place the torso and sleeves from them, and lint by the relations they declare ([#90](https://github.com/firejune/spine-parts/issues/90)) ([4038702](https://github.com/firejune/spine-parts/commit/403870207959fde22bb6296d94a7337dfbba1607)), closes [#75](https://github.com/firejune/spine-parts/issues/75)
* **propose:** say per bone which check read it or why none did, and write beside the proposal what each bone rests on ([#91](https://github.com/firejune/spine-parts/issues/91)) ([e86444c](https://github.com/firejune/spine-parts/commit/e86444ca7282ca0b58aa136f362322f9287db45a)), closes [#86](https://github.com/firejune/spine-parts/issues/86)

## [0.10.0](https://github.com/firejune/spine-parts/compare/v0.9.0...v0.10.0) (2026-10-06)


### Features

* **check:** measure a rig spec with no parts.json or no idle, SKIP by name, and add SETUP_POSE_VS_SOURCE under --source ([#82](https://github.com/firejune/spine-parts/issues/82)) ([989aa00](https://github.com/firejune/spine-parts/commit/989aa00542edce052e6f90d6a0cf9ee1c253ee57)), closes [#77](https://github.com/firejune/spine-parts/issues/77)
* **inputs:** a landscape painting is padded onto its square vertically, and every stage maps the full run back through both pads ([#79](https://github.com/firejune/spine-parts/issues/79)) ([c7a6bdd](https://github.com/firejune/spine-parts/commit/c7a6bdd02c5a7695300d4014b79278eae95a984c)), closes [#78](https://github.com/firejune/spine-parts/issues/78)
* **propose:** a face-less figure gets a proposal, its face box derived from the head run's hair and neck by measured ratios ([#83](https://github.com/firejune/spine-parts/issues/83)) ([88b88f4](https://github.com/firejune/spine-parts/commit/88b88f4868cf40079a9feed2c031cf3d16ef87e7)), closes [#76](https://github.com/firejune/spine-parts/issues/76)
* **rig:** turn each chain bone along its chain and give it a length, without moving anything ([#81](https://github.com/firejune/spine-parts/issues/81)) ([76a3189](https://github.com/firejune/spine-parts/commit/76a31894d7e3bead213460051a73dbf4e3e4bb2f)), closes [#73](https://github.com/firejune/spine-parts/issues/73)

## [0.9.0](https://github.com/firejune/spine-parts/compare/v0.8.2...v0.9.0) (2026-10-05)


### Features

* **config:** a project's own records ride under x- keys, read by nothing — and the painting meta names its sampler fields ([#71](https://github.com/firejune/spine-parts/issues/71)) ([a91d54f](https://github.com/firejune/spine-parts/commit/a91d54fd4b388ecdf044e83a9ce89e58a9298004)), closes [#70](https://github.com/firejune/spine-parts/issues/70)

## [0.8.2](https://github.com/firejune/spine-parts/compare/v0.8.1...v0.8.2) (2026-10-04)


### Bug Fixes

* **deps:** take up spine-rigc 2.10.1 — the header is the setup-pose box, held to getBounds by the atlas instrument; stale sentences made true ([#68](https://github.com/firejune/spine-parts/issues/68)) ([2277d86](https://github.com/firejune/spine-parts/commit/2277d86e406f833371de4447d8e5a67dcc7d5d1e)), closes [#67](https://github.com/firejune/spine-parts/issues/67)

## [0.8.1](https://github.com/firejune/spine-parts/compare/v0.8.0...v0.8.1) (2026-10-03)


### Bug Fixes

* **config:** two tracks on one bone property are refused by the loader, before rigc ([#65](https://github.com/firejune/spine-parts/issues/65)) ([6cf8ac9](https://github.com/firejune/spine-parts/commit/6cf8ac9786a384127867b59bbcdccc74b11656bc)), closes [#49](https://github.com/firejune/spine-parts/issues/49)

## [0.8.0](https://github.com/firejune/spine-parts/compare/v0.7.0...v0.8.0) (2026-10-03)


### ⚠ BREAKING CHANGES

* **check:** the default packed page changes (polygon); --pack-shape rect restores 0.7.0's page. check.json gains a key, pack_mode, after rigc_entry. A rigc older than 2.1.0 on PATH is refused (CHECK_PACK_SHAPE) under the default.

### Features

* **check:** take up spine-rigc 2.1 — read the pack line that ends in its shape, pass --pack-shape through with polygon as the default, and record pack_mode in check.json ([#63](https://github.com/firejune/spine-parts/issues/63)) ([6ed8e4d](https://github.com/firejune/spine-parts/commit/6ed8e4d159f414e67d202368a35a78df2733b828))

## [0.7.0](https://github.com/firejune/spine-parts/compare/v0.6.0...v0.7.0) (2026-10-02)


### ⚠ BREAKING CHANGES

* **rigc:** an install of spine-parts no longer carries spine-core, and its build is gated by rigc's own validator (cli_core.ts); the spine-core round trip runs in this repository's selftest and CI. check.json drops gate_spine_green and adds rigc_entry; check no longer writes gate_spine.txt.

### Features

* **rigc:** take up spine-rigc 2.0 — rig gates through rigc's launcher like check, build's spine-html gate is the one gate, a rigc that stops before its gate prints is quoted, both entries' reports are read by name and check.json records the entry ([#60](https://github.com/firejune/spine-parts/issues/60)) ([992a8fd](https://github.com/firejune/spine-parts/commit/992a8fd009c4a475387897f46e75d1a6da396ffe))

## [0.6.0](https://github.com/firejune/spine-parts/compare/v0.5.0...v0.6.0) (2026-10-01)


### Features

* **check:** the packed page takes rigc's --page-edges, free by default — the examples' pages go from 1024x2048 to 967x1338 and 512x2048 to 479x1166, and --page-edges pot keeps the earlier bytes ([#57](https://github.com/firejune/spine-parts/issues/57)) ([7ab56b4](https://github.com/firejune/spine-parts/commit/7ab56b421fa140278f6211b726eb8ce1906c9944))


### Instrument

* **tools:** atlas_population measures the editor's example atlases and ours with one instrument — regions, page opaque share, figure size at atlas scale ([#55](https://github.com/firejune/spine-parts/issues/55)) ([610bde8](https://github.com/firejune/spine-parts/commit/610bde8715830eadbc5b105cdc3ef66f7975f17a)), closes [#54](https://github.com/firejune/spine-parts/issues/54)

## [0.5.0](https://github.com/firejune/spine-parts/compare/v0.4.0...v0.5.0) (2026-09-28)


### Features

* **check:** TEXTURE_STRETCH measures every mesh triangle's edge stretch over the idle from rigc's geometry export — the reference guide's judgement 6 leaves the eye-only list ([#52](https://github.com/firejune/spine-parts/issues/52)) ([0283a6b](https://github.com/firejune/spine-parts/commit/0283a6b69b084168235d6025c49a722199a01bb1)), closes [#31](https://github.com/firejune/spine-parts/issues/31)


### Bug Fixes

* **check:** STILL_REGIONS_DARK measures the face in the head's own frame — a 2 px slide the screen-space bar let through is now red ([#53](https://github.com/firejune/spine-parts/issues/53)) ([b0d3efe](https://github.com/firejune/spine-parts/commit/b0d3efe45f3a0ce38963b56d355a205b269b4533))
* **propose:** irides without an eyewhite are placed as still regions with the cause in the note, and a blink group naming a bone twice is refused before rigc ([#51](https://github.com/firejune/spine-parts/issues/51)) ([ec963c1](https://github.com/firejune/spine-parts/commit/ec963c18f68ae3b1019ca1c2e7dc5b91263a1eef))


### Documentation

* **seethrough:** upstream's two stages, read at a named revision and measured against our head-crop run — what each route needs ([#48](https://github.com/firejune/spine-parts/issues/48)) ([912c699](https://github.com/firejune/spine-parts/commit/912c699b7ce6a77f500b8b2a9a2112a69bec57a2)), closes [#10](https://github.com/firejune/spine-parts/issues/10)

## [0.4.0](https://github.com/firejune/spine-parts/compare/v0.3.0...v0.4.0) (2026-09-28)


### Features

* **rig:** --idle-keys ctl|direct — the _ctl indirection measured against direct keys with rigc 1.3.0's idleDrivesMeshes declaration ([#43](https://github.com/firejune/spine-parts/issues/43)) ([8a450cc](https://github.com/firejune/spine-parts/commit/8a450cc59c81052fe9008ea71c9bfae45d62cdd7))


### Bug Fixes

* **motion:** the blink's hold spans a loop frame — the 12 fps idle now shows the closed eye on both examples, and the README animation blinks ([#46](https://github.com/firejune/spine-parts/issues/46)) ([48e3e61](https://github.com/firejune/spine-parts/commit/48e3e610524d7b43b190fcfc3a14678533aaff12))
* **propose:** a figure with no eye parts gets no blink — propose says so, and a config with an empty blink group is refused before rigc sees it ([#47](https://github.com/firejune/spine-parts/issues/47)) ([8bc20b4](https://github.com/firejune/spine-parts/commit/8bc20b4dbb41f7403a1b5d0b25b779c8992e5363))

## [0.3.0](https://github.com/firejune/spine-parts/compare/v0.2.0...v0.3.0) (2026-09-27)


### Features

* **assemble:** --propose-plan drops a layer that is mostly translucent, background-coloured or out of proportion, and says which rule — layers prints the three figures ([#39](https://github.com/firejune/spine-parts/issues/39)) ([84ac886](https://github.com/firejune/spine-parts/commit/84ac8861b3c2a28dd23e52eae348ba9707638fc9)), closes [#21](https://github.com/firejune/spine-parts/issues/21)
* **assemble:** assemble.patches cuts an extra part from the painting with a painting: provenance that parts.json, propose and check accept — and check --parts says what it takes ([#42](https://github.com/firejune/spine-parts/issues/42)) ([e44b01d](https://github.com/firejune/spine-parts/commit/e44b01dc48e6858a246842ff409b2f7bb785798f))
* **assemble:** the recomposite error is a map and a list of uncovered holes with their boxes, and check reports it as a line no gate can see ([#40](https://github.com/firejune/spine-parts/issues/40)) ([6629d5c](https://github.com/firejune/spine-parts/commit/6629d5c217b1fe9b586df1ce095eb1f9c2a82384))
* **propose:** hanging strands on an accessory are found, noted and given pendulum chains instead of hanging stiff on a fixed bone ([#37](https://github.com/firejune/spine-parts/issues/37)) ([fff0b84](https://github.com/firejune/spine-parts/commit/fff0b84fc8d6abdefd01df8ede4181b0e48fbc7d))


### Bug Fixes

* **assemble:** assemble reads the config through the early door — plan and seethrough are all it needs before propose — and a control runs the README loop in order on a fresh config ([#41](https://github.com/firejune/spine-parts/issues/41)) ([92b0eed](https://github.com/firejune/spine-parts/commit/92b0eedbf495d136f1d9e11bf344c811a46530e1))
* **propose:** hip comes from the waist and is linted against the chest; clasped hands are one region rather than two sleeve chains on one line ([#34](https://github.com/firejune/spine-parts/issues/34)) ([8515ffe](https://github.com/firejune/spine-parts/commit/8515ffe49f814e5af1c7effc7ec77c14f934c145))
* **rig:** a lash that reaches above the lid is cut at a clear row into a still piece — the eyelid crease no longer squashes, and the rest pose is byte-identical ([#38](https://github.com/firejune/spine-parts/issues/38)) ([7d6bd6a](https://github.com/firejune/spine-parts/commit/7d6bd6a424e0ba031d0534db0a9f0a80eba10524)), closes [#26](https://github.com/firejune/spine-parts/issues/26)

## [0.2.0](https://github.com/firejune/spine-parts/compare/v0.1.0...v0.2.0) (2026-09-27)


### Features

* **assemble:** parts.json counts visible, occluded and visible-but-not-projected pixels apart, and --project visible takes every visible pixel of a thin part from the painting ([#29](https://github.com/firejune/spine-parts/issues/29)) ([986a0a9](https://github.com/firejune/spine-parts/commit/986a0a9100acac1e891d8f580d89db2e52e227b0)), closes [#9](https://github.com/firejune/spine-parts/issues/9)
* **check:** six of the reference guide's eye-only judgements become named check lines — breath, blink hole, chain lag, tip over root, still regions — each with its bar and its SKIP ([#30](https://github.com/firejune/spine-parts/issues/30)) ([27f24ec](https://github.com/firejune/spine-parts/commit/27f24ec7dcb4b46f9ed29ee528a56937ceb088c3))
* **loop:** an indexed APNG with a shared palette — the README-sized animation is lossless PNG structure with a measured palette error ([#27](https://github.com/firejune/spine-parts/issues/27)) ([5e85bb0](https://github.com/firejune/spine-parts/commit/5e85bb0145222e6df7774afb8961a204b3b4e491))


### Bug Fixes

* **comfy:** comfy paint reads the config through the early door — key and generation are all it needs ([#18](https://github.com/firejune/spine-parts/issues/18)) ([c5c01be](https://github.com/firejune/spine-parts/commit/c5c01beb86f105107e8496b97e4d902262c5a7f8)), closes [#17](https://github.com/firejune/spine-parts/issues/17)

## 0.1.0 (2026-09-27)


### Features

* **assemble:** merge the full and head See-through runs into rig-space parts, measured against the reference ([#14](https://github.com/firejune/spine-parts/issues/14)) ([6c2602a](https://github.com/firejune/spine-parts/commit/6c2602ad6f8239abf46e0a87a0ad221569dbd695))
* **build:** one command from painting to packed atlas, an end-to-end examples chain, and the 0.1.0 README, authoring guide, skill and demo ([#16](https://github.com/firejune/spine-parts/issues/16)) ([9ed1183](https://github.com/firejune/spine-parts/commit/9ed11834418333ec0f9d267ce6b46750fe883922))
* **check:** build, gate, render and measure a rig through spine-rigc, and encode its idle as APNG and GIF ([#8](https://github.com/firejune/spine-parts/issues/8)) ([722e67b](https://github.com/firejune/spine-parts/commit/722e67b28943aeaf02aef20aaffb04ecfe74addc))
* **comfy:** the optional ComfyUI adapter (comfy paint, comfy seethrough) and the inputs command ([#15](https://github.com/firejune/spine-parts/issues/15)) ([a9c778a](https://github.com/firejune/spine-parts/commit/a9c778a6e98335fe2af38e674fdb57920443c279))
* **examples:** two public example characters, fetched inputs, and a corpus suite that reads them ([#3](https://github.com/firejune/spine-parts/issues/3)) ([7f4b4af](https://github.com/firejune/spine-parts/commit/7f4b4afa204f6271bfef4b8bb637f5a307589790))
* **propose:** bones, meshes, regions and an idle from the parts' tags, the overlay to correct against, LINT, compare and a head box held inside the painting ([#5](https://github.com/firejune/spine-parts/issues/5)) ([a00fe94](https://github.com/firejune/spine-parts/commit/a00fe940250d9af068064d676cfe0207ab4e7fd9))
* **rig:** author rig.json and motion.json from the config and the parts — lattice meshes, segment weights, regions, the idle — and write them only after spine-rigc is green on them ([#4](https://github.com/firejune/spine-parts/issues/4)) ([e8165bc](https://github.com/firejune/spine-parts/commit/e8165bcd98054fae33a98af4306fbf9c1a485bac))

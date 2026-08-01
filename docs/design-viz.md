# Display Design — Showing the Rendering Process

*Drafted 2026-07-28 for review. Governs the visualization/animation work
between V1a and V1b (agreed sequencing: display substrate + first demos now,
glass/metal after — the display work informs what scenes want glass).
Primary output: recorded movies for the talk, exported frame-by-frame at
whatever per-frame cost we like. Live browser demos are the authoring mode,
not the deliverable.*

## The three output tiers

One animation, three renderers of increasing cost — same data throughout:

1. **Lines** (`THREE.Line2`, real pixel width) — live authoring and quick
   previews; runs well enough to demo live if ever wanted.
2. **Tubes** (`TubeGeometry` meshes) — affordable beauty; also runs live.
3. **Path-traced frames** — trajectories converted to *emissive tube
   geometry* inside the scene, each frame rendered to convergence with
   `three-gpu-pathtracer`, dumped as PNG, stitched to video offline. A
   path-traced movie of path tracing, rendered overnight from the same
   timeline script as the live preview.

## The timeline (animation substrate)

A shared clock all animated elements listen to. An animation is:

- **Elements** implementing `drawAt(t)` — e.g. a `PathReveal` draws its
  PathRecord's polyline up to arc length s(t), segment by segment;
- **Events** pinned to moments — when the clock reaches a path's arrival at
  vertex k: the shadow ray fires (green to the light / red dying at the
  recorded blocker point), the RR coin shows, the emission flash triggers,
  the sampling-lobe overlay appears;
- **A script**: plain data — scene, seed keys, integrator name, per-path
  start times and speeds. Deterministic end to end: the take you liked in
  rehearsal is the take in the export.

Controls: play / pause / scrub (a slider sets t) / single-step.

**Recording is stepping, not capturing.** For export we advance the clock in
fixed increments (t = 0, 1/30, 2/30, …), render each frame with whichever
tier, and write it out. No real-time constraint — tier 3 spends minutes per
frame if it wants. Two writers:
- PNG frame dump via the File System Access API (robust, resumable, the
  route for tier-3 overnight runs), stitched with ffmpeg;
- MediaRecorder capture for quick low-stakes previews.

## Visual design language (the spec to mark up)

One language across every demo and every future stage; BDPT and MLT inherit
it rather than inventing their own. Recorded here so figures stay
consistent talk-wide.

| Element | Treatment |
|---|---|
| Camera-path segments | warm white → amber; **brightness/width scales with throughput** (log-scaled, clamped) |
| Light-subpath segments (V2) | cyan family — instantly distinguishable from camera paths |
| Connections / shadow rays | green when the connection succeeds; red, drawn only as far as the blocker, when occluded |
| Delta (specular) bounces (V1b) | sharp specular white; no lobe overlay (there is no lobe — that's the point) |
| Scattering vertices | small dot; active vertex enlarged while "its" moment plays |
| Emission hit | brief bloom flash at the light; path locks to its final color |
| Russian-roulette death | small × marker at the vertex; path freezes and dims |
| Escaped rays | drawn a fixed length, fading to transparent |
| Sampled direction | an arrow appears at the active vertex before the outgoing segment grows |
| MLT (V3 preview) | current path solid; proposal ghosted; accept = ghost solidifies, reject = ghost evaporates |

*Removed by decision (2026-07-28): the sampling-distribution ("lobe")
overlay. The Lambert version is trivial (cos θ polar plot = sphere tangent
at the vertex) but doesn't generalize — GGX lobes need real machinery — so
it was deleted rather than kept dormant. If a slide ever needs one, design
the general version then.*

Failures are always visible — occluded connections, RR deaths, escapes.
Half the pedagogy lives in the failures.

## Demo-set rebuild (agreed 2026-07-29 — supersedes the statuses below)

The demos below were each grown into an option matrix (4–7 selects apiece),
which made them instruments rather than figures: over-packed to the point
where they no longer showed any individual thing. Decision: **retire them
and rebuild as a larger set of single-purpose pages**, one idea per page,
every parameter a named constant at the top of `main.ts`. Amended the same
day: where a page exists to COMPARE kinds of thing, that comparison axis is
its single control — a page that is supposed to show different types of
path has to let you switch between them. Everything incidental (tier,
dwell, sample count, resolution) stays a constant. Grouped in acts:

0. the renderer and the scenes (`render-still`, `scene-sheet`,
   `material-strip`, `depth-sweep`) ✅ 2026-07-29. `render-still` renders
   with ALL THREE integrators side by side (one worker each, equal seed and
   spp) and captions each with its ms/pass: measured on `cornell` at 256²,
   PT ×1.0, NEE ×1.5, **BDPT ×9.3** — i.e. ~6× NEE per pass at the worker's
   default 32-bounce cap, above design-v2's predicted 3–5×;
1. the vocabulary of one path ✅ 2026-07-29 — three switchable pages, one
   comparison axis each: `path-strategies` (PT / PT+NEE / BDPT on one sample,
   same depth cap, roulette off — the BDPT mode grows the cyan light
   subpath on the same clock and flashes its connections), `path-outcomes`
   (emitter / roulette death / escape; the escape mode swaps in
   `open-stage`), `connection-outcomes` (one NEE connection, clear or
   blocked). Animation timing is per-page: the substrate default of 4
   units/second and 1.2 s per vertex was far too slow to watch twice, so
   these pass `{ speed: 14, momentSeconds: 0.3 }` and loop after a short
   hold — 2–4 s per playthrough instead of 4–9 s. `path-strategies` runs
   all three integrators to a shared 6-bounce cap with roulette OFF: the
   renderer's real default (roulette from depth 3) kills most walks after
   3–4 bounces in this bright box, which made every path on the page look
   stunted and let roulette truncate one integrator earlier than another.
   Roulette is the subject of `path-outcomes` instead. A `one-ray` page was
   built and then cut: a camera ray is only meaningful fully extended, at
   which point it is just the first segment of `path-strategies`;
2. one pixel, many samples (flipbook, path family, per-sample values,
   image forming) — pending. **Requested 2026-07-29: a DEEP naive-tracing
   page — long walks, roulette off, showing how long it takes a BSDF-sampled
   path to stumble onto the light.** Design notes banked while they are
   fresh:
   - The quantity to put on screen is *P(the walk has found the emitter
     within k bounces)*, plus the bounce index of the first hit. Measured
     baseline for `cornell` (32-bounce cap, roulette from depth 3): a
     floor pixel needed 13 samples before one reached the light at all.
     With roulette off, walks in this closed box run essentially to the
     cap (mean 46 bounces against a 64 cap), so every path eventually
     gets many chances and the interesting curve is over k, not over spp.
   - The per-vertex "moment" machinery does NOT scale to this: at
     `momentSeconds: 0.3` a 40-bounce path spends 12 s on pauses alone.
     A deep-path page wants moments off (or ~0.02 s) and a much higher
     speed — i.e. a third timing regime beside the substrate default and
     the Act 1 figures. Decide it there rather than retro-fitting.
   - Naive tracing looks bad here specifically because the emitter is a
     1.6×1.6 quad in a 4×4×13 room; the page should state that solid
     angle, since it is the whole reason the count is large.
3. the image and its noise (convergence scrub, wipe, error view, equal
   time) — pending;
4. bidirectional (light subpaths alone, one connection, light tracing,
   the pyramid, balance vs power, the lamp and caustic comparisons) —
   pending;
5. probes (sampler scope; a `three-gpu-pathtracer` beauty test — note
   that package is a dependency NOTHING imports, so tier 3 above is
   unproven) — pending.

`v0-cornell` and `v1-nee` were deleted in the Act 0/1 pass, which also
retired `src/viz/three-paths.ts` — the second, static path-drawing
codepath — leaving `path-elements.ts` + `sample-flip.ts` as the only
implementation of the visual language.

Two scenes were added for these pages: **`open-stage`** (floor and back
wall only) and **`material-row`** (four spheres, one per material, on a 2:1
film). `open-stage` closed a real gap: every previous scene was a closed
box, so the escaped-ray branch of the schedule — and the "escapes fade
out" entry in the design language below — had never once executed.

Added 2026-07-30 with V3: **`door-ajar`** (Veach & Guibas 1997's door
scene in our box) — the divider wall with a slit whose width is the
difficulty dial; the tuning table lives with the scene in
`demos/_shared/scenes.ts`. The Metropolis showcase: equal-time in
`viz-convergence`, MMLT resolves the red-lit room while BDPT is still
firefly grain.

## Demos — status (updated 2026-07-28)

Built:
- **D1 — substrate** ✅: timeline (elements are pure functions of t),
  Line2/tube tiers, webm + PNG-frame writers, shared control strip.
- **D2 — single-path construction** ✅ (`demos/viz-single-path`): one
  sample grown bounce by bounce with all event moments.
- **Flipbook / accumulate** ✅ (`demos/viz-pixel-samples`, added by
  discussion): one pixel's samples shown whole — flip cycles them at a
  dwell; accumulate piles them up, age-dimmed. Integrator toggle makes it
  the variance story (PT: a handful of 100 samples carry light).
- **Image forming** ✅ (`demos/viz-image-forming`, added by discussion): a
  low-res (default 16×16) image accumulates on a plane placed exactly on
  the camera frustum inside the scene, while one highlighted cell draws
  its paths on the same sample clock.

Decided against:
- **D3 — pixel histogram**: killed after full design (2026-07-28). The
  felt version of variance is better served by the flipbook and image
  plane; the quantitative content (count-vs-energy contrast, SE ∝ N^(−1/2)
  with different constants, "the median sample is zero") belongs in a
  STATIC figure. **Kept option**: a trivial per-sample data export
  (pixel + integrator → JSON/CSV of sample luminances via seed replay,
  ~ten lines) to feed external plotting when the slide deck wants that
  figure.
- **Sampling-lobe overlay**: removed (see design-language note above).

Shelved: **D4 — firefly forensics** (machinery exists via D2 + replay;
build only if the figure list calls for it).

Built since (V2, 2026-07-29):
- **D5 — convergence scrub + wipe** ✅ (`demos/viz-convergence`): pooled
  workers, equal-sample/equal-time scrub, error view, per-pane integrator
  selects (pt / pt-nee / bdpt).
- **Strategy pyramid** ✅ (`demos/viz-bdpt-pyramid`): per-(s,t) cells
  weighted/unweighted, balance/power, in-browser weight-sum residual.
  Clicking a pixel inside a cell deep-links into `viz-single-path`
  (`?scene&integrator&px&py&s&t`), which isolates that strategy: the two
  subpath prefixes grow and only that connection flashes, auto-advancing
  samples until the strategy forms. Demo-set decision (2026-07-29): demos
  stay SEPARATE single-purpose test instruments — no consolidation — and
  link to each other by URL where a jump is pedagogically useful.
- **D6 — path swarm** ✅ (as the bdpt accumulate view in
  `demos/viz-pixel-samples`): each sample's light subpath draws in cyan
  beside the amber camera bundle — transport as flow from both ends.

Built since (V3, 2026-07-30):
- **viz-mlt-chain** ✅: the design-language MLT row realized — one
  deterministic chain replayed from its bootstrap seed (current path solid,
  proposal ghosted, accept solidifies / reject evaporates), with the
  chain's splat footprints accumulating on a film panel and per-mutation
  step-type/acceptance readouts. Chain choice is a constant; chain 8 (seed
  0) is a depth-5 glass-crossing chain chosen by probe.

Built since (V4, 2026-07-31):
- **viz-restir-flow** ✅: ReSTIR's reuse made visible — per-pixel source
  map (fresh amber / temporal blue / spatial green), click-to-trace
  adoption lineage across neighbors and passes ending at the discovering
  pixel, live source-mix stats. Image-space arrows rather than in-scene
  lines (the lineage IS an image-space structure); an in-scene variant is
  a recorded option if the talk wants it.

Pending, to be selected against the talk's figure list (none exists yet;
dozens of figures expected once drafting starts).

## Scene-parity note (agreed 2026-07-28)

Closed scenes (no escaping paths) require the visualizer to see through a
wall the renderer treats as real. `PrimitiveDescription.display.ghost` is a
**display-only hint**: the CPU renderer ignores it entirely; the three.js
adapter draws the primitive as near-transparent glass. This deliberately
relaxes strict portrayal parity — geometry parity is preserved, and the
hint lives in the shared description so the break is visible in one place.
The Cornell box's front wall is the first user.

## Out of scope for now

Camera fly-throughs during animations (static or slow-orbit camera only),
audio/narration sync, DOM-overlay text baked into exports (labels that must
appear in movies are drawn in-canvas), and any change to `src/core` beyond
the one Film slot.

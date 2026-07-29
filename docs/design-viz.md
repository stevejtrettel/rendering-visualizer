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

## Demo build order

- **D1 — substrate**: timeline, Line2/tube path rendering, the two frame
  writers, and a scrub/play control strip shared by all demos.
- **D2 — single-path construction**: one sample grown bounce by bounce,
  with lobe overlay and all event moments. The atomic narrated animation.
- **D3 — the pixel as a random variable**: click a pixel → live-accumulating
  histogram of its sample values, PT and NEE side by side; running mean
  converging at 1/√N; PT's zero-spike and heavy tail on display. Rendered
  into its own canvas so it exports like everything else.
- **D4 — firefly forensics**: click a bright outlier pixel → replay and
  animate the exact low-pdf path that caused it.
- **D5 — convergence scrub + wipe**: film snapshots at exponential spacing
  (1, 2, 4, … spp) scrubbed by slider; draggable wipe divider between
  integrators; false-color standard-error view. Requires one Film
  extension: an 8th per-pixel slot accumulating squared luminance.
- **D6 — path swarm**: hundreds of concurrent throughput-faded paths; the
  "light transport as flow" establishing shot.

Checkpoints: review after D1+D2 (the animation has to *feel* right before
anything else builds on it), after D3+D4, after D5+D6.

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

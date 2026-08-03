# rendering-visualizer

A bidirectional path tracer built two ways for a talk:

1. **A CPU renderer** — unidirectional path tracing, NEE/light sampling,
   bidirectional path tracing, and Metropolis light transport, implemented
   carefully in TypeScript.
2. **A visualization of that renderer** — the same scenes rendered in three.js
   (via `three-gpu-pathtracer` for beauty renders), with the *actual light
   trajectories the CPU renderer sampled* drawn into the scene, animated and
   rendered for talk figures.

## Central design idea

The renderer and the visualization share one core. Integrators are written
once and **instrumented**: each one emits `PathRecord` events (vertices, BSDF
samples, pdfs, throughput, BDPT connection edges, MLT mutation history). The
CPU renderer consumes these to accumulate a film; the visualizer consumes the
same records to draw trajectories. With a seedable RNG, a rendered figure and
its animated visualization can replay literally the same path.

Consequences, designed in from day one:

- `src/core/` is **pure** — no DOM, no three.js. It runs in Node (offline
  renders, tests), in Web Workers (interactive renders), and in the browser
  (visualization).
- BSDFs expose `eval` / `sample` / `pdf` as separate operations. NEE, MIS
  weights, and BDPT all evaluate BSDFs in directions another strategy
  produced; a sample-only interface cannot be retrofitted cleanly.
- Scenes are defined once, declaratively, with two adapters: one to the
  core's intersection structures, one to three.js meshes.
- RGB throughput (no spectral rendering for now).

## Layout

```
src/
  core/            pure rendering core — no DOM, no three.js
    math/          Vec3, Ray, ONB, sampling routines, seedable RNG
    geometry/      sphere / quad / triangle mesh, BVH
    materials/     BSDFs (lambert, dielectric, conductor, rough variants)
    lights/        area lights with sample/pdf
    scene/         declarative scene description + intersection adapter
    integrators/   pt, pt-nee, bdpt, mlt — each emits PathRecords
  trace/           PathRecord types + recorder (the renderer↔viz bridge)
  render/          CPU harness: film/tiles, worker pool, PNG output
  viz/             three.js scene adapter, trajectory drawing, animation
demos/             one folder per talk figure/animation (index.html + main.ts)
scripts/           run-demo.mjs launcher; offline render CLI (Node) later
tests/             vitest — sampler chi-square, furnace tests, integrator
                   cross-consistency (all integrators converge to same image)
```

## Design docs

The repo carries its own rationale — read these before changing anything
structural:

- `docs/design-v0.md` — the architecture and its load-bearing decisions
  (V0 shipped: unidirectional PT, worker rendering, click-to-replay).
- `docs/design-v1.md` — the V1 stages (V1a NEE/MIS shipped; V1b materials
  and V1c parallelism pending).
- `docs/design-v2.md` — bidirectional path tracing: strategy enumeration,
  pure-function MIS, the validation plan (V2 shipped).
- `docs/design-v3.md` — Metropolis (MMLT): the primary-sample-space chain,
  bootstrap normalization, chain visualization (V3 shipped).
- `docs/design-v4.md` — ReSTIR: reservoir resampling, pairwise MIS,
  reuse across pixels and passes (V4 shipped); `docs/restir-notes.md`
  banks the course-notes math with equation-level citations.
- `docs/design-viz.md` — the display/animation system: timeline substrate,
  visual design language for light paths, demo statuses and decisions.
- `docs/pbrt-notes.md` — distilled PBRT implementation references for the
  BDPT/MLT stages, with section citations.

## Demos

`npm run dev` opens the gallery. **One page shows one thing**, with every
parameter fixed as a constant at the top of its `main.ts`. Where a page
exists to *compare* kinds of thing — three integrators, three ways a path
can end — that comparison is its single control; everything incidental
stays a constant. (The old multi-purpose pages were over-packed to the
point of not showing anything individually; agreed 2026-07-29 to retire
them for a larger set of single-purpose ones, built in acts.)

- **Act 0 — the renderer and the scenes**: `render-still` (one scene by all
  four integrators at equal samples and a shared 8-bounce depth cap,
  captioned with each one's ms/pass; MMLT's "spp" is mutations/pixel),
  `scene-sheet`
  (every registry scene at equal samples), `material-strip` (every
  material, one sphere each), `depth-sweep` (the image at 1, 2, 3, 4 and
  32 bounces).
- **Act 1 — the vocabulary of one path**, all switchable along one axis:
  `path-strategies` (WHICH ALGORITHM builds the path — PT / PT+NEE / BDPT
  on one fixed sample; the BDPT mode grows the light subpath in cyan and
  flashes its connections), `path-outcomes` (HOW A WALK ENDS — emitter /
  roulette death / escape, with the algorithm fixed), `connection-outcomes`
  (one light connection, clear or blocked). They animate at ~14 world units
  per second and loop, so a path takes 2–4 s to draw rather than 9.
- **Act 2 — populations of paths**: `path-swarm` (100 of one pixel's paths on
  screen at once, 10 replaced per refresh, switchable between 1 scattering
  event / 2 / full — at one event the spray IS the material's scattering
  distribution), `light-swarm` (100 paths thrown from the lamp connecting to
  the camera: BDPT's t=1 strategies, the light-tracing code path). Both use
  `src/viz/path-swarm.ts`, which draws a whole population as one buffered
  `LineSegments`; the visible window is still a pure function of time, so
  scrub and export work.
- **Specular manifolds (V5)**: `viz-manifold-walk` — the Newton walk that
  solves a specular connection, played as the M attempts of one SMS
  estimate (seed dotted, iterates color-ramped by residual, solved chains
  solid, failures evaporating; switches for scene, constraint
  formulation, seed mode, and M). `viz-caustic-fold` — a receiver point
  sweeping through the coffee-cup caustic inside a mirror dome (concave —
  measured: the convex ball is single-root with no fold anywhere) while
  the fiber's solution branches and their projection determinant
  |det ∂x₁/∂x₂| are tracked live: at the fold two branches are born
  together, the determinant spikes ~400×, and the pt-sms render beside it
  glows along the same line (a caustic IS a critical value of the
  projection that forgets the specular vertex). `render-still` and
  `viz-convergence` carry `pt-sms` panes.
- **ReSTIR (V4)**: `viz-restir-flow` — the parallel-reuse mirror of the
  MLT chain figure: a source map colors each pixel by where its reservoir
  sample came from (fresh / temporal / spatial), and clicking a pixel
  traces the adoption lineage back to the pixel that discovered the
  sample. `viz-convergence` and `render-still` carry `restir` panes
  (single sequential worker — its passes are not parallelizable).
- **Metropolis (V3)**: `viz-mlt-chain` — one deterministic Markov
  chain replayed from its bootstrap seed: the current path solid, each
  proposal ghosted (accepts solidify, rejects evaporate), the chain's
  splat footprints accumulating on a film panel beside it. `viz-convergence`
  and `render-still` carry `mmlt` panes for the equal-time payoff figures.
- **Acts 2 (rest)–4 pending**: per-sample values; the image and its noise;
  bidirectional. Until they land, the remaining old pages stay in the
  gallery under "not yet rebuilt" (`viz-single-path`, `viz-pixel-samples`,
  `viz-image-forming`, `viz-convergence`, `viz-bdpt-pyramid`).

## Commands

```
npm run dev              serve everything — / is the demo gallery
npm run dev <name>       serve and open demos/<name>/
npm run build <name>     build one demo into dist/<name>/
npm run preview <name>   preview a built demo
npm run test             vitest
npm run typecheck        tsc --noEmit
```

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
    lights/        area + point lights with sample/pdf
    scene/         declarative scene description + intersection adapter
    manifold/      specular manifold walk (SMS): constraints, Newton, chains
    integrators/   pt, pt-term, pt-nee, pt-sms, bdpt, mmlt — each emits
                   PathRecords; estimators.ts holds the pieces they share
  scenes/          the named scene registry — library content, not demo
                   content: tests read it too. assets.ts holds the scenes
                   needing a fetched model, so registry.ts stays Node-safe.
  trace/           PathRecord types + recorder (the renderer↔viz bridge);
                   replay.ts re-traces a path from its seed key
  render/          film, the Renderer interface over the three execution
                   models (per-pixel / MMLT / ReSTIR), worker, pool, session
  viz/             style.ts   the palette and materials — retune to restyle
                              the entire deck
                   stage.ts   renderer, camera, 16:9 letterbox, the clock
                   capture.ts stills and frame-stepped video
                   ui.ts      lil-gui panel and keyboard shortcuts
                   text.ts    in-canvas labels, so they survive export
                   lines.ts   thick lines (THREE.Line is 1px and unusable)
                   film-panel.ts  a CPU render as a quad inside the canvas
                   three-scene, path-schedule, path-elements, path-swarm,
                   timeline, image-plane, sample-flip, views
  registry.ts      demo discovery (glob) + optional gallery metadata
  demo-host.ts     the single host page behind demo.html?d=<name>
  gallery.ts       the index page
demos/<name>/main.ts   one figure, self-contained — no HTML, no config
legacy/          the pre-rebuild demo set, reference only (not built)
scripts/         encode.mjs — re-encode captured frames
tests/           vitest — sampler chi-square, furnace tests, integrator
                 cross-consistency (all integrators converge to same image)
```

`docs/design-cleanup.md` records the consolidation pass those shared
modules came out of, and what is still deferred.

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

The demo set is **mid-rebuild** (2026-08-04). `demos/hello-stage` is the
worked example on the new stage; the previous 21 pages are parked in
`legacy/` for reference — they predate the 16:9 stage and one-button
export, are not built or typechecked, and are there so a rebuilt figure can
see what its predecessor did. Delete a legacy folder as its figure lands.

The acts they are being rebuilt into, and what each was:

- **Act 0 — the renderer and the scenes**: `render-still` (one scene by
  every integrator at equal samples and a shared depth cap, captioned with
  each one's ms/pass), `scene-sheet` (every registry scene), `material-strip`
  (every material, one sphere each), `depth-sweep` (the image at 1, 2, 3, 4
  and 32 bounces).
- **Act 1 — the vocabulary of one path**, each switchable along one axis:
  `path-strategies` (WHICH ALGORITHM builds the path — PT / PT+NEE / BDPT on
  one fixed sample), `path-outcomes` (HOW A WALK ENDS — emitter / roulette
  death / escape), `connection-outcomes` (one light connection, clear or
  blocked).
- **Act 2 — populations of paths**: `path-swarm` (100 of one pixel's paths
  at once, 10 replaced per refresh — at one scattering event the spray IS
  the material's distribution), `light-swarm` (100 paths thrown from the
  lamp: BDPT's t=1 strategies). Both draw a whole population as one buffered
  `LineSegments` via `src/viz/path-swarm.ts`, with the visible window still a
  pure function of time so scrub and export work.
- **Specular manifolds (V5/V5b)**: `viz-manifold-walk` (the Newton walk that
  solves a specular connection, played as the M attempts of one SMS
  estimate), `viz-caustic-fold` (a receiver sweeping through a caustic while
  the fiber's solution branches and their projection determinant are tracked
  live — a caustic IS a critical value of the projection that forgets the
  specular vertex).
- **ReSTIR (V4)**: `viz-restir-flow` — a source map colouring each pixel by
  where its reservoir sample came from, with click-to-trace lineage.
- **Metropolis (V3)**: `viz-mlt-chain` — one chain replayed from its
  bootstrap seed, proposals ghosted, splat footprints accumulating beside it.
- **Convergence**: `viz-convergence`, `viz-bdpt-pyramid`, `viz-single-path`,
  `viz-pixel-samples`, `viz-image-forming`.

The figure list for the talk is still open; `docs/design-viz.md` has been
waiting on it, and it should drive which of the above get rebuilt first.

## Adding a demo

Create `demos/<name>/main.ts`. That is the whole procedure — it appears on
the index page automatically. `demos/hello-stage/` is the worked example.

```ts
import { createStage, createUI, C } from '@';

const stage = createStage({ position: [0, 2.8, 15.5] });
stage.duration = 8;              // loop length, and the default export length
createUI(stage);

stage.frame((t) => {
  // animate from t, never from performance.now() — see "Time" below
});

stage.start();
```

Optionally add a title, blurb and section for the gallery in
`src/registry.ts`. Without one you get a prettified folder name.

## Exporting

Everything lands in `out/`, which is git-ignored.

| Key | Action |
| --- | --- |
| `S` | Save a PNG still → `out/stills/<demo>-<timestamp>.png` |
| `V` | Render a video → `out/<demo>.mp4` |
| `H` | Hide the control panel (for screen recording) |
| `R` | Restart from t = 0 |
| `space` | Play / pause |

**Video export is one button and ends with a finished movie.** The page
steps `t` frame by frame, POSTs each frame to the dev server, which writes
the PNGs and runs `ffmpeg` when the last one lands. Because it steps time
rather than recording in realtime, a frame that takes two seconds to render
is fine — which is what makes exporting a page that is path tracing while it
animates possible at all. Set the format to `prores` for a ProRes 4444
`.mov`, which is what Keynote prefers for fine gradients.

**Capture › from (s) / to (s)** set the range on the demo's own clock, so
exporting the first 6 s of a 20 s loop is two numbers rather than
arithmetic. They default to the whole loop, and *whole loop* resets them to
it. The range is deliberately independent of Time › loop (s): the loop is
how long the animation takes, the range is what you want out of it.

Export needs the dev server (the writing-to-disk half is vite middleware)
and `ffmpeg` on PATH. `npm run build` produces a static gallery without it.

## Time, and why it is handed to you

Demos animate from the `t` in `stage.frame((t, dt) => …)`, **not**
`performance.now()`. That is what lets the exporter set `t` to any value and
take as long as it likes per frame. **Never call `Math.random()` in a demo**
either — the exporter re-runs your update per frame, so anything reseeding
per frame makes the video boil. The renderer's own sampling is already
seeded and replayable (`tracePath` re-traces a path from its seed key), so
this costs nothing here.

## Framing and export-safety

The canvas holds a locked 16:9 box, letterboxed in the window, exporting at
1920×1080 — what you frame while fiddling is exactly what lands in Keynote.
Line widths are authored against 1080p and scale automatically.

**DOM does not appear in exports.** So the lil-gui panel can never leak into
a PNG (press `H` only for screen recordings), and conversely anything that
must be *in* the figure has to be inside the canvas:

- labels via `label()` (`src/viz/text.ts`), drawn as real geometry;
- readouts on `stage.hud`, a flat overlay in fixed screen coordinates;
- a CPU render via `FilmPanel` (`src/viz/film-panel.ts`) — a textured quad
  fed from `RenderSession` or `WorkerPool`, never a `<canvas>` beside the
  stage.

`stage.shiftView(f)` slides the 3D image sideways with an off-axis frustum,
which is how a figure frees the right third for a render pane without
moving the camera or the scene.

## Commands

```
npm run dev              serve everything — / is the demo gallery
npm run build            build the static gallery into dist/
npm run preview          preview the build
npm run video <name>     re-encode already-captured frames
npm run test             vitest
npm run typecheck        tsc --noEmit
```

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

## Commands

```
npm run dev              serve everything — / is the demo gallery
npm run dev <name>       serve and open demos/<name>/
npm run build <name>     build one demo into dist/<name>/
npm run preview <name>   preview a built demo
npm run test             vitest
npm run typecheck        tsc --noEmit
```

# Working conventions

**Plan first, always.** Never write code in this repo without a plan that has
been discussed and agreed with Steve. Propose the design, discuss trade-offs,
then implement. This applies to every feature, not just large ones.

## Architecture (agreed 2026-07-28 — see README.md, and the design docs in
## docs/: design-v0, design-v1, design-v1c, design-viz, design-v2,
## pbrt-notes. Decisions and their rationale live there; check statuses
## before proposing work. NEXT UP: docs/plan-v2-implementation.md is the
## approved, detailed BDPT build plan — execute it checkpoint by
## checkpoint, stopping for Steve's review at each.)

- TypeScript everywhere, strict mode. The CPU renderer is TS, not native —
  the shared core between renderer and visualization is the whole point.
- `src/core/` is pure: no DOM, no three.js imports. It must run in Node,
  Web Workers, and the browser unchanged.
- Integrators emit `PathRecord` events (defined in `src/trace/`); both the
  film accumulator and the three.js trajectory visualizer consume them.
- BSDF interface: `eval`, `sample`, `pdf` as separate methods, always.
- Seedable deterministic RNG — figures and their visualizations replay the
  same paths.
- RGB throughput, not spectral.
- Beauty renders of three.js scenes use `three-gpu-pathtracer`; the CPU
  renderer's own output is used for algorithm comparisons and convergence
  figures, and runs offline under Node when needed.

## Demo pattern (mirrors Steve's PathTracer repo)

Each demo is a self-contained Vite page: `demos/<name>/index.html` +
`main.ts`. The root `index.html` is a hand-maintained gallery — add a link
there when adding a demo. `scripts/run-demo.mjs` wraps vite; `npm run build
<name>` scopes vite's root to that demo (DEMO env var, see vite.config.ts).

## Testing

Sampling code fails silently — test it statistically: chi-square tests on
samplers, white-furnace tests on BSDFs, and cross-consistency (all
integrators must converge to the same image on test scenes) in `tests/`.

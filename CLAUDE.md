# Working conventions

**Plan first, always.** Never write code in this repo without a plan that has
been discussed and agreed with Steve. Propose the design, discuss trade-offs,
then implement. This applies to every feature, not just large ones.

## Architecture (agreed 2026-07-28 — see README.md, and the design docs in
## docs/: design-v0, design-v1, design-v1c, design-viz, design-v2,
## design-v3, design-v4, design-v5, pbrt-notes, restir-notes, sms-theory,
## sms-notes. Decisions and their
## rationale live there; check statuses before proposing work. V2 (BDPT),
## V3 (MMLT), V4a (ReSTIR), and V5 (SMS) are shipped. Veach path-space
## perturbations are SKIPPED permanently (2026-08-02; SMS covers the
## ground). NEXT UP: V5b — two-bounce specular chains (design-v5 §V5b
## DRAFTED 2026-08-03 + plan-v5b-implementation.md, awaiting Steve's
## markup; no code before agreement). Also open: rough/mesh casters
## (design-v5 follow-ups), the V4b decision (design-v4), and the talk's
## figure list (design-viz has been waiting on it).)

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

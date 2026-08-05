# Working conventions

**New here? Read `docs/ORIENTATION.md` first** — architecture, the demo
system, how to verify visually, and what is currently open.

**Plan first, always.** Never write code in this repo without a plan that has
been discussed and agreed with Steve. Propose the design, discuss trade-offs,
then implement. This applies to every feature, not just large ones.

## Architecture (agreed 2026-07-28 — see README.md, and the design docs in
## docs/: design-v0, design-v1, design-v1c, design-viz, design-v2,
## design-v3, design-v4, design-v5, design-cleanup, pbrt-notes,
## restir-notes, sms-theory, sms-notes. Decisions and their
## rationale live there; check statuses before proposing work. V2 (BDPT),
## V3 (MMLT), V4a (ReSTIR), V5 (SMS), and V5b (two-bounce chains) are
## shipped. Veach path-space perturbations are SKIPPED permanently
## (2026-08-02; SMS covers the ground). The design-cleanup consolidation
## pass shipped stages 0-4 (2026-08-04): shared direct-lighting estimator,
## scenes in src/scenes/, one Renderer interface, demo-facing modules;
## stages 5-6 deferred. NEXT UP: the demo rebuild — plus, unagreed,
## rough/mesh casters and chain-cost reduction (design-v5 follow-ups + the
## V5b checkpoint-2 note's recorded options), the V4b decision
## (design-v4), the talk's figure list (design-viz has been waiting on
## it), and the ReSTIR delta-light gap recorded in design-cleanup §7.
## Discuss with Steve before any code.)

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

## Demo pattern (ported from Steve's rendering-talk-visuals, 2026-08-04)

**Adding a demo is creating `demos/<name>/main.ts`. That is the whole
procedure** — one shared `demo.html?d=<name>` host page loads it, and
`src/registry.ts` finds it by glob, so there is no per-demo HTML and no
build-config entry. Optional title/blurb/section for the gallery go in
`src/registry.ts`'s INFO table.

- `import { createStage, createUI, C, matte } from '@'` (alias → `src/`).
- **Animate from the `t` the stage hands you, never `performance.now()`,
  and never call `Math.random()` in a demo** — the exporter renders by
  setting `t` and re-running the update, so wallclock stutters the video
  and reseeded randomness makes it boil.
- `stage.duration` is the loop period; make a motion complete one cycle
  over it and the exported video loops seamlessly.
- The canvas is a locked 16:9 box, letterboxed, exporting at 1920×1080 —
  what you frame is what lands in Keynote. `stage.shiftView(f)` frees
  space for a side-by-side pane without moving the camera.
- **DOM does not export.** Labels go in-canvas via `label()`
  (`src/viz/text.ts`); a CPU render goes in a `FilmPanel`
  (`src/viz/film-panel.ts`), a textured quad in HUD coordinates, fed from
  `RenderSession` or `WorkerPool` — never a DOM canvas beside the stage.
- Colours come from `src/viz/style.ts`; the path language's mapping onto
  it lives in `PATH_COLORS` (`src/viz/path-elements.ts`).
- Export: `S` = PNG, `V` = video, `H` = hide panel, `R` = restart,
  `space` = pause. Capture › from/to set the export range on the demo's
  clock (defaults to the whole loop). Frames POST to vite middleware which
  runs ffmpeg; everything lands in `out/` (gitignored, needs the dev
  server + ffmpeg).
- `demos/hello-stage/` is the worked example. `legacy/` holds the
  pre-rebuild demo set for reference only — not built, not typechecked.

## Testing

Sampling code fails silently — test it statistically: chi-square tests on
samplers, white-furnace tests on BSDFs, and cross-consistency (all
integrators must converge to the same image on test scenes) in `tests/`.

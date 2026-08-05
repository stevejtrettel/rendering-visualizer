# Orientation — read this first

You are picking up a repo that builds **figures for a talk on the
mathematics of path tracing**. Steve is a professor and a veteran
path-tracer author; the renderer is his and it is correct. Your job is
almost never "make the renderer work" — it is "make a picture that
explains something", against a renderer that already does.

Read `CLAUDE.md` for the working rules (plan before code; the demo
pattern), `README.md` for the architecture, and the `docs/design-*.md`
series for why things are the way they are. This file is the shortcut.

---

## 1. What the thing is

Two halves that share one core:

- **A CPU path tracer in TypeScript** (`src/core/`) — PT, NEE/MIS, BDPT,
  MMLT, ReSTIR, and specular manifold sampling. Pure: no DOM, no three.js.
  Runs in Node, in Web Workers, and in the browser unchanged.
- **A visualisation of that tracer** (`src/viz/`) — the same scenes in
  three.js with the *actual sampled trajectories* drawn into them.

The bridge is `src/trace/`: integrators emit `PathRecord` events, the film
consumes them to make an image and the visualiser consumes them to draw
rays. Because the sampler is a pure function of (seed key, dimension),
**re-tracing a key reproduces the same path exactly** — nothing per-path is
ever stored or shipped. That property is load-bearing; do not break it.

## 2. The three rules that actually bite

1. **`src/core/` is pure.** No DOM, no three.js, ever. Tests and offline
   renders depend on it.
2. **Demos animate from the `t` handed to them**, never `performance.now()`,
   and never call `Math.random()`. The exporter renders by setting `t` and
   re-running the update; wallclock or fresh randomness makes exported video
   stutter or boil.
3. **DOM does not appear in exports.** Captions must be in-canvas
   (`viz/text.ts`), a CPU render must be a `FilmPanel` (a textured quad),
   never an HTML `<canvas>` beside the stage.

## 3. Adding a demo

Create `demos/<name>/main.ts`. That is the whole procedure — a single
`demo.html?d=<name>` host page loads it and `src/registry.ts` finds it by
glob. Optional title/blurb in `registry.ts`'s INFO table.

```ts
import { createStage, createUI, C } from '@';       // '@' aliases src/
const stage = createStage({ position: [0, 2, 6] });
stage.duration = 8;                                  // loop length
createUI(stage);                                     // panel + S/V/H/R/space
stage.frame((t) => { /* animate from t */ });
stage.start();
```

Export: `S` = PNG, `V` = video (frames POST to vite middleware, ffmpeg
encodes), `H` = hide panel. Everything lands in `out/`. Capture `from`/`to`
set the range on the demo's clock.

Two hooks matter for anything slow:
- `stage.onReady(fn)` — awaited ONCE before an export starts.
- `stage.beforeCapture(fn)` — awaited before EVERY exported frame.
  `speed = 0` holds the preview but never the exporter, which drives
  `setTime` directly. This is how a path-traced or precomputed frame gets
  the time it needs.

## 4. Layout you will actually touch

```
src/core/          the tracer (pure)
  integrators/     pt, pt-term, pt-nee, pt-sms, bdpt, mmlt
                   estimators.ts holds what they share (camera preamble,
                   the MIS'd direct-lighting estimator) — do not re-inline it
src/scenes/        named scenes; library content, tests read it too
src/render/        film, Renderer facade over the 3 execution models,
                   worker, pool, session, convergence/comparison helpers
src/viz/           style.ts   the palette — retune to restyle the deck
                   stage.ts   renderer, 16:9 letterbox, the clock
                   capture.ts stills + frame-stepped video
                   beauty.ts  three-gpu-pathtracer wrapper for export
                   path-tubes.ts, pixel-rays.ts, film-panel.ts, ...
demos/<name>/main.ts
legacy/            the pre-rebuild demo set — reference only, not built
docs/              design-v0..v5, design-viz, design-cleanup, pbrt/sms notes
```

## 5. Verification, and what "done" means

```
npm run typecheck      # tsc --noEmit, strict + noUncheckedIndexedAccess
npm run test           # vitest, ~228 tests
npm run build          # static gallery
npm run dev            # http://localhost:5173
```

The suite is statistical (chi-square samplers, white-furnace BSDFs,
cross-integrator convergence). It is slow *by design* — `mmlt` alone is 28s.
`vitest.config.ts` sets a 60s timeout because the 5s default produced
spurious failures under load that look exactly like real sampling bugs.

**Verify visually.** A demo that typechecks is not a demo that works. There
is no Playwright here; drive headless Chrome directly:

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --disable-gpu --enable-unsafe-swiftshader \
  --no-sandbox --window-size=1280,720 --virtual-time-budget=14000 \
  --user-data-dir=/tmp/cr --screenshot=out.png \
  "http://localhost:5173/demo.html?d=<name>"
```

For anything needing interaction (toggles, export), use the CDP harness
pattern: launch with `--remote-debugging-port=9222`, connect over
`WebSocket` (Node 22+ has it built in), and drive `window.__ui.gui`
controllers by name. Note **SwiftShader is software rendering** — fine for
"is it correct", useless for "how fast is it".

## 6. Recent history (2026-08-04)

Two large passes landed, both documented:

- **`docs/design-cleanup.md`** — consolidation. Shared direct-lighting
  estimator (it had been copy-pasted three times and drifted), scenes moved
  out of `demos/` into `src/scenes/`, one `Renderer` interface over the
  three execution models, demo-facing modules. Stages 5–6 deliberately
  deferred; §7 records what shipping it turned up.
- **The demo system was replaced wholesale**, ported from Steve's
  `rendering-talk-visuals` repo: locked 16:9 stage, `t`-driven clock,
  one-button ffmpeg export, single host page, mineral palette. The old 21
  pages are in `legacy/`.

Current demos: `convergence`, `convergence-split`, `convergence-wipe`,
`material-test`, `material-properties`, `pixel-grid`, `hello-stage`.

## 7. Known-open, and things already ruled out

**RESOLVED (2026-08-04) — the "blob", and the flat rays.** Three separate
bugs in `PathTubes`, all invisible to the rasteriser and all visible in the
GPU path tracer. Worth reading as a set, because the shape of each is the
same: three-gpu-pathtracer sees the whole merged buffer, on its own terms.

- **The blob was the beads' TEMPLATE geometry.** three-gpu-pathtracer has no
  instancing support at all — not one reference to `isInstancedMesh` or
  `instanceMatrix` in its source — and its scene walk matches `o.isMesh`,
  which `InstancedMesh` satisfies. So it baked `SphereGeometry(1, 6, 4)`
  once under the object's world matrix: a radius-1 sphere at the world
  origin, on the floor under the subject. The earlier "not the beads,
  turning `end markers` off leaves it" experiment was misleading — that only
  sets `count = 0`, which the generator never reads. Beads are now one plain
  preallocated mesh, written in place like the tubes.
- **The rays rendered black.** The library synthesises an itemSize-**4**
  colour attribute for any geometry lacking one, so everything else in the
  merge is 4; the tubes supplied 3, and its itemSize-3→4 promotion branch in
  `mergeGeometries` is broken upstream (it writes the *source* attribute and
  indexes it with the merge offset), leaving the target rows zero. Measured:
  all 1536 tube vertices arrived with colour (0,0,0), so the whole ramp was
  multiplied by black and only the uniform emissive glow survived. Colours
  are itemSize 4 now. Left at 3 it is also a coin flip — geometries sort by
  uuid, so on the runs where the tubes sort first the *scene* breaks instead.
- **The rays looked flat.** The ring winding was inverted relative to the
  shading normals (measured 0/24 triangles agreeing, min dot −0.982). The
  tracer takes `surfaceHit.side` from the winding and then does
  `normal *= side`, so every exterior hit became a back-face hit and the
  shading normal was flipped to point *into* the tube; direct lighting on
  the visible side was then discarded by `isSampleBelowSurface` and
  `isDirectionValid`. `DoubleSide` had been hiding it in the preview. Now
  144/144 agree across both helper-axis branches, beads 72/72.

The `park()` finding still stands and is still true: `StaticGeometryGenerator`
ignores `drawRange`, so unwritten slots must be moved somewhere unhittable
rather than left at the origin. It just was not the blob.

Method note, since it generalises: all of this was diagnosed by running the
tracer's own scene merge under vitest in Node — no WebGL needed — and
counting vertices. Reach for that before another screenshot A/B.

**Also open, unrelated:** ReSTIR has no delta-light support (its reservoir
target is zero at a point light; measured ~0.42× NEE). Recorded in
`design-cleanup.md` §7, pinned by `tests/delta-light-mis.test.ts`.

## 8. Working with Steve

- **Plan before code.** Every time, not just for large things.
- He gives terse, high-signal direction and will correct you fast. When he
  says something looks wrong, it is wrong — go and measure, do not explain
  why it might be fine.
- **Measure rather than assert.** Framing, exposure, sample counts, timings:
  there are one-off vitest probes throughout this history for exactly this,
  and they are cheap. Guessing at a number and stating it confidently is the
  main way to waste his time.
- Ask him to run things rather than building elaborate verification for
  yourself — but do verify what you can, especially anything visual.
- Comments in this repo carry measurements and dates. Preserve them when
  refactoring; they are the record of what was already tried.

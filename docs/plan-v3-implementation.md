# V3 Implementation Plan — MMLT (staged, reviewed per checkpoint)

*Written 2026-07-30. Decisions and rationale: `design-v3.md`. Mechanics
with citations: `pbrt-notes.md` §MLT/MMLT. STOP and report to Steve after
each checkpoint; the file lists below are the exact scope — propose
anything further before writing it.*

## Working rules (non-negotiable, see CLAUDE.md + memory)

- Steve reviews at each checkpoint — STOP and report after each.
- Integrators accumulate, never replace: PT / NEE / BDPT untouched except
  the one named refactor in checkpoint 2.
- Tests land WITH their components. `npm run typecheck` + `npm test` green
  before any checkpoint report.
- Demos verified in a real browser before the checkpoint 3 report
  (Playwright via
  `/Users/strettel/Code/PathTracerGLSL/node_modules/playwright/index.mjs`;
  parse the dev-server port from output; kill leaked servers).

## Existing seams this build stands on (do not re-derive)

- `Sampler.startStream` + CAMERA/LIGHT/CONNECTION constants — BDPT already
  calls them at its real phase boundaries; MLTSampler makes them live.
- `SeedKey` is opaque; sampler state is a pure function of (key, dims
  consumed) — chains key on bootstrap indices and replay by re-seeding.
- `connectStrategy(scene, cameraVs, lightVs, s, t, options, u)` is
  exported and pure; `misWeight` reads only the (s, t) prefixes, so
  exact-length subpath arrays evaluate a single strategy.
- `Film.splat` + develop-time `splatScale`; splat-only images are the
  design for MLT (`b/mutationsPerPixel`).
- Worker films merge by summation — chain-partitioned MMLT needs no pool
  changes beyond protocol naming.
- `WalkOptions.rrStartDepth` — roulette off via `Infinity`, no walk edits.

## Checkpoint 1 — MLTSampler (the primary-space kernel; no rendering)

Files: `src/core/math/sampling.ts` (add `erfInv`),
`src/core/sampler/sampler.ts` (add `chainSeedKey`),
`src/core/sampler/mlt.ts` (new), `tests/mlt-sampler.test.ts` (new).

1. `erfInv(x)` in `core/math/sampling.ts` — Giles' polynomial (pbrt's
   ErfInv); feeds the Gaussian small step.
2. `chainSeedKey(bootstrapIndex)` beside `pixelSeedKey` — tagged so chain
   streams can never collide with pixel streams.
3. `MLTSampler` per design-v3 §Components: lazy PrimarySample array,
   stream-interleaved slot mapping `i + streamCount·pos++`, small/large
   steps, `startIteration/accept/reject`, `startPixelSample` = chain
   (re)init, instrumentation accessors (`iteration`, `isLargeStep`,
   `primaryValues()`) for tests and the V3 chain viz. Options
   `{sigma = 0.01, largeStepProbability = 0.3, streamCount = 3}`.
4. Tests (`tests/mlt-sampler.test.ts`):
   - determinism: same key + same scripted mutate/accept/reject history ⇒
     identical draws; distinct keys ⇒ distinct; bounds [0,1) throughout;
   - erfInv table values;
   - small-step statistics: signed torus displacement mean ≈ 0, sd ≈ σ;
   - CLASSIC BUG 1 (lazy large-step reset): a dimension untouched across
     an accepted large step returns fresh (mean torus distance from its
     stale value ≈ uniform's 0.25, not ~σ);
   - CLASSIC BUG 2 (reject): touched values restored exactly AND the
     iteration counter decrements (via accessors);
   - stream locality: growing stream 0's consumption between iterations
     leaves stream 1's values within small-step distance (a flat global
     counter fails this);
   - kernel end-to-end: bootstrap → weighted seed pick → Metropolis chain
     on an analytic target on [0,1)² (driver-side accept RNG,
     expected-value deposits); histogram vs analytic bin masses + moment
     checks, deterministic seeds.

## Checkpoint 2 — MMLT state evaluation + driver (single-threaded)

Files: `src/core/integrators/bdpt.ts` (extract raster-taking camera-subpath
variant), `src/core/integrators/mmlt.ts` (new),
`src/render/mlt-driver.ts` (new), `src/trace/recorder.ts` +
`src/trace/records.ts` (mutation events), `tests/mmlt.test.ts` (new).

1. Refactor: `cameraSubpathFromRaster(scene, raster, sampler, recorder,
   options)`; existing `generateCameraSubpath` becomes a thin wrapper
   (draws `nextPixel2D`, delegates). BDPT behavior byte-identical
   (existing tests prove it).
2. `mmltState(scene, sampler, depth, options)`: camera stream dim 0 →
   `nStrategies = depth + 2`, `s = min(⌊u·n⌋, n−1)`, `t = n − s`
   (depth 0 forces (0,2)); dims 1–2 → raster over the full film; subpaths
   at exactly t and s vertices (`maxBounces` trimmed, `rrStartDepth = ∞`);
   reject length-shortfall states as zero; `startStream(CONNECTION)`;
   `connectStrategy`; return `{L = weighted·nStrategies, raster, s, t}`
   (t = 1 uses sampleWi's raster). Heuristic default `balance`.
3. `runMlt(scene, film, options, recorder)` in `src/render/mlt-driver.ts`:
   bootstrap `nBootstrap` seeds (depth `i mod (maxDepth+1)`), `b`;
   chain seeds ∝ weight; per mutation both-states splatting with
   zero-luminance guards; driver-side PCG for accept draws and seed picks;
   develop with `splatScale = b/mutationsPerPixel`. Options
   `{nBootstrap, nChains, mutationsPerPixel, maxDepth = 8, sigma,
   largeStepProbability, heuristic = 'balance'}` (numeric defaults
   proposed at review with measured timings).
4. Recorder: `mutationBegin/mutationEnd` events; lossy flatten to records.
5. Tests (`tests/mmlt.test.ts`): large-step-only ≡ BDPT on `cornell`;
   cross-integrator convergence on `cornell` + the glass box (means
   compared — `b` bias shows there); determinism (bit-identical film);
   depth-0 strategy forcing; zero-luminance guard paths.

## Checkpoint 3 — workers, demos, docs

1. Protocol: `IntegratorName` gains `'mmlt'`; mutation-batch pass
   semantics; redundant deterministic bootstrap per worker with disjoint
   chain ranges; error view disabled for MMLT.
2. `demos/viz-mlt-chain` (new): chain replay per design language (current
   solid, proposal ghosted, accept solidifies / reject evaporates), splat
   image panel, acceptance-rate readout. Gallery link in root
   `index.html`.
3. `render-still` + `viz-convergence` gain `mmlt` (equal-time SDS caustic
   figure).
4. Docs: statuses in design-v3.md, README, CLAUDE.md NEXT UP pointer;
   report measured timings.

## Definition of done

All three checkpoints reviewed; suite green including large-step-only ≡
BDPT and the glass-box convergence; chain demo verified in-browser; docs
updated. THEN the next conversation is V4 (path-space lens + caustic
perturbations — the "designing good proposals" punchline).

# V4 Implementation Plan — ReSTIR (staged, reviewed per checkpoint)

*Written 2026-07-31. Decisions and rationale: `design-v4.md`. Mechanics
with equation-level citations: `restir-notes.md` (SIGGRAPH 2023 course
notes rev. 2024 + Bitterli 2020, Talbot 2005, Lin 2022, Bitterli 2022).
STOP and report to Steve after each checkpoint; file lists are the exact
scope — propose anything further before writing it.*

## Working rules (non-negotiable, see CLAUDE.md + memory)

- Steve reviews at each checkpoint — STOP and report after each.
- Integrators accumulate, never replace: pt / pt-nee / bdpt / mmlt
  untouched (pt-nee is reused as machinery, not modified in place).
- Tests land WITH their components. `npm run typecheck` + `npm test`
  green before any checkpoint report.
- Demos verified in a real browser before the checkpoint 3 report
  (Playwright via
  `/Users/strettel/Code/PathTracerGLSL/node_modules/playwright/index.mjs`;
  parse the dev-server port; ride out vite re-optimize reloads before
  driving selects; kill leaked servers).
- Course Tip 5.2 is house policy anyway: "correct, principled and slow
  first" — no optimization before the staged validations pass.

## Existing seams this build stands on (do not re-derive)

- `core/lights/distribution.ts`: the light-selection interface has
  `sample(u) → {light, pmf}` AND `pmf(light)` — reserved since V0 for
  the PowerLightSampler (pbrt-notes §PowerLightSampler: weights ∝
  `phi()`, needs both entry points).
- `Sampler` streams + fixed dimension layout: per-stage consumption
  (candidates / WRS / neighbor picks) keyed per (pixel, pass) — replay =
  re-run passes 0..k (the pixel/chain idiom, third appearance).
- `mlt-driver.ts` is the pattern for a stateful whole-frame driver
  beside `renderPass`; `MltRunner`'s worker-batching shows how
  non-exchangeable state integrates with the protocol.
- The reworked viz-convergence protocols (equal samples / equal time)
  and the equal-time MSE probe methodology from the MLT investigation.
- Film 'sample' contributions only — ReSTIR never splats.
- ArrayRecorder/records: extend with lineage events, keep flatten lossy.

## Checkpoint 1 — resampling core + power sampler (no rendering)

Files: `src/core/restir/reservoir.ts` (new), `src/core/restir/mis.ts`
(new), `src/core/lights/power.ts` (new), `tests/reservoir.test.ts`
(new), `tests/power-light.test.ts` (new).

1. `reservoir.ts`: `Reservoir` per course Algorithm 3 — fields
   {y, wSum, confidence, W}; `update(candidate, w, c, u)` (streaming WRS
   with an explicit uniform argument — no hidden RNG; determinism stays
   sampler-owned); `finalize(pHatY)` setting W = wSum/p̂(Y) (0 for null);
   confidence capping min(c, cCap). Merge is `update` with
   (Y, m·p̂·W·, c) — one code path, no special merge function (course:
   merging IS resampling).
2. `mis.ts`: generalized balance heuristic (course eq 5.10/5.11 in the
   identity-shift specialization) and defensive pairwise MIS with
   confidence weights (eq 7.8; Algorithm 7 structure, identity-shift
   p̂←ᵢ = p̂ᵢ). Pure functions over candidate descriptors; an
   `assertWeightSum` helper (Σmᵢ = 1 within 1e-9) for tests/debug flags.
3. `power.ts`: `PowerLightSampler` — pmf ∝ `light.phi()`, both `sample`
   and `pmf` (alias table unnecessary at our light counts; a CDF walk is
   fine and deterministic).
4. Tests:
   - WRS marginal: selection frequency ∝ weights (chi-square, seeded);
   - unbiasedness: E[f(X)·W_X] = ∫f on an analytic discrete/1D target
     against closed form, for 1/M and pairwise weights;
   - merge associativity: k chained reservoir merges ≡ one-pass RIS over
     the concatenated candidates (distributional: chi-square on selected
     ids AND matching E[W]);
   - confidence: caps at cCap; fresh sample c = 1; RIS-of-M gives c = M;
   - pairwise MIS: Σmᵢ = 1 exactly across randomized candidate sets;
     defensive weights match balance when all p̂ identical;
   - power sampler: pmf matches phi ratios; chi-square on selection;
     `pmf(light)` consistent with `sample`.

## Checkpoint 2 — the frame driver, staged validations, full integral

Files: `src/render/restir-driver.ts` (new), `demos/_shared/scenes.ts`
(add `chandelier`), `src/trace/recorder.ts` + `records.ts` (lineage
events), `tests/restir.test.ts` (new).

1. `RestirRunner` (mlt-driver pattern): per-pixel buffers (reservoir +
   primary-hit G-data (position/normal/depth + primitive)); one `pass()`
   = primary trace → M light candidates/pixel (PowerLightSampler,
   p̂ = f_s·G·V·L_e with visibility, mᵢ = 1/M) → temporal merge
   (identity motion, current-pass p̂, confidence cap 20) → K spatial
   rounds × N neighbors (radius R, normal/depth gates; picks from the
   sampler's fixed layout) → shade + CONTINUE THE WALK for indirect
   (pt-nee machinery from the primary hit; primary-vertex accounting per
   design decision 4: reservoir owns primary direct; bounce-2 emitter
   hits contribute zero direct; delta primaries skip the reservoir
   entirely; deeper vertices standard NEE+BSDF MIS).
   Options: {M = 32, spatialRounds K = 2, neighbors N = 5, radius = 10px
   at 320² (scaled by res), cCap = 20, misWeights: 'pairwise' | 'oneOverM',
   pHatVisibility: true, assertWeights, seed}.
2. Staging INSIDE the checkpoint, validated in order (course Tip 4.4),
   via test configurations that disable later stages:
   a. candidates-only, direct component only ≡ NEE-DI reference (tight);
   b. + spatial with pairwise MIS ≡ still (and the 1/M toggle FAILS this
      test measurably — the negative control);
   c. + temporal: long-run pass-averaged image ≡ (the silent-bias test);
   d. full integral: 'restir' ≡ pt-nee ≡ bdpt on cornell + chandelier at
      the shared depth cap (house cross-integrator convergence);
   e. determinism: bit-identical film AND reservoir buffer per pass;
   f. equal-time MSE numbers (probe methodology from the MLT
      investigation) on chandelier + door-ajar vs pt-nee — the design's
      claims get numbers before any demo shows them.
3. `chandelier` scene: 8×8 small colored ceiling emitters, ~50× radiance
   spread, Cornell furniture; register + scene-sheet pickup.
4. Recorder: lineage events (per pixel per pass: winner light point,
   which neighbor/temporal source fed the final reservoir, candidate
   count) — plain data, lossy flatten as always.

## Checkpoint 3 — workers, demos, docs

1. Protocol: 'restir' IntegratorName; worker holds a `RestirRunner`; a
   pass message = one frame (passes are NOT exchangeable across workers
   — restir panes use a size-1 pool at first; a tile-partitioned pool is
   a recorded follow-up if throughput demands).
2. `demos/viz-restir-flow` (marquee): pixel picking, reservoir sample
   drawn in-scene, reuse-lineage arrows, pass stepping; bias toggle
   (pairwise vs 1/M) here unless a tiny dedicated page reads better.
3. viz-convergence + render-still gain 'restir' (full transport, shared
   depth cap); gallery + README + design-viz statuses; CLAUDE.md NEXT UP.
4. Report measured timings and the chandelier/door-ajar MSE table.

## Definition of done

All three checkpoints reviewed; suite green including the staged
validations, negative control, and full-integral convergence;
viz-restir-flow verified in-browser; equal-time numbers reported; docs
updated. THEN the V4b decision (faithful gated reconnection reuse of the
indirect tail) is made from V4a's measurements — the door-ajar MSE table
in particular.

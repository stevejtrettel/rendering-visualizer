# V3 Design — Metropolis (PSSMLT/MMLT)

**Status**: ✅ shipped 2026-07-30 (all three checkpoints of
`docs/plan-v3-implementation.md`). MLTSampler + MMLT state evaluation +
MltRunner driver; `'mmlt'` in the worker protocol (redundant deterministic
bootstrap, chains partitioned by batch); demos: `viz-mlt-chain` (chain
replay per the design language), MMLT panes in `render-still` and
`viz-convergence` (shared 8-bounce depth cap for pane parity). Measured on
`cornell`: small-step acceptance ~89% (the flattened-target story,
empirically); per-pass cost ×1.0 — the CHEAPEST pane in render-still (BDPT
×10.1). One deliberate divergence from pbrt (fresh-uniform materialization)
recorded below and in pbrt-notes §MLT. NEXT: V4 — path-space lens/caustic
perturbations, the "designing good proposals" punchline.

*Sources: docs/pbrt-notes.md §MLT/MMLT (pbrt-v3 mlt.cpp mechanics, banked
2026-07-28), Kelemen et al. 2002 (primary sample space), Hachisuka et al.
2014 (multiplexed MLT), Veach thesis ch. 11 + Thm 9.4.*

## What Metropolis is, stated for the talk

Everything before V3 draws **independent** samples: each path is built from
nothing, used once, discarded — a path that threaded the glass by luck
evaporates as fast as one that died in a corner. Metropolis runs a Markov
chain whose states are complete transport paths and whose stationary
distribution is proportional to the energy a path carries. Three verbs:

- **Seek** — a bootstrap phase throws ordinary independent (BDPT) samples
  at the scene and records each one's brightness: a census of path space.
- **Find** — chains start at paths drawn proportionally to that measured
  brightness, so they start already in equilibrium: zero burn-in. The
  bootstrap also yields the normalization `b` (mean image brightness) that
  scales the final image.
- **Mutate** — each step perturbs the current path and accepts/rejects by
  `min(1, brighter/dimmer)`. A bright caustic path, once found, is revisited
  with small variations; its splats on the film are its footprints.

The V3 trick (Kelemen): **don't mutate the path — mutate the random numbers
that built it.** The integrator run on a fixed vector u ∈ [0,1)ⁿ is a
deterministic chart map Φ: cube → path space, smooth almost everywhere
(each sampling routine is a smooth warp; seams at discrete choices and
silhouettes are legal, occasionally-bold proposals). The Markov state is
the vector of consumed uniforms itself — NEVER the RNG seed, which is a
hash and maximally discontinuous. Small steps nudge every coordinate at
once by a wrapped Gaussian (the whole path breathes); occasional large
steps draw fresh uniforms (a teleport that guarantees ergodicity and
unbiasedness). Because the proposal is symmetric on the torus, acceptance
is just the brightness ratio.

Slide-ready extras: the target in the cube is I(u) = luminance of
f(Φ(u))/p(Φ(u)) — the very ratio all our importance sampling was built to
flatten, so the chain accepts nearly everything where BDPT already samples
well and concentrates automatically on the residual (the caustic);
all-small-steps = trapped vs all-large-steps = reinvented independent
sampling; correlated "smudge" noise vs independent grain as the visible
price. The payoff scene is the SDS caustic where every BDPT strategy
degenerates to PT (design-v2's recorded limitation — V3's motivation).

**The V3/V4 arc**: V3 mutations live in the hypercube — all validity and
transition-density bookkeeping free, but you cannot wiggle the middle of a
path while holding both ends fixed (the lever arm: cube-uniform nudges
amplify down the path). V4's hand-designed lens/caustic perturbations
mutate the geometry itself — that is where "designing good proposals"
lands as the punchline, with V3 as its setup.

## Architectural decisions (agreed)

1. **MMLT, not Kelemen-PSSMLT** — one strategy per state: camera-stream
   dim 0 picks (s,t) with `nStrategies = depth + 2`, dims 1–2 are the
   raster; depth fixed per chain; contribution = weighted `connectStrategy`
   × nStrategies. Cheaper per mutation, pbrt-notes arithmetic applies
   verbatim. The talk still tells the Kelemen story first — the strategy
   index and raster are just three more primary dimensions.
2. **MIS heuristic inside MMLT defaults to `balance`** (Veach Thm 9.4:
   balance is exactly optimal for one-sample MIS, which the multiplexed
   strategy pick is; Hachisuka and pbrt agree). BDPT keeps `power`; same
   toggle, different default.
3. **Russian roulette OFF in MLT walks** (`rrStartDepth = ∞`): chains need
   subpaths of exactly s and t vertices; RR would randomly zero proposals
   and fatten the rejection rate. pbrt's BDPT walks have no RR at all.
   Fixed-dimension-layout is per-integrator, so this is consistent.
4. **MMLT maxDepth defaults to 8**, its own option (BDPT renders at 32).
   Per-chain depth allocation makes a big cap wasteful (pbrt uses 5); the
   glass-box SDS path needs ~6–7.
5. **Parallelism by redundant deterministic bootstrap**: every worker runs
   the identical seeded bootstrap (same `b`, same weight table) and takes a
   disjoint chain-index range; splats merge by summation as today,
   `splatScale = b/mutationsPerPixel` at develop. No new protocol shapes
   beyond an `'mmlt'` integrator name and mutation-batch pass semantics.
   The film's `standardError` view is meaningless under correlated
   samples — disabled for MMLT, itself a talk point.
6. **Chain visualization is seed replay, one level up**: a chain's entire
   history is a pure function of its bootstrap seed index (the MLTSampler's
   entropy source is a PCG seeded by it), so the visualizer re-runs a chain
   for N mutations with an ArrayRecorder — no storage, the same idiom as
   pixel replay. Design language already specifies the look: current path
   solid, proposal ghosted; accept = ghost solidifies, reject = evaporates.

### Components

- **`src/core/sampler/mlt.ts` — MLTSampler** (implements `Sampler`): lazy
  `PrimarySample` array (value, lastModificationIteration, backups); on
  read, reset-if-predates-last-large-step, then apply the pending mutation.
  Small step: wrapped Gaussian, σ = 0.01, `sqrt(nPendingSmallSteps)·σ·N(0,1)`
  via erfInv. Large step: fresh uniform, probability 0.3 (both
  constructor options). `startStream(i)` goes live:
  `slot = i + streamCount·posInStream++` — a length change in one stream
  cannot re-map another stream's coordinates. Chain lifecycle beyond
  `Sampler`: `startIteration()`, `accept()`, `reject()` (restore touched
  samples AND decrement the iteration counter — the two classic PSSMLT
  bugs are forgetting the lazy reset and this decrement).
  `startPixelSample(key)` = full chain (re)initialization from the key —
  bootstrap seeding and chain regeneration use the standard interface.
  One deliberate divergence from mlt.cpp (agreed 2026-07-30): coordinates
  first read mid-chain materialize as fresh uniforms dated at the last
  accepted large step (the eager-equivalent marginal), not pbrt's zero —
  see pbrt-notes §MLT for the do-not-regress note.
- **`src/core/integrators/mmlt.ts`** — pure state evaluation (not an
  `Integrator`): draws strategy + raster from the camera stream, generates
  the two subpaths at exactly t and s vertices (roulette off), then
  `startStream(CONNECTION)` and `connectStrategy(s, t)`. Requires one
  refactor: a raster-taking variant of `generateCameraSubpath` (MMLT's
  raster is Markov state, not a stratification hint).
- **`src/render/mlt-driver.ts`** — bootstrap (`nBootstrap` seeds, depth
  `i mod (maxDepth+1)`, `b = mean(weights)·(maxDepth+1)`), chain seeds
  drawn ∝ weight and regenerated by re-seeding, then per mutation
  both-states splatting: `splat(pProp, Lprop·a/lum(Lprop))` and
  `splat(pCur, Lcur·(1−a)/lum(Lcur))`, `a = min(1, lum_prop/lum_cur)`,
  guarding zero luminance. Everything is a splat — MLT never touches
  `addSample`. The accept/reject draw comes from a driver-side RNG, not
  from the primary samples.
- **Recorder**: `mutationBegin {index, type: 'small'|'large'}` /
  `mutationEnd {accepted, a, proposalLum, currentLum}` bracketing the
  proposal's walk/connection events.

## Validation plan

- **MLTSampler unit tests targeting the two classic bugs by name**: the
  lazy large-step reset (a dimension untouched across an accepted large
  step must come back fresh, not small-stepped from its stale value) and
  reject-restores-and-decrements (both directly observable via the
  instrumentation accessors the chain viz needs anyway). Plus stream
  locality (growing one stream's consumption leaves another stream's
  values within small-step distance), determinism, [0,1) bounds,
  small-step torus symmetry (mean ≈ 0, sd ≈ σ), erfInv against table
  values.
- **Kernel-level statistical test**: drive the full
  bootstrap/seed/mutate/accept machinery against a synthetic analytic
  target on [0,1)² (no rendering); chi-square-style histogram comparison
  plus moment checks. Validates the acceptance rule, proposal symmetry,
  and ergodicity in isolation.
- **Large-step-only ≡ BDPT**: with largeStepProbability = 1 every mutation
  is an independent bootstrap-distributed sample; the developed image must
  converge to BDPT's on `cornell`. The single strongest end-to-end check —
  isolates the Markov machinery from the contribution function.
- **Cross-integrator convergence**: MMLT vs BDPT vs NEE on `cornell` and
  the glass box. `b` errors are a global multiplicative bias — compare
  means, not just structure.
- **Determinism**: same seed ⇒ bit-identical film.

## Demos / figures

- `viz-mlt-chain` (new): replay one chain — scene view with current path
  solid / proposal ghosted per the design language, an image panel
  accumulating the chain's splats live, small/large-step markers and a
  running acceptance rate. The most Metropolis-native figure the talk has.
- `render-still` and `viz-convergence` gain `mmlt`: the payoff is the SDS
  caustic quiet under MMLT where BDPT stayed PT-grade, and the honest
  cost — smudgy correlated noise on the flat diffuse wall at equal time.

## Checkpoints

1. MLTSampler + kernel tests (no rendering).
2. MMLT state evaluation + driver + convergence tests (single-threaded).
3. Worker-pool integration + demos + docs.

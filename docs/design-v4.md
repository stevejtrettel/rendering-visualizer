# V4 Design — ReSTIR (full transport; reservoirs own primary direct)

**Status**: agreed 2026-07-31 after research + discussion (supersedes the
draft design-restir.md; sources banked in `docs/restir-notes.md` with
equation-level citations to the SIGGRAPH 2023 course notes, Bitterli
2020, Talbot 2005, Lin 2022, Bitterli 2022). Decisions recorded below;
each overridable at checkpoint review. Veach path-space perturbations are
SHELVED (not V4; revisit only if the talk demands it). Execution plan:
`docs/plan-v4-implementation.md`.

## What ReSTIR is, stated for the talk

The same question Metropolis answers — *you found a good path; what
now?* — with the opposite architecture. MLT keeps the good path in a
Markov chain and mutates it: sequential reuse, correlated footprints,
and (as our door-ajar measurements showed) no win when the underlying
estimator isn't actually crippled. ReSTIR keeps the good sample in a
per-pixel RESERVOIR and lets pixels share reservoirs with their
neighbors and their own past frames: parallel reuse, aggregating
thousands of candidates per pixel at ~the cost of one, with MIS weights
(not acceptance tests) keeping the estimator honest. Where MLT's
currency is the acceptance ratio, ReSTIR's is the unbiased contribution
weight W_X — a weight that acts like 1/pdf even when the pdf is
intractable (E[W_X | X] = 1/p(X)).

Slide-ready extras: RIS as an aggregation machine (many mediocre
candidates → one well-distributed sample); reservoirs as O(1) streaming
aggregation; iterated reuse compounding M₁×M₂×… candidates over frames;
bias as a VISIBLE image artifact (darkening at geometry edges under
naive 1/M weights) rather than an abstract warning; and the closing
taxonomy — mutate it (MLT) / share it (ReSTIR) / learn from it (path
guiding) / splat it (photon methods) — with ReSTIR as the corner
real-time engines actually adopted.

## The staged scope (agreed)

**V4a (this design): full transport, reservoirs own direct lighting at
the primary vertex.** The Bitterli-2020 integration pattern: per pixel,
RIS/reservoir machinery estimates direct illumination at the first
non-delta... at the primary hit; the ordinary NEE walk continues from
that hit for ALL indirect transport and for direct lighting at deeper
vertices. The total is the SAME full transport integral as pt-nee at the
shared depth cap — every cross-integrator comparison and convergence
test applies unchanged, and 'restir' sits in viz-convergence's dropdowns
beside pt/pt-nee/bdpt/mmlt with no caveats. The reused object is the
light vertex x₂ in world space: identity shift, Jacobian 1 — NO shift
mappings anywhere in V4a (restir-notes §Reuse across domains).

**V4b (optional, decided by V4a's measurements)**: extend reuse to the
indirect tail with the FAITHFUL reconnection shift (re-evaluate both
BSDFs, geometry term, fresh shadow ray — the unbiased kernel of ReSTIR
GI, not its biased radiance-caching shortcut) gated by the hybrid
shift's distance + roughness conditions; the random-replay portion is
our native seed-replay idiom. Scope, cost, and worth are an empirical
question V4a answers first — the same discipline as the MLT
investigation.

## Architectural decisions

1. **New pure core module `src/core/restir/`**: `Reservoir` per course
   Algorithm 3 (streaming update, confidence c, finalize
   W_Y = w_sum/p̂(Y); merge = update with (Y, p̂·W·, c) as a weighted
   candidate), c_cap = 20. Plain serializable state — a frame's
   reservoirs are flat typed arrays, worker-transferable and
   visualizer-inspectable. Null samples: W_∅ = 0, never redrawn, m(∅)=0.
2. **A frame-based renderer** `src/render/restir-driver.ts` (the
   mlt-driver pattern — ReSTIR needs per-pixel persistent state and
   whole-frame stages; the per-pixel `Integrator` interface cannot
   express it). Per pass (= frame): trace primary hits → M initial light
   candidates per pixel (RIS, mᵢ = 1/M — identical distributions) →
   temporal merge with the previous pass's buffer (identity motion;
   p̂_prev = p̂_cur up to the pixel jitter, evaluated with the CURRENT
   pass's primary hit, per course §4.3's "x₀, x₁ possibly randomized per
   frame") → K spatial rounds over N neighbors (disk radius, gated by
   normal/depth similarity, NEVER by reservoir contents — Tip 4.1) →
   shade: direct = f(Y)·W_Y at the primary vertex + continue the walk
   for indirect (ordinary pt-nee machinery from the primary hit onward).
3. **Target function p̂ = f_s·G·V·L_e, visibility included** (Tip 4.3;
   we are CPU-side and correctness-first). The unshadowed Talbot variant
   is a demo toggle — "what dropping V from the target costs" is a
   figure.
4. **Primary-vertex strategy accounting** (the one genuinely subtle
   correctness point, resolved from the sources): at the primary vertex,
   direct lighting is owned ENTIRELY by the reservoir — the continued
   walk's emitter hit at bounce 2 contributes ZERO direct (its MIS
   weight against the intractable reservoir pdf cannot be evaluated;
   dropping the BSDF-direct strategy at the primary vertex is unbiased
   because area-light NEE alone covers the direct integrand — variance,
   not bias, is the cost, and it is acceptable on our diffuse-dominant
   scenes). At DELTA primary vertices (glass/mirror pixels) the
   reservoir is skipped entirely and the ordinary specular machinery
   applies unchanged. Deeper vertices: pt-nee's usual NEE+BSDF MIS,
   untouched. OPTION (recorded, not built in V4a): BSDF-sampled
   candidates INTO the reservoir with per-technique mᵢ (course §4.5,
   §6.2) — the principled glossy-primary upgrade if GGX-primary noise
   ever matters.
5. **MIS for reuse: generalized pairwise MIS, defensive form, with
   confidence weights** (restir-notes §MIS menu; course eq 7.8 /
   Algorithm 7), canonical = the current pixel's fresh-candidate
   reservoir. Per-sample Σmᵢ = 1 assertion behind an `assertWeights`
   flag (house specialty, third appearance). The biased 1/M variant is
   kept as an explicit toggle: the darkening-at-edges figure AND the
   negative control proving our bias tests detect bias.
6. **PowerLightSampler** gets built (the V0 light-distribution interface
   reserved `pmf()` for exactly this): candidate quality on many-light
   scenes; the NEE baseline gets it too so comparisons stay honest.
7. **Determinism/replay unchanged in spirit**: all randomness through
   the Sampler (per-pixel-per-pass keys; fixed dimension layout per
   stage: M candidate draws, WRS selection draws, K×N neighbor picks);
   the reservoir buffer at pass k is a pure function of (seed, k) —
   replay = re-run passes 0..k, the same idiom as pixels and chains.
   Recorder gains reuse-lineage events (which neighbor/history fed each
   merge, candidate positions, winner) for the flow visualization.
8. **Worker/protocol**: 'restir' as an IntegratorName; a pass = a frame;
   reservoir buffer lives worker-side alongside the film. NOTE: unlike
   our other integrators, ReSTIR's passes are not exchangeable — pass k
   depends on pass k−1's reservoirs — so the sample-parallel pool CANNOT
   split restir passes across workers naively (open question resolved in
   plan: single-worker pools for restir panes at first; a
   tile-partitioned pool is a recorded option if throughput demands it).

## Scenes

- **`chandelier`** (new): the many-light showcase — 8×8 grid of small
  colored ceiling emitters, ~50× radiance spread, over Cornell
  furniture. Uniform light selection starves; power selection helps;
  resampling + reuse is the point.
- **`door-ajar`**: hard direct visibility — most candidates fail V; the
  reservoirs that find the slit spread the discovery spatially. Measured
  with the MSE harness, not assumed.
- **`cornell`**: sanity/convergence baseline.

## Validation plan (assertions itemized in restir-notes)

- Statistical, no rendering: WRS selection ∝ weights (chi-square);
  E[f(X)W_X] = ∫f on an analytic target; merge associativity (chained ≡
  one-pass, distributional); confidence capping behavior.
- Per-sample Σmᵢ = 1 assertion for pairwise + balance weights.
- Staged cross-checks (course Tip 4.4): candidates-only ≡ NEE-DI on the
  direct component; + spatial still ≡; + temporal over passes: LONG-RUN
  pass-averaged image still ≡ (the silent-bias test — M-capping bounds
  correlation, not bias).
- Negative control: the 1/M toggle must FAIL the spatial test measurably.
- FULL-INTEGRAL cross-integrator convergence: 'restir' ≡ pt-nee ≡ bdpt
  on cornell + chandelier at the shared depth cap (the house theorem).
- Determinism: same seed ⇒ bit-identical reservoir buffer and film every
  pass.
- Equal-time MSE numbers (the reworked harness) on chandelier +
  door-ajar vs pt-nee: the figures' backbone.

## Demos / figures

- **`viz-restir-flow`** (marquee): pick a pixel; draw its reservoir's
  light sample in the scene and the REUSE LINEAGE — arrows from the
  spatial neighbors and temporal history that fed it; step passes to
  watch one lucky discovery (slit-threading sample, rare bright emitter)
  propagate across the image. The mirror image of viz-mlt-chain.
- **viz-convergence**: 'restir' joins the dropdowns (full transport — no
  caveats), equal-time and equal-samples protocols as reworked.
- **Bias figure**: pairwise vs 1/M toggle (in viz-restir-flow or a tiny
  dedicated page — decide at checkpoint 3 by what reads best).
- render-still fifth pane; scene-sheet picks up chandelier; gallery/README.

## Checkpoints

1. `core/restir/` (reservoir + RIS + pairwise MIS) + PowerLightSampler +
   statistical tests. No rendering.
2. restir-driver, staged per course Tip 4.4: candidates-only ≡ NEE-DI;
   + spatial (pairwise MIS, weight-sum assertion, negative control);
   + temporal with long-run test; full-integral integration (walk
   continuation) with cross-integrator convergence; chandelier scene;
   equal-time MSE numbers.
3. Worker/protocol integration + viz-restir-flow + comparison panes +
   docs statuses.

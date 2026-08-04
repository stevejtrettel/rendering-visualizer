# V5 Design — Specular Manifold Sampling (single bounce)

**Status**: ✅ SHIPPED 2026-08-02 (all three checkpoints of
`docs/plan-v5-implementation.md`). core/manifold (mat2, vertex with
frame derivatives, both constraints, Newton walk with the validation
taxonomy, clamped generalized G) + derivative fields on all three
shapes; `pt-sms` integrator (strategy partition; biased-M / unbiased /
MNEE configs) with `'pt-sms'` in the worker protocol; scenes
`caustic-ring` (registry) + glass-bulb and mirror-dome (demo/test
local); demos `viz-manifold-walk`, `viz-caustic-fold`, panes in
render-still/viz-convergence/viz-pixel-samples/viz-image-forming.
Validation: FD harness, planar-mirror closed form (G identity to 8
decimals), constraint⇔BSDF agreement, implicit-function FD of the det
ratio, partition bit-identity on caster-free scenes, cross-integrator
convergence on the bulb caustic, M=1 negative control, determinism.
Measured: the checkpoint-2 note below, plus walk stats (refraction:
anglediff 82% vs halfvector 27% converged, the branch-rejection cases
appearing exactly there; pure reflection: halfvector 70% vs anglediff
54% — anglediff pays for its spherical-coordinate poles; median 6–7
iterations) and the checkpoint-3 geometry finding: a CONVEX caster's
m=1 fiber is single-root and FOLDLESS (det ratio smooth ~0.008), an
interior source refracting out of glass diverges (no fold), so genuine
m=1 caustic folds need CONCAVE reflection — the mirror-dome coffee-cup
scene, where the fold's ~400× determinant spike is measured and drawn.
V5b (rough casters, two-bounce chains, mesh casters) remains open per
the planned-follow-ups section. Sources: `docs/sms-theory.md` (Steve's
fibers-of-path-space account, banked verbatim 2026-08-02),
`docs/sms-notes.md` (implementation constants, code references, and the
2020/2015/2012 papers, banked 2026-08-02), the codebase survey of the
same date. Picks up the SDS thread design-v2 recorded as its known
limitation and design-v3 inherited as motivation; the shelved Veach
path-space perturbations are addressed in open question 6.

## What SMS is, stated for the talk

Every algorithm so far treats a specular surface as something you can
only sample THROUGH: BSDF sampling stumbles onto the light, NEE and
BDPT's connections give up at the delta vertex (pt-nee.ts:66 and
bdpt.ts:83 are literal early-outs), MLT and ReSTIR reuse lucky finds
but cannot manufacture them. SMS inverts the stance: given the two
endpoints a (shading point) and b (light point), SOLVE for the specular
vertex between them. Reflection/Snell at the vertex imposes two angular
constraints on two surface coordinates — a square system F(a, y, b) = 0
whose solution set, as the endpoints vary, is a smooth manifold; for
FIXED endpoints the admissible chains form a discrete fiber with zero,
one, or several roots. The theory note's line IS the slide: BDPT fixes
two terminal vertices and tests the single straight edge between them;
SMS fixes two terminal vertices and searches the fiber. A Newton iteration slides a seed point across
the glass until the path snaps into a valid specular connection: a
generalized NEE that connects through the surface every other strategy
must connect around.

Two corrections, kept rigorously separate (the theory note's central
discipline): the PHYSICAL contribution — Fresnel/η² along the solved
chain and a generalized geometry factor |det D_yF|-derived, not guessed
— and the SAMPLING correction 1/p_k for the probability that the
randomized solver discovers root k at all. The unbiased construction
estimates 1/p_k by repeating seed-and-solve trials until the same root
recurs (a geometric variable, E[N] = 1/p_k); truncating is biased and
must be labeled as such.

Slide-ready extras: caustic = critical value of the projection that
forgets the specular vertices — branches merge and the projected
density blows up exactly where the floor glows (the definition and the
phenomenon are the same object; marquee figure below); MNEE as the
one-deterministic-seed degenerate case (p ∈ {0,1}); the biased-vs-
unbiased fork as darkening-vs-fireflies; the taxonomy closer gains a
fourth verb — mutate it (MLT) / share it (ReSTIR) / learn it (guiding)
/ SOLVE for it (SMS). Payoff scene: the SDS caustic that stayed
PT-grade under BDPT (design-v2's recorded limitation) and needed MMLT's
whole Markov apparatus — quiet under a per-vertex Newton solve, because
the walk reaches the diffuse vertex through the glass and SMS supplies
the specular connection to the light from there.

**Checkpoint-2 measurement note (2026-08-02)**: equal-time efficiency
(relVar × cost, 6 probe pixels on each floor caustic, ref = unbiased
SMS 8k spp) vs pt-nee. GLASS-BULB (emitter inside a solid glass sphere;
NEE always occluded — contributes zero): SMS wins big — M8 26×,
unbiased 18×, MNEE-config 392× (deterministic seed, single-root regime,
~4 iterations, near-zero variance at 13ms/1k samples). CAUSTIC-RING
(mirror ball, convex): the M8 default LOSES at equal time (0.2×) —
variance improves 20× but cost is ~125× per sample, because a CONVEX
mirror fiber is single-root (the checkpoint-1 discovery) and 7 of 8
trials buy nothing; unbiased 0.6×; MNEE-config (one seed toward the
caster center) wins 3×. Measured moral, slide-ready: the trial budget
must match the fiber's root count — multi-trial estimators pay for
roots that don't exist, and the M-sweep figure IS this trade-off.
Recorded options, not built: per-caster trial budgets, SMS depth
gating, receiver-side culling.

## The staged scope (proposed)

**V5 = single-bounce SMS (m = 1), sphere and quad casters, both
constraint formulations, biased fixed-M default + unbiased Bernoulli
toggle, MNEE as the degenerate config.** One diffuse receiver vertex,
one specular vertex on a prescribed caster, one light point: a 2×2
Newton problem — no block-tridiagonal solver, no two-stage machinery,
no glints. This is exactly the scope the SMS authors ship as their
standalone `manifold_ss` module. Multi-bounce chains (double
refraction), rough casters (offset normals), and mesh casters
(smooth-normal-only, barycentric derivatives) are recorded stretch
rungs decided AFTER V5's measurements, V4b-style.

## Architectural decisions (proposed)

1. **New pure core module `src/core/manifold/`** (the core/restir
   precedent): `mat2.ts` (2×2 type: solve, det, inverse — the repo has
   no matrix anywhere); `vertex.ts` (`ManifoldVertex`: p, dpdu, dpdv,
   n, ng, dndu, dndv, orthonormalized frame + frame derivatives, η —
   Mitsuba's `make_orthonormal` pattern); `constraints.ts` (BOTH
   half-vector and angle-difference steps, toggleable — the Δφ wrap and
   the branch-rejection check per sms-notes); `newton.ts` (the shared
   beta-halving loop: maxIterations 20, ‖C‖ < 1e-5, det guard 1e-6,
   ray-trace re-projection, root VALIDATION checklist: intended shape,
   intended branch, no TIR, both edges visible); `geometry-term.ts`
   (generalized G from the same Jacobian, clamped — clamp value an
   explicit constant with a comment citing why everyone clamps).
2. **Derivatives in the hit record, pbrt-style (agreed 2026-08-02)**:
   `ShapeIntersection` gains `dpdu, dpdv, dndu, dndv` — this tracer
   exists to illustrate methods, so the textbook-shaped hit record wins
   over hot-path thrift. Sphere: exact (dn = dp/r, one line). Quad:
   dp = the edge vectors, dn ≡ 0. TriangleMesh: barycentric
   parameterization, dp from edges, dn from interpolated vertex
   normals (quotient rule, projected ⊥ n, per sms-notes). Caster
   ELIGIBILITY in V5 stays sphere + quad — mesh casters are a stretch
   rung (edge-crossing walks on faceted geometry are the hard part,
   not the derivatives; Cycles restricts to smooth normals for the
   same reason).
3. **Both constraint formulations built (agreed 2026-08-02); default:
   angle-difference for random seeds, half-vector for MNEE seeds.**
   They share the Jacobian plumbing (~80 extra lines); the 6%→45%
   Newton-success jump IS a talk figure, and the half-vector
   branch-ambiguity failure (converging to a reflection when refraction
   was prescribed) is a beautiful visible bug to demonstrate rather
   than merely avoid.
4. **Both estimators built (agreed 2026-08-02): biased fixed-M default
   (M = 8), unbiased Bernoulli as the toggle** (max-trials safety cap,
   direction-based root identity, ε = 1e-4). House pattern, third
   appearance: the biased variant is
   not a compromise but a FIGURE (darkening) and a negative control —
   the caustic-region mean under small M must measurably undershoot the
   reference, proving the bias tests can see it. MNEE = the config
   {deterministic straight-line seed, half-vector, M = 1} — one flag
   set, zero extra code, and the "MNEE cannot see multiple roots"
   comparison falls out.
5. **Integrator: `src/core/integrators/pt-sms.ts`, `SMSPathTracer`
   beside pt-nee — strategy PARTITION, not MIS** (the paper's own demo
   integrator; robust SMS MIS is explicitly open research). SMS owns
   the path family {diffuse vertex → exactly one specular vertex →
   emitter}: at each non-specular walk vertex, for EACH specular caster
   (loop, pmf 1 — our scenes have 1–2 casters; a caster distribution is
   premature), sample the light point, run the estimator; and the
   corresponding BSDF-sampled emitter hits (walk goes diffuse →
   specular → emitter) contribute ZERO in pt-sms. Plain NEE at diffuse
   vertices is untouched. Unbiasedness holds because the partition is
   exhaustive and disjoint; variance where SMS is weak (large lights,
   near-rough casters) is the honest cost and a recorded figure. BDPT
   integration is explicitly OUT of V5 (assertWeightSum's density table
   assumes directly-connectible junctions; teaching it about specular
   strategies is its own project).
6. **Delta-chain evaluation**: a narrow additive accessor on the two
   smooth specular materials (Dielectric, SmoothConductor) exposing
   Fresnel/η² along a SOLVED direction — the delta eval/pdf contract
   (eval ≡ black) stays untouched; MIS elsewhere depends on it.
7. **Sampler discipline**: SMS draws from a new dedicated stream (the
   V0 `startStream` hook, exactly why it exists) — seed draws and
   Bernoulli trials consume a variable number of dimensions, which the
   fixed-layout rule forbids in the walk streams. Light-point dims
   first, then sequential seed draws. Same-seed ⇒ bit-identical film
   still holds (trial counts are deterministic given the stream).
8. **Recorder**: one new event kind (fifth precedent),
   `manifoldWalk {depth, casterName, seed, iterates: {p, cNorm}[],
   outcome: 'converged'|'diverged'|'invalid-branch'|'occluded'|…,
   solution?, trials?}` + `manifoldWalks` array on `PathRecord`, no-op
   in NullRecorder, flatten in ArrayRecorder. Solver success-rate
   statistics surfaced, mirroring the SMS repo's instrumentation.
9. **Protocol**: `'pt-sms'` joins `IntegratorName` (protocol.ts:5) and
   the worker construction switch. Ordinary per-pixel integrator —
   sample-parallel pool applies unchanged (no driver needed; unlike
   V3/V4 this is plain phase-2 estimation).

## Scenes

- `cornell-glass` / inline `GLASS_BOX`: the refraction target — the
  existing flagship caustic, now solved rather than stumbled upon.
- `door-ajar`: the SDS misery scene — the MMLT-vs-SMS equal-time figure.
- **`caustic-ring` (new, agreed 2026-08-02)**: a MIRROR SPHERE low
  over the floor beside a small light — the classic ring caustic with
  MULTIPLE roots per receiver point, the scene MNEE structurally
  cannot render and reflective SMS owns. Sphere rather than an arc:
  V5 casters are sphere/quad (decision 2), an arc would need a new
  Shape type or a mesh caster, and sphere derivatives are exact.

## Validation plan

- **Finite-difference harness (new, checkpoint 1)**: dp/du, dn/du on
  sphere/quad vs central differences; constraint Jacobian vs FD at
  random configurations; the repo's testing culture demands it and
  nothing like it exists.
- **Planar-mirror analytic case**: quad mirror ⇒ single root = the
  mirror-image construction, in closed form. Newton must find it from
  any seed in ~1–2 iterations; generalized G must equal the classical
  G of the unfolded path (exact identity on a plane).
- **Constraint ⇔ sampler consistency**: at a converged root, the
  direction Dielectric/SmoothConductor's `sample` produces from wi must
  match wo to tolerance (the constraint and the BSDF agree on physics).
- **Cross-integrator convergence (the house theorem)**: pt-sms ≡ pt ≡
  pt-nee ≡ bdpt on cornell (SMS contributes nothing — partition
  correctness on a caustic-free scene), then on the glass-box caustic
  region vs a very-high-spp PT reference (unbiased toggle, and biased
  with M large).
- **Negative control**: biased M = 1 (random seed) must measurably
  darken the multi-root caustic region vs reference — the detector
  works. MNEE-config on `caustic-ring` shows the same signature for
  the structural reason.
- **Determinism**: same seed ⇒ bit-identical film and records,
  including Bernoulli trial counts.
- **Statistical**: chi-square on the seed sampler; root-identity
  clustering sanity (two known roots on the ring scene are never
  conflated at ε = 1e-4).

## Demos / figures

- **`viz-manifold-walk` (marquee)**: one receiver point on the floor,
  one caster, one light. Draw the seed chain dotted, each Newton
  iterate as the candidate point slides across the sphere (color-ramped
  by ‖C‖, red→green), the converged chain solid, constraint arrows at
  the specular vertex; failed walks evaporate. Toggles: MNEE seed vs
  random seeds; half-vector vs angle-difference (the success-rate and
  wrong-branch stories live here). The 2D manifold-visualizer's proven
  presentation, lifted into our scenes.
- **`viz-caustic-fold`**: sweep the receiver point along a floor line;
  plot the solved vertex sliding on the caster, all discovered roots,
  and G as it spikes — branches merge exactly where the rendered floor
  glows. The critical-value definition of a caustic, animated.
- **Estimator figure**: biased-vs-unbiased equal-time on the ring scene
  (darkening vs fireflies), plus the M-sweep.
- **Panes**: pt-sms joins render-still and viz-convergence; equal-time
  vs pt-nee / bdpt / mmlt on glass-box and door-ajar — the SDS payoff
  quantified against MMLT's whole apparatus.

## Checkpoints

1. `core/manifold/` complete (mat2, vertex, both constraints, newton,
   geometric term) + `manifoldGeometry` on sphere/quad + FD harness +
   planar-mirror analytic test. No integrator, no rendering.
2. `pt-sms`: MNEE config first (deterministic seed, glass box), then
   random-seed biased-M reflection on `caustic-ring`, then refraction,
   then the unbiased toggle; partition correctness + cross-integrator
   convergence + negative control; equal-time MSE numbers vs pt-nee
   and mmlt.
3. Recorder events + `viz-manifold-walk` + `viz-caustic-fold` + panes +
   gallery/README/docs statuses.

## Markup record (2026-08-02, both rounds — design AGREED)

Round 1: pbrt-style derivative fields in `ShapeIntersection` (this
tracer illustrates methods — textbook shape wins); BOTH constraint
formulations; BOTH estimators (biased M = 8 default + unbiased
toggle); the `caustic-ring` scene (mirror sphere). Clarified: pt-sms
is ADDITIVE — a sixth `IntegratorName` beside pt/pt-nee/bdpt/mmlt/
restir, panes coexist everywhere; BDPT itself is untouched in V5.

Round 2: name is `'pt-sms'`. Veach path-space perturbations are
SKIPPED permanently ("we didn't implement them and we won't") — the
shelf is closed; SMS covers the caustic-proposal ground. The theory
note is banked verbatim as `docs/sms-theory.md` (§12 of Steve's
bidirectional-estimation outline, which supersedes the earlier
fixed-endpoints note; it adds Speierer 2018 to the literature
anchors). Stretch work is DEFERRED BUT PLANNED — see below. The
M-sweep figure defaults to a toggle in viz-manifold-walk; promote to
its own page at checkpoint 3 only if it reads better (the V4 idiom).

## V5b design — two-bounce chains (✅ SHIPPED 2026-08-03)

**Status**: shipped, all three checkpoints of
`docs/plan-v5b-implementation.md`. `core/manifold/chain.ts`
(block-tridiagonal LU, chain walk with refracted-continuation seeding
and per-edge final validation, transfer-matrix G); chains in `pt-sms`
with the double-delta partition, crossing-parity gates, and the
`chains`/`chainSeedMode`/`chainMaxIterations` options; the FLAGSHIP
green (pt-sms ≡ NEE on bdpt.test's glass-box caustic pixels — four
architectures, one integral); the two-bounce scene in
viz-manifold-walk (both crossings sliding in step, 8/8 random-seed
convergence at the probed receiver). Measurements banked in the
checkpoint-2 note below. Design record as agreed at markup follows.

**Status**: AGREED 2026-08-03. Scope settled by Steve directly:
refraction-only m = 2 ("double refraction is enough for now"). The
remaining three decisions were delegated ("make your best case and
document it") — the cases, recorded:

- **(b) Seed default — argued deterministic, MEASURED random (amended
  2026-08-03 at checkpoint 2).** The original case: through a convex
  ball the double-crossing fiber should be single-root almost
  everywhere, making the deterministic straight-line seed free of
  estimator spend. The measurement disagreed: on the glass-box caustic
  pixels the deterministic-only config sits ~6% DARK (−5.9% and −7.4%
  at the two caustic probes) while random seeds with the biased-M
  ladder sit at reference — the refracted congruence's fold bands
  (spherical aberration, the same structure the V5a fold analysis
  found) put multiple roots over exactly the pixels that matter, and a
  single seed cannot cover them. Default flipped to
  chainSeedMode: 'random' with the SAME estimator ladder and M as the
  m = 1 strategy (one coherent default); 'deterministic' stays as the
  cheap MNEE-style config with its bias now measured and labeled. The
  case-then-measure sequence is itself a talk point: MNEE's known
  darkening, reproduced from first principles in two paragraphs.
- **(c) m = 1 and m = 2 attempted unconditionally per caster.** The
  partition's unbiasedness rests on one invariant: every family the
  emitter-hit suppression zeroes must actually be attempted by SMS.
  Unconditional attempts make that invariant true by construction; any
  gating rule couples two pieces of code (the attempt condition and
  the suppression predicate) that then must never drift apart — the
  classic silent-bias shape. The wasted m = 1 attempt against an
  exterior light dies cheaply in branch validation. Cost is measured
  at checkpoint 2; if gating is ever worth it, it is introduced as a
  SINGLE shared predicate used by both sides, with the negative
  control re-run.
- **(d) V5b, not design-v6.** Design documents mark architectural
  epochs — a new driver, a new protocol shape, a new estimator theory.
  The chain solver is none of these: it generalizes one core module
  and one integrator hook, under V5's estimator ladder, partition
  discipline, and measure conventions unchanged. Its rationale belongs
  next to the decisions it inherits.

Implementation per `docs/plan-v5b-implementation.md`.

**What it buys, stated for the talk**: the FAMILIAR figure — external
light, glass ball, caustic on the floor (light→glass→glass→floor,
m = 2). The V2 flagship test (BDPT matches NEE on the glass-box
caustic) gains a fourth participant: the same truncated integral, four
architectures.

**Door-ajar correction (measured 2026-08-03; the draft over-promised
here)**: single-receiver SMS does NOT rescue door-ajar, for two
structural reasons. (1) SMS solves specular constraints, not
visibility — the solved chain's exit-vertex→light edge must thread the
slit, and almost every root dies in the final occlusion check (probe:
chain contributions ≈ zero at the caustic pixels, at full attempt
cost). (2) The scene's difficulty is the DIFFUSE slit bottleneck —
BDPT/MMLT territory by design. The honest taxonomy slide: glass-box
and bulb caustics are SMS's scenes; door-ajar stays bidirectional —
no proposal dominates, which is §12.7's mixture argument made
concrete. The principled fix is RECORDED, not built: Speierer 2018's
caustic connections (sms-notes links) — manifold chains between
camera-subpath diffuse vertices and LIGHT-subpath vertices, so the
light walk carries visibility through the slit and the manifold solves
the glass. That is the SMS-in-BDPT project design decision 5 scoped
out, now with a motivating scene and a measured gap.

Decisions (proposed):

1. **Scope: m = 2 REFRACTION chains** — two crossings of dielectric
   interfaces. The chain TYPE is an explicit list of (primitive, branch)
   pairs, so a chain may cross one sphere twice (the ball) or two
   distinct quads once each (the slab — the analytic test case).
   Double-MIRROR chains and mixed reflect/refract chains stay out (no
   scene needs them; the machinery would allow them later).
2. **New `src/core/manifold/chain.ts`**, leaving the single-bounce
   module untouched (integrators accumulate; so does the manifold
   core): per-vertex constraint blocks dC_i/dx_{i−1,i,i+1} (the
   half-vector form generalizes vertex-wise; anglediff per-vertex with
   each vertex's prescribed branch), the ~30-line 2×2-block tridiagonal
   LU (Cycles mnee_solve_matrix_h_to_x, banked in sms-notes), a
   chainWalk with Cycles' per-vertex re-projection (ray from vertex
   i−1 toward proposed x_i, same-primitive check, beta halving on any
   failure, per-step transmissive-configuration check) and the same
   validation checklist per vertex plus per-edge visibility. The
   generalized G comes from the same factorization as the
   transfer-matrix determinant (MNEE eq. 8), clamped as before.
3. **Seeding: deterministic straight-line default** (trace receiver →
   light point, collect the crossings of the prescribed casters in
   order — MNEE seeding generalized, near-always convergent through a
   convex ball), with a random variant (straight line through ONE
   sampled caster point, collecting subsequent crossings) as the
   toggle. The estimator ladder (biased-M / unbiased / MNEE) transfers
   unchanged — the fiber is still discrete and p_k still needs its
   correction; expectation (recorded, to be measured): the glass-ball
   fiber is single-root almost everywhere, so the deterministic seed
   is the practical default and the M-sweep lesson carries over.
4. **Throughput**: product of per-crossing `specularChainThroughput`
   factors with the directed eta of each crossing. Sanity item worth a
   named test: the radiance η² compression cancels across an
   enter-then-exit pair (×1/η² then ×η² — net 1).
5. **Partition extension in pt-sms**: SMS also owns
   {diffuse → delta → delta → emitter} when BOTH deltas are
   transmissions on eligible casters matching an attempted chain type;
   those emitter hits are zeroed. Chain types attempted per vertex:
   for each dielectric caster, the double-crossing [caster, caster]
   chain, ALONGSIDE the existing m = 1 attempt (empty for exterior
   lights — the branch validation rejects it cheaply). Cost is
   measured, not guessed; gating is a recorded option.
6. **Recorder**: ManifoldWalkEvent.iterates entries gain the full
   chain per iterate (`chain: Vec3[]` replacing the single p), so the
   walk demo can slide BOTH candidate points in step; flatten
   mechanical as before.
7. **Scenes**: none new — `cornell-glass` / inline GLASS_BOX is the
   whole point, and `door-ajar` is the SDS measurement. The walk demo
   gains a 'glass ball (two-bounce)' scene mode.

Open questions for markup: (a) scope refraction-only — agree?
(b) deterministic-seed default — agree? (c) attempt m = 1 and m = 2
unconditionally per caster, measure the cost — agree? (d) numbering:
this stays V5b inside design-v5 rather than a design-v6 — agree?

**V5b checkpoint-2 measurement note (2026-08-03)**: the suppressed
double-refraction family is 12.4% of the glass-box caustic-zone energy
(measured by the M = 0 suppress-only config against chains-off, which
sits at −0.34% ≡ NEE — partition sanity). Getting the resupply to match
took three measured solver fixes: (1) DROP the per-step transmissive
guard (Cycles has one, Mitsuba doesn't — it froze walks whose Newton
path legitimately passes side-flipped states: 2/719 → 29/720 integrator
convergence); (2) REFRACTED-CONTINUATION seeding — bend by Snell at
each crossing instead of marching straight, so the seed satisfies the
constraint exactly at every vertex but the last (zone success 4.4% →
14.7%, biased-M8 zone deficit −4.0% → −1.5%); (3) shape-only
re-projection with explicit final per-edge visibility (which also
exposed 11 formerly-"converged" occluded far-side impostors). The
UNBIASED Bernoulli config lands at −1.1% (≈ the maxTrials-truncation
floor) and is SEVEN TIMES cheaper than biased-M8 (a failed first walk
ends the estimate) — it carries the flagship test, which passes: pt-sms
matches the NEE reference on bdpt.test's own glass-box caustic pixels.
CROSSING-PARITY gates (closed casters: odd chains need opposite-side
endpoints, even chains same-side — exact geometry) cut cost a further
2.6×. Equal-time verdict, honest: broad-light glass box LOSES badly
(BSDF luck is cheap under a 1.6² emitter — the caustic-ring lesson
again); small-hard-light glass box gets a 32× per-sample VARIANCE win
on the caustic but ~150× per-sample cost → 0.2–0.3× at equal time on
this TS renderer. The talk figures are equal-samples (the caustic
transformation is dramatic); the equal-time table stays on the slide —
the V4 discipline. Recorded cost options, not built: allocation-free
walk internals, guided seeding, per-caster trial budgets.

## Planned follow-ups (V5b — deferred, decided from V5's measurements)

Recorded now so the V5 code leaves the right seams; none of it is in
V5 scope, and the go/no-go on each is argued from V5's measured
success rates and equal-time numbers (the V4b discipline):

- **Rough casters** via one sampled offset normal per estimate — the
  `n_offset` hook exists at every level of the constraint code by
  construction; no two-stage solver (that is for normal maps).
- **Two-bounce chains** (double refraction through the glass ball) via
  the ~30-line 2×2-block tridiagonal LU (Cycles' pattern). The
  `ManifoldVertex` layout keeps the per-vertex dC/dx_prev/cur/next
  block structure in mind so this is an extension, not a rewrite.
- **Mesh casters** (smooth vertex normals only, barycentric
  derivatives — the derivatives already land in V5's hit record; the
  open problem is walks crossing triangle edges on faceted geometry).

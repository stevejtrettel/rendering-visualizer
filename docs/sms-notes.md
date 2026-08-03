# SMS implementation notes (banked 2026-08-02)

Sources studied at code level: the official SMS release (Mitsuba 2 fork,
github.com/tizian/specular-manifold-sampling — `manifold.h`,
`manifold_ss.cpp`, `path_sms_ss.cpp`), Blender Cycles' production MNEE
(`intern/cycles/kernel/integrator/mnee.h`, shipped since 3.2), and
Zeltner's 2D educational `manifold-visualizer`
(github.com/tizian/manifold-visualizer). Papers: Zeltner et al. 2020
(SMS, rev.3 PDF with the Δφ-wrap erratum), Hanika et al. 2015 (MNEE),
Jakob & Marschner 2012 (Manifold Exploration). Steve's theory note
(fixed endpoints, the fiber/projection picture) is the mathematical
frame the V5 design doc speaks in.

## The problem shape

A specular chain (a, x₁…x_m, b): endpoints a (shading point) and b
(light point) fixed, m specular vertices unknown — 2m surface
coordinates, 2m angular constraints (reflection/Snell at each vertex).
Regular fibers are discrete: zero, one, or several roots. The solver is
Newton with ray-trace re-projection; the estimator must account both
for physical transport (Fresnel, generalized G) and for the solver's
root-discovery probability p_k. Single bounce (m=1) is a 2×2 problem
and is what the SMS authors ship as their standalone `manifold_ss`
module — the whole single-bounce ladder needs no block solver.

## Constraint formulations (both exist in the SMS code, toggleable)

**Half-vector projection** (Jakob 2012, MNEE, Cycles): at vertex p with
shading frame (s, t, n), wi = normalize(a−p), wo = normalize(b−p),
generalized half-vector h = normalize(wi + η·wo) (sign-fixed toward n);
constraint C = (⟨s,h⟩, ⟨t,h⟩) ∈ R². Zero ⇔ mirror reflection or Snell.
Jacobian is closed-form; frame derivatives (ds/du…) enter here, which
is where dn/du, dn/dv are consumed. KNOWN FLAW: cannot distinguish
front/back-facing configurations — Newton happily converges to a
reflection-like root when refraction was prescribed; implementations
post-reject via sign(⟨n_g,wi⟩·⟨n_g,wo⟩) vs η (manifold_ss.cpp:390–404).

**Angle difference** (SMS 2020 §4.4, the release default): compute the
prescribed scattered direction wio = S(wi, n, η) (reflect or refract
explicitly), express wo and wio in spherical coordinates, C = (θo−θio,
φo−φio) with **Δφ wrapped into [−π, π]** — the wrap is load-bearing
(2021 erratum). If refracting wi hits TIR, retry transforming wo
instead. Removes the branch ambiguity; the robustness win for random
seeds is large: Newton success 6%→45% (reflective plane), 3%→12%
(normal-mapped refractive sphere) — paper Fig. 8. For MNEE-style
near-solution seeds, half-vector is fine.

## The Newton loop (identical skeleton in all three implementations)

```
beta = 1  (Cycles starts 0.1 and ramps)
repeat up to maxIterations:
  (C, dX) = computeStep(...)         # fail if |det| < detGuard
  if ‖C‖ < threshold: SUCCESS
  pProp = p − beta·(dpdu·dX.x + dpdv·dX.y)      # tangent-plane step
  re-project by ray trace (SS: ray from a through pProp); must hit the
  SAME shape with the intended orientation, else beta /= 2 and retry
  on accept: beta = min(1, 2·beta)
```

Constants from real code:

| param | SMS/Mitsuba | Cycles MNEE | MNEE paper |
|---|---|---|---|
| maxIterations | 20 | 64 | 15 ("→50 adds <10% convergence") |
| ‖C‖ threshold | 1e-5 | 1e-3 | — |
| det guard | 1e-6 | 1e-4 | — |
| uniqueness ε | 1e-4 on \|⟨d₁,d₂⟩−1\| | n/a | position ε |
| typical iters near root | few | — | 2–4 |

A returned root must be VALIDATED, not trusted: on the intended shape,
intended reflect/refract branch, no TIR, both edges visible. Failure to
converge is a legitimate outcome, not proof the fiber is empty.

## Generalized geometric term

Same Jacobian machinery: single bounce G = |dω₀/dx₁| ·
|det((∂C/∂x₁)⁻¹ · ∂C/∂x₂)| with |dω₀/dx₁| = |⟨d,n_g⟩|/r²
(manifold_ss.cpp:695–857). EVERY implementation clamps it (Mitsuba:
ratio ≤ 1; Cycles: G ≤ 2) — numerically unstable near folds, which is
exactly the caustic (the fold IS the blowup; see the V5 figure).
Specular reflectance along the solved chain: Fresnel (× η² for
radiance through refraction) — a direct evaluation, not the delta
`eval` (which correctly returns black).

## Probability estimation (the biased/unbiased fork)

p_k = seed-space measure of root k's convergence basin — unavailable in
closed form. Two estimators (manifold_ss.cpp:28–201):

- **Unbiased (Bernoulli/geometric, Booth 2007)**: after finding root k,
  repeat independent seed-and-solve trials until the SAME root recurs
  (direction dot within 1e-4); the trial count N has E[N] = 1/p_k.
  Variance (1−p_k)/p_k² — fireflies for rare roots. A max-trials cap
  (estimate→0) kills pathological loops at the cost of tiny bias.
- **Biased fixed-M**: M independent walks (paper M=16), deduplicate,
  sum each unique root's contribution ONCE (occurrence counts cancel
  against the empirical n_l/M). Consistent as M→∞; bias reads as
  darkening where roots are rarely found. Fixed cost; the practical
  default.

MNEE is the degenerate case: one deterministic seed (straight line
toward the light) ⇒ p ∈ {0,1}, no estimation — the SMS repo literally
implements MNEE as a config flag set (`mnee_init=true, M=1,
halfvector_constraints=true`).

## Geometry-derivative requirements

Per specular vertex: p, dp/du, dp/dv, n, n_g, dn/du, dn/dv. Tangent-
frame derivatives are DERIVED from dn (Cycles computes them inline), so
the only new primitive-level data is dn/du, dn/dv (plus dp if absent).

- **Sphere**: exact, one line — dn/du = dp/du / r (Mitsuba
  sphere.cpp:376). The ideal first target.
- **Quad**: dp/du = e1, dp/dv = e2, dn ≡ 0. The planar mirror is the
  classic single-root analytic sanity case.
- **Triangle mesh (smooth vertex normals, barycentric param)**:
  dp/du = p₁−p₀, dp/dv = p₂−p₀; dn/du = (n₁−n₀)/|N_raw| projected
  ⊥ n (quotient rule); then orthonormalize dp and apply the SAME
  transform to dn (Mitsuba `make_orthonormal`, Cycles mnee.h:198–218).
- **Flat-shaded meshes**: dn = 0 per face, frame discontinuous across
  edges — Cycles REJECTS casters without smooth normals; adopt the
  same restriction.
- The parameterization need not be globally consistent — everything is
  local per iteration; that is what the re-projection step is for.

## Integrator plumbing (how the released code plugs in)

SMS is a generalized NEE: at each diffuse receiver vertex, for each
specular caster shape — sample emitter point, sample seed on the caster
(uniform area, verified reachable by ray cast from the receiver),
Newton solve, validate, contribution = f(a)·Fresnel·G·Le·⟨1/p⟩. The
demo integrator FILTERS the same path family out of plain NEE and
BSDF-sampled emitter hits — a strategy partition, not MIS. The paper
explicitly leaves robust MIS with SMS as future work (the caveat:
rough casters / large lights, where plain sampling wins).

Cycles' alternative trigger: MNEE fires when the NEE shadow ray crosses
flagged caster geometry.

## Recommended single-bounce ladder (each rung independently demo-able)

1. Infrastructure: derivatives + ManifoldVertex + reflect/refract with
   derivatives + 2×2 solve; finite-difference-test everything.
2. MNEE (deterministic seed, half-vector, biased): refractive caustic,
   ~300 lines, 2–4 iterations typical. Before/after already dramatic.
3. SMS reflection, biased fixed-M, angle-difference constraint: the
   ring/cardioid caustic — multiple roots per receiver, which MNEE
   fundamentally cannot render (the strongest pedagogical contrast).
4. SMS refraction: same code path, η ≠ 1 branch + validity rejection.
5. Unbiased Bernoulli estimator: ~25 lines around the seed loop;
   biased-vs-unbiased darkening-vs-fireflies figure (paper Fig. 6).
6. Stretch, in value order: rough casters via one sampled offset
   normal per estimate (the `n_offset` hook exists at every level;
   skip the two-stage solver — it is for normal maps); two-bounce
   chains via Cycles' ~30-line 2×2-block tridiagonal LU.

## The 2D manifold-visualizer (talk-figure goldmine)

`python/modes/specular_manifold_sampling.py`: ~60-line Newton solver in
2D (1 DOF per vertex — scalar Jacobian), MNEE-vs-SMS and half-vector-
vs-angle-difference toggles. Draws seed paths dotted, Newton iterates
color-ramped red→green, solutions solid, constraint vectors at each
vertex — a proven presentation to copy into the three.js viz.

## Alternatives considered (for the design doc's record)

- **Path Cuts** (2020): deterministic interval-arithmetic pruning +
  Newton — complete, but wrong complexity class for this repo.
- **Manifold Path Guiding** (2023, mollnn/manifold-path-guiding):
  learns the seed distribution from historical solutions; up to 40×
  over SMS on long chains. Orthogonal layer on top of SMS — one slide
  as "how you'd make this production-fast".
- **Specular Polynomials** (2024, mollnn/spoly): no Newton at all —
  resultants reduce the constraints to univariate root-finding;
  complete root sets, no p_k estimation. Heavy machinery; note as the
  no-Newton endpoint of the design space.
- **SMS + spatiotemporal reuse** (PG 2023): ReSTIR-style reuse of
  manifold solutions — the amusing V4 adjacency.
- **Bernstein Bounds for Caustics** (2025): conservative enumeration,
  same "guaranteed coverage" theme as path cuts.

## Links

- SMS: https://tizianzeltner.com/projects/Zeltner2020Specular/ ·
  https://github.com/tizian/specular-manifold-sampling
- 2D visualizer: https://github.com/tizian/manifold-visualizer
- MNEE: https://jo.dreggn.org/home/2015_mnee.pdf (talk slides
  2015_mnee_talk.pdf beside it)
- Cycles MNEE: blender/blender → intern/cycles/kernel/integrator/mnee.h
- Manifold Exploration: https://www.cs.cornell.edu/projects/manifolds-sg12/
- Caustic Connection Strategies for BDPT (Speierer et al. 2018):
  https://graphics.pixar.com/library/CausticConnections/ — the "SMS
  inside bidirectional connections" reference if BDPT integration is
  ever revisited
- Specular Polynomials: https://arxiv.org/abs/2405.13409 ·
  https://github.com/mollnn/spoly
- Manifold Path Guiding: https://dl.acm.org/doi/10.1145/3618360 ·
  https://github.com/mollnn/manifold-path-guiding
- Path Cuts: https://dl.acm.org/doi/abs/10.1145/3414685.3417792

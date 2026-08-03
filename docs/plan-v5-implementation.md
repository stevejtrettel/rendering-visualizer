# V5 Implementation Plan — Specular Manifold Sampling (staged, reviewed per checkpoint)

*Written 2026-08-02. Decisions and rationale: `design-v5.md` (agreed
2026-08-02). Mathematics: `sms-theory.md`. Mechanics with code-level
citations and constants: `sms-notes.md` (Zeltner 2020 release code,
Cycles MNEE, Hanika 2015). STOP and report to Steve after each
checkpoint; file lists are the exact scope — propose anything further
before writing it.*

## Working rules (non-negotiable, see CLAUDE.md + memory)

- Steve reviews at each checkpoint — STOP and report after each.
- Integrators accumulate, never replace: pt / pt-nee / bdpt / mmlt /
  restir untouched (pt-nee is the template, not modified in place;
  BDPT explicitly gains nothing in V5).
- Tests land WITH their components. `npm run typecheck` + `npm test`
  green before any checkpoint report.
- Demos verified in a real browser before the checkpoint 3 report
  (Playwright via
  `/Users/strettel/Code/PathTracerGLSL/node_modules/playwright/index.mjs`;
  parse the dev-server port; ride out vite re-optimize reloads before
  driving selects; kill leaked servers).
- Correct, principled and slow first — no optimization before the
  validations pass. Numerical constants from sms-notes (maxIterations
  20, ‖C‖ < 1e-5, det guard 1e-6, uniqueness ε 1e-4, M = 8, clamped G)
  are named constants with one comment each citing the source.

## Existing seams this build stands on (do not re-derive)

- `pt-nee.ts:66` — the `hasNonSpecular` NEE guard whose complement IS
  the SMS opportunity; pt-sms copies pt-nee's phase-2 shape.
- `Sampler.startStream` (V0 hook, third activation): SMS draws from a
  dedicated stream — seed draws and Bernoulli trials consume a
  variable dimension count, which the walk streams' fixed layout
  forbids.
- `occlusionPoint` (`geometry/visibility.ts`) reports WHERE a
  connection is blocked — the recorder wants it for failed walks.
- `offset.ts` epsilon policy for the re-projection rays.
- Recorder/ArrayRecorder/NullRecorder: fifth event-kind addition, same
  mechanical pattern as shadow rays / connections / mutations / reuses.
- Scenes: `cornell-glass`, `door-ajar`, inline `GLASS_BOX`
  (tests/glass-scene.test.ts) are the refraction targets; the equal-time
  MSE probe methodology from the MLT investigation for the numbers.

## Checkpoint 1 — manifold core + derivatives (no integrator, no rendering)

Files: `src/core/manifold/mat2.ts` (new),
`src/core/manifold/vertex.ts` (new),
`src/core/manifold/constraints.ts` (new),
`src/core/manifold/newton.ts` (new),
`src/core/manifold/geometry-term.ts` (new),
`src/core/geometry/shape.ts` + `sphere.ts` + `quad.ts` +
`triangle-mesh.ts` (derivative fields),
`tests/manifold-derivatives.test.ts` (new),
`tests/manifold-newton.test.ts` (new).

1. `mat2.ts`: 2×2 matrix — det, inverse, solve, with the det guard
   returning null rather than exploding. (The repo's first matrix;
   lives in core/manifold per design decision 1.)
2. Derivative fields on `ShapeIntersection`: `dpdu, dpdv, dndu, dndv`
   (agreed pbrt-style). Sphere: exact (dn = dp/r). Quad: dp = edge
   vectors, dn = 0. TriangleMesh: dp from edges, dn from interpolated
   vertex normals (quotient rule, projected ⊥ n, per sms-notes) —
   fields filled for completeness; mesh casters stay out of V5 scope.
3. `vertex.ts`: `ManifoldVertex` — p, dpdu, dpdv, n, ng, dndu, dndv,
   η, orthonormalized frame + frame derivatives (`makeOrthonormal`:
   orthonormalize dp and apply the same transform to dn; frame
   derivatives derived from dn per Cycles' inline pattern). Built from
   an `Intersection` + material η.
4. `constraints.ts`: BOTH formulations behind one interface returning
   {C: [number, number], J: Mat2}: half-vector projection (generalized
   h = normalize(wi + η·wo), C = (⟨s,h⟩, ⟨t,h⟩)) and angle-difference
   (explicit reflect/refract of wi, spherical-coordinate difference,
   **Δφ wrapped into [−π, π]**, TIR-retry on the wo side), plus the
   `reflect/refract/dReflect/dRefract/sphcoords/dSphcoords` helpers.
5. `newton.ts`: the shared solver — beta-halving loop with ray-trace
   re-projection (ray from the receiver a through the proposed point;
   must hit the same primitive), and the root VALIDATION checklist as
   an explicit function: intended primitive, intended branch
   (sign(⟨ng,wi⟩·⟨ng,wo⟩) vs η — the half-vector wrong-branch
   rejection), no TIR, both edges visible. Returns a discriminated
   outcome ('converged' | 'diverged' | 'invalid-branch' | 'occluded' |
   'left-surface' | 'singular') — the recorder and the demos consume
   the failure taxonomy as data.
6. `geometry-term.ts`: generalized G from the constraint Jacobian
   blocks (|dω/dx| · |det((∂C/∂x₁)⁻¹·∂C/∂x₂)|), clamped (named
   constant, comment citing that every implementation clamps).
7. Tests:
   - finite-difference: dp/du, dn/du on sphere/quad/mesh vs central
     differences at random points; constraint Jacobians (both
     formulations) vs FD at random valid configurations;
   - planar-mirror analytic: quad mirror ⇒ unique root = the
     mirror-image construction in closed form; Newton finds it from
     any seed in ≤ a few iterations; generalized G equals the
     classical G of the unfolded path (exact identity on a plane);
   - constraint ⇔ sampler consistency: at a converged root, the
     direction `Dielectric`/`SmoothConductor.sample` produces from wi
     matches wo (both formulations agree with the BSDF's physics,
     reflection and refraction branches);
   - sphere two-root sanity: receiver + light + mirror sphere
     configured so two known roots exist; random seeds discover both;
     the uniqueness test (direction dot, ε = 1e-4) never conflates
     them;
   - determinism: same seed stream ⇒ identical iterate sequences.

## Checkpoint 2 — pt-sms integrator, estimator ladder, numbers

Files: `src/core/integrators/pt-sms.ts` (new),
`src/core/materials/dielectric.ts` + `conductor.ts` (specular-chain
throughput accessor), `src/core/sampler/sampler.ts` (SMS stream id),
`src/trace/recorder.ts` + `records.ts` (manifoldWalk events),
`demos/_shared/scenes.ts` (add `caustic-ring`),
`tests/sms.test.ts` (new).

1. Materials: the narrow additive accessor on the two smooth specular
   materials exposing Fresnel/η² along a SOLVED direction pair — the
   delta eval/pdf contract (eval ≡ black) untouched.
2. `pt-sms.ts`: `SMSPathTracer` — pt-nee's walk and per-vertex loop
   verbatim, plus at each non-specular vertex, for EACH specular
   caster (loop, pmf 1): sample light point (existing
   lightDistribution + sampleLi), seed on the caster (uniform area,
   verified reachable by ray cast from the receiver), estimator per
   design decisions 4–5, contribution
   f(a)·Fresnel·G·Le·⟨1/p⟩. Strategy partition: BSDF-sampled emitter
   hits of the family {diffuse → exactly one specular vertex →
   emitter} contribute ZERO here. Options: {constraint:
   'anglediff' | 'halfvector', estimator: 'biasedM' | 'unbiased',
   M = 8, maxTrials cap, mneeInit: boolean (deterministic
   straight-line seed — the MNEE config), maxIterations, thresholds,
   seed}.
3. Ladder INSIDE the checkpoint, validated in order:
   a. MNEE config (mneeInit, halfvector, M = 1) on GLASS_BOX — the
      refractive caustic appears; walk success rate and iteration
      counts reported;
   b. random-seed biased-M reflection on `caustic-ring` — the
      multi-root ring MNEE cannot render (A/B against the MNEE
      config);
   c. refraction with random seeds (η ≠ 1 branch + validity
      rejection) on GLASS_BOX;
   d. unbiased Bernoulli toggle — equal-time biased-vs-unbiased
      comparison (darkening vs fireflies).
4. `caustic-ring` scene: mirror sphere (SmoothConductor) low over the
   floor beside a small area light, camera framing the ring; register
   in scenes.ts (scene-sheet picks it up for free).
5. Recorder: `manifoldWalk {depth, casterName, seed, iterates:
   {p, cNorm}[], outcome, solution?, trials?}` + `manifoldWalks` on
   `PathRecord`; no-op in NullRecorder, flatten in ArrayRecorder;
   solver success/fail statistics surfaced.
6. Tests (tests/sms.test.ts):
   - partition correctness: pt-sms ≡ pt ≡ pt-nee on `cornell` (no
     specular casters ⇒ SMS contributes nothing, the partition
     changes nothing);
   - cross-integrator convergence (house theorem): pt-sms vs
     high-spp PT reference on the GLASS_BOX caustic region (unbiased
     toggle, and biased with M large);
   - negative control: biased M = 1 random-seed must measurably
     darken the caustic-ring multi-root region vs reference;
   - determinism: same seed ⇒ bit-identical film and records,
     including Bernoulli trial counts;
   - chi-square on the seed sampler (uniform area on the sphere).
7. Equal-time MSE numbers (probe methodology) on GLASS_BOX and
   `door-ajar`: pt-sms vs pt-nee vs mmlt — the design's SDS payoff
   claim gets numbers before any demo shows it.

## Checkpoint 3 — protocol, demos, docs

1. Protocol: `'pt-sms'` joins `IntegratorName` (protocol.ts) + the
   worker construction switch. Ordinary per-pixel integrator — the
   sample-parallel pool applies unchanged.
2. `demos/viz-manifold-walk` (marquee): one receiver point, one
   caster, one light; seed chain dotted, iterates color-ramped by ‖C‖
   red→green, converged chain solid, constraint arrows at the vertex,
   failed walks evaporate. Toggles: MNEE seed vs random; halfvector
   vs anglediff; M-sweep (promote to its own page only if it reads
   better here — decide at this checkpoint).
3. `demos/viz-caustic-fold`: sweep the receiver along a floor line;
   solved vertex traces on the caster, all discovered roots, G
   spiking as branches merge — beside the rendered floor so the fold
   and the glow line up.
4. render-still + viz-convergence gain `pt-sms` panes (shared depth
   cap); gallery + README + design-viz statuses; CLAUDE.md NEXT UP.
5. Report: measured walk success rates per constraint formulation,
   iteration histograms, and the GLASS_BOX/door-ajar MSE table.

## Definition of done

All three checkpoints reviewed; suite green including the FD harness,
planar-mirror identity, partition test, cross-integrator convergence,
and the negative control; both demos verified in-browser; equal-time
numbers reported; docs updated. THEN the V5b decisions (rough casters,
two-bounce chains, mesh casters — design-v5 §Planned follow-ups) are
argued from the measured success rates and MSE tables.

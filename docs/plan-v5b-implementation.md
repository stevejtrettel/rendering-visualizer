# V5b Implementation Plan — two-bounce specular chains (DRAFT, for agreement)

*Drafted 2026-08-03. Design: `design-v5.md` §V5b (PROPOSED — this plan
executes only after that section survives markup). Mechanics:
`sms-notes.md` (Cycles mnee.h block-tridiagonal LU and transfer matrix,
lines 369–401 / 664–789; MNEE paper eq. 8). STOP and report after each
checkpoint; file lists are the exact scope.*

## Working rules

Same as plan-v5: checkpoint stops, integrators accumulate (pt-sms is
EXTENDED in place — the m = 1 path must stay bit-identical when no
m = 2 chain types exist), tests land with components, typecheck + suite
green before any report, demos browser-verified before checkpoint 3.

## Existing seams this build stands on

- `ManifoldVertex` already carries everything a chain vertex needs;
  `Mat2` does the blocks. `manifoldWalk` (single-bounce) is untouched.
- `specularChainThroughput` composes per crossing with directed eta.
- The recorder's manifoldWalk event and the walk demo's WalkElement are
  the extension points for chain iterates.
- Validation oracles: a parallel-faced glass SLAB has the closed-form
  laterally-displaced straight-through chain (analytic root AND
  analytic G — the m = 2 planar-mirror analogue); the implicit-function
  FD harness from CP1 generalizes to chains directly.
- GLASS_BOX (tests) / cornell-glass (registry) and door-ajar are the
  target scenes; the V2 flagship caustic pixels are the reference
  region, with BDPT and NEE references already in bdpt.test.ts.

## Checkpoint 1 — chain solver core (no integrator, no rendering)

Files: `src/core/manifold/chain.ts` (new),
`tests/manifold-chain.test.ts` (new).

1. `chain.ts`: `ChainLink { primitive, eta }` (the discrete path type,
   in order from receiver to light); `chainConstraints(...)` building
   per-vertex C_i and blocks dC_i/dx_{i−1,i,i+1} (half-vector form
   vertex-wise; anglediff variant with per-vertex branch);
   `solveBlockTridiagonal(...)` (2×2-block LU, Cycles pattern);
   `chainWalk(receiverP, seedHits[], links, lightP, aggregate,
   options)` — per-vertex re-projection from the previous vertex,
   shared beta, per-step transmissive check, full validation (intended
   primitives, branches, TIR, per-edge visibility including the
   interior x₁→x₂ segment), iterates carrying the whole chain;
   `chainGeometricTerm(...)` via the transfer-matrix determinant out of
   the same factorization, clamped with the existing constant;
   `chainSeed(receiverP, target, links, aggregate)` — the straight-line
   crossing collector (deterministic MNEE seed and the random variant's
   propagator).
2. Tests:
   - block-LU vs a dense 4×4 solve on random block systems;
   - chain Jacobian vs FD: two vertices on the glass sphere, all four
     2×2 blocks against central differences (the CP1 exactness map
     extends: FD at converged chains for half-vector);
   - SLAB closed form: two parallel dielectric quads — the chain is the
     laterally displaced straight line (Snell in, parallel out); walk
     finds it from offset seeds; chainGeometricTerm matches the
     analytic displaced-connection Jacobian;
   - glass-sphere chain: deterministic seed converges from the
     straight-line start (success rate + iteration count recorded);
   - implicit-function FD: perturb the light, re-solve, det of x₁'s
     motion matches the transfer-matrix ratio;
   - η² cancellation: enter+exit radiance compression nets to 1;
   - determinism.

## Checkpoint 2 — pt-sms chain extension, the flagship convergence

Files: `src/core/integrators/pt-sms.ts` (extend),
`src/trace/recorder.ts` + `records.ts` (chain iterates),
`tests/sms.test.ts` (extend).

1. `smsConnect` gains chain enumeration: per dielectric caster, the
   [caster, caster] double-crossing type beside the m = 1 attempt;
   options gain `chains: boolean` (default true) so V5a behavior is
   recoverable exactly. Estimators reuse the existing ladder verbatim
   (root identity by direction, trials over chain seeds).
2. Partition: `smsOwnsEmitterHit` extends to the double-delta family
   (both transmissions, both on eligible casters, matching an attempted
   chain type). The m = 1 suppression is unchanged.
3. Tests:
   - m = 1 regression: with `chains: false`, bit-identical to V5a on
     every existing test;
   - partition: pt-sms ≡ pt-nee in the limit on cornell-glass
     (statistical, existing meanRadiance idiom);
   - **FLAGSHIP: pt-sms matches the BDPT/NEE references on the
     GLASS_BOX caustic region** (the V2 test's pixels — four
     architectures, one integral);
   - door-ajar caustic region vs high-spp reference;
   - determinism.
4. Equal-time MSE numbers (the probe methodology) on cornell-glass and
   door-ajar caustic regions: pt-sms vs pt-nee vs bdpt vs mmlt — the
   SDS story measured across the whole arc. Numbers banked in
   design-v5 as a checkpoint note, incl. the cost of unconditional
   chain attempts (the gating decision's data).

## Checkpoint 3 — demo + docs

Files: `demos/viz-manifold-walk/main.ts` + `index.html` (scene mode),
`README.md`, `index.html` (gallery blurb), `docs/design-v5.md` +
`docs/design-viz.md` + `CLAUDE.md` statuses.

1. viz-manifold-walk gains 'glass ball (two-bounce)' — cornell-glass,
   receiver on the caustic, both candidate points sliding in step per
   iterate, the chain snapping through the ball. Browser-verified.
2. No new panes needed (pt-sms already sits everywhere); render-still
   and viz-convergence on cornell-glass now exercise chains by default
   — re-measure the pane cost caption.
3. Docs statuses; report walk stats (deterministic-seed success rate,
   iterations) and the MSE table.

## Definition of done

Suite green including the slab closed form, the m = 1 regression, and
the four-architecture flagship; demo verified; equal-time numbers
banked; docs updated. THEN the remaining follow-ups (rough casters,
mesh casters) stay open, argued from the new measurements.

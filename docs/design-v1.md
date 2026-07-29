# V1 Design — NEE/MIS, Real Materials, Parallel Infrastructure

*Agreed 2026-07-28. Builds on `docs/design-v0.md` (architecture) and
`docs/pbrt-notes.md` (implementation references). V1 is three staged
increments, each with its own review checkpoint.*

**Status**: V1a ✅ shipped 2026-07-28 (`NEEPathTracer`, shadow-ray
recording, cross-integrator convergence test, `demos/v1-nee`). Display
work (see `design-viz.md`) was inserted between V1a and V1b by agreement.
V1b ✅ shipped 2026-07-28: exact-Fresnel `Dielectric` (delta lobes, η²
Radiance-mode correction, directed eta for RR), `SmoothConductor`,
`GGXConductor` (VNDF sampling, height-correlated Smith, α = roughness²,
Schlick F0 — both by decision), scene registry (`demos/_shared/scenes.ts`,
`cornell` + `cornell-glass`) with scene dropdowns in all viz demos, and an
`epoch` field on the worker protocol for clean scene switching. The
integrator/walk needed ZERO changes — the V0 delta/etaScale reservations
held. V1c (worker pool + Node CLI) pending; next planned conversation:
meshes + BVH (acceleration), per the caustics discussion.

## Standing principle, codified

**Integrators are never replaced — they accumulate.** Every algorithm the
talk discusses remains runnable forever, because equal-sample comparisons
between integrators are simultaneously our correctness test (they must
converge to the same image) and the talk's figures. `UnidirectionalPT`
stays untouched while `NEEPathTracer` lands beside it, and so on through
BDPT and MLT.

## V1a — Next-event estimation + MIS

A new integrator, `NEEPathTracer`, sharing the same `randomWalk` engine.

- **Strategy weighting**: power heuristic (β = 2). At each non-specular
  surface vertex, sample the light (selection pmf × `sampleLi`) and trace a
  shadow ray; weight the NEE contribution by
  `pLight² / (pLight² + pBsdf²)` and emission found by BSDF sampling by the
  symmetric weight — both pdfs expressed in **solid angle at the scattering
  vertex** (pLight = pmf · pdfLi). Emission directly from the camera or
  following a delta bounce is unweighted. Delta lights (future) are guarded
  by `isDelta`, never by zero-pdf arithmetic alone.
- **Dimension layout** (fixed, per bounce): BSDF lobe (1D), BSDF direction
  (2D), then NEE light-select (1D), NEE light-point (2D). The walk draws
  the NEE dimensions and stores them on the vertex
  (`PathVertex.neeSamples`); the phase-2 estimator casts shadow rays
  without consuming randomness, so replay and future PSSMLT mutations stay
  aligned. `UnidirectionalPT` keeps its old layout (NEE draws off) —
  layouts are per-integrator; replay always goes through the same
  integrator.
- **Recorder grows shadow-ray events**: `{depth, from, to, occluded,
  blockedAt}` — including the occluded ones, with the blocker's hit point,
  so the visualizer can draw failed connections dying at the occluder.
- **Sphere lights stay out** until the sphere's `sample(ref)/pdf` upgrade
  to cone sampling; quad lights (area-sample + conversion) are already
  self-consistent, and all V1 scenes use quad lights.
- Tests: cross-integrator convergence (PT vs. PT+NEE agree on a Cornell
  scene — the flagship test, active at last), MIS weights sum to 1,
  NEE furnace, shadow-ray recording, determinism.
- Demo `v1-nee`: same scene, same seed, same spp — PT and PT+NEE side by
  side, plus click-to-inspect showing NEE connections (successful and
  blocked). This is a talk figure on day one.

## V1b — Dielectric + rough conductor

Glass and metal before infrastructure: the talk's later acts (BDPT's
caustics, V4's caustic perturbation) depend on them, and they activate
every reservation V0 planted:

- **Smooth dielectric**: Fresnel-weighted reflect/refract lobe selection
  via `uc`; the η² radiance-compression correction inside `sample()`
  (Radiance mode only); `BSDFSample.eta` finally non-1, activating the
  Russian-roulette `etaScale` fix; first real **delta vertices**
  (pdf = 0, `delta = true`) exercising the specular bookkeeping BDPT will
  rely on. MIS/NEE skip delta vertices.
- **GGX conductor** (visible-normal sampling), plus a rough dielectric if
  free by then.
- Tests: GGX furnace + chi-square on the VNDF sampler; glass-sphere caustic
  scene where PT and PT+NEE still agree (slowly — that slowness is the
  BDPT motivation figure).

## V1c — Worker pool + Node CLI + PNG

Infrastructure lands when render times hurt, not before.

- **Worker pool**: tile scheduler over the pure driver. No seed
  coordination needed — seed keys are per-(pixel, sample), tiles partition
  pixels — and films merge by summation. Both were designed for this.
- **Node CLI** (`scripts/render`): runs the same driver under Node via
  `tsx`; `pngjs` output; scene + integrator + spp from the command line.
  Overnight renders for figures.
- EXR/float output deferred until a figure actually needs it.

## Deliberately out of V1

- **Triangle meshes + BVH** — deferred until the talk's figure list
  demands a mesh; every planned figure so far lives in quad/sphere scenes.
  The `Aggregate` seam waits indefinitely at zero cost.
- **Spectral, participating media, textures** — out of project scope.
- **Loop-style fast PT twin** — rejected at V0 checkpoint 3 on evidence
  (~250k paths/s single-threaded suffices; the pool multiplies it).

## After V1

A planning conversation on **rendering-process display demos** (how to
*show* the algorithms working — progressive comparisons, path animation,
per-strategy visual debugging) with two interesting integrators to drive
it, followed by the V2 (BDPT) plan against the talk's figure list.

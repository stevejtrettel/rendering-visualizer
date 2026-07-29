# V2 Implementation Plan — BDPT (handoff document)

*Written 2026-07-29 for a fresh session to execute. Rationale and research
live in `design-v2.md` (decisions), `pbrt-notes.md` (PBRT v3 mechanics with
section citations), and Veach thesis chapters (theory; re-fetch from
graphics.stanford.edu/papers/veach_thesis if needed). ALL FOUR open
questions in design-v2.md were ANSWERED YES by Steve on 2026-07-29:
pure-function ratio chains; power β=2 default with balance toggle; glass
in scope from day one (validation scenes climb Lambert→glass); weight-sum
assertion as a debug flag available in demos.*

## Working rules (non-negotiable, see CLAUDE.md + memory)

- Steve reviews at each checkpoint below — STOP and report after each.
- Never write code beyond the agreed plan; propose extras first.
- Integrators accumulate, never replace: `UnidirectionalPT` and
  `NEEPathTracer` remain untouched.
- Tests land WITH their components. Typecheck + full suite green before
  any checkpoint report. `npm run typecheck`, `npm test`.
- Verify demos in a real browser (Playwright via
  `/Users/strettel/Code/PathTracerGLSL/node_modules/playwright/index.mjs`;
  dev server may not get port 5173/5174 — parse the port from `npm run
  dev` output; kill leaked servers when done; `waitForFunction(fn,
  undefined, {timeout})` — options is the THIRD argument).

## Existing seams this build stands on (do not re-derive)

- `src/core/integrators/walk.ts` — `randomWalk` already writes per-vertex
  `pdfFwd`/`pdfRev` in AREA measure (backward write into prev), sets
  `delta` + zeroed pdfs for specular bounces, reserves `etaScale`, has
  `TransportMode` threaded, and draws a fixed dimension layout. The light
  subpath is a SECOND CALLER of this function, not new walk code.
- `src/core/integrators/vertex.ts` — `PathVertex` has `type:
  'camera'|'light'|'surface'`, cumulative `beta`, both normals, live
  `bsdf`/`camera`/`light` refs. `cameraVertex()` exists; add
  `lightVertex()`.
- `src/core/lights/light.ts` — `sampleLe`/`pdfLe` DECLARED on the
  interface (throwing stubs in `area.ts`). pdfPos (area) and pdfDir
  (solid angle) stay separate.
- `src/core/scene/camera.ts` — `pdfWe` implemented (pdfDir =
  1/(A·cos³θ)); `sampleWi` is a throwing stub.
- `src/core/geometry/measure.ts` — the ONLY measure-conversion functions.
- `src/render/film.ts` — `splat()` + develop-time `splatScale` ready;
  `Contribution.kind: 'sample'|'splat'` routed by `src/render/driver.ts`.
- `src/core/sampler/sampler.ts` — `startStream` no-op hook +
  CAMERA/LIGHT/CONNECTION constants: BDPT must call them at phase
  boundaries (V3 PSSMLT depends on it).
- `src/trace/recorder.ts` + `records.ts` — extend, keep flatten lossy.
- Worker pool (`src/render/pool.ts`) merges full-frame Float64 films by
  summation — t=1 splats need no pool changes.

## Checkpoint 1 — endpoints + light-subpath walk (no integrator)

1. `AreaLight.sampleLe(u1, u2)`: position uniform-by-area via
   `shape.sampleArea(u1)`; direction cosine-weighted about the light
   normal (`pdfDir = cosθ/π`); return `{L, ray (offset origin), nLight,
   pdfPos, pdfDir}`; respect `twoSided` (extra hemisphere bit only if a
   two-sided light exists — ours are one-sided). `pdfLe(p, n, w)`
   likewise. Import cosine sampling from `core/math/sampling`.
2. `PinholeCamera.sampleWi(ref)`: deterministic — direction from ref to
   `eye`; return `{wi, dist, pdf: 1 (delta convention), We, raster}` or
   null if ref is behind the camera or raster outside the film.
   `we(ray)`: full importance chain — with A = film area at unit distance
   (already stored), `We = 1/(A·cos⁴θ)` measured w.r.t. surface-area at
   distance d multiply by cos/d² at the receiving surface (follow
   SmallVCM `imageToSurfaceFactor`; write the derivation as a comment).
   Keep `pdfWe` consistent with it.
3. `lightVertex()` factory in vertex.ts (type 'light', pdfFwd = pdfPos ×
   selection pmf — already area measure; `light` ref set).
4. `correctShadingNormal(isect, wo, wi, mode)` in walk.ts, applied to
   beta in Importance mode (formula in pbrt-notes §shading-normal).
5. Recorder: tag walks with `role: 'camera'|'light'` (recorder.walk gains
   a role argument; flatten it).
6. Tests (`tests/bdpt-endpoints.test.ts`):
   - sampleLe pdfs: MC-integrate cosine pdfDir to 1 over hemisphere;
     pdfPos = 1/area exactly; emitted rays leave the emissive side.
   - VIGNETTING: flat emissive plane filling a pinhole camera's view —
     estimate the t=1-style importance integral per pixel; must be flat
     (this catches the cos⁴ chain).
   - sampleWi: raster round-trip — `generateRay(raster)` hit point maps
     back to the same raster via sampleWi within 1e-6.
   - Light-walk smoke: `randomWalk` from a `sampleLe` ray with mode
     Importance on the glass Cornell — vertices tagged, pdfs finite,
     determinism.
   - GGX ωo/ωi ORDER TRAP: evaluate a GGX vertex inside an
     Importance-mode walk both argument orders; assert the walk uses the
     (wo-from-light-side) order consistently — Lambert scenes cannot
     catch a swap (see design-v2 warning).

## Checkpoint 2 — the BDPT integrator

Files: `src/core/integrators/bdpt.ts`, `src/core/integrators/bdpt-mis.ts`.

1. `generateCameraSubpath` / `generateLightSubpath`: thin wrappers over
   `randomWalk` (camera: seeded with `pdfWe.pdfDir`, mode Radiance,
   `startStream(CAMERA_STREAM)`; light: pick light via
   `lightDistribution.sample`, `sampleLe`, beta = Le·|n·d| /
   (pmf·pdfPos·pdfDir), mode Importance, `startStream(LIGHT_STREAM)`).
2. `sampleContributions`: `startStream(CONNECTION_STREAM)`; enumerate
   t ≥ 1, s ≥ 0, skip (1,1), depth cap = walk maxBounces; per strategy
   compute unweighted contribution per pbrt-notes §ConnectBDPT (s=0
   emitter-hit; s=1 RESAMPLE via sampleLi, substituted vertex pdfFwd =
   pdfLightOrigin = pmf × 1/area; t=1 via camera.sampleWi → `kind:
   'splat'` at its raster; general: β_qs·f·f·G·β_pt with G using SHADING
   normals and visibility via `occlusionPoint` — record connection
   events). Contributions for t≥2 accumulate into ONE 'sample'
   contribution at the pixel raster; t=1 emits separate splats.
3. `bdpt-mis.ts`: PURE function
   `misWeight(cameraVs, lightVs, s, t, overrides, heuristic)` — no
   mutation; `overrides` carries the role-dependent values pbrt patches
   via ScopedAssignment (substituted endpoint, junction pdfRev values
   computed by the caller from live vertex refs, forced-non-delta
   junction flags). Ratio chains per pbrt-notes §MISWeight with `remap0`;
   `heuristic: 'balance'|'power'` — power squares each ratio term.
   Delta-light guard structure present but asserted-unreachable (no
   delta lights in scenes).
4. Debug flag (integrator option `assertWeights`): per formed path with
   nonzero contribution, evaluate all strategies' weights, assert
   Σ ≈ 1 (tolerance 1e-6). Exposed as a checkbox later in the pyramid
   demo; always on in tests.
5. Recorder: connection events `{s, t, from, to, occluded, blockedAt,
   weight}`; flatten to records.
6. Tests (`tests/bdpt.test.ts`):
   - Hand-built 3-vertex deterministic path: every strategy's
     area-product pdf computed independently (closed forms, Lambert) vs
     via vertex bookkeeping; weight sum = 1 (both heuristics); s=1
     substitution density correct.
   - t=1-only vs PT on diffuse Cornell (splat scale 1/spp): means agree
     within a few %.
   - Cross-integrator: BDPT vs NEE on `cornell` (tight tolerance) and on
     the glass box from tests/glass-scene.test.ts (looser; the caustic
     must MATCH — this is the flagship).
   - White furnace: closed uniform-albedo box, uniform emission;
     analytic Le/(1−ρ); flat image.
   - Determinism; weight-sum assertion enabled throughout.
   - SDS expectation documented in a test comment (weight ≡ 1 correct;
     pbrt-v4 #326).

## Checkpoint 3 — pyramid, demos, figures

1. Per-(s,t) AOVs: integrator option `strategyFilms` — per-strategy
   weighted AND unweighted accumulation (main-thread single-worker path
   is fine; pool not required for the pyramid demo). Checks: weighted
   cells sum pixelwise to final; unweighted cells converge individually.
2. `demos/viz-bdpt-pyramid`: grid of small canvases (rows = path length,
   cells = s), weighted/unweighted toggle, scene dropdown, weight-sum
   debug checkbox. Reuse worker protocol only if convenient — a
   main-thread chunked render (like viz-image-forming's tracer) is
   acceptable here.
3. `viz-single-path` extension: integrator dropdown gains `bdpt`; when
   selected, schedule BOTH subpaths on the timeline (camera amber, light
   subpath in the design language's cyan — add LIGHT_PATH color to
   path-elements) growing simultaneously, then connection events flash
   green/red at their moments. Schedule: reuse buildSchedule per walk
   with a shared clock; connections at max(arrival of their two
   endpoints).
4. `viz-convergence`: add `bdpt` to `IntegratorName`, worker switch, and
   the pane dropdowns (make pane integrator selectable — currently fixed
   pt/pt-nee; simplest: a per-pane <select>). The payoff figure: BDPT's
   error view quiet in the caustic where NEE glowed.
5. Update `docs/design-v2.md` status, README demo list, gallery
   index.html. Report timings (BDPT is O(s·t) connections per sample —
   expect ~3-5× NEE cost per spp at equal maxBounces; the pyramid demo
   should state its own cost).

## Definition of done

All three checkpoints reviewed; 100+ tests green including the flagship
caustic-match; pyramid weighted-sum property verified in-browser on
`cornell-glass`; balance/power toggle demonstrably changes noise on a
low-variance scene; docs statuses updated. THEN the next conversation is
V3 (PSSMLT — pbrt-notes has the full MLT section banked; the sampler
stream hooks are now live).

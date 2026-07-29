# V2 Design — Bidirectional Path Tracing

*Drafted 2026-07-29 for discussion. Sources: docs/pbrt-notes.md (PBRT v3
mechanics, banked), Veach thesis chs. 8–10 (read in full; chapter PDFs in
session scratchpad), SmallVCM + Georgiev VCM tech report, pbrt-v3/v4
issue history, practitioner postmortems. No code before this doc survives
markup.*

## What BDPT is, stated for the talk

Each pixel is one integral over path space Ω = ⋃ Ω_k with the area-product
measure. For a path of length k there are exactly **k+2 sampling
techniques** (s light vertices, t eye vertices, s+t = k+1) — different
probability measures on the SAME space, each proportional to a different
subset of the integrand's factors, each excelling where its subset
dominates. MIS combines them: balance heuristic provably within an
additive μ²-term of optimal (Veach Thm 9.2, Lagrange pointwise argument);
power heuristic (β=2) strictly better on low-variance problems (Thm 9.3).
Slide-ready extras: balance = mixture importance sampling (eqs 9.10–11);
the DD-substring theorem (Thm 8.3) characterizing exactly which paths
local sampling can reach; the middle-of-pyramid observation (equal split
wins for most paths because scattering diffuses radiance and importance
alike); weights summing to 1 IS the unbiasedness condition (W1).

## Architectural decisions (proposed)

1. **A new `BDPT` integrator beside PT and NEE** (never replace). It
   reuses `randomWalk` verbatim: the camera subpath as today; the light
   subpath as a second caller with `TransportMode.Importance`, activating
   `correctShadingNormal` (inert while ns = ng — see tests) and the
   already-filled `pdfRev` chain.
2. **Endpoint completion** — the V0 stubs get bodies:
   - `AreaLight.sampleLe` (uniform area × cosine-weighted direction,
     pdfPos/pdfDir separate) and `pdfLe`;
   - `PinholeCamera.sampleWi` (deterministic direction to the pinhole;
     raster position out) and full `We` importance with the
     imagePlaneDist²/cos³·(cos/d²) chain (SmallVCM's
     `imageToSurfaceFactor` as reference). A vignetting test guards the
     cos⁴-type factor: a flat-lit plane's t=1 light image must be flat.
3. **MIS as a pure function, pbrt's math** (the middle path from the
   research): keep vertex arrays + explicit backward ratio chains
   (inspectable per-strategy pdfs — the visualizer and the talk need
   them; SmallVCM's dVC/dVCM recursion is cleaner but opaque), but
   REPLACE ScopedAssignment's mutate-and-restore with a pure
   `misWeight(cameraVs, lightVs, s, t, overrides)` that takes the
   role-dependent pdf/delta/endpoint substitutions as ARGUMENTS. Same
   math, no mutation hazard, unit-testable in isolation.
4. **Both heuristics, toggleable; default power β=2.** Veach's own BDPT
   uses power (pbrt uses balance); the ratio chain generalizes by
   squaring each ratio. One-sample contexts (V3 MMLT strategy pick, BSDF
   lobe choice) stay balance — provably exactly optimal there (Thm 9.4).
   A balance-vs-power noise comparison is itself a talk figure.
5. **Strategy enumeration**: t ≥ 1 (pinhole ⇒ t=0 impossible), skip
   (1,1); s=1 RESAMPLES the light via `sampleLi` with the substituted
   vertex's `pdfFwd = pdfLightOrigin` (the classic silent-wrong-weights
   bug); t=1 emits `kind:'splat'` contributions, splat scale 1/spp at
   develop (Film already does this); s=0 guards on "vertex is on an
   emitter", not "walk ended".
6. **Locked simplifications** (safe for our scene class): NO infinite
   lights — all four seams omitted; NO delta lights — MIS structure gated
   on `light.type`, asserted unreachable; escaped rays produce no pseudo
   vertices. Surface deltas (glass/mirror) ARE in scope from day one —
   V1b pre-tested the vertex bookkeeping; `remap0` + pairwise delta skips
   per pbrt-notes.
7. **Sampler streams**: the walk phases call `startStream(CAMERA/LIGHT/
   CONNECTION)` — the V0 hook goes live so V3's PSSMLT needs no
   integrator edits.
8. **Recorder**: walks tagged camera/light; new connection events
   {s, t, from, to, occluded, weight, blockedAt} — the visualizer draws
   cyan light subpaths, amber camera subpaths, connection flashes.
9. **Worker pool**: t=1 splats land in each worker's own full-frame film;
   summation merge already handles them (Mitsuba's lightImage lesson).
10. **Numerics**: ratios only, never full path-density products (under/
    overflow even in double — pbrt §16.3).

## Validation plan (the heart of V2 — every item from a documented bug)

- **Per-connection weight-sum assertion** (debug flag): for each formed
  path, evaluate all k+2 strategies' weights, assert Σ = 1. This is
  condition (W1) executed, and the single highest-value check found in
  the research.
- **Pyramid AOVs from day one**: per-(s,t) weighted AND unweighted films
  (pbrt's visualizestrategies/-weights). Checks: weighted cells sum
  pixelwise to the final image; each unweighted cell individually
  converges to the reference for its transport. The PATTERN of wrong
  cells localizes bugs (pbrt-v3 #229 case study: unidirectional cells
  wrong ⇒ Le/orientation; connection cells wrong ⇒ MIS/pdf).
- **Hand-built path unit test**: 3-vertex deterministic path; every
  strategy's area-product pdf computed independently vs via vertex
  bookkeeping; weights sum to 1; s=1 substitution density correct
  (Veach §10.3.4.2's fixup applies to OTHER strategies' weights too).
- **t=1-only vs PT** on the diffuse Cornell: catches splat normalization
  (off-by-#pixels/spp), We vignetting, ωo/ωi argument order.
- **ωo/ωi-order trap**: Lambert is symmetric and ns=ng in our scenes, so
  two whole bug families are INVISIBLE at first. Dedicated test: GGX
  sphere in a light-subpath walk (asymmetric f exposes argument swaps);
  later a deliberately perturbed-ns sphere activates
  correctShadingNormal.
- **Cross-integrator convergence**: BDPT vs PT vs NEE on `cornell` and
  `cornell-glass` (the caustic must MATCH, and BDPT's error view should
  go quiet where NEE's glowed — the payoff figure).
- **White furnace enclosure**: uniform-albedo closed box, analytic
  Le/(1−ρ), flat per-strategy shares.
- **SDS expectation** (pbrt-v4 #326): BDPT legitimately cannot beat PT on
  specular-diffuse-specular paths (weight ≡ 1 is CORRECT there) — record
  as expected behavior, not a bug; it is V3's motivation.

## Demos / figures

- `viz-bdpt-pyramid`: the Veach pyramid as a live grid (weighted /
  unweighted toggle) — debugger during development, talk figure after.
- Single-path demo extension: both subpaths grow simultaneously on the
  timeline (camera amber, light cyan), then candidate connections flash;
  reuses the existing schedule machinery with a second walk + connection
  events.
- Convergence harness: BDPT joins as a third integrator option — zero
  new harness code.

## Checkpoints

1. Endpoints + light-subpath walk: sampleLe/pdfLe, We/sampleWi/pdfWe with
   vignetting test, Importance-mode walk + correctShadingNormal, GGX
   order test. No integrator yet.
2. BDPT integrator: enumeration, connections, pure-function MIS (both
   heuristics), weight-sum assertion, hand-built-path test, t=1-vs-PT,
   cross-integrator convergence.
3. Pyramid AOVs + demos + figures; pool integration verified.

## Open questions for markup

1. MIS style (pure-function ratio chains over SmallVCM recursion) — the
   pedagogy-vs-cleanliness call. Agree?
2. Power β=2 default with balance toggle — agree?
3. Scope: glass in from day one (recommended; V1b pre-tested deltas) or
   Lambert-first?
4. The per-connection weight-sum assertion: debug-flag always available,
   or also on in tests only?

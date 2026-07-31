# PBRT implementation notes for V1–V3

*Distilled 2026-07-28 from a review of PBRT (pbr-book.org, 4ed and 3ed)
against our design. `design-v0.md` holds everything V0-relevant; this file
preserves the later-stage detail so it isn't re-researched. Citations are
book sections: v4 = 4th edition online, v3 = 3ed-2018 online.*

## Sampler seeding scheme (v4 §8.3–8.5, §B.2.14)

- `IndependentSampler.startPixelSample`:
  `rng.setSequence(hash(key, seed)); rng.advance(sampleIndex * 65536 + dimension)`.
  Per-key PCG *sequences* (2⁶³ available), hashed — never raw
  `x*width+y`-style keys (correlation hazard). The 2¹⁶ constant is the
  per-sample dimension budget; deep-path overrun is theoretical but real.
- Uniform floats: `min(u32 * 2^-32, 1 - 2^-24)` — strictly [0,1).
- StratifiedSampler (future) derives samples *functionally* from
  `(pixel, dimension)` — deliberately excluding sampleIndex from the
  permutation hash so a pixel's samples share stratum permutations. A
  "hash everything" refactor would silently destroy stratification.
- Interface warning (v4 §8.3): integrators must consume dimensions in the
  same order on every code path; pbrt guarantees cross-run determinism per
  (pixel, sampleIndex) as an interface requirement.

## BSDF details (v4 §9.1, §9.5, §13.4)

- Local frame: `Frame::fromXZ(normalize(dpdu), ns)`; both `wo`,`wi` point
  away from surface; frame normal **never flipped** toward `wo` — the
  dielectric reads `sign(cosθ_o)` to know inside/outside. `SameHemisphere`
  = z-signs. Guard `wo.z == 0` → black/null.
- Dielectric transmission (v4 §9.5.2): BTDF non-symmetry
  `η_o² f(ωo,ωi) = η_i² f(ωi,ωo)`. Implementation: in `sample()`'s
  transmission branch, `if (mode === Radiance) f /= etap²` where `etap` is
  the directed relative IOR from the refract routine; also return
  `eta = etap` in the BSDFSample. The correction is *inside the BSDF*,
  keyed on mode — never an integrator-side multiply.
- Delta lobes: `sample()` pdf = discrete lobe probability (`R/(R+T)` for
  dielectric lobes, Fresnel-weighted); `eval`/`pdf` = 0.
- RR eta fix (v4 §13.4): path state carries `etaScale *= eta²` on
  transmission; RR survival uses `beta * etaScale` (never the estimate
  itself) so paths inside glass aren't over-killed.
- Regularization (v4 §13.4, optional later): after any non-specular bounce,
  near-specular microfacet lobes widen (`if α < 0.3: α = clamp(2α, 0.1,
  0.3)`). Biased; off by default; never on directly-viewed specular chains.

## Shading-normal adjoint correction (v3 §16.1.3)

For light subpaths (Importance mode) only, multiply throughput each bounce:
`correctShadingNormal = (|ns·wo| |ng·wi|) / (|ng·wo| |ns·wi|)`; = 1 for
Radiance mode. Applied in the random walk, not the BSDF. Needs ng and ns
at the vertex.

## Shape solid-angle sampling (v4 §6.2.4, §6.6.2)

Upgrades internal to `shape.sample(ref, u2)` — signature already final:
- **Sphere**: ref outside → sample the subtended cone, `pdf = 1/(2π(1 −
  cosθmax))`, `sinθmax = r/d` (Taylor-expand near 0); ref inside → uniform
  area + convertDensity fallback.
- **Quad/rectangle**: Ureña spherical-rectangle sampling, plus a bilinear
  warp by corner cosines (`w = max(0.01, |v_corner · ns_ref|)`); fall back
  to area sampling outside `[3e-4, 6.22]` steradian subtended area.
  `pdfLi` must mirror the branch (invert the warp).
- Fallback conversion (both): `pdf_ω = pdf_A · d² / |cosθ_light|`.

## Light interface details (v4 §12; v3 §16.1.2; pbrt-v4 base/light.h)

- `pdfLe` wants two entry points: (ray) for point-like lights and
  (interaction point, direction) for area lights.
- Delta lights: `sampleLi.pdf = 1` (L already includes 1/r²), `pdfLi = 0`;
  MIS must *also* guard on `isDelta` rather than trusting 0-pdf arithmetic.
- Two-sided quirks: `phi` ×2; `sampleLe` needs an extra random bit for
  hemisphere choice; back-side solid-angle samples of a one-sided light
  yield pdf > 0 with L = 0 — `le()` is the single source of truth.
- PowerLightSampler (v4 §12.6.2): weights ∝ `phi()`, alias table, needs
  `pmf(light)` lookup. Reported ~12× MSE win on many-light scenes.

## Film (v4 §5.4)

- Per pixel: `double rgbSum[3], weightSum; double splatSum[3]` (splats
  atomic in pbrt; per-worker-film + merge for us).
- v4 filter importance sampling: `filter.sample(u) → {offset, weight =
  f/pdf}` chosen at camera-sample generation; each sample touches exactly
  one pixel; estimator `Σ wᵢLᵢ / Σ wᵢ` is self-normalizing (works with
  negative-lobe filters). Box filter: offset = u − ½, weight = 1.
- `develop`: `rgbSum/weightSum + splatScale · splatSum / filterIntegral`.
  Samples normalize by *accumulated* weight, splats by *analytic* integral
  and an external scale (BDPT: `1/spp`; MLT: `b/mutationsPerPixel`).
- Guard `weightSum == 0` pixels.

## BDPT (v3 §16.3)

**Vertex** (§16.3.1): `{type: Camera|Light|Surface|Medium, beta, interaction,
delta = false, pdfFwd = 0, pdfRev = 0}` — beta is the subpath-prefix
throughput; delta means "a delta lobe was sampled leaving here"; both pdfs
in **area product measure**.

`convertDensity(pdf_ω, next)`: early-out (return pdf_ω unchanged) if `next`
is an infinite light; else `pdf_ω · invDist² · |ng_next · ŵ|` with the
cosine only for surface vertices. **Geometric** normal for density; the
geometry term G uses **shading** normals for contribution:
`G = Tr · |ns₀·d̂||ns₁·d̂| / d²` (cosines only for surface endpoints).

**RandomWalk** (§16.3.2), per bounce:
```
vertex   = createSurface(isect, beta, pdfFwd_ω, prev)   // converts fwd to area vs prev
{f, wi, pdfFwd_ω, lobeFlags} = bsdf.sample(wo, ...)
beta    *= f · |wi·ns| / pdfFwd_ω
pdfRev_ω = bsdf.pdf(wi, wo)                              // swapped args
if specular lobe: vertex.delta = true; pdfFwd_ω = pdfRev_ω = 0
beta    *= correctShadingNormal(isect, wo, wi, mode)
prev.pdfRev = vertex.convertDensity(pdfRev_ω, prev)      // written BACKWARD
```
Camera subpath: `path[0] = createCamera(camera, ray, beta=1)`, walk seeded
with `pdfWe.pdfDir`, mode Radiance, length maxDepth+2. Light subpath:
pick light (pmf), `sampleLe`; `path[0].pdfFwd = pdfPos · lightPmf` (already
area); `beta = Le · |nLight·d| / (lightPmf · pdfPos · pdfDir)`; mode
Importance; length maxDepth+1. Escaped Radiance-mode rays become Light-type
vertices storing solid-angle pdfFwd uncorrected (matched by the
convertDensity early-out).

**Strategy enumeration** (§16.3): `t ∈ [1, nCam]`, `s ∈ [0, nLight]`, skip
`(1,1)` and `depth = s+t−2 ∉ [0, maxDepth]`; t=0 never enumerated (pinhole
unhittable). `t ≠ 1` contributions add to the pixel sample; `t = 1` splats
at the resampled raster position.

**ConnectBDPT** (§16.3.3) special cases:
- Guard: reject `t>1, s≠0` when the camera subpath's last vertex is an
  escaped-ray Light vertex.
- `s=0`: `L = pt.Le(prev) · pt.beta` if the camera subpath ends on a light.
- `t=1`: `camera.sampleWi(qs, u)` → new camera vertex; splat at returned
  raster; `L = qs.beta · qs.f(sampled) · Tr · sampled.beta` (× `|wi·ns_qs|`
  if qs on surface).
- `s=1`: **resample the light with `sampleLi`** (superior to reusing
  lightVertices[0] — receiver-aware importance sampling); the substituted
  vertex needs `pdfFwd = pdfLightOrigin(...)` set or MIS is wrong.
- General: `L = qs.beta · qs.f(pt) · pt.f(qs) · pt.beta · G(qs, pt)`;
  connectible vertices only (surface vertices need a non-specular lobe).
- Compute the MIS weight only when L is non-black.

**MISWeight** (§16.3.4): balance heuristic `1/(1 + Σ rᵢ)` with ratio chains
`rᵢ *= remap0(pdfRev)/remap0(pdfFwd)` walking backward from the junction on
each side; a term joins the sum only if neither vertex flanking the
hypothetical junction is delta (light side i=0 uses `isDeltaLight`).
`remap0(x) = x ≠ 0 ? x : 1` realizes the delta-probability cancellation.
Before the loops, temporarily rewrite (scoped, restored after): the s=1/t=1
substituted endpoint; both junction vertices' `delta = false`; and up to
four role-dependent `pdfRev` values — `pt.pdfRev` (from qs, or
`pdfLightOrigin` when s=0), `ptMinus.pdfRev` (from pt, or `pdfLight` when
s=0), `qs.pdfRev` (from pt), `qsMinus.pdfRev` (from qs). These cannot be
baked in during the walk; they depend on (s,t).
Per-path weights across strategies must sum to 1 — build the per-(s,t)
strategy/weight debug images immediately (they are the Veach pyramid *and*
the debugging tool).

**Infinite lights** (§16.3.5, if ever needed): directional density
`1/(π·worldRadius²)` for positions; special-cased in exactly four seams
(convertDensity early-out, pdfLight, pdfLightOrigin, post-generation fixup
of path[0]/path[1]).

## MLT / MMLT (v3 §16.4, §13.4.1; pbrt-v3 mlt.cpp)

**MLTSampler**: lazy `PrimarySample { value, lastModificationIteration,
valueBackup, modifyBackup }` array, grown on demand. On read:
if the sample predates the last large step, reset to fresh uniform first;
then backup and apply the pending mutation. Small step: wrapped Gaussian,
`value += sqrt(nPendingSmallSteps) · σ · N(0,1)` (via erfInv), mod 1,
σ = 0.01 — symmetric on the torus, so acceptance is just `min(1, I'/I)`.
Large step: fresh uniform (prob 0.3). `reject()` restores this iteration's
touched samples **and decrements the iteration counter**. Forgetting the
lazy large-step reset (or the decrement) are the two classic PSSMLT bugs.
DELIBERATE DIVERGENCE (2026-07-30, agreed): pbrt zero-initializes
`PrimarySample.value`; we materialize new coordinates as fresh uniforms
dated at the last accepted large step — the eager-equivalent marginal
(uniform ⊛ wrapped Gaussian = uniform). Do not "fix" back to pbrt.

**Streams**: `startStream(i)` + `globalDim = i + 3·sampleIndex++`; streams
camera=0, light=1, connection=2. Without them, a subpath length change
re-maps every later dimension — an accidental global mutation.

**Driver (MMLT)**: per state, camera stream dim 0 picks the strategy:
`nStrategies = depth + 2; s = floor(u·nStrategies); t = nStrategies − s`
(depth 0: s=0,t=2); dims 1–2 are the raster position (part of the state);
contribution = `connectBDPT(s,t) · nStrategies`. Target I = luminance.
- Bootstrap: `nBootstrap (1e5) × (maxDepth+1)` seeds, depth `i mod
  (maxDepth+1)`, each a fresh sampler seeded by index i; `b = mean(weights)
  · (maxDepth+1)`. Chains draw a seed ∝ weight and **regenerate the state
  by re-seeding with that index** (seed-replay — our idiom) → chains start
  in equilibrium, zero burn-in. Error in b is a multiplicative bias on the
  whole image.
- 1000 chains, `mutationsPerPixel (100) × pixels` total mutations, split
  evenly. Depth is fixed per chain; s,t and raster mutate within it.
- Per mutation, both-states splatting (§13.4.1):
  `splat(pProposed, Lprop · a / Lprop.y)` and
  `splat(pCurrent, Lcur · (1−a) / Lcur.y)`, `a = min(1, Lprop.y/Lcur.y)`;
  guard `Lcur.y == 0`. Splats are unit-luminance; final image scale =
  `b / mutationsPerPixel` at develop time. MLT never touches `addSample`.
- Splats are correlated across iterations — variance bookkeeping must not
  assume independence.

## Russian roulette (v4 §13.4)

`q = max(0, 1 − maxComponent(beta · etaScale))` each bounce past the
minimum depth (pbrt: depth > 1 *with* NEE; use ≥ 3 without); on survival
`beta /= 1 − q`. Max component, not luminance (chromatic-bias avoidance).
pbrt skips the RNG draw when `rrBeta ≥ 1`; we deliberately always draw
(fixed dimension layout for PSSMLT).

# V0 Design — Walking Skeleton

*Agreed 2026-07-28; amended same day after the PBRT best-practices review
(see `docs/pbrt-notes.md` for the V1+ implementation detail that review
produced). Later stages (NEE, BDPT, PSSMLT, path-space perturbations) are
sketched at the end only insofar as they constrain V0's interfaces.*

## Purpose of the project

A bidirectional path tracer built two ways for a mathematics talk:

1. a CPU renderer implementing unidirectional PT, PT+NEE with MIS, BDPT, and
   Metropolis sampling — staged as PSSMLT first, then a curated set of
   path-space perturbations (lens + caustic) as the "designing good
   proposals" punchline;
2. a three.js visualization that draws the *actual paths the renderer
   sampled* into the scene — including the failures (occluded shadow rays,
   Russian-roulette terminations, rejected mutations), which are
   pedagogically as important as the successes.

## Purpose of V0

V0 is a **walking skeleton**: the smallest system that exercises every
architectural seam with minimal content. If the seams are right, later
algorithms are additions, not surgery.

**V0 target.** A Cornell-style scene (quads + spheres, one area light,
Lambert only) rendered by unidirectional path tracing in a Web Worker,
progressively displayed on a canvas. Clicking a pixel re-traces that pixel's
paths deterministically and draws them as polylines in a three.js panel
beside the canvas.

**V0 excludes** — deliberately, with interfaces already shaped for them:
NEE, BDPT, MLT, BVH, triangle meshes, dielectric/GGX materials, worker
pools, the Node CLI, EXR output.

## Architectural principles

These are the load-bearing decisions; changing any of them later is surgery.

1. **`src/core/` is pure.** No DOM, no three.js. It runs unchanged in the
   browser, Web Workers, and Node.

2. **All randomness flows through `Sampler`.** No integrator ever touches a
   raw RNG. This is the prerequisite for PSSMLT (the Markov chain hijacks
   the primary sample space by substituting the sampler) and it gives
   deterministic replay: sampler state is a pure function of a seed key, so
   the visualizer re-traces paths instead of storing them for every pixel.
   Corollary (PSSMLT locality): **integrators consume sample dimensions in
   a fixed order on every code path** — e.g. the Russian-roulette draw
   happens every bounce past the minimum depth even when survival is
   certain. Divergent consumption turns small mutations into accidental
   large ones and silently degrades stratified samplers.

3. **Integrators are path-centric.** They materialize explicit
   `PathVertex[]` lists via a single shared `randomWalk` engine, then
   evaluate contributions from them. BDPT requires this anyway; MIS weights
   become inspectable objects; and the integrator's internal representation
   *is* the visualization record, so the visualization cannot drift from
   the real computation. We accept the allocation cost — this renderer
   optimizes for clarity and instrumentation, not throughput.

4. **Cameras and lights are symmetric, sampleable endpoints.** Lights carry
   `sampleLi/pdfLi` *and* `sampleLe/pdfLe`; the camera carries
   `generateRay` *and* `We/sampleWi/pdfWe`. BDPT then reads as "connect two
   subpaths," and endpoints appear as first-class vertices in the path
   array. `TransportMode` (radiance vs. importance) is threaded through
   every BSDF call from day one because refraction and shading normals are
   transport-asymmetric. The two corrections live at fixed layers: the η²
   radiance-compression factor *inside* the dielectric BSDF (Radiance mode
   only, V1); the shading-normal adjoint factor in the light-subpath walk
   (Importance mode only, V2).

5. **The film accepts contributions, not answers.** Integrators produce
   weighted `{kind, raster, value}` contributions — `kind: 'sample'` for
   camera-sampled pixels, `kind: 'splat'` for light tracing and MLT, which
   land at arbitrary raster positions. An "Li per camera ray" interface
   structurally cannot express BDPT or MLT. Samples are normalized by
   accumulated filter weight; splats by an external scale supplied at
   develop time (MLT's normalization constant is unknown until the end).

6. **Instrumentation is a `Recorder` interface** threaded through
   integrators: `NullRecorder` for production renders, `ArrayRecorder` for
   traced pixels. Records are plain serializable data (structured-clone
   safe) so they cross the worker boundary and feed the three.js layer.

### Conventions (decided once, enforced everywhere)

- **Vec3 is a readable class**, immutable by convention (methods return new
  vectors), with a small set of explicitly named in-place operations
  (`addInPlace`, …) for hot loops. We are not chasing native performance.
  `Color` is an RGB triple with a `luminance()` scalar (MLT's target
  function and acceptance ratios need it; the weights are decided once,
  here).
- **Pdf measures are explicit.** Vertex pdfs are stored in area measure;
  solid-angle pdfs exist only transiently inside the random walk. The
  solid-angle → area conversion is **one named function**,
  `convertDensity(pdf, from, to)` = `pdf · cosθ_to / d²`, using the
  **geometric** normal of the destination and applying the cosine only for
  surface vertices. Position/direction pdfs of endpoints (`pdfPos` area,
  `pdfDir` solid angle) are always kept separate, never premultiplied —
  BDPT assigns them to different vertices.
- **Normals are used by role**: density conversion and ray offsetting use
  the geometric normal `ng`; BSDF evaluation and the geometry term G use
  the shading normal `ns`. Conflating them silently biases MIS.
- **Epsilon policy lives in one place**: `offsetRayOrigin(p, ng, w)` offsets
  along ±`ng`, sign chosen by `dot(w, ng)` so transmission rays offset to
  the far side; fixed magnitude ~1e-6 world units (float64 makes PBRT's
  error-bound machinery unnecessary). Shadow rays offset both endpoints and
  clip `tMax` at `(1 − 10⁻⁴) · distance`.
- **Random numbers are strictly in [0, 1)** — `next1D` clamps like PBRT
  (`min(u, 1 − 2⁻²⁴)`-style); a leaked 1.0 breaks `floor(u·n)` selection.
- **Radiometric units**: radiance throughout; RGB throughput (no spectra).
- **No clamping, no regularization** in V0/V1 defaults: the cross-integrator
  convergence tests require unbiased estimators. (A `regularize()` BSDF
  hook à la pbrt-v4 may arrive with dielectrics, off by default.)
- **V0 tone map**: exposure scale + sRGB encode. (ACES or similar can be
  added for final figures.)

## Components (implementation order = dependency order)

### 1. `core/math`
`Vec3`, `Ray`, `OrthonormalBasis`, `Color` (with `luminance()`), sampling
helpers (cosine-hemisphere, uniform sphere, concentric disk), `PCG32` with
full 64-bit state (two 32-bit words or BigInt), `setSequence(seq, offset)`
and `advance(delta)` (jump-ahead), plus a 64-bit-quality hash for seed
mixing. Never instantiate a PCG32 without an explicit sequence.

### 2. `core/sampler`
```ts
interface Sampler {
  startPixelSample(key: SeedKey, dimension?: number): void;
  next1D(): number;                   // strictly [0, 1)
  next2D(): [number, number];
  nextPixel2D(): [number, number];    // film-plane sample; default impl = next2D()
  startStream(index: number): void;   // no-op in IndependentSampler
  clone(): Sampler;                   // instance duplication (workers) — NOT re-seeding
}
// Stream constants: CAMERA_STREAM = 0, LIGHT_STREAM = 1, CONNECTION_STREAM = 2.
```
Design notes, from the PBRT review:
- `startPixelSample` *is* the determinism/replay mechanism: sampler state is
  a pure function of `(key, dimension)`. `IndependentSampler` implements it
  as `rng.setSequence(hash(key, globalSeed)); rng.advance(sampleIndex · 2¹⁶
  + dimension)` — per-key PCG sequences (hashed, never raw), a 2¹⁶
  dimension budget per sample, no stored state needed for replay.
- `SeedKey` is an **opaque integer key**, not structurally `(pixel,
  sampleIndex)`: pixel samples use `(pixel, sampleIndex)`-derived keys; MLT
  chains replay from bootstrap indices (V3).
- `startStream` exists so the BDPT integrator (V2) marks its camera / light
  / connection phase boundaries from day one of *its* implementation; the
  PSSMLT sampler (V3) interleaves streams so a path-length change in one
  subpath cannot shift another subpath's dimensions. Within a stream,
  consumption is strictly sequential — no absolute dimension addressing.
- `clone()` exists only for the V1 worker pool (samplers are stateful).

### 3. `core/geometry`
Analytic `Sphere` and `Quad`; `Intersection { t, p, ng, ns, uv, primitive }`;
an `Aggregate` interface with a linear-scan implementation (a BVH replaces
the internals in V1 without changing the signature); `visible(p, q)` for
shadow queries; `offsetRayOrigin` (see conventions). Shapes carry two
sampling entry points, mirroring pbrt: `sampleArea(u2)` (uniform by area,
pdf `1/area`) and `sample(ref, u2)` (with respect to solid angle at a
reference point, pdf in solid angle). **V0 implements `sample(ref, u2)` as
area sampling + `convertDensity`** — upgrading to cone sampling (sphere) and
spherical-rectangle sampling (quad) later is internal to the shape.

### 4. `core/materials`
```ts
interface BSDF {
  flags: BSDFFlags;
  eval(wo: Vec3, wi: Vec3, mode: TransportMode): Color;
  sample(wo: Vec3, uc: number, u2: [number, number], mode: TransportMode): BSDFSample | null;
  pdf(wo: Vec3, wi: Vec3, mode: TransportMode): number;
}
// BSDFSample = { f: Color, wi: Vec3, pdf: number, flags: BSDFFlags, eta: number /* = 1 */ }
```
- `uc` is the 1D lobe-selection sample, `u2` the 2D direction sample — an
  explicit, stable per-event sample layout (the V1 dielectric needs `uc`;
  PSSMLT benefits from the fixed layout).
- `flags` is a two-axis bitfield — `REFLECTION | TRANSMISSION` ×
  `DIFFUSE | GLOSSY | SPECULAR` — with helpers (`isSpecular`,
  `isNonSpecular`, …). `BSDFSample.flags` describes the **sampled lobe**,
  not the whole material (BDPT vertex classification and the
  specular-bounce logic need per-event flags).
- **Delta contract**: `sample()` on a delta lobe returns the *discrete lobe
  probability* as `pdf` (1 for a lone mirror); `eval()` and `pdf()` return
  0 for delta directions. MIS then needs no special cases beyond flag
  checks. We deliberately omit pbrt's `sampleFlags` restriction parameter.
- **Implementations are pure local-frame BxDFs** (shading normal = +z,
  cosθ = `w.z`, hemisphere tests by z-sign, frame never flipped toward
  `wo` — dielectrics need the sign) wrapped by a `SurfaceBSDF` owning the
  shading frame and transforming render ↔ local; integrators only see
  render space. Guard `wo.z == 0` → null/black.
- `BSDFSample.eta` feeds the Russian-roulette `etaScale` correction (below).
- V0 implements `Lambert` only.

### 5. `core/lights`
```ts
type LightType = 'area' | 'deltaPosition' | 'deltaDirection' | 'infinite';
interface Light {
  type: LightType;                       // isDelta(type) guards MIS
  phi(): Color;                          // total power — the future PowerLightSampler needs only this
  le(p: Vec3, n: Vec3, uv: UV, w: Vec3): Color;   // emitted radiance; the ONE place one-sidedness is enforced
  sampleLi(ctx: LightSampleContext, u2: [number, number]): LiSample | null;
  pdfLi(ctx: LightSampleContext, wi: Vec3): number;          // solid angle at receiver
  sampleLe(u1: [number, number], u2: [number, number]): LeSample | null;  // V2
  pdfLe(p: Vec3, n: Vec3, w: Vec3): { pdfPos: number; pdfDir: number };   // V2 — always separate
}
// LightSampleContext = { p: Vec3, ng: Vec3, ns: Vec3 } — slim receiver description
// LiSample = { L: Color, wi: Vec3, pdf: number /* solid angle */, pLight: { p, ng } }
```
- `sampleLi` does **not** trace visibility — the integrator does, which is
  exactly where the Recorder captures occluded shadow rays as failure
  events.
- Delta convention: delta lights return `pdf = 1` from `sampleLi` and 0
  from `pdfLi`; MIS additionally guards on `isDelta` rather than relying on
  zero-pdf arithmetic.
- `AreaLight` (over a shape) has `twoSided: boolean` (default one-sided),
  enforced only in `le()`; `phi = π · (twoSided ? 2 : 1) · area · L`.
  `sampleLe` (V2) samples position uniformly by area and direction
  cosine-weighted (`pdfDir = cosθ/π`) so light-subpath rays carry uniform
  differential power.
- Light selection sits behind a distribution interface with **both**
  `sample(u)` → `{light, pmf}` and a `pmf(light)` lookup (MIS composes
  `pmf · pdfLi`; BDPT's light-subpath start needs the context-free form).
  V0: uniform.

### 6. `core/scene`
Typed declarative scene description; adapter to core intersectables; pinhole
camera with `generateRay` implemented and `We/sampleWi/pdfWe` declared
(pdfWe returns separate `pdfPos`/`pdfDir`, mirroring lights). The three.js
adapter lives in `src/viz/`, not here.

### 7. `core/integrators`
```ts
interface Integrator {
  sampleContributions(pixel: Pixel, sampler: Sampler,
                      scene: Scene, recorder: Recorder): Contribution[];
}
// Contribution = { kind: 'sample' | 'splat', raster: [number, number], value: Color }
```
`pixel` is **advisory** — a stratification hint for camera-driven
integrators. MLT-mode rendering drives the raster position from the sampler
itself (it is part of the Markov state) and emits splats over the whole
film domain.

The path-building phase is one shared engine used by every integrator (and
by BDPT's light-subpath generation in V2):
```
randomWalk(ray, beta, pdfDirSolidAngle, mode, sampler, recorder): PathVertex[]
```
with pbrt's invariants: solid-angle pdfs live only in loop variables; each
new vertex stores `pdfFwd` converted to area measure against its
predecessor; **each bounce also computes the reverse pdf (`pdf(wi, wo)`)
and writes `pdfRev` backward into the previous vertex** — filled from V0
on (cheap, closed-form-testable for Lambert, and it makes BDPT a second
caller rather than a rewrite). Specular bounces set `pdfFwd = pdfRev = 0`
and `delta = true` on the vertex (never the discrete probability — the
MIS `remap0` machinery depends on the zeros).

`PathVertex` fields: `type: 'camera' | 'light' | 'surface'` (endpoints are
first-class array entries), `p`, `ng`, `ns`, `uv`, cumulative throughput
`beta` (prefix product to this vertex — connections need it at every
junction), `pdfFwd`, `pdfRev` (area measure), `delta: boolean` (a delta
lobe was sampled *leaving* this vertex — distinct from the BSDF's flags,
and temporarily rewritten by BDPT's MIS), the sampled direction and event
record, and live references (BSDF; camera/light object for endpoints) —
MIS evaluates directions that were never sampled, so vertices must be able
to *evaluate*, not just describe. This is also why PathRecord is a lossy
flatten.

Russian roulette, per bounce once `depth ≥ 3` (V0 has no NEE; the
threshold drops when NEE lands): survival `q = min(1, maxComponent(β ·
etaScale))`, throughput divided by `q` on continuation. `etaScale` starts
at 1 and is multiplied by `eta²` on transmission (reserved now; Lambert
never changes it) so glass interiors aren't over-killed. The RR dimension
is drawn unconditionally (principle 2), and RR terminations are recorded
as path events.

### 8. `src/trace`
`PathRecord` — the serializable flattening of `PathVertex[]` plus event
metadata: scatter events, occluded/unoccluded shadow rays (V1+), RR
survival/termination with probability, and later connection edges and
mutation accept/rejects — and `Recorder` (`NullRecorder`, `ArrayRecorder`).
The PathVertex → PathRecord conversion is a dumb flatten by design.

### 9. `src/render`
`Film`: one `Float64Array`, 7 numbers per pixel — `rgbSum[3]`, `weightSum`,
`splatSum[3]` (JS numbers give pbrt's double-precision accumulators for
free; per-worker films merge by summation in V1). `addSample(raster, color,
weight = 1)` accumulates weighted color + filter weight; `splat(raster,
color)` accumulates color only. `develop(splatScale)` produces
`rgbSum/weightSum + splatScale · splatSum / filterIntegral` → exposure →
sRGB. Store `weightSum`, never a sample count. Filter sampling happens at
camera-sample generation (v4-style filter importance sampling); V0 uses a
box filter (radius 0.5), where it degenerates to plain averaging.
Pass-based driver; a single Web Worker with a small message protocol
(`renderPass` → transferable pixel buffer). Worker pools come in V1.

### 10. `src/viz`
Scene → three.js adapter (quads/spheres → meshes, emissive material for
lights); `PathRecord[]` → polylines (plain `THREE.Line` in V0; tubes,
coloring by throughput, and animation come later).

### 11. `demos/v0-cornell`
Split view: progressive CPU render on the left; three.js scene on the
right; clicking a pixel re-traces and draws that pixel's paths.

### 12. `tests/` (land with their components, not after)
- chi-square: cosine-hemisphere sampler vs. analytic distribution;
- white furnace: Lambert energy conservation;
- determinism: same seed ⇒ bit-identical film hash;
- pdf symmetry: Lambert `pdfRev` against its closed form;
- sampler: `startPixelSample` purity (same key ⇒ same stream), [0,1) bounds;
- (from V1 on) integrator cross-consistency: all integrators converge to
  the same image on test scenes.

## Review checkpoints

Implementation pauses for review after:
1. `core/math` + `core/sampler` + `core/geometry` (foundations);
2. the integrator (components 4–7);
3. the demo (components 8–11).

## Staging beyond V0 (context only — not V0 scope)

- **V1**: NEE + MIS (power heuristic), BVH + triangle meshes, worker pool,
  Node CLI + PNG/EXR, dielectric + GGX (η² correction inside the dielectric;
  `etaScale` RR fix activates), solid-angle shape sampling upgrades.
- **V2**: BDPT — light subpaths (`sampleLe`), camera importance (`We`),
  (s,t) strategy family with MIS (`remap0`, role-dependent pdfRev
  rewrites), per-strategy film planes (the Veach pyramid figure — also the
  primary debugging tool), `CorrectShadingNormal` in the light walk.
- **V3**: PSSMLT wrapping the BDPT sampler (MMLT-style: strategy index and
  raster position are mutated dimensions); chain visualization.
- **V4**: path-space lens + caustic perturbations; proposal-design
  comparison figures.
- Throughout: visualization polish (tubes, animation, failure-case
  rendering) driven by the talk's figure list.

Implementation detail for V1–V3 (MIS weight mechanics, MLT driver
arithmetic and constants, shape solid-angle sampling, seeding schemes) is
recorded with citations in `docs/pbrt-notes.md`.

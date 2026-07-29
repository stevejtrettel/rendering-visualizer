# V1c Design — Triangle Meshes, BVH, OBJ, Worker Pool

*Agreed 2026-07-29. Motivation: caustic beauty figures may want real
geometry (glassware/teapots), and speed must stay comfortable ("relatively
fast" is a requirement). Reference implementation consulted: Steve's
PathTracerGLSL (`src/components/accel/bvh/bvh.ts` — binned-SAH builder
with a flat node array; `src/authoring/loadOBJ.ts`; `demos/models/*.obj`).*

## Architecture: the fork that isn't

A mesh is ONE `Shape`. Its BVH lives INSIDE `TriangleMesh.intersect()` —
the scene-level aggregate remains the linear scan over ~10 primitives,
which is optimal at that count. No unified acceleration over mixed object
types exists or is needed; integrators/lights/viz are untouched.

- **`TriangleMesh`** (`core/geometry/triangle-mesh.ts`): flat typed arrays
  (positions, normals, indices), Möller–Trumbore, interpolated shading
  normals (ng = face normal, flipped to agree with ns), internal BVH.
  Meshes CANNOT be lights (no sampleArea/sample/pdf — they throw); lights
  stay quads. UVs zero until needed.
- **BVH** (`core/geometry/bvh.ts`): binned SAH (12 bins, longest axis),
  leaf ≤ 4 tris, flat Float32Array nodes
  `[minx,miny,minz,A, maxx,maxy,maxz,B]` (A ≥ 0: leaf count/offset;
  A < 0: internal, axis = −A−1, right child = B, left = node+1), triangle
  order re-emitted leaf-contiguous. Iterative traversal, fixed stack.
- **Sealed fast module**: mesh + BVH internals are allocation-free scalar
  code on flat arrays (the u64 precedent) — correctness is enforced by
  testing traversal against a brute-force all-triangles reference on
  thousands of random rays, not by readability.
- **OBJ parser** (`src/io/obj.ts`): v / vn / f with all index forms
  (`a`, `a/b`, `a//c`, `a/b/c`, negatives), polygon-fan triangulation,
  per-corner v/vn dedup, smooth-normal computation when vn is absent.
  Materials (.mtl) and vt ignored.
- **Scene description**: `{kind:'mesh', positions, normals?, indices}`
  (typed arrays — structured-clone safe across workers). three.js adapter
  feeds them straight into a BufferGeometry.
- **Assets**: `demos/_shared/models/` (teapot.obj borrowed from
  PathTracerGLSL); `demos/_shared/scenes.ts` gains an async
  `loadSceneRegistry()` that fetches + parses + normalizes models and
  returns the full registry (`cornell`, `cornell-glass`,
  `cornell-teapot`). Demos await it at startup (top-level await).

## Performance expectation (stated in advance, measured at checkpoint)

Rays engaging a ~5–50k-triangle mesh: ~2–3× the current per-ray cost;
rays missing its root box: one AABB test. BVH build: one-time, well under
a second. The worker pool then over-recovers the loss.

## Worker pool (checkpoint 2)

**Sample-parallel, not tile-parallel**: N workers each render FULL frames
at interleaved sample indices (worker k renders passes k, k+N, …). Seed
keys are per-(pixel, sample) so no coordination exists; each worker keeps
its own Film and ships its raw Float64 film data (transferred, not
copied); the main thread keeps per-worker accumulations and merges IN
WORKER ORDER at develop time, so the result is bit-deterministic and
identical to a serial render. No tiles, no bands, no scheduler. Protocol:
`init` gains a reply mode (`rgba` for single-worker demos, `film` for
pools). First consumer: `viz-convergence`.

Node CLI + PNG: still deferred (unchanged from design-v1.md).

## Checkpoints

1. OBJ parser + TriangleMesh + BVH, brute-force equivalence tests, timing
   numbers, `cornell-teapot` in the registry, demos verified.
2. Worker pool + linear-speedup measurement in viz-convergence.

## Status

Checkpoint 1 ✅ shipped 2026-07-29: OBJ parser, TriangleMesh + binned-SAH
BVH (31 ms build for the 6320-tri teapot), brute-force equivalence on 3000
random rays, `cornell-teapot` scene, all demos scene-switchable. Measured:
~0.74 s/pass at 320² with the teapot vs ~0.51 s without (≈ +40%, far
under the 2–3× worst case). Checkpoint 2 (worker pool) pending.

Checkpoint 2 ✅ shipped 2026-07-29: sample-parallel WorkerPool
(`src/render/pool.ts`), `reply: 'film'` worker mode, viz-convergence on
pools with honest wall-clock labels. Measured: NEE 32 spp on
cornell-teapot in 10.2 s pooled (×3/pane) vs 23.6 s serial — ~2.3× with
both panes sharing cores. Final films bit-deterministic (ordered
summation); intermediate snapshots timing-dependent but statistically
equivalent. V1c complete; Node CLI remains deferred.

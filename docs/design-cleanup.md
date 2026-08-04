# design-cleanup — consolidation pass before the demo rebuild

**Status: Stages 0–4 SHIPPED (2026-08-04). Stages 5–6 remain proposed.**

Agreed and implemented in one sitting: F8 hygiene, F1 the shared direct-
lighting estimator, F3 scenes moved into `src/scenes/`, F2 the `Renderer`
interface, F4 the four demo-facing modules. Suite went 182 → 197 tests,
all green, with every pre-existing test unchanged. Stages 5 (F6/F7) and 6
(F5) were deliberately deferred — see §3 for why, and §7 for what shipping
these four turned up.

Scope: `src/` only. The demos are being fully redone, so this document
treats the existing `demos/` as *evidence* — the boilerplate every page
repeats tells us what the library failed to provide — and not as
something to preserve. Where a stage below changes an API, the count of
demo pages affected is given as information, not as a cost.

Baseline at the time of writing: `npm run typecheck` clean,
`npm run test` 31 files / 182 tests green in 25 s, `src/core/` verified
free of DOM and three.js imports.

---

## 1. What is already right — do not churn it

Worth stating plainly, because a cleanup pass invites rewriting things
that are working:

- **The interface layer is genuinely well designed.** `BxDF`
  (eval/sample/pdf split, delta-lobe pdf convention), `Shape` (with
  `dpdu`/`dndu` present from day one — which is what made V5 possible at
  all), `Sampler` (purity as the replay mechanism), `Recorder`, and
  `Integrator` are all small, documented, and load-bearing. None of them
  needs to change.
- **`src/core/` purity holds.** Verified: no `three`, no `document`, no
  `window`. This is the constraint the whole project rests on and it has
  not eroded.
- **MMLT is the model of how this codebase should reuse itself.**
  `core/integrators/mmlt.ts` is 112 lines because it calls BDPT's
  exported `cameraSubpathFromRaster` / `generateLightSubpath` /
  `connectStrategy` rather than restating them. Every finding in §2 is
  in some sense "why isn't this one more like mmlt.ts".
- **The timeline substrate is right.** `TimelineElement.drawAt(t)` as a
  pure function of time — so play, scrub, single-step and offline frame
  export are one operation — is the correct design and pays for itself
  in `recording.ts` being 68 lines.
- **The comments are an asset.** Many carry measurements and dates
  ("measured 2/719 integrator convergence WITH the guard", "cost 5% of
  wall brightness, caught by eye"). Refactors must carry these forward
  verbatim; they are the record of what was already tried.

The problem is not the design. It is that four algorithm stages (V2–V5b)
each landed beside the last rather than through it, and the seams never
got closed.

---

## 2. Findings

Ranked by risk × how much it obstructs the demo rebuild.

### F1 — The PT+NEE estimator exists in three places, and they have already drifted

The "loop over camera-walk vertices, add MIS-weighted emitter hits, add
MIS-weighted NEE connections" body is written out three times:

| Site | Lines | Notes |
|---|---|---|
| [pt-nee.ts:42-92](src/core/integrators/pt-nee.ts#L42-L92) | 51 | canonical |
| [pt-sms.ts:437-487](src/core/integrators/pt-sms.ts#L437-L487) | 51 | + SMS ownership guard |
| [restir-driver.ts:514-556](src/render/restir-driver.ts#L514-L556) | 43 | + two ReSTIR exceptions |

This has already cost something once. The comment at
[pt-sms.ts:478-480](src/core/integrators/pt-sms.ts#L478-L480) says so:

> Delta lights admit no competing BSDF strategy: weight 1 (mirrors
> pt-nee — forgetting this mirror cost 5% of wall brightness on delta
> scenes, caught by eye).

**And the third copy still has that bug.**
[restir-driver.ts:553](src/render/restir-driver.ts#L553) computes
`powerHeuristic(pLight, pBsdf)` unconditionally, where both other copies
guard with `selected.light.type === 'area' ? powerHeuristic(...) : 1`.
Under a delta light, ReSTIR's deeper-vertex NEE is therefore
under-weighted.

Honest caveat: this is **latent, not currently visible**. The only delta
scene in the registry is `cornell-delta`, and design-v5c restricts it to
`pt` / `pt-nee` / `pt-sms`; no shipped page runs ReSTIR against a point
light. But it is exactly the failure mode triplication produces, it was
found by reading rather than by a test, and there is no test that would
catch the next one.

The same three sites also repeat the five-line camera-sample preamble
(`nextPixel2D` → raster → `generateRay` → `cameraVertex` → `pdfWe` →
`randomWalk`), as do `pt.ts`, `pt-term.ts` and `bdpt.ts` — **six copies**.

### F2 — Three execution models with no shared abstraction, and the worker pays for it

`Integrator` + `renderPass` covers pt/pt-nee/pt-term/pt-sms/bdpt.
`MltRunner` and `RestirRunner` are drivers that do not implement it,
because MLT owns a bootstrap and ReSTIR owns per-pixel persistent state.
Both of those are legitimate reasons not to be an `Integrator`. Neither
is a reason to have no common type at all.

The cost is concentrated in [render/worker.ts](src/render/worker.ts),
which is 151 lines of nothing but this seam:

- a 15-line nested ternary (lines 80–95) to construct an integrator;
- a three-branch `if (mlt) / else if (restir) / else` to run a pass;
- `splatScale` special-cased per algorithm (lines 134–136);
- `flatErrorFrame` (lines 45–54), an MMLT-specific concession living in
  the transport layer;
- `mltB` threaded as an optional field through **both** reply messages
  in [protocol.ts](src/render/protocol.ts) and again through
  [pool.ts](src/render/pool.ts);
- `activeWorkers` in `PoolOptions`, which exists solely so ReSTIR can be
  forced onto one worker — enforced by a comment, not by a type.

What is missing is one interface:

```ts
interface Renderer {
  pass(sampleIndex: number, recorder?: Recorder): void;
  develop(passesDone: number): { rgba: Uint8ClampedArray; errorRgba: Uint8ClampedArray };
  readonly exchangeablePasses: boolean;  // false for restir — pool reads this
}
```

Three implementations (`IntegratorRenderer`, `MltRenderer`,
`RestirRenderer`), each owning its own `splatScale` and error-view
policy. `worker.ts` drops to ~40 lines, `protocol.ts` loses `mltB`
entirely, and the pool stops needing a hand-set `activeWorkers`.

This is the single biggest ergonomics win for the rebuild, because every
render-bearing demo talks to this protocol.

### F3 — The scene registry lives in `demos/` but the library depends on it

[demos/_shared/scenes.ts](demos/_shared/scenes.ts) is 312 lines and holds
every named scene, the three.js vantage points, `emissiveNames`, and the
OBJ fitting. It is imported by `tests/mesh.test.ts`,
`tests/lamp-scene.test.ts` and `tests/restir.test.ts` — so `tests/`
depends on `demos/`, which is backwards.

It also does `import teapotUrl from './models/teapot.obj?url'`, a
Vite-only feature, which drags a bundler dependency into anything that
touches the registry.

Scenes are library content. They belong in `src/scenes/`.

### F4 — Demo-facing conveniences the library never grew

Counted across the current 22 pages. This is the direct measure of what
the rebuild will re-suffer if nothing changes:

| Repeated by hand | Pages | Approx. lines each |
|---|---|---|
| `WebGLRenderer` + `PerspectiveCamera` + `OrbitControls` + background + `PathStyle` resolution | 13 | ~35 |
| `setAnimationLoop` with the replay/hold loop | 13 | ~15 |
| The trace-one-path dance (`startPixelSample` / `new ArrayRecorder` / `beginPath` / `sampleContributions` / `endPath` / `records[0]!`) | 10 | ~8 |
| Raw `new Worker` + `postMessage` + `onmessage` + schedule-next-pass | 8 | ~15 |

That is roughly 900 lines of boilerplate across the demo set, and it is
the reason a "one figure" page like
[path-strategies/main.ts](demos/path-strategies/main.ts) is 248 lines
when its actual figure spec is about 30.

Three small modules absorb nearly all of it — see Stage 4.

### F5 — Two independent derivations of the same manifold derivatives

[constraints.ts](src/core/manifold/constraints.ts) has
`computeStepHalfvector` / `computeStepAnglediff` (single vertex, fixed
endpoints). [chain.ts](src/core/manifold/chain.ts) has
`halfvectorBlocks` / `anglediffBlocks` (per vertex in a chain). The m = 1
chain case, with `dPrev` and `dNext` null, **is** the single-vertex case.

That is ~250 lines of the hardest and most numerically delicate math in
the repo, derived twice, independently. They differ in incidental ways
(constraints.ts works in the vertex's orthonormal `s`/`t` frame and
carries the `nOffset` rough-caster hook; chain.ts projects raw
`dpdu`/`dpdv`), which is exactly what makes merging them real work rather
than a textual dedup.

`chain.ts` header already acknowledges the situation: *"The single-bounce
module (newton.ts) stays untouched beside this one."* That was the right
call under V5b's schedule. It is worth revisiting now, but carefully —
see Stage 6, which is explicitly optional.

### F6 — The SMS estimator ladder is written twice inside one function

`smsConnect` runs the {deterministic | biasedM | unbiased} ladder for the
m = 1 family at [pt-sms.ts:257-306](src/core/integrators/pt-sms.ts#L257-L306),
then runs the same ladder again for chains at
[pt-sms.ts:370-409](src/core/integrators/pt-sms.ts#L370-L409). Same
control flow, same dedup-by-`sameSolution`, same Booth geometric
estimator, same `maxTrials` cap — differing only in which sampler and
which contribution function it calls.

It is already 90% parameterized: both halves are built from a
`sample*() → root | null` closure and a `*Contribution(root) → Color |
null` closure. Lifting `estimate(sampleFn, contributionFn, options)` out
turns ~80 lines into ~30 and means the next estimator variant is written
once.

### F7 — `pt-sms.ts` dispatches on `instanceof` across the geometry and material layers

`eligibleCasters`, `shapeCenter` and the light branch of `smsConnect`
switch on `Sphere`, `Quad`, `TriangleMesh`, `AreaLight`, `PointLight`
directly, and `asCasterBxDF` duck-types a material capability by probing
for property names.

The practical consequence: **adding a shape or a light means editing an
integrator.** The recorded V5 follow-up "mesh casters" is precisely a
change that would have to be made here rather than in `geometry/`.

Two small interface additions retire all of it:
- `Shape.centroid(): Vec3` and `Shape.smooth: boolean` (a mesh reports
  `false`; the caster-eligibility predicate reads that instead of
  `instanceof TriangleMesh`);
- an optional `manifold?: { eta: number; chainThroughput(cos, mode): Color }`
  member on `BxDF`, replacing the structural probe.

### F8 — Naming and constant hygiene

Small, safe, and worth doing first because they make the later diffs
readable:

- **`DEFAULT_WALK_OPTIONS` is exported from two modules** —
  [integrators/walk.ts:29](src/core/integrators/walk.ts#L29) and
  [manifold/newton.ts:36](src/core/manifold/newton.ts#L36) — with
  unrelated meanings. `pt-sms.ts` imports both areas and has to keep them
  straight by hand. Rename the manifold one to
  `DEFAULT_MANIFOLD_WALK_OPTIONS`.
- **`MIN_EDGE_LENGTH = 1e-3` is declared three times** (constraints.ts,
  chain.ts, and again inside chain.ts's `edgeBlocked`). One exported
  constant.
- **The luminance coefficients are inlined in five places in `src/`**
  (film.ts twice, path-schedule.ts, sample-flip.ts) plus four demos,
  while `Color.luminance()` already exists. Export a
  `luminanceOf(r, g, b)` and use it everywhere; the `Tuple3` call sites
  cannot use the `Color` method.

---

## 3. Proposed staging

Each stage is independently shippable and ends green
(`npm run typecheck && npm run test`). The file list per stage is the
exact boundary — no extras.

### Stage 0 — hygiene (F8) · ~1 hour · very low risk

Rename `DEFAULT_WALK_OPTIONS` in the manifold module; hoist
`MIN_EDGE_LENGTH`; add and adopt `luminanceOf`.

*Touches:* `core/manifold/newton.ts`, `core/manifold/constraints.ts`,
`core/manifold/chain.ts`, `core/integrators/pt-sms.ts`,
`core/math/color.ts`, `render/film.ts`, `viz/path-schedule.ts`,
`viz/sample-flip.ts`.

*Verifies by:* existing suite, unchanged.

### Stage 1 — one NEE estimator (F1) · ~half a day · **highest value**

Extract two pure functions into `core/integrators/estimators.ts`:

```ts
// The camera-sample preamble, once.
export function cameraWalk(scene, pixel, sampler, recorder, options):
  { raster: Sample2D; vertices: PathVertex[] };

// One vertex's direct-lighting contribution — both strategies, MIS-weighted.
// Callers pass policy rather than re-deriving the estimator:
export function directLighting(scene, vertices, k, recorder, policy: {
  skipEmitterHit?: (k: number) => boolean;   // SMS ownership / ReSTIR's k===2
  skipNEE?: (k: number) => boolean;          // ReSTIR's primary vertex
}): Color;
```

Then `pt-nee.ts` becomes ~25 lines, `pt-sms.ts` loses branches (a)/(b),
and `restir-driver.walkContribution` loses its whole loop body — **and
picks up the delta-light guard it is currently missing**, closing F1's
live divergence.

*Touches:* new `core/integrators/estimators.ts`;
`core/integrators/pt.ts`, `pt-nee.ts`, `pt-term.ts`, `pt-sms.ts`,
`bdpt.ts` (preamble only); `render/restir-driver.ts`.

*Verifies by:* existing suite must pass **unchanged and bit-identical** —
this stage is required to be behaviour-preserving except for the ReSTIR
delta fix. Add one new test: `pt-nee` and ReSTIR agree on a point-light
scene, which is the test that would have caught F1.

### Stage 2 — scenes become library content (F3) · ~1 hour · low risk

Move `demos/_shared/scenes.ts` → `src/scenes/registry.ts` and
`demos/_shared/cornell.ts` → `src/scenes/cornell.ts`. Split the
asset-loading path (`loadSceneRegistry`, the `?url` import) into
`src/scenes/assets.ts` so the synchronous registry is importable from
Node with no bundler involvement. Move `vizViewFor` to `src/viz/views.ts`
— it is a three.js concern, not a scene one.

*Touches:* the two moved files, `src/viz/views.ts` (new), the three
importing tests, and the import lines in existing demos (mechanical).

*Verifies by:* existing suite; the three affected tests should get
*simpler*, not just relocated.

### Stage 3 — one `Renderer` interface (F2) · ~1 day · **biggest demo-facing win**

Introduce `render/renderer.ts` with the interface from §F2 and three
implementations wrapping the existing `renderPass` / `MltRunner` /
`RestirRunner` (which stay as they are — this is a facade, not a rewrite
of the algorithms). Collapse `worker.ts` onto it; drop `mltB` from
`protocol.ts`; let `pool.ts` read `exchangeablePasses` instead of taking
`activeWorkers` on faith.

*Touches:* new `render/renderer.ts`; `render/worker.ts`,
`render/protocol.ts`, `render/pool.ts`. `driver.ts`, `mlt-driver.ts` and
`restir-driver.ts` gain a wrapper each and are otherwise untouched.

*Verifies by:* existing suite, plus a new test that each renderer
produces the same film through the facade as through its driver directly.

*Open question for Steve:* should `develop` stay in the worker (current
behaviour, `reply: 'rgba'`) or always return raw film with the caller
developing (`reply: 'film'`, what the pool already does)? Keeping both
modes is what makes `worker.ts` branch twice. My recommendation: keep
both — the single-worker `rgba` path is what makes a one-canvas demo a
five-line call — but move the choice into the `Renderer`, not the
message handler.

### Stage 4 — the three missing demo modules (F4) · ~1 day

Written against the rebuild, not the current pages:

- **`viz/stage.ts`** — `createStage({ container, scene, view, size })`
  returns `{ renderer, camera, scene, style, group, onFrame(cb) }` with
  orbit, background, device-pixel-ratio resolution, resize and the
  animation loop handled. Replaces ~35 lines × 13 pages.
- **`viz/replay-loop.ts`** — the play → hold → replay clock currently
  copy-pasted into 13 `setAnimationLoop` blocks, as a timeline option.
- **`trace/replay.ts`** — `tracePath(scene, integrator, pixel, sample)`
  → `PathRecord`, and `tracePaths(...)` → `PathRecord[]` for the swarm
  pages. Replaces the 10 hand-rolled recorder dances.
- **`render/session.ts`** — `renderTo(canvas, { scene, integrator, spp })`
  returning a small handle (`{ spp, msPerPass, stop() }`). Replaces the
  8 hand-rolled worker loops; built on Stage 3.

*Touches:* four new files under `src/viz/` and `src/render/` plus
`src/trace/replay.ts`. No existing demo is migrated in this stage — they
are being replaced anyway.

*Verifies by:* new unit tests for `tracePath` determinism and the replay
clock; the stage/session modules are DOM-bound and get exercised by the
first rebuilt demo.

### Stage 5 — SMS estimator ladder + interface-based dispatch (F6, F7) · ~half a day

Lift `estimate(sampleFn, contributionFn, options)` out of `smsConnect`.
Add `Shape.centroid()` / `Shape.smooth` and `BxDF.manifold?`, and delete
the `instanceof` chains and `asCasterBxDF`.

*Touches:* `core/integrators/pt-sms.ts`, `core/geometry/shape.ts`,
`sphere.ts`, `quad.ts`, `triangle-mesh.ts`, `core/materials/bsdf.ts`,
`dielectric.ts`, `conductor.ts`.

*Verifies by:* `tests/sms.test.ts` and `tests/manifold-chain.test.ts`
unchanged. This stage also removes the blocker in front of the recorded
"mesh casters" follow-up.

### Stage 6 — unify the manifold derivatives (F5) · 2+ days · **optional, decide separately**

Make `chain.ts`'s per-vertex blocks the single source of truth and
express the single-bounce walk as the m = 1 case, keeping `newton.ts`'s
distinct beta schedule and aggregate-based re-projection (both are
deliberate and measured — see the comments at
[chain.ts:355-359](src/core/manifold/chain.ts#L355-L359) and
[chain.ts:412-417](src/core/manifold/chain.ts#L412-L417)).

I am flagging this as **optional and lowest priority** despite being the
largest duplication. Reasons: the existing FD tests
(`manifold-derivatives`, `manifold-newton`, `manifold-chain`, 839 lines
between them) pin both copies, so the drift risk that makes F1 urgent is
largely already covered here; V5 is shipped and not under active
development; and the `nOffset` rough-caster hook in `constraints.ts` is a
deliberate forward-looking asymmetry that a merge would have to preserve
or discard. If rough casters get picked up as the next feature, do this
stage first as part of that work. Otherwise leave it.

---

## 4. Explicitly out of scope

- **`Vec3`/`Color` allocation.** Every operation allocates. This is
  visible in the SMS hot loop. It is *not* being addressed: the
  immutable-by-convention style is what makes the transport code
  readable, readability is the point of this repo, and the fix (scratch
  vectors threaded through signatures) would undo that for a renderer
  that is fast enough for its purpose. If a specific figure ever becomes
  unwatchable, profile that figure then.
- **Spectral rendering, new integrators, new materials.** Not cleanup.
- **The demos themselves.** Being replaced.
- **`bdpt.ts`'s `assertWeightSum`** (lines 369–462). It is a large debug
  function inside a production file and it looks like a refactor target,
  but it is deliberately an *independent* re-derivation of the density
  table — its value is precisely that it shares no code with the
  production path. Leave it.

---

## 5. Summary

| Stage | Finding | Status |
|---|---|---|
| 0 | F8 hygiene | **shipped** |
| 1 | F1 one NEE estimator | **shipped** |
| 2 | F3 scenes to `src/` | **shipped** |
| 3 | F2 one `Renderer` | **shipped** |
| 4 | F4 demo modules | **shipped** |
| 5 | F6/F7 SMS + dispatch | deferred |
| 6 | F5 manifold merge | deferred |

Stages 5 and 6 are worth doing when their neighbouring features (mesh
casters, rough casters) come up, and not before.

## 6. Resolved questions

1. **Stage 3's develop side.** Both reply modes kept, with the choice
   moved into the renderer as recommended: `Renderer.develop(totalPasses)`
   for the single-worker `rgba` path, and `developFilm(name, film, …)`
   exported for the pool-merged case. `mltB` is gone; the generic
   `splatNorm` (defined so `splatScale = splatNorm / totalPasses`) replaced
   it, and `PoolUpdate.frame()` means callers never branch on the
   algorithm.
2. **`render/session.ts`** was built, on the assumption stated. Still
   worth confirming against the first rebuilt page — if the new figures
   want the pool everywhere instead, this module is ~120 lines to drop.
3. **Stage 1's `policy` shape** shipped as the two optional predicates.
   No AOV sink was added; if the rebuilt figures want per-strategy AOVs
   out of `pt-nee`, that is the moment to grow the signature.

## 7. What shipping stages 0–4 turned up

- **ReSTIR has no delta-light support at all**, quite apart from the MIS
  guard F1 was about. `PointLight.le()` returns black by construction (a
  delta light is never *hit*), so the reservoir's target function is zero
  for a point light and the whole direct-at-primary term vanishes —
  while `shade` still skips the k = 1 NEE that would have covered it.
  Measured on a point-lit box, 64 passes: ReSTIR lands at **42%** of
  pt-nee's mean.

  This is pre-existing and out of the cleanup's scope — design-v4 never
  claimed delta support and design-v5c scopes delta scenes to
  pt / pt-nee / pt-sms — but it is worth a decision. Either the reservoir
  path learns about delta lights, or `RestirRunner` should refuse a scene
  containing one rather than silently darkening it. **Not fixed; flagged.**

  It also means the test Stage 1 promised ("pt-nee and ReSTIR agree on a
  point-light scene") cannot pass for reasons unrelated to F1. What
  shipped instead is `tests/delta-light-mis.test.ts`, which pins the
  actual invariant that drifted — delta-light NEE is weighted 1, with a
  discriminating assertion against the damped value — plus a bit-identity
  check between pt-nee and pt-sms on a delta scene, which holds only
  while both really do go through the one shared estimator.

- **MMLT's splat normalization was slightly wrong in the pool path.**
  The worker used `b·nPixels / (passes · chainsPerBatch ·
  mutationsPerChain)`, but `WorkerPool` callers used `mltB / totalSpp`,
  which ignores that a batch overshoots `nPixels` a little. Unifying on
  `splatNorm` made the precise form the only one. The effect is small and
  the direction was a slight over-brightening of pooled MMLT images.

- **`src/core/manifold/chain.ts` imports `offsetRayOrigin` and never uses
  it** (pre-existing, found by a one-off `--noUnusedLocals` pass). Left
  alone: outside the agreed file list, and the project does not enable
  that flag. Same for four unused private fields in `viz/path-elements.ts`.

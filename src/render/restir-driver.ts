// ReSTIR frame driver (design-v4; mechanics in restir-notes.md). Unlike the
// per-pixel integrators, ReSTIR needs per-pixel PERSISTENT state (each
// pixel's reservoir survives across passes) and whole-frame stages — so,
// like MLT, it gets a driver beside renderPass rather than an Integrator.
//
// One pass (= one "frame"; static scene, identity motion):
//   1. primary trace — jittered raster, first hit, G-data cached;
//   2. initial candidates — M light samples (PowerLightSampler), RIS with
//      m = 1/M into a fresh reservoir; target p̂ = luminance of
//      f_s·G·V·L_e (visibility included per design decision 3, toggleable);
//   3. temporal merge — pairwise MIS against the PREVIOUS pass's reservoir,
//      evaluated against the previous pass's stored primary hit (static
//      scene: same geometry, exact p̂_prev, no approximation);
//   4. spatial rounds — K rounds of N disk neighbors (normal/depth gated,
//      never sample-gated), pairwise MIS with the current pixel canonical;
//      double-buffered so rounds are order-independent;
//   5. shade — the reservoir owns DIRECT LIGHTING AT THE PRIMARY VERTEX;
//      the ordinary NEE walk continues from the same primary hit for all
//      indirect transport and deeper-vertex direct lighting (design
//      decision 4: bounce-2 emitter hits contribute zero direct at
//      non-delta primaries; delta primaries skip the reservoir and keep
//      the standard specular machinery end to end).
//
// Determinism: all randomness flows through the Sampler with per-stage
// dimension bases under one (pixel, pass) key — the reservoir buffer after
// pass k is a pure function of (seed, k); replay = re-run passes 0..k.
import { Color } from '../core/math/color';
import { Vec3, absDot } from '../core/math/vec3';
import type { Sample2D } from '../core/math/sampling';
import { concentricSampleDisk } from '../core/math/sampling';
import { solidAngleToArea } from '../core/geometry/measure';
import { occlusionPoint } from '../core/geometry/visibility';
import { SurfaceBSDF } from '../core/materials/surface';
import { TransportMode, hasNonSpecular } from '../core/materials/bsdf';
import type { Scene, ScenePrimitive } from '../core/scene/scene';
import type { Light } from '../core/lights/light';
import { PowerLightSampler } from '../core/lights/power';
import { IndependentSampler } from '../core/sampler/independent';
import { pixelSeedKey } from '../core/sampler/sampler';
import { directLighting, walkFromCamera } from '../core/integrators/estimators';
import { Reservoir } from '../core/restir/reservoir';
import { misWeightSum, pairwiseMisWeight, type MisKind } from '../core/restir/mis';
import { NULL_RECORDER, type Recorder } from '../trace/recorder';
import type { Film } from './film';

export interface RestirOptions {
  candidates: number; // M initial light samples per pixel
  spatialRounds: number; // K
  spatialNeighbors: number; // N per round
  spatialRadiusPx: number;
  // Confidence cap as a MULTIPLE of the per-pass aggregation M (Bitterli
  // 2020's "clamp history to 20×"; the course's c_cap in fresh-sample
  // units). History never outweighs ~capFactor passes of fresh candidates.
  confidenceCapFactor: number;
  mis: MisKind; // 'pairwise' (default) | 'balance' | 'oneOverM' (biased toggle)
  pHatVisibility: boolean; // visibility inside the target function (Tip 4.3)
  temporal: boolean;
  // Neighbor similarity gates (G-data only — never reservoir contents).
  normalDotMin: number;
  depthRelMax: number;
  // The surrounding path tracer (full transport unless directOnly).
  maxBounces: number;
  rrStartDepth: number;
  directOnly: boolean; // test/figure mode: reservoir term only, no walk
  assertWeights: boolean; // Σm = 1 at every merge (tests; O(N²) p̂ evals)
  seed: number;
}

// Defaults tuned by the checkpoint-2 equal-time sweep (2026-07-31, 64²
// chandelier): unshadowed p̂ with M = 8 beat the design draft's shadowed
// M = 32 by 2.5× at equal wall time (candidate shadow rays dominated the
// pass cost); shading still traces the deferred visibility ray, so the
// estimator stays exact — only the TARGET got cheaper. pHatVisibility: true
// remains the quality toggle (better limit distribution, pricier passes).
export const DEFAULT_RESTIR_OPTIONS: RestirOptions = {
  candidates: 8,
  spatialRounds: 2,
  spatialNeighbors: 5,
  spatialRadiusPx: 10,
  confidenceCapFactor: 20,
  mis: 'pairwise',
  pHatVisibility: false,
  temporal: true,
  normalDotMin: 0.9,
  depthRelMax: 0.1,
  maxBounces: 32,
  rrStartDepth: 3,
  directOnly: false,
  assertWeights: false,
  seed: 0,
};

// Per-stage dimension bases under one (pixel, pass) seed key — stages are
// independently replayable and cannot bleed into each other (65536 budget).
const DIM_PRIMARY = 0;
const DIM_CANDIDATES = 4096;
const DIM_TEMPORAL = 8192;
const DIM_SPATIAL = 16384; // + round * 2048
const DIM_SHADE = 32768;

// The reservoir sample: a light vertex in world space (identity shift,
// Jacobian 1 — restir-notes §Reuse across domains).
export interface LightVertexSample {
  p: Vec3;
  ng: Vec3;
  light: Light;
}

export interface PixelReservoir {
  y: LightVertexSample | null;
  W: number;
  confidence: number;
  pHatY: number; // this pixel's target at y (cached for MIS reuse)
  source: 'none' | 'fresh' | 'temporal' | 'spatial';
  from: readonly [number, number] | null;
}

interface PrimaryHit {
  p: Vec3;
  ng: Vec3;
  ns: Vec3;
  wo: Vec3;
  depth: number;
  bsdf: SurfaceBSDF;
  primitive: ScenePrimitive;
  delta: boolean; // no non-specular lobe: reservoir does not apply
  raster: Sample2D;
}

const EMPTY_RESERVOIR: PixelReservoir = {
  y: null, W: 0, confidence: 0, pHatY: 0, source: 'none', from: null,
};

export class RestirRunner {
  readonly options: RestirOptions;
  private readonly sampler: IndependentSampler;
  private readonly lightSampler: PowerLightSampler;
  private readonly width: number;
  private readonly height: number;
  private hits: (PrimaryHit | null)[];
  private prevHits: (PrimaryHit | null)[];
  reservoirs: PixelReservoir[]; // exposed for tests and the flow visualizer
  private prevReservoirs: PixelReservoir[];
  private scratch: PixelReservoir[]; // spatial double buffer
  passesDone = 0;

  constructor(
    private readonly scene: Scene,
    private readonly film: Film,
    options: Partial<RestirOptions> = {},
  ) {
    this.options = { ...DEFAULT_RESTIR_OPTIONS, ...options };
    this.sampler = new IndependentSampler(this.options.seed);
    this.lightSampler = new PowerLightSampler(scene.lights);
    this.width = film.width;
    this.height = film.height;
    const n = this.width * this.height;
    this.hits = new Array(n).fill(null);
    this.prevHits = new Array(n).fill(null);
    this.reservoirs = new Array(n).fill(EMPTY_RESERVOIR);
    this.prevReservoirs = new Array(n).fill(EMPTY_RESERVOIR);
    this.scratch = new Array(n).fill(EMPTY_RESERVOIR);
  }

  // Colored direct-lighting integrand at `hit` for light vertex `s`, in
  // AREA measure: f_s · G · L_e (· V when withVisibility). The target
  // function p̂ is this quantity's luminance; shading reuses the color.
  private directContribution(hit: PrimaryHit, s: LightVertexSample, withVisibility: boolean): Color {
    const d = s.p.sub(hit.p);
    const distSq = d.lengthSq();
    if (distSq === 0) return Color.BLACK;
    const wi = d.scale(1 / Math.sqrt(distSq));
    const f = hit.bsdf.eval(hit.wo, wi, TransportMode.Radiance);
    if (f.isBlack()) return Color.BLACK;
    const Le = s.light.le(s.p, s.ng, [0, 0], wi.neg());
    if (Le.isBlack()) return Color.BLACK;
    // G with the receiver's shading normal and the light's geometric normal
    // (contribution-side cosines, house convention).
    const G = (absDot(wi, hit.ns) * absDot(wi, s.ng)) / distSq;
    if (withVisibility) {
      const blocked = occlusionPoint(
        this.scene.aggregate, { p: hit.p, ng: hit.ng }, { p: s.p, ng: s.ng },
      );
      if (blocked !== null) return Color.BLACK;
    }
    return f.mul(Le).scale(G);
  }

  private pHat(hit: PrimaryHit | null, s: LightVertexSample | null): number {
    if (!hit || !s || hit.delta) return 0;
    return this.directContribution(hit, s, this.options.pHatVisibility).luminance();
  }

  private confidenceCap(): number {
    return this.options.confidenceCapFactor * this.options.candidates;
  }

  // ---- Stage 1: primary hits ----
  private tracePrimaries(pass: number): void {
    const swap = this.prevHits;
    this.prevHits = this.hits;
    this.hits = swap;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        this.sampler.startPixelSample(pixelSeedKey(x, y, pass), DIM_PRIMARY);
        const u = this.sampler.nextPixel2D();
        const raster: Sample2D = [x + u[0], y + u[1]];
        const ray = this.scene.camera.generateRay(raster);
        const isect = this.scene.aggregate.intersect(ray);
        if (!isect) {
          this.hits[y * this.width + x] = null;
          continue;
        }
        const primitive = isect.primitive as ScenePrimitive;
        const bsdf = new SurfaceBSDF(primitive.bxdf, isect.ns, isect.ng);
        this.hits[y * this.width + x] = {
          p: isect.p,
          ng: isect.ng,
          ns: isect.ns,
          wo: ray.d.neg(),
          depth: isect.t,
          bsdf,
          primitive,
          delta: !hasNonSpecular(primitive.bxdf.flags),
          raster,
        };
      }
    }
  }

  // ---- Stage 2: initial candidates ----
  private initialCandidates(pass: number): void {
    const M = this.options.candidates;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        const hit = this.hits[i]!;
        if (!hit || hit.delta) {
          this.reservoirs[i] = EMPTY_RESERVOIR;
          continue;
        }
        this.sampler.startPixelSample(pixelSeedKey(x, y, pass), DIM_CANDIDATES);
        const res = new Reservoir<LightVertexSample>();
        let winnerPHat = 0;
        for (let c = 0; c < M; c++) {
          const uSelect = this.sampler.next1D();
          const uPoint = this.sampler.next2D();
          const uWrs = this.sampler.next1D();
          const selected = this.lightSampler.sample(uSelect);
          const li = selected
            ? selected.light.sampleLi({ p: hit.p, ng: hit.ng, ns: hit.ns }, uPoint)
            : null;
          if (!selected || !li) {
            res.update(null, 0, 1, uWrs);
            continue;
          }
          const sample: LightVertexSample = { p: li.pLight.p, ng: li.pLight.ng, light: selected.light };
          const pdfArea =
            selected.pmf * solidAngleToArea(li.pdf, hit.p, li.pLight.p, li.pLight.ng);
          const ph = this.pHat(hit, sample);
          const w = pdfArea > 0 ? ((1 / M) * ph) / pdfArea : 0;
          const before = res.y;
          res.update(sample, w, 1, uWrs);
          if (res.y !== before) winnerPHat = ph;
        }
        res.finalize(winnerPHat, this.confidenceCap());
        this.reservoirs[i] = {
          y: res.y, W: res.W, confidence: res.confidence, pHatY: winnerPHat,
          source: res.y ? 'fresh' : 'none', from: null,
        };
      }
    }
  }

  // ---- Stage 3: temporal merge (previous pass, static scene) ----
  private temporalMerge(pass: number): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        const hit = this.hits[i];
        const cur = this.reservoirs[i]!;
        const prev = this.prevReservoirs[i]!;
        const prevHit = this.prevHits[i] ?? null;
        if (!hit || hit.delta) continue;
        if (prev.confidence === 0) continue;

        this.sampler.startPixelSample(pixelSeedKey(x, y, pass), DIM_TEMPORAL);
        // Technique targets: [0] = this pass (canonical), [1] = previous
        // pass — p̂_prev evaluated against the STORED previous primary hit.
        const confidences = [Math.max(cur.confidence, 1), prev.confidence];
        const pPrevAtCur = cur.y ? this.pHat(prevHit, cur.y) : 0;
        const pNowAtPrev = prev.y ? this.pHat(hit, prev.y) : 0;
        const merged = new Reservoir<LightVertexSample>();
        let winnerPHat = 0;
        let winnerFrom: PixelReservoir['source'] = 'none';

        const candidates: Array<{ r: PixelReservoir; pNowAtY: number; pHatAtY: number[]; tag: PixelReservoir['source'] }> = [
          { r: cur, pNowAtY: cur.pHatY, pHatAtY: [cur.pHatY, pPrevAtCur], tag: cur.source },
          { r: prev, pNowAtY: pNowAtPrev, pHatAtY: [pNowAtPrev, prev.pHatY], tag: 'temporal' },
        ];
        candidates.forEach((cand, idx) => {
          const uWrs = this.sampler.next1D();
          if (!cand.r.y) {
            merged.update(null, 0, cand.r.confidence, uWrs);
            return;
          }
          const m = pairwiseMisWeight(cand.pHatAtY, confidences, 0, idx);
          const w = m * cand.pNowAtY * cand.r.W;
          const before = merged.y;
          merged.update(cand.r.y, w, cand.r.confidence, uWrs);
          if (merged.y !== before) {
            winnerPHat = cand.pNowAtY;
            winnerFrom = cand.tag;
          }
          if (this.options.assertWeights) {
            const sum = misWeightSum('pairwise', cand.pHatAtY, confidences, 0);
            if (cand.pHatAtY[0]! > 0 && Math.abs(sum - 1) > 1e-9) {
              throw new Error(`restir temporal MIS weight sum ${sum} at (${x}, ${y})`);
            }
          }
        });
        merged.finalize(winnerPHat, this.confidenceCap());
        this.reservoirs[i] = {
          y: merged.y, W: merged.W, confidence: merged.confidence, pHatY: winnerPHat,
          source: merged.y ? winnerFrom : 'none', from: null,
        };
      }
    }
  }

  // ---- Stage 4: spatial rounds (double-buffered) ----
  private spatialRound(pass: number, round: number): void {
    const src = this.reservoirs;
    const dst = this.scratch;
    const radius = this.options.spatialRadiusPx;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        const hit = this.hits[i];
        const self = src[i]!;
        if (!hit || hit.delta) {
          dst[i] = self;
          continue;
        }
        this.sampler.startPixelSample(pixelSeedKey(x, y, pass), DIM_SPATIAL + round * 2048);
        // Gather gated neighbors (G-data similarity only — Tip 4.1).
        const neighbors: number[] = [];
        for (let n = 0; n < this.options.spatialNeighbors; n++) {
          const u = this.sampler.next2D();
          const [dx, dy] = concentricSampleDisk(u);
          const nx = x + Math.round(dx * radius);
          const ny = y + Math.round(dy * radius);
          if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) continue;
          if (nx === x && ny === y) continue;
          const nHit = this.hits[ny * this.width + nx];
          if (!nHit || nHit.delta) continue;
          if (nHit.ns.dot(hit.ns) < this.options.normalDotMin) continue;
          if (Math.abs(nHit.depth - hit.depth) > this.options.depthRelMax * hit.depth) continue;
          neighbors.push(ny * this.width + nx);
        }

        // Candidate set: self (canonical, index 0) + neighbors. Pairwise MIS
        // needs, per candidate y: the canonical target at y, and (for the
        // canonical's own weight) every neighbor's target at the canonical y.
        const confidences = [Math.max(self.confidence, 1)];
        for (const n of neighbors) confidences.push(src[n]!.confidence);
        const nCand = 1 + neighbors.length;

        const merged = new Reservoir<LightVertexSample>();
        let winnerPHat = 0;
        let winnerSource: PixelReservoir['source'] = self.source;
        let winnerFrom: readonly [number, number] | null = self.from;

        // Canonical candidate. Its pairwise weight needs p̂_j(y_self) for
        // every neighbor technique j.
        {
          const uWrs = this.sampler.next1D();
          if (self.y) {
            const pHatAtY = new Array<number>(nCand).fill(0);
            pHatAtY[0] = self.pHatY;
            neighbors.forEach((n, k) => {
              pHatAtY[k + 1] = this.pHat(this.hits[n] ?? null, self.y);
            });
            const m = this.spatialMisWeight(pHatAtY, confidences, 0);
            merged.update(self.y, m * self.pHatY * self.W, self.confidence, uWrs);
            if (merged.y === self.y) winnerPHat = self.pHatY;
            if (this.options.assertWeights) this.assertSpatialSum(pHatAtY, confidences, x, y);
          } else {
            merged.update(null, 0, self.confidence, uWrs);
          }
        }
        // Neighbor candidates: pairwise weight needs only own target at own
        // y (stored) and the canonical target at that y (one evaluation).
        neighbors.forEach((n, k) => {
          const uWrs = this.sampler.next1D();
          const nr = src[n]!;
          if (!nr.y) {
            merged.update(null, 0, nr.confidence, uWrs);
            return;
          }
          const pMeAtY = this.pHat(hit, nr.y);
          const pHatAtY = new Array<number>(nCand).fill(0);
          pHatAtY[0] = pMeAtY;
          pHatAtY[k + 1] = nr.pHatY;
          if (this.options.assertWeights) {
            // The full Σm check needs every technique's target at this y.
            neighbors.forEach((n2, k2) => {
              if (k2 !== k) pHatAtY[k2 + 1] = this.pHat(this.hits[n2] ?? null, nr.y);
            });
            this.assertSpatialSum(pHatAtY, confidences, x, y);
          }
          const m = this.spatialMisWeight(pHatAtY, confidences, k + 1);
          const before = merged.y;
          merged.update(nr.y, m * pMeAtY * nr.W, nr.confidence, uWrs);
          if (merged.y !== before) {
            winnerPHat = pMeAtY;
            winnerSource = 'spatial';
            winnerFrom = [n % this.width, Math.floor(n / this.width)];
          }
        });

        merged.finalize(winnerPHat, this.confidenceCap());
        dst[i] = {
          y: merged.y, W: merged.W, confidence: merged.confidence, pHatY: winnerPHat,
          source: merged.y ? winnerSource : 'none', from: merged.y ? winnerFrom : null,
        };
      }
    }
    this.scratch = src;
    this.reservoirs = dst;
  }

  private spatialMisWeight(pHatAtY: number[], confidences: number[], i: number): number {
    if (this.options.mis === 'oneOverM') return pHatAtY[i]! > 0 ? 1 / pHatAtY.length : 0;
    // Full balance would need every technique's target at every candidate y
    // (O(N²) shadow rays per pixel); pairwise is the production choice
    // (course §7.1.3), so 'balance' resolves to pairwise here — the exact
    // balance heuristic lives in core/restir/mis for the statistical tests.
    return pairwiseMisWeight(pHatAtY, confidences, 0, i);
  }

  private assertSpatialSum(pHatAtY: number[], confidences: number[], x: number, y: number): void {
    if (pHatAtY[0]! <= 0) return; // canonical does not cover this y
    const sum = misWeightSum('pairwise', pHatAtY, confidences, 0);
    if (Math.abs(sum - 1) > 1e-9) {
      throw new Error(`restir spatial MIS weight sum ${sum} at (${x}, ${y})`);
    }
  }

  // ---- Stage 5: shade + continue the walk ----
  private shade(pass: number, recorder: Recorder): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        const hit = this.hits[i];
        const key = pixelSeedKey(x, y, pass);
        recorder.beginPath(key);
        if (!hit) {
          recorder.endPath();
          this.film.addSample([x + 0.5, y + 0.5], Color.BLACK);
          continue;
        }
        let L = Color.BLACK;

        // Reservoir-owned direct lighting at the (non-delta) primary vertex.
        const res = this.reservoirs[i]!;
        if (!hit.delta && res.y && res.W > 0) {
          // With visibility inside p̂, a selected sample is already proven
          // visible (its p̂ would be 0 otherwise); without it, shading must
          // trace the deferred shadow ray now.
          const C = this.directContribution(hit, res.y, !this.options.pHatVisibility);
          L = L.add(C.scale(res.W));
        }
        recorder.reuse({
          x, y, pass,
          lightP: res.y ? res.y.p : null,
          source: res.source,
          from: res.from,
        });

        if (!this.options.directOnly) {
          L = L.add(this.walkContribution(hit, key, recorder));
        }

        recorder.contribution({ kind: 'sample', raster: hit.raster, value: L });
        recorder.endPath();
        this.film.addSample(hit.raster, L);
      }
    }
  }

  // The surrounding path tracer: pt-nee's estimator with two exceptions at
  // a NON-DELTA primary vertex (design-v4 decision 4) — its NEE is skipped
  // (the reservoir owns it) and the bounce-2 emitter hit contributes zero
  // (that is the same direct integral by BSDF sampling; MIS against the
  // reservoir's intractable pdf is impossible, and light-sample coverage of
  // area lights makes dropping the strategy unbiased). Delta primaries take
  // the standard path end to end. k = 1 emitter hits (directly visible
  // lights) are always kept.
  private walkContribution(hit: PrimaryHit, key: ReturnType<typeof pixelSeedKey>, recorder: Recorder): Color {
    this.sampler.startPixelSample(key, DIM_SHADE);
    const vertices = walkFromCamera(
      this.scene,
      this.scene.camera.generateRay(hit.raster),
      this.sampler,
      recorder,
      { maxBounces: this.options.maxBounces, rrStartDepth: this.options.rrStartDepth, sampleNEE: true },
    );

    // pt-nee's estimator under the two ReSTIR exceptions. Sharing it is
    // what fixed the delta-light MIS guard this copy used to be missing.
    let L = Color.BLACK;
    for (let k = 1; k < vertices.length; k++) {
      L = L.add(
        directLighting(this.scene, vertices, k, recorder, {
          skipEmitterHit: (depth) => depth === 2 && !hit.delta,
          skipNEE: (depth) => depth === 1,
        }),
      );
    }
    return L;
  }

  // One full pass. Returns nothing; the film accumulates one sample/pixel.
  pass(recorder: Recorder = NULL_RECORDER): void {
    const pass = this.passesDone;
    this.tracePrimaries(pass);
    // Rotate reservoir history BEFORE building this pass's reservoirs.
    const swap = this.prevReservoirs;
    this.prevReservoirs = this.reservoirs;
    this.reservoirs = swap;
    this.initialCandidates(pass);
    if (this.options.temporal && pass > 0) this.temporalMerge(pass);
    for (let r = 0; r < this.options.spatialRounds; r++) this.spatialRound(pass, r);
    this.shade(pass, recorder);
    this.passesDone += 1;
  }
}

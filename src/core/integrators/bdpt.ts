// Bidirectional path tracing (pbrt v3 §16.3, Veach ch. 10). One camera
// subpath and one light subpath per pixel sample — both via the shared
// randomWalk — then every (s, t) pairing of their prefixes becomes a
// sampling strategy for the same path space, combined by MIS (bdpt-mis.ts).
//
// Conventions (see design-v2.md):
// - t >= 1 always (a pinhole cannot be hit); (1, 1) is skipped.
// - s = 1 RESAMPLES the light with sampleLi — receiver-aware — and the MIS
//   substitution uses pdfLightOrigin = pmf x pdfPos.
// - t = 1 contributions are 'splat's at sampleWi's raster (develop with
//   splatScale = 1/spp); all t >= 2 strategies sum into ONE 'sample'.
// - Escaped rays end walks (no infinite lights): no pseudo-vertices, and
//   the s = 0 strategy guards on "vertex is on an emitter".
import { Color } from '../math/color';
import { Ray } from '../math/ray';
import { Vec3, absDot } from '../math/vec3';
import type { Sample2D } from '../math/sampling';
import { solidAngleToArea } from '../geometry/measure';
import { occlusionPoint } from '../geometry/visibility';
import { TransportMode, hasNonSpecular } from '../materials/bsdf';
import type { Scene } from '../scene/scene';
import type { Sampler } from '../sampler/sampler';
import { CAMERA_STREAM, CONNECTION_STREAM, LIGHT_STREAM } from '../sampler/sampler';
import type { Recorder } from '../../trace/recorder';
import { cameraVertex, lightVertex, type PathVertex } from './vertex';
import { randomWalk, type WalkOptions } from './walk';
import { misWeight, type MisHeuristic, type MisOverrides, type MisVertex } from './bdpt-mis';
import type { Contribution, Integrator, Pixel } from './types';

// One strategy's contribution for one pixel sample — the per-(s, t) AOV
// feed behind the Veach pyramid. For t = 1 the raster is the splat target;
// otherwise it is the pixel sample's raster.
export interface StrategyContribution {
  s: number;
  t: number;
  kind: 'sample' | 'splat';
  raster: Sample2D;
  weighted: Color;
  unweighted: Color;
  weight: number;
}

// Sink interface rather than Film references: core stays pure — the caller
// (demo/test) owns per-strategy films and routes these into them.
export interface StrategySink {
  add(c: StrategyContribution): void;
}

export interface BDPTOptions {
  maxBounces: number; // walk cap AND strategy depth cap (s + t - 2)
  rrStartDepth: number;
  heuristic: MisHeuristic; // default power (Veach); balance toggleable
  // Per-(s, t) AOV feed (weighted AND unweighted) for the pyramid.
  strategyFilms: StrategySink | null;
  // Debug: for every formed path, evaluate ALL strategies' weights from an
  // independently recomputed density table and assert they sum to 1
  // (condition W1) and match the production ratio-chain weight. Throws.
  assertWeights: boolean;
  // Figure/debug hooks (light-tracing comparisons, the strategy pyramid):
  // restrict which strategies contribute, and/or skip MIS weighting.
  // Connection dimensions are drawn before filtering, so filtered runs
  // replay the same subpaths and connections as unfiltered ones.
  strategyFilter: ((s: number, t: number) => boolean) | null;
  unweighted: boolean;
}

export const DEFAULT_BDPT_OPTIONS: BDPTOptions = {
  maxBounces: 32,
  rrStartDepth: 3,
  heuristic: 'power',
  strategyFilms: null,
  assertWeights: false,
  strategyFilter: null,
  unweighted: false,
};

const walkOptions = (o: BDPTOptions): WalkOptions => ({
  maxBounces: o.maxBounces,
  rrStartDepth: o.rrStartDepth,
  sampleNEE: false,
});

const connectible = (v: PathVertex): boolean => v.bsdf !== null && hasNonSpecular(v.bsdf.flags);

// Area-measure density at a target vertex; cosine for any on-surface target
// (area-light endpoints included), none for the pinhole.
const toAreaAt = (pdfW: number, from: Vec3, to: PathVertex): number =>
  solidAngleToArea(pdfW, from, to.p, to.type === 'camera' ? null : to.ng);

// Camera subpath from an EXPLICIT raster position. MMLT (V3) enters here:
// its raster is Markov state (mutated camera-stream dims), not a
// stratification hint. The caller owns the camera stream — this function
// draws only walk dimensions.
export function cameraSubpathFromRaster(
  scene: Scene,
  raster: Sample2D,
  sampler: Sampler,
  recorder: Recorder,
  options: BDPTOptions,
): PathVertex[] {
  const ray = scene.camera.generateRay(raster);
  const start = cameraVertex(scene.camera, Color.WHITE);
  const { pdfDir } = scene.camera.pdfWe(ray);
  return randomWalk(
    scene, start, ray, Color.WHITE, pdfDir, TransportMode.Radiance, sampler, recorder, walkOptions(options),
  );
}

export function generateCameraSubpath(
  scene: Scene,
  pixel: Pixel,
  sampler: Sampler,
  recorder: Recorder,
  options: BDPTOptions,
): { raster: Sample2D; vertices: PathVertex[] } {
  sampler.startStream(CAMERA_STREAM);
  const u = sampler.nextPixel2D();
  const raster: Sample2D = [pixel[0] + u[0], pixel[1] + u[1]];
  return { raster, vertices: cameraSubpathFromRaster(scene, raster, sampler, recorder, options) };
}

export function generateLightSubpath(
  scene: Scene,
  sampler: Sampler,
  recorder: Recorder,
  options: BDPTOptions,
): PathVertex[] {
  sampler.startStream(LIGHT_STREAM);
  // Fixed dimension layout: light-select + two emission 2Ds, drawn always.
  const uSelect = sampler.next1D();
  const u1 = sampler.next2D();
  const u2 = sampler.next2D();
  const selected = scene.lightDistribution.sample(uSelect);
  if (!selected) return [];
  const le = selected.light.sampleLe(u1, u2);
  if (!le) return [];
  const start = lightVertex(selected.light, le.ray.o, le.nLight, le.L, le.pdfPos * selected.pmf);
  const beta = le.L.scale(
    Math.abs(le.nLight.dot(le.ray.d)) / (selected.pmf * le.pdfPos * le.pdfDir),
  );
  return randomWalk(
    scene, start, le.ray, beta, le.pdfDir, TransportMode.Importance, sampler, recorder, walkOptions(options),
  );
}

export interface ConnectionSample {
  select: number;
  point: Sample2D;
}

export interface StrategyOutcome {
  unweighted: Color; // strategy contribution before MIS weighting
  weight: number; // 0 when occluded
  raster: Sample2D | null; // t = 1: splat target
  connection: { from: Vec3; to: Vec3; occluded: boolean; blockedAt: Vec3 | null } | null;
}

// Unweighted contribution + MIS weight for strategy (s, t). `u` carries the
// connection dimensions (s = 1 only). Returns null when the strategy cannot
// form a path here (before any visibility test).
export function connectStrategy(
  scene: Scene,
  cameraVs: readonly PathVertex[],
  lightVs: readonly PathVertex[],
  s: number,
  t: number,
  options: BDPTOptions,
  u: ConnectionSample | null,
): StrategyOutcome | null {
  const pt = cameraVs[t - 1]!;
  const ptMinus = t >= 2 ? cameraVs[t - 2]! : null;
  const o: MisOverrides = {};

  if (s === 0) {
    // The camera subpath ends on an emitter.
    const light = pt.primitive?.light;
    if (!light || !pt.wo) return null;
    const Le = light.le(pt.p, pt.ng, pt.uv, pt.wo);
    if (Le.isBlack()) return null;
    const C = pt.beta.mul(Le);
    const pmf = scene.lightDistribution.pmf(light);
    if (t >= 2) o.ptPdfRev = pmf * light.pdfLe(pt.p, pt.ng, pt.wo).pdfPos;
    if (t >= 3) {
      o.ptMinusPdfRev = toAreaAt(light.pdfLe(pt.p, pt.ng, pt.wo).pdfDir, pt.p, ptMinus!);
    }
    const weight = misWeight(cameraVs, lightVs, s, t, o, options.heuristic);
    if (options.assertWeights) assertWeightSum(scene, cameraVs, lightVs, s, t, null, options, weight);
    return { unweighted: C, weight, raster: null, connection: null };
  }

  if (t === 1) {
    // Connect a light-subpath vertex straight to the pinhole: a splat.
    const qs = lightVs[s - 1]!;
    if (!connectible(qs) || !qs.wo) return null;
    const sw = scene.camera.sampleWi(qs.p);
    if (!sw) return null;
    const f = qs.bsdf!.eval(qs.wo, sw.wi, TransportMode.Importance);
    if (f.isBlack()) return null;
    const C = qs.beta.mul(f).scale(sw.We * absDot(sw.wi, qs.ns));
    if (C.isBlack()) return null;
    const blockedAt = occlusionPoint(
      scene.aggregate, { p: qs.p, ng: qs.ng }, { p: scene.camera.eye, ng: Vec3.ZERO },
    );
    const connection = {
      from: scene.camera.eye, to: qs.p, occluded: blockedAt !== null, blockedAt,
    };
    if (blockedAt !== null) {
      return { unweighted: Color.BLACK, weight: 0, raster: sw.raster, connection };
    }
    const { pdfDir } = scene.camera.pdfWe(new Ray(scene.camera.eye, sw.wi.neg()));
    o.qsPdfRev = toAreaAt(pdfDir, scene.camera.eye, qs);
    if (s >= 2) {
      o.qsMinusPdfRev = toAreaAt(
        qs.bsdf!.pdf(sw.wi, qs.wo, TransportMode.Radiance), qs.p, lightVs[s - 2]!,
      );
    }
    const weight = misWeight(cameraVs, lightVs, s, t, o, options.heuristic);
    if (options.assertWeights) assertWeightSum(scene, cameraVs, lightVs, s, t, null, options, weight);
    return { unweighted: C, weight, raster: sw.raster, connection };
  }

  if (s === 1) {
    // Resample the light toward pt (receiver-aware, like NEE).
    if (!connectible(pt) || !pt.wo || !u) return null;
    const selected = scene.lightDistribution.sample(u.select);
    if (!selected) return null;
    const li = selected.light.sampleLi({ p: pt.p, ng: pt.ng, ns: pt.ns }, u.point);
    if (!li) return null;
    const f = pt.bsdf!.eval(pt.wo, li.wi, TransportMode.Radiance);
    if (f.isBlack()) return null;
    const C = pt.beta.mul(f).mul(li.L).scale(absDot(li.wi, pt.ns) / (selected.pmf * li.pdf));
    if (C.isBlack()) return null;
    const blockedAt = occlusionPoint(scene.aggregate, { p: pt.p, ng: pt.ng }, li.pLight);
    const connection = {
      from: pt.p, to: li.pLight.p, occluded: blockedAt !== null, blockedAt,
    };
    if (blockedAt !== null) {
      return { unweighted: Color.BLACK, weight: 0, raster: null, connection };
    }
    const pdfPos = selected.light.pdfLe(li.pLight.p, li.pLight.ng, li.wi).pdfPos;
    o.qsSubstitutePdfFwd = selected.pmf * pdfPos;
    o.qsPdfRev = solidAngleToArea(
      pt.bsdf!.pdf(pt.wo, li.wi, TransportMode.Radiance), pt.p, li.pLight.p, li.pLight.ng,
    );
    o.ptPdfRev = toAreaAt(
      selected.light.pdfLe(li.pLight.p, li.pLight.ng, li.wi.neg()).pdfDir, li.pLight.p, pt,
    );
    if (t >= 3) {
      o.ptMinusPdfRev = toAreaAt(
        pt.bsdf!.pdf(li.wi, pt.wo, TransportMode.Importance), pt.p, ptMinus!,
      );
    }
    const weight = misWeight(cameraVs, lightVs, s, t, o, options.heuristic);
    if (options.assertWeights) {
      const substituted = lightVertex(
        selected.light, li.pLight.p, li.pLight.ng, li.L, selected.pmf * pdfPos,
      );
      assertWeightSum(scene, cameraVs, lightVs, s, t, substituted, options, weight);
    }
    return { unweighted: C, weight, raster: null, connection };
  }

  // General connection between two interior surface vertices.
  const qs = lightVs[s - 1]!;
  if (!connectible(qs) || !connectible(pt) || !qs.wo || !pt.wo) return null;
  const d = pt.p.sub(qs.p);
  const distSq = d.lengthSq();
  if (distSq === 0) return null;
  const dHat = d.scale(1 / Math.sqrt(distSq)); // qs -> pt
  const fq = qs.bsdf!.eval(qs.wo, dHat, TransportMode.Importance);
  const fp = pt.bsdf!.eval(pt.wo, dHat.neg(), TransportMode.Radiance);
  if (fq.isBlack() || fp.isBlack()) return null;
  // G with SHADING normals — the geometric normal belongs to density
  // conversion, not to the contribution (pbrt-notes §BDPT).
  const G = (absDot(qs.ns, dHat) * absDot(pt.ns, dHat)) / distSq;
  const C = qs.beta.mul(fq).mul(fp).mul(pt.beta).scale(G);
  if (C.isBlack()) return null;
  const blockedAt = occlusionPoint(scene.aggregate, { p: qs.p, ng: qs.ng }, { p: pt.p, ng: pt.ng });
  const connection = { from: pt.p, to: qs.p, occluded: blockedAt !== null, blockedAt };
  if (blockedAt !== null) {
    return { unweighted: Color.BLACK, weight: 0, raster: null, connection };
  }
  o.ptPdfRev = toAreaAt(qs.bsdf!.pdf(qs.wo, dHat, TransportMode.Importance), qs.p, pt);
  if (t >= 3) {
    o.ptMinusPdfRev = toAreaAt(
      pt.bsdf!.pdf(dHat.neg(), pt.wo, TransportMode.Importance), pt.p, ptMinus!,
    );
  }
  o.qsPdfRev = toAreaAt(pt.bsdf!.pdf(pt.wo, dHat.neg(), TransportMode.Radiance), pt.p, qs);
  o.qsMinusPdfRev = toAreaAt(qs.bsdf!.pdf(dHat, qs.wo, TransportMode.Radiance), qs.p, lightVs[s - 2]!);
  const weight = misWeight(cameraVs, lightVs, s, t, o, options.heuristic);
  if (options.assertWeights) assertWeightSum(scene, cameraVs, lightVs, s, t, null, options, weight);
  return { unweighted: C, weight, raster: null, connection };
}

export class BDPT implements Integrator {
  private readonly options: BDPTOptions;

  constructor(options: Partial<BDPTOptions> = {}) {
    this.options = { ...DEFAULT_BDPT_OPTIONS, ...options };
  }

  sampleContributions(pixel: Pixel, sampler: Sampler, scene: Scene, recorder: Recorder): Contribution[] {
    const { raster, vertices: cameraVs } = generateCameraSubpath(scene, pixel, sampler, recorder, this.options);
    const lightVs = generateLightSubpath(scene, sampler, recorder, this.options);

    sampler.startStream(CONNECTION_STREAM);
    let L = Color.BLACK;
    const splats: Contribution[] = [];
    for (let t = 1; t <= cameraVs.length; t++) {
      for (let s = 0; s <= lightVs.length; s++) {
        const depth = s + t - 2;
        if ((s === 1 && t === 1) || depth < 0 || depth > this.options.maxBounces) continue;
        // s = 1 draws its connection dimensions unconditionally, before the
        // filter and before any early-out inside connectStrategy.
        const u: ConnectionSample | null =
          s === 1 ? { select: sampler.next1D(), point: sampler.next2D() } : null;
        if (this.options.strategyFilter && !this.options.strategyFilter(s, t)) continue;
        const outcome = connectStrategy(scene, cameraVs, lightVs, s, t, this.options, u);
        if (!outcome) continue;
        if (outcome.connection) recorder.connection({ s, t, ...outcome.connection, weight: outcome.weight });
        this.options.strategyFilms?.add({
          s,
          t,
          kind: t === 1 ? 'splat' : 'sample',
          raster: t === 1 ? outcome.raster! : raster,
          weighted: outcome.unweighted.scale(outcome.weight),
          unweighted: outcome.unweighted,
          weight: outcome.weight,
        });
        const value = outcome.unweighted.scale(this.options.unweighted ? 1 : outcome.weight);
        if (value.isBlack()) continue;
        if (t === 1) {
          const splat: Contribution = { kind: 'splat', raster: outcome.raster!, value };
          recorder.contribution(splat);
          splats.push(splat);
        } else {
          L = L.add(value);
        }
      }
    }

    const sample: Contribution = { kind: 'sample', raster, value: L };
    recorder.contribution(sample);
    return [sample, ...splats];
  }
}

// ---------------------------------------------------------------------------
// Weight-sum debug check (options.assertWeights).
//
// Rebuilds the formed path's full forward/reverse area-density table from
// live refs (bsdf.pdf / pdfWe / pdfLe along directions that were never
// sampled), evaluates EVERY strategy's weight from that one table via
// misWeight, and asserts (1) the weights sum to 1 — condition W1, the
// unbiasedness of the combination — and (2) the production weight computed
// through the override plumbing matches the table's value for (s, t). The
// table is independent of the walks' stored pdfs, so a bookkeeping bug on
// either side makes the two disagree.

function assertWeightSum(
  scene: Scene,
  cameraVs: readonly PathVertex[],
  lightVs: readonly PathVertex[],
  s: number,
  t: number,
  substituted: PathVertex | null, // s = 1: the resampled light vertex
  options: BDPTOptions,
  productionWeight: number,
): void {
  // The formed path P: camera side in order, then the light side reversed.
  const P: PathVertex[] = cameraVs.slice(0, t);
  if (s === 1 && substituted) P.push(substituted);
  else for (let i = s - 1; i >= 0; i--) P.push(lightVs[i]!);
  const n = P.length;
  const light = P[n - 1]!.light ?? P[n - 1]!.primitive?.light;
  if (!light || n < 2) return;
  const pmf = scene.lightDistribution.pmf(light);
  // Directions: use the walks' EXACT sampled directions for segments a walk
  // produced (the walk computed its pdfs from those, and ray origins are
  // offset, so recomputing from positions diverges at grazing cosines);
  // junction-crossing segments are recomputed from positions, exactly as
  // the production overrides compute them.
  const stored = (jFrom: number, jTo: number): Vec3 | null => {
    if (jFrom < t !== jTo < t) return null; // crosses the junction
    const v = P[jFrom]!;
    if (jFrom < t) return jTo === jFrom + 1 ? v.wiSampled : v.wo;
    // Light side is reversed in P: toward higher j is toward the emitter.
    return jTo === jFrom + 1 ? v.wo : v.wiSampled;
  };
  const dir = (jFrom: number, jTo: number): Vec3 =>
    stored(jFrom, jTo) ?? stored(jTo, jFrom)?.neg() ?? P[jTo]!.p.sub(P[jFrom]!.p).normalize();

  // pCam[j]: area density of generating P[j] by extending the camera side.
  const pCam = new Array<number>(n).fill(0);
  pCam[0] = 1;
  pCam[1] = toAreaAt(scene.camera.pdfWe(new Ray(P[0]!.p, dir(0, 1))).pdfDir, P[0]!.p, P[1]!);
  for (let j = 2; j < n; j++) {
    const v = P[j - 1]!;
    pCam[j] = v.bsdf
      ? toAreaAt(v.bsdf.pdf(dir(j - 1, j - 2), dir(j - 1, j), TransportMode.Radiance), v.p, P[j]!)
      : 0;
  }
  // pLight[j]: area density of generating P[j] by extending the light side.
  const pLight = new Array<number>(n).fill(0);
  const nL = P[n - 1]!.ng;
  pLight[n - 1] = pmf * light.pdfLe(P[n - 1]!.p, nL, nL).pdfPos;
  pLight[n - 2] = toAreaAt(light.pdfLe(P[n - 1]!.p, nL, dir(n - 1, n - 2)).pdfDir, P[n - 1]!.p, P[n - 2]!);
  for (let j = n - 3; j >= 0; j--) {
    const v = P[j + 1]!;
    pLight[j] = v.bsdf
      ? toAreaAt(v.bsdf.pdf(dir(j + 1, j + 2), dir(j + 1, j), TransportMode.Importance), v.p, P[j]!)
      : 0;
  }
  // Delta as a CAPABILITY of the vertex's material (can it be a junction?),
  // matching the walk's sampled-lobe flag for our pure materials.
  const delta = P.map((v) => (v.bsdf ? !hasNonSpecular(v.bsdf.flags) : false));

  let sum = 0;
  let tableWeight = Number.NaN;
  for (let tp = 1; tp <= n; tp++) {
    const sp = n - tp;
    if (sp === 1 && tp === 1) continue;
    if (tp < n) {
      // Junction between P[tp-1] and P[tp]: both must be connectible
      // (endpoints always are; the light endpoint is P[n-1]).
      const leftDelta = tp >= 2 ? delta[tp - 1]! : false;
      const rightDelta = tp === n - 1 && P[n - 1]!.type === 'light' ? false : delta[tp]!;
      if (leftDelta || rightDelta) continue;
    }
    const camViews: MisVertex[] = [];
    for (let j = 0; j < tp; j++) camViews.push({ pdfFwd: pCam[j]!, pdfRev: pLight[j]!, delta: delta[j]! });
    const lightViews: MisVertex[] = [];
    for (let i = 0; i < sp; i++) {
      const j = n - 1 - i;
      lightViews.push({ pdfFwd: pLight[j]!, pdfRev: pCam[j]!, delta: delta[j]! });
    }
    const w = misWeight(camViews, lightViews, sp, tp, {}, options.heuristic);
    sum += w;
    if (tp === t) tableWeight = w;
  }

  if (Math.abs(sum - 1) > 1e-6) {
    throw new Error(`BDPT weight-sum violation at (s=${s}, t=${t}): sum of all strategy weights = ${sum}`);
  }
  if (Math.abs(tableWeight - productionWeight) > 1e-9) {
    throw new Error(
      `BDPT MIS mismatch at (s=${s}, t=${t}): production weight ${productionWeight}, density-table weight ${tableWeight}`,
    );
  }
}

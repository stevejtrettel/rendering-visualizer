// Path tracing with NEE and SPECULAR MANIFOLD SAMPLING — pt-nee plus one
// more connection strategy: at every diffuse vertex, for every specular
// caster, solve for the specular vertex connecting the receiver to a
// sampled light point (a generalized NEE through the surface every other
// strategy connects around).
//
// Strategy PARTITION, not MIS (design-v5 decision 5, the paper's own demo
// integrator): SMS owns the family {diffuse vertex → exactly one specular
// vertex (on an eligible caster, on the prescribed branch) → emitter}, so
// the walk's BSDF-sampled emitter hits of that family contribute ZERO
// here. Unbiased by disjointness; the honest cost is variance where plain
// sampling would win (large lights, near-rough casters).
//
// The estimator (sms-theory §12.4–12.5, manifold_ss.cpp:28–201): per
// contribution the PHYSICAL factors — receiver BSDF · Fresnel(chain) ·
// generalized G · Le — and the SAMPLING correction for root discovery:
// 'unbiased' repeats seed-and-solve trials until the found root recurs
// (geometric variable, E[N] = 1/p_k, capped by maxTrials → tiny labeled
// bias); 'biasedM' runs a fixed budget of M trials and sums each UNIQUE
// root once (occurrence counts cancel — consistent as M → ∞, darkening
// where roots are rarely found). mneeInit is the MNEE degenerate config:
// one deterministic straight-line seed, p ∈ {0, 1}, no estimation.
import { Color } from '../math/color';
import { Ray } from '../math/ray';
import { Vec3, absDot } from '../math/vec3';
import { OrthonormalBasis } from '../math/onb';
import { TransportMode, hasNonSpecular, type BxDF } from '../materials/bsdf';
import { RAY_EPSILON } from '../geometry/offset';
import { occlusionPoint } from '../geometry/visibility';
import { Sphere } from '../geometry/sphere';
import { Quad } from '../geometry/quad';
import { TriangleMesh } from '../geometry/triangle-mesh';
import type { Shape } from '../geometry/shape';
import type { Scene, ScenePrimitive } from '../scene/scene';
import { AreaLight } from '../lights/area';
import type { Sampler } from '../sampler/sampler';
import { SMS_STREAM } from '../sampler/sampler';
import type { Recorder } from '../../trace/recorder';
import { ManifoldVertex } from '../manifold/vertex';
import {
  manifoldWalk,
  sameSolution,
  MAX_ITERATIONS,
  SOLVER_THRESHOLD,
  type ManifoldWalkOptions,
} from '../manifold/newton';
import { geometricTerm } from '../manifold/geometry-term';
import { cameraVertex, type PathVertex } from './vertex';
import { DEFAULT_WALK_OPTIONS, randomWalk, type WalkOptions } from './walk';
import { powerHeuristic } from './mis';
import type { Contribution, Integrator, Pixel } from './types';

// The narrow structural contract a specular caster's material fulfills
// (Dielectric, SmoothConductor). Kept structural on purpose: the BxDF
// interface and its delta eval/pdf contract stay untouched.
interface CasterBxDF extends BxDF {
  readonly manifoldEta: number;
  specularChainThroughput(cosReceiver: number, mode: TransportMode): Color;
}

const asCasterBxDF = (b: BxDF): CasterBxDF | null =>
  'manifoldEta' in b && 'specularChainThroughput' in b ? (b as CasterBxDF) : null;

// V5 caster eligibility: sphere and quad only — mesh casters are a
// recorded follow-up (the derivatives exist; edge-crossing walks on
// faceted geometry do not).
export const eligibleCasters = (scene: Scene): ScenePrimitive[] =>
  scene.primitives.filter(
    (p) => p.light === null && asCasterBxDF(p.bxdf) !== null && !(p.shape instanceof TriangleMesh),
  );

const shapeCenter = (shape: Shape): Vec3 => {
  if (shape instanceof Sphere) return shape.center;
  if (shape instanceof Quad) return shape.q.add(shape.e1.scale(0.5)).add(shape.e2.scale(0.5));
  return Vec3.ZERO; // unreachable for eligible casters
};

// Endpoint vertex for the generalized G: an orthonormal area frame, flat.
const endpointVertex = (p: Vec3, n: Vec3): ManifoldVertex => {
  const onb = OrthonormalBasis.fromZ(n);
  return new ManifoldVertex(
    { p, ns: n, ng: n, dpdu: onb.u, dpdv: onb.v, dndu: Vec3.ZERO, dndv: Vec3.ZERO },
    1,
  );
};

export interface SMSPTOptions extends WalkOptions, ManifoldWalkOptions {
  estimator: 'biasedM' | 'unbiased';
  M: number; // biasedM: fixed trial budget (design default 8)
  maxTrials: number; // unbiased: Bernoulli safety cap (estimate → 0 past it)
  mneeInit: boolean; // deterministic straight-line seed — the MNEE config
}

export const DEFAULT_SMS_OPTIONS: SMSPTOptions = {
  ...DEFAULT_WALK_OPTIONS,
  sampleNEE: true,
  constraint: 'anglediff',
  maxIterations: MAX_ITERATIONS,
  solverThreshold: SOLVER_THRESHOLD,
  stepScale: 1,
  estimator: 'biasedM',
  M: 8,
  maxTrials: 64,
  mneeInit: false,
};

// The receiver-side context the SMS estimator needs — a PathVertex slice,
// exported so tests can drive the estimator at a chosen point without a
// camera walk.
export interface SMSReceiver {
  p: Vec3;
  ns: Vec3;
  bsdf: { eval(wo: Vec3, wi: Vec3, mode: TransportMode): Color };
  wo: Vec3;
  depth: number;
}

// One SMS estimate at a receiver vertex: sample a light point, then for
// each eligible caster run the configured estimator. Returns radiance
// WITHOUT the path throughput beta (the integrator applies it).
export function smsConnect(
  scene: Scene,
  receiver: SMSReceiver,
  sampler: Sampler,
  recorder: Recorder,
  options: SMSPTOptions,
): Color {
  const casters = eligibleCasters(scene);
  if (casters.length === 0) return Color.BLACK;

  // One emitter interaction per estimate (manifold_ss.cpp:49), sampled by
  // AREA — the generalized G is the area-to-solid-angle Jacobian.
  const selected = scene.lightDistribution.sample(sampler.next1D());
  const uLight = sampler.next2D();
  if (!selected || !(selected.light instanceof AreaLight)) return Color.BLACK;
  const light = selected.light;
  const pL = light.shape.sampleArea(uLight);

  const walkOptions: ManifoldWalkOptions = {
    constraint: options.constraint,
    maxIterations: options.maxIterations,
    solverThreshold: options.solverThreshold,
    stepScale: options.stepScale,
  };

  let L = Color.BLACK;
  for (const caster of casters) {
    const casterBxdf = asCasterBxDF(caster.bxdf)!;
    const eta = casterBxdf.manifoldEta;

    // Seed-and-solve: sample a point on the caster (or the deterministic
    // MNEE target), verify the caster is actually the first hit from the
    // receiver, then run the manifold walk.
    const samplePath = (recordTrials: number | null) => {
      let target: Vec3;
      if (options.mneeInit) {
        // MNEE: straight line toward the light for refraction; toward the
        // caster's center for reflection (the paper's modified MNEE).
        target = eta !== 1 ? pL.p : shapeCenter(caster.shape);
      } else {
        target = caster.shape.sampleArea(sampler.next2D()).p;
      }
      const dir = target.sub(receiver.p).normalize();
      const seedHit = scene.aggregate.intersect(new Ray(receiver.p.add(dir.scale(RAY_EPSILON)), dir));
      if (!seedHit || seedHit.primitive !== caster) return null;
      const result = manifoldWalk(receiver.p, seedHit, eta, pL.p, caster, scene.aggregate, walkOptions);
      recorder.manifoldWalk({
        depth: receiver.depth,
        casterName: caster.name,
        lightP: pL.p,
        seed: seedHit.p,
        iterates: result.iterates,
        outcome: result.outcome,
        solution: result.vertex ? result.vertex.p : null,
        trials: recordTrials,
      });
      return result.outcome === 'converged' ? result.vertex : null;
    };

    // Physical contribution of one root (the walk already validated the
    // branch and both visibilities).
    const contributionOfRoot = (vtx: ManifoldVertex): Color | null => {
      const dirToVtx = vtx.p.sub(receiver.p).normalize();
      const f = receiver.bsdf.eval(receiver.wo, dirToVtx, TransportMode.Radiance);
      if (f.isBlack()) return null;
      const wEmit = vtx.p.sub(pL.p).normalize();
      const Le = light.le(pL.p, pL.ng, [0, 0], wEmit);
      if (Le.isBlack()) return null;
      const cosReceiver = absDot(dirToVtx, receiver.ns);
      const chain = casterBxdf.specularChainThroughput(
        receiver.p.sub(vtx.p).normalize().dot(vtx.n),
        TransportMode.Radiance,
      );
      const v0 = endpointVertex(receiver.p, receiver.ns);
      const v2 = endpointVertex(pL.p, pL.ng);
      vtx.makeOrthonormal();
      const G = geometricTerm(v0, vtx, v2);
      if (G === 0) return null;
      return f
        .mul(chain)
        .mul(Le)
        .scale((cosReceiver * G) / (selected.pmf * pL.pdf));
    };

    if (options.estimator === 'biasedM' || options.mneeInit) {
      // Fixed budget, unique roots summed once each (Algorithm 3).
      const trials = options.mneeInit ? 1 : options.M;
      const dirs: Vec3[] = [];
      for (let m = 0; m < trials; m++) {
        const vtx = samplePath(null);
        if (!vtx) continue;
        const dir = vtx.p.sub(receiver.p).normalize();
        if (dirs.some((d) => sameSolution(d, dir))) continue;
        dirs.push(dir);
        const c = contributionOfRoot(vtx);
        if (c) L = L.add(c);
      }
    } else {
      // Unbiased (Algorithm 2, Booth-style geometric estimator).
      const vtx = samplePath(null);
      if (!vtx) continue;
      const dir = vtx.p.sub(receiver.p).normalize();
      let invProb = 1;
      let trials = 1;
      for (;;) {
        const trialVtx = samplePath(null);
        if (trialVtx && sameSolution(dir, trialVtx.p.sub(receiver.p).normalize())) break;
        invProb += 1;
        trials += 1;
        if (options.maxTrials > 0 && trials > options.maxTrials) {
          // Numerical one-off roots would loop forever; the cap trades a
          // tiny labeled bias for termination (manifold_ss.cpp:127).
          invProb = 0;
          break;
        }
      }
      recorder.manifoldWalk({
        depth: receiver.depth,
        casterName: caster.name,
        lightP: pL.p,
        seed: vtx.p,
        iterates: [],
        outcome: 'converged',
        solution: vtx.p,
        trials,
      });
      if (invProb > 0) {
        const c = contributionOfRoot(vtx);
        if (c) L = L.add(c.scale(invProb));
      }
    }
  }
  return L;
}

export class SMSPathTracer implements Integrator {
  private readonly options: SMSPTOptions;

  constructor(options: Partial<SMSPTOptions> = {}) {
    this.options = { ...DEFAULT_SMS_OPTIONS, ...options, sampleNEE: true };
  }

  sampleContributions(pixel: Pixel, sampler: Sampler, scene: Scene, recorder: Recorder): Contribution[] {
    const u = sampler.nextPixel2D();
    const raster = [pixel[0] + u[0], pixel[1] + u[1]] as const;
    const ray = scene.camera.generateRay(raster);

    const start = cameraVertex(scene.camera, Color.WHITE);
    const { pdfDir } = scene.camera.pdfWe(ray);
    const vertices = randomWalk(
      scene, start, ray, Color.WHITE, pdfDir, TransportMode.Radiance, sampler, recorder, this.options,
    );

    // All SMS dimensions live after the walk's, in their own stream —
    // trial counts are data-dependent and must not shift walk dimensions.
    sampler.startStream(SMS_STREAM);

    let L = Color.BLACK;
    for (let k = 1; k < vertices.length; k++) {
      const v = vertices[k]!;
      const prev = vertices[k - 1]!;

      // (a) Emission hit by BSDF sampling — pt-nee's branch, minus the
      // SMS-owned family (see header).
      const hitLight = v.primitive?.light;
      if (hitLight && v.wo) {
        const Le = hitLight.le(v.p, v.ng, v.uv, v.wo);
        if (!Le.isBlack() && !this.smsOwnsEmitterHit(vertices, k)) {
          let weight = 1;
          if (prev.bsdf && prev.wo && prev.wiSampled && !prev.delta) {
            const pBsdf = prev.bsdf.pdf(prev.wo, prev.wiSampled, TransportMode.Radiance);
            const pLight =
              scene.lightDistribution.pmf(hitLight) *
              hitLight.pdfLi({ p: prev.p, ng: prev.ng, ns: prev.ns }, prev.wiSampled);
            weight = powerHeuristic(pBsdf, pLight);
          }
          L = L.add(v.beta.mul(Le).scale(weight));
        }
      }

      // (b) NEE connection — pt-nee's, unchanged.
      if (v.bsdf && v.wo && v.neeSamples && hasNonSpecular(v.bsdf.flags)) {
        const selected = scene.lightDistribution.sample(v.neeSamples.select);
        if (selected) {
          const li = selected.light.sampleLi({ p: v.p, ng: v.ng, ns: v.ns }, v.neeSamples.point);
          if (li) {
            const f = v.bsdf.eval(v.wo, li.wi, TransportMode.Radiance);
            if (!f.isBlack()) {
              const blockedAt = occlusionPoint(scene.aggregate, { p: v.p, ng: v.ng }, li.pLight);
              recorder.shadowRay({
                depth: k,
                from: v.p,
                to: li.pLight.p,
                occluded: blockedAt !== null,
                blockedAt,
              });
              if (blockedAt === null) {
                const pLight = selected.pmf * li.pdf;
                const pBsdf = v.bsdf.pdf(v.wo, li.wi, TransportMode.Radiance);
                const weight = powerHeuristic(pLight, pBsdf);
                L = L.add(v.beta.mul(f).mul(li.L).scale((absDot(li.wi, v.ns) / pLight) * weight));
              }
            }
          }
        }
      }

      // (c) The SMS connection — the strategy pt-nee cannot attempt.
      if (v.bsdf && v.wo && hasNonSpecular(v.bsdf.flags)) {
        const sms = smsConnect(
          scene,
          { p: v.p, ns: v.ns, bsdf: v.bsdf, wo: v.wo, depth: k },
          sampler,
          recorder,
          this.options,
        );
        if (!sms.isBlack()) L = L.add(v.beta.mul(sms));
      }
    }

    const contribution: Contribution = { kind: 'sample', raster, value: L };
    recorder.contribution(contribution);
    return [contribution];
  }

  // Does the emitter hit at index k complete the SMS-owned family
  // {non-specular vertex → one delta bounce on an eligible caster, on the
  // prescribed branch → emitter}? Exactly those contributions are zeroed
  // here — SMS supplies them. A delta bounce on the WRONG branch (e.g. the
  // reflection lobe of glass, which SMS does not solve) keeps its BSDF
  // contribution: the partition must stay exhaustive.
  private smsOwnsEmitterHit(vertices: readonly PathVertex[], k: number): boolean {
    if (k < 2) return false;
    const spec = vertices[k - 1]!;
    const diffuse = vertices[k - 2]!;
    if (!spec.delta || !spec.primitive || !spec.wo || !spec.wiSampled) return false;
    if (!diffuse.bsdf || !hasNonSpecular(diffuse.bsdf.flags)) return false;
    const casterBxdf = asCasterBxDF(spec.primitive.bxdf);
    if (!casterBxdf || spec.primitive.light !== null || spec.primitive.shape instanceof TriangleMesh) {
      return false;
    }
    // Branch of the actual bounce: transmission crosses sides of ng.
    const transmission = spec.wo.dot(spec.ng) * spec.wiSampled.dot(spec.ng) < 0;
    return casterBxdf.manifoldEta !== 1 ? transmission : !transmission;
  }
}

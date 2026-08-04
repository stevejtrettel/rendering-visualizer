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
import { Sphere } from '../geometry/sphere';
import { Quad } from '../geometry/quad';
import { TriangleMesh } from '../geometry/triangle-mesh';
import type { Shape } from '../geometry/shape';
import type { Scene, ScenePrimitive } from '../scene/scene';
import { AreaLight } from '../lights/area';
import { PointLight } from '../lights/point';
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
import { chainGeometricTerm, chainSeed, chainWalk, type ChainLink } from '../manifold/chain';
import type { PathVertex } from './vertex';
import { cameraSample, directLighting, walkFromCamera } from './estimators';
import { DEFAULT_WALK_OPTIONS, type WalkOptions } from './walk';
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
  // V5b: two-crossing refraction chains through each dielectric caster.
  chains: boolean;
  // 'random' (default) engages the estimator ladder over straight-
  // through seeds; 'deterministic' is the single straight-line MNEE-
  // style seed — measured ~6% DARK on glass-box caustic pixels (the
  // fiber has multi-root fold bands a single seed cannot cover; see the
  // amended case (b) in design-v5 §V5b).
  chainSeedMode: 'deterministic' | 'random';
  // Chains ramp beta from 0.1 (Cycles' schedule) and need more headroom
  // than the single-bounce 20 (Cycles uses 64).
  chainMaxIterations: number;
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
  chains: true,
  chainSeedMode: 'random',
  chainMaxIterations: 32,
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

  // One emitter interaction per estimate (manifold_ss.cpp:49). Area
  // lights are sampled by AREA (the generalized G is the area-to-solid-
  // angle Jacobian); DELTA lights fix b outright with pdf 1, and their
  // endpoint vertex gets a virtual plane FACING the chain (the reference
  // point-emitter pattern: weight = intensity, the r² lives in G).
  const selected = scene.lightDistribution.sample(sampler.next1D());
  const uLight = sampler.next2D();
  if (!selected) return Color.BLACK;
  let lightP: Vec3;
  let lightNg: Vec3 | null; // null for delta lights: face each root
  let invPdfLight: number;
  let lightRadianceToward: (vtxP: Vec3) => Color;
  if (selected.light instanceof AreaLight) {
    const light = selected.light;
    const s = light.shape.sampleArea(uLight);
    lightP = s.p;
    lightNg = s.ng;
    invPdfLight = 1 / (selected.pmf * s.pdf);
    lightRadianceToward = (vtxP) => light.le(s.p, s.ng, [0, 0], vtxP.sub(s.p).normalize());
  } else if (selected.light instanceof PointLight) {
    const light = selected.light;
    lightP = light.position;
    lightNg = null;
    invPdfLight = 1 / selected.pmf;
    lightRadianceToward = () => light.intensity;
  } else {
    return Color.BLACK;
  }
  const lightVertexFor = (vtxP: Vec3): ManifoldVertex =>
    endpointVertex(lightP, lightNg ?? vtxP.sub(lightP).normalize());

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

    // Crossing parity for CLOSED casters (spheres): a transmission chain
    // of odd length needs its endpoints on opposite sides, even length
    // the same side. Attempting the wrong-parity family is provably
    // wasted work (every walk ends invalid-branch) — measured as roughly
    // half the per-sample cost on the glass box. Exact geometry, and the
    // suppression predicate is untouched (it tests the actual path).
    const sideParity =
      eta !== 1 && caster.shape instanceof Sphere
        ? (caster.shape.center.distanceTo(receiver.p) < caster.shape.radius) ===
          (caster.shape.center.distanceTo(lightP) < caster.shape.radius)
        : null; // open surfaces / mirrors: no parity constraint
    const skipSingle = sideParity === true; // same side ⇒ no m = 1 family
    const skipChain = sideParity === false; // opposite sides ⇒ no m = 2 family

    // Seed-and-solve: sample a point on the caster (or the deterministic
    // MNEE target), verify the caster is actually the first hit from the
    // receiver, then run the manifold walk.
    const samplePath = (recordTrials: number | null) => {
      let target: Vec3;
      if (options.mneeInit) {
        // MNEE: straight line toward the light for refraction; toward the
        // caster's center for reflection (the paper's modified MNEE).
        target = eta !== 1 ? lightP : shapeCenter(caster.shape);
      } else {
        target = caster.shape.sampleArea(sampler.next2D()).p;
      }
      const dir = target.sub(receiver.p).normalize();
      const seedHit = scene.aggregate.intersect(new Ray(receiver.p.add(dir.scale(RAY_EPSILON)), dir));
      if (!seedHit || seedHit.primitive !== caster) return null;
      const result = manifoldWalk(receiver.p, seedHit, eta, lightP, caster, scene.aggregate, walkOptions);
      recorder.manifoldWalk({
        depth: receiver.depth,
        casterName: caster.name,
        lightP,
        seed: seedHit.p,
        iterates: result.iterates.map((it) => ({ chain: [it.p], cNorm: it.cNorm })),
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
      const Le = lightRadianceToward(vtx.p);
      if (Le.isBlack()) return null;
      const cosReceiver = absDot(dirToVtx, receiver.ns);
      const chain = casterBxdf.specularChainThroughput(
        receiver.p.sub(vtx.p).normalize().dot(vtx.n),
        TransportMode.Radiance,
      );
      const v0 = endpointVertex(receiver.p, receiver.ns);
      const v2 = lightVertexFor(vtx.p);
      vtx.makeOrthonormal();
      const G = geometricTerm(v0, vtx, v2);
      if (G === 0) return null;
      return f
        .mul(chain)
        .mul(Le)
        .scale(cosReceiver * G * invPdfLight);
    };

    if (skipSingle) {
      // Empty m = 1 family (parity): no attempts, no draws.
    } else if (options.estimator === 'biasedM' || options.mneeInit) {
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
      if (vtx) {
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
          lightP,
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

    // --- V5b: the two-crossing refraction chain through this caster ---
    if (!options.chains || eta === 1 || skipChain) continue;
    const links: ChainLink[] = [
      { primitive: caster, eta },
      { primitive: caster, eta },
    ];
    // Chains run the HALF-VECTOR constraint regardless of the m = 1
    // toggle (design-v5 §V5b decision 2): the anglediff form's per-vertex
    // spherical frames couple badly across a chain from far seeds
    // (measured: 0/518 integrator walks converged under it), while the
    // half-vector blocks are the reference recipe.
    const chainOptions = {
      ...walkOptions,
      constraint: 'halfvector' as const,
      maxIterations: options.chainMaxIterations,
    };

    const sampleChain = (): ManifoldVertex[] | null => {
      const target =
        options.chainSeedMode === 'deterministic' ? lightP : caster.shape.sampleArea(sampler.next2D()).p;
      const seeds = chainSeed(receiver.p, target, links, scene.aggregate);
      if (!seeds) return null;
      const result = chainWalk(receiver.p, seeds, links, lightP, scene.aggregate, chainOptions);
      recorder.manifoldWalk({
        depth: receiver.depth,
        casterName: caster.name,
        lightP,
        seed: seeds[0]!.p,
        iterates: result.iterates,
        outcome: result.outcome,
        solution: result.vertices ? result.vertices[0]!.p : null,
        trials: null,
      });
      return result.outcome === 'converged' ? result.vertices : null;
    };

    const chainContribution = (verts: ManifoldVertex[]): Color | null => {
      const dirToX1 = verts[0]!.p.sub(receiver.p).normalize();
      const f = receiver.bsdf.eval(receiver.wo, dirToX1, TransportMode.Radiance);
      if (f.isBlack()) return null;
      const xLast = verts[verts.length - 1]!.p;
      const Le = lightRadianceToward(xLast);
      if (Le.isBlack()) return null;
      const cosReceiver = absDot(dirToX1, receiver.ns);
      // Per-crossing Fresnel with each crossing's directed eta (the η²
      // compressions cancel across an enter/exit pair — tested).
      let chainT = Color.WHITE;
      for (let i = 0; i < verts.length; i++) {
        const prevP = i === 0 ? receiver.p : verts[i - 1]!.p;
        const cos = prevP.sub(verts[i]!.p).normalize().dot(verts[i]!.n);
        chainT = chainT.mul(casterBxdf.specularChainThroughput(cos, TransportMode.Radiance));
      }
      const v2 = lightVertexFor(xLast);
      for (const v of verts) v.makeOrthonormal();
      const G = chainGeometricTerm(receiver.p, verts, v2);
      if (G === 0) return null;
      return f
        .mul(chainT)
        .mul(Le)
        .scale(cosReceiver * G * invPdfLight);
    };

    if (options.chainSeedMode === 'deterministic') {
      // MNEE-degenerate: p ∈ {0, 1}, one walk, no estimator spend.
      const verts = sampleChain();
      if (verts) {
        const c = chainContribution(verts);
        if (c) L = L.add(c);
      }
    } else if (options.estimator === 'biasedM') {
      const dirs: Vec3[] = [];
      for (let m = 0; m < options.M; m++) {
        const verts = sampleChain();
        if (!verts) continue;
        const dir = verts[0]!.p.sub(receiver.p).normalize();
        if (dirs.some((d) => sameSolution(d, dir))) continue;
        dirs.push(dir);
        const c = chainContribution(verts);
        if (c) L = L.add(c);
      }
    } else {
      const verts = sampleChain();
      if (verts) {
        const dir = verts[0]!.p.sub(receiver.p).normalize();
        let invProb = 1;
        let trials = 1;
        for (;;) {
          const trialVerts = sampleChain();
          if (trialVerts && sameSolution(dir, trialVerts[0]!.p.sub(receiver.p).normalize())) break;
          invProb += 1;
          trials += 1;
          if (options.maxTrials > 0 && trials > options.maxTrials) {
            invProb = 0;
            break;
          }
        }
        if (invProb > 0) {
          const c = chainContribution(verts);
          if (c) L = L.add(c.scale(invProb));
        }
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
    const { raster, ray } = cameraSample(scene, pixel, sampler);
    const vertices = walkFromCamera(scene, ray, sampler, recorder, this.options);

    // All SMS dimensions live after the walk's, in their own stream —
    // trial counts are data-dependent and must not shift walk dimensions.
    sampler.startStream(SMS_STREAM);

    let L = Color.BLACK;
    for (let k = 1; k < vertices.length; k++) {
      const v = vertices[k]!;

      // (a) + (b): pt-nee's estimator exactly, minus the emitter hits of
      // the SMS-owned families (see the header's partition note) — those
      // are supplied by (c) instead.
      L = L.add(
        directLighting(scene, vertices, k, recorder, {
          skipEmitterHit: (depth) => this.smsOwnsEmitterHit(vertices, depth),
        }),
      );

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

  // Does the emitter hit at index k complete an SMS-owned family?
  // m = 1: {non-specular vertex → one delta bounce on an eligible caster,
  // on the prescribed branch → emitter}. m = 2 (V5b, when chains are on):
  // {non-specular vertex → two delta TRANSMISSIONS on the SAME eligible
  // dielectric caster → emitter}. Exactly those contributions are zeroed
  // here — SMS supplies them. A delta bounce on the wrong branch (e.g.
  // the reflection lobe of glass) keeps its BSDF contribution: the
  // partition must stay exhaustive, and the suppression predicate must
  // match the attempted chain types precisely (design-v5 §V5b case (c)).
  private smsOwnsEmitterHit(vertices: readonly PathVertex[], k: number): boolean {
    const eligible = (v: PathVertex): CasterBxDF | null => {
      if (!v.delta || !v.primitive || !v.wo || !v.wiSampled) return null;
      if (v.primitive.light !== null || v.primitive.shape instanceof TriangleMesh) return null;
      return asCasterBxDF(v.primitive.bxdf);
    };
    const transmission = (v: PathVertex): boolean =>
      v.wo!.dot(v.ng) * v.wiSampled!.dot(v.ng) < 0;

    if (k >= 2) {
      const spec = vertices[k - 1]!;
      const diffuse = vertices[k - 2]!;
      const casterBxdf = eligible(spec);
      if (
        casterBxdf &&
        diffuse.bsdf &&
        hasNonSpecular(diffuse.bsdf.flags) &&
        (casterBxdf.manifoldEta !== 1 ? transmission(spec) : !transmission(spec))
      ) {
        return true;
      }
    }
    if (this.options.chains && k >= 3) {
      const s2 = vertices[k - 1]!;
      const s1 = vertices[k - 2]!;
      const diffuse = vertices[k - 3]!;
      const b2 = eligible(s2);
      const b1 = eligible(s1);
      if (
        b1 &&
        b2 &&
        s1.primitive === s2.primitive &&
        b1.manifoldEta !== 1 &&
        diffuse.bsdf &&
        hasNonSpecular(diffuse.bsdf.flags) &&
        transmission(s1) &&
        transmission(s2)
      ) {
        return true;
      }
    }
    return false;
  }
}

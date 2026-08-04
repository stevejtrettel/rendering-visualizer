// Multi-vertex specular chains (V5b): the block-tridiagonal
// generalization of the single-bounce manifold walk. Each vertex's
// constraint involves only itself and its two neighbors (sms-theory
// §12.3), so dC/dX has 2×2 blocks A_i = ∂C_i/∂x_{i−1}, B_i = ∂C_i/∂x_i,
// N_i = ∂C_i/∂x_{i+1}, and the Newton step is a ~30-line block LU sweep
// (Cycles mnee_solve_matrix_h_to_x; MNEE eq. 8 gives the generalized G
// out of the same factorization as a transfer matrix).
//
// The single-bounce module (newton.ts) stays untouched beside this one.
// Constraint blocks follow manifold_ss.cpp's geometric_term exactly —
// its dc1_dx0/dc1_dx1/dc1_dx2 ARE the chain blocks; C uses the same
// unnormalized projected tangents as the block rows, so the row scaling
// cancels in the solve. The half-vector form is the chain default (the
// agreed deterministic straight-line seed lands near the root, where it
// is exact); the angle-difference variant is per-vertex with each
// vertex's prescribed branch.
import { Vec3, absDot } from '../math/vec3';
import { Ray } from '../math/ray';
import type { Aggregate, Intersection, Primitive } from '../geometry/aggregate';
import { RAY_EPSILON, SHADOW_EPSILON, offsetRayOrigin } from '../geometry/offset';
import { Mat2 } from './mat2';
import { ManifoldVertex } from './vertex';
import {
  DET_GUARD,
  dSphcoords,
  dReflect,
  dRefract,
  reflect,
  refract,
  sphcoords,
  type ConstraintType,
} from './constraints';
import { G_RATIO_CLAMP } from './geometry-term';
import type { ManifoldWalkOptions, ManifoldWalkOutcome } from './newton';

const MIN_EDGE_LENGTH = 1e-3;

// The discrete chain type, receiver → light order: which primitive each
// vertex lies on and the prescribed relative IOR of its event (V5b
// scope: refraction only, eta ≠ 1).
export interface ChainLink {
  primitive: Primitive;
  eta: number;
}

// One vertex's constraint value and blocks. dPrev/dNext are null at the
// fixed endpoints (receiver, light) unless a frame is supplied for them
// (the transfer matrix supplies the light's).
interface VertexBlocks {
  C: [number, number];
  dSelf: Mat2;
  dPrev: Mat2 | null;
  dNext: Mat2 | null;
}

interface NeighborFrame {
  dpdu: Vec3;
  dpdv: Vec3;
}

// --- half-vector blocks (geometric_term's recipe, per vertex) ---

function halfvectorBlocks(
  v: ManifoldVertex,
  prevP: Vec3,
  nextP: Vec3,
  prevFrame: NeighborFrame | null,
  nextFrame: NeighborFrame | null,
): VertexBlocks | null {
  let wi = prevP.sub(v.p);
  let ili = wi.length();
  if (ili < MIN_EDGE_LENGTH) return null;
  ili = 1 / ili;
  wi = wi.scale(ili);

  let wo = nextP.sub(v.p);
  let ilo = wo.length();
  if (ilo < MIN_EDGE_LENGTH) return null;
  ilo = 1 / ilo;
  wo = wo.scale(ilo);

  let eta = v.eta;
  if (wi.dot(v.ng) < 0) eta = 1 / eta;
  let h = wi.add(wo.scale(eta));
  if (eta !== 1) h = h.neg();
  const ilh = 1 / h.length();
  h = h.scale(ilh);

  const iliS = ili * ilh;
  const iloS = eta * ilo * ilh;

  const dotDpduN = v.dpdu.dot(v.n);
  const dotDpdvN = v.dpdv.dot(v.n);
  const s = v.dpdu.sub(v.n.scale(dotDpduN));
  const t = v.dpdv.sub(v.n.scale(dotDpdvN));

  const project = (d: Vec3): Vec3 => {
    let out = d.sub(h.scale(d.dot(h)));
    if (eta !== 1) out = out.neg();
    return out;
  };

  // Self block, with the normal-derivative correction terms.
  let dhdu = v.dpdu
    .scale(-(iliS + iloS))
    .add(wi.scale(wi.dot(v.dpdu) * iliS))
    .add(wo.scale(wo.dot(v.dpdu) * iloS));
  let dhdv = v.dpdv
    .scale(-(iliS + iloS))
    .add(wi.scale(wi.dot(v.dpdv) * iliS))
    .add(wo.scale(wo.dot(v.dpdv) * iloS));
  dhdu = project(dhdu);
  dhdv = project(dhdv);
  const dotHN = h.dot(v.n);
  const dotHDndu = h.dot(v.dndu);
  const dotHDndv = h.dot(v.dndv);
  const dSelf = new Mat2(
    dhdu.dot(s) - v.dpdu.dot(v.dndu) * dotHN - dotDpduN * dotHDndu,
    dhdv.dot(s) - v.dpdu.dot(v.dndv) * dotHN - dotDpduN * dotHDndv,
    dhdu.dot(t) - v.dpdv.dot(v.dndu) * dotHN - dotDpdvN * dotHDndu,
    dhdv.dot(t) - v.dpdv.dot(v.dndv) * dotHN - dotDpdvN * dotHDndv,
  );

  const neighborBlock = (frame: NeighborFrame, w: Vec3, ilS: number): Mat2 => {
    const du = project(frame.dpdu.sub(w.scale(w.dot(frame.dpdu))).scale(ilS));
    const dv = project(frame.dpdv.sub(w.scale(w.dot(frame.dpdv))).scale(ilS));
    return new Mat2(du.dot(s), dv.dot(s), du.dot(t), dv.dot(t));
  };

  return {
    C: [s.dot(h), t.dot(h)],
    dSelf,
    dPrev: prevFrame ? neighborBlock(prevFrame, wi, iliS) : null,
    dNext: nextFrame ? neighborBlock(nextFrame, wo, iloS) : null,
  };
}

// --- angle-difference blocks (per-vertex prescribed branch) ---

function anglediffBlocks(
  v: ManifoldVertex,
  prevP: Vec3,
  nextP: Vec3,
  prevFrame: NeighborFrame | null,
  nextFrame: NeighborFrame | null,
): VertexBlocks | null {
  let wi = prevP.sub(v.p);
  let ili = wi.length();
  if (ili < MIN_EDGE_LENGTH) return null;
  ili = 1 / ili;
  wi = wi.scale(ili);

  let wo = nextP.sub(v.p);
  let ilo = wo.length();
  if (ilo < MIN_EDGE_LENGTH) return null;
  ilo = 1 / ilo;
  wo = wo.scale(ilo);

  const dwiSelfU = v.dpdu.sub(wi.scale(wi.dot(v.dpdu))).scale(-ili);
  const dwiSelfV = v.dpdv.sub(wi.scale(wi.dot(v.dpdv))).scale(-ili);
  const dwoSelfU = v.dpdu.sub(wo.scale(wo.dot(v.dpdu))).scale(-ilo);
  const dwoSelfV = v.dpdv.sub(wo.scale(wo.dot(v.dpdv))).scale(-ilo);

  const transform = (w: Vec3): Vec3 | null => (v.eta === 1 ? reflect(w, v.n) : refract(w, v.n, v.eta));
  const dT = (w: Vec3, dwdu: Vec3, dwdv: Vec3, dndu: Vec3, dndv: Vec3): [Vec3, Vec3] =>
    v.eta === 1
      ? dReflect(w, dwdu, dwdv, v.n, dndu, dndv)
      : dRefract(w, dwdu, dwdv, v.n, dndu, dndv, v.eta);

  const wrap = (dp: number): number => {
    if (dp < -Math.PI) return dp + 2 * Math.PI;
    if (dp > Math.PI) return dp - 2 * Math.PI;
    return dp;
  };

  const wio = transform(wi);
  if (wio) {
    const [to, po] = sphcoords(wo);
    const [tio, pio] = sphcoords(wio);
    const C: [number, number] = [to - tio, wrap(po - pio)];

    // Self: wi, wo, AND n all move with the vertex.
    const [dwioSelfU, dwioSelfV] = dT(wi, dwiSelfU, dwiSelfV, v.dndu, v.dndv);
    const [dtoU, dpoU, dtoV, dpoV] = dSphcoords(wo, dwoSelfU, dwoSelfV);
    const [dtioU, dpioU, dtioV, dpioV] = dSphcoords(wio, dwioSelfU, dwioSelfV);
    const dSelf = new Mat2(dtoU - dtioU, dtoV - dtioV, dpoU - dpioU, dpoV - dpioV);

    // Prev: only wi moves (n fixed).
    let dPrev: Mat2 | null = null;
    if (prevFrame) {
      const du = prevFrame.dpdu.sub(wi.scale(wi.dot(prevFrame.dpdu))).scale(ili);
      const dv = prevFrame.dpdv.sub(wi.scale(wi.dot(prevFrame.dpdv))).scale(ili);
      const [dwioU, dwioV] = dT(wi, du, dv, Vec3.ZERO, Vec3.ZERO);
      const [a, b, c, d] = dSphcoords(wio, dwioU, dwioV);
      dPrev = new Mat2(-a, -c, -b, -d);
    }

    // Next: only wo moves.
    let dNext: Mat2 | null = null;
    if (nextFrame) {
      const du = nextFrame.dpdu.sub(wo.scale(wo.dot(nextFrame.dpdu))).scale(ilo);
      const dv = nextFrame.dpdv.sub(wo.scale(wo.dot(nextFrame.dpdv))).scale(ilo);
      const [a, b, c, d] = dSphcoords(wo, du, dv);
      dNext = new Mat2(a, c, b, d);
    }
    return { C, dSelf, dPrev, dNext };
  }

  // TIR of the wi side mid-walk: transform wo instead, with the roles
  // mirrored (the single-bounce fallback, manifold_ss.cpp:599, applied
  // per vertex).
  const woi = transform(wo);
  if (!woi) return null;
  const [ti, pi] = sphcoords(wi);
  const [toi, poi] = sphcoords(woi);
  const C: [number, number] = [ti - toi, wrap(pi - poi)];

  const [dwoiSelfU, dwoiSelfV] = dT(wo, dwoSelfU, dwoSelfV, v.dndu, v.dndv);
  const [dtiU, dpiU, dtiV, dpiV] = dSphcoords(wi, dwiSelfU, dwiSelfV);
  const [dtoiU, dpoiU, dtoiV, dpoiV] = dSphcoords(woi, dwoiSelfU, dwoiSelfV);
  const dSelf = new Mat2(dtiU - dtoiU, dtiV - dtoiV, dpiU - dpoiU, dpiV - dpoiV);

  let dPrev: Mat2 | null = null;
  if (prevFrame) {
    const du = prevFrame.dpdu.sub(wi.scale(wi.dot(prevFrame.dpdu))).scale(ili);
    const dv = prevFrame.dpdv.sub(wi.scale(wi.dot(prevFrame.dpdv))).scale(ili);
    const [a, b, c, d] = dSphcoords(wi, du, dv);
    dPrev = new Mat2(a, c, b, d);
  }
  let dNext: Mat2 | null = null;
  if (nextFrame) {
    const du = nextFrame.dpdu.sub(wo.scale(wo.dot(nextFrame.dpdu))).scale(ilo);
    const dv = nextFrame.dpdv.sub(wo.scale(wo.dot(nextFrame.dpdv))).scale(ilo);
    const [dwoiU, dwoiV] = dT(wo, du, dv, Vec3.ZERO, Vec3.ZERO);
    const [a, b, c, d] = dSphcoords(woi, dwoiU, dwoiV);
    dNext = new Mat2(-a, -c, -b, -d);
  }
  return { C, dSelf, dPrev, dNext };
}

const blocksOf = (
  constraint: ConstraintType,
  v: ManifoldVertex,
  prevP: Vec3,
  nextP: Vec3,
  prevFrame: NeighborFrame | null,
  nextFrame: NeighborFrame | null,
): VertexBlocks | null =>
  constraint === 'halfvector'
    ? halfvectorBlocks(v, prevP, nextP, prevFrame, nextFrame)
    : anglediffBlocks(v, prevP, nextP, prevFrame, nextFrame);

// --- block-tridiagonal solve (Cycles mnee_solve_matrix_h_to_x) ---

// Solves J·dX = rhs for m vertices, where row i has blocks
// (A_i, B_i, N_i) and rhs_i ∈ R². Returns null when any pivot falls
// under the det guard. Forward-eliminates A, back-substitutes N.
export function solveBlockTridiagonal(
  A: (Mat2 | null)[],
  B: Mat2[],
  N: (Mat2 | null)[],
  rhs: [number, number][],
): [number, number][] | null {
  const m = B.length;
  const Btilde: Mat2[] = [];
  const rtilde: [number, number][] = [];
  for (let i = 0; i < m; i++) {
    let Bi = B[i]!;
    let ri = rhs[i]!;
    const Ai = A[i];
    if (i > 0 && Ai) {
      const inv = Btilde[i - 1]!.inverse(DET_GUARD);
      if (!inv) return null;
      const L = Ai.mul(inv);
      const Nprev = N[i - 1];
      if (Nprev) {
        const LN = L.mul(Nprev);
        Bi = new Mat2(Bi.m00 - LN.m00, Bi.m01 - LN.m01, Bi.m10 - LN.m10, Bi.m11 - LN.m11);
      }
      const [lx, ly] = L.mulVec(rtilde[i - 1]![0], rtilde[i - 1]![1]);
      ri = [ri[0] - lx, ri[1] - ly];
    }
    Btilde.push(Bi);
    rtilde.push(ri);
  }
  const dX: [number, number][] = new Array(m);
  for (let i = m - 1; i >= 0; i--) {
    let ri = rtilde[i]!;
    const Ni = N[i];
    if (i < m - 1 && Ni) {
      const [nx, ny] = Ni.mulVec(dX[i + 1]![0], dX[i + 1]![1]);
      ri = [ri[0] - nx, ri[1] - ny];
    }
    const inv = Btilde[i]!.inverse(DET_GUARD);
    if (!inv) return null;
    dX[i] = inv.mulVec(ri[0], ri[1]);
  }
  return dX;
}

// --- the chain walk ---

export interface ChainWalkResult {
  outcome: ManifoldWalkOutcome;
  vertices: ManifoldVertex[] | null; // non-null iff converged
  iterates: { chain: Vec3[]; cNorm: number }[];
}

// Refracted-continuation seed: aim receiver → target, but BEND by Snell
// at each crossing instead of marching straight through. The seed chain
// then satisfies the constraint EXACTLY at every vertex but the last —
// half the system starts solved, and Newton starts one basin away
// instead of an ior-bend away (measured: the straight-line seed's zone
// success was ~5–9% and solver knobs were flat; the bend is what the
// straight line is missing). Null when the bent line does not cross the
// prescribed sequence (TIR included) — legitimate failure mass.
export function chainSeed(
  receiverP: Vec3,
  target: Vec3,
  links: readonly ChainLink[],
  aggregate: Aggregate,
): Intersection[] | null {
  let dir = target.sub(receiverP).normalize();
  const hits: Intersection[] = [];
  let origin = receiverP;
  for (const [i, link] of links.entries()) {
    const hit = aggregate.intersect(new Ray(origin.add(dir.scale(RAY_EPSILON)), dir));
    if (!hit || hit.primitive !== link.primitive) return null;
    hits.push(hit);
    origin = hit.p;
    if (i < links.length - 1) {
      const bent = link.eta === 1 ? reflect(dir.neg(), hit.ns) : refract(dir.neg(), hit.ns, link.eta);
      if (!bent) return null;
      dir = bent;
    }
  }
  return hits;
}

export function chainWalk(
  receiverP: Vec3,
  seedHits: readonly Intersection[],
  links: readonly ChainLink[],
  lightP: Vec3,
  aggregate: Aggregate,
  options: ManifoldWalkOptions,
): ChainWalkResult {
  const m = links.length;
  let vertices = seedHits.map((h, i) => new ManifoldVertex(h, links[i]!.eta));
  const iterates: { chain: Vec3[]; cNorm: number }[] = [];

  let converged = false;
  let stepFailed = false;
  let projectionFailed = false;
  // Chains start conservatively and ramp up (Cycles mnee_newton_solver:
  // beta = 0.1, doubling on success). A full first step from a straight-
  // line seed on a curved caster overshoots into a stable period-2
  // oscillation — found the hard way; the single-bounce walk's beta = 1
  // is safe only because its seeds are one Newton basin away.
  let beta = 0.1;
  let iterations = 0;

  while (iterations < options.maxIterations) {
    // Assemble blocks; endpoint neighbors (receiver, light) are fixed.
    const A: (Mat2 | null)[] = [];
    const B: Mat2[] = [];
    const N: (Mat2 | null)[] = [];
    const rhs: [number, number][] = [];
    let cNormSq = 0;
    let ok = true;
    for (let i = 0; i < m; i++) {
      const prevP = i === 0 ? receiverP : vertices[i - 1]!.p;
      const nextP = i === m - 1 ? lightP : vertices[i + 1]!.p;
      const prevFrame = i === 0 ? null : { dpdu: vertices[i - 1]!.dpdu, dpdv: vertices[i - 1]!.dpdv };
      const nextFrame = i === m - 1 ? null : { dpdu: vertices[i + 1]!.dpdu, dpdv: vertices[i + 1]!.dpdv };
      const blocks = blocksOf(options.constraint, vertices[i]!, prevP, nextP, prevFrame, nextFrame);
      if (!blocks) {
        ok = false;
        break;
      }
      A.push(blocks.dPrev);
      B.push(blocks.dSelf);
      N.push(blocks.dNext);
      rhs.push(blocks.C);
      cNormSq += blocks.C[0] * blocks.C[0] + blocks.C[1] * blocks.C[1];
    }
    if (!ok) {
      stepFailed = true;
      break;
    }

    const cNorm = Math.sqrt(cNormSq);
    iterates.push({ chain: vertices.map((v) => v.p), cNorm });
    if (cNorm < options.solverThreshold) {
      converged = true;
      break;
    }

    const dX = solveBlockTridiagonal(A, B, N, rhs);
    if (!dX) {
      stepFailed = true;
      break;
    }

    // Propose all vertices, then re-project sequentially: each from its
    // (freshly projected) predecessor (Cycles' scheme).
    const proposed = vertices.map((v, i) =>
      v.p.sub(
        v.dpdu.scale(options.stepScale * beta * dX[i]![0]).add(v.dpdv.scale(options.stepScale * beta * dX[i]![1])),
      ),
    );
    // Re-projection traces against the TARGET PRIMITIVE ONLY (Cycles'
    // scheme): projecting through the aggregate makes every grazing ray
    // from a floor receiver die on the floor it starts on — measured as
    // the dominant failure (57% left-surface) in the caustic zone.
    // Visibility is NOT the projection's job; the final validation
    // checks every edge against the aggregate explicitly.
    const newHits: Intersection[] = [];
    let prevPos = receiverP;
    let failed = false;
    for (let i = 0; i < m; i++) {
      const dir = proposed[i]!.sub(prevPos).normalize();
      const shapeHit = links[i]!.primitive.shape.intersect(new Ray(prevPos.add(dir.scale(RAY_EPSILON)), dir), Infinity);
      if (!shapeHit) {
        failed = true;
        break;
      }
      newHits.push({ ...shapeHit, primitive: links[i]!.primitive });
      prevPos = shapeHit.p;
    }
    // NOTE: no per-step transmissive-configuration guard (Cycles has
    // one; Mitsuba's multi-bounce solver and our m = 1 walk do not).
    // Enforcing it froze walks whose Newton path legitimately passes
    // through side-flipped intermediate states — measured 2/719
    // integrator convergence WITH the guard on the glass box. The final
    // branch validation below is the correctness gate.
    if (failed) {
      projectionFailed = true;
      beta = 0.5 * beta;
      iterations += 1;
      continue;
    }
    projectionFailed = false;
    beta = Math.min(1, 2 * beta);
    vertices = newHits.map((h, i) => new ManifoldVertex(h, links[i]!.eta));
    iterations += 1;
  }

  if (!converged) {
    return {
      outcome: stepFailed ? 'singular' : projectionFailed ? 'left-surface' : 'diverged',
      vertices: null,
      iterates,
    };
  }

  // Branch validation per vertex (the walk enforced it on accepted steps,
  // but the converged state may have arrived at iteration 0).
  for (let i = 0; i < m; i++) {
    const v = vertices[i]!;
    const before = i === 0 ? receiverP : vertices[i - 1]!.p;
    const after = i === m - 1 ? lightP : vertices[i + 1]!.p;
    const refraction = v.ng.dot(before.sub(v.p).normalize()) * v.ng.dot(after.sub(v.p).normalize()) < 0;
    if ((links[i]!.eta === 1 && refraction) || (links[i]!.eta !== 1 && !refraction)) {
      return { outcome: 'invalid-branch', vertices: null, iterates };
    }
  }

  // EVERY edge's visibility against the full aggregate (shape-only
  // projection surrendered the first-hit guarantee). Both segment ends
  // are trimmed along the ray, so the surfaces the edge legitimately
  // touches are excluded and any interior hit is a real blocker.
  const edgeBlocked = (from: Vec3, to: Vec3): boolean => {
    const d = to.sub(from);
    const dist = d.length();
    if (dist < MIN_EDGE_LENGTH) return true;
    const w = d.scale(1 / dist);
    return aggregate.intersectP(new Ray(from.add(w.scale(RAY_EPSILON)), w), dist * (1 - SHADOW_EPSILON));
  };
  if (edgeBlocked(receiverP, vertices[0]!.p)) {
    return { outcome: 'occluded', vertices: null, iterates };
  }
  for (let i = 0; i < m; i++) {
    const to = i === m - 1 ? lightP : vertices[i + 1]!.p;
    if (edgeBlocked(vertices[i]!.p, to)) {
      return { outcome: 'occluded', vertices: null, iterates };
    }
  }

  return { outcome: 'converged', vertices, iterates };
}

// --- generalized G via the transfer matrix ---

// |det ∂x₁/∂x_light| through the whole chain: solve J·δX = −N_light·δb
// for the two light-frame columns and read off δx₁ in x₁'s orthonormal
// frame. All vertices and the light vertex must be makeOrthonormal()'d.
export function chainTransferDet(
  receiverP: Vec3,
  vertices: readonly ManifoldVertex[],
  vLight: ManifoldVertex,
): number | null {
  const m = vertices.length;
  const A: (Mat2 | null)[] = [];
  const B: Mat2[] = [];
  const N: (Mat2 | null)[] = [];
  let lightBlock: Mat2 | null = null;
  for (let i = 0; i < m; i++) {
    const prevP = i === 0 ? receiverP : vertices[i - 1]!.p;
    const nextP = i === m - 1 ? vLight.p : vertices[i + 1]!.p;
    const prevFrame = i === 0 ? null : { dpdu: vertices[i - 1]!.dpdu, dpdv: vertices[i - 1]!.dpdv };
    const nextFrame =
      i === m - 1
        ? { dpdu: vLight.dpdu, dpdv: vLight.dpdv }
        : { dpdu: vertices[i + 1]!.dpdu, dpdv: vertices[i + 1]!.dpdv };
    const blocks = halfvectorBlocks(vertices[i]!, prevP, nextP, prevFrame, nextFrame);
    if (!blocks) return null;
    A.push(blocks.dPrev);
    B.push(blocks.dSelf);
    if (i === m - 1) {
      lightBlock = blocks.dNext;
      N.push(null);
    } else {
      N.push(blocks.dNext);
    }
  }
  if (!lightBlock) return null;

  // Two rhs columns: −(∂C_last/∂light) e_u, e_v.
  const cols: [number, number][] = [];
  for (const [bu, bv] of [
    [lightBlock.m00, lightBlock.m10],
    [lightBlock.m01, lightBlock.m11],
  ] as const) {
    const rhs: [number, number][] = new Array(m).fill([0, 0]) as [number, number][];
    rhs[m - 1] = [-bu, -bv];
    const dX = solveBlockTridiagonal(A, B, N, rhs);
    if (!dX) return null;
    cols.push(dX[0]!);
  }
  return Math.abs(cols[0]![0] * cols[1]![1] - cols[1]![0] * cols[0]![1]);
}

// The full generalized G for the chain: area at the light → solid angle
// at the receiver, clamped like the single-bounce version.
export function chainGeometricTerm(
  receiverP: Vec3,
  vertices: readonly ManifoldVertex[],
  vLight: ManifoldVertex,
): number {
  const det = chainTransferDet(receiverP, vertices, vLight);
  if (det === null) return 0;
  const first = vertices[0]!;
  const d = receiverP.sub(first.p);
  const invR2 = 1 / d.lengthSq();
  const dw0dx1 = absDot(d.scale(Math.sqrt(invR2)), first.ng) * invR2;
  return dw0dx1 * Math.min(det, G_RATIO_CLAMP);
}

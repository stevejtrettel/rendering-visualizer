// The two constraint formulations of the specular manifold, with their
// 2×2 Jacobians and Newton steps. Both describe the same physical zero
// set — h ∥ n (reflection) or Snell's law (refraction) at the specular
// vertex — with very different numerical behavior:
//
// - 'halfvector' (Jakob & Marschner 2012, MNEE, Cycles): C = the two
//   tangential components of the generalized half-vector. Cannot tell a
//   reflection-like root from a refraction-like one — the walk's
//   post-solve branch validation rejects the impostors.
// - 'anglediff' (SMS 2020 §4.4, the release default): scatter wi through
//   the PRESCRIBED branch and measure the spherical-coordinate difference
//   to wo. Removes the branch ambiguity; Newton success rates with random
//   seeds improve severalfold (paper Fig. 8). The Δφ wrap into [−π, π] is
//   load-bearing (2021 erratum).
//
// Ported from manifold_ss.cpp (compute_step_halfvector:410–492,
// compute_step_anglediff:497–636) and manifold.h (reflect/refract helpers
// and their derivatives, 347–444), area-light case (fixed emitter
// position). The offset-normal arguments are the rough-caster hook
// (design-v5 planned follow-up): [0, 0, 1] is the smooth no-op.
import { Vec3 } from '../math/vec3';
import { Mat2 } from './mat2';
import type { ManifoldVertex } from './vertex';

export type ConstraintType = 'halfvector' | 'anglediff';

// Below this |det| the constraint Jacobian is treated as singular
// (manifold_ss.cpp:479, 628).
export const DET_GUARD = 1e-6;

// Degenerate-configuration guard on edge lengths (manifold_ss.cpp:424).
const MIN_EDGE_LENGTH = 1e-3;

export interface ConstraintStep {
  C: [number, number]; // constraint residual
  dX: [number, number]; // Newton step in (u, v), to be SUBTRACTED
  J: Mat2; // dC/d(u,v) — exposed for the geometry factor and tests
}

export function reflect(w: Vec3, n: Vec3): Vec3 {
  return n.scale(2 * w.dot(n)).sub(w);
}

export function dReflect(
  w: Vec3,
  dwdu: Vec3,
  dwdv: Vec3,
  n: Vec3,
  dndu: Vec3,
  dndv: Vec3,
): [Vec3, Vec3] {
  const dotWN = w.dot(n);
  const du = n
    .scale(2 * (dwdu.dot(n) + w.dot(dndu)))
    .add(dndu.scale(2 * dotWN))
    .sub(dwdu);
  const dv = n
    .scale(2 * (dwdv.dot(n) + w.dot(dndv)))
    .add(dndv.scale(2 * dotWN))
    .sub(dwdv);
  return [du, dv];
}

// Refract w about n with relative IOR eta (interior/exterior, the vertex
// convention); handles arrival from either side. Null on total internal
// reflection.
export function refract(w: Vec3, n_: Vec3, eta_: number): Vec3 | null {
  let n = n_;
  let eta = 1 / eta_;
  if (w.dot(n) < 0) {
    eta = 1 / eta;
    n = n.neg();
  }
  const dotWN = w.dot(n);
  const rootTerm = 1 - eta * eta * (1 - dotWN * dotWN);
  if (rootTerm < 0) return null;
  return w
    .sub(n.scale(dotWN))
    .scale(-eta)
    .sub(n.scale(Math.sqrt(rootTerm)));
}

export function dRefract(
  w: Vec3,
  dwdu: Vec3,
  dwdv: Vec3,
  n_: Vec3,
  dndu_: Vec3,
  dndv_: Vec3,
  eta_: number,
): [Vec3, Vec3] {
  let n = n_;
  let dndu = dndu_;
  let dndv = dndv_;
  let eta = 1 / eta_;
  if (w.dot(n) < 0) {
    eta = 1 / eta;
    n = n.neg();
    dndu = dndu.neg();
    dndv = dndv.neg();
  }
  const dotWN = w.dot(n);
  const dotDwduN = dwdu.dot(n);
  const dotDwdvN = dwdv.dot(n);
  const dotWDndu = w.dot(dndu);
  const dotWDndv = w.dot(dndv);
  const root = Math.sqrt(1 - eta * eta * (1 - dotWN * dotWN));

  const aU = dwdu.sub(n.scale(dotDwduN + dotWDndu).add(dndu.scale(dotWN))).scale(-eta);
  const b1U = dndu.scale(root);
  const b2U = n.scale((1 / (2 * root)) * (-eta * eta * -2 * dotWN * (dotDwduN + dotWDndu)));
  const aV = dwdv.sub(n.scale(dotDwdvN + dotWDndv).add(dndv.scale(dotWN))).scale(-eta);
  const b1V = dndv.scale(root);
  const b2V = n.scale((1 / (2 * root)) * (-eta * eta * -2 * dotWN * (dotDwdvN + dotWDndv)));

  return [aU.sub(b1U.add(b2U)), aV.sub(b1V.add(b2V))];
}

export function sphcoords(w: Vec3): [number, number] {
  const theta = Math.acos(Math.min(1, Math.max(-1, w.z)));
  let phi = Math.atan2(w.y, w.x);
  if (phi < 0) phi += 2 * Math.PI;
  return [theta, phi];
}

// (dθ/du, dφ/du, dθ/dv, dφ/dv). The φ derivative uses the combined form
// (x·dy − y·dx)/(x² + y²) — algebraically identical to the reference's
// atan2 chain where x ≠ 0 and well-defined on the whole circle (the
// reference zeroes the x = 0 case; the FD tests pin this form).
export function dSphcoords(w: Vec3, dwdu: Vec3, dwdv: Vec3): [number, number, number, number] {
  const oneMinusZ2 = 1 - w.z * w.z;
  let dThetaDu = 0;
  let dThetaDv = 0;
  if (oneMinusZ2 > 0) {
    const dAcos = -1 / Math.sqrt(oneMinusZ2);
    dThetaDu = dAcos * dwdu.z;
    dThetaDv = dAcos * dwdv.z;
  }
  const r2 = w.x * w.x + w.y * w.y;
  let dPhiDu = 0;
  let dPhiDv = 0;
  if (r2 > 0) {
    dPhiDu = (w.x * dwdu.y - w.y * dwdu.x) / r2;
    dPhiDv = (w.x * dwdv.y - w.y * dwdv.x) / r2;
  }
  return [dThetaDu, dPhiDu, dThetaDv, dPhiDv];
}

// Half-vector constraint step at specular vertex v between receiver point
// a and light point b (both fixed).
export function computeStepHalfvector(
  a: Vec3,
  v: ManifoldVertex,
  b: Vec3,
  nOffset: [number, number] = [0, 0],
): ConstraintStep | null {
  let wo = b.sub(v.p);
  let ilo = wo.length();
  if (ilo < MIN_EDGE_LENGTH) return null;
  ilo = 1 / ilo;
  wo = wo.scale(ilo);

  let wi = a.sub(v.p);
  let ili = wi.length();
  if (ili < MIN_EDGE_LENGTH) return null;
  ili = 1 / ili;
  wi = wi.scale(ili);

  // Generalized half-vector, flipped toward the normal for refraction.
  let eta = v.eta;
  if (wi.dot(v.ng) < 0) eta = 1 / eta;
  let h = wi.add(wo.scale(eta));
  if (eta !== 1) h = h.neg();
  const ilh = 1 / h.length();
  h = h.scale(ilh);

  ilo *= eta * ilh;
  ili *= ilh;

  // dh/d(u,v): the vertex's own motion changes both unit vectors.
  let dhdu = v.dpdu
    .scale(-(ili + ilo))
    .add(wi.scale(wi.dot(v.dpdu) * ili))
    .add(wo.scale(wo.dot(v.dpdu) * ilo));
  let dhdv = v.dpdv
    .scale(-(ili + ilo))
    .add(wi.scale(wi.dot(v.dpdv) * ili))
    .add(wo.scale(wo.dot(v.dpdv) * ilo));
  dhdu = dhdu.sub(h.scale(dhdu.dot(h)));
  dhdv = dhdv.sub(h.scale(dhdv.dot(h)));
  if (eta !== 1) {
    dhdu = dhdu.neg();
    dhdv = dhdv.neg();
  }

  const J = new Mat2(
    v.dsdu.dot(h) + v.s.dot(dhdu),
    v.dsdv.dot(h) + v.s.dot(dhdv),
    v.dtdu.dot(h) + v.t.dot(dhdu),
    v.dtdv.dot(h) + v.t.dot(dhdv),
  );
  const Jinv = J.inverse(DET_GUARD);
  if (!Jinv) return null;

  const C: [number, number] = [v.s.dot(h) - nOffset[0], v.t.dot(h) - nOffset[1]];
  const dX = Jinv.mulVec(C[0], C[1]);
  return { C, dX, J };
}

// Angle-difference constraint step: scatter wi through the prescribed
// branch (reflect for eta = 1, refract otherwise) and compare against wo
// in spherical coordinates. On TIR of the wi side, retries transforming
// wo instead (manifold_ss.cpp:599).
export function computeStepAnglediff(
  a: Vec3,
  v: ManifoldVertex,
  b: Vec3,
  nOffset3: [number, number, number] = [0, 0, 1],
): ConstraintStep | null {
  let wi = a.sub(v.p);
  let ili = wi.length();
  if (ili < MIN_EDGE_LENGTH) return null;
  ili = 1 / ili;
  wi = wi.scale(ili);
  const dwiDu = v.dpdu.sub(wi.scale(wi.dot(v.dpdu))).scale(-ili);
  const dwiDv = v.dpdv.sub(wi.scale(wi.dot(v.dpdv))).scale(-ili);

  let wo = b.sub(v.p);
  let ilo = wo.length();
  if (ilo < MIN_EDGE_LENGTH) return null;
  ilo = 1 / ilo;
  wo = wo.scale(ilo);
  const dwoDu = v.dpdu.sub(wo.scale(wo.dot(v.dpdu))).scale(-ilo);
  const dwoDv = v.dpdv.sub(wo.scale(wo.dot(v.dpdv))).scale(-ilo);

  // Offset normal folded into the frame (no-op at [0, 0, 1]).
  const n = v.s.scale(nOffset3[0]).add(v.t.scale(nOffset3[1])).add(v.n.scale(nOffset3[2]));
  const dndu = v.dsdu
    .scale(nOffset3[0])
    .add(v.dtdu.scale(nOffset3[1]))
    .add(v.dndu.scale(nOffset3[2]));
  const dndv = v.dsdv
    .scale(nOffset3[0])
    .add(v.dtdv.scale(nOffset3[1]))
    .add(v.dndv.scale(nOffset3[2]));

  const transform = (w: Vec3): Vec3 | null =>
    v.eta === 1 ? reflect(w, n) : refract(w, n, v.eta);
  const dTransform = (w: Vec3, dwdu: Vec3, dwdv: Vec3): [Vec3, Vec3] =>
    v.eta === 1 ? dReflect(w, dwdu, dwdv, n, dndu, dndv) : dRefract(w, dwdu, dwdv, n, dndu, dndv, v.eta);

  const wrap = (dp: number): number => {
    if (dp < -Math.PI) return dp + 2 * Math.PI;
    if (dp > Math.PI) return dp - 2 * Math.PI;
    return dp;
  };

  let C: [number, number] | null = null;
  let J: Mat2 | null = null;

  const wio = transform(wi);
  if (wio) {
    const [dwioDu, dwioDv] = dTransform(wi, dwiDu, dwiDv);
    const [to, po] = sphcoords(wo);
    const [tio, pio] = sphcoords(wio);
    C = [to - tio, wrap(po - pio)];
    const [dtoDu, dpoDu, dtoDv, dpoDv] = dSphcoords(wo, dwoDu, dwoDv);
    const [dtioDu, dpioDu, dtioDv, dpioDv] = dSphcoords(wio, dwioDu, dwioDv);
    J = new Mat2(dtoDu - dtioDu, dtoDv - dtioDv, dpoDu - dpioDu, dpoDv - dpioDv);
  } else {
    const woi = transform(wo);
    if (!woi) return null; // TIR both ways: no valid configuration here
    const [dwoiDu, dwoiDv] = dTransform(wo, dwoDu, dwoDv);
    const [ti, pi] = sphcoords(wi);
    const [toi, poi] = sphcoords(woi);
    C = [ti - toi, wrap(pi - poi)];
    const [dtiDu, dpiDu, dtiDv, dpiDv] = dSphcoords(wi, dwiDu, dwiDv);
    const [dtoiDu, dpoiDu, dtoiDv, dpoiDv] = dSphcoords(woi, dwoiDu, dwoiDv);
    J = new Mat2(dtiDu - dtoiDu, dtiDv - dtoiDv, dpiDu - dpoiDu, dpiDv - dpoiDv);
  }

  const Jinv = J.inverse(DET_GUARD);
  if (!Jinv) return null;
  const dX = Jinv.mulVec(C[0], C[1]);
  return { C, dX, J };
}

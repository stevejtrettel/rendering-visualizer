// A vertex of a specular chain, carrying the local differential geometry
// the Newton solver and the generalized geometry factor consume: position
// and shading-normal partials from the hit record, plus an orthonormal
// tangent frame WITH derivatives (the frame derivatives are where surface
// curvature enters the half-vector constraint Jacobian).
//
// Ported from the SMS release (manifold.h, ManifoldVertex) with the frame
// construction of Cycles' mnee_setup_manifold_vertex: s is the tangent-
// plane projection of dpdu, t = n × s, and the frame derivatives are
// derived from dndu/dndv treating d(dpdu)/du as zero. That approximation
// drops second-order position terms, but their normal components cancel
// exactly (differentiate ⟨s, n⟩ ≡ 0), so at a converged solution — where
// the constraint and the geometry factor are evaluated — the Jacobian is
// exact; away from solutions the step is quasi-Newton.
import { Vec3 } from '../math/vec3';
import { OrthonormalBasis } from '../math/onb';

// The slice of ShapeIntersection the manifold machinery needs — kept
// structural so tests can build vertices without a Shape (light quads,
// synthetic endpoints).
export interface ManifoldGeometry {
  p: Vec3;
  ns: Vec3;
  ng: Vec3;
  dpdu: Vec3;
  dpdv: Vec3;
  dndu: Vec3;
  dndv: Vec3;
}

export class ManifoldVertex {
  p: Vec3;
  dpdu: Vec3;
  dpdv: Vec3;
  n: Vec3; // shading normal
  ng: Vec3;
  dndu: Vec3;
  dndv: Vec3;

  // eta convention (Mitsuba's): 1 means the prescribed event is a
  // REFLECTION; anything else means REFRACTION with that relative IOR
  // (interior/exterior). The branch is part of the discrete path type —
  // the solver never changes it, only rejects solutions that violate it.
  readonly eta: number;

  // Orthonormal shading tangent frame and its derivatives.
  s: Vec3;
  t: Vec3;
  dsdu: Vec3;
  dsdv: Vec3;
  dtdu: Vec3;
  dtdv: Vec3;

  constructor(g: ManifoldGeometry, eta: number) {
    this.p = g.p;
    this.dpdu = g.dpdu;
    this.dpdv = g.dpdv;
    this.n = g.ns;
    // Keep geometric and shading normals on the same side (manifold.h:112).
    this.ng = g.ng.dot(g.ns) < 0 ? g.ng.neg() : g.ng;
    this.dndu = g.dndu;
    this.dndv = g.dndv;
    this.eta = eta;

    const n = this.n;
    const sRaw = g.dpdu.sub(n.scale(n.dot(g.dpdu)));
    const sLen = sRaw.length();
    if (sLen < 1e-12) {
      // Degenerate parameterization (e.g. sphere pole): fall back to an
      // arbitrary frame with no curvature information. The Newton step's
      // determinant guard treats it as singular if it matters.
      const onb = OrthonormalBasis.fromZ(n);
      this.s = onb.u;
      this.t = onb.v;
      this.dsdu = this.dsdv = this.dtdu = this.dtdv = Vec3.ZERO;
      return;
    }
    const invSLen = 1 / sLen;
    const s = sRaw.scale(invSLen);
    const t = n.cross(s);
    this.s = s;
    this.t = t;

    // d/du of sRaw = dpdu − n⟨n, dpdu⟩ with dpdu held fixed (see header).
    const dotNdpdu = n.dot(g.dpdu);
    const dsRawDu = g.dndu.scale(-dotNdpdu).sub(n.scale(g.dndu.dot(g.dpdu)));
    const dsRawDv = g.dndv.scale(-dotNdpdu).sub(n.scale(g.dndv.dot(g.dpdu)));
    this.dsdu = dsRawDu.sub(s.scale(s.dot(dsRawDu))).scale(invSLen);
    this.dsdv = dsRawDv.sub(s.scale(s.dot(dsRawDv))).scale(invSLen);
    this.dtdu = g.dndu.cross(s).add(n.cross(this.dsdu));
    this.dtdv = g.dndv.cross(s).add(n.cross(this.dsdv));
  }

  // Re-express the (u, v) parameterization as orthonormal at p by
  // Gram–Schmidt on the position partials, applying the SAME transform to
  // the normal partials (manifold.h, make_orthonormal). The generalized
  // geometry factor needs this: with orthonormal parameterizations at
  // every vertex, parametric determinants equal area determinants, so the
  // det-ratio reads as an area-to-area Jacobian.
  makeOrthonormal(): void {
    let invNorm = 1 / this.dpdu.length();
    this.dpdu = this.dpdu.scale(invNorm);
    this.dndu = this.dndu.scale(invNorm);
    const dp = this.dpdu.dot(this.dpdv);
    const dpdvTmp = this.dpdv.sub(this.dpdu.scale(dp));
    const dndvTmp = this.dndv.sub(this.dndu.scale(dp));
    invNorm = 1 / dpdvTmp.length();
    this.dpdv = dpdvTmp.scale(invNorm);
    this.dndv = dndvTmp.scale(invNorm);
  }
}

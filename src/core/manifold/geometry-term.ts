// The generalized geometry factor of a single-bounce specular chain
// x0 (receiver) ↔ x1 (specular vertex) ↔ x2 (light): |dω₀/dx₂|, the solid
// angle at the receiver swept per unit area at the light, factored as
// |dω₀/dx₁| · |det((∂C/∂x₁)⁻¹ · ∂C/∂x₂)| — the same constraint Jacobian
// the Newton solver builds, evaluated at the root (sms-theory §12.5: this
// is J_π⁻¹, the GEOMETRIC correction; the solver's discovery probability
// is accounted for separately).
//
// Ported from manifold_ss.cpp (geometric_term:695–857), area-light case.
// ALL vertices must be makeOrthonormal()'d first so the parametric
// determinant reads as an area-to-area Jacobian. The determinant ratio is
// numerically unstable near folds — which is exactly the caustic — so
// every implementation clamps it (Mitsuba: 1, Cycles: 2); we follow
// Mitsuba. The unclamped ratio is exported for the fold visualization.
import { absDot } from '../math/vec3';
import { Mat2 } from './mat2';
import { DET_GUARD } from './constraints';
import type { ManifoldVertex } from './vertex';

export const G_RATIO_CLAMP = 1;

const MIN_EDGE_LENGTH = 1e-3;

// |det((∂C/∂x₁)⁻¹ · ∂C/∂x₂)| — unclamped; null when degenerate/singular.
export function specularManifoldDetRatio(
  v0: ManifoldVertex,
  v1: ManifoldVertex,
  v2: ManifoldVertex,
): number | null {
  let wi = v0.p.sub(v1.p);
  let ili = wi.length();
  if (ili < MIN_EDGE_LENGTH) return null;
  ili = 1 / ili;
  wi = wi.scale(ili);

  let wo = v2.p.sub(v1.p);
  let ilo = wo.length();
  if (ilo < MIN_EDGE_LENGTH) return null;
  ilo = 1 / ilo;
  wo = wo.scale(ilo);

  let eta = v1.eta;
  if (wi.dot(v1.ng) < 0) eta = 1 / eta;
  let h = wi.add(wo.scale(eta));
  if (eta !== 1) h = h.neg();
  const ilh = 1 / h.length();
  h = h.scale(ilh);

  ilo *= eta * ilh;
  ili *= ilh;

  // Local shading tangents — unnormalized projections, per the reference:
  // the u/v parameterization scale cancels between the two blocks.
  const dotDpduN = v1.dpdu.dot(v1.n);
  const dotDpdvN = v1.dpdv.dot(v1.n);
  const s = v1.dpdu.sub(v1.n.scale(dotDpduN));
  const t = v1.dpdv.sub(v1.n.scale(dotDpdvN));

  // ∂C/∂x₁ (with the normal-derivative correction terms).
  let dhdu = v1.dpdu
    .scale(-(ili + ilo))
    .add(wi.scale(wi.dot(v1.dpdu) * ili))
    .add(wo.scale(wo.dot(v1.dpdu) * ilo));
  let dhdv = v1.dpdv
    .scale(-(ili + ilo))
    .add(wi.scale(wi.dot(v1.dpdv) * ili))
    .add(wo.scale(wo.dot(v1.dpdv) * ilo));
  dhdu = dhdu.sub(h.scale(dhdu.dot(h)));
  dhdv = dhdv.sub(h.scale(dhdv.dot(h)));
  if (eta !== 1) {
    dhdu = dhdu.neg();
    dhdv = dhdv.neg();
  }
  const dotHN = h.dot(v1.n);
  const dotHDndu = h.dot(v1.dndu);
  const dotHDndv = h.dot(v1.dndv);
  const dc1dx1 = new Mat2(
    dhdu.dot(s) - v1.dpdu.dot(v1.dndu) * dotHN - dotDpduN * dotHDndu,
    dhdv.dot(s) - v1.dpdu.dot(v1.dndv) * dotHN - dotDpduN * dotHDndv,
    dhdu.dot(t) - v1.dpdv.dot(v1.dndu) * dotHN - dotDpdvN * dotHDndu,
    dhdv.dot(t) - v1.dpdv.dot(v1.dndv) * dotHN - dotDpdvN * dotHDndv,
  );

  // ∂C/∂x₂ (moving the light point).
  let dhdu2 = v2.dpdu.sub(wo.scale(wo.dot(v2.dpdu))).scale(ilo);
  let dhdv2 = v2.dpdv.sub(wo.scale(wo.dot(v2.dpdv))).scale(ilo);
  dhdu2 = dhdu2.sub(h.scale(dhdu2.dot(h)));
  dhdv2 = dhdv2.sub(h.scale(dhdv2.dot(h)));
  if (eta !== 1) {
    dhdu2 = dhdu2.neg();
    dhdv2 = dhdv2.neg();
  }
  const dc1dx2 = new Mat2(dhdu2.dot(s), dhdv2.dot(s), dhdu2.dot(t), dhdv2.dot(t));

  const inv = dc1dx1.inverse(DET_GUARD);
  if (!inv) return null;
  return Math.abs(inv.mul(dc1dx2).det());
}

// The full generalized G (area measure at the light → solid angle at the
// receiver), clamped.
export function geometricTerm(v0: ManifoldVertex, v1: ManifoldVertex, v2: ManifoldVertex): number {
  const ratio = specularManifoldDetRatio(v0, v1, v2);
  if (ratio === null) return 0;
  const d = v0.p.sub(v1.p);
  const invR2 = 1 / d.lengthSq();
  const dw0dx1 = absDot(d.scale(Math.sqrt(invR2)), v1.ng) * invR2;
  return dw0dx1 * Math.min(ratio, G_RATIO_CLAMP);
}

// The ONLY places pdfs change measure. Vertex pdfs are stored in area
// measure; solid-angle pdfs exist transiently inside walks and samplers.
// Cosines use the GEOMETRIC normal of the point whose measure is changing;
// pass null for non-surface points (no cosine).
import type { Vec3 } from '../math/vec3';
import { absDot } from '../math/vec3';

// pdf_A = pdf_w * |cos(theta_to)| / dist^2
export function solidAngleToArea(pdfW: number, from: Vec3, to: Vec3, toNg: Vec3 | null): number {
  const d = to.sub(from);
  const distSq = d.lengthSq();
  if (distSq === 0) return 0;
  const inv = 1 / distSq;
  const cos = toNg ? absDot(toNg, d.scale(Math.sqrt(inv))) : 1;
  return pdfW * inv * cos;
}

// pdf_w = pdf_A * dist^2 / |cos(theta_at)| — inverse of the above, used when a
// shape samples by area but must report solid angle at the receiver.
export function areaToSolidAngle(pdfA: number, ref: Vec3, at: Vec3, atNg: Vec3): number {
  const d = at.sub(ref);
  const distSq = d.lengthSq();
  if (distSq === 0) return 0;
  const cos = absDot(atNg, d.scale(1 / Math.sqrt(distSq)));
  if (cos === 0) return 0;
  return (pdfA * distSq) / cos;
}

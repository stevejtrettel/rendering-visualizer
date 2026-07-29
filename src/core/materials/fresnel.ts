// Fresnel terms and refraction, in the local shading frame (normal = +z).
// eta arguments are RELATIVE IOR interior/exterior (e.g. 1.5 for glass in
// air); a negative incident cosine means "arriving from inside" and both
// functions handle the inversion themselves.
import { Vec3 } from '../math/vec3';
import { Color } from '../math/color';

// Exact dielectric Fresnel reflectance (unpolarized). Returns 1 beyond the
// critical angle (total internal reflection).
export function frDielectric(cosThetaI: number, eta: number): number {
  let cosI = cosThetaI;
  let e = eta;
  if (cosI < 0) {
    e = 1 / e;
    cosI = -cosI;
  }
  const sin2I = 1 - cosI * cosI;
  const sin2T = sin2I / (e * e);
  if (sin2T >= 1) return 1;
  const cosT = Math.sqrt(1 - sin2T);
  const rParl = (e * cosI - cosT) / (e * cosI + cosT);
  const rPerp = (cosI - e * cosT) / (cosI + e * cosT);
  return (rParl * rParl + rPerp * rPerp) / 2;
}

// Schlick approximation with an F0 color — the conductor convention we
// agreed on (gold is three numbers, not a spectrum).
export function schlick(f0: Color, cosTheta: number): Color {
  const m = Math.pow(1 - Math.min(1, Math.abs(cosTheta)), 5);
  return new Color(
    f0.r + (1 - f0.r) * m,
    f0.g + (1 - f0.g) * m,
    f0.b + (1 - f0.b) * m,
  );
}

// Refract wo about the local normal (+z). Returns the transmitted direction
// and the DIRECTED relative IOR etap actually crossed (eta or 1/eta), or
// null on total internal reflection.
export function refractLocal(wo: Vec3, eta: number): { wi: Vec3; etap: number } | null {
  let cosI = wo.z;
  let e = eta;
  let nz = 1;
  if (cosI < 0) {
    e = 1 / e;
    cosI = -cosI;
    nz = -1;
  }
  const sin2T = (1 - cosI * cosI) / (e * e);
  if (sin2T >= 1) return null;
  const cosT = Math.sqrt(1 - sin2T);
  const wi = new Vec3(
    -wo.x / e,
    -wo.y / e,
    -wo.z / e + (cosI / e - cosT) * nz,
  ).normalize();
  return { wi, etap: e };
}

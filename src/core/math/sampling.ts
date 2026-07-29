// Sampling routines over canonical domains. All take uniform samples in
// [0, 1)^2 and report pdfs in the measure named by the helper.
import { Vec3 } from './vec3';

export type Sample2D = readonly [number, number];

// Concentric (Shirley–Chiu) map: preserves stratification, unlike the
// naive sqrt(r)/theta polar map.
export function concentricSampleDisk(u: Sample2D): readonly [number, number] {
  const ox = 2 * u[0] - 1;
  const oy = 2 * u[1] - 1;
  if (ox === 0 && oy === 0) return [0, 0];
  let r: number, theta: number;
  if (Math.abs(ox) > Math.abs(oy)) {
    r = ox;
    theta = (Math.PI / 4) * (oy / ox);
  } else {
    r = oy;
    theta = Math.PI / 2 - (Math.PI / 4) * (ox / oy);
  }
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

// Cosine-weighted hemisphere around +z (Malley's method).
export function cosineSampleHemisphere(u: Sample2D): Vec3 {
  const [x, y] = concentricSampleDisk(u);
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  return new Vec3(x, y, z);
}

// pdf (solid angle) of cosineSampleHemisphere for a direction with given cos(theta).
export function cosineHemispherePdf(cosTheta: number): number {
  return cosTheta > 0 ? cosTheta / Math.PI : 0;
}

export function uniformSampleSphere(u: Sample2D): Vec3 {
  const z = 1 - 2 * u[0];
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = 2 * Math.PI * u[1];
  return new Vec3(r * Math.cos(phi), r * Math.sin(phi), z);
}

export const UNIFORM_SPHERE_PDF = 1 / (4 * Math.PI);

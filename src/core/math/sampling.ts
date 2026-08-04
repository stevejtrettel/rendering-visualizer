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

// Inverse error function (Giles 2010 single-precision polynomial, as used
// by pbrt's ErfInv). Turns a uniform sample into a Gaussian one:
// N(0,1) = sqrt(2) * erfInv(2u - 1) — the MLT small-step mutation's warp.
export function erfInv(x: number): number {
  const c = Math.min(0.99999, Math.max(-0.99999, x));
  let w = -Math.log((1 - c) * (1 + c));
  let p: number;
  if (w < 5) {
    w -= 2.5;
    p = 2.81022636e-8;
    p = 3.43273939e-7 + p * w;
    p = -3.5233877e-6 + p * w;
    p = -4.39150654e-6 + p * w;
    p = 0.00021858087 + p * w;
    p = -0.00125372503 + p * w;
    p = -0.00417768164 + p * w;
    p = 0.246640727 + p * w;
    p = 1.50140941 + p * w;
  } else {
    w = Math.sqrt(w) - 3;
    p = -0.000200214257;
    p = 0.000100950558 + p * w;
    p = 0.00134934322 + p * w;
    p = -0.00367342844 + p * w;
    p = 0.00573950773 + p * w;
    p = -0.0076224613 + p * w;
    p = 0.00943887047 + p * w;
    p = 1.00167406 + p * w;
    p = 2.83297682 + p * w;
  }
  return p * c;
}

// Uniform over the hemisphere around +z — every solid angle equally
// likely, which is the deliberately naive alternative to importance
// sampling a BSDF (see materials/uniform-sampled.ts).
export function uniformSampleHemisphere(u: Sample2D): Vec3 {
  const z = u[0];
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = 2 * Math.PI * u[1];
  return new Vec3(r * Math.cos(phi), r * Math.sin(phi), z);
}

export const UNIFORM_HEMISPHERE_PDF = 1 / (2 * Math.PI);

export function uniformSampleSphere(u: Sample2D): Vec3 {
  const z = 1 - 2 * u[0];
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = 2 * Math.PI * u[1];
  return new Vec3(r * Math.cos(phi), r * Math.sin(phi), z);
}

export const UNIFORM_SPHERE_PDF = 1 / (4 * Math.PI);

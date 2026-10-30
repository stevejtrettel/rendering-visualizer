// Spectra to colours, for the Part II camera slides (lens-camera): the CIE
// 1931 observer as the multi-lobe analytic fit rendering-talk-visuals uses
// (its src/response.ts), so a spectrum here comes out the colour it does on
// the pixel-response and pixel-image slides. Pure: no three.js.

function lobe(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
export const xbar = (nm: number): number =>
  1.056 * lobe(nm, 599.8, 37.9, 31.0) + 0.362 * lobe(nm, 442.0, 16.0, 26.7) - 0.065 * lobe(nm, 501.1, 20.4, 26.2);
export const ybar = (nm: number): number => 0.821 * lobe(nm, 568.8, 46.9, 40.5) + 0.286 * lobe(nm, 530.9, 16.3, 31.1);
export const zbar = (nm: number): number => 1.217 * lobe(nm, 437.0, 11.8, 36.0) + 0.681 * lobe(nm, 459.0, 26.0, 13.8);

/** XYZ of a spectrum sampled at `nm` (trapezoid rule), scaled so a flat spectrum of height 1 has Y = 1. */
export function toXYZ(spec: ArrayLike<number>, nm: readonly number[]): [number, number, number] {
  const xyz: [number, number, number] = [0, 0, 0];
  let norm = 0;
  for (let i = 0; i < nm.length; i++) {
    const w = i === 0 || i === nm.length - 1 ? 0.5 : 1;
    const l = nm[i]!;
    xyz[0] += w * xbar(l) * spec[i]!;
    xyz[1] += w * ybar(l) * spec[i]!;
    xyz[2] += w * zbar(l) * spec[i]!;
    norm += w * ybar(l);
  }
  return [xyz[0] / norm, xyz[1] / norm, xyz[2] / norm];
}

const encode = (u: number) => (u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055);
/** XYZ to sRGB bytes; out of gamut is lifted, over-bright is scaled down (hue kept). */
export function xyzToSrgb(X: number, Y: number, Z: number): [number, number, number] {
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  let g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  let b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  const lo = Math.min(r, g, b);
  if (lo < 0) [r, g, b] = [r - lo, g - lo, b - lo];
  const hi = Math.max(r, g, b);
  if (hi > 1) [r, g, b] = [r / hi, g / hi, b / hi];
  return [r, g, b].map((c) => Math.round(255 * encode(Math.max(c, 0)))) as [number, number, number];
}

/** The colour of a single wavelength, at full brightness (for a spectrum axis's rainbow). */
export function nmSrgb(nm: number): [number, number, number] {
  const l = Math.min(Math.max(nm, 400), 670); // the fit's tails fail past ~680 nm
  const xyz = [xbar(l), ybar(l), zbar(l)];
  const m = Math.max(...xyz);
  return xyzToSrgb(xyz[0]! / m, xyz[1]! / m, xyz[2]! / m);
}

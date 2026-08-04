// Film accumulator. Per pixel, 8 float64 slots in one flat array:
// [rSum, gSum, bSum, weightSum, rSplat, gSplat, bSplat, lumSqSum].
// Samples normalize by ACCUMULATED filter weight; splats by an EXTERNAL
// scale supplied at develop time (BDPT: 1/spp; MLT: b/mutationsPerPixel —
// unknown until the render ends, which is why it must not be baked in).
// lumSqSum accumulates squared sample luminance, giving a per-pixel
// standard-error estimate for the convergence/error view.
// Per-worker films merge by plain summation (V1).
import { Color, luminanceOf } from '../core/math/color';
import type { Sample2D } from '../core/math/sampling';

const STRIDE = 8;

export interface DevelopOptions {
  exposure?: number;
  splatScale?: number;
}

export class Film {
  readonly data: Float64Array;

  constructor(
    readonly width: number,
    readonly height: number,
    data?: Float64Array,
  ) {
    this.data = data ?? new Float64Array(width * height * STRIDE);
  }

  private index(raster: Sample2D): number {
    const x = Math.min(this.width - 1, Math.max(0, Math.floor(raster[0])));
    const y = Math.min(this.height - 1, Math.max(0, Math.floor(raster[1])));
    return (y * this.width + x) * STRIDE;
  }

  addSample(raster: Sample2D, value: Color, weight = 1): void {
    const i = this.index(raster);
    this.data[i]! += weight * value.r;
    this.data[i + 1]! += weight * value.g;
    this.data[i + 2]! += weight * value.b;
    this.data[i + 3]! += weight;
    const lum = value.luminance();
    this.data[i + 7]! += weight * lum * lum;
  }

  splat(raster: Sample2D, value: Color): void {
    const i = this.index(raster);
    this.data[i + 4]! += value.r;
    this.data[i + 5]! += value.g;
    this.data[i + 6]! += value.b;
  }

  // Linear radiance of one pixel (box filter: filterIntegral = 1).
  pixel(x: number, y: number, opts: DevelopOptions = {}): [number, number, number] {
    const { exposure = 1, splatScale = 1 } = opts;
    const i = (y * this.width + x) * STRIDE;
    const w = this.data[i + 3]!;
    const inv = w > 0 ? 1 / w : 0;
    return [
      exposure * (this.data[i]! * inv + splatScale * this.data[i + 4]!),
      exposure * (this.data[i + 1]! * inv + splatScale * this.data[i + 5]!),
      exposure * (this.data[i + 2]! * inv + splatScale * this.data[i + 6]!),
    ];
  }

  // Standard error of the pixel's mean luminance (sample-based): sqrt of
  // (E[x^2] - mean^2) / N. Splats are excluded — this is a camera-sample
  // statistic for the convergence view.
  standardError(x: number, y: number): number {
    const i = (y * this.width + x) * STRIDE;
    const n = this.data[i + 3]!;
    if (n <= 1) return Infinity;
    const meanLum = luminanceOf(this.data[i]! / n, this.data[i + 1]! / n, this.data[i + 2]! / n);
    const meanSq = this.data[i + 7]! / n;
    const variance = Math.max(0, meanSq - meanLum * meanLum);
    return Math.sqrt(variance / n);
  }

  // sRGB-encoded RGBA8, ready for putImageData or PNG.
  develop(opts: DevelopOptions = {}): Uint8ClampedArray<ArrayBuffer> {
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const [r, g, b] = this.pixel(x, y, opts);
        const o = (y * this.width + x) * 4;
        out[o] = srgbEncode(r);
        out[o + 1] = srgbEncode(g);
        out[o + 2] = srgbEncode(b);
        out[o + 3] = 255;
      }
    }
    return out;
  }

  // False-color relative-standard-error view (black -> violet -> orange ->
  // white as noise increases). `scale` sets the relSE mapped to full white.
  developError(scale = 1): Uint8ClampedArray<ArrayBuffer> {
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const [r, g, b] = this.pixel(x, y, { splatScale: 0 });
        const meanLum = luminanceOf(r, g, b);
        const se = this.standardError(x, y);
        const rel = meanLum > 1e-6 && Number.isFinite(se) ? se / meanLum : se === 0 ? 0 : 1;
        const t = Math.min(1, rel / scale);
        const o = (y * this.width + x) * 4;
        const [cr, cg, cb] = heat(t);
        out[o] = cr;
        out[o + 1] = cg;
        out[o + 2] = cb;
        out[o + 3] = 255;
      }
    }
    return out;
  }
}

export function srgbEncode(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

// Perceptual-ish ramp via piecewise lerp over fixed stops (magma-like).
const HEAT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 4], [64, 12, 92], [178, 54, 88], [250, 148, 58], [252, 253, 191],
];

function heat(t: number): [number, number, number] {
  const pos = t * (HEAT_STOPS.length - 1);
  const i = Math.min(HEAT_STOPS.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = HEAT_STOPS[i]!;
  const b = HEAT_STOPS[i + 1]!;
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

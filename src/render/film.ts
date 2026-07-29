// Film accumulator. Per pixel, 7 float64 slots in one flat array:
// [rSum, gSum, bSum, weightSum, rSplat, gSplat, bSplat].
// Samples normalize by ACCUMULATED filter weight; splats by an EXTERNAL
// scale supplied at develop time (BDPT: 1/spp; MLT: b/mutationsPerPixel —
// unknown until the render ends, which is why it must not be baked in).
// Per-worker films merge by plain summation (V1).
import type { Color } from '../core/math/color';
import type { Sample2D } from '../core/math/sampling';

const STRIDE = 7;

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
}

function srgbEncode(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

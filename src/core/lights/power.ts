// Power-proportional light selection (pbrt-notes §PowerLightSampler; the
// V0 LightDistribution interface reserved pmf() for exactly this). Selection
// probability ∝ the light's total emitted power phi() — the difference
// between starving and feeding a 64-emitter chandelier with one draw. A CDF
// walk suffices at our light counts (an alias table is an optimization for
// thousands of lights, not a correctness feature).
import type { Light } from './light';
import type { LightDistribution } from './distribution';

export class PowerLightSampler implements LightDistribution {
  private readonly weights: number[];
  private readonly cdf: number[];
  private readonly total: number;

  constructor(private readonly lights: readonly Light[]) {
    this.weights = lights.map((l) => l.phi().luminance());
    this.cdf = [];
    let sum = 0;
    for (const w of this.weights) {
      sum += w;
      this.cdf.push(sum);
    }
    this.total = sum;
    // Degenerate scene (all-black emitters): fall back to uniform weights
    // so sample() never returns null for a nonempty light list.
    if (this.total === 0 && lights.length > 0) {
      this.weights.fill(1);
      for (let i = 0; i < lights.length; i++) this.cdf[i] = i + 1;
      this.total = lights.length;
    }
  }

  sample(u: number): { light: Light; pmf: number } | null {
    const n = this.lights.length;
    if (n === 0) return null;
    const target = u * this.total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cdf[mid]! <= target) lo = mid + 1;
      else hi = mid;
    }
    return { light: this.lights[lo]!, pmf: this.weights[lo]! / this.total };
  }

  pmf(light: Light): number {
    const i = this.lights.indexOf(light);
    return i >= 0 ? this.weights[i]! / this.total : 0;
  }
}

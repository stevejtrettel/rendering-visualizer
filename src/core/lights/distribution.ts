import type { Light } from './light';

// Discrete light selection. Exposes BOTH sampling and pmf lookup — MIS
// composes pmf(light) * pdfLi, and BDPT's light-subpath start uses the
// context-free sample. (A receiver-context-aware variant can be added
// alongside when a smarter sampler needs it.)
export interface LightDistribution {
  sample(u: number): { light: Light; pmf: number } | null;
  pmf(light: Light): number;
}

export class UniformLightDistribution implements LightDistribution {
  constructor(private readonly lights: readonly Light[]) {}

  sample(u: number): { light: Light; pmf: number } | null {
    const n = this.lights.length;
    if (n === 0) return null;
    const i = Math.min(Math.floor(u * n), n - 1);
    return { light: this.lights[i]!, pmf: 1 / n };
  }

  pmf(light: Light): number {
    return this.lights.includes(light) ? 1 / this.lights.length : 0;
  }
}

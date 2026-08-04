// Single-term series estimator — path tracing made even more naive than
// Russian roulette. The pixel value is the Neumann series L = sum_n L_n over
// path length; each sample draws the term index N up front from a geometric
// pmf, traces exactly N bounces with RR disabled, and evaluates ONLY the
// length-N contribution, weighted by 1/pmf(N). Emission the path crosses at
// earlier depths is deliberately discarded — other samples' draws cover
// those terms — which is exactly where the extra variance over RR comes
// from. (Fixed-q RR is this estimator's lazy cousin: reveal the same
// geometric lifetime one Bernoulli at a time and keep every term with
// survival weights instead of pmf weights.)
//
// The pmf is truncated to [1, maxBounces] and renormalized, so the
// estimator targets the same depth-capped transport integral as the other
// depth-capped integrators — comparisons stay apples-to-apples.
import { Color } from '../math/color';
import type { Scene } from '../scene/scene';
import type { Sampler } from '../sampler/sampler';
import type { Recorder } from '../../trace/recorder';
import { cameraSample, walkFromCamera } from './estimators';
import type { Contribution, Integrator, Pixel } from './types';

export interface SingleTermOptions {
  maxBounces: number; // truncation depth D of the length pmf
  continueProb: number; // q of the geometric, in (0, 1); mean length ~ 1/(1-q)
}

export const DEFAULT_SINGLE_TERM_OPTIONS: SingleTermOptions = {
  maxBounces: 32,
  continueProb: 0.75,
};

// Inverse-CDF sample of the truncated geometric pmf(n) = q^(n-1)(1-q) /
// (1 - q^D) on n in [1, D]. Returns the drawn length and its pmf.
export function sampleTermLength(
  u: number,
  q: number,
  maxBounces: number,
): { n: number; pmf: number } {
  const norm = 1 - Math.pow(q, maxBounces);
  const t = 1 - u * norm; // in (q^D, 1]
  const n = Math.min(maxBounces, Math.max(1, Math.ceil(Math.log(t) / Math.log(q))));
  return { n, pmf: (Math.pow(q, n - 1) * (1 - q)) / norm };
}

export class SingleTermPT implements Integrator {
  private readonly options: SingleTermOptions;

  constructor(options: Partial<SingleTermOptions> = {}) {
    this.options = { ...DEFAULT_SINGLE_TERM_OPTIONS, ...options };
  }

  sampleContributions(pixel: Pixel, sampler: Sampler, scene: Scene, recorder: Recorder): Contribution[] {
    const { raster, ray } = cameraSample(scene, pixel, sampler);

    // Term index right after the film sample — one extra dimension ahead of
    // the walk's fixed layout, which is why the preamble is split in two.
    const { n, pmf } = sampleTermLength(
      sampler.next1D(),
      this.options.continueProb,
      this.options.maxBounces,
    );
    recorder.lengthDraw({ n, pmf });

    // rrStartDepth beyond the cap: the committed lifetime replaces RR.
    const vertices = walkFromCamera(scene, ray, sampler, recorder, {
      maxBounces: n,
      rrStartDepth: n + 1,
      sampleNEE: false,
    });

    // vertices = [camera, v_1 .. v_k], k <= n; only a path that reached
    // depth n exactly contributes, and only through vertex n's emission.
    let L = Color.BLACK;
    const v = vertices[n];
    const light = v?.primitive?.light;
    if (v && light && v.wo) {
      L = v.beta.mul(light.le(v.p, v.ng, v.uv, v.wo)).scale(1 / pmf);
    }

    const contribution: Contribution = { kind: 'sample', raster, value: L };
    recorder.contribution(contribution);
    return [contribution];
  }
}

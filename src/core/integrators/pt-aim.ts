// Bounce a while, then aim at the light. The simplest fix for "most paths
// never find the light" that needs no importance-sampling story (Steve,
// 2026-10-28: "a truncation point where our bounce does light sampling").
//
// Each sample draws a stopping depth N up front from a truncated geometric
// pmf, bounces N times by BSDF sampling, and at vertex N sends ONE shadow
// ray to a sampled point on a light. That estimates exactly the term of the
// Neumann series whose paths have N surface vertices before the lamp,
// weighted by 1/pmf(N), so every length is covered by some draw of N:
//
//   length 1  (the eye sees the lamp)   the camera ray's own emission, added
//                                       as-is on every sample
//   length N+1, N in [1, D]             the connection at vertex N, / pmf(N)
//
// and the sum is unbiased for the same depth-capped transport integral as
// the other integrators (cap D on bounces). The connection is UNWEIGHTED:
// this estimator never also counts a BSDF-sampled hit on the lamp beyond
// the first vertex, so there is nothing to share the paths with. pt-term is
// the same single-term idea with the last edge found by luck instead.
//
// Limit: a connection cannot leave a delta (mirror, smooth glass) vertex, so
// paths whose N-th vertex is delta contribute nothing and those terms are
// missed. cornell-short has none; scenes with delta surfaces want pt-nee.
import { Color } from '../math/color';
import { absDot } from '../math/vec3';
import { TransportMode, hasNonSpecular } from '../materials/bsdf';
import { occlusionPoint } from '../geometry/visibility';
import type { Scene } from '../scene/scene';
import type { Sampler } from '../sampler/sampler';
import type { Recorder } from '../../trace/recorder';
import { cameraSample, walkFromCamera } from './estimators';
import { sampleTermLength } from './pt-term';
import type { Contribution, Integrator, Pixel } from './types';

export interface AimOptions {
  maxBounces: number; // D: the deepest vertex a connection may leave from
  continueProb: number; // q of the geometric; mean stopping depth ~ 1/(1-q)
}

export const DEFAULT_AIM_OPTIONS: AimOptions = { maxBounces: 8, continueProb: 0.6 };

export class AimAtLightPT implements Integrator {
  private readonly options: AimOptions;

  constructor(options: Partial<AimOptions> = {}) {
    this.options = { ...DEFAULT_AIM_OPTIONS, ...options };
  }

  sampleContributions(pixel: Pixel, sampler: Sampler, scene: Scene, recorder: Recorder): Contribution[] {
    const { raster, ray } = cameraSample(scene, pixel, sampler);
    const { n, pmf } = sampleTermLength(sampler.next1D(), this.options.continueProb, this.options.maxBounces);
    recorder.lengthDraw({ n, pmf });

    // [camera, v_1 .. v_k], k <= n. The walk draws the NEE dimensions at
    // every vertex (fixed layout); only vertex n's are used.
    const vertices = walkFromCamera(scene, ray, sampler, recorder, {
      maxBounces: n,
      rrStartDepth: n + 1,
      sampleNEE: true,
    });

    let L = Color.BLACK;
    const first = vertices[1];
    const firstLight = first?.primitive?.light;
    if (first && firstLight && first.wo) {
      // Length 1: the eye sees the lamp. The lamp scatters nothing, so this
      // sample has nothing further to add.
      L = firstLight.le(first.p, first.ng, first.uv, first.wo);
    } else {
      const v = vertices[n];
      if (v?.bsdf && v.wo && v.neeSamples && hasNonSpecular(v.bsdf.flags)) {
        const selected = scene.lightDistribution.sample(v.neeSamples.select);
        const li = selected?.light.sampleLi({ p: v.p, ng: v.ng, ns: v.ns }, v.neeSamples.point);
        if (selected && li) {
          const f = v.bsdf.eval(v.wo, li.wi, TransportMode.Radiance);
          const blockedAt = occlusionPoint(scene.aggregate, { p: v.p, ng: v.ng }, li.pLight);
          recorder.shadowRay({ depth: n, from: v.p, to: li.pLight.p, occluded: blockedAt !== null, blockedAt });
          if (blockedAt === null && !f.isBlack()) {
            const pLight = selected.pmf * li.pdf;
            L = v.beta.mul(f).mul(li.L).scale(absDot(li.wi, v.ns) / pLight / pmf);
          }
        }
      }
    }

    const contribution: Contribution = { kind: 'sample', raster, value: L };
    recorder.contribution(contribution);
    return [contribution];
  }
}

// Unidirectional path tracing, BSDF sampling only — in BDPT terms, the s=0
// strategies. Phase 1 materializes the path (randomWalk); phase 2 evaluates:
// every emissive surface the path touches contributes beta * Le toward the
// previous vertex.
import { Color } from '../math/color';
import type { Scene } from '../scene/scene';
import type { Sampler } from '../sampler/sampler';
import type { Recorder } from '../../trace/recorder';
import { cameraSample, walkFromCamera } from './estimators';
import { DEFAULT_WALK_OPTIONS, type WalkOptions } from './walk';
import type { Contribution, Integrator, Pixel } from './types';

export class UnidirectionalPT implements Integrator {
  constructor(private readonly options: WalkOptions = DEFAULT_WALK_OPTIONS) {}

  sampleContributions(pixel: Pixel, sampler: Sampler, scene: Scene, recorder: Recorder): Contribution[] {
    const { raster, ray } = cameraSample(scene, pixel, sampler);
    const vertices = walkFromCamera(scene, ray, sampler, recorder, this.options);

    // Deliberately NOT estimators.directLighting: that combines the BSDF
    // and light-sampling strategies by MIS, and this integrator has no
    // light-sampling strategy to combine with. Every emitter hit counts at
    // full weight — which is the whole point of the first rung.
    let L = Color.BLACK;
    for (let i = 1; i < vertices.length; i++) {
      const v = vertices[i]!;
      const light = v.primitive?.light;
      if (light && v.wo) {
        L = L.add(v.beta.mul(light.le(v.p, v.ng, v.uv, v.wo)));
      }
    }

    const contribution: Contribution = { kind: 'sample', raster, value: L };
    recorder.contribution(contribution);
    return [contribution];
  }
}

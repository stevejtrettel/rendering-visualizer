// Unidirectional path tracing, BSDF sampling only — in BDPT terms, the s=0
// strategies. Phase 1 materializes the path (randomWalk); phase 2 evaluates:
// every emissive surface the path touches contributes beta * Le toward the
// previous vertex.
import { Color } from '../math/color';
import { TransportMode } from '../materials/bsdf';
import type { Scene } from '../scene/scene';
import type { Sampler } from '../sampler/sampler';
import type { Recorder } from '../../trace/recorder';
import { cameraVertex } from './vertex';
import { DEFAULT_WALK_OPTIONS, randomWalk, type WalkOptions } from './walk';
import type { Contribution, Integrator, Pixel } from './types';

export class UnidirectionalPT implements Integrator {
  constructor(private readonly options: WalkOptions = DEFAULT_WALK_OPTIONS) {}

  sampleContributions(pixel: Pixel, sampler: Sampler, scene: Scene, recorder: Recorder): Contribution[] {
    // Box filter: the film sample is jittered uniformly inside the pixel.
    const u = sampler.nextPixel2D();
    const raster = [pixel[0] + u[0], pixel[1] + u[1]] as const;
    const ray = scene.camera.generateRay(raster);

    const start = cameraVertex(scene.camera, Color.WHITE);
    const { pdfDir } = scene.camera.pdfWe(ray);
    const vertices = randomWalk(
      scene, start, ray, Color.WHITE, pdfDir, TransportMode.Radiance, sampler, recorder, this.options,
    );

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

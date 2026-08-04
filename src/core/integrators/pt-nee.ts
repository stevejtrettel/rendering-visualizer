// Path tracing with next-event estimation and MIS (power heuristic) — the
// second rung of the talk's ladder. UnidirectionalPT remains untouched
// beside it: integrators accumulate, never replace.
//
// Phase 1: the shared randomWalk (with NEE dimensions drawn per bounce).
// Phase 2: estimators.directLighting at every surface vertex, which is
// where the two-strategy MIS combination now lives — this integrator is
// its plainest caller (no ownership policy at all), and pt-sms and the
// ReSTIR driver are the same estimator under a policy.
import { Color } from '../math/color';
import type { Scene } from '../scene/scene';
import type { Sampler } from '../sampler/sampler';
import type { Recorder } from '../../trace/recorder';
import { cameraSample, directLighting, walkFromCamera } from './estimators';
import { DEFAULT_WALK_OPTIONS, type WalkOptions } from './walk';
import type { Contribution, Integrator, Pixel } from './types';

export class NEEPathTracer implements Integrator {
  private readonly options: WalkOptions;

  constructor(options: Partial<WalkOptions> = {}) {
    this.options = { ...DEFAULT_WALK_OPTIONS, ...options, sampleNEE: true };
  }

  sampleContributions(pixel: Pixel, sampler: Sampler, scene: Scene, recorder: Recorder): Contribution[] {
    const { raster, ray } = cameraSample(scene, pixel, sampler);
    const vertices = walkFromCamera(scene, ray, sampler, recorder, this.options);

    let L = Color.BLACK;
    for (let k = 1; k < vertices.length; k++) {
      L = L.add(directLighting(scene, vertices, k, recorder));
    }

    const contribution: Contribution = { kind: 'sample', raster, value: L };
    recorder.contribution(contribution);
    return [contribution];
  }
}

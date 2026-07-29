// Pass-based render driver: one pass = one sample per pixel. Pure — runs
// identically on the main thread, in a Web Worker, or under Node. The driver
// owns seeding (startPixelSample) so integrators stay replayable.
import type { Scene } from '../core/scene/scene';
import type { Sampler } from '../core/sampler/sampler';
import type { Integrator } from '../core/integrators/types';
import { pixelSeedKey } from '../core/sampler/sampler';
import { NULL_RECORDER, type Recorder } from '../trace/recorder';
import type { Film } from './film';

export function renderPass(
  scene: Scene,
  integrator: Integrator,
  sampler: Sampler,
  film: Film,
  sampleIndex: number,
  recorder: Recorder = NULL_RECORDER,
): void {
  for (let y = 0; y < film.height; y++) {
    for (let x = 0; x < film.width; x++) {
      sampler.startPixelSample(pixelSeedKey(x, y, sampleIndex));
      const contributions = integrator.sampleContributions([x, y], sampler, scene, recorder);
      for (const c of contributions) {
        if (c.kind === 'sample') film.addSample(c.raster, c.value);
        else film.splat(c.raster, c.value);
      }
    }
  }
}

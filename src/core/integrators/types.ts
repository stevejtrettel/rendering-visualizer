import type { Color } from '../math/color';
import type { Sample2D } from '../math/sampling';
import type { Scene } from '../scene/scene';
import type { Sampler } from '../sampler/sampler';
import type { Recorder } from '../../trace/recorder';

export type Pixel = readonly [number, number];

export interface Contribution {
  // 'sample' contributions carry a filter weight and normalize by the film's
  // accumulated weight; 'splat' contributions (light tracing, MLT) land at
  // arbitrary raster positions and are scaled externally at develop time.
  kind: 'sample' | 'splat';
  raster: Sample2D;
  value: Color;
}

export interface Integrator {
  // `pixel` is advisory — a stratification hint for camera-driven
  // integrators. The sampler must already be seeded (startPixelSample) by
  // the driver; MLT-mode rendering derives raster positions from the
  // sampler itself.
  sampleContributions(pixel: Pixel, sampler: Sampler, scene: Scene, recorder: Recorder): Contribution[];
}

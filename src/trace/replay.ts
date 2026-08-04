// Re-tracing a path for inspection, in one call.
//
// Every visualization page needs the same six lines: make the seed key,
// seed the sampler with it, wrap an ArrayRecorder in beginPath/endPath,
// run the integrator, take records[0]. Ten pages wrote them out by hand.
//
// This is only ever a convenience: the reason it works is the sampler
// contract (state is a pure function of (key, dimension)), so re-tracing
// with the same key reproduces the same path exactly, and nothing per-path
// ever has to be stored or shipped across a worker boundary.
import type { Scene } from '../core/scene/scene';
import type { Integrator, Pixel } from '../core/integrators/types';
import type { Sampler } from '../core/sampler/sampler';
import { pixelSeedKey } from '../core/sampler/sampler';
import { IndependentSampler } from '../core/sampler/independent';
import { ArrayRecorder, type PathRecord } from './records';

export interface ReplayOptions {
  // Defaults to a fresh IndependentSampler(seed). Pass one explicitly to
  // replay against the sampler a render actually used.
  sampler?: Sampler;
  seed?: number;
}

// The path the integrator builds for `pixel` at `sampleIndex`.
export function tracePath(
  scene: Scene,
  integrator: Integrator,
  pixel: Pixel,
  sampleIndex: number,
  options: ReplayOptions = {},
): PathRecord {
  return tracePaths(scene, integrator, pixel, [sampleIndex], options)[0]!;
}

// The same for a list of sample indices — one record each, in order. The
// swarm pages want a whole population of one pixel's paths at once.
export function tracePaths(
  scene: Scene,
  integrator: Integrator,
  pixel: Pixel,
  sampleIndices: Iterable<number>,
  options: ReplayOptions = {},
): PathRecord[] {
  const sampler = options.sampler ?? new IndependentSampler(options.seed ?? 0);
  const recorder = new ArrayRecorder();
  for (const sampleIndex of sampleIndices) {
    const key = pixelSeedKey(pixel[0], pixel[1], sampleIndex);
    sampler.startPixelSample(key);
    recorder.beginPath(key);
    integrator.sampleContributions(pixel, sampler, scene, recorder);
    recorder.endPath();
  }
  return recorder.records;
}

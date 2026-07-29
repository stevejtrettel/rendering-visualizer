import { describe, expect, it } from 'vitest';
import { powerHeuristic } from '../src/core/integrators/mis';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';
import { UnidirectionalPT } from '../src/core/integrators/pt';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import type { Integrator } from '../src/core/integrators/types';
import { NULL_RECORDER } from '../src/trace/recorder';
import { ArrayRecorder } from '../src/trace/records';

describe('powerHeuristic', () => {
  it('weights for the two strategies sum to 1', () => {
    const pairs = [
      [0.5, 0.5], [1e-6, 10], [3, 0], [0, 3], [123.4, 0.001],
    ] as const;
    for (const [a, b] of pairs) {
      if (a + b === 0) continue;
      expect(powerHeuristic(a, b) + powerHeuristic(b, a)).toBeCloseTo(1, 12);
    }
    expect(powerHeuristic(0, 0)).toBe(0);
  });
});

// Cornell-style closed box with a SMALL light — the regime where NEE matters.
const CORNELL_TEST: SceneDescription = {
  camera: { eye: [0, 2, 7.2], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 0, 4], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ceiling', shape: { kind: 'quad', q: [-2, 4, -2], e1: [4, 0, 0], e2: [0, 0, 4] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'back', shape: { kind: 'quad', q: [-2, 0, -2], e1: [4, 0, 0], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'left', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 4, 0], e2: [0, 0, 4] }, material: { kind: 'lambert', albedo: [0.65, 0.05, 0.05] } },
    { name: 'right', shape: { kind: 'quad', q: [2, 0, -2], e1: [0, 0, 4], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.12, 0.45, 0.15] } },
    { name: 'light', shape: { kind: 'quad', q: [-0.8, 3.998, -0.8], e1: [1.6, 0, 0], e2: [0, 0, 1.6] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [14, 14, 14] } },
    { name: 'ball', shape: { kind: 'sphere', center: [-0.9, 0.8, -0.6], radius: 0.8 }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
  ],
};

function meanRadiance(integrator: Integrator, seed: number, pixels: ReadonlyArray<readonly [number, number]>, spp: number): number {
  const scene = buildScene(CORNELL_TEST, 32, 32);
  const s = new IndependentSampler(seed);
  let sum = 0;
  for (const pixel of pixels) {
    for (let i = 0; i < spp; i++) {
      s.startPixelSample(pixelSeedKey(pixel[0], pixel[1], i));
      const [c] = integrator.sampleContributions(pixel, s, scene, NULL_RECORDER);
      sum += c!.value.r + c!.value.g + c!.value.b;
    }
  }
  return sum / (pixels.length * spp);
}

describe('cross-integrator consistency (the flagship test)', () => {
  it('PT and PT+NEE converge to the same radiance', () => {
    // A handful of pixels across the image: floor, walls, sphere.
    const pixels = [
      [16, 26], [16, 16], [6, 16], [26, 16], [12, 20], [20, 24],
    ] as const;
    // NEE converges fast; PT needs many more samples for the same variance.
    const nee = meanRadiance(new NEEPathTracer(), 1, pixels, 400);
    const pt = meanRadiance(new UnidirectionalPT(), 2, pixels, 4000);
    expect(Math.abs(pt - nee) / nee).toBeLessThan(0.05);
  });

  it('NEE furnace: floor under a vast emitter still converges to albedo * L', () => {
    const albedo = 0.65;
    const L = 2.0;
    const desc: SceneDescription = {
      camera: { eye: [0, 0.5, 0], lookAt: [0, 0, -2], up: [0, 1, 0], fovDegrees: 40 },
      primitives: [
        { name: 'floor', shape: { kind: 'quad', q: [-2000, 0, -2000], e1: [4000, 0, 0], e2: [0, 0, 4000] }, material: { kind: 'lambert', albedo: [albedo, albedo, albedo] } },
        { name: 'ceiling', shape: { kind: 'quad', q: [-2000, 10, -2000], e1: [4000, 0, 0], e2: [0, 0, 4000] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [L, L, L] } },
      ],
    };
    const scene = buildScene(desc, 16, 16);
    const nee = new NEEPathTracer();
    const s = new IndependentSampler(3);
    const N = 20_000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      s.startPixelSample(pixelSeedKey(8, 8, i));
      const [c] = nee.sampleContributions([8, 8], s, scene, NULL_RECORDER);
      sum += c!.value.r;
    }
    expect(sum / N).toBeGreaterThan(albedo * L * 0.99);
    expect(sum / N).toBeLessThan(albedo * L * 1.01);
  });
});

describe('shadow-ray recording', () => {
  it('captures both blocked and clear NEE connections, with blocker points', () => {
    const scene = buildScene(CORNELL_TEST, 32, 32);
    const nee = new NEEPathTracer();
    const s = new IndependentSampler(5);
    const recorder = new ArrayRecorder();
    // Pixels near the sphere's shadow region: some connections blocked by
    // the ball, some clear.
    for (const pixel of [[13, 25], [16, 26], [10, 24], [20, 25]] as const) {
      for (let i = 0; i < 32; i++) {
        const key = pixelSeedKey(pixel[0], pixel[1], i);
        s.startPixelSample(key);
        recorder.beginPath(key);
        nee.sampleContributions(pixel, s, scene, recorder);
        recorder.endPath();
      }
    }
    const rays = recorder.records.flatMap((r) => r.shadowRays);
    expect(rays.length).toBeGreaterThan(0);
    const blocked = rays.filter((r) => r.occluded);
    const clear = rays.filter((r) => !r.occluded);
    expect(blocked.length).toBeGreaterThan(0);
    expect(clear.length).toBeGreaterThan(0);
    for (const b of blocked) {
      expect(b.blockedAt).not.toBeNull();
      // The blocker lies strictly between the endpoints.
      const [fx, fy, fz] = b.from;
      const [tx, ty, tz] = b.to;
      const [bx, by, bz] = b.blockedAt!;
      const total = Math.hypot(tx - fx, ty - fy, tz - fz);
      const toBlock = Math.hypot(bx - fx, by - fy, bz - fz);
      expect(toBlock).toBeGreaterThan(0);
      expect(toBlock).toBeLessThan(total);
    }
  });
});

describe('NEE determinism', () => {
  it('contributions are reproducible from seed keys', () => {
    const run = () => {
      const scene = buildScene(CORNELL_TEST, 32, 32);
      const nee = new NEEPathTracer();
      const s = new IndependentSampler(6);
      const out: number[] = [];
      for (let i = 0; i < 200; i++) {
        s.startPixelSample(pixelSeedKey(16, 24, i));
        const [c] = nee.sampleContributions([16, 24], s, scene, NULL_RECORDER);
        out.push(c!.value.r, c!.value.g, c!.value.b);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

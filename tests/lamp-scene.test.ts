import { describe, expect, it } from 'vitest';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { BDPT } from '../src/core/integrators/bdpt';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import type { Integrator } from '../src/core/integrators/types';
import { renderPass } from '../src/render/driver';
import { Film } from '../src/render/film';

// The uplight scene (demos/_shared/scenes.ts 'cornell-lamp', inlined per
// test convention): the emitter faces the ceiling inside a shaded fixture,
// so the room is lit ENTIRELY by the ceiling bounce. These tests guard the
// challenge property itself — if someone moves or flips the fixture, the
// scene silently stops being a BDPT showcase, and this file starts failing.
const SHADE = { kind: 'lambert' as const, albedo: [0.25, 0.25, 0.25] as const };
const LAMP: SceneDescription = {
  camera: { eye: [0, 2, 9.5], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 0, 13], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ceiling', shape: { kind: 'quad', q: [-2, 4, -2], e1: [4, 0, 0], e2: [0, 0, 13] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'back', shape: { kind: 'quad', q: [-2, 0, -2], e1: [4, 0, 0], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'left', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 4, 0], e2: [0, 0, 13] }, material: { kind: 'lambert', albedo: [0.65, 0.05, 0.05] } },
    { name: 'right', shape: { kind: 'quad', q: [2, 0, -2], e1: [0, 0, 13], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.12, 0.45, 0.15] } },
    { name: 'front', shape: { kind: 'quad', q: [-2, 0, 11], e1: [0, 4, 0], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ball', shape: { kind: 'sphere', center: [-0.9, 0.8, -0.6], radius: 0.8 }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ballBlue', shape: { kind: 'sphere', center: [0.9, 0.55, 0.6], radius: 0.55 }, material: { kind: 'lambert', albedo: [0.35, 0.45, 0.8] } },
    { name: 'lampEmitter', shape: { kind: 'quad', q: [-0.4, 2.7, -0.4], e1: [0, 0, 0.8], e2: [0.8, 0, 0] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [100, 100, 100] } },
    { name: 'lampPlate', shape: { kind: 'quad', q: [-0.6, 2.55, -0.6], e1: [1.2, 0, 0], e2: [0, 0, 1.2] }, material: SHADE },
    { name: 'lampSkirtFront', shape: { kind: 'quad', q: [-0.6, 2.55, 0.6], e1: [1.2, 0, 0], e2: [0, 0.4, 0] }, material: SHADE },
    { name: 'lampSkirtBack', shape: { kind: 'quad', q: [-0.6, 2.55, -0.6], e1: [0, 0.4, 0], e2: [1.2, 0, 0] }, material: SHADE },
    { name: 'lampSkirtLeft', shape: { kind: 'quad', q: [-0.6, 2.55, -0.6], e1: [0, 0, 1.2], e2: [0, 0.4, 0] }, material: SHADE },
    { name: 'lampSkirtRight', shape: { kind: 'quad', q: [0.6, 2.55, -0.6], e1: [0, 0.4, 0], e2: [0, 0, 1.2] }, material: SHADE },
  ],
};

const SIZE = 16;

function render(integrator: Integrator, spp: number, seed: number): Film {
  const scene = buildScene(LAMP, SIZE, SIZE);
  const film = new Film(SIZE, SIZE);
  const sampler = new IndependentSampler(seed);
  for (let i = 0; i < spp; i++) renderPass(scene, integrator, sampler, film, i);
  return film;
}

const imageMean = (film: Film, spp: number): number => {
  let sum = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = film.pixel(x, y, { splatScale: 1 / spp });
      sum += r + g + b;
    }
  }
  return sum / (SIZE * SIZE);
};

describe('cornell-lamp (the uplight — indirect-only illumination)', () => {
  it('depth-1 direct lighting is EXACTLY zero everywhere below the fixture', () => {
    // Only the strategies that constitute direct lighting at the first
    // camera vertex: seeing the emitter (0,2) and one NEE connection (1,2).
    const direct = new BDPT({
      strategyFilter: (s, t) => t === 2 && s <= 1,
      unweighted: true,
      assertWeights: true,
    });
    const spp = 20;
    const film = render(direct, spp, 5);
    // Bottom half of the frame (floor, balls, lower walls): every point is
    // below the fixture plane, sees only the emitter's dark side — zero,
    // not merely small.
    for (let y = 10; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const [r, g, b] = film.pixel(x, y, { splatScale: 1 / spp });
        expect(r + g + b).toBe(0);
      }
    }
    // The ceiling pool above the fixture IS directly lit.
    let ceiling = 0;
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < SIZE; x++) {
        const [r, g, b] = film.pixel(x, y, { splatScale: 1 / spp });
        ceiling += r + g + b;
      }
    }
    expect(ceiling).toBeGreaterThan(0.1);
  });

  it('BDPT and NEE converge to the same image mean', { timeout: 30_000 }, () => {
    const bdpt = imageMean(render(new BDPT({ assertWeights: true }), 60, 6), 60);
    const nee = imageMean(render(new NEEPathTracer(), 400, 7), 400);
    expect(Math.abs(bdpt - nee) / nee).toBeLessThan(0.05);
  });
});

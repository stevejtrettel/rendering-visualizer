import { describe, expect, it } from 'vitest';
import { Color } from '../src/core/math/color';
import { Film } from '../src/render/film';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { UnidirectionalPT } from '../src/core/integrators/pt';
import { renderPass } from '../src/render/driver';

describe('Film', () => {
  it('samples average by accumulated weight', () => {
    const film = new Film(4, 4);
    film.addSample([1.3, 2.7], new Color(2, 4, 6));
    film.addSample([1.9, 2.1], new Color(4, 8, 12));
    expect(film.pixel(1, 2)).toEqual([3, 6, 9]);
    // Non-unit weights: (2*0.5 + 4*1.5) / (0.5 + 1.5) = 3.5
    const film2 = new Film(2, 2);
    film2.addSample([0, 0], new Color(2, 2, 2), 0.5);
    film2.addSample([0, 0], new Color(4, 4, 4), 1.5);
    expect(film2.pixel(0, 0)[0]).toBeCloseTo(3.5, 12);
  });

  it('splats accumulate separately and scale only at develop time', () => {
    const film = new Film(2, 2);
    film.addSample([0, 0], new Color(1, 1, 1));
    film.splat([0.5, 0.5], new Color(10, 10, 10));
    film.splat([0.5, 0.5], new Color(10, 10, 10));
    expect(film.pixel(0, 0, { splatScale: 0 })[0]).toBe(1);
    expect(film.pixel(0, 0, { splatScale: 0.1 })[0]).toBeCloseTo(1 + 2, 12);
    // A pixel with only splats must not divide by a zero weightSum.
    film.splat([1.5, 0.5], new Color(5, 5, 5));
    expect(film.pixel(1, 0, { splatScale: 1 })[0]).toBe(5);
  });

  it('tracks per-pixel standard error of the mean', () => {
    const film = new Film(1, 1);
    // Two samples of luminance 1 and 3 (gray colors): mean 2,
    // variance E[x^2] - mean^2 = 5 - 4 = 1, SE = sqrt(1/2).
    film.addSample([0, 0], new Color(1, 1, 1));
    film.addSample([0, 0], new Color(3, 3, 3));
    expect(film.standardError(0, 0)).toBeCloseTo(Math.sqrt(1 / 2), 10);
    // Identical samples: zero variance.
    const uniform = new Film(1, 1);
    uniform.addSample([0, 0], new Color(2, 2, 2));
    uniform.addSample([0, 0], new Color(2, 2, 2));
    expect(uniform.standardError(0, 0)).toBeCloseTo(0, 10);
    // A single sample has no variance estimate.
    const single = new Film(1, 1);
    single.addSample([0, 0], new Color(2, 2, 2));
    expect(single.standardError(0, 0)).toBe(Infinity);
  });

  it('develops to sRGB with correct endpoints', () => {
    const film = new Film(2, 1);
    film.addSample([0, 0], Color.BLACK);
    film.addSample([1, 0], Color.WHITE);
    const rgba = film.develop();
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([0, 0, 0, 255]);
    expect([rgba[4], rgba[5], rgba[6], rgba[7]]).toEqual([255, 255, 255, 255]);
  });
});

const MINI_CORNELL: SceneDescription = {
  camera: { eye: [0, 2, 7.2], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 0, 4], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ceiling', shape: { kind: 'quad', q: [-2, 4, -2], e1: [4, 0, 0], e2: [0, 0, 4] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'back', shape: { kind: 'quad', q: [-2, 0, -2], e1: [4, 0, 0], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'light', shape: { kind: 'quad', q: [-0.8, 3.998, -0.8], e1: [1.6, 0, 0], e2: [0, 0, 1.6] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [14, 14, 14] } },
    { name: 'ball', shape: { kind: 'sphere', center: [-0.9, 0.8, -0.6], radius: 0.8 }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
  ],
};

describe('renderPass', () => {
  it('same seed produces a bit-identical film (the design-doc determinism test)', () => {
    const run = () => {
      const scene = buildScene(MINI_CORNELL, 24, 24);
      const film = new Film(24, 24);
      const sampler = new IndependentSampler(0);
      const pt = new UnidirectionalPT();
      for (let pass = 0; pass < 4; pass++) renderPass(scene, pt, sampler, film, pass);
      return film.data;
    };
    const a = run();
    const b = run();
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) throw new Error(`film differs at slot ${i}: ${a[i]} vs ${b[i]}`);
    }
  });

  it('a lit Cornell render is neither black nor NaN', () => {
    const scene = buildScene(MINI_CORNELL, 24, 24);
    const film = new Film(24, 24);
    const sampler = new IndependentSampler(1);
    renderPass(scene, new UnidirectionalPT(), sampler, film, 0);
    let energy = 0;
    for (const v of film.data) {
      expect(Number.isNaN(v)).toBe(false);
      energy += v;
    }
    expect(energy).toBeGreaterThan(0);
  });

  it('timing (informational, for the speed discussion)', () => {
    const scene = buildScene(MINI_CORNELL, 128, 128);
    const film = new Film(128, 128);
    const sampler = new IndependentSampler(2);
    const pt = new UnidirectionalPT();
    renderPass(scene, pt, sampler, film, 0); // warm the JIT
    const t0 = performance.now();
    const PASSES = 4;
    for (let p = 1; p <= PASSES; p++) renderPass(scene, pt, sampler, film, p);
    const ms = (performance.now() - t0) / PASSES;
    // eslint-disable-next-line no-console
    console.log(`[timing] 128x128 pass: ${ms.toFixed(1)} ms (${((128 * 128) / ms).toFixed(0)} paths/ms)`);
    expect(ms).toBeGreaterThan(0);
  });
});

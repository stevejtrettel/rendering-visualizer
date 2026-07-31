import { describe, expect, it } from 'vitest';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { MLTSampler } from '../src/core/sampler/mlt';
import { chainSeedKey } from '../src/core/sampler/sampler';
import { BDPT } from '../src/core/integrators/bdpt';
import { mmltState } from '../src/core/integrators/mmlt';
import { renderPass } from '../src/render/driver';
import { Film } from '../src/render/film';
import { runMlt, type MLTOptions } from '../src/render/mlt-driver';
import { NULL_RECORDER } from '../src/trace/recorder';
import { ArrayRecorder } from '../src/trace/records';

// Same boxes as tests/bdpt.test.ts (self-contained by test convention).
const CORNELL: SceneDescription = {
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

const GLASS_BOX: SceneDescription = {
  camera: { eye: [0, 2, 7.2], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 0, 10], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ceiling', shape: { kind: 'quad', q: [-2, 4, -2], e1: [4, 0, 0], e2: [0, 0, 10] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'back', shape: { kind: 'quad', q: [-2, 0, -2], e1: [4, 0, 0], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'left', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 4, 0], e2: [0, 0, 10] }, material: { kind: 'lambert', albedo: [0.65, 0.05, 0.05] } },
    { name: 'right', shape: { kind: 'quad', q: [2, 0, -2], e1: [0, 0, 10], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.12, 0.45, 0.15] } },
    { name: 'front', shape: { kind: 'quad', q: [-2, 0, 8], e1: [0, 4, 0], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'light', shape: { kind: 'quad', q: [-0.8, 3.998, -0.8], e1: [1.6, 0, 0], e2: [0, 0, 1.6] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [14, 14, 14] } },
    { name: 'glass', shape: { kind: 'sphere', center: [-0.3, 0.8, -0.3], radius: 0.8 }, material: { kind: 'dielectric', ior: 1.5 } },
  ],
};

// BDPT reference at the SAME depth cap as MMLT — the comparison must be of
// the same (truncated) transport integral.
function bdptReference(desc: SceneDescription, size: number, spp: number, maxDepth: number, seed: number): Film {
  const scene = buildScene(desc, size, size);
  const film = new Film(size, size);
  const sampler = new IndependentSampler(seed);
  const bdpt = new BDPT({ maxBounces: maxDepth, assertWeights: true });
  for (let i = 0; i < spp; i++) renderPass(scene, bdpt, sampler, film, i);
  return film;
}

// Mean luminance-ish (r+g+b) per pixel over a whole film.
function imageMean(film: Film, splatScale: number): number {
  let sum = 0;
  for (let y = 0; y < film.height; y++) {
    for (let x = 0; x < film.width; x++) {
      const [r, g, b] = film.pixel(x, y, { splatScale });
      sum += r + g + b;
    }
  }
  return sum / (film.width * film.height);
}

// Block-averaged image (block x block pixel tiles): per-pixel MLT output is
// noisy at test-sized mutation counts; block means compare the SPATIAL
// distribution — which the global mean cannot, because MLT's image mean is
// b by construction (each mutation deposits total luminance 1).
function blockMeans(film: Film, splatScale: number, block: number): number[] {
  const out: number[] = [];
  for (let by = 0; by < film.height; by += block) {
    for (let bx = 0; bx < film.width; bx += block) {
      let sum = 0;
      for (let y = by; y < by + block; y++) {
        for (let x = bx; x < bx + block; x++) {
          const [r, g, b] = film.pixel(x, y, { splatScale });
          sum += r + g + b;
        }
      }
      out.push(sum / (block * block));
    }
  }
  return out;
}

describe('mmltState', () => {
  it('depth 0 forces (s, t) = (0, 2) and rasters inside the film', () => {
    const scene = buildScene(CORNELL, 16, 16);
    const sampler = new MLTSampler(1);
    for (let i = 0; i < 32; i++) {
      sampler.startPixelSample(chainSeedKey(i));
      const state = mmltState(scene, sampler, 0, { width: 16, height: 16, heuristic: 'balance', assertWeights: true }, NULL_RECORDER);
      expect(state.s).toBe(0);
      expect(state.t).toBe(2);
      expect(state.raster[0]).toBeGreaterThanOrEqual(0);
      expect(state.raster[0]).toBeLessThan(16);
      expect(state.raster[1]).toBeGreaterThanOrEqual(0);
      expect(state.raster[1]).toBeLessThan(16);
      expect(Number.isFinite(state.L.luminance())).toBe(true);
    }
  });

  it('covers the full strategy range at positive depth', () => {
    const scene = buildScene(CORNELL, 16, 16);
    const sampler = new MLTSampler(2);
    const seen = new Set<string>();
    for (let i = 0; i < 256; i++) {
      sampler.startPixelSample(chainSeedKey(i));
      const state = mmltState(scene, sampler, 2, { width: 16, height: 16, heuristic: 'balance', assertWeights: true }, NULL_RECORDER);
      expect(state.s + state.t).toBe(4); // nStrategies = depth + 2 vertices total
      expect(state.t).toBeGreaterThanOrEqual(1);
      seen.add(`${state.s},${state.t}`);
    }
    expect(seen.size).toBe(4); // s in {0, 1, 2, 3}
  });
});

describe('MMLT vs BDPT', () => {
  const MAX_DEPTH = 6;

  it('large-step-only mutations reproduce BDPT (the Markov machinery is inert)', { timeout: 60_000 }, () => {
    // With largeStepProbability = 1 every proposal is an independent
    // bootstrap-distributed sample: the chain never actually "walks", and
    // the both-states estimator must converge to the same image as BDPT.
    // Isolates driver + normalization from the small-step machinery.
    const size = 16;
    const scene = buildScene(CORNELL, size, size);
    const film = new Film(size, size);
    const result = runMlt(scene, film, {
      maxDepth: MAX_DEPTH,
      nBootstrap: 65536,
      nChains: 64,
      mutationsPerPixel: 1600,
      largeStepProbability: 1,
      assertWeights: true,
      seed: 5,
    });
    const ref = bdptReference(CORNELL, size, 300, MAX_DEPTH, 51);

    // b is the mean image luminance (bootstrap-only quantity).
    const refMeanLum = (() => {
      let sum = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const [r, g, b] = ref.pixel(x, y, { splatScale: 1 / 300 });
          sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
      }
      return sum / (size * size);
    })();
    expect(Math.abs(result.b - refMeanLum) / refMeanLum).toBeLessThan(0.05);

    // Spatial distribution: 4x4 blocks.
    const got = blockMeans(film, result.splatScale, 4);
    const want = blockMeans(ref, 1 / 300, 4);
    for (let i = 0; i < got.length; i++) {
      expect(Math.abs(got[i]! - want[i]!) / want[i]!).toBeLessThan(0.16);
    }
  });

  it('real chains (small steps) converge to BDPT on the Cornell box', { timeout: 60_000 }, () => {
    const size = 16;
    const scene = buildScene(CORNELL, size, size);
    const film = new Film(size, size);
    const result = runMlt(scene, film, {
      maxDepth: MAX_DEPTH,
      nBootstrap: 65536,
      nChains: 64,
      mutationsPerPixel: 800,
      assertWeights: true,
      seed: 7,
    });
    const ref = bdptReference(CORNELL, size, 300, MAX_DEPTH, 71);
    const got = blockMeans(film, result.splatScale, 4);
    const want = blockMeans(ref, 1 / 300, 4);
    for (let i = 0; i < got.length; i++) {
      expect(Math.abs(got[i]! - want[i]!) / want[i]!).toBeLessThan(0.18);
    }
    expect(imageMean(film, result.splatScale)).toBeGreaterThan(0);
  });

  it('glass box: chains find the caustic transport', { timeout: 120_000 }, () => {
    const size = 24;
    const scene = buildScene(GLASS_BOX, size, size);
    const film = new Film(size, size);
    const result = runMlt(scene, film, {
      maxDepth: 8,
      nBootstrap: 65536,
      nChains: 128,
      mutationsPerPixel: 800,
      seed: 9,
    });
    const spp = 160;
    const ref = bdptReference(GLASS_BOX, size, spp, 8, 91);
    // Coarse blocks (6x6): the caustic region is bright and localized; the
    // comparison checks MLT distributes energy like BDPT, caustic included.
    const got = blockMeans(film, result.splatScale, 6);
    const want = blockMeans(ref, 1 / spp, 6);
    for (let i = 0; i < got.length; i++) {
      expect(Math.abs(got[i]! - want[i]!) / want[i]!).toBeLessThan(0.25);
    }
  });
});

describe('MMLT determinism and recording', () => {
  const TINY: Partial<MLTOptions> = {
    maxDepth: 4,
    nBootstrap: 1024,
    nChains: 8,
    mutationsPerPixel: 40,
    assertWeights: true,
    seed: 3,
  };

  it('same seed gives a bit-identical film and b', () => {
    const run = () => {
      const scene = buildScene(CORNELL, 8, 8);
      const film = new Film(8, 8);
      const result = runMlt(scene, film, TINY);
      return { film, result };
    };
    const a = run();
    const b = run();
    expect(a.result.b).toBe(b.result.b);
    expect(a.result.splatScale).toBe(b.result.splatScale);
    expect(Array.from(a.film.data)).toEqual(Array.from(b.film.data));
  });

  it('records mutations with walks, decisions, and both step types', () => {
    const scene = buildScene(CORNELL, 8, 8);
    const film = new Film(8, 8);
    const recorder = new ArrayRecorder();
    runMlt(scene, film, TINY, recorder);
    // One chain-start record per chain (mutation null — the chain viz needs
    // the starting path), then one record per mutation.
    const starts = recorder.records.filter((r) => r.mutation === null);
    expect(starts.length).toBe(8);
    const mutations = recorder.records.map((r) => r.mutation).filter((m) => m !== null);
    expect(mutations.length).toBe(recorder.records.length - starts.length);
    expect(mutations.some((m) => m!.type === 'large')).toBe(true);
    expect(mutations.some((m) => m!.type === 'small')).toBe(true);
    expect(mutations.some((m) => m!.accepted)).toBe(true);
    expect(mutations.some((m) => !m!.accepted)).toBe(true);
    for (const m of mutations) {
      expect(m!.a).toBeGreaterThanOrEqual(0);
      expect(m!.a).toBeLessThanOrEqual(1);
    }
    // Proposals carry their walks (camera always; light when s > 0).
    expect(recorder.records.some((r) => r.vertices.length > 0)).toBe(true);
    expect(recorder.records.some((r) => r.lightVertices.length > 0)).toBe(true);
  });
});

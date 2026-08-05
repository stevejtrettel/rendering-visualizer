// Stage 3 of docs/design-cleanup.md: the three execution models now sit
// behind one `Renderer` interface, so that worker.ts stops branching on the
// algorithm and protocol.ts stops carrying MMLT-specific fields.
//
// The facade must be exactly that — a facade. These tests pin that a
// renderer's film is bit-identical to driving its underlying driver by
// hand, for one representative of each of the three models.
import { describe, expect, it } from 'vitest';
import { buildScene, type Scene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import { BDPT } from '../src/core/integrators/bdpt';
import { Film } from '../src/render/film';
import { renderPass } from '../src/render/driver';
import { MltRunner } from '../src/render/mlt-driver';
import { RestirRunner } from '../src/render/restir-driver';
import { createRenderer, passesAreExchangeable } from '../src/render/renderer';
import { describeIntegrator, type IntegratorName } from '../src/render/protocol';

const BOX: SceneDescription = {
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

const SIZE = 16;
const SEED = 0;
const DEPTH = 3;
const PASSES = 3;

const scene = (): Scene => buildScene(BOX, SIZE, SIZE);

function viaFacade(name: IntegratorName): Film {
  const film = new Film(SIZE, SIZE);
  const renderer = createRenderer(describeIntegrator(name, DEPTH), scene(), film, { seed: SEED });
  for (let p = 0; p < PASSES; p++) renderer.pass(p);
  return film;
}

const expectSameFilm = (got: Film, want: Film): void => {
  expect(got.data.length).toBe(want.data.length);
  for (let i = 0; i < want.data.length; i++) expect(got.data[i]).toBe(want.data[i]);
};

describe('the Renderer facade drives each model exactly as its driver does', () => {
  it('per-pixel integrators match renderPass (pt-nee)', () => {
    const film = new Film(SIZE, SIZE);
    const sampler = new IndependentSampler(SEED);
    const integrator = new NEEPathTracer({ maxBounces: DEPTH });
    for (let p = 0; p < PASSES; p++) renderPass(scene(), integrator, sampler, film, p);
    expectSameFilm(viaFacade('pt-nee'), film);
  });

  it('per-pixel integrators match renderPass (bdpt, which also splats)', () => {
    const film = new Film(SIZE, SIZE);
    const sampler = new IndependentSampler(SEED);
    const integrator = new BDPT({ maxBounces: DEPTH });
    for (let p = 0; p < PASSES; p++) renderPass(scene(), integrator, sampler, film, p);
    const facade = viaFacade('bdpt');
    expectSameFilm(facade, film);
    // BDPT's t = 1 splats average over passes, so splatScale = 1/spp.
    const renderer = createRenderer({ name: 'bdpt' }, scene(), new Film(SIZE, SIZE), { seed: SEED });
    expect(renderer.splatNorm()).toBe(1);
  });

  it('MMLT matches MltRunner over the same chain batches', () => {
    // The pass -> chain-batch mapping is the facade's job; these mirror
    // renderer.ts's batching deliberately, so a change to it fails here.
    const nPixels = SIZE * SIZE;
    const chainsPerBatch = Math.max(1, Math.round(nPixels / 4096));
    const mutationsPerChain = Math.ceil(nPixels / chainsPerBatch);

    const film = new Film(SIZE, SIZE);
    const runner = new MltRunner(scene(), film, { seed: SEED, maxDepth: DEPTH });
    for (let p = 0; p < PASSES; p++) {
      runner.runChains(p * chainsPerBatch, chainsPerBatch, mutationsPerChain);
    }
    expectSameFilm(viaFacade('mmlt'), film);

    // splatScale = splatNorm / totalPasses must reproduce the bootstrap
    // normalization b over the mutations per pixel actually spent.
    const renderer = createRenderer({ name: 'mmlt', maxBounces: DEPTH }, scene(), new Film(SIZE, SIZE), {
      seed: SEED,
    });
    const expected = (runner.b * nPixels) / (chainsPerBatch * mutationsPerChain);
    expect(renderer.splatNorm()).toBeCloseTo(expected, 12);
  });

  it('ReSTIR matches RestirRunner pass for pass', () => {
    const film = new Film(SIZE, SIZE);
    const runner = new RestirRunner(scene(), film, { seed: SEED, maxBounces: DEPTH });
    for (let p = 0; p < PASSES; p++) runner.pass();
    expectSameFilm(viaFacade('restir'), film);
  });

  it('only ReSTIR reports non-exchangeable passes', () => {
    const names: IntegratorName[] = ['pt', 'pt-term', 'pt-nee', 'pt-sms', 'bdpt', 'mmlt', 'restir'];
    for (const n of names) {
      expect(passesAreExchangeable(n)).toBe(n !== 'restir');
    }
  });
});

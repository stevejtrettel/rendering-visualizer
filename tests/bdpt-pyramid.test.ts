import { describe, expect, it } from 'vitest';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { BDPT, type StrategyContribution, type StrategySink } from '../src/core/integrators/bdpt';
import { renderPass } from '../src/render/driver';
import { Film } from '../src/render/film';

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

// Per-(s,t) accumulation. Everything goes into splat slots (raw sums), so a
// cell's pixel value is sum/spp regardless of how often the strategy fired.
class GridSink implements StrategySink {
  readonly cells = new Map<string, { weighted: Film; unweighted: Film }>();

  constructor(private readonly size: number) {}

  cell(s: number, t: number): { weighted: Film; unweighted: Film } {
    const key = `${s},${t}`;
    let c = this.cells.get(key);
    if (!c) {
      c = { weighted: new Film(this.size, this.size), unweighted: new Film(this.size, this.size) };
      this.cells.set(key, c);
    }
    return c;
  }

  add(c: StrategyContribution): void {
    const cell = this.cell(c.s, c.t);
    cell.weighted.splat(c.raster, c.weighted);
    cell.unweighted.splat(c.raster, c.unweighted);
  }
}

function renderWithSink(size: number, spp: number, seed: number, maxBounces: number) {
  const scene = buildScene(CORNELL, size, size);
  const film = new Film(size, size);
  const sink = new GridSink(size);
  const bdpt = new BDPT({
    maxBounces,
    rrStartDepth: 99, // no RR: the truncated transport is exact per depth
    strategyFilms: sink,
    assertWeights: true,
  });
  const sampler = new IndependentSampler(seed);
  for (let i = 0; i < spp; i++) renderPass(scene, bdpt, sampler, film, i);
  return { film, sink };
}

const cellMean = (film: Film, spp: number, size: number): number => {
  let sum = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = film.pixel(x, y, { splatScale: 1 / spp });
      sum += r + g + b;
    }
  }
  return sum / (size * size);
};

describe('per-strategy AOVs (the Veach pyramid)', () => {
  it('weighted cells sum pixelwise to the final image, splats included', () => {
    const size = 10;
    const spp = 24;
    const { film, sink } = renderWithSink(size, spp, 51, 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const finalPx = film.pixel(x, y, { splatScale: 1 / spp });
        let sum = 0;
        let finalSum = 0;
        for (const { weighted } of sink.cells.values()) {
          const [r, g, b] = weighted.pixel(x, y, { splatScale: 1 / spp });
          sum += r + g + b;
        }
        finalSum = finalPx[0] + finalPx[1] + finalPx[2];
        expect(Math.abs(sum - finalSum)).toBeLessThan(1e-9);
      }
    }
  });

  it('s+t=2 cell has weight identically 1: weighted equals unweighted', () => {
    const size = 10;
    const spp = 24;
    const { sink } = renderWithSink(size, spp, 51, 4);
    const direct = sink.cells.get('0,2')!;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const w = direct.weighted.pixel(x, y, { splatScale: 1 });
        const u = direct.unweighted.pixel(x, y, { splatScale: 1 });
        expect(w[0]).toBe(u[0]);
        expect(w[1]).toBe(u[1]);
        expect(w[2]).toBe(u[2]);
      }
    }
  });

  it('unweighted depth-1 cells all converge to the same transport', () => {
    // (0,3), (1,2), (2,1) are three different samplings of the SAME
    // one-bounce integral — their unweighted images must agree.
    const size = 8;
    const spp = 1500;
    const { sink } = renderWithSink(size, spp, 52, 2);
    const [hitLight, nee, lightTrace] = ['0,3', '1,2', '2,1'].map((key) =>
      cellMean(sink.cells.get(key)!.unweighted, spp, size),
    ) as [number, number, number];
    // The two explicit-connection samplings are low-variance: tight bound.
    expect(Math.abs(nee - lightTrace) / nee).toBeLessThan(0.02);
    // BSDF-sampling the small light is the high-variance strategy (that is
    // the pyramid's lesson) — same transport, wider statistical band.
    expect(Math.abs(hitLight - nee) / nee).toBeLessThan(0.1);
  });
});

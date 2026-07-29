import { describe, expect, it } from 'vitest';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';
import { UnidirectionalPT } from '../src/core/integrators/pt';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import type { Integrator } from '../src/core/integrators/types';
import { NULL_RECORDER } from '../src/trace/recorder';
import { ArrayRecorder } from '../src/trace/records';

// Cornell-style box with a glass sphere under the light: the caustic scene.
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

function meanRadiance(integrator: Integrator, seed: number, pixels: ReadonlyArray<readonly [number, number]>, spp: number): number {
  const scene = buildScene(GLASS_BOX, 32, 32);
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

describe('glass Cornell scene', () => {
  it('paths through the glass produce delta vertices with zeroed pdfs', () => {
    const scene = buildScene(GLASS_BOX, 32, 32);
    const nee = new NEEPathTracer();
    const s = new IndependentSampler(1);
    const recorder = new ArrayRecorder();
    // A pixel looking at the glass sphere (center-left of frame).
    for (let i = 0; i < 64; i++) {
      const key = pixelSeedKey(14, 19, i);
      s.startPixelSample(key);
      recorder.beginPath(key);
      nee.sampleContributions([14, 19], s, scene, recorder);
      recorder.endPath();
    }
    // PBRT convention: delta marks "a delta lobe was sampled LEAVING this
    // vertex". The vertex's own pdfFwd is its (possibly nonzero) arrival
    // density; the ZEROS propagate outward — the next vertex's pdfFwd and
    // the previous vertex's pdfRev both come from the delta sample.
    let deltaCount = 0;
    for (const record of recorder.records) {
      record.vertices.forEach((v, k) => {
        if (!v.delta) return;
        deltaCount += 1;
        expect(v.primitiveName).toBe('glass');
        const next = record.vertices[k + 1];
        if (next) expect(next.pdfFwd).toBe(0);
        const prev = record.vertices[k - 1];
        if (prev) expect(prev.pdfRev).toBe(0);
      });
    }
    expect(deltaCount).toBeGreaterThan(0);
    // NEE must not attempt connections FROM delta vertices: every recorded
    // shadow ray should originate at a non-glass surface.
    const glassShadow = recorder.records
      .flatMap((r) => r.shadowRays)
      .filter((sr) => {
        // shadow ray depths index vertices; find the vertex it started at
        return recorder.records.some((rec) =>
          rec.shadowRays.includes(sr) && rec.vertices[sr.depth]?.primitiveName === 'glass');
      });
    expect(glassShadow.length).toBe(0);
  });

  it('PT and PT+NEE converge to the same radiance (slowly — that is the point)', () => {
    const pixels = [
      [16, 26], [14, 19], [8, 16], [24, 16],
    ] as const; // caustic floor region, glass, walls
    const nee = meanRadiance(new NEEPathTracer(), 1, pixels, 3000);
    const pt = meanRadiance(new UnidirectionalPT(), 2, pixels, 12000);
    expect(Math.abs(pt - nee) / nee).toBeLessThan(0.1);
  });

  it('is deterministic on the glass scene', () => {
    const run = () => {
      const scene = buildScene(GLASS_BOX, 32, 32);
      const nee = new NEEPathTracer();
      const s = new IndependentSampler(7);
      const out: number[] = [];
      for (let i = 0; i < 100; i++) {
        s.startPixelSample(pixelSeedKey(14, 19, i));
        const [c] = nee.sampleContributions([14, 19], s, scene, NULL_RECORDER);
        out.push(c!.value.r, c!.value.g, c!.value.b);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

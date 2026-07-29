import { describe, expect, it } from 'vitest';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';
import { UnidirectionalPT } from '../src/core/integrators/pt';
import { NULL_RECORDER } from '../src/trace/recorder';

describe('UnidirectionalPT', () => {
  it('camera looking directly at an emissive quad sees exactly its radiance', () => {
    // Quad at z = -5 spanning x,y in [-10,10]; e1 x e2 = (20,0,0) x (0,20,0)
    // points +z, toward the camera, so one-sided emission faces us.
    const desc: SceneDescription = {
      camera: { eye: [0, 0, 0], lookAt: [0, 0, -1], up: [0, 1, 0], fovDegrees: 40 },
      primitives: [
        {
          shape: { kind: 'quad', q: [-10, -10, -5], e1: [20, 0, 0], e2: [0, 20, 0] },
          material: { kind: 'lambert', albedo: [0, 0, 0] },
          emission: { radiance: [3, 2, 1] },
        },
      ],
    };
    const scene = buildScene(desc, 16, 16);
    const pt = new UnidirectionalPT();
    const s = new IndependentSampler(0);
    for (let i = 0; i < 32; i++) {
      s.startPixelSample(pixelSeedKey(8, 8, i));
      const [c] = pt.sampleContributions([8, 8], s, scene, NULL_RECORDER);
      expect(c!.kind).toBe('sample');
      expect(c!.value.r).toBeCloseTo(3, 12);
      expect(c!.value.g).toBeCloseTo(2, 12);
      expect(c!.value.b).toBeCloseTo(1, 12);
    }
  });

  it('one-sided emission is dark from behind', () => {
    const desc: SceneDescription = {
      camera: { eye: [0, 0, -10], lookAt: [0, 0, 0], up: [0, 1, 0], fovDegrees: 40 },
      primitives: [
        {
          // Same quad; its emissive side faces +z, away from this camera.
          shape: { kind: 'quad', q: [-10, -10, -5], e1: [20, 0, 0], e2: [0, 20, 0] },
          material: { kind: 'lambert', albedo: [0, 0, 0] },
          emission: { radiance: [3, 2, 1] },
        },
      ],
    };
    const scene = buildScene(desc, 16, 16);
    const pt = new UnidirectionalPT();
    const s = new IndependentSampler(0);
    s.startPixelSample(pixelSeedKey(8, 8, 0));
    const [c] = pt.sampleContributions([8, 8], s, scene, NULL_RECORDER);
    expect(c!.value.isBlack()).toBe(true);
  });

  it('furnace-style bounce: floor under a vast emissive ceiling converges to albedo * L', () => {
    // Camera sees a white floor; a huge one-sided emitter (facing down) fills
    // the floor's hemisphere. One bounce gives beta = albedo (f*cos/pdf for
    // cosine-sampled Lambert), so E[L] ~= albedo * Lceiling. Deep paths die:
    // the ceiling's albedo is 0.
    const albedo = 0.65;
    const L = 2.0;
    const desc: SceneDescription = {
      camera: { eye: [0, 0.5, 0], lookAt: [0, 0, -2], up: [0, 1, 0], fovDegrees: 40 },
      primitives: [
        {
          name: 'floor',
          shape: { kind: 'quad', q: [-2000, 0, -2000], e1: [4000, 0, 0], e2: [0, 0, 4000] },
          material: { kind: 'lambert', albedo: [albedo, albedo, albedo] },
        },
        {
          name: 'ceiling',
          // e1 x e2 = (4000,0,0) x (0,0,4000) points -y: emits downward.
          // Height 10 over a +-2000 span: the ceiling covers 99.997% of the
          // floor's cosine-weighted hemisphere, so side-escape is negligible.
          shape: { kind: 'quad', q: [-2000, 10, -2000], e1: [4000, 0, 0], e2: [0, 0, 4000] },
          material: { kind: 'lambert', albedo: [0, 0, 0] },
          emission: { radiance: [L, L, L] },
        },
      ],
    };
    const scene = buildScene(desc, 16, 16);
    const pt = new UnidirectionalPT();
    const s = new IndependentSampler(9);
    const N = 20_000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      s.startPixelSample(pixelSeedKey(8, 8, i));
      const [c] = pt.sampleContributions([8, 8], s, scene, NULL_RECORDER);
      sum += c!.value.r;
    }
    const mean = sum / N;
    // Estimator is albedo*L per ceiling hit, hit probability ~1 (vast quad):
    // variance is tiny, so a 1% tolerance is generous but non-vacuous.
    expect(mean).toBeGreaterThan(albedo * L * 0.99);
    expect(mean).toBeLessThan(albedo * L * 1.01);
  });

  it('contributions are deterministic given the seed key', () => {
    const desc: SceneDescription = {
      camera: { eye: [0, 2, 6], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 45 },
      primitives: [
        { shape: { kind: 'quad', q: [-4, 0, -4], e1: [8, 0, 0], e2: [0, 0, 8] }, material: { kind: 'lambert', albedo: [0.8, 0.7, 0.6] } },
        { shape: { kind: 'quad', q: [-1, 3.99, -1], e1: [0, 0, 2], e2: [2, 0, 0] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [10, 10, 10] } },
        { shape: { kind: 'sphere', center: [0, 1, 0], radius: 1 }, material: { kind: 'lambert', albedo: [0.5, 0.5, 0.9] } },
      ],
    };
    const scene = buildScene(desc, 32, 32);
    const pt = new UnidirectionalPT();
    const run = () => {
      const s = new IndependentSampler(4);
      const out: number[] = [];
      for (let i = 0; i < 100; i++) {
        s.startPixelSample(pixelSeedKey(16, 20, i));
        const [c] = pt.sampleContributions([16, 20], s, scene, NULL_RECORDER);
        out.push(c!.value.r, c!.value.g, c!.value.b, c!.raster[0], c!.raster[1]);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

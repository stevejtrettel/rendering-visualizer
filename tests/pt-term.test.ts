import { describe, expect, it } from 'vitest';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';
import { SingleTermPT, sampleTermLength } from '../src/core/integrators/pt-term';
import { PCG32 } from '../src/core/math/pcg32';
import { hashInts } from '../src/core/math/hash';
import { U64_ZERO, fromNumber } from '../src/core/math/u64';
import { NULL_RECORDER } from '../src/trace/recorder';

describe('sampleTermLength', () => {
  const Q = 0.75;
  const D = 8;
  const pmf = (n: number) => (Math.pow(Q, n - 1) * (1 - Q)) / (1 - Math.pow(Q, D));

  it('reported pmf matches the truncated geometric and sums to 1', () => {
    let total = 0;
    for (let n = 1; n <= D; n++) {
      // Probe with a u that lands inside bucket n: the midpoint of its CDF slab.
      const cdf = (k: number) => (1 - Math.pow(Q, k)) / (1 - Math.pow(Q, D));
      const u = (cdf(n - 1) + cdf(n)) / 2;
      const draw = sampleTermLength(u, Q, D);
      expect(draw.n).toBe(n);
      expect(draw.pmf).toBeCloseTo(pmf(n), 12);
      total += draw.pmf;
    }
    expect(total).toBeCloseTo(1, 12);
  });

  it('draw frequencies match the pmf (chi-square)', () => {
    const rng = new PCG32(U64_ZERO, U64_ZERO);
    rng.setSequence(hashInts([0x7074, 1]), fromNumber(0));
    const N = 50_000;
    const counts = new Array<number>(D + 1).fill(0);
    for (let i = 0; i < N; i++) {
      const { n } = sampleTermLength(rng.nextFloat(), Q, D);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(D);
      counts[n]! += 1;
    }
    let chi2 = 0;
    for (let n = 1; n <= D; n++) {
      const expected = N * pmf(n);
      chi2 += ((counts[n]! - expected) * (counts[n]! - expected)) / expected;
    }
    // 7 degrees of freedom, alpha = 0.001 -> critical value 24.32.
    expect(chi2).toBeLessThan(24.32);
  });
});

describe('SingleTermPT', () => {
  it('directly visible emitter: samples are 0 or Le/pmf(1), mean converges to Le', () => {
    // Same scene as pt.test.ts's direct-visibility test — but where plain PT
    // sees the radiance EXACTLY on every sample, the single-term estimator
    // only scores when it happens to draw N = 1, weighted 1/pmf(1). Noise on
    // a directly visible light is the whole pedagogical point.
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
    const q = 0.75;
    const maxBounces = 8;
    const pmf1 = (1 - q) / (1 - Math.pow(q, maxBounces));
    const pt = new SingleTermPT({ continueProb: q, maxBounces });
    const s = new IndependentSampler(0);
    const N = 20_000;
    let sum = 0;
    let hits = 0;
    for (let i = 0; i < N; i++) {
      s.startPixelSample(pixelSeedKey(8, 8, i));
      const [c] = pt.sampleContributions([8, 8], s, scene, NULL_RECORDER);
      if (c!.value.r > 0) {
        hits += 1;
        expect(c!.value.r).toBeCloseTo(3 / pmf1, 12);
        expect(c!.value.g).toBeCloseTo(2 / pmf1, 12);
        expect(c!.value.b).toBeCloseTo(1 / pmf1, 12);
      }
    }
    for (let i = 0; i < N; i++) {
      s.startPixelSample(pixelSeedKey(8, 8, i));
      const [c] = pt.sampleContributions([8, 8], s, scene, NULL_RECORDER);
      sum += c!.value.r;
    }
    // Hit rate is Binomial(N, pmf1): 3 sigma ~ 0.9% absolute.
    expect(hits / N).toBeGreaterThan(pmf1 - 0.01);
    expect(hits / N).toBeLessThan(pmf1 + 0.01);
    expect(sum / N).toBeGreaterThan(3 * 0.97);
    expect(sum / N).toBeLessThan(3 * 1.03);
  });

  it('cross-consistency: furnace-style bounce converges to albedo * L like plain PT', () => {
    // pt.test.ts's furnace scene: the only transport is the length-2 term
    // (floor then ceiling), so the estimator scores albedo*L/pmf(2) on N = 2
    // draws and 0 otherwise — same mean as UnidirectionalPT, more variance.
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
          shape: { kind: 'quad', q: [-2000, 10, -2000], e1: [4000, 0, 0], e2: [0, 0, 4000] },
          material: { kind: 'lambert', albedo: [0, 0, 0] },
          emission: { radiance: [L, L, L] },
        },
      ],
    };
    const scene = buildScene(desc, 16, 16);
    const pt = new SingleTermPT();
    const s = new IndependentSampler(9);
    const N = 50_000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      s.startPixelSample(pixelSeedKey(8, 8, i));
      const [c] = pt.sampleContributions([8, 8], s, scene, NULL_RECORDER);
      sum += c!.value.r;
    }
    const mean = sum / N;
    // Per-sample std is ~2.1x the mean here, so 50k samples put 3 sigma
    // under 3%.
    expect(mean).toBeGreaterThan(albedo * L * 0.97);
    expect(mean).toBeLessThan(albedo * L * 1.03);
  });

  it('contributions are deterministic given the seed key', () => {
    // The dimension layout depends on the drawn length, so replay hinges on
    // the leading term-index dimension being re-drawn identically.
    const desc: SceneDescription = {
      camera: { eye: [0, 2, 6], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 45 },
      primitives: [
        { shape: { kind: 'quad', q: [-4, 0, -4], e1: [8, 0, 0], e2: [0, 0, 8] }, material: { kind: 'lambert', albedo: [0.8, 0.7, 0.6] } },
        { shape: { kind: 'quad', q: [-1, 3.99, -1], e1: [0, 0, 2], e2: [2, 0, 0] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [10, 10, 10] } },
        { shape: { kind: 'sphere', center: [0, 1, 0], radius: 1 }, material: { kind: 'lambert', albedo: [0.5, 0.5, 0.9] } },
      ],
    };
    const scene = buildScene(desc, 32, 32);
    const pt = new SingleTermPT();
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

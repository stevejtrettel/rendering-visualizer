import { describe, expect, it } from 'vitest';
import { concentricSampleDisk, cosineSampleHemisphere, uniformSampleSphere } from '../src/core/math/sampling';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';

function sampler(seed: number): IndependentSampler {
  const s = new IndependentSampler(seed);
  s.startPixelSample(pixelSeedKey(0, 0, 0));
  return s;
}

describe('sampling routines', () => {
  it('cosine hemisphere matches its analytic distribution (chi-square)', () => {
    const s = sampler(42);
    const THETA_BINS = 8;
    const PHI_BINS = 8;
    const N = 200_000;
    const counts = new Array<number>(THETA_BINS * PHI_BINS).fill(0);

    for (let i = 0; i < N; i++) {
      const d = cosineSampleHemisphere(s.next2D());
      expect(d.z).toBeGreaterThanOrEqual(0);
      const theta = Math.acos(Math.min(1, d.z));
      let phi = Math.atan2(d.y, d.x);
      if (phi < 0) phi += 2 * Math.PI;
      const ti = Math.min(THETA_BINS - 1, Math.floor((theta / (Math.PI / 2)) * THETA_BINS));
      const pi = Math.min(PHI_BINS - 1, Math.floor((phi / (2 * Math.PI)) * PHI_BINS));
      counts[ti * PHI_BINS + pi]! += 1;
    }

    // Bin mass for pdf = cos(theta)/pi: (dPhi/pi) * (sin^2(t1) - sin^2(t0)) / 2.
    let chi2 = 0;
    for (let ti = 0; ti < THETA_BINS; ti++) {
      const t0 = (ti / THETA_BINS) * (Math.PI / 2);
      const t1 = ((ti + 1) / THETA_BINS) * (Math.PI / 2);
      const thetaMass = (Math.sin(t1) ** 2 - Math.sin(t0) ** 2) / 2;
      for (let pi = 0; pi < PHI_BINS; pi++) {
        const expected = N * thetaMass * (2 / PHI_BINS); // dPhi/pi = (2pi/PHI_BINS)/pi
        const observed = counts[ti * PHI_BINS + pi]!;
        chi2 += ((observed - expected) * (observed - expected)) / expected;
      }
    }
    // 63 degrees of freedom; critical value at alpha = 0.001 is ~103.4.
    // Deterministic seed, so this is a regression bound, not a flaky test.
    expect(chi2).toBeLessThan(103.4);
  });

  it('concentric disk maps into the unit disk and preserves the center', () => {
    const s = sampler(7);
    for (let i = 0; i < 10_000; i++) {
      const [x, y] = concentricSampleDisk(s.next2D());
      expect(x * x + y * y).toBeLessThanOrEqual(1 + 1e-12);
    }
    expect(concentricSampleDisk([0.5, 0.5])).toEqual([0, 0]);
  });

  it('uniform sphere samples are unit length with near-zero mean', () => {
    const s = sampler(11);
    let mx = 0, my = 0, mz = 0;
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const d = uniformSampleSphere(s.next2D());
      expect(d.length()).toBeCloseTo(1, 12);
      mx += d.x; my += d.y; mz += d.z;
    }
    // Std. error of each mean component is ~1/sqrt(3N) ≈ 0.0018; 5 sigma bound.
    for (const m of [mx / N, my / N, mz / N]) expect(Math.abs(m)).toBeLessThan(0.01);
  });
});

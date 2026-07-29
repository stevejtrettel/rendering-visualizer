import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/math/vec3';
import { Color } from '../src/core/math/color';
import { GGXConductor } from '../src/core/materials/conductor';
import { TransportMode } from '../src/core/materials/bsdf';
import { uniformSampleSphere } from '../src/core/math/sampling';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';

function sampler(seed: number): IndependentSampler {
  const s = new IndependentSampler(seed);
  s.startPixelSample(pixelSeedKey(0, 0, 0));
  return s;
}

const WHITE_GGX = (roughness: number) => new GGXConductor(Color.WHITE, roughness);
const wo = new Vec3(0.35, -0.2, 0.91).normalize();

describe('GGXConductor', () => {
  it('sample, eval, and pdf are mutually consistent', () => {
    const ggx = WHITE_GGX(0.4);
    const s = sampler(1);
    for (let i = 0; i < 2000; i++) {
      const bs = ggx.sample(wo, s.next1D(), s.next2D(), TransportMode.Radiance);
      if (!bs) continue;
      expect(bs.pdf).toBeCloseTo(ggx.pdf(wo, bs.wi, TransportMode.Radiance), 10);
      expect(bs.f.r).toBeCloseTo(ggx.eval(wo, bs.wi, TransportMode.Radiance).r, 10);
      expect(bs.wi.z).toBeGreaterThan(0);
    }
  });

  it('is reciprocal: f(wo, wi) = f(wi, wo)', () => {
    const ggx = new GGXConductor(new Color(0.9, 0.7, 0.4), 0.3);
    const s = sampler(2);
    for (let i = 0; i < 500; i++) {
      let wi = uniformSampleSphere(s.next2D());
      if (wi.z < 0) wi = new Vec3(wi.x, wi.y, -wi.z);
      const a = ggx.eval(wo, wi, TransportMode.Radiance);
      const b = ggx.eval(wi, wo, TransportMode.Radiance);
      expect(a.r).toBeCloseTo(b.r, 10);
      expect(a.g).toBeCloseTo(b.g, 10);
    }
  });

  it('pdf integrates to 1 minus the below-horizon rejection rate', () => {
    const ggx = WHITE_GGX(0.55); // rough enough for a real rejection rate
    const s = sampler(3);
    // MC integral of pdf over the upper hemisphere (uniform sampling).
    const N = 200_000;
    let integral = 0;
    for (let i = 0; i < N; i++) {
      let wi = uniformSampleSphere(s.next2D());
      if (wi.z < 0) wi = new Vec3(wi.x, wi.y, -wi.z);
      integral += ggx.pdf(wo, wi, TransportMode.Radiance) * 2 * Math.PI;
    }
    integral /= N;
    // Rejection rate of the sampler for the same wo.
    let rejected = 0;
    const M = 100_000;
    for (let i = 0; i < M; i++) {
      if (!ggx.sample(wo, s.next1D(), s.next2D(), TransportMode.Radiance)) rejected += 1;
    }
    const expected = 1 - rejected / M;
    expect(integral).toBeCloseTo(expected, 1);
    expect(integral).toBeGreaterThan(0.8);
    expect(integral).toBeLessThan(1.02);
  });

  it('white furnace: bounded by 1, near 1 when smooth, losing energy as roughness grows', () => {
    const s = sampler(4);
    const energy = (roughness: number): number => {
      const ggx = WHITE_GGX(roughness);
      const N = 100_000;
      let sum = 0;
      for (let i = 0; i < N; i++) {
        const bs = ggx.sample(wo, s.next1D(), s.next2D(), TransportMode.Radiance);
        if (bs) sum += (bs.f.r * Math.abs(bs.wi.z)) / bs.pdf;
      }
      return sum / N;
    };
    const smooth = energy(0.08);
    const mid = energy(0.4);
    const rough = energy(0.8);
    expect(smooth).toBeGreaterThan(0.97);
    expect(smooth).toBeLessThanOrEqual(1.001);
    expect(mid).toBeLessThanOrEqual(smooth + 1e-3);
    expect(rough).toBeLessThan(mid); // single-scattering energy loss, documented
    expect(rough).toBeGreaterThan(0.5);
  });
});

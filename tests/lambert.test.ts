import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/math/vec3';
import { Color } from '../src/core/math/color';
import { uniformSampleSphere } from '../src/core/math/sampling';
import { Lambert } from '../src/core/materials/lambert';
import { SurfaceBSDF } from '../src/core/materials/surface';
import { TransportMode } from '../src/core/materials/bsdf';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';

function sampler(seed: number): IndependentSampler {
  const s = new IndependentSampler(seed);
  s.startPixelSample(pixelSeedKey(0, 0, 0));
  return s;
}

describe('Lambert', () => {
  const albedo = new Color(0.7, 0.5, 0.3);
  const lambert = new Lambert(albedo);
  const wo = new Vec3(0.3, -0.2, 0.9).normalize();

  it('white furnace: integral of f * cos over the hemisphere equals the albedo', () => {
    // Uniform hemisphere MC (pdf = 1/2pi), independent of the BSDF's own sampling.
    const s = sampler(1);
    const N = 200_000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      let wi = uniformSampleSphere(s.next2D());
      if (wi.z < 0) wi = new Vec3(wi.x, wi.y, -wi.z);
      sum += lambert.eval(wo, wi, TransportMode.Radiance).r * wi.z * 2 * Math.PI;
    }
    expect(sum / N).toBeCloseTo(albedo.r, 2);
  });

  it('sample/eval/pdf are mutually consistent', () => {
    const s = sampler(2);
    for (let i = 0; i < 1000; i++) {
      const bs = lambert.sample(wo, s.next1D(), s.next2D(), TransportMode.Radiance)!;
      expect(bs.pdf).toBeCloseTo(lambert.pdf(wo, bs.wi, TransportMode.Radiance), 12);
      expect(bs.f.r).toBeCloseTo(lambert.eval(wo, bs.wi, TransportMode.Radiance).r, 12);
      expect(bs.wi.z).toBeGreaterThan(0); // wo.z > 0: samples stay in wo's hemisphere
      expect(bs.eta).toBe(1);
    }
  });

  it('is reflection-only: opposite hemisphere gives zero f and zero pdf', () => {
    const below = new Vec3(0.1, 0.2, -0.9).normalize();
    expect(lambert.eval(wo, below, TransportMode.Radiance).isBlack()).toBe(true);
    expect(lambert.pdf(wo, below, TransportMode.Radiance)).toBe(0);
  });

  it('SurfaceBSDF round-trips through an arbitrary shading frame', () => {
    const ns = new Vec3(1, 2, 0.5).normalize();
    const surf = new SurfaceBSDF(lambert, ns, ns);
    const s = sampler(3);
    const woWorld = ns.add(new Vec3(0.3, -0.1, 0.2)).normalize();
    for (let i = 0; i < 500; i++) {
      const bs = surf.sample(woWorld, s.next1D(), s.next2D(), TransportMode.Radiance);
      expect(bs).not.toBeNull();
      // Sampled direction lies in the shading hemisphere of woWorld.
      expect(bs!.wi.dot(ns)).toBeGreaterThan(0);
      expect(bs!.pdf).toBeCloseTo(surf.pdf(woWorld, bs!.wi, TransportMode.Radiance), 12);
    }
  });
});

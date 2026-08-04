// The claim the sample-swarm figure rests on: uniform sampling and the
// BSDF's own importance sampling estimate the SAME integral, and differ
// only in variance. If that were not true the figure would be comparing
// two different quantities and calling it a lesson about sampling.
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/math/vec3';
import { Color } from '../src/core/math/color';
import { Lambert } from '../src/core/materials/lambert';
import { GGXConductor } from '../src/core/materials/conductor';
import { UniformSamplingBxDF } from '../src/core/materials/uniform-sampled';
import { SmoothConductor } from '../src/core/materials/conductor';
import { TransportMode, isSpecular } from '../src/core/materials/bsdf';
import { UNIFORM_HEMISPHERE_PDF, uniformSampleHemisphere } from '../src/core/math/sampling';
import { PCG32 } from '../src/core/math/pcg32';
import { fromNumber, U64_ZERO } from '../src/core/math/u64';
import type { BxDF } from '../src/core/materials/bsdf';

const rng = () => {
  const r = new PCG32(U64_ZERO, U64_ZERO);
  r.setSequence(fromNumber(7), fromNumber(11));
  return r;
};

// Monte Carlo estimate of the directional albedo, ∫ f·cos dω, using
// whatever density the BxDF samples from. This is exactly the factor the
// walk multiplies into throughput, averaged.
function albedoEstimate(bxdf: BxDF, wo: Vec3, n: number): Color {
  const r = rng();
  let sum = Color.BLACK;
  for (let i = 0; i < n; i++) {
    const s = bxdf.sample(wo, r.nextFloat(), [r.nextFloat(), r.nextFloat()], TransportMode.Radiance);
    if (!s || s.pdf === 0) continue;
    sum = sum.add(s.f.scale(Math.abs(s.wi.z) / s.pdf));
  }
  return sum.scale(1 / n);
}

describe('uniformSampleHemisphere', () => {
  it('stays on the +z hemisphere and on the unit sphere', () => {
    const r = rng();
    for (let i = 0; i < 500; i++) {
      const w = uniformSampleHemisphere([r.nextFloat(), r.nextFloat()]);
      expect(w.length()).toBeCloseTo(1, 9);
      expect(w.z).toBeGreaterThanOrEqual(0);
    }
  });

  it('is uniform in solid angle — equal-area bands get equal counts', () => {
    // Uniform over the hemisphere means uniform in z, so splitting z into
    // four equal bands should split the samples four ways.
    const r = rng();
    const bands = [0, 0, 0, 0];
    const n = 40000;
    for (let i = 0; i < n; i++) {
      const w = uniformSampleHemisphere([r.nextFloat(), r.nextFloat()]);
      bands[Math.min(3, Math.floor(w.z * 4))]! += 1;
    }
    for (const c of bands) expect(c / n).toBeCloseTo(0.25, 2);
  });
});

describe('UniformSamplingBxDF', () => {
  const wo = new Vec3(0.3, -0.2, 0.93).normalize();

  it('reports the density it actually samples from', () => {
    const b = new UniformSamplingBxDF(new Lambert(new Color(0.6, 0.6, 0.6)));
    const r = rng();
    const s = b.sample(wo, r.nextFloat(), [r.nextFloat(), r.nextFloat()], TransportMode.Radiance)!;
    expect(s.pdf).toBeCloseTo(UNIFORM_HEMISPHERE_PDF, 12);
    // pdf() must agree with sample(), or every MIS weight built on it is wrong.
    expect(b.pdf(wo, s.wi, TransportMode.Radiance)).toBeCloseTo(s.pdf, 12);
    // ...and be zero across the surface, where nothing is sampled.
    expect(b.pdf(wo, new Vec3(0, 0, -1), TransportMode.Radiance)).toBe(0);
  });

  it('leaves f alone — only the density changes', () => {
    const inner = new GGXConductor(new Color(1, 0.77, 0.34), 0.3);
    const b = new UniformSamplingBxDF(inner);
    const wi = new Vec3(-0.4, 0.1, 0.91).normalize();
    const a = inner.eval(wo, wi, TransportMode.Radiance);
    const c = b.eval(wo, wi, TransportMode.Radiance);
    expect(c.r).toBeCloseTo(a.r, 12);
    expect(c.g).toBeCloseTo(a.g, 12);
    expect(c.b).toBeCloseTo(a.b, 12);
  });

  it('estimates the same albedo as cosine sampling does, for Lambert', () => {
    const albedo = new Color(0.6, 0.45, 0.3);
    const inner = new Lambert(albedo);
    const importance = albedoEstimate(inner, wo, 20000);
    const uniform = albedoEstimate(new UniformSamplingBxDF(inner), wo, 200000);
    // Ground truth for Lambert is the albedo itself.
    expect(importance.r).toBeCloseTo(albedo.r, 6); // cosine sampling is exact here
    expect(uniform.r).toBeCloseTo(albedo.r, 2);
    expect(uniform.g).toBeCloseTo(albedo.g, 2);
    expect(uniform.b).toBeCloseTo(albedo.b, 2);
  });

  it('estimates the same albedo as GGX importance sampling does', () => {
    const inner = new GGXConductor(new Color(0.9, 0.9, 0.9), 0.35);
    const importance = albedoEstimate(inner, wo, 40000);
    const uniform = albedoEstimate(new UniformSamplingBxDF(inner), wo, 400000);
    expect(uniform.r).toBeCloseTo(importance.r, 1);
  });

  it('is exactly constant-weight under cosine sampling — the reason the toggle exists', () => {
    // f·cos/pdf = (albedo/pi)·cos / (cos/pi) = albedo, for EVERY direction.
    // So on Lambert the renderer's own paths all carry identical weight and
    // the lobe is visible only as ray density. Uniform sampling is what
    // makes the weight vary and the lobe appear as thickness instead.
    const albedo = new Color(0.7, 0.7, 0.7);
    const inner = new Lambert(albedo);
    const r = rng();
    for (let i = 0; i < 200; i++) {
      const s = inner.sample(wo, r.nextFloat(), [r.nextFloat(), r.nextFloat()], TransportMode.Radiance);
      if (!s) continue;
      expect(s.f.r * Math.abs(s.wi.z) / s.pdf).toBeCloseTo(albedo.r, 9);
    }
  });

  it('varies by orders of magnitude under uniform sampling', () => {
    const b = new UniformSamplingBxDF(new GGXConductor(new Color(1, 1, 1), 0.15));
    const r = rng();
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i < 4000; i++) {
      const s = b.sample(wo, r.nextFloat(), [r.nextFloat(), r.nextFloat()], TransportMode.Radiance);
      if (!s) continue;
      const w = (s.f.r * Math.abs(s.wi.z)) / s.pdf;
      lo = Math.min(lo, w);
      hi = Math.max(hi, w);
    }
    expect(hi / Math.max(lo, 1e-12)).toBeGreaterThan(100);
  });

  it('passes a specular material straight through', () => {
    const inner = new SmoothConductor(new Color(0.95, 0.95, 0.95));
    const b = new UniformSamplingBxDF(inner);
    expect(isSpecular(b.flags)).toBe(true);
    const s = b.sample(wo, 0.5, [0.3, 0.7], TransportMode.Radiance)!;
    const direct = inner.sample(wo, 0.5, [0.3, 0.7], TransportMode.Radiance)!;
    // The mirror direction, not a uniform one.
    expect(s.wi.x).toBeCloseTo(direct.wi.x, 12);
    expect(s.wi.z).toBeCloseTo(direct.wi.z, 12);
    expect(s.pdf).toBeCloseTo(direct.pdf, 12);
  });
});

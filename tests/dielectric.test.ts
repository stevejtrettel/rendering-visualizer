import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/math/vec3';
import { Color } from '../src/core/math/color';
import { frDielectric, refractLocal, schlick } from '../src/core/materials/fresnel';
import { Dielectric } from '../src/core/materials/dielectric';
import { SmoothConductor } from '../src/core/materials/conductor';
import { REFLECTION, SPECULAR, TRANSMISSION, TransportMode } from '../src/core/materials/bsdf';

const IOR = 1.5;

describe('frDielectric', () => {
  it('matches the closed form at normal incidence', () => {
    // ((n-1)/(n+1))^2 = 0.04 for n = 1.5
    expect(frDielectric(1, IOR)).toBeCloseTo(0.04, 10);
    expect(frDielectric(-1, IOR)).toBeCloseTo(0.04, 10); // same from inside
  });

  it('goes to 1 at grazing incidence and stays in [0, 1]', () => {
    expect(frDielectric(1e-6, IOR)).toBeCloseTo(1, 3);
    for (let c = 0.05; c <= 1; c += 0.05) {
      const F = frDielectric(c, IOR);
      expect(F).toBeGreaterThanOrEqual(0);
      expect(F).toBeLessThanOrEqual(1);
    }
  });

  it('total internal reflection beyond the critical angle (from inside)', () => {
    // critical angle: sin(c) = 1/1.5 -> cos(c) ~ 0.7454
    expect(frDielectric(-0.5, IOR)).toBe(1); // 60 deg > critical
    expect(frDielectric(-0.9, IOR)).toBeLessThan(1); // 25.8 deg < critical
  });
});

describe('refractLocal', () => {
  it("obeys Snell's law entering the medium", () => {
    const theta = Math.PI / 6;
    const wo = new Vec3(Math.sin(theta), 0, Math.cos(theta));
    const r = refractLocal(wo, IOR)!;
    expect(r.etap).toBeCloseTo(IOR, 12);
    const sinT = Math.sin(theta) / IOR;
    expect(r.wi.x).toBeCloseTo(-sinT, 10); // bends toward the normal
    expect(r.wi.z).toBeCloseTo(-Math.sqrt(1 - sinT * sinT), 10); // into the surface
    expect(r.wi.length()).toBeCloseTo(1, 12);
  });

  it('returns null under total internal reflection', () => {
    const wo = new Vec3(Math.sqrt(1 - 0.25), 0, -0.5); // 60 deg from inside
    expect(refractLocal(wo, IOR)).toBeNull();
  });
});

describe('Dielectric BSDF', () => {
  const glass = new Dielectric(IOR);
  const wo = new Vec3(0.4, 0.2, 0.85).normalize();

  it('honors the delta contract: eval and pdf are zero', () => {
    expect(glass.eval(wo, new Vec3(-0.4, -0.2, 0.85).normalize(), TransportMode.Radiance).isBlack()).toBe(true);
    expect(glass.pdf(wo, new Vec3(0, 0, 1), TransportMode.Radiance)).toBe(0);
  });

  it('lobe selection matches Fresnel and weights are exact', () => {
    const R = frDielectric(wo.z, IOR);
    // Force reflection: uc just below R.
    const refl = glass.sample(wo, R * 0.5, [0, 0], TransportMode.Radiance)!;
    expect(refl.flags).toBe(SPECULAR | REFLECTION);
    expect(refl.wi.z).toBeCloseTo(wo.z, 12);
    expect(refl.pdf).toBeCloseTo(R, 12);
    // Throughput weight f*|cos|/pdf = 1 for a lossless reflection.
    expect((refl.f.r * Math.abs(refl.wi.z)) / refl.pdf).toBeCloseTo(1, 12);
    expect(refl.eta).toBe(1);

    // Force transmission: uc just above R.
    const trans = glass.sample(wo, R + (1 - R) * 0.5, [0, 0], TransportMode.Importance)!;
    expect(trans.flags).toBe(SPECULAR | TRANSMISSION);
    expect(trans.eta).toBeCloseTo(IOR, 12);
    // Importance mode: no eta^2 factor -> weight exactly 1.
    expect((trans.f.r * Math.abs(trans.wi.z)) / trans.pdf).toBeCloseTo(1, 12);
  });

  it('applies the eta^2 radiance compression in Radiance mode only', () => {
    const R = frDielectric(wo.z, IOR);
    const uc = R + (1 - R) * 0.5;
    const radiance = glass.sample(wo, uc, [0, 0], TransportMode.Radiance)!;
    const importance = glass.sample(wo, uc, [0, 0], TransportMode.Importance)!;
    // Entering the denser medium: radiance version carries 1/eta^2.
    expect(radiance.f.r / importance.f.r).toBeCloseTo(1 / (IOR * IOR), 12);

    // Exiting (wo below the surface, within the critical angle): eta' = 1/1.5,
    // so the radiance weight EXPANDS by eta^2.
    const inside = new Vec3(0.3, 0.1, -0.94).normalize();
    const Ri = frDielectric(inside.z, IOR);
    const uci = Ri + (1 - Ri) * 0.5;
    const out = glass.sample(inside, uci, [0, 0], TransportMode.Radiance)!;
    expect(out.eta).toBeCloseTo(1 / IOR, 12);
    expect((out.f.r * Math.abs(out.wi.z)) / out.pdf).toBeCloseTo(IOR * IOR, 10);
  });

  it('always reflects beyond the critical angle', () => {
    const grazingInside = new Vec3(Math.sqrt(1 - 0.25), 0, -0.5);
    for (const uc of [0.01, 0.5, 0.99]) {
      const bs = grazingInside && new Dielectric(IOR).sample(grazingInside, uc, [0, 0], TransportMode.Radiance)!;
      expect(bs.flags & REFLECTION).toBeTruthy();
      expect(bs.pdf).toBe(1);
    }
  });
});

describe('SmoothConductor', () => {
  it('mirrors about the normal with Fresnel-weighted throughput', () => {
    const f0 = new Color(0.9, 0.6, 0.3);
    const mirror = new SmoothConductor(f0);
    const wo = new Vec3(0.5, -0.3, 0.8).normalize();
    const bs = mirror.sample(wo, 0.5, [0, 0], TransportMode.Radiance)!;
    expect(bs.wi.x).toBeCloseTo(-wo.x, 12);
    expect(bs.wi.y).toBeCloseTo(-wo.y, 12);
    expect(bs.wi.z).toBeCloseTo(wo.z, 12);
    const F = schlick(f0, wo.z);
    expect((bs.f.r * Math.abs(bs.wi.z)) / bs.pdf).toBeCloseTo(F.r, 12);
    expect(mirror.pdf(wo, bs.wi, TransportMode.Radiance)).toBe(0);
  });
});

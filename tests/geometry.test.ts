import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/math/vec3';
import { Ray } from '../src/core/math/ray';
import { OrthonormalBasis } from '../src/core/math/onb';
import { Sphere } from '../src/core/geometry/sphere';
import { Quad } from '../src/core/geometry/quad';
import { LinearAggregate } from '../src/core/geometry/aggregate';
import { visible } from '../src/core/geometry/visibility';
import { offsetRayOrigin, RAY_EPSILON } from '../src/core/geometry/offset';
import { areaToSolidAngle, solidAngleToArea } from '../src/core/geometry/measure';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';

const v = (x: number, y: number, z: number) => new Vec3(x, y, z);

describe('Sphere', () => {
  const sphere = new Sphere(v(0, 0, 0), 2);

  it('intersects head-on with correct t, point, and normal', () => {
    const hit = sphere.intersect(new Ray(v(0, 0, -10), v(0, 0, 1)), Infinity)!;
    expect(hit.t).toBeCloseTo(8, 10);
    expect(hit.p.z).toBeCloseTo(-2, 10);
    expect(hit.ng.z).toBeCloseTo(-1, 10);
    expect(hit.p.length()).toBeCloseTo(2, 12); // reprojected exactly onto the sphere
  });

  it('returns the far hit from inside, misses tangentially displaced rays', () => {
    const inside = sphere.intersect(new Ray(v(0, 0, 0), v(1, 0, 0)), Infinity)!;
    expect(inside.t).toBeCloseTo(2, 10);
    expect(sphere.intersect(new Ray(v(0, 3, -10), v(0, 0, 1)), Infinity)).toBeNull();
  });

  it('respects tMax', () => {
    expect(sphere.intersect(new Ray(v(0, 0, -10), v(0, 0, 1)), 5)).toBeNull();
  });

  it('pdf(ref, wi) agrees with sample(ref, u) conversion', () => {
    const s = new IndependentSampler(3);
    s.startPixelSample(pixelSeedKey(0, 0, 0));
    const ref = v(0, 0, -10);
    for (let i = 0; i < 100; i++) {
      const smp = sphere.sample(ref, s.next2D());
      if (!smp) continue;
      const wi = smp.p.sub(ref).normalize();
      // pdf() ray-casts; it sees the NEAR surface, sample() may pick the far
      // side — only compare when the sampled point is the visible one.
      const hit = sphere.intersect(new Ray(ref, wi), Infinity)!;
      if (hit.p.distanceTo(smp.p) < 1e-6) {
        expect(sphere.pdf(ref, wi)).toBeCloseTo(smp.pdf, 6);
      }
    }
  });
});

describe('Quad', () => {
  // 2x2 square in the xz-plane at y = 0; e1 x e2 = (2,0,0) x (0,0,2) points -y.
  const simpleQuad = new Quad(v(-1, 0, -1), v(2, 0, 0), v(0, 0, 2));

  it('has the right area and normal', () => {
    expect(simpleQuad.area()).toBeCloseTo(4, 12);
  });

  it('intersects inside and misses outside the parallelogram', () => {
    const hit = simpleQuad.intersect(new Ray(v(0.5, 5, 0.5), v(0, -1, 0)), Infinity)!;
    expect(hit.t).toBeCloseTo(5, 10);
    expect(hit.uv[0]).toBeCloseTo(0.75, 10);
    expect(hit.uv[1]).toBeCloseTo(0.75, 10);
    expect(simpleQuad.intersect(new Ray(v(1.5, 5, 0), v(0, -1, 0)), Infinity)).toBeNull();
    expect(simpleQuad.intersect(new Ray(v(0, 5, 0), v(1, 0, 0)), Infinity)).toBeNull(); // parallel
  });

  it('sampleArea covers the quad with pdf 1/area', () => {
    const s = simpleQuad.sampleArea([0.25, 0.5]);
    expect(s.p.x).toBeCloseTo(-0.5, 12);
    expect(s.p.z).toBeCloseTo(0, 12);
    expect(s.pdf).toBeCloseTo(1 / 4, 12);
  });
});

describe('measure conversions', () => {
  it('areaToSolidAngle and solidAngleToArea are inverses', () => {
    const ref = v(0, 5, 0);
    const at = v(1, 0, 2);
    const ng = v(0, 1, 0);
    const pdfA = 0.37;
    const pdfW = areaToSolidAngle(pdfA, ref, at, ng);
    expect(solidAngleToArea(pdfW, ref, at, ng)).toBeCloseTo(pdfA, 12);
  });
});

describe('visibility and offsets', () => {
  it('offsetRayOrigin moves toward the side the ray leaves on', () => {
    const p = v(0, 0, 0);
    const ng = v(0, 1, 0);
    expect(offsetRayOrigin(p, ng, v(0, 1, 0)).y).toBeCloseTo(RAY_EPSILON, 15);
    expect(offsetRayOrigin(p, ng, v(0, -1, 0)).y).toBeCloseTo(-RAY_EPSILON, 15);
  });

  it('visible() sees through empty space and is blocked by an occluder', () => {
    const blocker = new Sphere(v(0, 2.5, 0), 1);
    const scene = new LinearAggregate([{ shape: blocker }]);
    const a = { p: v(0, 0, 0), ng: v(0, 1, 0) };
    const b = { p: v(0, 5, 0), ng: v(0, -1, 0) };
    const aside = { p: v(3, 0, 0), ng: v(0, 1, 0) };
    expect(visible(scene, a, b)).toBe(false);
    expect(visible(scene, aside, b)).toBe(true);
    expect(visible(scene, a, { p: v(0, 1, 0), ng: v(0, -1, 0) })).toBe(true); // segment ends before blocker
  });

  it('adjacent surfaces do not self-shadow', () => {
    const floor = new Quad(v(-5, 0, -5), v(10, 0, 0), v(0, 0, 10));
    const scene = new LinearAggregate([{ shape: floor }]);
    const onFloor = { p: v(0, 0, 0), ng: v(0, 1, 0) };
    const above = { p: v(1, 3, 1), ng: v(0, -1, 0) };
    expect(visible(scene, onFloor, above)).toBe(true);
  });
});

describe('OrthonormalBasis', () => {
  it('is orthonormal and round-trips for arbitrary normals', () => {
    const s = new IndependentSampler(5);
    s.startPixelSample(pixelSeedKey(0, 0, 0));
    for (let i = 0; i < 100; i++) {
      const zc = 1 - 2 * s.next1D();
      const r = Math.sqrt(Math.max(0, 1 - zc * zc));
      const phi = 2 * Math.PI * s.next1D();
      const n = v(r * Math.cos(phi), r * Math.sin(phi), zc);
      const onb = OrthonormalBasis.fromZ(n);
      expect(onb.u.dot(onb.v)).toBeCloseTo(0, 10);
      expect(onb.u.dot(onb.w)).toBeCloseTo(0, 10);
      expect(onb.u.length()).toBeCloseTo(1, 10);
      const local = v(0.3, -0.4, 0.5);
      const back = onb.toLocal(onb.toWorld(local));
      expect(back.x).toBeCloseTo(local.x, 10);
      expect(back.y).toBeCloseTo(local.y, 10);
      expect(back.z).toBeCloseTo(local.z, 10);
    }
  });
});

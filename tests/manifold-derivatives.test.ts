// Finite-difference validation of the manifold machinery's derivatives —
// the surface partials in the hit record and the constraint Jacobians.
// Silent sign/factor bugs here would not crash anything; they would bend
// every Newton step and bias the generalized G. FD is the ground truth.
//
// Exactness map (see core/manifold/vertex.ts header): the angle-difference
// Jacobian is exact everywhere (it never touches the frame derivatives at
// the default offset normal); the half-vector Jacobian is exact AT
// solutions and quasi-Newton away from them — so it is FD-tested at a
// converged root only.
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/math/vec3';
import { Ray } from '../src/core/math/ray';
import { Sphere } from '../src/core/geometry/sphere';
import { Quad } from '../src/core/geometry/quad';
import { TriangleMesh } from '../src/core/geometry/triangle-mesh';
import { LinearAggregate } from '../src/core/geometry/aggregate';
import { Mat2 } from '../src/core/manifold/mat2';
import { ManifoldVertex } from '../src/core/manifold/vertex';
import {
  computeStepAnglediff,
  computeStepHalfvector,
} from '../src/core/manifold/constraints';
import { manifoldWalk, DEFAULT_MANIFOLD_WALK_OPTIONS } from '../src/core/manifold/newton';
import type { ShapeIntersection } from '../src/core/geometry/shape';

const EPS = 1e-5;

// Relative comparison with an absolute floor for near-zero entries.
const expectClose = (actual: number, expected: number, rel = 1e-3, absFloor = 1e-6) => {
  const tol = Math.max(absFloor, rel * Math.abs(expected));
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
};

// Closed-form sphere parameterization matching Sphere.intersect's uv:
// p(u, v) = c + r(sin θ cos φ, sin θ sin φ, cos θ), φ = 2πu, θ = πv.
const spherePoint = (c: Vec3, r: number, u: number, v: number): Vec3 => {
  const phi = 2 * Math.PI * u;
  const theta = Math.PI * v;
  return c.add(
    new Vec3(
      Math.sin(theta) * Math.cos(phi),
      Math.sin(theta) * Math.sin(phi),
      Math.cos(theta),
    ).scale(r),
  );
};

// Build a real hit record at a given (u, v) by tracing radially inward.
const sphereHitAtUV = (sphere: Sphere, u: number, v: number): ShapeIntersection => {
  const target = spherePoint(sphere.center, sphere.radius, u, v);
  const dir = target.sub(sphere.center).normalize();
  const hit = sphere.intersect(new Ray(sphere.center.add(dir.scale(sphere.radius + 5)), dir.neg()), Infinity);
  if (!hit) throw new Error('sphereHitAtUV: missed the sphere');
  return hit;
};

describe('Mat2', () => {
  it('inverse and solve round-trip', () => {
    const m = new Mat2(2, 1, -0.5, 3);
    const inv = m.inverse()!;
    const id = m.mul(inv);
    expectClose(id.m00, 1, 1e-12);
    expectClose(id.m11, 1, 1e-12);
    expectClose(id.m01, 0, 1e-12, 1e-12);
    expectClose(id.m10, 0, 1e-12, 1e-12);
    const [x, y] = inv.mulVec(4, -1);
    expectClose(m.mulVec(x, y)[0], 4, 1e-12);
    expectClose(m.mulVec(x, y)[1], -1, 1e-12);
  });

  it('det guard returns null instead of exploding', () => {
    expect(new Mat2(1, 2, 2, 4).inverse(1e-6)).toBeNull();
    expect(new Mat2(1e-2, 0, 0, 1e-2).inverse(1e-6)).not.toBeNull();
  });
});

describe('sphere derivatives', () => {
  const sphere = new Sphere(new Vec3(0.3, -0.2, 0.5), 1.3);

  it('dpdu/dpdv match central differences of the closed form', () => {
    for (const [u, v] of [
      [0.13, 0.41],
      [0.37, 0.62],
      [0.61, 0.29],
      [0.83, 0.55],
    ] as const) {
      const hit = sphereHitAtUV(sphere, u, v);
      const fdU = spherePoint(sphere.center, sphere.radius, u + EPS, v)
        .sub(spherePoint(sphere.center, sphere.radius, u - EPS, v))
        .scale(1 / (2 * EPS));
      const fdV = spherePoint(sphere.center, sphere.radius, u, v + EPS)
        .sub(spherePoint(sphere.center, sphere.radius, u, v - EPS))
        .scale(1 / (2 * EPS));
      for (const axis of ['x', 'y', 'z'] as const) {
        expectClose(hit.dpdu[axis], fdU[axis], 1e-4, 1e-6);
        expectClose(hit.dpdv[axis], fdV[axis], 1e-4, 1e-6);
      }
    }
  });

  it('dndu/dndv are exactly dpdu/r, dpdv/r', () => {
    const hit = sphereHitAtUV(sphere, 0.27, 0.44);
    for (const axis of ['x', 'y', 'z'] as const) {
      expectClose(hit.dndu[axis], hit.dpdu[axis] / sphere.radius, 1e-12, 1e-12);
      expectClose(hit.dndv[axis], hit.dpdv[axis] / sphere.radius, 1e-12, 1e-12);
    }
  });
});

describe('quad derivatives', () => {
  it('partials are the edges exactly; normal partials vanish', () => {
    const quad = new Quad(new Vec3(-1, -1, 0.5), new Vec3(2, 0, 0.1), new Vec3(0, 2, -0.2));
    const hit = quad.intersect(new Ray(new Vec3(0.1, 0.2, 5), new Vec3(0, 0, -1)), Infinity)!;
    expect(hit.dpdu).toBe(quad.e1);
    expect(hit.dpdv).toBe(quad.e2);
    expect(hit.dndu.length()).toBe(0);
    expect(hit.dndv.length()).toBe(0);
  });
});

describe('triangle-mesh derivatives', () => {
  // One triangle with genuinely varying vertex normals (Phong shading).
  const positions = new Float32Array([0, 0, 0, 1, 0, 0.2, 0.3, 1, -0.1]);
  const n0 = new Vec3(0.2, 0.3, 1).normalize();
  const n1 = new Vec3(-0.3, 0.2, 1).normalize();
  const n2 = new Vec3(0.1, -0.4, 1).normalize();
  const normals = new Float32Array([n0.x, n0.y, n0.z, n1.x, n1.y, n1.z, n2.x, n2.y, n2.z]);
  const mesh = new TriangleMesh(positions, normals, new Uint32Array([0, 1, 2]));

  const p0 = new Vec3(0, 0, 0);
  const p1 = new Vec3(1, 0, 0.2);
  const p2 = new Vec3(0.3, 1, -0.1);
  const baryPoint = (u: number, v: number) =>
    p0.scale(1 - u - v).add(p1.scale(u)).add(p2.scale(v));
  const interpNormal = (u: number, v: number) =>
    n0.scale(1 - u - v).add(n1.scale(u)).add(n2.scale(v)).normalize();

  const hitAtBary = (u: number, v: number) => {
    const target = baryPoint(u, v);
    const hit = mesh.intersect(new Ray(target.add(new Vec3(0, 0, 5)), new Vec3(0, 0, -1)), Infinity);
    if (!hit) throw new Error('missed triangle');
    return hit;
  };

  it('dpdu/dpdv are the triangle edges', () => {
    const hit = hitAtBary(0.3, 0.25);
    for (const axis of ['x', 'y', 'z'] as const) {
      // float32 vertex storage bounds the match.
      expectClose(hit.dpdu[axis], p1.sub(p0)[axis], 1e-6, 1e-6);
      expectClose(hit.dpdv[axis], p2.sub(p0)[axis], 1e-6, 1e-6);
    }
  });

  it('dndu/dndv match central differences of the normalized interpolant', () => {
    const [u, v] = [0.3, 0.25];
    const hit = hitAtBary(u, v);
    const fdU = interpNormal(u + EPS, v).sub(interpNormal(u - EPS, v)).scale(1 / (2 * EPS));
    const fdV = interpNormal(u, v + EPS).sub(interpNormal(u, v - EPS)).scale(1 / (2 * EPS));
    for (const axis of ['x', 'y', 'z'] as const) {
      // float32 normals: FD agreement to ~1e-3 relative is the honest bound.
      expectClose(hit.dndu[axis], fdU[axis], 3e-3, 1e-4);
      expectClose(hit.dndv[axis], fdV[axis], 3e-3, 1e-4);
    }
  });
});

describe('constraint Jacobians vs finite differences', () => {
  const sphere = new Sphere(new Vec3(0, 0, 0), 1);
  const a = new Vec3(0.5, 3, 0.2); // receiver, φ ≈ 90°
  const bReflect = new Vec3(3, 0.5, -0.1); // light for the mirror case
  const bRefract = new Vec3(-0.2, -0.3, 0.1); // light INSIDE the glass sphere

  // FD of the angle-difference constraint C(u, v), holding a and b fixed.
  const fdJacobian = (
    b: Vec3,
    eta: number,
    u: number,
    v: number,
    C: (vtx: ManifoldVertex) => [number, number],
  ): Mat2 => {
    const at = (uu: number, vv: number) => C(new ManifoldVertex(sphereHitAtUV(sphere, uu, vv), eta));
    const [cuP0, cuP1] = at(u + EPS, v);
    const [cuM0, cuM1] = at(u - EPS, v);
    const [cvP0, cvP1] = at(u, v + EPS);
    const [cvM0, cvM1] = at(u, v - EPS);
    return new Mat2(
      (cuP0 - cuM0) / (2 * EPS),
      (cvP0 - cvM0) / (2 * EPS),
      (cuP1 - cuM1) / (2 * EPS),
      (cvP1 - cvM1) / (2 * EPS),
    );
  };

  const compareJ = (J: Mat2, Jfd: Mat2, rel: number) => {
    const scale = Math.max(
      Math.abs(Jfd.m00),
      Math.abs(Jfd.m01),
      Math.abs(Jfd.m10),
      Math.abs(Jfd.m11),
    );
    for (const k of ['m00', 'm01', 'm10', 'm11'] as const) {
      expect(Math.abs(J[k] - Jfd[k])).toBeLessThanOrEqual(rel * scale);
    }
  };

  it('anglediff J is exact at arbitrary points (reflection)', () => {
    for (const [u, v] of [
      [0.12, 0.45],
      [0.18, 0.52],
      [0.08, 0.38],
    ] as const) {
      const vtx = new ManifoldVertex(sphereHitAtUV(sphere, u, v), 1);
      const step = computeStepAnglediff(a, vtx, bReflect)!;
      expect(step).not.toBeNull();
      const Jfd = fdJacobian(bReflect, 1, u, v, (vv) => computeStepAnglediff(a, vv, bReflect)!.C);
      compareJ(step.J, Jfd, 1e-3);
    }
  });

  it('anglediff J is exact at arbitrary points (refraction, eta = 1.5)', () => {
    for (const [u, v] of [
      [0.2, 0.48],
      [0.15, 0.55],
    ] as const) {
      const vtx = new ManifoldVertex(sphereHitAtUV(sphere, u, v), 1.5);
      const step = computeStepAnglediff(a, vtx, bRefract);
      expect(step).not.toBeNull();
      const Jfd = fdJacobian(bRefract, 1.5, u, v, (vv) => computeStepAnglediff(a, vv, bRefract)!.C);
      compareJ(step!.J, Jfd, 1e-3);
    }
  });

  it('halfvector J is exact at a converged root', () => {
    // Find a root precisely, then FD the half-vector constraint around it.
    const caster = { shape: sphere };
    const agg = new LinearAggregate([caster]);
    const seed = agg.intersect(new Ray(a, spherePoint(sphere.center, 1, 0.12, 0.48).sub(a).normalize()))!;
    const result = manifoldWalk(
      a,
            seed,
      1,
      bReflect,
      caster,
      agg,
      { ...DEFAULT_MANIFOLD_WALK_OPTIONS, solverThreshold: 1e-12, maxIterations: 40 },
    );
    expect(result.outcome).toBe('converged');
    const root = result.vertex!;

    // Recover the root's (u, v) via a fresh trace, then FD around it.
    const rootHit = agg.intersect(new Ray(a, root.p.sub(a).normalize()))!;
    const [u, v] = rootHit.uv;
    const step = computeStepHalfvector(a, new ManifoldVertex(rootHit, 1), bReflect)!;
    expect(step).not.toBeNull();
    expect(Math.hypot(step.C[0], step.C[1])).toBeLessThan(1e-9);
    const Jfd = fdJacobian(bReflect, 1, u, v, (vv) => computeStepHalfvector(a, vv, bReflect)!.C);
    compareJ(step.J, Jfd, 1e-3);
  });
});

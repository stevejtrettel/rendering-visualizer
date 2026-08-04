// The manifold walk end-to-end: the planar-mirror closed form (unique
// root, exact generalized G), constraint⇔BSDF-sampler agreement at
// converged roots, the multi-root mirror sphere (what MNEE cannot see),
// determinism, and an implicit-function-theorem FD check of the
// generalized G's determinant ratio on a curved caster.
import { describe, expect, it } from 'vitest';
import { Vec3, absDot } from '../src/core/math/vec3';
import { Ray } from '../src/core/math/ray';
import { Color } from '../src/core/math/color';
import { OrthonormalBasis } from '../src/core/math/onb';
import { PCG32 } from '../src/core/math/pcg32';
import { u64 } from '../src/core/math/u64';
import { uniformSampleSphere, type Sample2D } from '../src/core/math/sampling';
import { Sphere } from '../src/core/geometry/sphere';
import { Quad } from '../src/core/geometry/quad';
import { LinearAggregate, type Primitive } from '../src/core/geometry/aggregate';
import { SmoothConductor } from '../src/core/materials/conductor';
import { Dielectric } from '../src/core/materials/dielectric';
import { frDielectric } from '../src/core/materials/fresnel';
import { TransportMode } from '../src/core/materials/bsdf';
import { ManifoldVertex } from '../src/core/manifold/vertex';
import {
  manifoldWalk,
  sameSolution,
  DEFAULT_MANIFOLD_WALK_OPTIONS,
  UNIQUENESS_THRESHOLD,
  type ManifoldWalkOptions,
  type ManifoldWalkResult,
} from '../src/core/manifold/newton';
import {
  geometricTerm,
  specularManifoldDetRatio,
} from '../src/core/manifold/geometry-term';
import type { ConstraintType } from '../src/core/manifold/constraints';

// Synthetic endpoint vertex (receiver or light point) with an orthonormal
// frame — already area-parameterized, dn = 0.
const pointVertex = (p: Vec3, n: Vec3): ManifoldVertex => {
  const onb = OrthonormalBasis.fromZ(n);
  return new ManifoldVertex(
    { p, ns: n, ng: n, dpdu: onb.u, dpdv: onb.v, dndu: Vec3.ZERO, dndv: Vec3.ZERO },
    1,
  );
};

const TIGHT: ManifoldWalkOptions = {
  ...DEFAULT_MANIFOLD_WALK_OPTIONS,
  solverThreshold: 1e-12,
  maxIterations: 50,
};

describe('planar mirror: the closed-form single root', () => {
  const mirror = new Quad(new Vec3(-2, -2, 0), new Vec3(4, 0, 0), new Vec3(0, 4, 0));
  const caster: Primitive = { shape: mirror };
  const aggregate = new LinearAggregate([caster]);
  const a = new Vec3(-0.7, 0.3, 1.2);
  const b = new Vec3(0.9, -0.4, 0.8);
  
  // Mirror image construction: b' = b reflected through z = 0, x* on the
  // segment a→b' at z = 0.
  const bMirrored = new Vec3(b.x, b.y, -b.z);
  const s = a.z / (a.z - bMirrored.z); // 0.6
  const xStar = a.add(bMirrored.sub(a).scale(s));

  const seedAt = (u: number, v: number) => {
    const target = mirror.q.add(mirror.e1.scale(u)).add(mirror.e2.scale(v));
    const hit = aggregate.intersect(new Ray(a, target.sub(a).normalize()));
    if (!hit) throw new Error('seed missed the mirror');
    return hit;
  };

  for (const constraint of ['halfvector', 'anglediff'] as ConstraintType[]) {
    it(`${constraint}: converges to the mirror-image point from any seed`, () => {
      for (const [u, v] of [
        [0.1, 0.1],
        [0.9, 0.2],
        [0.5, 0.95],
        [0.05, 0.6],
      ] as const) {
        const result = manifoldWalk(a, seedAt(u, v), 1, b, caster, aggregate, {
          ...DEFAULT_MANIFOLD_WALK_OPTIONS,
          constraint,
        });
        expect(result.outcome).toBe('converged');
        expect(result.vertex!.p.distanceTo(xStar)).toBeLessThan(1e-4);
      }
    });

    it(`${constraint}: a near seed converges in a few iterations (papers: 2–4)`, () => {
      // Seed close to the root's own (u, v) on the quad.
      const uStar = (xStar.x + 2) / 4;
      const vStar = (xStar.y + 2) / 4;
      const result = manifoldWalk(a, seedAt(uStar + 0.03, vStar - 0.03), 1, b, caster, aggregate, {
        ...DEFAULT_MANIFOLD_WALK_OPTIONS,
        constraint,
      });
      expect(result.outcome).toBe('converged');
      expect(result.iterates.length).toBeLessThanOrEqual(6);
    });
  }

  it('generalized G equals the classical G of the unfolded path (exact on a plane)', () => {
    const result = manifoldWalk(a, seedAt(0.3, 0.7), 1, b, caster, aggregate, TIGHT);
    expect(result.outcome).toBe('converged');

    const v0 = pointVertex(a, new Vec3(0, 0, 1));
    const rootHit = aggregate.intersect(new Ray(a, result.vertex!.p.sub(a).normalize()))!;
    const v1 = new ManifoldVertex(rootHit, 1);
    const v2 = pointVertex(b, new Vec3(0, 0, -1)); // light faces the mirror
    v0.makeOrthonormal();
    v1.makeOrthonormal();
    v2.makeOrthonormal();

    // det ratio on a plane is exactly s² (similar triangles), safely
    // below the clamp.
    const ratio = specularManifoldDetRatio(v0, v1, v2)!;
    expect(ratio).toBeCloseTo(s * s, 6);

    // Unfolding identity: G equals the direct-connection Jacobian
    // dω/dA = cosθ/r² against the MIRRORED light.
    const dTot = a.sub(bMirrored);
    const expected = absDot(dTot.normalize(), new Vec3(0, 0, 1)) / dTot.lengthSq();
    expect(geometricTerm(v0, v1, v2)).toBeCloseTo(expected, 8);
  });
});

describe('constraint ⇔ BSDF sampler consistency at converged roots', () => {
  const sphere = new Sphere(new Vec3(0, 0, 0), 1);
  const caster: Primitive = { shape: sphere };
  const aggregate = new LinearAggregate([caster]);
  const a = new Vec3(0.5, 3, 0.2);
  
  const seedToward = (target: Vec3) => {
    const hit = aggregate.intersect(new Ray(a, target.sub(a).normalize()));
    if (!hit) throw new Error('seed missed the caster');
    return hit;
  };

  it('mirror root satisfies SmoothConductor.sample exactly', () => {
    const b = new Vec3(3, 0.5, -0.1);
    const result = manifoldWalk(a, seedToward(new Vec3(0.8, 0.8, 0)), 1, b, caster, aggregate, TIGHT);
    expect(result.outcome).toBe('converged');
    const v = result.vertex!;

    const onb = OrthonormalBasis.fromZ(v.n);
    const woLocal = onb.toLocal(a.sub(v.p).normalize());
    const bs = new SmoothConductor(new Color(0.9, 0.9, 0.9)).sample(woLocal, 0.5, [0, 0] as Sample2D, TransportMode.Radiance)!;
    const wiWorld = onb.toWorld(bs.wi);
    expect(wiWorld.dot(b.sub(v.p).normalize())).toBeGreaterThan(1 - 1e-9);
  });

  it('refraction root satisfies Dielectric.sample (transmission lobe) exactly', () => {
    const b = new Vec3(-0.2, -0.3, 0.1); // inside the glass sphere
    const result = manifoldWalk(a, seedToward(new Vec3(0.2, 0.9, 0.1)), 1.5, b, caster, aggregate, TIGHT);
    expect(result.outcome).toBe('converged');
    const v = result.vertex!;

    const onb = OrthonormalBasis.fromZ(v.n);
    const woLocal = onb.toLocal(a.sub(v.p).normalize());
    expect(woLocal.z).toBeGreaterThan(0); // receiver on the outside
    const R = frDielectric(woLocal.z, 1.5);
    const bs = new Dielectric(1.5).sample(woLocal, R + (1 - R) * 0.5, [0, 0] as Sample2D, TransportMode.Radiance)!;
    const wiWorld = onb.toWorld(bs.wi);
    expect(wiWorld.dot(b.sub(v.p).normalize())).toBeGreaterThan(1 - 1e-9);
  });
});

// Alhazen's billiard problem: point-to-point reflection off the INSIDE of
// a mirror sphere has up to four roots, all visible (no occlusion is
// possible inside a sphere) and well separated — the cleanest multi-root
// fiber a single bounce can produce, and the configuration a
// deterministic-seed method (MNEE) structurally cannot cover. (A CONVEX
// mirror with both endpoints outside generically has a single visible
// root — found out empirically; the multi-root demos want concave
// geometry or refraction folds.)
describe('multi-root interior mirror (Alhazen)', () => {
  const sphere = new Sphere(new Vec3(0, 0, 0), 1);
  const caster: Primitive = { shape: sphere };
  const aggregate = new LinearAggregate([caster]);
  const a = new Vec3(0.5, 0, 0.1);
  const b = new Vec3(-0.4, 0.3, -0.05);
  
  const runBatch = (seedCount: number): { dirs: Vec3[]; results: ManifoldWalkResult[] } => {
    const rng = new PCG32(u64(0, 42), u64(0, 0));
    const results: ManifoldWalkResult[] = [];
    const dirs: Vec3[] = [];
    for (let i = 0; i < seedCount; i++) {
      const n = uniformSampleSphere([rng.nextFloat(), rng.nextFloat()]);
      const seed = aggregate.intersect(new Ray(a, n.sub(a).normalize()));
      if (!seed) continue; // a ray toward a sphere surface point always hits, but stay safe
      const result = manifoldWalk(a, seed, 1, b, caster, aggregate);
      results.push(result);
      if (result.outcome === 'converged') {
        const dir = result.vertex!.p.sub(a).normalize();
        if (!dirs.some((d) => sameSolution(d, dir))) dirs.push(dir);
      }
    }
    return { dirs, results };
  };

  it('random seeds discover all four Alhazen roots, never conflated', () => {
    const { dirs, results } = runBatch(128);
    expect(dirs.length).toBe(4);
    // Every walk converges in this configuration (empirically 256/256).
    expect(results.every((r) => r.outcome === 'converged')).toBe(true);
    for (let i = 0; i < dirs.length; i++) {
      for (let j = i + 1; j < dirs.length; j++) {
        // Distinct roots must be separated far beyond the identity
        // threshold, or deduplication would be meaningless.
        expect(Math.abs(dirs[i]!.dot(dirs[j]!) - 1)).toBeGreaterThan(100 * UNIQUENESS_THRESHOLD);
      }
    }
  });

  it('the batch is bit-deterministic', () => {
    const one = runBatch(64);
    const two = runBatch(64);
    expect(two.results.length).toBe(one.results.length);
    for (let i = 0; i < one.results.length; i++) {
      const r1 = one.results[i]!;
      const r2 = two.results[i]!;
      expect(r2.outcome).toBe(r1.outcome);
      expect(r2.iterates.length).toBe(r1.iterates.length);
      for (let k = 0; k < r1.iterates.length; k++) {
        expect(r2.iterates[k]!.p.x).toBe(r1.iterates[k]!.p.x);
        expect(r2.iterates[k]!.p.y).toBe(r1.iterates[k]!.p.y);
        expect(r2.iterates[k]!.p.z).toBe(r1.iterates[k]!.p.z);
        expect(r2.iterates[k]!.cNorm).toBe(r1.iterates[k]!.cNorm);
      }
    }
  });

  it('det ratio matches the implicit-function FD of the root position', () => {
    // Solve once; then move the light point in its tangent plane and
    // re-solve from the old root — the root's motion IS ∂x₁/∂x₂, and its
    // determinant must match the constraint-Jacobian ratio.
    const seed = aggregate.intersect(new Ray(a, new Vec3(-0.2, 0, 0.98).sub(a).normalize()))!;
    const base = manifoldWalk(a, seed, 1, b, caster, aggregate, TIGHT);
    expect(base.outcome).toBe('converged');
    const root = base.vertex!;

    const nL = new Vec3(0, 0, 0).sub(b).normalize(); // light faces the sphere
    const lightOnb = OrthonormalBasis.fromZ(nL);

    const EPS = 1e-4;
    const solveAt = (lightP: Vec3): Vec3 => {
      const s = aggregate.intersect(new Ray(a, root.p.sub(a).normalize()))!;
      const r = manifoldWalk(a, s, 1, lightP, caster, aggregate, TIGHT);
      expect(r.outcome).toBe('converged');
      return r.vertex!.p;
    };
    const col = (tangent: Vec3): Vec3 =>
      solveAt(b.add(tangent.scale(EPS)))
        .sub(solveAt(b.sub(tangent.scale(EPS))))
        .scale(1 / (2 * EPS));
    const d1 = col(lightOnb.u);
    const d2 = col(lightOnb.v);

    // Express root motion in the root's orthonormal parameterization.
    const rootHit = aggregate.intersect(new Ray(a, root.p.sub(a).normalize()))!;
    const v1 = new ManifoldVertex(rootHit, 1);
    v1.makeOrthonormal();
    const fdDet = Math.abs(
      d1.dot(v1.dpdu) * d2.dot(v1.dpdv) - d2.dot(v1.dpdu) * d1.dot(v1.dpdv),
    );

    const v0 = pointVertex(a, a.neg().normalize());
    const v2 = new ManifoldVertex(
      { p: b, ns: nL, ng: nL, dpdu: lightOnb.u, dpdv: lightOnb.v, dndu: Vec3.ZERO, dndv: Vec3.ZERO },
      1,
    );
    v0.makeOrthonormal();
    v2.makeOrthonormal();
    const ratio = specularManifoldDetRatio(v0, v1, v2)!;
    expect(ratio).not.toBeNull();
    expect(Math.abs(fdDet - ratio) / ratio).toBeLessThan(5e-3);
  });
});

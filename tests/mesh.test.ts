import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vec3 } from '../src/core/math/vec3';
import { Ray } from '../src/core/math/ray';
import { parseOBJ } from '../src/io/obj';
import { TriangleMesh } from '../src/core/geometry/triangle-mesh';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';
import { uniformSampleSphere } from '../src/core/math/sampling';

const CUBE_OBJ = `
# unit cube, quads, no normals
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 1
v 1 0 1
v 1 1 1
v 0 1 1
f 1 2 3 4
f 5 8 7 6
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 5 1 4 8
`;

describe('parseOBJ', () => {
  it('parses quads as triangle fans and computes smooth normals', () => {
    const mesh = parseOBJ(CUBE_OBJ);
    expect(mesh.positions.length / 3).toBe(8); // corners dedup'd
    expect(mesh.indices.length / 3).toBe(12); // 6 quads -> 12 tris
    // Smooth normals on a cube point along the corner diagonals.
    const n0 = [mesh.normals[0]!, mesh.normals[1]!, mesh.normals[2]!];
    expect(Math.hypot(...n0)).toBeCloseTo(1, 5);
  });

  it('handles v//vn and negative indices', () => {
    const text = `
v 0 0 0
v 1 0 0
v 0 1 0
vn 0 0 1
f -3//-1 -2//-1 -1//-1
`;
    const mesh = parseOBJ(text);
    expect(mesh.indices.length).toBe(3);
    expect(mesh.normals[2]).toBeCloseTo(1, 6);
  });
});

// Brute-force reference: test every triangle, no BVH.
function bruteForce(mesh: { positions: Float32Array; indices: Uint32Array }, ray: Ray, tMax: number): number | null {
  const P = mesh.positions;
  const I = mesh.indices;
  let best: number | null = null;
  for (let t = 0; t < I.length; t += 3) {
    const ia = I[t]! * 3, ib = I[t + 1]! * 3, ic = I[t + 2]! * 3;
    const a = new Vec3(P[ia]!, P[ia + 1]!, P[ia + 2]!);
    const e1 = new Vec3(P[ib]!, P[ib + 1]!, P[ib + 2]!).sub(a);
    const e2 = new Vec3(P[ic]!, P[ic + 1]!, P[ic + 2]!).sub(a);
    const p = ray.d.cross(e2);
    const det = e1.dot(p);
    if (Math.abs(det) < 1e-12) continue;
    const s = ray.o.sub(a);
    const u = s.dot(p) / det;
    if (u < 0 || u > 1) continue;
    const q = s.cross(e1);
    const v = ray.d.dot(q) / det;
    if (v < 0 || u + v > 1) continue;
    const hit = e2.dot(q) / det;
    if (hit <= 0 || hit >= tMax) continue;
    if (best === null || hit < best) best = hit;
  }
  return best;
}

describe('TriangleMesh + BVH', () => {
  const teapotText = readFileSync(join(import.meta.dirname, '../src/scenes/models/teapot.obj'), 'utf8');
  const parsed = parseOBJ(teapotText);

  it('BVH traversal agrees with brute force on thousands of random rays', () => {
    const t0 = performance.now();
    const mesh = new TriangleMesh(parsed.positions, parsed.normals, parsed.indices);
    const buildMs = performance.now() - t0;
    expect(mesh.triangleCount).toBe(parsed.indices.length / 3);

    const s = new IndependentSampler(11);
    s.startPixelSample(pixelSeedKey(0, 0, 0));
    let hits = 0;
    const N = 3000;
    const t1 = performance.now();
    for (let i = 0; i < N; i++) {
      // Rays from a shell around the model, aimed inward-ish.
      const origin = uniformSampleSphere(s.next2D()).scale(30);
      const target = uniformSampleSphere(s.next2D()).scale(5 * s.next1D());
      const ray = new Ray(origin, target.sub(origin).normalize());
      const bvhHit = mesh.intersect(ray, Infinity);
      const refT = bruteForce(parsed, ray, Infinity);
      if (refT === null) {
        expect(bvhHit).toBeNull();
      } else {
        hits += 1;
        expect(bvhHit).not.toBeNull();
        expect(bvhHit!.t).toBeCloseTo(refT, 4);
        // Shadow query agrees too.
        expect(mesh.intersectP(ray, refT * 1.001)).toBe(true);
        expect(mesh.intersectP(ray, refT * 0.5)).toBe(false);
      }
    }
    const rayMs = performance.now() - t1;
    expect(hits).toBeGreaterThan(N / 10); // the test actually exercised hits
    // eslint-disable-next-line no-console
    console.log(
      `[timing] teapot: ${mesh.triangleCount} tris, BVH build ${buildMs.toFixed(0)} ms, ` +
      `${((N / rayMs) * 1000).toFixed(0)} BVH rays/s (incl. brute-force overhead excluded)`,
    );
  });

  it('interpolates unit shading normals consistent with the geometric side', () => {
    const mesh = new TriangleMesh(parsed.positions, parsed.normals, parsed.indices);
    const s = new IndependentSampler(12);
    s.startPixelSample(pixelSeedKey(0, 0, 0));
    for (let i = 0; i < 200; i++) {
      const origin = uniformSampleSphere(s.next2D()).scale(30);
      const ray = new Ray(origin, origin.scale(-1).normalize());
      const hit = mesh.intersect(ray, Infinity);
      if (!hit) continue;
      expect(hit.ns.length()).toBeCloseTo(1, 5);
      expect(hit.ng.length()).toBeCloseTo(1, 5);
      expect(hit.ng.dot(hit.ns)).toBeGreaterThanOrEqual(0);
    }
  });
});

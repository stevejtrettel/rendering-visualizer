// Triangle mesh Shape: flat typed arrays, Möller–Trumbore, internal BVH.
// The intersection path is a sealed fast module — scalar, allocation-free
// until a hit is confirmed. Meshes cannot be area lights: the sampling
// methods throw (lights stay quads by design, see design-v1c.md).
import { Vec3 } from '../math/vec3';
import type { Ray } from '../math/ray';
import type { Sample2D } from '../math/sampling';
import { buildBVH, type BVH } from './bvh';
import type { Shape, ShapeIntersection, ShapeSample } from './shape';

const STACK = new Int32Array(64);

export class TriangleMesh implements Shape {
  private readonly bvh: BVH;
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly indices: Uint32Array;

  constructor(positions: Float32Array, normals: Float32Array, indices: Uint32Array) {
    this.positions = positions;
    this.normals = normals;
    this.indices = indices;
    this.bvh = buildBVH(positions, indices);
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  intersect(ray: Ray, tMax: number): ShapeIntersection | null {
    const hit = this.traverse(ray, tMax, false);
    if (!hit) return null;
    const [t, tri, bu, bv] = hit;
    const [ia, ib, ic] = [this.indices[tri * 3]! * 3, this.indices[tri * 3 + 1]! * 3, this.indices[tri * 3 + 2]! * 3];
    const P = this.positions;
    const N = this.normals;
    const w = 1 - bu - bv;
    const p = ray.at(t);
    // Geometric normal from winding; shading normal interpolated.
    const e1 = new Vec3(P[ib]! - P[ia]!, P[ib + 1]! - P[ia + 1]!, P[ib + 2]! - P[ia + 2]!);
    const e2 = new Vec3(P[ic]! - P[ia]!, P[ic + 1]! - P[ia + 1]!, P[ic + 2]! - P[ia + 2]!);
    let ng = e1.cross(e2).normalize();
    let ns = new Vec3(
      w * N[ia]! + bu * N[ib]! + bv * N[ic]!,
      w * N[ia + 1]! + bu * N[ib + 1]! + bv * N[ic + 1]!,
      w * N[ia + 2]! + bu * N[ib + 2]! + bv * N[ic + 2]!,
    );
    const nsLen = ns.length();
    ns = nsLen > 0 ? ns.scale(1 / nsLen) : ng;
    if (ng.dot(ns) < 0) ng = ng.neg(); // keep the two on the same side
    // Barycentric parameterization p(u, v) = (1−u−v)p0 + u·p1 + v·p2: the
    // position partials are the edges. Shading-normal partials by the
    // quotient rule on the normalized interpolant, projected ⊥ ns; zero on
    // degenerate (flat-shaded) normals.
    let dndu = Vec3.ZERO;
    let dndv = Vec3.ZERO;
    if (nsLen > 0) {
      const dnduRaw = new Vec3(N[ib]! - N[ia]!, N[ib + 1]! - N[ia + 1]!, N[ib + 2]! - N[ia + 2]!).scale(1 / nsLen);
      const dndvRaw = new Vec3(N[ic]! - N[ia]!, N[ic + 1]! - N[ia + 1]!, N[ic + 2]! - N[ia + 2]!).scale(1 / nsLen);
      dndu = dnduRaw.sub(ns.scale(ns.dot(dnduRaw)));
      dndv = dndvRaw.sub(ns.scale(ns.dot(dndvRaw)));
    }
    return { t, p, ng, ns, uv: [bu, bv], dpdu: e1, dpdv: e2, dndu, dndv };
  }

  intersectP(ray: Ray, tMax: number): boolean {
    return this.traverse(ray, tMax, true) !== null;
  }

  // Iterative BVH traversal. anyHit short-circuits for shadow rays.
  // Returns [t, triangleIndex, baryU, baryV] or null.
  private traverse(ray: Ray, tMax: number, anyHit: boolean): [number, number, number, number] | null {
    const { nodes, order } = this.bvh;
    if (this.bvh.nodeCount === 0) return null;
    const ox = ray.o.x, oy = ray.o.y, oz = ray.o.z;
    const dx = ray.d.x, dy = ray.d.y, dz = ray.d.z;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    const P = this.positions;
    const I = this.indices;

    let bestT = tMax;
    let bestTri = -1;
    let bestU = 0;
    let bestV = 0;
    let sp = 0;
    STACK[sp++] = 0;

    while (sp > 0) {
      const node = STACK[--sp]! * 8;
      // Slab test against [best so far].
      let t0 = (nodes[node]! - ox) * ix;
      let t1 = (nodes[node + 4]! - ox) * ix;
      if (ix < 0) { const tmp = t0; t0 = t1; t1 = tmp; }
      let u0 = (nodes[node + 1]! - oy) * iy;
      let u1 = (nodes[node + 5]! - oy) * iy;
      if (iy < 0) { const tmp = u0; u0 = u1; u1 = tmp; }
      if (u0 > t0) t0 = u0;
      if (u1 < t1) t1 = u1;
      let v0 = (nodes[node + 2]! - oz) * iz;
      let v1 = (nodes[node + 6]! - oz) * iz;
      if (iz < 0) { const tmp = v0; v0 = v1; v1 = tmp; }
      if (v0 > t0) t0 = v0;
      if (v1 < t1) t1 = v1;
      if (t0 > t1 || t0 > bestT || t1 < 0) continue;

      const a = nodes[node + 3]!;
      if (a >= 0) {
        // Leaf: Möller–Trumbore each triangle.
        const count = a;
        const offset = nodes[node + 7]!;
        for (let i = 0; i < count; i++) {
          const tri = order[offset + i]!;
          const ia = I[tri * 3]! * 3, ib = I[tri * 3 + 1]! * 3, ic = I[tri * 3 + 2]! * 3;
          const ax = P[ia]!, ay = P[ia + 1]!, az = P[ia + 2]!;
          const e1x = P[ib]! - ax, e1y = P[ib + 1]! - ay, e1z = P[ib + 2]! - az;
          const e2x = P[ic]! - ax, e2y = P[ic + 1]! - ay, e2z = P[ic + 2]! - az;
          const px = dy * e2z - dz * e2y;
          const py = dz * e2x - dx * e2z;
          const pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-12) continue;
          const inv = 1 / det;
          const sx = ox - ax, sy = oy - ay, sz = oz - az;
          const u = (sx * px + sy * py + sz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y;
          const qy = sz * e1x - sx * e1z;
          const qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (t <= 0 || t >= bestT) continue;
          if (anyHit) return [t, tri, u, v];
          bestT = t;
          bestTri = tri;
          bestU = u;
          bestV = v;
        }
      } else {
        // Internal: near child first along the split axis.
        const axis = -a - 1;
        const right = nodes[node + 7]!;
        const dirNeg = (axis === 0 ? dx : axis === 1 ? dy : dz) < 0;
        const near = dirNeg ? right : node / 8 + 1;
        const far = dirNeg ? node / 8 + 1 : right;
        STACK[sp++] = far;
        STACK[sp++] = near;
      }
    }
    return bestTri >= 0 ? [bestT, bestTri, bestU, bestV] : null;
  }

  area(): number {
    let sum = 0;
    const P = this.positions;
    const I = this.indices;
    for (let t = 0; t < I.length; t += 3) {
      const ia = I[t]! * 3, ib = I[t + 1]! * 3, ic = I[t + 2]! * 3;
      const e1 = new Vec3(P[ib]! - P[ia]!, P[ib + 1]! - P[ia + 1]!, P[ib + 2]! - P[ia + 2]!);
      const e2 = new Vec3(P[ic]! - P[ia]!, P[ic + 1]! - P[ia + 1]!, P[ic + 2]! - P[ia + 2]!);
      sum += e1.cross(e2).length() / 2;
    }
    return sum;
  }

  sampleArea(_u: Sample2D): ShapeSample {
    throw new Error('TriangleMesh: mesh area lights are not supported (lights stay quads)');
  }

  sample(_ref: Vec3, _u: Sample2D): ShapeSample | null {
    throw new Error('TriangleMesh: mesh area lights are not supported (lights stay quads)');
  }

  pdf(_ref: Vec3, _wi: Vec3): number {
    throw new Error('TriangleMesh: mesh area lights are not supported (lights stay quads)');
  }
}

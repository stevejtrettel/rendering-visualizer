import { Vec3 } from '../math/vec3';
import { Ray } from '../math/ray';
import type { Sample2D } from '../math/sampling';
import { areaToSolidAngle } from './measure';
import type { Shape, ShapeIntersection, ShapeSample } from './shape';

// Parallelogram: origin q plus edge vectors e1, e2. Geometric normal is
// normalize(e1 × e2) — construction order fixes the emission side for
// one-sided lights.
export class Quad implements Shape {
  private readonly n: Vec3;
  private readonly quadArea: number;
  // Gram matrix of the edges, for point -> (u, v) coordinates.
  private readonly g11: number;
  private readonly g12: number;
  private readonly g22: number;
  private readonly invDet: number;

  constructor(
    readonly q: Vec3,
    readonly e1: Vec3,
    readonly e2: Vec3,
  ) {
    const cross = e1.cross(e2);
    this.quadArea = cross.length();
    this.n = cross.scale(1 / this.quadArea);
    this.g11 = e1.dot(e1);
    this.g12 = e1.dot(e2);
    this.g22 = e2.dot(e2);
    this.invDet = 1 / (this.g11 * this.g22 - this.g12 * this.g12);
  }

  area(): number {
    return this.quadArea;
  }

  intersect(ray: Ray, tMax: number): ShapeIntersection | null {
    const denom = ray.d.dot(this.n);
    if (denom === 0) return null;
    const t = this.q.sub(ray.o).dot(this.n) / denom;
    if (t <= 0 || t >= tMax) return null;
    const p = ray.at(t);
    const uv = this.uvOf(p);
    if (!uv) return null;
    return { t, p, ng: this.n, ns: this.n, uv };
  }

  intersectP(ray: Ray, tMax: number): boolean {
    return this.intersect(ray, tMax) !== null;
  }

  private uvOf(p: Vec3): Sample2D | null {
    const d = p.sub(this.q);
    const d1 = d.dot(this.e1);
    const d2 = d.dot(this.e2);
    const u = (this.g22 * d1 - this.g12 * d2) * this.invDet;
    if (u < 0 || u > 1) return null;
    const v = (this.g11 * d2 - this.g12 * d1) * this.invDet;
    if (v < 0 || v > 1) return null;
    return [u, v];
  }

  sampleArea(u: Sample2D): ShapeSample {
    return {
      p: this.q.add(this.e1.scale(u[0])).add(this.e2.scale(u[1])),
      ng: this.n,
      pdf: 1 / this.quadArea,
    };
  }

  sample(ref: Vec3, u: Sample2D): ShapeSample | null {
    // V0: area sampling + measure conversion; spherical-rectangle sampling
    // is a later internal upgrade.
    const s = this.sampleArea(u);
    const pdf = areaToSolidAngle(s.pdf, ref, s.p, s.ng);
    if (pdf === 0 || !Number.isFinite(pdf)) return null;
    return { p: s.p, ng: s.ng, pdf };
  }

  pdf(ref: Vec3, wi: Vec3): number {
    const hit = this.intersect(new Ray(ref, wi), Infinity);
    if (!hit) return 0;
    return areaToSolidAngle(1 / this.quadArea, ref, hit.p, hit.ng);
  }
}

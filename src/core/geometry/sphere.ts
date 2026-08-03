import { Vec3 } from '../math/vec3';
import { Ray } from '../math/ray';
import type { Sample2D } from '../math/sampling';
import { uniformSampleSphere } from '../math/sampling';
import { areaToSolidAngle } from './measure';
import type { Shape, ShapeIntersection, ShapeSample } from './shape';

export class Sphere implements Shape {
  constructor(
    readonly center: Vec3,
    readonly radius: number,
  ) {}

  area(): number {
    return 4 * Math.PI * this.radius * this.radius;
  }

  intersect(ray: Ray, tMax: number): ShapeIntersection | null {
    const t = this.hitT(ray, tMax);
    if (t === null) return null;
    // Reproject onto the sphere so the normal and later offsets are exact.
    const raw = ray.at(t);
    const p = this.center.add(raw.sub(this.center).normalize().scale(this.radius));
    const n = p.sub(this.center).scale(1 / this.radius);
    const phi = Math.atan2(n.y, n.x);
    const theta = Math.acos(Math.min(1, Math.max(-1, n.z)));
    const uv: Sample2D = [(phi < 0 ? phi + 2 * Math.PI : phi) / (2 * Math.PI), theta / Math.PI];
    // Partials of p(u, v) = c + r(sin θ cos φ, sin θ sin φ, cos θ) with
    // φ = 2πu, θ = πv; the sphere's normal partials are exact: dn = dp/r.
    const d = p.sub(this.center);
    const zr = Math.sqrt(d.x * d.x + d.y * d.y); // r·sinθ
    const cosPhi = zr > 0 ? d.x / zr : 1;
    const sinPhi = zr > 0 ? d.y / zr : 0;
    const dpdu = new Vec3(-d.y, d.x, 0).scale(2 * Math.PI);
    const dpdv = new Vec3(d.z * cosPhi, d.z * sinPhi, -zr).scale(Math.PI);
    const invR = 1 / this.radius;
    return { t, p, ng: n, ns: n, uv, dpdu, dpdv, dndu: dpdu.scale(invR), dndv: dpdv.scale(invR) };
  }

  intersectP(ray: Ray, tMax: number): boolean {
    return this.hitT(ray, tMax) !== null;
  }

  private hitT(ray: Ray, tMax: number): number | null {
    const oc = ray.o.sub(this.center);
    const b = oc.dot(ray.d); // ray.d is unit length
    const c = oc.lengthSq() - this.radius * this.radius;
    const disc = b * b - c;
    if (disc < 0) return null;
    const sqrtDisc = Math.sqrt(disc);
    const t0 = -b - sqrtDisc;
    if (t0 > 0 && t0 < tMax) return t0;
    const t1 = -b + sqrtDisc;
    if (t1 > 0 && t1 < tMax) return t1;
    return null;
  }

  sampleArea(u: Sample2D): ShapeSample {
    const n = uniformSampleSphere(u);
    return {
      p: this.center.add(n.scale(this.radius)),
      ng: n,
      pdf: 1 / this.area(),
    };
  }

  sample(ref: Vec3, u: Sample2D): ShapeSample | null {
    // V0: area sampling + measure conversion. Cone sampling for exterior
    // references is a strict variance upgrade, internal to this method.
    const s = this.sampleArea(u);
    const pdf = areaToSolidAngle(s.pdf, ref, s.p, s.ng);
    if (pdf === 0 || !Number.isFinite(pdf)) return null;
    return { p: s.p, ng: s.ng, pdf };
  }

  pdf(ref: Vec3, wi: Vec3): number {
    const hit = this.intersect(new Ray(ref, wi), Infinity);
    if (!hit) return 0;
    return areaToSolidAngle(1 / this.area(), ref, hit.p, hit.ng);
  }
}

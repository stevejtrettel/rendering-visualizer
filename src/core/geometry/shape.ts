import type { Vec3 } from '../math/vec3';
import type { Ray } from '../math/ray';
import type { Sample2D } from '../math/sampling';

export interface ShapeIntersection {
  t: number;
  p: Vec3;
  ng: Vec3; // geometric normal — density conversion, ray offsets
  ns: Vec3; // shading normal — BSDF evaluation, geometry terms
  uv: Sample2D;
  // Local differential geometry with respect to the shape's own (u, v)
  // parameterization — position and SHADING-normal partials. The manifold
  // walk's Newton step (core/manifold) consumes these; dndu/dndv carry the
  // curvature that makes caustic focusing computable.
  dpdu: Vec3;
  dpdv: Vec3;
  dndu: Vec3;
  dndv: Vec3;
}

export interface ShapeSample {
  p: Vec3;
  ng: Vec3;
  pdf: number; // measure depends on the sampling method — see Shape
}

export interface Shape {
  area(): number;

  // t is constrained to (0, tMax); origins are pre-offset (see offset.ts),
  // so there is no tMin epsilon here.
  intersect(ray: Ray, tMax: number): ShapeIntersection | null;
  intersectP(ray: Ray, tMax: number): boolean;

  // Uniform by surface area; pdf = 1/area (area measure).
  sampleArea(u: Sample2D): ShapeSample;

  // With respect to solid angle at the reference point; pdf in solid angle.
  // V0 implementations sample by area and convert — upgrading to true
  // solid-angle sampling (sphere cones, spherical rectangles) is internal
  // to the shape; this signature is final.
  sample(ref: Vec3, u: Sample2D): ShapeSample | null;

  // Solid-angle pdf at ref of sampling direction wi via sample(); 0 if wi misses.
  pdf(ref: Vec3, wi: Vec3): number;
}

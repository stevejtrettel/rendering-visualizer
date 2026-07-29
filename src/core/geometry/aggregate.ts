import type { Ray } from '../math/ray';
import type { Shape, ShapeIntersection } from './shape';

// The scene layer extends this with material/light bindings; geometry only
// needs "a thing owning a shape" so intersections can be traced back.
export interface Primitive {
  readonly shape: Shape;
}

export interface Intersection extends ShapeIntersection {
  primitive: Primitive;
}

export interface Aggregate {
  intersect(ray: Ray, tMax?: number): Intersection | null;
  intersectP(ray: Ray, tMax: number): boolean;
}

// Linear scan. A BVH replaces the internals in V1 behind the same interface.
export class LinearAggregate implements Aggregate {
  constructor(private readonly primitives: readonly Primitive[]) {}

  intersect(ray: Ray, tMax = Infinity): Intersection | null {
    let closest: Intersection | null = null;
    let t = tMax;
    for (const primitive of this.primitives) {
      const hit = primitive.shape.intersect(ray, t);
      if (hit) {
        t = hit.t;
        closest = { ...hit, primitive };
      }
    }
    return closest;
  }

  intersectP(ray: Ray, tMax: number): boolean {
    for (const primitive of this.primitives) {
      if (primitive.shape.intersectP(ray, tMax)) return true;
    }
    return false;
  }
}

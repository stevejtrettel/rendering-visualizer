import type { Vec3 } from '../math/vec3';
import { Ray } from '../math/ray';
import type { Aggregate } from './aggregate';
import { offsetRayOrigin, SHADOW_EPSILON } from './offset';

export interface SurfacePoint {
  p: Vec3;
  ng: Vec3;
}

// Mutual visibility between two surface points: both endpoints are offset
// along their geometric normals toward each other, and tMax is clipped short
// of the far endpoint (belt and suspenders against self-shadowing).
export function visible(aggregate: Aggregate, a: SurfacePoint, b: SurfacePoint): boolean {
  let dir = b.p.sub(a.p);
  const dist = dir.length();
  if (dist === 0) return false;
  dir = dir.scale(1 / dist);
  const origin = offsetRayOrigin(a.p, a.ng, dir);
  const target = offsetRayOrigin(b.p, b.ng, dir.neg());
  const segment = target.sub(origin);
  const segmentLength = segment.length();
  if (segmentLength === 0) return true;
  const ray = new Ray(origin, segment.scale(1 / segmentLength));
  return !aggregate.intersectP(ray, segmentLength * (1 - SHADOW_EPSILON));
}

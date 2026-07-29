// The single epsilon policy. float64 gives ~1e-15 relative intersection
// error, so a fixed offset is safe by many orders of magnitude (the float32
// error-bound machinery of pbrt §6.8 is unnecessary here).
import { Vec3 } from '../math/vec3';

export const RAY_EPSILON = 1e-6; // world units
export const SHADOW_EPSILON = 1e-4; // parametric, relative to segment length

// Offset along the GEOMETRIC normal, toward the side the outgoing direction
// w leaves on — the sign flip is what keeps transmission rays from
// self-intersecting.
export function offsetRayOrigin(p: Vec3, ng: Vec3, w: Vec3): Vec3 {
  const s = w.dot(ng) < 0 ? -RAY_EPSILON : RAY_EPSILON;
  return p.add(ng.scale(s));
}

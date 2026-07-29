import type { Vec3 } from '../math/vec3';
import type { Color } from '../math/color';
import type { Ray } from '../math/ray';
import type { Sample2D } from '../math/sampling';

export type LightType = 'area' | 'deltaPosition' | 'deltaDirection' | 'infinite';

export const isDeltaLight = (t: LightType): boolean =>
  t === 'deltaPosition' || t === 'deltaDirection';

// Slim receiver description — all a light needs to importance-sample toward
// a point (ns lets shape samplers do cosine-aware warping later).
export interface LightSampleContext {
  p: Vec3;
  ng: Vec3;
  ns: Vec3;
}

export interface LiSample {
  L: Color; // radiance arriving at the receiver, assuming unoccluded
  wi: Vec3; // unit direction receiver -> light
  pdf: number; // solid angle at the receiver (delta lights: 1)
  pLight: { p: Vec3; ng: Vec3 }; // the integrator traces the shadow ray
}

export interface LeSample {
  L: Color;
  ray: Ray;
  nLight: Vec3;
  pdfPos: number; // area measure
  pdfDir: number; // solid angle — kept separate from pdfPos, always
}

export interface Light {
  readonly type: LightType;

  // Total emitted power — the only hook a power-based light sampler needs.
  phi(): Color;

  // Emitted radiance from a surface point in direction w. The single place
  // one-sidedness is enforced.
  le(p: Vec3, ng: Vec3, uv: Sample2D, w: Vec3): Color;

  sampleLi(ctx: LightSampleContext, u: Sample2D): LiSample | null;
  pdfLi(ctx: LightSampleContext, wi: Vec3): number; // 0 for delta lights

  // BDPT light-subpath emission sampling — declared now, implemented in V2.
  sampleLe(u1: Sample2D, u2: Sample2D): LeSample | null;
  pdfLe(p: Vec3, n: Vec3, w: Vec3): { pdfPos: number; pdfDir: number };
}

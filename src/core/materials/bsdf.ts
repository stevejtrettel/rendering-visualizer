import type { Vec3 } from '../math/vec3';
import type { Color } from '../math/color';
import type { Sample2D } from '../math/sampling';

// What quantity the path carries: camera-started paths transport Radiance,
// light-started paths transport Importance. Refraction and shading normals
// are asymmetric between the two — threaded everywhere from day one.
export enum TransportMode {
  Radiance,
  Importance,
}

// Two orthogonal axes: directional (reflection/transmission) x roughness.
export const REFLECTION = 1 << 0;
export const TRANSMISSION = 1 << 1;
export const DIFFUSE = 1 << 2;
export const GLOSSY = 1 << 3;
export const SPECULAR = 1 << 4;

export type BSDFFlags = number;

export const isSpecular = (flags: BSDFFlags): boolean => (flags & SPECULAR) !== 0;
export const hasNonSpecular = (flags: BSDFFlags): boolean => (flags & (DIFFUSE | GLOSSY)) !== 0;

export interface BSDFSample {
  f: Color;
  wi: Vec3;
  // Solid-angle pdf of the sampled direction. Delta lobes report their
  // DISCRETE lobe probability here (1 for a lone mirror) — while eval() and
  // pdf() return 0 for delta directions. MIS and BDPT depend on this split.
  pdf: number;
  // Flags of the sampled LOBE, not the whole material.
  flags: BSDFFlags;
  // Relative IOR of the sampled event (1 unless transmission) — feeds the
  // Russian-roulette etaScale correction.
  eta: number;
}

// A BxDF works purely in the local shading frame: shading normal = +z,
// cos(theta) = w.z, both wo and wi pointing away from the surface. The frame
// is never flipped toward wo — dielectrics read the sign of wo.z to know
// inside from outside.
export interface BxDF {
  readonly flags: BSDFFlags;
  eval(wo: Vec3, wi: Vec3, mode: TransportMode): Color;
  // uc selects among discrete lobes; u2 selects the direction. Integrators
  // draw both every bounce regardless of material (fixed dimension layout).
  sample(wo: Vec3, uc: number, u2: Sample2D, mode: TransportMode): BSDFSample | null;
  pdf(wo: Vec3, wi: Vec3, mode: TransportMode): number;
}

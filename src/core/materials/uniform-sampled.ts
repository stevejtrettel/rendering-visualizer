// A BxDF that ignores its own shape when choosing directions.
//
// This exists to be WORSE than the renderer, on purpose. A path's
// contribution is f·cos/pdf, and the density of sampled rays is pdf, so
// those are the two factors of one estimator:
//
//   uniform sampling      density flat, all the structure in the weight
//   importance sampling   structure moves into the density, weights flatten
//
// Both are unbiased and estimate the same integral; only the variance
// differs. Wrapping a material in this and drawing the two side by side is
// what makes that visible, because the renderer's own sampling hides it —
// for Lambert with cosine sampling f·cos/pdf is EXACTLY the albedo, the
// same for every path, so the lobe lives entirely in where the rays went.
//
// The walk needs no changes: it multiplies throughput by f·|cos|/pdf from
// whatever the BxDF reports, so a decorator is enough and there is no
// second sampling path to keep in sync.
import { Vec3 } from '../math/vec3';
import type { Color } from '../math/color';
import {
  UNIFORM_HEMISPHERE_PDF,
  uniformSampleHemisphere,
  type Sample2D,
} from '../math/sampling';
import { isSpecular, type BSDFFlags, type BSDFSample, type BxDF, type TransportMode } from './bsdf';

export class UniformSamplingBxDF implements BxDF {
  constructor(private readonly inner: BxDF) {}

  get flags(): BSDFFlags {
    return this.inner.flags;
  }

  eval(wo: Vec3, wi: Vec3, mode: TransportMode): Color {
    return this.inner.eval(wo, wi, mode);
  }

  // A delta lobe has no density to replace — its whole contribution lives
  // at one direction, and "sampling it uniformly" would simply never find
  // it. Specular materials pass through untouched.
  sample(wo: Vec3, uc: number, u2: Sample2D, mode: TransportMode): BSDFSample | null {
    if (isSpecular(this.inner.flags)) return this.inner.sample(wo, uc, u2, mode);
    if (wo.z === 0) return null;

    // Uniform over the hemisphere wo is in. Transmission through the other
    // side is simply not attempted, which is why this wrapper is for the
    // reflective materials the figure uses.
    let wi = uniformSampleHemisphere(u2);
    if (wo.z < 0) wi = new Vec3(wi.x, wi.y, -wi.z);

    const f = this.inner.eval(wo, wi, mode);
    return { f, wi, pdf: UNIFORM_HEMISPHERE_PDF, flags: this.inner.flags, eta: 1 };
  }

  // Must report the density this actually samples from, or every MIS weight
  // built on it would be wrong.
  pdf(wo: Vec3, wi: Vec3, mode: TransportMode): number {
    if (isSpecular(this.inner.flags)) return this.inner.pdf(wo, wi, mode);
    return wo.z * wi.z > 0 ? UNIFORM_HEMISPHERE_PDF : 0;
  }
}

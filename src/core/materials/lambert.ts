import { Vec3 } from '../math/vec3';
import { Color } from '../math/color';
import type { Sample2D } from '../math/sampling';
import { cosineHemispherePdf, cosineSampleHemisphere } from '../math/sampling';
import { BSDFSample, BxDF, DIFFUSE, REFLECTION, TransportMode } from './bsdf';

const sameHemisphere = (a: Vec3, b: Vec3) => a.z * b.z > 0;

export class Lambert implements BxDF {
  readonly flags = DIFFUSE | REFLECTION;
  private readonly fConst: Color;

  constructor(readonly albedo: Color) {
    this.fConst = albedo.scale(1 / Math.PI);
  }

  eval(wo: Vec3, wi: Vec3, _mode: TransportMode): Color {
    return sameHemisphere(wo, wi) ? this.fConst : Color.BLACK;
  }

  sample(wo: Vec3, _uc: number, u2: Sample2D, mode: TransportMode): BSDFSample | null {
    if (wo.z === 0) return null;
    let wi = cosineSampleHemisphere(u2);
    if (wo.z < 0) wi = new Vec3(wi.x, wi.y, -wi.z); // sample wo's hemisphere
    const pdf = cosineHemispherePdf(Math.abs(wi.z));
    if (pdf === 0) return null;
    return { f: this.eval(wo, wi, mode), wi, pdf, flags: this.flags, eta: 1 };
  }

  pdf(wo: Vec3, wi: Vec3, _mode: TransportMode): number {
    return sameHemisphere(wo, wi) ? cosineHemispherePdf(Math.abs(wi.z)) : 0;
  }
}

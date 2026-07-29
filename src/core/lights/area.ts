import type { Vec3 } from '../math/vec3';
import { Color } from '../math/color';
import { OrthonormalBasis } from '../math/onb';
import { Ray } from '../math/ray';
import { cosineHemispherePdf, cosineSampleHemisphere, type Sample2D } from '../math/sampling';
import { offsetRayOrigin } from '../geometry/offset';
import type { Shape } from '../geometry/shape';
import type { LeSample, Light, LightSampleContext, LiSample, LightType } from './light';

export class AreaLight implements Light {
  readonly type: LightType = 'area';

  constructor(
    readonly shape: Shape,
    readonly radiance: Color,
    readonly twoSided = false,
  ) {}

  phi(): Color {
    return this.radiance.scale(Math.PI * (this.twoSided ? 2 : 1) * this.shape.area());
  }

  le(_p: Vec3, ng: Vec3, _uv: Sample2D, w: Vec3): Color {
    if (!this.twoSided && ng.dot(w) < 0) return Color.BLACK;
    return this.radiance;
  }

  sampleLi(ctx: LightSampleContext, u: Sample2D): LiSample | null {
    const s = this.shape.sample(ctx.p, u);
    if (!s) return null;
    const toLight = s.p.sub(ctx.p);
    const dist = toLight.length();
    if (dist === 0) return null;
    const wi = toLight.scale(1 / dist);
    const L = this.le(s.p, s.ng, [0, 0], wi.neg());
    if (L.isBlack()) return null;
    return { L, wi, pdf: s.pdf, pLight: { p: s.p, ng: s.ng } };
  }

  pdfLi(ctx: LightSampleContext, wi: Vec3): number {
    return this.shape.pdf(ctx.p, wi);
  }

  // Position uniform by area, direction cosine-weighted about the light
  // normal. Two-sided emission would need an extra hemisphere-choice
  // dimension the fixed layout does not draw — no two-sided lights exist in
  // our scenes, so fail loudly rather than emit from one side silently.
  sampleLe(u1: Sample2D, u2: Sample2D): LeSample | null {
    if (this.twoSided) {
      throw new Error('AreaLight.sampleLe: two-sided emission needs a hemisphere-choice dimension');
    }
    const s = this.shape.sampleArea(u1);
    const local = cosineSampleHemisphere(u2);
    const pdfDir = cosineHemispherePdf(local.z);
    if (pdfDir === 0) return null;
    const w = OrthonormalBasis.fromZ(s.ng).toWorld(local);
    const L = this.le(s.p, s.ng, [0, 0], w);
    if (L.isBlack()) return null;
    return {
      L,
      ray: new Ray(offsetRayOrigin(s.p, s.ng, w), w),
      nLight: s.ng,
      pdfPos: s.pdf,
      pdfDir,
    };
  }

  pdfLe(_p: Vec3, n: Vec3, w: Vec3): { pdfPos: number; pdfDir: number } {
    if (this.twoSided) {
      throw new Error('AreaLight.pdfLe: two-sided emission needs a hemisphere-choice dimension');
    }
    return { pdfPos: 1 / this.shape.area(), pdfDir: cosineHemispherePdf(n.dot(w)) };
  }
}

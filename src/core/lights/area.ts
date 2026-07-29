import type { Vec3 } from '../math/vec3';
import { Color } from '../math/color';
import type { Sample2D } from '../math/sampling';
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

  sampleLe(_u1: Sample2D, _u2: Sample2D): LeSample | null {
    throw new Error('AreaLight.sampleLe: implemented in V2 (BDPT light subpaths)');
  }

  pdfLe(_p: Vec3, _n: Vec3, _w: Vec3): { pdfPos: number; pdfDir: number } {
    throw new Error('AreaLight.pdfLe: implemented in V2 (BDPT light subpaths)');
  }
}

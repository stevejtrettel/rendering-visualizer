import type { Vec3 } from '../math/vec3';
import { Color } from '../math/color';
import { OrthonormalBasis } from '../math/onb';
import type { Sample2D } from '../math/sampling';
import type { BSDFFlags, BSDFSample, BxDF, TransportMode } from './bsdf';

// Render-space wrapper: owns the shading frame, transforms directions
// local <-> world around the pure local-frame BxDF. Integrators never see
// local coordinates.
export class SurfaceBSDF {
  private readonly frame: OrthonormalBasis;

  constructor(
    private readonly bxdf: BxDF,
    readonly ns: Vec3,
    readonly ng: Vec3,
  ) {
    this.frame = OrthonormalBasis.fromZ(ns);
  }

  get flags(): BSDFFlags {
    return this.bxdf.flags;
  }

  eval(woWorld: Vec3, wiWorld: Vec3, mode: TransportMode): Color {
    const wo = this.frame.toLocal(woWorld);
    if (wo.z === 0) return Color.BLACK;
    return this.bxdf.eval(wo, this.frame.toLocal(wiWorld), mode);
  }

  sample(woWorld: Vec3, uc: number, u2: Sample2D, mode: TransportMode): BSDFSample | null {
    const wo = this.frame.toLocal(woWorld);
    if (wo.z === 0) return null;
    const s = this.bxdf.sample(wo, uc, u2, mode);
    if (!s || s.f.isBlack() || s.pdf === 0) return null;
    return { ...s, wi: this.frame.toWorld(s.wi) };
  }

  pdf(woWorld: Vec3, wiWorld: Vec3, mode: TransportMode): number {
    const wo = this.frame.toLocal(woWorld);
    if (wo.z === 0) return 0;
    return this.bxdf.pdf(wo, this.frame.toLocal(wiWorld), mode);
  }
}

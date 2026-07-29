// Smooth dielectric (clear glass): two delta lobes, reflect and refract,
// selected by uc with probability = exact Fresnel reflectance. Per the
// delta contract: sample() reports the DISCRETE lobe probability as pdf;
// eval() and pdf() return 0. The eta^2 radiance-compression correction
// lives here, in the transmission branch, Radiance mode only — and the
// directed eta is returned so the walk's Russian-roulette etaScale works.
import { Vec3 } from '../math/vec3';
import { Color } from '../math/color';
import type { Sample2D } from '../math/sampling';
import { BSDFSample, BxDF, REFLECTION, SPECULAR, TRANSMISSION, TransportMode } from './bsdf';
import { frDielectric, refractLocal } from './fresnel';

export class Dielectric implements BxDF {
  readonly flags = SPECULAR | REFLECTION | TRANSMISSION;

  // ior: interior over exterior (glass in air ~ 1.5).
  constructor(readonly ior: number) {}

  eval(_wo: Vec3, _wi: Vec3, _mode: TransportMode): Color {
    return Color.BLACK; // delta lobes: no other strategy can find them
  }

  pdf(_wo: Vec3, _wi: Vec3, _mode: TransportMode): number {
    return 0;
  }

  sample(wo: Vec3, uc: number, _u2: Sample2D, mode: TransportMode): BSDFSample | null {
    if (wo.z === 0) return null;
    const R = frDielectric(wo.z, this.ior);
    if (uc < R) {
      const wi = new Vec3(-wo.x, -wo.y, wo.z);
      return {
        f: new Color(R, R, R).scale(1 / Math.abs(wi.z)),
        wi,
        pdf: R,
        flags: SPECULAR | REFLECTION,
        eta: 1,
      };
    }
    const refr = refractLocal(wo, this.ior);
    if (!refr) return null; // unreachable: TIR implies R = 1
    const T = 1 - R;
    let ft = T;
    // Radiance compresses crossing into the denser medium: the BTDF is
    // non-symmetric, and importance transport (the adjoint) omits this.
    if (mode === TransportMode.Radiance) ft /= refr.etap * refr.etap;
    return {
      f: new Color(ft, ft, ft).scale(1 / Math.abs(refr.wi.z)),
      wi: refr.wi,
      pdf: T,
      flags: SPECULAR | TRANSMISSION,
      eta: refr.etap,
    };
  }
}

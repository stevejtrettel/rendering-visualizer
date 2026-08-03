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

  // SMS (V5): relative IOR of the manifold walk's prescribed event — the
  // eta convention of core/manifold (≠ 1 means the REFRACTION branch).
  get manifoldEta(): number {
    return this.ior;
  }

  // SMS (V5): throughput of radiance crossing this delta interface along a
  // SOLVED transmission pair — the deterministic-direction counterpart of
  // sample()'s transmission branch, with identical Fresnel and η²
  // conventions (cosReceiver = local cosine of the direction toward the
  // receiver, signed against the shading normal). The delta eval() ≡ black
  // contract stays untouched; MIS elsewhere depends on it.
  specularChainThroughput(cosReceiver: number, mode: TransportMode): Color {
    const F = frDielectric(cosReceiver, this.ior);
    let t = 1 - F;
    if (mode === TransportMode.Radiance) {
      const etap = cosReceiver > 0 ? this.ior : 1 / this.ior;
      t /= etap * etap;
    }
    return new Color(t, t, t);
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

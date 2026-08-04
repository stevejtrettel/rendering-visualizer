// Point light (V5c experiment, 2026-08-03): the delta emitter that makes
// the SMS support argument CATEGORICAL. With a point light behind glass,
// S(D)S transport has measure-zero probability under every local sampling
// strategy — PT can never hit the emitter, NEE's shadow rays refract
// away, BDPT's connections die on the delta chain (Veach's unsampleable
// obstruction). The manifold solver is the only unbiased route, so the
// caustic exists in the pt-sms pane and is BLACK everywhere else.
//
// V2's "no delta lights" lock was LIFTED by V5c and this comment used to
// say otherwise (that sampleLe returned null) long after it stopped being
// true. It does not: sampleLe below emits from the point with pdfPos = 1,
// bdpt.ts handles the discrete origin through lightIsDelta, and
// tests/delta-light-mis.test.ts measures BDPT and MMLT agreeing with NEE
// on a point-lit box. Plain PT still renders black, correctly — a delta
// light cannot be hit. ReSTIR is the one integrator that does not support
// these (see that test, and docs/design-cleanup.md §7).
import { Vec3 } from '../math/vec3';
import { Color } from '../math/color';
import { Ray } from '../math/ray';
import { uniformSampleSphere, UNIFORM_SPHERE_PDF, type Sample2D } from '../math/sampling';
import type { LeSample, Light, LightSampleContext, LiSample, LightType } from './light';

export class PointLight implements Light {
  readonly type: LightType = 'deltaPosition';

  // intensity: radiant intensity I (power per solid angle), isotropic.
  constructor(
    readonly position: Vec3,
    readonly intensity: Color,
  ) {}

  phi(): Color {
    return this.intensity.scale(4 * Math.PI);
  }

  le(): Color {
    return Color.BLACK; // a delta light is never hit by a ray
  }

  // Delta sampling: pdf = 1 (discrete), L carries the 1/r² falloff so the
  // standard NEE estimator f·L·cos/pdf is correct as-is. MIS weight must
  // be 1 (no other strategy can produce this direction) — integrators
  // check light.type.
  sampleLi(ctx: LightSampleContext, _u: Sample2D): LiSample | null {
    const toLight = this.position.sub(ctx.p);
    const distSq = toLight.lengthSq();
    if (distSq === 0) return null;
    const dist = Math.sqrt(distSq);
    const wi = toLight.scale(1 / dist);
    return {
      L: this.intensity.scale(1 / distSq),
      wi,
      pdf: 1,
      pLight: { p: this.position, ng: wi.neg() },
    };
  }

  pdfLi(): number {
    return 0; // BSDF sampling can never hit a delta light
  }

  // Bidirectional support (V5c unlock of the V2 delta lock): position is
  // a discrete event (pdfPos = 1, paired with the selection pmf in the
  // MIS ratios — consistent across all strategies of a path since they
  // share the same light origin), direction uniform over the sphere.
  // nLight = the emitted direction, making the walk's |n·d| factor 1 —
  // a delta light has no surface cosine.
  sampleLe(_u1: Sample2D, u2: Sample2D): LeSample | null {
    const d = uniformSampleSphere(u2);
    return {
      L: this.intensity,
      ray: new Ray(this.position, d),
      nLight: d,
      pdfPos: 1,
      pdfDir: UNIFORM_SPHERE_PDF,
    };
  }

  pdfLe(): { pdfPos: number; pdfDir: number } {
    return { pdfPos: 1, pdfDir: UNIFORM_SPHERE_PDF };
  }
}

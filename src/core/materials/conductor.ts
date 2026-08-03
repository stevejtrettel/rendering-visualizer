// Conductors: the perfect mirror (delta) and the GGX rough conductor
// (Trowbridge–Reitz with visible-normal sampling, height-correlated Smith
// shadowing). Isotropic; exposed roughness maps to alpha = roughness^2
// (the perceptual convention, agreed). Single-scattering only — energy is
// lost at high roughness; the furnace test bounds rather than pins it.
import { Vec3 } from '../math/vec3';
import { Color } from '../math/color';
import type { Sample2D } from '../math/sampling';
import { BSDFSample, BxDF, GLOSSY, REFLECTION, SPECULAR, TransportMode } from './bsdf';
import { schlick } from './fresnel';

const sameHemisphere = (a: Vec3, b: Vec3) => a.z * b.z > 0;

export class SmoothConductor implements BxDF {
  readonly flags = SPECULAR | REFLECTION;

  // SMS (V5): eta = 1 is the manifold walk's REFLECTION branch.
  readonly manifoldEta = 1;

  constructor(readonly f0: Color) {}

  // SMS (V5): Fresnel along a SOLVED reflection pair — the deterministic
  // counterpart of sample(), same schlick convention.
  specularChainThroughput(cosReceiver: number, _mode: TransportMode): Color {
    return schlick(this.f0, Math.abs(cosReceiver));
  }

  eval(_wo: Vec3, _wi: Vec3, _mode: TransportMode): Color {
    return Color.BLACK;
  }

  pdf(_wo: Vec3, _wi: Vec3, _mode: TransportMode): number {
    return 0;
  }

  sample(wo: Vec3, _uc: number, _u2: Sample2D, _mode: TransportMode): BSDFSample | null {
    if (wo.z === 0) return null;
    const wi = new Vec3(-wo.x, -wo.y, wo.z);
    return {
      f: schlick(this.f0, Math.abs(wo.z)).scale(1 / Math.abs(wi.z)),
      wi,
      pdf: 1,
      flags: this.flags,
      eta: 1,
    };
  }
}

export class GGXConductor implements BxDF {
  readonly flags = GLOSSY | REFLECTION;
  private readonly alpha: number;

  constructor(
    readonly f0: Color,
    roughness: number,
  ) {
    this.alpha = Math.max(1e-3, roughness * roughness);
  }

  private distribution(wh: Vec3): number {
    const a2 = this.alpha * this.alpha;
    const d = wh.z * wh.z * (a2 - 1) + 1;
    return a2 / (Math.PI * d * d);
  }

  private lambda(w: Vec3): number {
    const cos2 = w.z * w.z;
    if (cos2 >= 1) return 0;
    if (cos2 === 0) return Infinity;
    const tan2 = (1 - cos2) / cos2;
    return (Math.sqrt(1 + this.alpha * this.alpha * tan2) - 1) / 2;
  }

  eval(wo: Vec3, wi: Vec3, _mode: TransportMode): Color {
    if (!sameHemisphere(wo, wi)) return Color.BLACK;
    const cosO = Math.abs(wo.z);
    const cosI = Math.abs(wi.z);
    if (cosO === 0 || cosI === 0) return Color.BLACK;
    let wh = wo.add(wi);
    if (wh.lengthSq() === 0) return Color.BLACK;
    wh = wh.normalize();
    if (wh.z < 0) wh = wh.neg(); // canonical +z half-vector
    const F = schlick(this.f0, Math.abs(wo.dot(wh)));
    const G = 1 / (1 + this.lambda(wo) + this.lambda(wi)); // height-correlated Smith
    return F.scale((this.distribution(wh) * G) / (4 * cosO * cosI));
  }

  pdf(wo: Vec3, wi: Vec3, _mode: TransportMode): number {
    if (!sameHemisphere(wo, wi)) return 0;
    if (wo.z === 0) return 0;
    let wh = wo.add(wi);
    if (wh.lengthSq() === 0) return 0;
    wh = wh.normalize();
    if (wh.z < 0) wh = wh.neg();
    const g1 = 1 / (1 + this.lambda(wo));
    // VNDF pdf over wh, divided by the reflection Jacobian 4|wo·wh|.
    return (g1 * this.distribution(wh)) / (4 * Math.abs(wo.z));
  }

  sample(wo: Vec3, _uc: number, u2: Sample2D, mode: TransportMode): BSDFSample | null {
    if (wo.z === 0) return null;
    const flip = wo.z < 0;
    const woUp = flip ? new Vec3(wo.x, wo.y, -wo.z) : wo;
    const wh = this.sampleVNDF(woUp, u2);
    const wiUp = wh.scale(2 * woUp.dot(wh)).sub(woUp);
    if (wiUp.z <= 0) return null; // sampled below the surface
    const wi = flip ? new Vec3(wiUp.x, wiUp.y, -wiUp.z) : wiUp;
    const pdf = this.pdf(wo, wi, mode);
    if (pdf === 0) return null;
    const f = this.eval(wo, wi, mode);
    if (f.isBlack()) return null;
    return { f, wi, pdf, flags: this.flags, eta: 1 };
  }

  // Heitz 2018: sampling the visible normal distribution for wo.z > 0.
  private sampleVNDF(wo: Vec3, u: Sample2D): Vec3 {
    const a = this.alpha;
    const vh = new Vec3(a * wo.x, a * wo.y, wo.z).normalize();
    const lenSq = vh.x * vh.x + vh.y * vh.y;
    const t1 = lenSq > 0 ? new Vec3(-vh.y, vh.x, 0).scale(1 / Math.sqrt(lenSq)) : new Vec3(1, 0, 0);
    const t2 = vh.cross(t1);
    const r = Math.sqrt(u[0]);
    const phi = 2 * Math.PI * u[1];
    const p1 = r * Math.cos(phi);
    let p2 = r * Math.sin(phi);
    const s = 0.5 * (1 + vh.z);
    p2 = (1 - s) * Math.sqrt(Math.max(0, 1 - p1 * p1)) + s * p2;
    const p3 = Math.sqrt(Math.max(0, 1 - p1 * p1 - p2 * p2));
    const nh = t1.scale(p1).add(t2.scale(p2)).add(vh.scale(p3));
    return new Vec3(a * nh.x, a * nh.y, Math.max(1e-6, nh.z)).normalize();
  }
}

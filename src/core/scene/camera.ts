import { Vec3 } from '../math/vec3';
import { Ray } from '../math/ray';
import type { Sample2D } from '../math/sampling';

// Importance carried from a surface point to the camera (BDPT t=1). wi points
// from the surface point toward the pinhole; pdf = 1 by the delta convention
// (a pinhole is a delta position, like sampleLi on a delta light). We is the
// surface-measure importance factor — see sampleWi for exactly which factors
// it includes.
export interface CameraWiSample {
  wi: Vec3;
  dist: number;
  pdf: number;
  We: number;
  raster: Sample2D;
}

export interface PinholeCameraOptions {
  eye: Vec3;
  lookAt: Vec3;
  up: Vec3;
  fovDegrees: number; // vertical field of view
  width: number; // film resolution in pixels
  height: number;
}

export class PinholeCamera {
  readonly eye: Vec3;
  readonly width: number;
  readonly height: number;
  private readonly forward: Vec3;
  private readonly right: Vec3;
  private readonly upV: Vec3;
  private readonly tanHalf: number;
  private readonly aspect: number;
  private readonly filmArea: number; // of the virtual film plane at unit distance

  constructor(opts: PinholeCameraOptions) {
    this.eye = opts.eye;
    this.width = opts.width;
    this.height = opts.height;
    this.forward = opts.lookAt.sub(opts.eye).normalize();
    this.right = this.forward.cross(opts.up).normalize();
    this.upV = this.right.cross(this.forward);
    this.tanHalf = Math.tan((opts.fovDegrees * Math.PI) / 360);
    this.aspect = opts.width / opts.height;
    this.filmArea = 4 * this.tanHalf * this.tanHalf * this.aspect;
  }

  // raster is a continuous film position in [0,width) x [0,height);
  // pixel (i, j) spans raster [i, i+1) x [j, j+1). y grows downward.
  generateRay(raster: Sample2D): Ray {
    const px = (2 * (raster[0] / this.width) - 1) * this.tanHalf * this.aspect;
    const py = (1 - 2 * (raster[1] / this.height)) * this.tanHalf;
    const d = this.forward.add(this.right.scale(px)).add(this.upV.scale(py)).normalize();
    return new Ray(this.eye, d);
  }

  // Importance emission pdfs for a camera ray. Position is a delta (pinhole):
  // pdfPos = 1 by the delta convention. Directions are distributed by uniform
  // film-area sampling: pdfDir = 1 / (A * cos^3(theta)).
  pdfWe(ray: Ray): { pdfPos: number; pdfDir: number } {
    const cos = ray.d.dot(this.forward);
    if (cos <= 0) return { pdfPos: 1, pdfDir: 0 };
    return { pdfPos: 1, pdfDir: 1 / (this.filmArea * cos * cos * cos) };
  }

  // Raster position of the film point a (unit) direction d looks through, or
  // null if d points behind the camera or outside the film. Inverse of
  // generateRay's raster -> direction map.
  private rasterOf(d: Vec3): Sample2D | null {
    const cos = d.dot(this.forward);
    if (cos <= 0) return null;
    const px = d.dot(this.right) / cos;
    const py = d.dot(this.upV) / cos;
    const rx = ((px / (this.tanHalf * this.aspect) + 1) / 2) * this.width;
    const ry = ((1 - py / this.tanHalf) / 2) * this.height;
    if (rx < 0 || rx >= this.width || ry < 0 || ry >= this.height) return null;
    return [rx, ry];
  }

  // Emitted importance for a camera ray, per (delta lens area x solid angle):
  // We(w) = 1 / (A cos^4 theta), with A the film area at unit distance.
  //
  // Derivation. The importance measurement is
  //   I_j = integral over pixel j's directions of We(w) L(w) cos(theta) dw,
  // with cos(theta) the lens cosine of the measure (importance analogue of
  // the cos in emitted-power integrals). A film point at angle theta sits at
  // distance 1/cos(theta) on the unit-distance plane, so dw = cos^3 dA_film,
  // giving I_j = integral of We L cos^4 dA_film = A_pixel/A * (mean L over
  // the pixel) with We as above. The camera-side pixel value is the mean L
  // itself; the missing numPixels = A/A_pixel is supplied by the path-count
  // convention (numPixels * spp light paths, splats developed at 1/spp), so
  // the two sides agree. pdfWe.pdfDir = 1/(A cos^3 theta) is the same chain
  // without the lens cosine: pdfDir = We * cos(theta).
  we(ray: Ray): { We: number; raster: Sample2D } | null {
    const raster = this.rasterOf(ray.d);
    if (!raster) return null;
    const cos = ray.d.dot(this.forward);
    const cos2 = cos * cos;
    return { We: 1 / (this.filmArea * cos2 * cos2), raster };
  }

  // BDPT t=1: connect a surface point to the pinhole. Deterministic — wi is
  // the direction from ref to eye, pdf = 1 by the delta convention.
  //
  // We here is the full surface-measure coupling EXCEPT the cosine at the
  // receiving surface (sampleWi has no normal; the caller multiplies
  // |wi . ns|):
  //   We_surf = We(w) * cos(theta) / d^2 = 1 / (A cos^3(theta) d^2),
  // i.e. directional importance x lens cosine x the solid-angle-to-area
  // Jacobian's 1/d^2. This is SmallVCM's imageToSurfaceFactor with its
  // image measured in film area instead of pixels (their imagePlaneDist^2
  // in pixel units equals numPixels/A) and the surface cosine left to the
  // caller. Contribution: beta * f * We_surf * |wi . ns|, splat at raster.
  sampleWi(ref: Vec3): CameraWiSample | null {
    const toEye = this.eye.sub(ref);
    const dist = toEye.length();
    if (dist === 0) return null;
    const wi = toEye.scale(1 / dist);
    const w = this.we(new Ray(this.eye, wi.neg()));
    if (!w) return null;
    const cos = wi.neg().dot(this.forward);
    return { wi, dist, pdf: 1, We: (w.We * cos) / (dist * dist), raster: w.raster };
  }
}

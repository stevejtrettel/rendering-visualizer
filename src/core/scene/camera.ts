import { Vec3 } from '../math/vec3';
import { Ray } from '../math/ray';
import type { Sample2D } from '../math/sampling';

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

  // BDPT camera-importance sampling — declared now, implemented in V2.
  sampleWi(_ref: Vec3, _u: Sample2D): never {
    throw new Error('PinholeCamera.sampleWi: implemented in V2 (BDPT t=1 strategy)');
  }
}

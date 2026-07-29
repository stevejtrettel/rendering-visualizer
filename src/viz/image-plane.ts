// The floating image plane: a low-res image forming INSIDE the scene as
// samples accumulate. Placed geometrically on the camera frustum, so the
// ray for cell (i, j) literally passes through cell (i, j) of the plane.
// Like every timeline element, its appearance is a pure function of t:
// at time t it shows each cell's running mean over samples 0..floor(t/dwell).
import * as THREE from 'three';
import type { Vec3Tuple } from '../core/scene/scene';
import { srgbEncode } from '../render/film';
import type { TimelineElement } from './timeline';

// Per-sample cell values, converted in place to cumulative sums over the
// sample axis. Layout: value[(s * res * res + y * res + x) * 3 + channel].
export function toCumulative(values: Float32Array, res: number, samples: number): void {
  const stride = res * res * 3;
  for (let s = 1; s < samples; s++) {
    const base = s * stride;
    const prev = base - stride;
    for (let i = 0; i < stride; i++) {
      values[base + i]! += values[prev + i]!;
    }
  }
}

// Running mean of a cell after samples 0..s (inclusive), from cumulative data.
export function meanAt(
  cumulative: Float32Array, res: number, s: number, x: number, y: number,
): [number, number, number] {
  const i = (s * res * res + y * res + x) * 3;
  const inv = 1 / (s + 1);
  return [cumulative[i]! * inv, cumulative[i + 1]! * inv, cumulative[i + 2]! * inv];
}

export interface ImagePlaneConfig {
  camera: { eye: Vec3Tuple; lookAt: Vec3Tuple; up: Vec3Tuple; fovDegrees: number };
  distance: number; // pinhole -> plane, world units
  res: number;
  samples: number;
  dwell: number;
  cumulative: Float32Array; // from toCumulative
  highlight: readonly [number, number] | null; // outlined cell
  exposure?: number;
}

export class ImagePlaneElement implements TimelineElement {
  private readonly group = new THREE.Group();
  private readonly texture: THREE.DataTexture;
  private readonly rgba: Uint8Array;
  private lastSample = -2;

  constructor(
    private readonly cfg: ImagePlaneConfig,
    private readonly parent: THREE.Object3D,
  ) {
    const { res } = cfg;
    this.rgba = new Uint8Array(res * res * 4);
    this.texture = new THREE.DataTexture(this.rgba, res, res, THREE.RGBAFormat);
    this.texture.magFilter = THREE.NearestFilter; // crisp cells
    this.texture.minFilter = THREE.NearestFilter;

    // Camera basis (same math as the core pinhole camera).
    const eye = new THREE.Vector3(...cfg.camera.eye);
    const forward = new THREE.Vector3(...cfg.camera.lookAt).sub(eye).normalize();
    const right = forward.clone().cross(new THREE.Vector3(...cfg.camera.up)).normalize();
    const up = right.clone().cross(forward);
    const tanHalf = Math.tan((cfg.camera.fovDegrees * Math.PI) / 360);
    const halfH = cfg.distance * tanHalf;
    const halfW = halfH; // square film, like the CPU camera in these demos

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * halfW, 2 * halfH),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        opacity: 0.94,
        side: THREE.DoubleSide,
        depthWrite: false, // paths stay visible passing through
        toneMapped: false,
      }),
    );
    const center = eye.clone().addScaledVector(forward, cfg.distance);
    plane.position.copy(center);
    plane.matrixAutoUpdate = true;
    plane.up.copy(up);
    plane.lookAt(eye); // plane normal faces the pinhole
    this.group.add(plane);

    if (cfg.highlight) {
      // Outline the highlighted cell, slightly proud of the plane.
      const [hx, hy] = cfg.highlight;
      const cell = (2 * halfW) / res;
      const x0 = -halfW + hx * cell;
      const y0 = halfH - (hy + 1) * cell; // raster y grows downward
      const pts = [
        [x0, y0], [x0 + cell, y0], [x0 + cell, y0 + cell], [x0, y0 + cell], [x0, y0],
      ].map(([px, py]) =>
        center.clone().addScaledVector(right, px!).addScaledVector(up, py!)
          .addScaledVector(forward, -0.01),
      );
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      this.group.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffaa33 })));
    }

    parent.add(this.group);
  }

  drawAt(t: number): void {
    const s = Math.min(this.cfg.samples - 1, Math.max(0, Math.floor(t / this.cfg.dwell)));
    if (s === this.lastSample) return;
    this.lastSample = s;
    const { res, cumulative, exposure = 1 } = this.cfg;
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const [r, g, b] = meanAt(cumulative, res, s, x, y);
        // Texture row 0 is the BOTTOM of the plane; raster y grows downward.
        const o = ((res - 1 - y) * res + x) * 4;
        this.rgba[o] = srgbEncode(r * exposure);
        this.rgba[o + 1] = srgbEncode(g * exposure);
        this.rgba[o + 2] = srgbEncode(b * exposure);
        this.rgba[o + 3] = 255;
      }
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.parent.remove(this.group);
    this.texture.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}

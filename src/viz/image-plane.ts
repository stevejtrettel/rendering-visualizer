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
  /**
   * Optional per-cell reveal times, indexed y * res + x: a cell stays blank
   * until t reaches its time, then shows its value. For figures where each
   * pixel appears the moment its own ray lands, rather than a whole sample
   * at once. Used with a single sample.
   */
  revealAt?: Float32Array;
}

/** What an unrevealed cell shows: blank film, dark but not invisible. */
const BLANK = 18;

/**
 * Where the image plane sits on the camera frustum, and the basis it is
 * laid out in. Shared so anything drawn RELATIVE to the plane — a tile
 * dropping onto it, an annotation beside it — agrees with it exactly
 * instead of recomputing the same camera basis and drifting.
 */
export interface PlaneFrame {
  center: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  forward: THREE.Vector3;
  eye: THREE.Vector3;
  halfW: number;
  halfH: number;
}

export function imagePlaneFrame(
  camera: ImagePlaneConfig['camera'],
  distance: number,
): PlaneFrame {
  const eye = new THREE.Vector3(...camera.eye);
  const forward = new THREE.Vector3(...camera.lookAt).sub(eye).normalize();
  const right = forward.clone().cross(new THREE.Vector3(...camera.up)).normalize();
  const up = right.clone().cross(forward);
  const halfH = distance * Math.tan((camera.fovDegrees * Math.PI) / 360);
  return {
    center: eye.clone().addScaledVector(forward, distance),
    right,
    up,
    forward,
    eye,
    halfH,
    halfW: halfH, // square film, like the CPU camera in these demos
  };
}

/** Fill an RGBA buffer from one sample's raw values (not a running mean). */
export function fillSampleRgba(
  out: Uint8ClampedArray,
  values: Float32Array,
  res: number,
  sample: number,
  exposure = 1,
): void {
  const base = sample * res * res * 3;
  for (let i = 0; i < res * res; i++) {
    const o = i * 4;
    out[o] = srgbEncode(values[base + i * 3]! * exposure);
    out[o + 1] = srgbEncode(values[base + i * 3 + 1]! * exposure);
    out[o + 2] = srgbEncode(values[base + i * 3 + 2]! * exposure);
    out[o + 3] = 255;
  }
}

export class ImagePlaneElement implements TimelineElement {
  // Public so a figure can hide the plane outright — before the first
  // sample has landed there is no running mean to show.
  readonly group = new THREE.Group();
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

    const { eye, right, up, forward, center, halfW, halfH } = imagePlaneFrame(
      cfg.camera,
      cfg.distance,
    );

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
    const { res, cumulative, exposure = 1, revealAt } = this.cfg;
    // With reveal times, what changes is how many cells are showing.
    let key = s;
    if (revealAt) {
      key = 0;
      for (let i = 0; i < revealAt.length; i++) if (t >= revealAt[i]!) key++;
    }
    if (key === this.lastSample) return;
    this.lastSample = key;
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        // Texture row 0 is the BOTTOM of the plane; raster y grows downward.
        const o = ((res - 1 - y) * res + x) * 4;
        if (revealAt && t < revealAt[y * res + x]!) {
          this.rgba[o] = this.rgba[o + 1] = this.rgba[o + 2] = BLANK;
          this.rgba[o + 3] = 255;
          continue;
        }
        const [r, g, b] = meanAt(cumulative, res, s, x, y);
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

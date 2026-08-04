// The sample that is being traced, shown on its own above the accumulating
// image, then dropped into it.
//
// The point it makes: a single sample IS an unbiased estimate of the whole
// picture — usually a terrible one, mostly black under plain path tracing,
// occasionally blindingly bright. Watching one land on the mean and barely
// move it, then another, is what "averaging" actually looks like, and it is
// invisible if the image simply gets less noisy on its own.
//
// Lives in HUD coordinates beside the running image, not in the scene: it
// is a statement about the estimator, not about the geometry, and it has to
// stay square-on and legible whatever the camera is doing.
import * as THREE from 'three';
import { createFilmTexture, type FilmTexture } from './film-panel';
import { fillSampleRgba } from './image-plane';
import type { TimelineElement } from './timeline';

export interface SampleDropConfig {
  res: number;
  samples: number;
  /** Seconds per sample — the same clock the rays run on. */
  dwell: number;
  /** Raw per-sample values (PixelGridTrace.perSample), NOT accumulated. */
  perSample: Float32Array;
  /** Centre of the image it falls INTO, in HUD units. */
  target: [number, number];
  /** Drawn height, matching the panel it falls into. */
  drawnHeight: number;
  /** How far above the target it hovers before dropping, in HUD units. */
  riseHeight: number;
  // The beats, as fractions of the sample period: the tile fades in while
  // the rays are still flying, hangs, then falls in and merges.
  fadeInEnd: number;
  dropStart: number;
  dropLand: number;
  exposure?: number;
}

export class SampleDropElement implements TimelineElement {
  readonly group = new THREE.Group();
  private readonly film: FilmTexture;
  private readonly rgba: Uint8ClampedArray;
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private lastSample = -1;

  constructor(
    private readonly cfg: SampleDropConfig,
    private readonly parent: THREE.Object3D,
  ) {
    const { res, drawnHeight } = cfg;
    this.rgba = new Uint8ClampedArray(res * res * 4);
    this.film = createFilmTexture(res, res);

    this.material = new THREE.MeshBasicMaterial({
      map: this.film.texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(drawnHeight, drawnHeight), this.material);
    this.group.add(this.mesh);
    parent.add(this.group);
  }

  drawAt(t: number): void {
    const { res, samples, dwell, perSample, target, riseHeight, fadeInEnd, dropStart, dropLand, exposure = 1 } =
      this.cfg;
    const s = Math.min(samples - 1, Math.max(0, Math.floor(t / dwell)));
    const u = (t - s * dwell) / dwell;

    if (s !== this.lastSample) {
      this.lastSample = s;
      fillSampleRgba(this.rgba, perSample, res, s, exposure);
      this.film.upload(this.rgba);
    }

    if (u > dropLand) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;

    if (u < dropStart) {
      // Fading into existence while the rays are still out gathering it.
      this.mesh.position.set(target[0], target[1] + riseHeight, 0.01);
      this.material.opacity = Math.min(1, u / Math.max(1e-6, fadeInEnd));
      return;
    }

    // Falling. Eased in, so it accelerates downward and reads as a drop
    // rather than a slide, and dissolves as it meets the image.
    const p = (u - dropStart) / Math.max(1e-6, dropLand - dropStart);
    const eased = p * p;
    this.mesh.position.set(target[0], target[1] + riseHeight * (1 - eased), 0.01);
    this.material.opacity = p < 0.7 ? 1 : Math.max(0, 1 - (p - 0.7) / 0.3);
  }

  dispose(): void {
    this.parent.remove(this.group);
    this.film.texture.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

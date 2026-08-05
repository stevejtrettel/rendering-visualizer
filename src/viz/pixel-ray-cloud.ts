// Every ray of every sample, all at once, standing still.
//
// The sibling of PixelRays, and the opposite thing: PixelRays shows ONE
// sample growing at time t and rewrites its whole buffer every frame, which
// is what an animation of an image forming needs. A still of the finished
// computation needs every sample simultaneously and needs it never to
// change — so the geometry is built once in the constructor and the frame
// loop never touches it. At 32x32 x 32 samples that is ~190k segments in
// one draw call, and drawing it costs the same whether the camera is
// orbiting or parked.
//
// Colour is the same language as everywhere else: ochre by throughput,
// unlit paths dimmed rather than dropped — most paths reporting nothing is
// the fact this figure is FOR, and deleting them would hide it.
import * as THREE from 'three';
import type { Tuple3 } from '../trace/records';
import type { TracedPath } from '../trace/pixel-grid';
import { segmentColor, type PathPalette } from './path-elements';

/**
 * How overlapping rays combine.
 *
 * 'normal' keeps each ray's hue where they cross, so a dense region reads
 * as a mass of ochre lines. 'additive' lets crossings accumulate toward
 * white, so the region the paths actually concentrate in glows — closer to
 * how the eye reads a light field, at the cost of saturating where it is
 * densest. Which one carries better depends on the projector, so figures
 * expose it rather than the module choosing.
 */
export type CloudBlend = 'normal' | 'additive';

export interface PixelRayCloudOptions {
  /** Indexed [sample][pixel], from tracePixelGrid. */
  paths: TracedPath[][];
  /** Draw samples 0..sampleCount-1. Default: all of them. */
  sampleCount?: number;
  /** Per-line alpha. A few hundred thousand lines want a very low one. */
  opacity?: number;
  blend?: CloudBlend;
  /** Paths that carried no light, dimmed to this fraction. */
  darkDim?: number;
  palette?: PathPalette;
}

export class PixelRayCloud {
  readonly group = new THREE.Group();
  /** Line segments actually written — the size of the picture, in one number. */
  readonly segmentCount: number;
  /** Paths contributing to it (some are single vertices and draw nothing). */
  readonly pathCount: number;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.LineBasicMaterial;

  constructor(options: PixelRayCloudOptions) {
    const {
      paths,
      sampleCount = paths.length,
      opacity = 0.15,
      blend = 'normal',
      darkDim = 0.45,
      palette = 'camera',
    } = options;
    const samples = Math.max(0, Math.min(sampleCount, paths.length));

    // Size the buffers exactly: a still is built once, so there is no reason
    // to carry the worst-case slack PixelRays needs for a growing frame.
    let segments = 0;
    let pathsDrawn = 0;
    for (let s = 0; s < samples; s++) {
      for (const p of paths[s]!) {
        if (!p || p.points.length < 2) continue;
        segments += p.points.length - 1;
        pathsDrawn += 1;
      }
    }
    this.segmentCount = segments;
    this.pathCount = pathsDrawn;

    const positions = new Float32Array(segments * 6);
    const colors = new Float32Array(segments * 6);
    let cursor = 0;
    for (let s = 0; s < samples; s++) {
      for (const path of paths[s]!) {
        if (!path || path.points.length < 2) continue;
        const color = segmentColor(path.beta, false, palette);
        const dim = path.lit ? 1 : darkDim;
        const r = color.r * dim;
        const g = color.g * dim;
        const b = color.b * dim;
        for (let k = 1; k < path.points.length; k++) {
          const a = path.points[k - 1] as Tuple3;
          const c = path.points[k] as Tuple3;
          const o = cursor * 6;
          positions[o] = a[0];
          positions[o + 1] = a[1];
          positions[o + 2] = a[2];
          positions[o + 3] = c[0];
          positions[o + 4] = c[1];
          positions[o + 5] = c[2];
          colors[o] = r;
          colors[o + 1] = g;
          colors[o + 2] = b;
          colors[o + 3] = r;
          colors[o + 4] = g;
          colors[o + 5] = b;
          cursor += 1;
        }
      }
    }

    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity,
      blending: blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
      // Hundreds of thousands of translucent lines cannot be depth-sorted,
      // and writing depth would make the result depend on draw order — the
      // rays would occlude each other in whatever sequence the buffer
      // happened to be filled in.
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(this.geometry, this.material);
    lines.frustumCulled = false;
    this.group.add(lines);
  }

  /** Tune the density without rebuilding the geometry. */
  setOpacity(opacity: number): void {
    this.material.opacity = opacity;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

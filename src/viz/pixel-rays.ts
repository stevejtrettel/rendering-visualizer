// A whole grid of pixels firing rays into the scene, one sample at a time.
//
// The single-path elements in path-elements.ts build a three.js object per
// segment, which is right for one path being narrated and hopeless for
// sixty-four of them replaced several times a second. This draws the entire
// population as ONE buffered LineSegments: the visible geometry at time t is
// computed straight into a preallocated typed array, so a frame costs a few
// hundred writes and one draw call.
//
// Pure function of t, like everything on the stage — so scrubbing and
// frame-stepped export show exactly what playback shows.
import * as THREE from 'three';
import type { Tuple3 } from '../trace/records';
import type { TracedPath } from '../trace/pixel-grid';
import { segmentColor, type PathPalette } from './path-elements';

/** How a sample's rays enter the scene. */
export type LaunchMode =
  // Raster order over `sweepSeconds`, so the grid is visibly scanned and
  // individual paths stay separable before they all bounce together.
  | 'sweep'
  // Every pixel leaves the pinhole on the same frame. The strongest reading
  // of "one sample = one ray per pixel", and the right choice when the
  // sample period is short and the movie is long.
  | 'together';

export interface PixelRaysOptions {
  /** Indexed [sample][pixel], from tracePixelGrid. */
  paths: TracedPath[][];
  /** Seconds each sample owns. */
  samplePeriod: number;
  launch: LaunchMode;
  /** Seconds the sweep takes to cross the whole grid (launch: 'sweep'). */
  sweepSeconds: number;
  /**
   * Fraction of the sample period by which the LONGEST path has finished
   * drawing. The growth rate follows from it and from the traced geometry,
   * which is the only way this works across scenes: an absolute world-units
   * -per-second is a number that has to be retuned for every scene, and
   * gets it wrong silently — a Cornell camera ray is ~11 units before its
   * first bounce, so a speed tuned on a small scene draws a stub and
   * nothing else.
   *
   * Every ray still travels at the SAME speed, which is the physically
   * honest reading: a long flight across the room takes longer than a short
   * hop. Only the common rate is fitted to the scene.
   */
  drawFraction: number;
  /** Override the fitted rate, in world units per second. */
  speed?: number;
  /** Fraction of the period spent fading out, so samples do not pile up. */
  fadeFraction: number;
  palette?: PathPalette;
  /** Paths that carried no light, dimmed to this fraction. */
  darkDim?: number;
}

const dist = (a: Tuple3, b: Tuple3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

export class PixelRays {
  readonly group = new THREE.Group();
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly lines: THREE.LineSegments;
  private readonly capacity: number;
  private readonly samples: number;
  /** The fitted growth rate, world units per second. */
  readonly speed: number;
  /** Arclength of the longest path in the whole trace. */
  readonly maxPathLength: number;

  constructor(private readonly options: PixelRaysOptions) {
    const { paths, samplePeriod, launch, sweepSeconds, drawFraction } = options;
    this.samples = paths.length;

    // Worst case: every pixel's longest path fully drawn, in one sample.
    let maxSegments = 0;
    let maxLength = 0;
    for (const sample of paths) {
      let n = 0;
      for (const p of sample) {
        n += Math.max(0, p.points.length - 1);
        let len = 0;
        for (let k = 1; k < p.points.length; k++) len += dist(p.points[k - 1]!, p.points[k]!);
        maxLength = Math.max(maxLength, len);
      }
      maxSegments = Math.max(maxSegments, n);
    }
    this.capacity = Math.max(1, maxSegments);
    this.maxPathLength = maxLength;

    // The last pixel to launch must still finish inside the draw window, so
    // a sweep eats into it. Floored so a long sweep cannot demand an
    // infinite rate.
    const window = Math.max(
      0.15 * samplePeriod,
      drawFraction * samplePeriod - (launch === 'sweep' ? sweepSeconds : 0),
    );
    this.speed = options.speed ?? (maxLength > 0 ? maxLength / window : 1);

    this.positions = new Float32Array(this.capacity * 6);
    this.colors = new Float32Array(this.capacity * 6);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(
      this.geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }),
    );
    this.lines.frustumCulled = false; // the buffer is rewritten every frame
    this.group.add(this.lines);
  }

  /** Total seconds of animation for the whole sample sequence. */
  get duration(): number {
    return this.samples * this.options.samplePeriod;
  }

  /** Segments currently on screen — the growth, in one number. */
  get drawnSegments(): number {
    return this.geometry.drawRange.count / 2;
  }

  /** Which sample is on screen at time t. */
  sampleAt(t: number): number {
    const { samplePeriod } = this.options;
    return Math.min(this.samples - 1, Math.max(0, Math.floor(t / samplePeriod)));
  }

  drawAt(t: number): void {
    const { paths, samplePeriod, launch, sweepSeconds, fadeFraction, palette = 'camera', darkDim = 0.45 } =
      this.options;
    const speed = this.speed;
    const s = this.sampleAt(t);
    const local = t - s * samplePeriod;
    const sample = paths[s];
    if (!sample) {
      this.geometry.setDrawRange(0, 0);
      return;
    }

    // A sample fades out over the tail of its period so successive samples
    // read as flow rather than as an ever-thickening tangle.
    const fadeStart = samplePeriod * (1 - fadeFraction);
    const fade = local <= fadeStart || fadeFraction <= 0
      ? 1
      : Math.max(0, 1 - (local - fadeStart) / (samplePeriod - fadeStart));

    const n = sample.length;
    let cursor = 0;
    for (let i = 0; i < n && cursor < this.capacity; i++) {
      const path = sample[i]!;
      if (path.points.length < 2) continue;

      const start = launch === 'sweep' ? (i / n) * sweepSeconds : 0;
      const tau = local - start;
      if (tau <= 0) continue;

      const color = segmentColor(path.beta, false, palette);
      const dim = fade * (path.lit ? 1 : darkDim);
      const r = color.r * dim;
      const g = color.g * dim;
      const b = color.b * dim;
      if (dim <= 0.002) continue;

      // Grow along the polyline by arclength — the ray travels at a fixed
      // speed through the scene rather than each segment taking equal time,
      // so a long flight across the room reads as a long flight.
      let remaining = tau * speed;
      for (let k = 1; k < path.points.length && cursor < this.capacity; k++) {
        if (remaining <= 0) break;
        const a = path.points[k - 1]!;
        const c = path.points[k]!;
        const len = dist(a, c);
        const f = len > 0 ? Math.min(1, remaining / len) : 1;
        remaining -= len;

        const o = cursor * 6;
        this.positions[o] = a[0];
        this.positions[o + 1] = a[1];
        this.positions[o + 2] = a[2];
        this.positions[o + 3] = a[0] + (c[0] - a[0]) * f;
        this.positions[o + 4] = a[1] + (c[1] - a[1]) * f;
        this.positions[o + 5] = a[2] + (c[2] - a[2]) * f;
        this.colors[o] = r;
        this.colors[o + 1] = g;
        this.colors[o + 2] = b;
        this.colors[o + 3] = r;
        this.colors[o + 4] = g;
        this.colors[o + 5] = b;
        cursor += 1;
      }
    }

    this.geometry.setDrawRange(0, cursor * 2);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}

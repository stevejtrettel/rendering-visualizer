// One sample's rays leaving the whole grid together and walking out in
// lockstep, one bounce per beat, until a ray lands on the lamp.
//
// The third of the buffered-population elements, and the one about SEARCH.
// PixelRays draws sample after sample, each fading out, coloured by
// throughput; PixelRayCloud draws every sample at once, standing still. This
// draws ONE sample, never fades it, and colours it by a single yes/no:
// has this path found the light yet.
//
//   dark   the path so far, carrying nothing anyone can see
//   lit    it landed on an emitter — the whole path, all at once
//
// Which is a deliberately cruder language than segmentColor's throughput
// ramp, because the claim is cruder: at ten bounces from a 16x16 grid,
// a couple of hundred rays are groping around a room and a handful of them
// find the lamp. Shading the misses by how much they still carry would say
// they differ; they do not, in the only respect this figure is about.
//
// Lockstep, not constant speed: every ray's k-th flight takes the same beat
// however far it travels, so "bounce 4" is a moment on the clock the
// audience can count to, and the population arrives at the lamp in visible
// waves. (PixelRays is the honest-speed version, and is the right element
// when the figure is about a single sample's flight rather than about
// depth.)
//
// Pure function of t, like everything on the stage.
import * as THREE from 'three';
import type { Tuple3 } from '../trace/records';
import type { TracedPath } from '../trace/pixel-grid';
import { C } from './style';

export interface BounceCloudOptions {
  /** One sample's paths, one per pixel — paths[s] from tracePixelGrid. */
  paths: readonly TracedPath[];
  /** Bounces drawn, at most. Paths longer than this are truncated. */
  maxBounces: number;
  /** Seconds a bounce spends flying. Every ray's k-th flight takes this. */
  flySeconds: number;
  /** Beat after each bounce lands, before the next launches. */
  settleSeconds: number;
  /** Seconds the finished population stays up at the end of the loop. */
  holdSeconds?: number;
  /** Paths that have not found the light. */
  darkColor?: number;
  /** …dimmed by this, so the misses can be pushed toward the void. */
  darkDim?: number;
  /** Paths that have. */
  litColor?: number;
  opacity?: number;
}

const dist = (a: Tuple3, b: Tuple3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** What of a path this figure draws, precomputed once. */
interface Walk {
  points: readonly Tuple3[];
  /**
   * Segments drawn, ever. A path that reaches the lamp STOPS there — it is
   * finished, it delivered, and the bounces the walk went on to take after
   * skipping off the light surface are not part of the story.
   */
  segments: number;
  /** Beat index (1-based) whose landing turns the path lit, or null. */
  litOnBounce: number | null;
}

export class BounceCloud {
  readonly group = new THREE.Group();
  /** Paths with at least one segment to draw — the population, in one number. */
  readonly pathCount: number;
  /** Paths that reach an emitter within `maxBounces`. */
  readonly litCount: number;
  /** Longest walk actually drawn, in bounces — where the figure really ends. */
  readonly deepest: number;
  private readonly walks: Walk[] = [];
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.LineBasicMaterial;
  private readonly dark = new THREE.Color();
  private readonly lit = new THREE.Color();

  constructor(private readonly options: BounceCloudOptions) {
    const {
      paths,
      maxBounces,
      darkColor = C.slateDeep,
      darkDim = 0.7,
      litColor = C.ochreLight,
      opacity = 0.9,
    } = options;

    let capacity = 0;
    let lit = 0;
    let deepest = 0;
    for (const path of paths) {
      const walked = path.points.length - 1;
      if (walked < 1) continue;
      const stop = path.litAt !== null && path.litAt <= maxBounces ? path.litAt : null;
      const segments = Math.min(walked, stop ?? maxBounces);
      this.walks.push({ points: path.points, segments, litOnBounce: stop });
      capacity += segments;
      deepest = Math.max(deepest, segments);
      if (stop !== null) lit += 1;
    }
    this.pathCount = this.walks.length;
    this.litCount = lit;
    this.deepest = deepest;

    this.setDark(darkColor, darkDim);
    this.lit.setHex(litColor);

    this.positions = new Float32Array(Math.max(1, capacity) * 6);
    this.colors = new Float32Array(Math.max(1, capacity) * 6);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity,
      // Nothing here is depth-sorted, and the rays are meant to be seen
      // through each other — as in the sibling elements.
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(this.geometry, this.material);
    lines.frustumCulled = false; // the buffer is rewritten every frame
    this.group.add(lines);
  }

  /** Seconds one bounce owns: its flight plus the beat after it. */
  get beat(): number {
    return this.options.flySeconds + this.options.settleSeconds;
  }

  /** The whole build, plus the hold at the end. */
  get duration(): number {
    return this.deepest * this.beat + (this.options.holdSeconds ?? 0);
  }

  /** Which bounce is in the air (or just landed) at t, 1-based. */
  bounceAt(t: number): number {
    return Math.min(this.deepest, Math.max(1, Math.floor(t / this.beat) + 1));
  }

  /** Paths that have found the light by t. */
  litBy(t: number): number {
    let n = 0;
    for (const w of this.walks) {
      if (w.litOnBounce !== null && t >= this.flipTime(w.litOnBounce)) n += 1;
    }
    return n;
  }

  /** Retune the misses without rebuilding anything — the next frame shows it. */
  setDark(color: number, dim: number): void {
    this.dark.setHex(color).multiplyScalar(dim);
  }

  setOpacity(opacity: number): void {
    this.material.opacity = opacity;
  }

  /**
   * The moment the k-th flight lands, which is when a path that hit flips.
   *
   * Public because a figure may have something else to do on that beat —
   * light-bounce lights the film cell a photon landed in, and the cell must
   * come up on the same frame the path turns, not a frame either side.
   */
  flipTime(bounce: number): number {
    return (bounce - 1) * this.beat + this.options.flySeconds;
  }

  drawAt(t: number): void {
    const { flySeconds } = this.options;
    const beat = this.beat;
    let cursor = 0;

    for (const walk of this.walks) {
      const isLit = walk.litOnBounce !== null && t >= this.flipTime(walk.litOnBounce);
      const c = isLit ? this.lit : this.dark;

      for (let k = 1; k <= walk.segments; k++) {
        // Every ray's k-th flight owns the same window, whatever its length:
        // that is what makes the depth countable.
        const f = Math.min(1, (t - (k - 1) * beat) / flySeconds);
        if (f <= 0) break;

        const a = walk.points[k - 1]!;
        const b = walk.points[k]!;
        const o = cursor * 6;
        this.positions[o] = a[0];
        this.positions[o + 1] = a[1];
        this.positions[o + 2] = a[2];
        this.positions[o + 3] = a[0] + (b[0] - a[0]) * f;
        this.positions[o + 4] = a[1] + (b[1] - a[1]) * f;
        this.positions[o + 5] = a[2] + (b[2] - a[2]) * f;
        this.colors[o] = c.r;
        this.colors[o + 1] = c.g;
        this.colors[o + 2] = c.b;
        this.colors[o + 3] = c.r;
        this.colors[o + 4] = c.g;
        this.colors[o + 5] = c.b;
        cursor += 1;
      }
    }

    this.geometry.setDrawRange(0, cursor * 2);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Total length of a walk, for reporting rather than for pacing. */
  static walkLength(path: TracedPath): number {
    let total = 0;
    for (let k = 1; k < path.points.length; k++) total += dist(path.points[k - 1]!, path.points[k]!);
    return total;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

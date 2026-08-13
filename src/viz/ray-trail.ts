// One path, drawn up to a given arclength — and nothing else.
//
// path-elements.ts builds a three.js object per segment from a PathSchedule,
// which is right when a path is being NARRATED: each segment owns its slot on
// the clock, vertices have moments, shadow rays fire. A figure that swaps the
// whole path several times a second cannot afford that — rebuilding a dozen
// Line2s and their materials thirty times a second churns geometry and
// shader programs for a picture that is only ever showing one path.
//
// So this preallocates the slots once and rewrites them. `show()` takes a
// path and how far along it to draw, which covers both readings with one
// object and one look: a ray growing (arclength rising with t) and a ray
// being replaced (arclength infinite, different path each time).
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { polyline, setPolyline } from './lines';
import { brightness, segmentColor, PATH_COLORS, type PathPalette } from './path-elements';
import type { Tuple3 } from '../trace/records';

export interface TrailSegment {
  from: Tuple3;
  to: Tuple3;
  /** Throughput arriving along it — brightness and width, as everywhere. */
  betaLuminance: number;
  delta: boolean;
}

export interface RayTrailOptions {
  /** Slots to preallocate. Paths longer than this are drawn truncated. */
  maxSegments: number;
  /** Width in pixels at 1080p, at full throughput. */
  lineWidth?: number;
  palette?: PathPalette;
  /** Mark each bounce with a dot. Makes depth countable without a caption. */
  dots?: boolean;
  dotRadius?: number;
}

const dist = (a: Tuple3, b: Tuple3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

export class RayTrail {
  readonly group = new THREE.Group();
  private readonly lines: Line2[] = [];
  private readonly dots: THREE.Mesh[] = [];
  private readonly dotMaterial: THREE.MeshBasicMaterial | null;
  private readonly lineWidth: number;
  private readonly palette: PathPalette;

  constructor(options: RayTrailOptions) {
    const {
      maxSegments,
      lineWidth = 4,
      palette = 'camera',
      dots = true,
      dotRadius = 0.055,
    } = options;
    this.lineWidth = lineWidth;
    this.palette = palette;

    const dotGeometry = dots ? new THREE.SphereGeometry(dotRadius, 12, 12) : null;
    // Transparent from the start even at full opacity: `show` dims a whole
    // trail by setting opacity, and flipping `transparent` at runtime forces
    // a shader recompile on the frame it changes.
    const dotMaterial = dots
      ? new THREE.MeshBasicMaterial({ color: PATH_COLORS[palette], transparent: true })
      : null;
    this.dotMaterial = dotMaterial;

    for (let i = 0; i < maxSegments; i++) {
      // Every slot is a TWO-point line for its whole life: setPolyline can
      // only replace points in place while the count holds.
      const line = polyline(
        [
          [0, 0, 0],
          [0, 0, 0],
        ],
        { width: lineWidth },
      );
      line.visible = false;
      line.frustumCulled = false;
      (line.material as LineMaterial).transparent = true;
      this.lines.push(line);
      this.group.add(line);

      if (dotGeometry && dotMaterial) {
        const dot = new THREE.Mesh(dotGeometry, dotMaterial);
        dot.visible = false;
        this.dots.push(dot);
        this.group.add(dot);
      }
    }
  }

  /**
   * Draw `segments` up to `drawLength` world units from the start.
   *
   * Growth is by ARCLENGTH, not per-segment fractions: the ray moves at one
   * speed through the scene, so a long flight across the room takes longer
   * than a short hop — which is the honest reading, and the one that makes
   * a bounce look like a bounce.
   *
   * `dim` fades the whole trail, for a figure that keeps earlier attempts on
   * screen behind the one it is currently drawing.
   */
  show(segments: readonly TrailSegment[], drawLength = Infinity, dim = 1): void {
    if (this.dotMaterial) this.dotMaterial.opacity = dim;
    let remaining = drawLength;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i]!;
      const dot = this.dots[i];
      const seg = segments[i];
      if (!seg || remaining <= 0) {
        line.visible = false;
        if (dot) dot.visible = false;
        continue;
      }

      const length = dist(seg.from, seg.to);
      const f = length > 0 ? Math.min(1, remaining / length) : 1;
      remaining -= length;

      // Copied out mutable: polyline's Pt is a writable tuple, and a
      // PathRecord's points are readonly by design.
      const base: [number, number, number] = [seg.from[0], seg.from[1], seg.from[2]];
      const tip: [number, number, number] = [
        seg.from[0] + (seg.to[0] - seg.from[0]) * f,
        seg.from[1] + (seg.to[1] - seg.from[1]) * f,
        seg.from[2] + (seg.to[2] - seg.from[2]) * f,
      ];
      setPolyline(line, [base, tip]);
      const material = line.material as LineMaterial;
      material.color.copy(segmentColor(seg.betaLuminance, seg.delta, this.palette));
      material.linewidth = this.lineWidth * (0.5 + 0.5 * brightness(seg.betaLuminance));
      material.opacity = dim;
      line.visible = true;

      // The bounce is only marked once the ray has actually got there.
      if (dot) {
        dot.visible = f >= 1;
        if (f >= 1) dot.position.set(seg.to[0], seg.to[1], seg.to[2]);
      }
    }
  }

  /** Total arclength of a path, for pacing its growth. */
  static length(segments: readonly TrailSegment[]): number {
    let total = 0;
    for (const s of segments) total += dist(s.from, s.to);
    return total;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const line of this.lines) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    const dot = this.dots[0];
    if (dot) {
      dot.geometry.dispose();
      (dot.material as THREE.Material).dispose();
    }
  }
}

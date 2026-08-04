// A churning POPULATION of paths, rather than one path animated.
//
// The rest of the viz layer builds one three.js object per path per segment,
// which is right for a single path growing on a clock and wrong for a hundred
// paths being replaced continuously. This module draws the whole population as
// ONE THREE.LineSegments over a preallocated buffer: no per-frame allocation,
// one draw call, and the cost of a refresh is a typed-array write.
//
// Determinism is preserved the same way everything else here preserves it: the
// visible population is a pure function of time. At time t the window covers
// sample indices [step*K - N, step*K) with step = floor(t * rate) — so play,
// scrub, and frame-stepped export all show the same populations.
import * as THREE from 'three';
import type { Tuple3 } from '../trace/records';
import { PATH_COLORS, segmentColor, type PathPalette } from './path-elements';

export type SwarmPalette = PathPalette | 'connection' | 'blocked';

export interface SwarmPolyline {
  points: readonly Tuple3[];
  // Throughput luminance along the line — drives brightness, as elsewhere.
  beta: number;
  palette: SwarmPalette;
  // 0 = newest, 1 = about to be replaced. Older members dim so the churn
  // reads as flow rather than flicker.
  age: number;
}

const CONNECTION = new THREE.Color(PATH_COLORS.connectionOk);
const BLOCKED = new THREE.Color(PATH_COLORS.connectionBlocked);

function colorFor(line: SwarmPolyline): THREE.Color {
  if (line.palette === 'connection') return CONNECTION.clone();
  if (line.palette === 'blocked') return BLOCKED.clone();
  return segmentColor(line.beta, false, line.palette);
}

export class PathSwarm {
  private readonly geometry = new THREE.BufferGeometry();
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly lines: THREE.LineSegments;
  private readonly capacity: number;

  // capacity = maximum number of SEGMENTS drawn at once (paths x bounces).
  constructor(capacity: number, parent: THREE.Object3D) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 6);
    this.colors = new Float32Array(capacity * 6);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(
      this.geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
    );
    this.lines.frustumCulled = false; // the buffer is rewritten every update
    parent.add(this.lines);
  }

  // Rewrite the whole population. Cheap enough to do wholesale: a hundred
  // paths of eight segments is ~5k floats, far below the cost of tracing them.
  update(lines: readonly SwarmPolyline[]): void {
    let s = 0; // segment cursor
    for (const line of lines) {
      const color = colorFor(line);
      // Age dims toward black; the background is dark, so this reads as fade.
      const dim = 1 - 0.75 * Math.min(1, Math.max(0, line.age));
      const [r, g, b] = [color.r * dim, color.g * dim, color.b * dim];
      for (let i = 1; i < line.points.length && s < this.capacity; i++, s++) {
        const a = line.points[i - 1]!;
        const c = line.points[i]!;
        const p = s * 6;
        this.positions[p] = a[0];
        this.positions[p + 1] = a[1];
        this.positions[p + 2] = a[2];
        this.positions[p + 3] = c[0];
        this.positions[p + 4] = c[1];
        this.positions[p + 5] = c[2];
        this.colors[p] = r;
        this.colors[p + 1] = g;
        this.colors[p + 2] = b;
        this.colors[p + 3] = r;
        this.colors[p + 4] = g;
        this.colors[p + 5] = b;
      }
      if (s >= this.capacity) break;
    }
    this.geometry.setDrawRange(0, s * 2);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.lines.removeFromParent();
    this.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}

// The rolling window itself: at time t, which sample indices are on screen.
// `rate` is refreshes per second, `replace` how many samples each refresh
// retires. Returns the oldest-first list of indices.
export function swarmWindow(
  t: number,
  rate: number,
  replace: number,
  size: number,
): number[] {
  const step = Math.max(0, Math.floor(t * rate));
  const newest = step * replace + size; // exclusive
  const oldest = Math.max(0, newest - size);
  const indices: number[] = [];
  for (let i = oldest; i < newest; i++) indices.push(i);
  return indices;
}

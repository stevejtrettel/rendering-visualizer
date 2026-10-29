/**
 * Thick lines.
 *
 * `THREE.Line` is stuck at one physical pixel on every desktop GL driver, which
 * is invisible from the back of a lecture hall. These use three's `Line2`, which
 * builds lines out of screen-space quads and honours real widths.
 *
 * `Line2` needs its material told the size of the drawing buffer, or widths
 * come out wrong. Every material made here is registered so the stage can
 * refresh them on resize and — importantly — when it jumps to export
 * resolution, which is what keeps line weight identical in preview and export.
 */

import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { C } from './style';

const materials = new Set<LineMaterial>();

/** Point the registered line materials at the current drawing buffer size. */
export function setLineResolution(w: number, h: number): void {
  for (const m of materials) m.resolution.set(w, h);
}

export interface LineOptions {
  color?: number;
  /** Width in pixels at 1920×1080, scaled automatically at other sizes. */
  width?: number;
  opacity?: number;
  /** Draw dashes. Combine with `dashSize` / `gapSize`. */
  dashed?: boolean;
  dashSize?: number;
  gapSize?: number;
}

export type Pt = THREE.Vector3 | [number, number, number];

function flatten(points: Pt[]): number[] {
  const out: number[] = [];
  for (const p of points) {
    if (Array.isArray(p)) out.push(p[0], p[1], p[2]);
    else out.push(p.x, p.y, p.z);
  }
  return out;
}

/** A thick polyline through the given points. */
export function polyline(points: Pt[], opts: LineOptions = {}): Line2 {
  const {
    color = C.bone,
    width = 3,
    opacity = 1,
    dashed = false,
    dashSize = 0.1,
    gapSize = 0.06,
  } = opts;

  const geom = new LineGeometry();
  geom.setPositions(flatten(points));

  const mat = new LineMaterial({
    color,
    linewidth: width,
    // Widths are authored against the 1080p export, so a line looks the same
    // whether you are previewing in a small window or rendering the movie.
    worldUnits: false,
    dashed,
    dashSize,
    gapSize,
    transparent: opacity < 1,
    opacity,
  });
  materials.add(mat);

  const line = new Line2(geom, mat);
  if (dashed) line.computeLineDistances();
  return line;
}

/**
 * Replace a polyline's points in place. Cheaper than rebuilding when a curve
 * animates — but note the vertex count must stay the same.
 */
export function setPolyline(line: Line2, points: Pt[]): void {
  (line.geometry as LineGeometry).setPositions(flatten(points));
  line.computeLineDistances();
}

/**
 * Many thick segments in one draw call, each with its own colour: for a
 * figure that shows hundreds of rays at once, where a Line2 per segment
 * would be hundreds of objects. Fill with setSegments every frame.
 */
export function segments(opts: { width?: number; opacity?: number; toneMapped?: boolean } = {}): LineSegments2 {
  const { width = 2, opacity = 1, toneMapped = true } = opts;
  const mat = new LineMaterial({
    color: 0xffffff,
    linewidth: width,
    worldUnits: false,
    vertexColors: true,
    transparent: opacity < 1,
    opacity,
  });
  mat.toneMapped = toneMapped;
  materials.add(mat);
  const lines = new LineSegments2(new LineSegmentsGeometry(), mat);
  lines.frustumCulled = false; // rewritten every frame
  return lines;
}

/**
 * Replace a segment set's contents: `positions` holds 6 numbers per segment
 * (both ends), `colors` 6 per segment (an rgb per end). An empty set hides it.
 *
 * The buffers are written in place and `instanceCount` set, with the geometry
 * replaced only when it must grow. Calling setPositions every frame is NOT
 * equivalent: three caches an instanced geometry's maximum instance count the
 * first time it is drawn (_maxInstanceCount) and never revisits it, so a set
 * that starts with 256 segments and grows silently draws only the first 256.
 */
export function setSegments(lines: LineSegments2, positions: Float32Array, colors: Float32Array): void {
  const count = positions.length / 6;
  lines.visible = count > 0;
  if (!lines.visible) return;
  let geom = lines.geometry as LineSegmentsGeometry;
  const capacity: number = lines.userData.capacity ?? 0;
  if (count > capacity) {
    const grown = Math.max(count, 2 * capacity, 256);
    geom.dispose();
    geom = new LineSegmentsGeometry();
    geom.setPositions(new Float32Array(grown * 6));
    geom.setColors(new Float32Array(grown * 6));
    lines.geometry = geom;
    lines.userData.capacity = grown;
  }
  const pos = (geom.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute).data;
  const col = (geom.getAttribute('instanceColorStart') as THREE.InterleavedBufferAttribute).data;
  (pos.array as Float32Array).set(positions);
  (col.array as Float32Array).set(colors);
  pos.needsUpdate = true;
  col.needsUpdate = true;
  geom.instanceCount = count;
}

/** Sample `f` over [a, b] and draw it as a curve in the z = 0 plane. */
export function graph2d(
  f: (x: number) => number,
  a: number,
  b: number,
  opts: LineOptions & { samples?: number } = {},
): Line2 {
  const { samples = 600, ...rest } = opts;
  const pts: Pt[] = [];
  for (let i = 0; i <= samples; i++) {
    const x = a + ((b - a) * i) / samples;
    pts.push([x, f(x), 0]);
  }
  return polyline(pts, { color: C.ochre, width: 4, ...rest });
}

/**
 * A pair of axes in the z = 0 plane, with tick marks. Deliberately dim: the
 * scaffolding should sit behind the mathematics, not compete with it.
 */
export function axes2d(opts: {
  xRange?: [number, number];
  yRange?: [number, number];
  tick?: number;
  color?: number;
  width?: number;
} = {}): THREE.Group {
  const {
    xRange = [-1, 1],
    yRange = [-1, 1],
    tick = 0.5,
    color = C.slateDeep,
    width = 2,
  } = opts;

  const g = new THREE.Group();
  g.add(polyline([[xRange[0], 0, 0], [xRange[1], 0, 0]], { color, width }));
  g.add(polyline([[0, yRange[0], 0], [0, yRange[1], 0]], { color, width }));

  const h = tick * 0.12;
  for (let x = Math.ceil(xRange[0] / tick) * tick; x <= xRange[1]; x += tick) {
    if (Math.abs(x) < 1e-9) continue;
    g.add(polyline([[x, -h, 0], [x, h, 0]], { color, width }));
  }
  for (let y = Math.ceil(yRange[0] / tick) * tick; y <= yRange[1]; y += tick) {
    if (Math.abs(y) < 1e-9) continue;
    g.add(polyline([[-h, y, 0], [h, y, 0]], { color, width }));
  }
  return g;
}

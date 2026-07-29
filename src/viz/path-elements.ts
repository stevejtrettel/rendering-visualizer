// three.js elements that render a PathSchedule at time t, in either render
// tier: 'lines' (Line2, real pixel width) or 'tubes' (TubeGeometry meshes).
// Visual language per docs/design-viz.md: camera paths warm white -> amber,
// brightness/width by throughput; shadow rays green / red-to-blocker;
// delta bounces specular white; RR death an x-marker; escapes fade out.
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { PathSchedule, SegmentTiming, VertexMoment } from './path-schedule';
import { segmentProgress } from './path-schedule';
import type { Tuple3 } from '../trace/records';
import type { TimelineElement } from './timeline';

export type RenderTier = 'lines' | 'tubes';

// Which subpath a set of elements draws: camera walks in the warm amber
// language, light walks (BDPT) in cyan.
export type PathPalette = 'camera' | 'light';

export interface PathStyle {
  tier: RenderTier;
  lineWidth: number; // pixels, lines tier
  tubeRadius: number; // world units at unit brightness, tubes tier
  resolution: THREE.Vector2; // canvas size, required by LineMaterial
  palette?: PathPalette; // default 'camera'
}

const v3 = (t: Tuple3) => new THREE.Vector3(t[0], t[1], t[2]);
const lerp3 = (a: Tuple3, b: Tuple3, s: number): Tuple3 => [
  a[0] + (b[0] - a[0]) * s,
  a[1] + (b[1] - a[1]) * s,
  a[2] + (b[2] - a[2]) * s,
];

// Throughput -> [0,1] brightness, log-scaled per the design language.
export function brightness(betaLuminance: number): number {
  const floor = 1e-3;
  const b = (Math.log10(Math.max(betaLuminance, floor)) - Math.log10(floor)) / -Math.log10(floor);
  return 0.25 + 0.75 * Math.min(1, b);
}

// Camera: warm white -> amber. Light subpath: cyan. Both scaled by
// throughput brightness; specular white in either language.
export function segmentColor(
  betaLuminance: number,
  delta: boolean,
  palette: PathPalette = 'camera',
): THREE.Color {
  if (delta) return new THREE.Color(1, 1, 1); // specular white
  const b = brightness(betaLuminance);
  const hue = palette === 'light' ? 0.52 : 0.09;
  // Light subpaths carry Le-scaled throughput that pins the brightness ramp;
  // cap their lightness so the cyan stays saturated instead of washing white.
  const lightness = 0.35 + 0.5 * b;
  return new THREE.Color().setHSL(hue, 0.85, palette === 'light' ? Math.min(lightness, 0.6) : lightness);
}

const DOT_COLOR: Record<PathPalette, number> = { camera: 0xffc070, light: 0x70d8ff };
const ARROW_COLOR: Record<PathPalette, number> = { camera: 0xffe0b0, light: 0xb0e8ff };
const SHADOW_OK = new THREE.Color(0x44cc66);
const SHADOW_BLOCKED = new THREE.Color(0xdd4444);

// One growing segment of the path, in either tier.
class SegmentElement implements TimelineElement {
  private object: THREE.Object3D;
  private lineGeometry: LineGeometry | null = null;
  private tube: THREE.Mesh | null = null;
  private lastProgress = -1;

  constructor(
    private readonly seg: SegmentTiming,
    private readonly delta: boolean,
    private readonly style: PathStyle,
    private readonly parent: THREE.Object3D,
    private readonly color?: THREE.Color,
    private readonly opacity = 1,
  ) {
    const c = color ?? segmentColor(seg.betaLuminance, delta, style.palette ?? 'camera');
    if (style.tier === 'lines') {
      this.lineGeometry = new LineGeometry();
      this.lineGeometry.setPositions([...seg.from, ...seg.from]);
      const material = new LineMaterial({
        color: c.getHex(),
        linewidth: style.lineWidth * (0.5 + 0.5 * brightness(seg.betaLuminance)),
        transparent: opacity < 1,
        opacity,
      });
      material.resolution.copy(style.resolution);
      this.object = new Line2(this.lineGeometry, material);
    } else {
      const material = new THREE.MeshStandardMaterial({
        color: c,
        emissive: c,
        emissiveIntensity: 0.7,
        transparent: opacity < 1,
        opacity,
      });
      this.tube = new THREE.Mesh(new THREE.BufferGeometry(), material);
      this.object = this.tube;
    }
    (this.object as THREE.Mesh).visible = false;
    parent.add(this.object);
  }

  drawAt(t: number): void {
    const progress = segmentProgress(this.seg, t);
    if (progress === this.lastProgress) return;
    this.lastProgress = progress;
    this.object.visible = progress > 0;
    if (progress === 0) return;
    const tip = lerp3(this.seg.from, this.seg.to, progress);
    if (this.lineGeometry) {
      this.lineGeometry.setPositions([...this.seg.from, ...tip]);
    } else if (this.tube) {
      this.tube.geometry.dispose();
      const radius = this.style.tubeRadius * (0.5 + 0.7 * brightness(this.seg.betaLuminance));
      this.tube.geometry = new THREE.TubeGeometry(
        new THREE.LineCurve3(v3(this.seg.from), v3(tip)), 1, radius, 8,
      );
    }
  }

  dispose(): void {
    this.parent.remove(this.object);
    this.lineGeometry?.dispose();
    this.tube?.geometry.dispose();
    ((this.object as THREE.Mesh).material as THREE.Material)?.dispose?.();
  }
}

// Everything that happens AT a vertex: the dot (enlarged during its moment),
// the sampled-direction arrow, the shadow ray, the RR death marker.
// (A sampling-distribution overlay was deliberately removed 2026-07-28 —
// if a slide ever needs one, design the general version: the Lambert lobe
// is a sphere tangent at the vertex, but GGX lobes need real machinery.)
class MomentElement implements TimelineElement {
  private group = new THREE.Group();
  private dot: THREE.Mesh;
  private arrow: THREE.ArrowHelper | null = null;
  private shadow: SegmentElement | null = null;
  private rrMarker: THREE.Group | null = null;

  constructor(
    private readonly m: VertexMoment,
    style: PathStyle,
    private readonly parent: THREE.Object3D,
  ) {
    parent.add(this.group);
    const palette = style.palette ?? 'camera';
    const dotColor = m.delta ? 0xffffff : DOT_COLOR[palette];
    this.dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 12, 8),
      new THREE.MeshBasicMaterial({ color: dotColor }),
    );
    this.dot.position.copy(v3(m.p));
    this.group.add(this.dot);

    if (!m.delta && m.wiSampled) {
      this.arrow = new THREE.ArrowHelper(
        v3(m.wiSampled).normalize(), v3(m.p), 0.65, ARROW_COLOR[palette], 0.14, 0.07,
      );
      this.group.add(this.arrow);
    }

    if (m.shadowRay) {
      const sr = m.shadowRay;
      const to = sr.occluded && sr.blockedAt ? sr.blockedAt : sr.to;
      const window = Math.max(0.25, (m.end - m.start) * 0.5);
      this.shadow = new SegmentElement(
        { from: sr.from, to, start: m.start + 0.1, end: m.start + 0.1 + window, betaLuminance: 1 },
        false,
        style,
        this.group,
        sr.occluded ? SHADOW_BLOCKED : SHADOW_OK,
        sr.occluded ? 0.9 : 0.6,
      );
    }

    if (m.rrDeath) {
      this.rrMarker = new THREE.Group();
      const mat = new LineMaterial({ color: 0xff5555, linewidth: 2.5 });
      mat.resolution.copy(style.resolution);
      const s = 0.11;
      for (const [dx, dz] of [[1, 1], [1, -1]] as const) {
        const g = new LineGeometry();
        g.setPositions([
          m.p[0] - s * dx, m.p[1] - s, m.p[2] - s * dz,
          m.p[0] + s * dx, m.p[1] + s, m.p[2] + s * dz,
        ]);
        this.rrMarker.add(new Line2(g, mat));
      }
      this.group.add(this.rrMarker);
    }
  }

  drawAt(t: number): void {
    const arrived = t >= this.m.start;
    const active = arrived && t <= this.m.end;
    this.dot.visible = arrived;
    this.dot.scale.setScalar(active ? 1.8 : 1);
    if (this.arrow) {
      // The arrow emerges midway through the moment and stays until the
      // outgoing segment has clearly taken over.
      const arrowStart = this.m.start + (this.m.end - this.m.start) * 0.4;
      this.arrow.visible = t >= arrowStart && t <= this.m.end + 0.4;
    }
    this.shadow?.drawAt(t);
    if (this.rrMarker) this.rrMarker.visible = t >= this.m.end - 0.2;
  }

  dispose(): void {
    this.shadow?.dispose();
    this.parent.remove(this.group);
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof Line2) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}

class EmissionFlash implements TimelineElement {
  private mesh: THREE.Mesh;

  constructor(
    private readonly p: Tuple3,
    private readonly time: number,
    private readonly parent: THREE.Object3D,
  ) {
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffcc, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.mesh.position.copy(v3(p));
    parent.add(this.mesh);
  }

  drawAt(t: number): void {
    const dt = t - this.time;
    const env = dt < 0 ? 0 : Math.exp(-dt * 3) * Math.min(1, dt * 12);
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = env;
    this.mesh.scale.setScalar(1 + 2.5 * Math.min(Math.max(dt, 0), 0.5));
    this.mesh.visible = env > 0.01;
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

class EscapeFade implements TimelineElement {
  private line: Line2;
  private material: LineMaterial;

  constructor(
    private readonly e: NonNullable<PathSchedule['escape']>,
    style: PathStyle,
    private readonly parent: THREE.Object3D,
  ) {
    const dir = v3(e.direction).normalize();
    const tip = v3(e.from).addScaledVector(dir, e.length);
    const g = new LineGeometry();
    g.setPositions([...e.from, tip.x, tip.y, tip.z]);
    this.material = new LineMaterial({
      color: 0x8899bb, linewidth: style.lineWidth * 0.6, transparent: true, opacity: 0,
    });
    this.material.resolution.copy(style.resolution);
    this.line = new Line2(g, this.material);
    parent.add(this.line);
  }

  drawAt(t: number): void {
    const dt = t - this.e.start;
    this.material.opacity = dt < 0 ? 0 : 0.5 * Math.exp(-dt * 1.2);
    this.line.visible = this.material.opacity > 0.01;
  }

  dispose(): void {
    this.parent.remove(this.line);
    this.line.geometry.dispose();
    this.material.dispose();
  }
}

// A BDPT connection attempt: at its moment the segment sweeps from the
// camera-side endpoint toward the light-side one — green when the two
// subpaths see each other, red dying at the blocker when they don't — then
// settles to a faint persistent line so the composed path stays readable.
export class ConnectionFlash implements TimelineElement {
  private readonly line: Line2;
  private readonly material: LineMaterial;
  private readonly from: Tuple3;
  private readonly to: Tuple3;

  constructor(
    connection: { from: Tuple3; to: Tuple3; occluded: boolean; blockedAt: Tuple3 | null },
    private readonly time: number,
    style: PathStyle,
    private readonly parent: THREE.Object3D,
    private readonly occluded = connection.occluded,
  ) {
    this.from = connection.from;
    this.to = connection.occluded && connection.blockedAt ? connection.blockedAt : connection.to;
    const g = new LineGeometry();
    g.setPositions([...this.from, ...this.from]);
    this.material = new LineMaterial({
      color: (occluded ? SHADOW_BLOCKED : SHADOW_OK).getHex(),
      linewidth: style.lineWidth * 0.8,
      transparent: true,
      opacity: 0,
    });
    this.material.resolution.copy(style.resolution);
    this.line = new Line2(g, this.material);
    this.line.visible = false;
    parent.add(this.line);
  }

  drawAt(t: number): void {
    const dt = t - this.time;
    if (dt < 0) {
      this.line.visible = false;
      return;
    }
    const sweep = Math.min(1, dt / 0.4);
    const tip = lerp3(this.from, this.to, sweep);
    this.line.geometry.dispose();
    const g = new LineGeometry();
    g.setPositions([...this.from, ...tip]);
    this.line.geometry = g;
    // Full strength through the flash, then settle (blocked ones fade more).
    const settled = this.occluded ? 0.12 : 0.3;
    const opacity = dt < 1.2 ? 0.95 : Math.max(settled, 0.95 * Math.exp(-(dt - 1.2) * 2));
    this.material.opacity = opacity;
    this.line.visible = true;
  }

  dispose(): void {
    this.parent.remove(this.line);
    this.line.geometry.dispose();
    this.material.dispose();
  }
}

// Assemble a full path animation into the timeline's element list.
export function pathElements(
  schedule: PathSchedule,
  deltas: ReadonlyArray<boolean>, // per-vertex delta flags, indexed like vertices
  style: PathStyle,
  parent: THREE.Object3D,
): TimelineElement[] {
  const elements: TimelineElement[] = [];
  schedule.segments.forEach((seg, i) => {
    elements.push(new SegmentElement(seg, deltas[i + 1] ?? false, style, parent));
  });
  for (const m of schedule.moments) {
    elements.push(new MomentElement(m, style, parent));
  }
  if (schedule.emission) {
    elements.push(new EmissionFlash(schedule.emission.p, schedule.emission.time, parent));
  }
  if (schedule.escape) {
    elements.push(new EscapeFade(schedule.escape, style, parent));
  }
  return elements;
}

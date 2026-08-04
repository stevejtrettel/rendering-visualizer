// Whole-sample elements for the flipbook and accumulate views: each sample's
// COMPLETE path (and its shadow rays) appears at once; the timeline cycles
// through samples at a fixed dwell. Pure functions of t, like everything on
// the timeline: flip shows sample floor(t/dwell), accumulate shows all
// samples up to it, dimmed by age so the bundle reads as density.
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { luminanceOf } from '../core/math/color';
import type { PathRecord, VertexRecord } from '../trace/records';
import type { TimelineElement } from './timeline';
import { brightness, segmentColor, type PathPalette, type PathStyle } from './path-elements';

export type SampleMode = 'flip' | 'accumulate';

export interface SampleFlipConfig {
  mode: SampleMode;
  dwell: number; // seconds each sample stays current
  shadowRays: boolean;
}

// Which sample is "current" at time t (clamped to the last sample).
export function currentSampleIndex(t: number, dwell: number, count: number): number {
  if (count === 0) return -1;
  return Math.min(count - 1, Math.max(0, Math.floor(t / dwell)));
}

// Age-based dimming for accumulate mode: newest full, older fading toward a
// floor so the accumulated bundle stays legible as a density.
export function opacityForAge(age: number): number {
  return age === 0 ? 1 : Math.max(0.13, 0.6 * Math.pow(0.985, age));
}

const SHADOW_OK = 0x44cc66;
const SHADOW_BLOCKED = 0xdd4444;

class SampleElement implements TimelineElement {
  private group: THREE.Group | null = null;
  private materials: { mat: LineMaterial | THREE.MeshStandardMaterial; base: number }[] = [];
  private lastVisible = false;
  private lastAge = -1;

  constructor(
    private readonly record: PathRecord,
    private readonly index: number,
    private readonly count: number,
    private readonly cfg: SampleFlipConfig,
    private readonly style: PathStyle,
    private readonly parent: THREE.Object3D,
  ) {}

  // One walk as a whole polyline, in its palette's language.
  private addWalk(g: THREE.Group, vs: readonly VertexRecord[], palette: PathPalette): void {
    if (vs.length < 2) return;
    const meanBeta =
      vs.slice(1).reduce((s, v) => s + luminanceOf(v.beta[0], v.beta[1], v.beta[2]), 0) /
      (vs.length - 1);
    const color = segmentColor(meanBeta, false, palette);
    if (this.style.tier === 'lines') {
      const geometry = new LineGeometry();
      geometry.setPositions(vs.flatMap((v) => [...v.p]));
      const mat = new LineMaterial({
        color: color.getHex(),
        linewidth: this.style.lineWidth * (0.5 + 0.5 * brightness(meanBeta)),
        transparent: true,
        opacity: 1,
      });
      mat.resolution.copy(this.style.resolution);
      g.add(new Line2(geometry, mat));
      this.materials.push({ mat, base: 1 });
    } else {
      const curve = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 1; i < vs.length; i++) {
        curve.add(new THREE.LineCurve3(
          new THREE.Vector3(...vs[i - 1]!.p), new THREE.Vector3(...vs[i]!.p),
        ));
      }
      const mat = new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 0.7, transparent: true, opacity: 1,
      });
      g.add(new THREE.Mesh(
        new THREE.TubeGeometry(curve, (vs.length - 1) * 4, this.style.tubeRadius, 6), mat,
      ));
      this.materials.push({ mat, base: 1 });
    }
  }

  // Geometry is built lazily on first visibility — accumulate mode over
  // hundreds of samples would otherwise pay full construction up front.
  private build(): THREE.Group {
    if (this.group) return this.group;
    const g = new THREE.Group();

    this.addWalk(g, this.record.vertices, 'camera');
    // BDPT records carry a light walk too: the accumulate view becomes the
    // light swarm — cyan streams growing from the emitter alongside the
    // amber camera bundle.
    this.addWalk(g, this.record.lightVertices, 'light');

    if (this.cfg.shadowRays) {
      for (const sr of this.record.shadowRays) {
        const to = sr.occluded && sr.blockedAt ? sr.blockedAt : sr.to;
        const base = sr.occluded ? 0.85 : 0.5;
        const geometry = new LineGeometry();
        geometry.setPositions([...sr.from, ...to]);
        const mat = new LineMaterial({
          color: sr.occluded ? SHADOW_BLOCKED : SHADOW_OK,
          linewidth: this.style.lineWidth * 0.55,
          transparent: true,
          opacity: base,
        });
        mat.resolution.copy(this.style.resolution);
        g.add(new Line2(geometry, mat));
        this.materials.push({ mat, base });
      }
    }

    g.visible = false;
    this.parent.add(g);
    this.group = g;
    return g;
  }

  drawAt(t: number): void {
    const current = currentSampleIndex(t, this.cfg.dwell, this.count);
    const visible =
      this.cfg.mode === 'flip' ? current === this.index : current >= this.index;
    const age = current - this.index;
    if (visible === this.lastVisible && (!visible || age === this.lastAge)) return;
    this.lastVisible = visible;
    this.lastAge = age;

    if (!visible) {
      if (this.group) this.group.visible = false;
      return;
    }
    const g = this.build();
    g.visible = true;
    const dim = this.cfg.mode === 'accumulate' ? opacityForAge(age) : 1;
    for (const { mat, base } of this.materials) mat.opacity = base * dim;
  }

  dispose(): void {
    if (!this.group) return;
    this.parent.remove(this.group);
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof Line2) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.group = null;
  }
}

export function sampleFlipElements(
  records: readonly PathRecord[],
  cfg: SampleFlipConfig,
  style: PathStyle,
  parent: THREE.Object3D,
): { elements: TimelineElement[]; duration: number } {
  const elements = records.map(
    (r, i) => new SampleElement(r, i, records.length, cfg, style, parent),
  );
  return { elements, duration: records.length * cfg.dwell + 1 };
}

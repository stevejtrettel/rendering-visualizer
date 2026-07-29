// Serializable path records: the lossy flatten of PathVertex[] that crosses
// worker boundaries and feeds the three.js layer. Plain numbers and arrays
// only — no classes, no live references (structured-clone safe by design).
import type { PathVertex } from '../core/integrators/vertex';
import type { Contribution } from '../core/integrators/types';
import type { SeedKey } from '../core/sampler/sampler';
import type { ConnectionEvent, Recorder, RREvent, ShadowRayEvent, WalkRole } from './recorder';

export type Tuple3 = readonly [number, number, number];

export interface VertexRecord {
  type: 'camera' | 'light' | 'surface';
  p: Tuple3;
  ng: Tuple3;
  ns: Tuple3;
  uv: readonly [number, number];
  beta: Tuple3;
  pdfFwd: number;
  pdfRev: number;
  delta: boolean;
  wo: Tuple3 | null;
  wiSampled: Tuple3 | null;
  primitiveName: string | null;
}

export interface ContributionRecord {
  kind: 'sample' | 'splat';
  raster: readonly [number, number];
  value: Tuple3;
}

export interface ShadowRayRecord {
  depth: number;
  from: Tuple3;
  to: Tuple3;
  occluded: boolean;
  blockedAt: Tuple3 | null;
}

export interface ConnectionRecord {
  s: number;
  t: number;
  from: Tuple3;
  to: Tuple3;
  occluded: boolean;
  blockedAt: Tuple3 | null;
  weight: number;
}

export interface PathRecord {
  key: { seq: readonly number[]; index: number };
  // Camera-walk vertices — the field every existing consumer reads; BDPT's
  // light walk lands in lightVertices so the two subpaths stay
  // distinguishable after the lossy flatten.
  vertices: VertexRecord[];
  lightVertices: VertexRecord[];
  rr: RREvent[];
  shadowRays: ShadowRayRecord[];
  connections: ConnectionRecord[];
  contributions: ContributionRecord[];
}

const t3 = (v: { x: number; y: number; z: number }): Tuple3 => [v.x, v.y, v.z];
const c3 = (c: { r: number; g: number; b: number }): Tuple3 => [c.r, c.g, c.b];

export function flattenVertex(v: PathVertex): VertexRecord {
  return {
    type: v.type,
    p: t3(v.p),
    ng: t3(v.ng),
    ns: t3(v.ns),
    uv: v.uv,
    beta: c3(v.beta),
    pdfFwd: v.pdfFwd,
    pdfRev: v.pdfRev,
    delta: v.delta,
    wo: v.wo ? t3(v.wo) : null,
    wiSampled: v.wiSampled ? t3(v.wiSampled) : null,
    primitiveName: v.primitive?.name ?? null,
  };
}

export class ArrayRecorder implements Recorder {
  readonly records: PathRecord[] = [];
  private current: PathRecord | null = null;

  beginPath(key: SeedKey): void {
    this.current = {
      key: { seq: [...key.seq], index: key.index },
      vertices: [],
      lightVertices: [],
      rr: [],
      shadowRays: [],
      connections: [],
      contributions: [],
    };
  }

  walk(vertices: readonly PathVertex[], role: WalkRole): void {
    if (!this.current) return;
    const target = role === 'light' ? this.current.lightVertices : this.current.vertices;
    target.push(...vertices.map(flattenVertex));
  }

  rr(event: RREvent): void {
    this.current?.rr.push(event);
  }

  shadowRay(event: ShadowRayEvent): void {
    this.current?.shadowRays.push({
      depth: event.depth,
      from: t3(event.from),
      to: t3(event.to),
      occluded: event.occluded,
      blockedAt: event.blockedAt ? t3(event.blockedAt) : null,
    });
  }

  connection(event: ConnectionEvent): void {
    this.current?.connections.push({
      s: event.s,
      t: event.t,
      from: t3(event.from),
      to: t3(event.to),
      occluded: event.occluded,
      blockedAt: event.blockedAt ? t3(event.blockedAt) : null,
      weight: event.weight,
    });
  }

  contribution(c: Contribution): void {
    this.current?.contributions.push({ kind: c.kind, raster: c.raster, value: c3(c.value) });
  }

  endPath(): void {
    if (this.current) this.records.push(this.current);
    this.current = null;
  }
}

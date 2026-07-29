// Serializable path records: the lossy flatten of PathVertex[] that crosses
// worker boundaries and feeds the three.js layer. Plain numbers and arrays
// only — no classes, no live references (structured-clone safe by design).
import type { PathVertex } from '../core/integrators/vertex';
import type { Contribution } from '../core/integrators/types';
import type { SeedKey } from '../core/sampler/sampler';
import type { Recorder, RREvent } from './recorder';

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

export interface PathRecord {
  key: { seq: readonly number[]; index: number };
  vertices: VertexRecord[];
  rr: RREvent[];
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
    this.current = { key: { seq: [...key.seq], index: key.index }, vertices: [], rr: [], contributions: [] };
  }

  walk(vertices: readonly PathVertex[]): void {
    this.current?.vertices.push(...vertices.map(flattenVertex));
  }

  rr(event: RREvent): void {
    this.current?.rr.push(event);
  }

  contribution(c: Contribution): void {
    this.current?.contributions.push({ kind: c.kind, raster: c.raster, value: c3(c.value) });
  }

  endPath(): void {
    if (this.current) this.records.push(this.current);
    this.current = null;
  }
}

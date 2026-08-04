// Serializable path records: the lossy flatten of PathVertex[] that crosses
// worker boundaries and feeds the three.js layer. Plain numbers and arrays
// only — no classes, no live references (structured-clone safe by design).
import type { PathVertex } from '../core/integrators/vertex';
import type { Contribution } from '../core/integrators/types';
import type { SeedKey } from '../core/sampler/sampler';
import type { ConnectionEvent, LengthDrawEvent, ManifoldWalkEvent, MutationEvent, Recorder, ReuseEvent, RREvent, ShadowRayEvent, WalkRole } from './recorder';
import type { ManifoldWalkOutcome } from '../core/manifold/newton';

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

export interface ReuseRecord {
  x: number;
  y: number;
  pass: number;
  lightP: Tuple3 | null;
  source: 'none' | 'fresh' | 'temporal' | 'spatial';
  from: readonly [number, number] | null;
}

export interface ManifoldWalkRecord {
  depth: number;
  casterName: string;
  lightP: Tuple3;
  seed: Tuple3;
  iterates: readonly { chain: readonly Tuple3[]; cNorm: number }[];
  outcome: ManifoldWalkOutcome;
  solution: Tuple3 | null;
  trials: number | null;
}

export interface PathRecord {
  key: { seq: readonly number[]; index: number };
  // Camera-walk vertices — the field every existing consumer reads; BDPT's
  // light walk lands in lightVertices so the two subpaths stay
  // distinguishable after the lossy flatten.
  vertices: VertexRecord[];
  lightVertices: VertexRecord[];
  rr: RREvent[];
  // Single-term PT (pt-term): the up-front lifetime draw. Null elsewhere.
  lengthDraw: LengthDrawEvent | null;
  shadowRays: ShadowRayRecord[];
  connections: ConnectionRecord[];
  // ReSTIR (V4): reservoir lineage events for this pixel/pass.
  reuses: ReuseRecord[];
  // SMS (V5): every manifold walk attempted for this path, iterates and all.
  manifoldWalks: ManifoldWalkRecord[];
  contributions: ContributionRecord[];
  // MLT (V3): one record per mutation — the walks/connection above are the
  // PROPOSAL's; this is the Metropolis decision about it. Null outside MLT.
  mutation: MutationEvent | null;
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
      lengthDraw: null,
      shadowRays: [],
      connections: [],
      reuses: [],
      manifoldWalks: [],
      contributions: [],
      mutation: null,
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

  lengthDraw(event: LengthDrawEvent): void {
    if (this.current) this.current.lengthDraw = event;
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

  reuse(event: ReuseEvent): void {
    this.current?.reuses.push({
      x: event.x,
      y: event.y,
      pass: event.pass,
      lightP: event.lightP ? t3(event.lightP) : null,
      source: event.source,
      from: event.from,
    });
  }

  manifoldWalk(event: ManifoldWalkEvent): void {
    this.current?.manifoldWalks.push({
      depth: event.depth,
      casterName: event.casterName,
      lightP: t3(event.lightP),
      seed: t3(event.seed),
      iterates: event.iterates.map((it) => ({ chain: it.chain.map(t3), cNorm: it.cNorm })),
      outcome: event.outcome,
      solution: event.solution ? t3(event.solution) : null,
      trials: event.trials,
    });
  }

  mutation(event: MutationEvent): void {
    if (this.current) this.current.mutation = event;
  }

  contribution(c: Contribution): void {
    this.current?.contributions.push({ kind: c.kind, raster: c.raster, value: c3(c.value) });
  }

  endPath(): void {
    if (this.current) this.records.push(this.current);
    this.current = null;
  }
}

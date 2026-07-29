// Turns a PathRecord into a timed schedule: when each segment grows, when
// each vertex's "moment" plays (sampled-direction arrow, shadow ray,
// RR coin), when the emission flash or escape fade happens. Pure data in,
// pure data out — the three.js elements just evaluate it at time t, which
// is what makes scrubbing and frame-stepping trivially correct.
import type { PathRecord, ShadowRayRecord, Tuple3, VertexRecord } from '../trace/records';
import type { WalkRole } from '../trace/recorder';

export interface ScheduleConfig {
  speed: number; // world units per second of segment growth
  momentSeconds: number; // pause at each scattering vertex
  startTime: number;
  escapeLength: number; // drawn length for rays that left the scene
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  speed: 4,
  momentSeconds: 1.2,
  startTime: 0,
  escapeLength: 3,
};

export interface SegmentTiming {
  from: Tuple3;
  to: Tuple3;
  start: number;
  end: number;
  // Luminance of the throughput ARRIVING along this segment (beta of the
  // destination vertex) — drives brightness/width per the design language.
  betaLuminance: number;
}

export interface VertexMoment {
  vertexIndex: number;
  p: Tuple3;
  ns: Tuple3;
  start: number; // arrival of the path at this vertex
  end: number; // start + momentSeconds
  wiSampled: Tuple3 | null;
  delta: boolean;
  shadowRay: ShadowRayRecord | null;
  rrDeath: boolean; // path dies here by Russian roulette
}

export interface PathSchedule {
  duration: number;
  segments: SegmentTiming[];
  moments: VertexMoment[];
  // Emission flash at the final vertex, if the path ended on an emitter.
  emission: { p: Tuple3; time: number } | null;
  // Fading stub for rays that escaped the scene.
  escape: { from: Tuple3; direction: Tuple3; start: number; length: number } | null;
}

const dist = (a: Tuple3, b: Tuple3) =>
  Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

const luminance = (c: Tuple3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// Which vertex list of the record to schedule. BDPT paths carry two walks;
// the default is the camera walk, exactly as before.
export interface WalkSelection {
  vertices: readonly VertexRecord[];
  role: WalkRole;
}

export function buildSchedule(
  record: PathRecord,
  emissiveNames: ReadonlySet<string>,
  cfg: ScheduleConfig = DEFAULT_SCHEDULE,
  walk: WalkSelection = { vertices: record.vertices, role: 'camera' },
): PathSchedule {
  const vs = walk.vertices;
  const segments: SegmentTiming[] = [];
  const moments: VertexMoment[] = [];
  let t = cfg.startTime;

  // RR events are attributed per walk; records predating the role tag are
  // camera walks.
  const rrDeathDepth =
    record.rr.find((e) => !e.survived && (e.role ?? 'camera') === walk.role)?.depth ?? null;

  for (let k = 0; k < vs.length; k++) {
    const v = vs[k]!;

    if (k > 0) {
      // Segment (k-1) -> k grows before vertex k's moment plays.
      const from = vs[k - 1]!.p;
      const growSeconds = dist(from, v.p) / cfg.speed;
      segments.push({
        from,
        to: v.p,
        start: t,
        end: t + growSeconds,
        betaLuminance: luminance(v.beta),
      });
      t += growSeconds;

      moments.push({
        vertexIndex: k,
        p: v.p,
        ns: v.ns,
        start: t,
        end: t + cfg.momentSeconds,
        wiSampled: v.wiSampled,
        delta: v.delta,
        shadowRay: record.shadowRays.find((sr) => sr.depth === k) ?? null,
        rrDeath: rrDeathDepth === k,
      });
      t += cfg.momentSeconds;
    }
  }

  const last = vs[vs.length - 1];
  const endedOnEmitter = last != null && last.primitiveName != null && emissiveNames.has(last.primitiveName);
  const emission = endedOnEmitter ? { p: last.p, time: t } : null;

  // Escape: the walk sampled a direction at the last vertex but no further
  // vertex exists, the path didn't die by RR there, and it isn't an
  // emission ending we chose to stop on.
  let escape: PathSchedule['escape'] = null;
  if (
    last != null &&
    last.wiSampled != null &&
    rrDeathDepth !== vs.length - 1 &&
    !endedOnEmitter
  ) {
    escape = {
      from: last.p,
      direction: last.wiSampled,
      start: t,
      length: cfg.escapeLength,
    };
    t += cfg.escapeLength / cfg.speed;
  }

  if (emission) t += 0.8; // room for the flash envelope

  return { duration: t, segments, moments, emission, escape };
}

// How much of a segment is revealed at time t, in [0, 1].
export function segmentProgress(seg: SegmentTiming, t: number): number {
  if (t <= seg.start) return 0;
  if (t >= seg.end) return 1;
  return (t - seg.start) / (seg.end - seg.start);
}

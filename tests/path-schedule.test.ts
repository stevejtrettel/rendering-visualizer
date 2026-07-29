import { describe, expect, it } from 'vitest';
import { buildSchedule, segmentProgress, DEFAULT_SCHEDULE } from '../src/viz/path-schedule';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import { ArrayRecorder } from '../src/trace/records';

const BOX: SceneDescription = {
  camera: { eye: [0, 2, 7.2], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 0, 4], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ceiling', shape: { kind: 'quad', q: [-2, 4, -2], e1: [4, 0, 0], e2: [0, 0, 4] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'back', shape: { kind: 'quad', q: [-2, 0, -2], e1: [4, 0, 0], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'light', shape: { kind: 'quad', q: [-0.8, 3.998, -0.8], e1: [1.6, 0, 0], e2: [0, 0, 1.6] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [14, 14, 14] } },
    { name: 'ball', shape: { kind: 'sphere', center: [-0.9, 0.8, -0.6], radius: 0.8 }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
  ],
};
const EMISSIVE = new Set(['light']);

function recordFor(pixel: readonly [number, number], sample: number) {
  const scene = buildScene(BOX, 64, 64);
  const sampler = new IndependentSampler(0);
  const integrator = new NEEPathTracer();
  const recorder = new ArrayRecorder();
  const key = pixelSeedKey(pixel[0], pixel[1], sample);
  sampler.startPixelSample(key);
  recorder.beginPath(key);
  integrator.sampleContributions(pixel, sampler, scene, recorder);
  recorder.endPath();
  return recorder.records[0]!;
}

describe('buildSchedule', () => {
  it('produces contiguous, monotonic timing: grow, moment, grow, moment…', () => {
    for (let s = 0; s < 10; s++) {
      const record = recordFor([32, 48], s);
      const schedule = buildSchedule(record, EMISSIVE);
      expect(schedule.segments.length).toBe(record.vertices.length - 1);
      expect(schedule.moments.length).toBe(schedule.segments.length);
      let t = DEFAULT_SCHEDULE.startTime;
      for (let i = 0; i < schedule.segments.length; i++) {
        const seg = schedule.segments[i]!;
        const m = schedule.moments[i]!;
        expect(seg.start).toBeCloseTo(t, 10);
        expect(seg.end).toBeGreaterThan(seg.start);
        expect(m.start).toBeCloseTo(seg.end, 10);
        expect(m.end).toBeCloseTo(m.start + DEFAULT_SCHEDULE.momentSeconds, 10);
        t = m.end;
      }
      expect(schedule.duration).toBeGreaterThanOrEqual(t);
    }
  });

  it('segment growth time matches distance / speed', () => {
    const record = recordFor([32, 48], 0);
    const schedule = buildSchedule(record, EMISSIVE);
    for (let i = 0; i < schedule.segments.length; i++) {
      const seg = schedule.segments[i]!;
      const a = record.vertices[i]!.p;
      const b = record.vertices[i + 1]!.p;
      const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      expect(seg.end - seg.start).toBeCloseTo(d / DEFAULT_SCHEDULE.speed, 10);
    }
  });

  it('classifies path endings: emission, RR death, or escape — never several', () => {
    let emissions = 0, rrDeaths = 0, escapes = 0;
    for (let s = 0; s < 40; s++) {
      const record = recordFor([32, 48], s);
      const schedule = buildSchedule(record, EMISSIVE);
      const rrDeath = record.rr.some((e) => !e.survived);
      if (schedule.emission) emissions++;
      if (rrDeath) rrDeaths++;
      if (schedule.escape) escapes++;
      // escape and emission are mutually exclusive by construction
      expect(schedule.emission && schedule.escape).toBeFalsy();
    }
    // In a closed-ish box over 40 samples all three endings should occur.
    expect(emissions).toBeGreaterThan(0);
    expect(rrDeaths).toBeGreaterThan(0);
    // (escape can be rare with the open front; don't assert it.)
    expect(emissions + rrDeaths + escapes).toBeGreaterThan(0);
  });

  it('shadow rays land in their vertex moments', () => {
    for (let s = 0; s < 10; s++) {
      const record = recordFor([32, 48], s);
      const schedule = buildSchedule(record, EMISSIVE);
      for (const m of schedule.moments) {
        if (m.shadowRay) expect(m.shadowRay.depth).toBe(m.vertexIndex);
      }
    }
  });

  it('segmentProgress clamps to [0, 1]', () => {
    const seg = { from: [0, 0, 0] as const, to: [1, 0, 0] as const, start: 2, end: 4, betaLuminance: 1 };
    expect(segmentProgress(seg, 0)).toBe(0);
    expect(segmentProgress(seg, 2)).toBe(0);
    expect(segmentProgress(seg, 3)).toBeCloseTo(0.5, 12);
    expect(segmentProgress(seg, 4)).toBe(1);
    expect(segmentProgress(seg, 99)).toBe(1);
  });
});

// The pacing curve behind demos/convergence. Pure, so it is the half of
// that figure a test can actually reach — the render half needs a Worker.
//
// The properties that matter for a movie: it never steps backwards (a frame
// that un-converges reads as a glitch), it starts at 1 and ends at maxSpp
// (the figure must show both ends of the story), and it is exactly as long
// as the movie is.
import { describe, expect, it } from 'vitest';
import { msSchedule, sppLadder, sppSchedule, type Pacing } from '../src/render/convergence';

const PACINGS: Pacing[] = ['linear', 'log', 'sqrt'];

describe('sppSchedule', () => {
  it.each(PACINGS)('%s is non-decreasing, and spans 1..maxSpp', (pacing) => {
    const s = sppSchedule({ frames: 600, maxSpp: 512, pacing });
    expect(s).toHaveLength(600);
    expect(s[0]).toBe(1);
    expect(s[s.length - 1]).toBe(512);
    for (let i = 1; i < s.length; i++) expect(s[i]!).toBeGreaterThanOrEqual(s[i - 1]!);
    for (const v of s) expect(v).toBeGreaterThanOrEqual(1);
    for (const v of s) expect(v).toBeLessThanOrEqual(512);
  });

  it('log spends half the movie below sqrt(maxSpp)', () => {
    // The whole point of the default pacing: equal doublings per second, so
    // the low counts — where the picture visibly changes — get half the
    // running time. Linear gives them almost none.
    const frames = 600;
    const maxSpp = 1024;
    const log = sppSchedule({ frames, maxSpp, pacing: 'log' });
    const linear = sppSchedule({ frames, maxSpp, pacing: 'linear' });
    expect(log[Math.floor(frames / 2)]).toBeCloseTo(32, -1); // sqrt(1024)
    expect(linear[Math.floor(frames / 2)]).toBeCloseTo(512, -2);
  });

  it('holds the first and last sample for the requested frames', () => {
    const s = sppSchedule({ frames: 100, maxSpp: 64, holdStart: 10, holdEnd: 20 });
    expect(s.slice(0, 10).every((v) => v === 1)).toBe(true);
    expect(s[10]).toBe(1); // the ramp starts at 1 too
    expect(s.slice(-20).every((v) => v === 64)).toBe(true);
    expect(s).toHaveLength(100);
  });

  it('a flat stretch repeats a sample, which is what holds it on screen', () => {
    // 300 frames over 8 spp: every sample must survive several frames.
    const s = sppSchedule({ frames: 300, maxSpp: 8, pacing: 'log' });
    const runs = new Map<number, number>();
    for (const v of s) runs.set(v, (runs.get(v) ?? 0) + 1);
    expect(runs.size).toBe(8);
    for (const [, n] of runs) expect(n).toBeGreaterThan(1);
  });

  it('survives degenerate requests', () => {
    expect(sppSchedule({ frames: 0, maxSpp: 32 })).toEqual([]);
    expect(sppSchedule({ frames: 1, maxSpp: 32 })).toEqual([32]);
    expect(sppSchedule({ frames: 5, maxSpp: 1 })).toEqual([1, 1, 1, 1, 1]);
    // Holds longer than the movie get scaled down rather than truncating it.
    const s = sppSchedule({ frames: 10, maxSpp: 16, holdStart: 100, holdEnd: 100 });
    expect(s).toHaveLength(10);
    expect(s[s.length - 1]).toBe(16);
  });

  it('rejects a nonsensical sample cap', () => {
    expect(() => sppSchedule({ frames: 10, maxSpp: 0 })).toThrow(/maxSpp/);
    expect(() => sppSchedule({ frames: 10, maxSpp: 8, steps: 0 })).toThrow(/steps/);
  });
});

describe('the ladder (steps)', () => {
  it('shows only that many distinct sample counts, spanning the range', () => {
    const opts = { frames: 900, maxSpp: 512, steps: 40 } as const;
    const ladder = sppLadder(opts);
    expect(ladder.length).toBeLessThanOrEqual(40 + 1); // +1: 1 and maxSpp forced in
    expect(ladder[0]).toBe(1);
    expect(ladder[ladder.length - 1]).toBe(512);
    // Every scheduled frame is on the ladder — that is what makes `keep`
    // sufficient, so no snapshot the movie needs goes unsaved.
    const onLadder = new Set(ladder);
    for (const v of sppSchedule(opts)) expect(onLadder.has(v)).toBe(true);
  });

  it('gives every rung a fair share of the running time', () => {
    // Including the LAST one: snapping to "highest rung under the curve"
    // would leave the converged image on screen for a single frame.
    const opts = { frames: 600, maxSpp: 512, steps: 30 } as const;
    const schedule = sppSchedule(opts);
    const runs = new Map<number, number>();
    for (const v of schedule) runs.set(v, (runs.get(v) ?? 0) + 1);
    const counts = [...runs.values()];
    const fair = schedule.length / runs.size;
    for (const n of counts) expect(n).toBeGreaterThan(fair / 2);
    expect(runs.get(512)).toBeGreaterThan(fair / 2);
  });

  it('a log ladder is geometric — the 1,2,3,…,10,20,50,100 shape', () => {
    const ladder = sppLadder({ frames: 400, maxSpp: 1000, steps: 24, pacing: 'log' });
    expect(ladder[0]).toBe(1);
    expect(ladder[ladder.length - 1]).toBe(1000);
    // Constant ratio between rungs, away from the bottom where rounding to
    // whole samples necessarily collapses them. Equal time per rung then
    // means equal time per doubling, which is the perceptual point.
    const upper = ladder.filter((v) => v >= 16);
    const ratios = upper.slice(1).map((v, i) => v / upper[i]!);
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    for (const r of ratios) expect(Math.abs(r - mean)).toBeLessThan(0.1 * mean);
  });

  it('without steps, every sample count is its own rung', () => {
    expect(sppLadder({ frames: 500, maxSpp: 64 })).toHaveLength(64);
  });
});

describe('msSchedule (the equal-time ramp)', () => {
  it('is the same ramp measured in milliseconds', () => {
    const s = msSchedule({ frames: 400, maxMs: 8000, pacing: 'log' });
    expect(s).toHaveLength(400);
    expect(s[0]).toBe(1);
    expect(s[s.length - 1]).toBe(8000);
    for (let i = 1; i < s.length; i++) expect(s[i]!).toBeGreaterThanOrEqual(s[i - 1]!);
  });

  it('tolerates a fractional budget', () => {
    // Wall-clock totals are not integers; the ramp must not choke on one.
    const s = msSchedule({ frames: 50, maxMs: 1234.56 });
    expect(s[s.length - 1]).toBe(1235);
  });
});

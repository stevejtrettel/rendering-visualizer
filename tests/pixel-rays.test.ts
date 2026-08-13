// Regression test for "we only see the first bit of each ray".
//
// PixelRays used to take an absolute speed in world units per second. That
// is a number nobody can pick correctly: a Cornell camera ray travels ~11
// units before its FIRST bounce, so a rate tuned on a small scene draws a
// stub and silently stops. The rate is now fitted from the traced geometry,
// and these tests pin the property that matters — by the end of the draw
// window, whole paths are on screen.
import { describe, expect, it } from 'vitest';
import { PixelRays } from '../src/viz/pixel-rays';
import type { TracedPath } from '../src/trace/pixel-grid';

// A path of `segments` hops, each `len` long, marching along +x.
const straight = (segments: number, len: number): TracedPath => ({
  points: Array.from({ length: segments + 1 }, (_, i) => [i * len, 0, 0] as const),
  beta: 1,
  lit: true,
  litAt: null,
});

// One long path (a big room) beside a short one, which is exactly the case
// a single absolute speed cannot serve.
const paths = (): TracedPath[][] => [[straight(4, 3), straight(2, 0.5)]];

const SAMPLE_PERIOD = 1;
const DRAW_FRACTION = 0.6;

const make = (over: Partial<ConstructorParameters<typeof PixelRays>[0]> = {}) =>
  new PixelRays({
    paths: paths(),
    samplePeriod: SAMPLE_PERIOD,
    launch: 'together',
    sweepSeconds: 0,
    drawFraction: DRAW_FRACTION,
    fadeFraction: 0,
    ...over,
  });

/** Segments currently on screen. */
const drawn = (rays: PixelRays, t: number): number => {
  rays.drawAt(t);
  return rays.drawnSegments;
};

describe('PixelRays growth', () => {
  it('measures the longest path and fits a rate to it', () => {
    const rays = make();
    expect(rays.maxPathLength).toBeCloseTo(12, 6); // 4 hops x 3
    // Fast enough to finish 12 units within 0.6 of a 1 s period.
    expect(rays.speed).toBeCloseTo(12 / (DRAW_FRACTION * SAMPLE_PERIOD), 6);
  });

  it('draws every segment of every path by the end of the draw window', () => {
    const rays = make();
    // 4 + 2 segments across the two pixels.
    expect(drawn(rays, DRAW_FRACTION * SAMPLE_PERIOD)).toBe(6);
  });

  it('gets past the first bounce well before then — the actual bug', () => {
    const rays = make();
    // A quarter of the way through the window, the long path is 3 units in:
    // its first hop is complete and the second has started.
    expect(drawn(rays, 0.25 * DRAW_FRACTION * SAMPLE_PERIOD)).toBeGreaterThan(2);
  });

  it('grows monotonically, and starts from nothing', () => {
    const rays = make();
    expect(drawn(rays, 0)).toBe(0);
    let previous = 0;
    for (let i = 1; i <= 12; i++) {
      const n = drawn(rays, (i / 12) * DRAW_FRACTION * SAMPLE_PERIOD);
      expect(n).toBeGreaterThanOrEqual(previous);
      previous = n;
    }
    expect(previous).toBe(6);
  });

  it('a sweep still lets the LAST pixel finish inside the window', () => {
    const sweepSeconds = 0.3;
    const rays = make({ launch: 'sweep', sweepSeconds });
    // The second (last) pixel launches at sweepSeconds/2 here, but the rate
    // is fitted against the worst case, so the window still covers it.
    expect(drawn(rays, DRAW_FRACTION * SAMPLE_PERIOD)).toBe(6);
  });

  it('scales to a scene an order of magnitude larger', () => {
    // The failure mode was scene-dependent, so pin that it is not any more.
    const big: TracedPath[][] = [[straight(4, 300)]];
    const rays = new PixelRays({
      paths: big,
      samplePeriod: SAMPLE_PERIOD,
      launch: 'together',
      sweepSeconds: 0,
      drawFraction: DRAW_FRACTION,
      fadeFraction: 0,
    });
    expect(drawn(rays, DRAW_FRACTION * SAMPLE_PERIOD)).toBe(4);
  });

  it('honours an explicit speed override', () => {
    const rays = make({ speed: 1 });
    expect(rays.speed).toBe(1);
  });
});

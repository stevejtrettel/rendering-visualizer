import { describe, expect, it } from 'vitest';
import { MLTSampler } from '../src/core/sampler/mlt';
import { chainSeedKey } from '../src/core/sampler/sampler';
import { erfInv, type Sample2D } from '../src/core/math/sampling';
import { PCG32 } from '../src/core/math/pcg32';
import { hashInts } from '../src/core/math/hash';
import { U64_ZERO, fromNumber } from '../src/core/math/u64';

// Distance on the unit torus — small-step mutations wrap, so all
// "nearness" assertions must too.
const torus = (a: number, b: number): number => {
  const d = Math.abs(a - b);
  return Math.min(d, 1 - d);
};

describe('erfInv', () => {
  it('matches table values (Gaussian warp for small steps)', () => {
    expect(erfInv(0)).toBeCloseTo(0, 6);
    expect(erfInv(0.5)).toBeCloseTo(0.4769362762, 3);
    expect(erfInv(-0.5)).toBeCloseTo(-0.4769362762, 3);
    expect(erfInv(0.9)).toBeCloseTo(1.1630871537, 3);
    expect(erfInv(-0.9)).toBeCloseTo(-1.1630871537, 3);
  });
});

describe('MLTSampler', () => {
  it('is a pure function of key and history (replay = re-run)', () => {
    const script = (s: MLTSampler): number[] => {
      const out: number[] = [];
      s.startPixelSample(chainSeedKey(42));
      s.startStream(0);
      for (let i = 0; i < 4; i++) out.push(s.next1D());
      for (let iter = 0; iter < 10; iter++) {
        s.startIteration();
        s.startStream(0);
        for (let i = 0; i < 4; i++) out.push(s.next1D());
        if (iter % 3 === 0) s.reject();
        else s.accept();
      }
      return out;
    };
    const a = script(new MLTSampler(9));
    const b = script(new MLTSampler(9));
    expect(a).toEqual(b);
    // Re-seeding the SAME instance must fully reset chain state.
    const s = new MLTSampler(9);
    const first = script(s);
    const again = script(s);
    expect(again).toEqual(first);
  });

  it('distinct chain keys give distinct streams', () => {
    const first = (k: number): number => {
      const s = new MLTSampler(0);
      s.startPixelSample(chainSeedKey(k));
      s.startStream(0);
      return s.next1D();
    };
    const values = [first(0), first(1), first(2), first(3)];
    expect(new Set(values).size).toBe(values.length);
  });

  it('stays strictly in [0, 1) through mixed histories', () => {
    const s = new MLTSampler(3, { largeStepProbability: 0.5 });
    s.startPixelSample(chainSeedKey(0));
    s.startStream(0);
    for (let i = 0; i < 8; i++) {
      const v = s.next1D();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    for (let iter = 0; iter < 2000; iter++) {
      s.startIteration();
      s.startStream(0);
      for (let i = 0; i < 8; i++) {
        const v = s.next1D();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
      if (iter % 4 === 0) s.reject();
      else s.accept();
    }
  });

  it('single small step: symmetric, sd = sigma', () => {
    const sigma = 0.01;
    const diffs: number[] = [];
    for (let k = 0; k < 2000; k++) {
      const s = new MLTSampler(1, { largeStepProbability: 0, sigma });
      s.startPixelSample(chainSeedKey(k));
      s.startStream(0);
      const v0 = s.next1D();
      s.startIteration();
      s.startStream(0);
      const v1 = s.next1D();
      // Signed wrapped difference in (-1/2, 1/2].
      let d = v1 - v0;
      if (d > 0.5) d -= 1;
      if (d <= -0.5) d += 1;
      diffs.push(d);
    }
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const sd = Math.sqrt(diffs.reduce((a, b) => a + b * b, 0) / diffs.length - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.001);
    expect(sd).toBeGreaterThan(0.009);
    expect(sd).toBeLessThan(0.011);
  });

  it('accumulates pending small steps as sigma * sqrt(n)', () => {
    // Dim 0 is read at init, left untouched for 16 small-step iterations,
    // then read: the lazy catch-up must apply ONE Gaussian of sigma*sqrt(16).
    const sigma = 0.01;
    const n = 16;
    const diffs: number[] = [];
    for (let k = 0; k < 2000; k++) {
      const s = new MLTSampler(2, { largeStepProbability: 0, sigma });
      s.startPixelSample(chainSeedKey(k));
      s.startStream(0);
      const v0 = s.next1D();
      for (let i = 0; i < n - 1; i++) {
        s.startIteration();
        s.accept();
      }
      s.startIteration();
      s.startStream(0);
      let d = s.next1D() - v0;
      if (d > 0.5) d -= 1;
      if (d <= -0.5) d += 1;
      diffs.push(d);
    }
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const sd = Math.sqrt(diffs.reduce((a, b) => a + b * b, 0) / diffs.length - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.004);
    expect(sd).toBeGreaterThan(sigma * Math.sqrt(n) * 0.88);
    expect(sd).toBeLessThan(sigma * Math.sqrt(n) * 1.12);
  });

  it('CLASSIC BUG 1: a dim untouched across an accepted large step comes back fresh', () => {
    // Buggy samplers keep the stale value and small-step it (distance ~sigma);
    // correct ones reset to a fresh uniform (mean torus distance 0.25).
    const distances: number[] = [];
    for (let k = 0; k < 400; k++) {
      const s = new MLTSampler(4, { largeStepProbability: 0.5 });
      s.startPixelSample(chainSeedKey(k));
      s.startStream(0);
      s.next1D();
      const v1 = s.next1D(); // dim 1 materialized at the initial state
      // Iterate reading ONLY dim 0, accepting everything, until a large
      // step has been accepted...
      let sawLarge = false;
      let fresh: number | null = null;
      for (let i = 0; i < 200 && fresh === null; i++) {
        s.startIteration();
        s.startStream(0);
        s.next1D();
        if (sawLarge && !s.isLargeStep) {
          // ...then, on a later SMALL step (a large step would draw fresh
          // regardless), read dim 1 again.
          fresh = s.next1D();
        }
        s.accept();
        if (s.isLargeStep) sawLarge = true;
      }
      expect(fresh).not.toBeNull();
      distances.push(torus(fresh!, v1));
    }
    const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
    expect(mean).toBeGreaterThan(0.15); // uniform gives 0.25; the bug gives ~0.04
  });

  it('CLASSIC BUG 2: reject restores touched values and decrements the iteration', () => {
    const s = new MLTSampler(7, { largeStepProbability: 0 });
    s.startPixelSample(chainSeedKey(3));
    s.startStream(0);
    const v0 = s.next1D();
    expect(s.iteration).toBe(0);

    s.startIteration();
    expect(s.iteration).toBe(1);
    s.startStream(0);
    const proposal = s.next1D();
    expect(proposal).not.toBe(v0);
    expect(s.primaryValues()[0]).toBe(proposal);

    s.reject();
    expect(s.iteration).toBe(0); // the proposal never happened
    expect(s.primaryValues()[0]).toBe(v0); // exact restore, not re-derivation

    // The next iteration must behave as the first again: one pending small
    // step from v0, not two.
    s.startIteration();
    expect(s.iteration).toBe(1);
    s.startStream(0);
    const second = s.next1D();
    expect(torus(second, v0)).toBeLessThan(0.06); // ~6 sigma for n = 1
  });

  it('streams are isolated: growing one stream never re-maps another', () => {
    // A flat global dimension counter would hand stream 1 fresh slots when
    // stream 0 consumes more — an accidental global mutation. With
    // interleaved slots, stream 1's coordinates stay within small-step
    // distance of their initial values whatever stream 0 does.
    const run = (extraStream0: number) => {
      const s = new MLTSampler(11, { largeStepProbability: 0 });
      s.startPixelSample(chainSeedKey(5));
      s.startStream(0);
      const c0 = [s.next1D(), s.next1D(), s.next1D()];
      s.startStream(1);
      const l0 = [s.next1D(), s.next1D()];
      s.startIteration();
      s.startStream(0);
      for (let i = 0; i < 3 + extraStream0; i++) s.next1D();
      s.startStream(1);
      const l1 = [s.next1D(), s.next1D()];
      s.accept();
      return { c0, l0, l1 };
    };
    const short = run(0);
    const long = run(3);
    expect(long.c0).toEqual(short.c0); // identical init state
    expect(long.l0).toEqual(short.l0);
    for (let i = 0; i < 2; i++) {
      expect(torus(short.l1[i]!, short.l0[i]!)).toBeLessThan(0.06);
      expect(torus(long.l1[i]!, long.l0[i]!)).toBeLessThan(0.06);
    }
  });

  it('a dim first read mid-chain materializes uniform, not near zero', () => {
    // Deliberate divergence from pbrt's zero-initialized PrimarySample
    // (see pbrt-notes §MLT): the eager-equivalent marginal of a coordinate
    // first read mid-chain is a fresh uniform — it was conceptually drawn
    // at the last large step, and uniform convolved with wrapped Gaussians
    // stays uniform. largeStepProbability = 0 keeps the quirk window open
    // forever, isolating the materialization path.
    const distances: number[] = [];
    for (let k = 0; k < 400; k++) {
      const s = new MLTSampler(17, { largeStepProbability: 0 });
      s.startPixelSample(chainSeedKey(k));
      s.startStream(0);
      s.next1D(); // only dim 0 exists in the initial state
      for (let i = 0; i < 4; i++) {
        s.startIteration();
        s.startStream(0);
        s.next1D();
        s.accept();
      }
      s.startIteration();
      s.startStream(0);
      s.next1D();
      const v = s.next1D(); // first-ever read of this slot, 5 iterations in
      distances.push(torus(v, 0));
    }
    const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
    // Uniform gives mean torus distance from 0 of 0.25; pbrt's zero-init
    // gives |N(0, sigma*sqrt(5))| ~ 0.02.
    expect(mean).toBeGreaterThan(0.15);
  });

  it('kernel end-to-end: chain visits match an analytic target', () => {
    // The full seek/find/mutate loop on a synthetic target over [0,1)^2 —
    // no rendering. Target I(u, v) = f(u) f(v), f(x) = (1 + x) / 1.5
    // (normalized). Validates the acceptance rule, proposal symmetry (an
    // asymmetric small step would skew the stationary distribution), the
    // large-step ergodicity, and the lazy machinery under real accept/
    // reject traffic. Expected-value deposits (a to the proposal, 1-a to
    // the current state) mirror the future driver's both-states splatting.
    const f = (x: number): number => (1 + x) / 1.5;
    const F = (x: number): number => (x + (x * x) / 2) / 1.5; // CDF per axis
    const I = (p: Sample2D): number => f(p[0]) * f(p[1]);

    const NB = 8; // bins per axis
    const mass = (bx: number, by: number): number =>
      (F((bx + 1) / NB) - F(bx / NB)) * (F((by + 1) / NB) - F(by / NB));
    const binOf = (p: Sample2D): number =>
      Math.min(NB - 1, Math.floor(p[1] * NB)) * NB + Math.min(NB - 1, Math.floor(p[0] * NB));

    // Seek: a bootstrap census of chain seeds.
    const sampler = new MLTSampler(13);
    const nBootstrap = 1024;
    const weights: number[] = [];
    for (let i = 0; i < nBootstrap; i++) {
      sampler.startPixelSample(chainSeedKey(i));
      sampler.startStream(0);
      weights.push(I([sampler.next1D(), sampler.next1D()]));
    }
    // Find: one seed drawn proportionally to weight (fixed pick point);
    // the chain starts in equilibrium.
    const total = weights.reduce((a, b) => a + b, 0);
    let pick = 0.37 * total;
    let chosen = 0;
    while (pick > weights[chosen]! && chosen < nBootstrap - 1) pick -= weights[chosen++]!;
    sampler.startPixelSample(chainSeedKey(chosen));
    sampler.startStream(0);
    let cur: Sample2D = [sampler.next1D(), sampler.next1D()];
    let Icur = I(cur);

    // Mutate: accept/reject draws come from a DRIVER-side RNG, never from
    // the primary samples (they are not part of the Markov state).
    const accRng = new PCG32(U64_ZERO, U64_ZERO);
    accRng.setSequence(hashInts([999, 13]), fromNumber(0));
    const M = 300000;
    const hist = new Float64Array(NB * NB);
    for (let m = 0; m < M; m++) {
      sampler.startIteration();
      sampler.startStream(0);
      const prop: Sample2D = [sampler.next1D(), sampler.next1D()];
      const Iprop = I(prop);
      const a = Math.min(1, Iprop / Icur);
      hist[binOf(prop)]! += a;
      hist[binOf(cur)]! += 1 - a;
      if (accRng.nextFloat() < a) {
        sampler.accept();
        cur = prop;
        Icur = Iprop;
      } else {
        sampler.reject();
      }
    }

    // Moments are tight; per-bin errors are looser (chain samples are
    // correlated — itself a talk point) but still catch any systematic bias.
    let meanU = 0;
    let tv = 0;
    for (let by = 0; by < NB; by++) {
      for (let bx = 0; bx < NB; bx++) {
        const p = hist[by * NB + bx]! / M;
        meanU += p * ((bx + 0.5) / NB);
        const expected = mass(bx, by);
        tv += 0.5 * Math.abs(p - expected);
        expect(Math.abs(p - expected) / expected).toBeLessThan(0.15);
      }
    }
    expect(tv).toBeLessThan(0.02);
    // E[u] under f = integral of x (1+x)/1.5 = 5/9 (binned midpoints shift
    // this by < 1e-3).
    expect(meanU).toBeCloseTo(5 / 9, 2);
  });
});

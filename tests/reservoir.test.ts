import { describe, expect, it } from 'vitest';
import { Reservoir } from '../src/core/restir/reservoir';
import { balanceMisWeight, misWeightSum, pairwiseMisWeight } from '../src/core/restir/mis';
import { PCG32 } from '../src/core/math/pcg32';
import { hashInts } from '../src/core/math/hash';
import { U64_ZERO, fromNumber } from '../src/core/math/u64';

const rng = (seed: number): PCG32 => {
  const r = new PCG32(U64_ZERO, U64_ZERO);
  r.setSequence(hashInts([0x52535652, seed]), fromNumber(0));
  return r;
};

// Discrete test integrand over the domain {0..9}: integral = plain sum.
// f(x) = (x+1)(10-x), Σf = 220; target function p̂(x) = x+1 (Σp̂ = 55).
const f = (x: number): number => (x + 1) * (10 - x);
const pHat = (x: number): number => x + 1;
const SUM_F = 220;

describe('Reservoir (weighted reservoir sampling)', () => {
  it('selects candidates with probability proportional to weight', () => {
    // Fixed weight stream [1..5]: P(select i) = w_i / 15 exactly.
    const weights = [1, 2, 3, 4, 5];
    const N = 30000;
    const counts = new Array(weights.length).fill(0);
    const r = rng(1);
    for (let trial = 0; trial < N; trial++) {
      const res = new Reservoir<number>();
      weights.forEach((w, i) => res.update(i, w, 1, r.nextFloat()));
      counts[res.y!] += 1;
    }
    const total = weights.reduce((a, b) => a + b, 0);
    let chi2 = 0;
    weights.forEach((w, i) => {
      const expected = (N * w) / total;
      chi2 += (counts[i]! - expected) ** 2 / expected;
    });
    expect(chi2).toBeLessThan(20); // 4 dof; p < 0.0005 would exceed this
  });

  it('RIS with 1/M weights is unbiased: E[f(Y) W_Y] = sum of f', () => {
    const M = 8;
    const N = 50000;
    const r = rng(2);
    let mean = 0;
    for (let trial = 0; trial < N; trial++) {
      const res = new Reservoir<number>();
      for (let i = 0; i < M; i++) {
        const x = Math.min(9, Math.floor(r.nextFloat() * 10)); // q uniform, p = 1/10
        const w = (1 / M) * pHat(x) * 10; // m · p̂ · W_candidate
        res.update(x, w, 1, r.nextFloat());
      }
      res.finalize(pHat(res.y!));
      mean += (f(res.y!) * res.W) / N;
    }
    expect(Math.abs(mean - SUM_F) / SUM_F).toBeLessThan(0.02);
  });

  it('pairwise MIS keeps mixed-support candidates unbiased; 1/M is measurably biased', () => {
    // Three techniques: canonical uniform over 0..9 (covers), plus uniform
    // over 0..4 and uniform over 5..9 (half supports). Known pdfs stand in
    // for the p̂ proxies — the exact-MIS case.
    const pdfs = [
      (x: number) => 1 / 10,
      (x: number) => (x <= 4 ? 1 / 5 : 0),
      (x: number) => (x >= 5 ? 1 / 5 : 0),
    ];
    const draw = (tech: number, u: number): number =>
      tech === 0 ? Math.min(9, Math.floor(u * 10))
      : tech === 1 ? Math.min(4, Math.floor(u * 5))
      : 5 + Math.min(4, Math.floor(u * 5));

    const run = (kind: 'pairwise' | 'oneOverM'): number => {
      const r = rng(kind === 'pairwise' ? 3 : 4);
      const N = 50000;
      let mean = 0;
      for (let trial = 0; trial < N; trial++) {
        const res = new Reservoir<number>();
        for (let tech = 0; tech < 3; tech++) {
          const x = draw(tech, r.nextFloat());
          const pAt = pdfs.map((p) => p(x));
          const m =
            kind === 'pairwise'
              ? pairwiseMisWeight(pAt, [1, 1, 1], 0, tech)
              : 1 / 3;
          const w = m * pHat(x) * (1 / pdfs[tech]!(x));
          res.update(x, w, 1, r.nextFloat());
        }
        res.finalize(pHat(res.y!));
        mean += (f(res.y!) * res.W) / N;
      }
      return mean;
    };

    const unbiased = run('pairwise');
    expect(Math.abs(unbiased - SUM_F) / SUM_F).toBeLessThan(0.02);

    // With 1/M, every point is covered by exactly 2 of 3 techniques, so the
    // weights sum to 2/3 pointwise: expectation (2/3)·ΣF. The negative
    // control: our machinery must SEE this bias clearly.
    const biased = run('oneOverM');
    expect(Math.abs(biased - (2 / 3) * SUM_F) / SUM_F).toBeLessThan(0.02);
    expect(Math.abs(biased - SUM_F) / SUM_F).toBeGreaterThan(0.25);
  });

  it('chained merges are equivalent to one-pass RIS (associativity)', () => {
    // 12 identically-distributed candidates: path A resamples all in one
    // pass (m = 1/12); path B builds three 4-candidate reservoirs (m = 1/4)
    // and merges them with confidence-proportional weights (4/12 each).
    // Effective per-candidate weight is 1/12 both ways — the selection
    // distribution and the estimator must agree.
    const N = 30000;
    const histA = new Array(10).fill(0);
    const histB = new Array(10).fill(0);
    let meanA = 0;
    let meanB = 0;
    const r = rng(5);
    for (let trial = 0; trial < N; trial++) {
      const xs = Array.from({ length: 12 }, () => Math.min(9, Math.floor(r.nextFloat() * 10)));

      const resA = new Reservoir<number>();
      for (const x of xs) resA.update(x, (1 / 12) * pHat(x) * 10, 1, r.nextFloat());
      resA.finalize(pHat(resA.y!));
      histA[resA.y!] += 1;
      meanA += (f(resA.y!) * resA.W) / N;

      const subs: Reservoir<number>[] = [];
      for (let g = 0; g < 3; g++) {
        const sub = new Reservoir<number>();
        for (let i = 0; i < 4; i++) {
          const x = xs[g * 4 + i]!;
          sub.update(x, (1 / 4) * pHat(x) * 10, 1, r.nextFloat());
        }
        sub.finalize(pHat(sub.y!));
        subs.push(sub);
      }
      const resB = new Reservoir<number>();
      for (const sub of subs) {
        // Identical distributions: confidence-proportional MIS (c/Σc = 4/12).
        resB.update(sub.y, (sub.confidence / 12) * pHat(sub.y!) * sub.W, sub.confidence, r.nextFloat());
      }
      resB.finalize(pHat(resB.y!));
      histB[resB.y!] += 1;
      meanB += (f(resB.y!) * resB.W) / N;
      expect(resB.confidence).toBe(12);
    }

    expect(Math.abs(meanA - SUM_F) / SUM_F).toBeLessThan(0.02);
    expect(Math.abs(meanB - SUM_F) / SUM_F).toBeLessThan(0.02);
    // Selection distributions agree bin by bin (both estimate the same
    // marginal; tolerance covers Monte Carlo noise at N = 30000).
    for (let v = 0; v < 10; v++) {
      expect(Math.abs(histA[v]! - histB[v]!) / N).toBeLessThan(0.015);
    }
  });

  it('tracks and caps confidence', () => {
    const res = new Reservoir<number>();
    const r = rng(6);
    for (let i = 0; i < 7; i++) res.update(i, 1, 1, r.nextFloat());
    expect(res.confidence).toBe(7);
    res.finalize(pHat(res.y!), 5);
    expect(res.confidence).toBe(5);
    // Null candidates still add confidence (the distribution counts).
    const res2 = new Reservoir<number>();
    res2.update(null, 0, 1, r.nextFloat());
    res2.update(null, 0, 1, r.nextFloat());
    expect(res2.y).toBeNull();
    expect(res2.confidence).toBe(2);
    res2.finalize(0);
    expect(res2.W).toBe(0);
  });
});

describe('resampling MIS weights', () => {
  it('balance and pairwise weights sum to 1 whenever the canonical covers', () => {
    const r = rng(7);
    for (let trial = 0; trial < 500; trial++) {
      const n = 2 + Math.floor(r.nextFloat() * 6);
      const pHatAt = Array.from({ length: n }, () =>
        r.nextFloat() < 0.3 ? 0 : r.nextFloat() * 5,
      );
      const canonical = Math.floor(r.nextFloat() * n);
      pHatAt[canonical] = 0.1 + r.nextFloat() * 5; // canonical covers y
      const confidences = Array.from({ length: n }, () => 1 + Math.floor(r.nextFloat() * 20));
      expect(misWeightSum('balance', pHatAt, confidences, canonical)).toBeCloseTo(1, 9);
      expect(misWeightSum('pairwise', pHatAt, confidences, canonical)).toBeCloseTo(1, 9);
    }
  });

  it('pairwise reduces to confidence-proportional lerp for identical targets', () => {
    // Course Tip 7.2: with equal p̂ everywhere and t_c = c_c/Σc,
    // m_i = (1-t_c)·c_i/Σc (i ≠ c), m_c = t_c + (1-t_c)·c_c/Σc.
    const confidences = [20, 1, 4, 7];
    const pHatAt = [2.5, 2.5, 2.5, 2.5];
    const cTotal = 32;
    const tc = 20 / cTotal;
    for (let i = 0; i < 4; i++) {
      const expected = i === 0 ? tc + (1 - tc) * (20 / cTotal) : (1 - tc) * (confidences[i]! / cTotal);
      expect(pairwiseMisWeight(pHatAt, confidences, 0, i)).toBeCloseTo(expected, 12);
    }
  });

  it('zero-target candidates get zero weight; canonical absorbs their share', () => {
    const pHatAt = [3, 0, 2];
    const confidences = [1, 1, 1];
    expect(pairwiseMisWeight(pHatAt, confidences, 0, 1)).toBe(0);
    expect(balanceMisWeight(pHatAt, confidences, 1)).toBe(0);
    expect(misWeightSum('pairwise', pHatAt, confidences, 0)).toBeCloseTo(1, 12);
  });
});

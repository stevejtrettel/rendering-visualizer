import { describe, expect, it } from 'vitest';
import { meanAt, toCumulative } from '../src/viz/image-plane';

describe('image plane accumulation', () => {
  it('running means match direct averages', () => {
    const res = 2;
    const samples = 4;
    // values[s][y][x][c] = deterministic pattern
    const raw = new Float32Array(samples * res * res * 3);
    const direct: number[][][] = [];
    for (let s = 0; s < samples; s++) {
      for (let p = 0; p < res * res; p++) {
        for (let c = 0; c < 3; c++) {
          raw[(s * res * res + p) * 3 + c] = (s + 1) * (p + 1) * (c + 1) * 0.1;
        }
      }
    }
    // Direct means for comparison, before mutating raw.
    for (let s = 0; s < samples; s++) {
      direct.push([]);
      for (let p = 0; p < res * res; p++) {
        const means: number[] = [];
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let k = 0; k <= s; k++) sum += raw[(k * res * res + p) * 3 + c]!;
          means.push(sum / (s + 1));
        }
        direct[s]!.push(means);
      }
    }

    toCumulative(raw, res, samples);
    for (let s = 0; s < samples; s++) {
      for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
          const m = meanAt(raw, res, s, x, y);
          const d = direct[s]![y * res + x]!;
          expect(m[0]).toBeCloseTo(d[0]!, 5);
          expect(m[1]).toBeCloseTo(d[1]!, 5);
          expect(m[2]).toBeCloseTo(d[2]!, 5);
        }
      }
    }
  });
});

import { describe, expect, it } from 'vitest';
import { currentSampleIndex, opacityForAge } from '../src/viz/sample-flip';

describe('sample flip timing', () => {
  it('maps time to the current sample and clamps at the ends', () => {
    expect(currentSampleIndex(0, 0.1, 100)).toBe(0);
    expect(currentSampleIndex(0.05, 0.1, 100)).toBe(0);
    expect(currentSampleIndex(0.1, 0.1, 100)).toBe(1);
    expect(currentSampleIndex(2.34, 0.1, 100)).toBe(23);
    expect(currentSampleIndex(999, 0.1, 100)).toBe(99); // holds on the last sample
    expect(currentSampleIndex(-1, 0.1, 100)).toBe(0);
    expect(currentSampleIndex(5, 0.1, 0)).toBe(-1);
  });

  it('dims monotonically with age, newest full, floored for legibility', () => {
    expect(opacityForAge(0)).toBe(1);
    let prev = 1;
    for (let age = 1; age < 500; age++) {
      const o = opacityForAge(age);
      expect(o).toBeLessThanOrEqual(prev);
      expect(o).toBeGreaterThanOrEqual(0.13);
      prev = o;
    }
  });
});

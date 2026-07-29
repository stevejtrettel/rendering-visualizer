import { describe, expect, it } from 'vitest';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';

describe('IndependentSampler', () => {
  it('is a pure function of the seed key', () => {
    const a = new IndependentSampler(123);
    const b = new IndependentSampler(123);
    a.startPixelSample(pixelSeedKey(10, 20, 3));
    b.startPixelSample(pixelSeedKey(10, 20, 3));
    for (let i = 0; i < 64; i++) expect(a.next1D()).toBe(b.next1D());
  });

  it('replays from mid-path via the dimension argument', () => {
    const key = pixelSeedKey(5, 7, 2);
    const full = new IndependentSampler(1);
    full.startPixelSample(key);
    const drawn: number[] = [];
    for (let i = 0; i < 20; i++) drawn.push(full.next1D());

    const resumed = new IndependentSampler(1);
    resumed.startPixelSample(key, 12);
    for (let i = 12; i < 20; i++) expect(resumed.next1D()).toBe(drawn[i]);
  });

  it('distinct keys give distinct streams', () => {
    const s = new IndependentSampler(0);
    const first = (key: Parameters<typeof s.startPixelSample>[0]) => {
      s.startPixelSample(key);
      return s.next1D();
    };
    const values = [
      first(pixelSeedKey(0, 0, 0)),
      first(pixelSeedKey(1, 0, 0)),
      first(pixelSeedKey(0, 1, 0)),
      first(pixelSeedKey(0, 0, 1)),
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  it('global seed changes every stream', () => {
    const a = new IndependentSampler(0);
    const b = new IndependentSampler(1);
    a.startPixelSample(pixelSeedKey(3, 4, 0));
    b.startPixelSample(pixelSeedKey(3, 4, 0));
    expect(a.next1D()).not.toBe(b.next1D());
  });
});

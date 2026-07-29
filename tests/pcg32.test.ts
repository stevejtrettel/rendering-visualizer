import { describe, expect, it } from 'vitest';
import { PCG32 } from '../src/core/math/pcg32';
import { fromNumber, u64 } from '../src/core/math/u64';

describe('PCG32', () => {
  it('matches the official pcg32 demo output (seed 42, seq 54)', () => {
    // pcg32_srandom_r(&rng, 42u, 54u) — first six outputs from the PCG
    // reference implementation's demo program.
    const rng = new PCG32(fromNumber(54), fromNumber(42));
    const expected = [0xa15c02b7, 0x7b47f409, 0xba1d3330, 0x83d2f293, 0xbfa4784b, 0xcbed606e];
    for (const e of expected) expect(rng.nextUInt32()).toBe(e);
  });

  it('advance(n) equals n sequential draws', () => {
    const a = new PCG32(fromNumber(7), fromNumber(11));
    const b = new PCG32(fromNumber(7), fromNumber(11));
    for (let i = 0; i < 1000; i++) a.nextUInt32();
    b.advance(1000);
    expect(b.nextUInt32()).toBe(a.nextUInt32());

    // Large jumps exercise the high limb of the delta.
    const c = new PCG32(fromNumber(7), fromNumber(11));
    c.advance(3 * 65536 + 17);
    const d = new PCG32(fromNumber(7), fromNumber(11));
    for (let i = 0; i < 3 * 65536 + 17; i++) d.nextUInt32();
    expect(c.nextUInt32()).toBe(d.nextUInt32());
  });

  it('setSequence is pure: same inputs, same stream', () => {
    const a = new PCG32(u64(0x1234, 0x5678), fromNumber(99));
    const b = new PCG32(u64(0x1234, 0x5678), fromNumber(99));
    for (let i = 0; i < 32; i++) expect(a.nextUInt32()).toBe(b.nextUInt32());
  });

  it('nextFloat stays in [0, 1)', () => {
    const rng = new PCG32(fromNumber(1), fromNumber(2));
    for (let i = 0; i < 100_000; i++) {
      const f = rng.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });
});

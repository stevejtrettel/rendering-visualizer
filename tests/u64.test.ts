import { describe, expect, it } from 'vitest';
import { add64, mul64, shl64, shr64, u64, xor64, fromNumber } from '../src/core/math/u64';

const MASK = (1n << 64n) - 1n;
const toBig = (v: { hi: number; lo: number }) => (BigInt(v.hi) << 32n) | BigInt(v.lo);
const fromBig = (b: bigint) => u64(Number((b >> 32n) & 0xffffffffn), Number(b & 0xffffffffn));

// Deterministic pseudo-random 64-bit test values (LCG over BigInt).
function* testValues(count: number): Generator<bigint> {
  let x = 0x123456789abcdef0n;
  for (let i = 0; i < count; i++) {
    x = (x * 6364136223846793005n + 1442695040888963407n) & MASK;
    yield x;
  }
}

describe('u64 against BigInt oracle', () => {
  const values = [...testValues(64)];

  it('add64', () => {
    for (let i = 0; i < values.length - 1; i++) {
      const a = values[i]!, b = values[i + 1]!;
      expect(toBig(add64(fromBig(a), fromBig(b)))).toBe((a + b) & MASK);
    }
  });

  it('mul64', () => {
    for (let i = 0; i < values.length - 1; i++) {
      const a = values[i]!, b = values[i + 1]!;
      expect(toBig(mul64(fromBig(a), fromBig(b)))).toBe((a * b) & MASK);
    }
  });

  it('shifts and xor', () => {
    for (const a of values) {
      for (const n of [0, 1, 5, 18, 27, 31, 32, 45, 59, 63]) {
        expect(toBig(shr64(fromBig(a), n))).toBe(a >> BigInt(n));
        expect(toBig(shl64(fromBig(a), n))).toBe((a << BigInt(n)) & MASK);
      }
      expect(toBig(xor64(fromBig(a), fromBig(a ^ 0xffn)))).toBe(0xffn);
    }
  });

  it('fromNumber is exact for safe integers', () => {
    for (const n of [0, 1, 65536, 2 ** 32 - 1, 2 ** 32, 2 ** 52 + 12345]) {
      expect(toBig(fromNumber(n))).toBe(BigInt(n));
    }
  });
});

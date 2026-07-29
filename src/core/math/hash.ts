// 64-bit-quality hashing for seed derivation (splitmix64 finalizer).
// Seed keys are always hashed before becoming PCG sequence indices — raw
// x*width+y-style keys put adjacent pixels in adjacent sequences, a classic
// correlation hazard the moment the generator or usage pattern changes.
import { U64, u64, add64, mul64, shr64, xor64, fromNumber } from './u64';

const M1: U64 = u64(0xbf58476d, 0x1ce4e5b9);
const M2: U64 = u64(0x94d049bb, 0x133111eb);
const GOLDEN: U64 = u64(0x9e3779b9, 0x7f4a7c15);

export function mixBits(v: U64): U64 {
  let z = xor64(v, shr64(v, 30));
  z = mul64(z, M1);
  z = xor64(z, shr64(z, 27));
  z = mul64(z, M2);
  return xor64(z, shr64(z, 31));
}

// Hash a sequence of safe integers into one U64.
export function hashInts(values: readonly number[]): U64 {
  let h = GOLDEN;
  for (const v of values) {
    h = mixBits(add64(xor64(h, fromNumber(v)), GOLDEN));
  }
  return h;
}

// Unsigned 64-bit integers as two 32-bit limbs. JS numbers lose integer
// precision past 2^53 and BigInt is too slow for the RNG hot path, so PCG32
// and the seed hash do their arithmetic here. All limbs are kept as unsigned
// 32-bit values (>>> 0).

export interface U64 {
  readonly hi: number;
  readonly lo: number;
}

export const u64 = (hi: number, lo: number): U64 => ({ hi: hi >>> 0, lo: lo >>> 0 });

export const U64_ZERO = u64(0, 0);
export const U64_ONE = u64(0, 1);

// Exact for integers up to 2^53 (the safe-integer range).
export function fromNumber(n: number): U64 {
  return u64(Math.floor(n / 0x100000000), n >>> 0);
}

export function add64(a: U64, b: U64): U64 {
  const lo = a.lo + b.lo;
  const carry = lo > 0xffffffff ? 1 : 0;
  return u64(a.hi + b.hi + carry, lo);
}

// 64×64 → low 64 bits, via 16-bit limbs with carry propagation (long.js scheme).
export function mul64(a: U64, b: U64): U64 {
  const a48 = a.hi >>> 16, a32 = a.hi & 0xffff, a16 = a.lo >>> 16, a00 = a.lo & 0xffff;
  const b48 = b.hi >>> 16, b32 = b.hi & 0xffff, b16 = b.lo >>> 16, b00 = b.lo & 0xffff;

  let c00 = a00 * b00;
  let c16 = c00 >>> 16;
  c00 &= 0xffff;
  c16 += a16 * b00;
  let c32 = c16 >>> 16;
  c16 &= 0xffff;
  c16 += a00 * b16;
  c32 += c16 >>> 16;
  c16 &= 0xffff;
  c32 += a32 * b00;
  let c48 = c32 >>> 16;
  c32 &= 0xffff;
  c32 += a16 * b16;
  c48 += c32 >>> 16;
  c32 &= 0xffff;
  c32 += a00 * b32;
  c48 += c32 >>> 16;
  c32 &= 0xffff;
  c48 += a48 * b00 + a32 * b16 + a16 * b32 + a00 * b48;
  c48 &= 0xffff;

  return u64((c48 << 16) | c32, (c16 << 16) | c00);
}

export function xor64(a: U64, b: U64): U64 {
  return u64(a.hi ^ b.hi, a.lo ^ b.lo);
}

// Logical right shift by 0..63 bits.
export function shr64(a: U64, n: number): U64 {
  if (n === 0) return a;
  if (n >= 32) return u64(0, a.hi >>> (n - 32));
  return u64(a.hi >>> n, ((a.hi << (32 - n)) | (a.lo >>> n)) >>> 0);
}

// Left shift by 0..63 bits.
export function shl64(a: U64, n: number): U64 {
  if (n === 0) return a;
  if (n >= 32) return u64(a.lo << (n - 32), 0);
  return u64(((a.hi << n) | (a.lo >>> (32 - n))) >>> 0, a.lo << n);
}

export function or64(a: U64, b: U64): U64 {
  return u64(a.hi | b.hi, a.lo | b.lo);
}

export function eq64(a: U64, b: U64): boolean {
  return a.hi === b.hi && a.lo === b.lo;
}

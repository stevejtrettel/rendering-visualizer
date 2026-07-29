// PCG32 (O'Neill) with pbrt's interface: setSequence establishes state as a
// pure function of (sequence, offset), advance() is the O(log n) jump-ahead
// that startPixelSample relies on. Never use a PCG32 without an explicit
// sequence — default-constructed generators risk correlated streams.
import { U64, u64, U64_ZERO, U64_ONE, add64, mul64, or64, shl64, shr64, xor64, fromNumber } from './u64';

const PCG32_MULT: U64 = u64(0x5851f42d, 0x4c957f2d);

// Largest float below 1.0 with a 24-bit mantissa step; clamping here keeps
// nextFloat strictly in [0, 1) — a leaked 1.0 breaks floor(u * n) selection.
const ONE_MINUS_EPSILON = 1 - 2 ** -24;

export class PCG32 {
  private state: U64 = U64_ZERO;
  private inc: U64 = U64_ONE;

  constructor(sequenceIndex: U64, offset: U64) {
    this.setSequence(sequenceIndex, offset);
  }

  setSequence(sequenceIndex: U64, offset: U64): void {
    this.state = U64_ZERO;
    this.inc = or64(shl64(sequenceIndex, 1), U64_ONE);
    this.nextUInt32();
    this.state = add64(this.state, offset);
    this.nextUInt32();
  }

  nextUInt32(): number {
    const old = this.state;
    this.state = add64(mul64(old, PCG32_MULT), this.inc);
    const x = xor64(shr64(old, 18), old);
    const xorshifted = ((x.hi << 5) | (x.lo >>> 27)) >>> 0;
    const rot = old.hi >>> 27;
    return ((xorshifted >>> rot) | (xorshifted << (-rot & 31))) >>> 0;
  }

  // Uniform in [0, 1), never 1.0.
  nextFloat(): number {
    return Math.min(this.nextUInt32() * 2 ** -32, ONE_MINUS_EPSILON);
  }

  // Jump the stream forward by delta draws in O(log delta).
  // delta must be a non-negative safe integer.
  advance(delta: number): void {
    let accMult = U64_ONE;
    let accPlus = U64_ZERO;
    let curMult = PCG32_MULT;
    let curPlus = this.inc;
    let d = fromNumber(delta);
    while (d.hi !== 0 || d.lo !== 0) {
      if (d.lo & 1) {
        accMult = mul64(accMult, curMult);
        accPlus = add64(mul64(accPlus, curMult), curPlus);
      }
      curPlus = add64(mul64(curMult, curPlus), curPlus);
      curMult = mul64(curMult, curMult);
      d = shr64(d, 1);
    }
    this.state = add64(mul64(accMult, this.state), accPlus);
  }
}

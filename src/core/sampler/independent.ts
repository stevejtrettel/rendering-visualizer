import { PCG32 } from '../math/pcg32';
import { hashInts } from '../math/hash';
import { U64_ZERO } from '../math/u64';
import { fromNumber } from '../math/u64';
import type { Sample2D } from '../math/sampling';
import type { Sampler, SeedKey } from './sampler';

// Dimension budget per sample: samples within a stream start 2^16 draws
// apart, so a path consuming fewer than 65536 dimensions never bleeds into
// the next sample's draws.
const DIMENSIONS_PER_SAMPLE = 65536;

export class IndependentSampler implements Sampler {
  private readonly rng = new PCG32(U64_ZERO, U64_ZERO);

  // Consumed-dimension counter; only used for bookkeeping/replay-from-mid-path.
  dimension = 0;

  constructor(private readonly globalSeed: number = 0) {}

  startPixelSample(key: SeedKey, dimension = 0): void {
    // State is a pure function of (key, dimension): the sequence index comes
    // from hashing the stream id, the offset from jumping within the stream.
    this.rng.setSequence(hashInts([...key.seq, this.globalSeed]), fromNumber(0));
    this.rng.advance(key.index * DIMENSIONS_PER_SAMPLE + dimension);
    this.dimension = dimension;
  }

  next1D(): number {
    this.dimension += 1;
    return this.rng.nextFloat();
  }

  next2D(): Sample2D {
    return [this.next1D(), this.next1D()];
  }

  nextPixel2D(): Sample2D {
    return this.next2D();
  }

  startStream(_index: number): void {
    // Independent samples have no inter-dimension structure to protect.
  }

  clone(): Sampler {
    return new IndependentSampler(this.globalSeed);
  }
}

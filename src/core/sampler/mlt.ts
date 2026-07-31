// Primary-sample-space Metropolis sampler (Kelemen et al. 2002; pbrt v3
// §16.4.2's MLTSampler). The Markov state is the VECTOR OF UNIFORMS the
// integrator consumes — never the RNG seed, which is a hash and maximally
// discontinuous. The integrator run on a fixed vector is a deterministic,
// almost-everywhere-smooth chart map from the cube into path space, so a
// small perturbation of every coordinate yields a nearby path; the PCG
// stream below is only an entropy source for the perturbations themselves,
// fresh coordinates, and large-step resets.
//
// Mutations: SMALL steps nudge each read coordinate by a wrapped Gaussian
// (symmetric on the torus, so Metropolis acceptance is just the brightness
// ratio); LARGE steps replace it with a fresh uniform — the teleport that
// keeps the chain ergodic and the estimate unbiased.
//
// Samples are LAZY: a coordinate is materialized (and mutated) only when
// read, with two bookkeeping subtleties that are the classic PSSMLT bugs:
// a sample whose last touch predates the last accepted large step must be
// reset to a fresh uniform before mutating (it "missed" that large step),
// and reject() must restore this iteration's touched samples AND decrement
// the iteration counter (the proposal never happened, so it must not count
// toward pending-small-step accumulation).
import { PCG32 } from '../math/pcg32';
import { hashInts } from '../math/hash';
import { U64_ZERO, fromNumber } from '../math/u64';
import { erfInv } from '../math/sampling';
import type { Sample2D } from '../math/sampling';
import type { Sampler, SeedKey } from './sampler';

export interface MLTSamplerOptions {
  // Small-step standard deviation in primary space, per pending iteration.
  sigma: number;
  largeStepProbability: number;
  // Interleaving factor for startStream: coordinate slots are
  // stream + streamCount * positionInStream, so a path-length change in
  // one stream cannot re-map another stream's coordinates.
  streamCount: number;
}

export const DEFAULT_MLT_SAMPLER_OPTIONS: MLTSamplerOptions = {
  sigma: 0.01,
  largeStepProbability: 0.3,
  streamCount: 3,
};

interface PrimarySample {
  value: number;
  // Iteration at which this coordinate was last brought up to date.
  lastModificationIteration: number;
  valueBackup: number;
  modifyBackup: number;
}

export class MLTSampler implements Sampler {
  private readonly options: MLTSamplerOptions;
  private readonly rng = new PCG32(U64_ZERO, U64_ZERO);

  private X: PrimarySample[] = [];
  private currentIteration = 0;
  // True before the first startIteration so the initial state (bootstrap
  // evaluation / chain regeneration) is drawn as all-fresh uniforms.
  private largeStep = true;
  private lastLargeStepIteration = 0;
  private streamIndex = 0;
  private streamPos = 0;

  constructor(
    private readonly globalSeed: number = 0,
    options: Partial<MLTSamplerOptions> = {},
  ) {
    this.options = { ...DEFAULT_MLT_SAMPLER_OPTIONS, ...options };
  }

  // Full chain (re)initialization: state becomes a pure function of the
  // key — bootstrap evaluation and chain regeneration both re-seed through
  // here (chains replay by re-running, storing nothing). The mid-path
  // `dimension` resume of pixel samplers does not apply to chains.
  startPixelSample(key: SeedKey, _dimension = 0): void {
    this.rng.setSequence(hashInts([...key.seq, this.globalSeed]), fromNumber(0));
    this.rng.advance(key.index * 65536);
    this.X = [];
    this.currentIteration = 0;
    this.largeStep = true;
    this.lastLargeStepIteration = 0;
    this.streamIndex = 0;
    this.streamPos = 0;
  }

  startStream(index: number): void {
    this.streamIndex = index;
    this.streamPos = 0;
  }

  next1D(): number {
    const slot = this.streamIndex + this.options.streamCount * this.streamPos;
    this.streamPos += 1;
    return this.ensureReady(slot);
  }

  next2D(): Sample2D {
    return [this.next1D(), this.next1D()];
  }

  nextPixel2D(): Sample2D {
    return this.next2D();
  }

  clone(): Sampler {
    return new MLTSampler(this.globalSeed, this.options);
  }

  // --- Chain lifecycle (driver-facing, beyond the Sampler interface) ---

  startIteration(): void {
    this.currentIteration += 1;
    this.largeStep = this.rng.nextFloat() < this.options.largeStepProbability;
  }

  accept(): void {
    if (this.largeStep) this.lastLargeStepIteration = this.currentIteration;
  }

  reject(): void {
    for (const Xi of this.X) {
      if (Xi.lastModificationIteration === this.currentIteration) {
        Xi.value = Xi.valueBackup;
        Xi.lastModificationIteration = Xi.modifyBackup;
      }
    }
    this.currentIteration -= 1;
  }

  // --- Instrumentation (tests and the chain visualizer) ---

  get iteration(): number {
    return this.currentIteration;
  }

  get isLargeStep(): boolean {
    return this.largeStep;
  }

  // Snapshot of the materialized coordinates, indexed by slot (the cube
  // point the chain currently sits at — the thing the visualizer plots).
  primaryValues(): number[] {
    return this.X.map((Xi) => Xi.value);
  }

  // -------------------------------------------------------------------

  private ensureReady(slot: number): number {
    while (this.X.length <= slot) {
      // Deliberate divergence from pbrt's mlt.cpp (which zero-initializes):
      // a coordinate materializes as a FRESH UNIFORM dated at the last
      // accepted large step. That is the eager-equivalent marginal — the
      // coordinate was conceptually drawn uniform at that large step, and
      // uniform convolved with wrapped-Gaussian small steps is still
      // uniform — where pbrt's zero puts a point mass where a uniform
      // belongs (transient: self-heals at the next accepted large step).
      this.X.push({
        value: this.rng.nextFloat(),
        lastModificationIteration: this.lastLargeStepIteration,
        valueBackup: 0,
        modifyBackup: 0,
      });
    }
    const Xi = this.X[slot]!;

    // Lazy catch-up: if the last touch predates the last accepted large
    // step, the stale value is meaningless — reset to a fresh uniform
    // dated at that large step before mutating forward from it.
    if (Xi.lastModificationIteration < this.lastLargeStepIteration) {
      Xi.value = this.rng.nextFloat();
      Xi.lastModificationIteration = this.lastLargeStepIteration;
    }

    Xi.valueBackup = Xi.value;
    Xi.modifyBackup = Xi.lastModificationIteration;

    if (this.largeStep) {
      Xi.value = this.rng.nextFloat();
    } else {
      // All pending small steps at once: the sum of n Gaussian steps is one
      // Gaussian step of sigma * sqrt(n), wrapped onto the torus (which is
      // what makes the proposal symmetric and acceptance ratio-only).
      const nSmall = this.currentIteration - Xi.lastModificationIteration;
      const normal = Math.SQRT2 * erfInv(2 * this.rng.nextFloat() - 1);
      Xi.value += normal * this.options.sigma * Math.sqrt(nSmall);
      Xi.value -= Math.floor(Xi.value);
      // Wrap can round to exactly 1.0 (value an epsilon below an integer);
      // the sampler contract is strictly [0, 1).
      if (Xi.value >= 1) Xi.value = 0;
    }
    Xi.lastModificationIteration = this.currentIteration;
    return Xi.value;
  }
}

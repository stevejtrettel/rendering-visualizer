import type { Sample2D } from '../math/sampling';

// A seed key identifies one replayable sample stream: `seq` names the stream
// (pixel coords for pixel samples, a bootstrap index for MLT chains), `index`
// the sample number within it. Sampler state must be a pure function of
// (key, dimension) — that purity IS the replay mechanism: the visualizer
// re-traces paths by re-running with the same key, storing nothing.
export interface SeedKey {
  readonly seq: readonly number[];
  readonly index: number;
}

export const pixelSeedKey = (x: number, y: number, sampleIndex: number): SeedKey => ({
  seq: [x, y],
  index: sampleIndex,
});

// MLT chains are keyed by their bootstrap index. The tag ('MLT' in ASCII)
// keeps chain streams disjoint from pixel streams whatever the hash does
// with sequence length.
export const chainSeedKey = (bootstrapIndex: number): SeedKey => ({
  seq: [0x4d4c54, bootstrapIndex],
  index: 0,
});

// Stream indices for startStream (BDPT phase boundaries; interleaved by the
// future PSSMLT sampler so a length change in one subpath cannot shift
// another subpath's dimensions).
export const CAMERA_STREAM = 0;
export const LIGHT_STREAM = 1;
export const CONNECTION_STREAM = 2;
// SMS (V5) draws its light-point and seed dimensions here. The dimension
// count is data-dependent (Bernoulli trials), which the walk streams'
// fixed layout forbids — a dedicated stream keeps that variability from
// ever touching them. (No-op interleaving for ordinary samplers; pt-sms
// is not an MLT-hosted integrator.)
export const SMS_STREAM = 3;

export interface Sampler {
  // Establish deterministic state for this key; `dimension` resumes
  // generation mid-stream (replay from the middle of a path).
  startPixelSample(key: SeedKey, dimension?: number): void;

  // Strictly [0, 1). Consumption rule (see design doc): integrators draw
  // dimensions in a fixed order on every code path.
  next1D(): number;
  next2D(): Sample2D;

  // Film-plane sample — separated so pixel-optimized samplers (stratified,
  // low-discrepancy) can specialize it. Default implementations forward to next2D.
  nextPixel2D(): Sample2D;

  // No-op for ordinary samplers; PSSMLT keys its interleaved streams on it.
  startStream(index: number): void;

  // Instance duplication for worker parallelism — NOT re-seeding.
  clone(): Sampler;
}

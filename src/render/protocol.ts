// Worker message protocol. Everything crossing the boundary is
// structured-clone-safe: the scene travels as its declarative description.
import type { SceneDescription } from '../core/scene/scene';

export type IntegratorName = 'pt' | 'pt-nee' | 'bdpt' | 'mmlt';

export interface InitMessage {
  type: 'init';
  description: SceneDescription;
  width: number;
  height: number;
  seed: number;
  integrator: IntegratorName;
  // Optional shared depth cap (walk maxBounces; MMLT chain depth). Set it
  // when panes compare integrators — they must estimate the SAME truncated
  // transport integral. Default: each integrator's own default.
  maxDepth?: number;
  // Incremented by the caller on re-init (e.g. scene switch); echoed on
  // every passDone so stale in-flight results can be discarded.
  epoch?: number;
  // 'rgba' (default): developed frames back. 'film': raw accumulated
  // Float64 film data back — pool mode, merged and developed by the caller.
  reply?: 'rgba' | 'film';
}

// For MMLT, `sampleIndex` names a mutation BATCH: batch k runs the disjoint
// chain-index range [k*K, (k+1)*K) for one mutation-per-pixel's worth of
// mutations, so the pool's sample-parallel scheduling partitions chains
// with no new coordination and "spp" accounting becomes mutations/pixel.
export interface PassMessage {
  type: 'pass';
  sampleIndex: number;
}

export type MainToWorker = InitMessage | PassMessage;

export interface PassDoneMessage {
  type: 'passDone';
  epoch: number;
  sampleIndex: number;
  samplesPerPixel: number;
  passMillis: number;
  // sRGB RGBA8 frame + false-color relative-SE view, both transferred.
  rgba: Uint8ClampedArray<ArrayBuffer>;
  errorRgba: Uint8ClampedArray<ArrayBuffer>;
  // MMLT only: the worker's bootstrap normalization (identical across
  // workers — same seed, same deterministic census).
  mltB?: number;
}

export interface FilmPassMessage {
  type: 'filmPass';
  epoch: number;
  sampleIndex: number;
  passesDone: number; // this worker's completed pass count
  passMillis: number;
  film: Float64Array<ArrayBuffer>; // snapshot of the worker's accumulated film
  // MMLT only: bootstrap normalization; the caller develops merged films
  // with splatScale = mltB / totalPasses (one pass = one mutation/pixel).
  mltB?: number;
}

export type WorkerToMain = PassDoneMessage | FilmPassMessage;

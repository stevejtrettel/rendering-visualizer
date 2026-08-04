// Worker message protocol. Everything crossing the boundary is
// structured-clone-safe: the scene travels as its declarative description.
import type { SceneDescription } from '../core/scene/scene';

export type IntegratorName = 'pt' | 'pt-term' | 'pt-nee' | 'pt-sms' | 'bdpt' | 'mmlt' | 'restir';

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

// What `sampleIndex` names is the renderer's business (see renderer.ts): a
// sample index for the per-pixel integrators, a disjoint mutation BATCH for
// MMLT — which is what makes "spp" accounting become mutations/pixel — and
// advisory for ReSTIR, whose passes are not exchangeable at all. The pool
// asks `passesAreExchangeable` rather than being told.
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
  // Developed by the worker's Renderer, so the error view is already
  // whatever is honest for this algorithm.
  rgba: Uint8ClampedArray<ArrayBuffer>;
  errorRgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface FilmPassMessage {
  type: 'filmPass';
  epoch: number;
  sampleIndex: number;
  passesDone: number; // this worker's completed pass count
  passMillis: number;
  film: Float64Array<ArrayBuffer>; // snapshot of the worker's accumulated film
  // Splat normalization for the MERGED film: splatScale = splatNorm /
  // totalPasses. Identical across workers (same seed, same deterministic
  // setup), and meaningful for every algorithm — this replaced the
  // MMLT-specific `mltB` field.
  splatNorm: number;
}

export type WorkerToMain = PassDoneMessage | FilmPassMessage;

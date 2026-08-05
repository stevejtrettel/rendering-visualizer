// Worker message protocol. Everything crossing the boundary is
// structured-clone-safe: the scene travels as its declarative description.
import type { SceneDescription } from '../core/scene/scene';
import type { MisHeuristic } from '../core/integrators/bdpt-mis';

export type IntegratorName = 'pt' | 'pt-term' | 'pt-nee' | 'pt-sms' | 'bdpt' | 'mmlt' | 'restir';

/**
 * How the walk chooses scattering directions. 'bsdf' is what a renderer
 * does; 'uniform' ignores each material's lobe and pays for it in the
 * weight. Both are unbiased estimators of the same integral — the choice is
 * pure variance, which is what makes it a figure.
 */
export type DirectionSampling = 'bsdf' | 'uniform';

/**
 * The estimator, as DATA — the counterpart to `SceneDescription`.
 *
 * This exists because of an asymmetry that used to sit in this file
 * (2026-08-04): the scene crossed the worker boundary fully described,
 * while the estimator crossed as a bare name plus one hand-picked option
 * (`maxDepth`) that had been promoted to a top-level field because somebody
 * needed it. Everything else — roulette depth, pt-term's geometric q,
 * BDPT's heuristic, the whole SMS ladder — was frozen at the factory, and
 * uniform direction sampling could not be named at all.
 *
 * So: one description per integrator, carrying its own options, plain data
 * by construction. `createRenderer` is its `buildScene`. Adding a knob is
 * adding a field here, never another protocol field.
 *
 * Every option is optional and defaults to the integrator's own default;
 * only what a figure has actually needed is exposed. Options that cannot be
 * data (BDPT's `strategyFilms` sink) stay local-only and are passed by
 * main-thread callers directly.
 */
export type IntegratorDescription =
  | { name: 'pt'; maxBounces?: number; rrStartDepth?: number; directions?: DirectionSampling }
  | { name: 'pt-nee'; maxBounces?: number; rrStartDepth?: number; directions?: DirectionSampling }
  // Roulette is absent on purpose: pt-term draws the whole path length up
  // front, which is the same geometric lifetime roulette reveals one
  // Bernoulli at a time. Offering both would let you build incoherent
  // combinations of one idea.
  | { name: 'pt-term'; maxBounces?: number; continueProb?: number; directions?: DirectionSampling }
  | {
      name: 'pt-sms';
      maxBounces?: number;
      rrStartDepth?: number;
      estimator?: 'biasedM' | 'unbiased';
      directions?: DirectionSampling;
    }
  | {
      name: 'bdpt';
      maxBounces?: number;
      rrStartDepth?: number;
      heuristic?: MisHeuristic;
      directions?: DirectionSampling;
    }
  | { name: 'mmlt'; maxBounces?: number }
  | { name: 'restir'; maxBounces?: number };

/**
 * The common case: a named integrator at its defaults, optionally sharing a
 * depth cap with the panes beside it (comparisons must estimate the SAME
 * truncated transport integral). Anything more specific is written as a
 * description literal.
 */
export function describeIntegrator(
  name: IntegratorName,
  maxBounces?: number,
): IntegratorDescription {
  const depth = maxBounces === undefined ? {} : { maxBounces };
  switch (name) {
    case 'pt':
      return { name: 'pt', ...depth };
    case 'pt-nee':
      return { name: 'pt-nee', ...depth };
    case 'pt-term':
      return { name: 'pt-term', ...depth };
    case 'pt-sms':
      return { name: 'pt-sms', ...depth };
    case 'bdpt':
      return { name: 'bdpt', ...depth };
    case 'mmlt':
      return { name: 'mmlt', ...depth };
    case 'restir':
      return { name: 'restir', ...depth };
  }
}

export interface InitMessage {
  type: 'init';
  description: SceneDescription;
  width: number;
  height: number;
  seed: number;
  integrator: IntegratorDescription;
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

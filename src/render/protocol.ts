// Worker message protocol. Everything crossing the boundary is
// structured-clone-safe: the scene travels as its declarative description.
import type { SceneDescription } from '../core/scene/scene';

export type IntegratorName = 'pt' | 'pt-nee';

export interface InitMessage {
  type: 'init';
  description: SceneDescription;
  width: number;
  height: number;
  seed: number;
  integrator: IntegratorName;
  // Incremented by the caller on re-init (e.g. scene switch); echoed on
  // every passDone so stale in-flight results can be discarded.
  epoch?: number;
}

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
}

export type WorkerToMain = PassDoneMessage;

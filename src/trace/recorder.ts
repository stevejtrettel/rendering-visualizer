import type { Vec3 } from '../core/math/vec3';
import type { PathVertex } from '../core/integrators/vertex';
import type { Contribution } from '../core/integrators/types';
import type { SeedKey } from '../core/sampler/sampler';

// Instrumentation events emitted by integrators. Grows with the algorithms:
// V0 walks + RR, V1a shadow rays, later BDPT connections and MLT mutations.
export interface RREvent {
  depth: number;
  probability: number;
  survived: boolean;
}

// An NEE connection attempt — the occluded ones are pedagogically as
// important as the successes, so the blocker's hit point is captured.
export interface ShadowRayEvent {
  depth: number;
  from: Vec3;
  to: Vec3;
  occluded: boolean;
  blockedAt: Vec3 | null;
}

// A BDPT connection attempt for strategy (s, t). `from` is the camera-side
// endpoint (the eye itself for t=1), `to` the light-side endpoint (the
// resampled light point for s=1). weight is the MIS weight of the formed
// path — 0 when the segment was occluded.
export interface ConnectionEvent {
  s: number;
  t: number;
  from: Vec3;
  to: Vec3;
  occluded: boolean;
  blockedAt: Vec3 | null;
  weight: number;
}

// Which subpath a walk materialized — camera walks transport Radiance,
// light walks (BDPT) transport Importance.
export type WalkRole = 'camera' | 'light';

export interface Recorder {
  beginPath(key: SeedKey): void;
  // Called once per completed walk, after all backward pdfRev writes.
  walk(vertices: readonly PathVertex[], role: WalkRole): void;
  rr(event: RREvent): void;
  shadowRay(event: ShadowRayEvent): void;
  connection(event: ConnectionEvent): void;
  contribution(c: Contribution): void;
  endPath(): void;
}

export class NullRecorder implements Recorder {
  beginPath(): void {}
  walk(): void {}
  rr(): void {}
  shadowRay(): void {}
  connection(): void {}
  contribution(): void {}
  endPath(): void {}
}

export const NULL_RECORDER: Recorder = new NullRecorder();

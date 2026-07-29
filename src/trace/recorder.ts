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

export interface Recorder {
  beginPath(key: SeedKey): void;
  // Called once per completed walk, after all backward pdfRev writes.
  walk(vertices: readonly PathVertex[]): void;
  rr(event: RREvent): void;
  shadowRay(event: ShadowRayEvent): void;
  contribution(c: Contribution): void;
  endPath(): void;
}

export class NullRecorder implements Recorder {
  beginPath(): void {}
  walk(): void {}
  rr(): void {}
  shadowRay(): void {}
  contribution(): void {}
  endPath(): void {}
}

export const NULL_RECORDER: Recorder = new NullRecorder();

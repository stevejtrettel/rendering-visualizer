import type { PathVertex } from '../core/integrators/vertex';
import type { Contribution } from '../core/integrators/types';
import type { SeedKey } from '../core/sampler/sampler';

// Instrumentation events emitted by integrators. Kept deliberately small in
// V0; grows with NEE (shadow rays) and BDPT/MLT (connections, mutations).
export interface RREvent {
  depth: number;
  probability: number;
  survived: boolean;
}

export interface Recorder {
  beginPath(key: SeedKey): void;
  // Called once per completed walk, after all backward pdfRev writes.
  walk(vertices: readonly PathVertex[]): void;
  rr(event: RREvent): void;
  contribution(c: Contribution): void;
  endPath(): void;
}

export class NullRecorder implements Recorder {
  beginPath(): void {}
  walk(): void {}
  rr(): void {}
  contribution(): void {}
  endPath(): void {}
}

export const NULL_RECORDER: Recorder = new NullRecorder();

// Two tracers on one scene, rendered for comparison.
//
// Sequentially, never concurrently. Two workers racing for the same cores
// make each other slower by an amount nobody can account for, and an
// equal-TIME comparison built on contended timings is not a measurement of
// anything. It costs twice the wall clock and buys a number you can quote.
import type { SceneDescription } from '../core/scene/scene';
import type { IntegratorName } from './protocol';
import { ConvergenceSequence } from './convergence';

/** How the two sides are held level against each other. */
export type SyncMode =
  // Both show the same sample count at the same moment. The usual figure:
  // "same work per pixel, look at the difference in noise."
  | 'samples'
  // Both get the same wall-clock budget and show how far each got. The
  // stronger claim, and the machine-dependent one.
  | 'time';

export interface ComparisonOptions {
  description: SceneDescription;
  tracers: readonly [IntegratorName, IntegratorName];
  width: number;
  height: number;
  maxSpp: number;
  seed?: number;
  maxDepth?: number;
  signal?: AbortSignal;
  onProgress?: (status: {
    side: 0 | 1;
    tracer: IntegratorName;
    spp: number;
    maxSpp: number;
    msPerPass: number;
    rgba: Uint8ClampedArray;
  }) => void;
}

export class ConvergenceComparison {
  private constructor(
    readonly tracers: readonly [IntegratorName, IntegratorName],
    readonly a: ConvergenceSequence,
    readonly b: ConvergenceSequence,
  ) {}

  /**
   * The largest time budget BOTH sides actually reached. Pacing an
   * equal-time movie past this would freeze the faster side on its last
   * frame while the slower one carried on — the comparison would quietly
   * stop being one.
   */
  get sharedMillis(): number {
    return Math.min(this.a.totalMillis, this.b.totalMillis);
  }

  /** Sample counts the two sides show for a given budget, by sync mode. */
  sppFor(mode: SyncMode, value: number): [number, number] {
    return mode === 'time'
      ? [this.a.sppWithin(value), this.b.sppWithin(value)]
      : [Math.min(value, this.a.maxSpp), Math.min(value, this.b.maxSpp)];
  }

  static async render(options: ComparisonOptions): Promise<ConvergenceComparison> {
    const { tracers, onProgress, ...rest } = options;
    const one = (side: 0 | 1) =>
      ConvergenceSequence.render({
        ...rest,
        integrator: tracers[side],
        ...(onProgress
          ? {
              onProgress: (s) =>
                onProgress({ side, tracer: tracers[side], ...s }),
            }
          : {}),
      });

    const a = await one(0);
    const b = await one(1);
    return new ConvergenceComparison(tracers, a, b);
  }
}

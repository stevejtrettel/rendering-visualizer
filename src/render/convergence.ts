// Convergence sequences: the image at 1, 2, 3, … spp, played as a movie.
//
// The renderer already works pass by pass. This saves the passes the movie
// wants and hands them back, so the animation is an array lookup like any
// other figure's is a function of t.
//
// The one choice with a reason behind it: a single RenderSession, not a
// WorkerPool. The pool merges "whichever passes have arrived", which is
// fine for converging a preview and wrong when the intermediate states are
// the content — pass k would land in a different merge on every run. One
// worker delivers spp = 1, 2, 3, … in order, so exports are reproducible.
import type { SceneDescription } from '../core/scene/scene';
import type { IntegratorDescription, IntegratorName } from './protocol';
import { RenderSession } from './session';

/** How movie time is spent across the sample range. */
export type Pacing =
  // Equal spp per second. Honest, and mostly boring: past ~100 spp
  // successive frames are indistinguishable.
  | 'linear'
  // Equal DOUBLINGS per second. The default, and the perceptually right
  // one: noise falls as 1/sqrt(spp), so equal doublings are roughly equal
  // visible change. Dwells on 1 -> 32 and races through 128 -> 512.
  | 'log'
  // Between the two, for when log feels too eager to leave the low counts.
  | 'sqrt';

export interface ScheduleOptions {
  /** Total movie frames — duration x fps. */
  frames: number;
  maxSpp: number;
  pacing?: Pacing;
  /**
   * Show only this many DISTINCT sample counts, spaced along the pacing
   * curve, each held for an equal share of the running time. Omit to step
   * through every count. Useful when you want the picture to change in
   * deliberate beats rather than continuously.
   */
  steps?: number;
  /** Frames held on the first sample before the ramp starts. */
  holdStart?: number;
  /** Frames held on the converged image at the end. */
  holdEnd?: number;
}

/**
 * The distinct sample counts a schedule visits — its ladder. Pass this
 * straight to ConvergenceSequence.render as `keep`, so only the images the
 * movie actually shows are held in memory.
 */
export function sppLadder(options: ScheduleOptions): number[] {
  return [...new Set(sppSchedule(options))];
}

/**
 * The spp to display on each movie frame: non-decreasing, starting at 1 and
 * ending at maxSpp. Values repeat wherever the curve is flat — which is how
 * one render pass stays on screen for several movie frames, without the
 * caller doing anything.
 */
export function sppSchedule(options: ScheduleOptions): number[] {
  const { frames, maxSpp, pacing = 'log', steps, holdStart = 0, holdEnd = 0 } = options;
  if (frames <= 0) return [];
  if (maxSpp < 1) throw new Error(`sppSchedule: maxSpp must be >= 1, got ${maxSpp}`);
  if (steps !== undefined && steps < 1) throw new Error(`sppSchedule: steps must be >= 1, got ${steps}`);

  // Holds cannot eat the whole movie; leave at least one ramp frame.
  const held = Math.min(holdStart + holdEnd, Math.max(0, frames - 1));
  const scale = held > 0 ? Math.min(1, (frames - 1) / (holdStart + holdEnd)) : 1;
  const hs = Math.floor(holdStart * scale);
  const he = Math.floor(holdEnd * scale);
  const ramp = frames - hs - he;

  const curve = (u: number): number => {
    switch (pacing) {
      case 'linear':
        return 1 + (maxSpp - 1) * u;
      case 'sqrt':
        return 1 + (maxSpp - 1) * u * u;
      case 'log':
      default:
        return Math.pow(maxSpp, u);
    }
  };

  const clamp = (v: number) => Math.min(maxSpp, Math.max(1, Math.round(v)));

  // The ladder: the distinct counts the movie shows, spaced along the same
  // curve. Without `steps`, every count is its own rung.
  let ladder: number[] | null = null;
  if (steps !== undefined) {
    const rungs = new Set<number>([1, maxSpp]);
    for (let j = 0; j < steps; j++) rungs.add(clamp(curve(steps === 1 ? 1 : j / (steps - 1))));
    ladder = [...rungs].sort((a, b) => a - b);
  }

  const out: number[] = new Array(hs).fill(1);
  for (let j = 0; j < ramp; j++) {
    const u = ramp === 1 ? 1 : j / (ramp - 1);
    if (ladder) {
      // Walk the ladder at a constant rate — each rung gets an equal share
      // of the running time. Snapping to "the highest rung under the curve"
      // instead would give the top rung a single frame, so the converged
      // image, the one worth looking at, would flash past in 1/60 s.
      out.push(ladder[Math.min(ladder.length - 1, Math.floor(u * ladder.length))]!);
    } else {
      out.push(clamp(curve(u)));
    }
  }
  for (let j = 0; j < he; j++) out.push(maxSpp);

  // Rounding a shallow curve can step backwards; the sequence must only
  // ever move forward or a frame would appear to un-converge.
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i]!, out[i - 1]!);
  return out;
}

export interface ConvergenceOptions {
  description: SceneDescription;
  integrator: IntegratorDescription;
  width: number;
  height: number;
  maxSpp: number;
  seed?: number;
  /** Also keep the false-colour error view. Doubles the memory. */
  keepError?: boolean;
  /** Only these spp are kept; defaults to every one. */
  keep?: Iterable<number>;
  // Abort an in-flight render and terminate its worker. A page that lets
  // you switch scene or integrator needs this: without it, the abandoned
  // render keeps tracing and its progress callbacks fight the new one for
  // the same panel.
  signal?: AbortSignal;
  // Called as each pass lands. `rgba` is that pass's developed image, so a
  // demo can show the render converging live while it waits.
  onProgress?: (status: {
    spp: number;
    maxSpp: number;
    msPerPass: number;
    rgba: Uint8ClampedArray;
  }) => void;
}

/** The same ramp, over a wall-clock budget in ms rather than samples. */
export const msSchedule = (
  options: Omit<ScheduleOptions, 'maxSpp'> & { maxMs: number },
): number[] => sppSchedule({ ...options, maxSpp: Math.max(1, Math.round(options.maxMs)) });

/** A rendered sequence: the developed image at each kept sample count. */
export class ConvergenceSequence {
  private constructor(
    readonly maxSpp: number,
    private readonly images: Map<number, Uint8ClampedArray>,
    private readonly errors: Map<number, Uint8ClampedArray>,
    // Cumulative wall-clock ms spent to REACH each kept sample count. This
    // is what makes an equal-TIME comparison possible: two tracers get the
    // same budget and each shows how far it actually got.
    //
    // Measured on this machine, this session, and frozen into the sequence
    // — so a movie is reproducible once rendered, but re-rendering
    // elsewhere gives different numbers. That is honest for an equal-time
    // claim, which is a statement about a machine, not about mathematics.
    private readonly millis: Map<number, number>,
  ) {}

  /** Bytes held, for a demo that wants to report it. */
  get bytes(): number {
    let n = 0;
    for (const a of this.images.values()) n += a.length;
    for (const a of this.errors.values()) n += a.length;
    return n;
  }

  /** The image at `spp`, or the nearest kept sample count below it. */
  at(spp: number): Uint8ClampedArray | null {
    for (let s = Math.min(spp, this.maxSpp); s >= 1; s--) {
      const hit = this.images.get(s);
      if (hit) return hit;
    }
    return null;
  }

  errorAt(spp: number): Uint8ClampedArray | null {
    for (let s = Math.min(spp, this.maxSpp); s >= 1; s--) {
      const hit = this.errors.get(s);
      if (hit) return hit;
    }
    return null;
  }

  /** Cumulative ms of tracing to reach `spp` (nearest kept count below). */
  msAt(spp: number): number {
    for (let s = Math.min(spp, this.maxSpp); s >= 1; s--) {
      const hit = this.millis.get(s);
      if (hit !== undefined) return hit;
    }
    return 0;
  }

  /** Total wall-clock ms this sequence cost to trace. */
  get totalMillis(): number {
    return this.msAt(this.maxSpp);
  }

  /**
   * The furthest sample count reached within `ms` of tracing — the
   * equal-time question. Returns 0 when not even one pass fits, which a
   * caller should render as "nothing yet" rather than as 1 spp.
   */
  sppWithin(ms: number): number {
    let best = 0;
    for (const [spp, cumulative] of this.millis) {
      if (cumulative <= ms && spp > best) best = spp;
    }
    return best;
  }

  /**
   * Render the whole sequence, resolving once maxSpp is reached. Hold the
   * stage clock until it does, so pressing V cannot catch a half-built
   * sequence and export a movie that stops converging halfway.
   */
  static render(options: ConvergenceOptions): Promise<ConvergenceSequence> {
    const { maxSpp, keepError = false, keep, onProgress, signal } = options;
    const wanted = keep ? new Set(keep) : null;
    const images = new Map<number, Uint8ClampedArray>();
    const errors = new Map<number, Uint8ClampedArray>();
    const millis = new Map<number, number>();

    return new Promise((resolve, reject) => {
      let session: RenderSession | null = null;
      const abortError = () =>
        Object.assign(new Error('convergence render aborted'), { name: 'AbortError' });
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        session?.dispose();
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (seq: ConvergenceSequence) => {
        signal?.removeEventListener('abort', onAbort);
        session?.dispose();
        resolve(seq);
      };
      try {
        session = new RenderSession({
          description: options.description,
          integrator: options.integrator,
          width: options.width,
          height: options.height,
          targetSpp: maxSpp,
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
          onUpdate: (s) => {
            if (signal?.aborted) return;
            if (!wanted || wanted.has(s.spp)) {
              // The worker transfers these buffers, so each update owns its
              // arrays and they can be kept without copying.
              images.set(s.spp, s.rgba);
              if (keepError) errors.set(s.spp, s.errorRgba);
              millis.set(s.spp, s.totalMillis);
            }
            onProgress?.({ spp: s.spp, maxSpp, msPerPass: s.msPerPass, rgba: s.rgba });
            if (s.done) finish(new ConvergenceSequence(maxSpp, images, errors, millis));
          },
        });
      } catch (e) {
        signal?.removeEventListener('abort', onAbort);
        session?.dispose();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

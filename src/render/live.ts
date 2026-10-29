// A live, progressive render that starts showing at once and restarts at
// once. Workers (live-worker.ts) render whole passes of one path per pixel
// but post them in small chunks of pixels in a scattered order, so the
// picture fills in as speckle from the first frame; this side keeps each
// pixel's running sum and count. A restart bumps the epoch; chunks from the
// old one are dropped as they arrive.
//
// Made for the talk's live slides (full-render): WorkerPool renders a whole
// pass per worker before anything arrives, which at a large resolution kept
// the screen empty for seconds, then rushed. Not bit-replayable (which
// chunk arrives when depends on timing); the converged image a slide shows
// is made separately, deterministically.
import type { SceneDescription } from '../core/scene/scene';
import { srgbEncode } from './film';
import { scatteredOrder, type LiveChunk, type LiveStart } from './live-protocol';

export interface LiveOptions {
  description: SceneDescription;
  res: number;
  tracer: 'plain' | 'nee';
  maxBounces?: number;
  maxSpp?: number;
  workers?: number;
  chunk?: number;
}

export class LiveRender {
  readonly res: number;
  private readonly sum: Float32Array;
  private readonly count: Uint32Array;
  private readonly order: Uint32Array;
  private readonly workers: Worker[] = [];
  private epoch = 0;
  private paths = 0;
  private description: SceneDescription;

  constructor(private readonly opts: LiveOptions) {
    this.res = opts.res;
    this.sum = new Float32Array(opts.res * opts.res * 3);
    this.count = new Uint32Array(opts.res * opts.res);
    this.order = scatteredOrder(opts.res);
    this.description = opts.description;
    const n = opts.workers ?? Math.max(1, (navigator.hardwareConcurrency || 4) - 2);
    for (let k = 0; k < n; k++) {
      const w = new Worker(new URL('./live-worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<LiveChunk>) => this.receive(e.data);
      this.workers.push(w);
    }
    this.start();
  }

  /** Paths per pixel so far, on average. */
  get perPixel(): number {
    return this.paths / (this.res * this.res);
  }

  /** Throw everything away and render this description from nothing. */
  restart(description: SceneDescription = this.description): void {
    this.description = description;
    this.sum.fill(0);
    this.count.fill(0);
    this.paths = 0;
    this.start();
  }

  /** Each pixel's average so far as sRGB bytes (black where it has had no path). */
  develop(out: Uint8ClampedArray, exposure = 1): void {
    const { sum, count } = this;
    for (let i = 0; i < count.length; i++) {
      const k = count[i]! ? exposure / count[i]! : 0;
      out[i * 4] = srgbEncode(sum[i * 3]! * k);
      out[i * 4 + 1] = srgbEncode(sum[i * 3 + 1]! * k);
      out[i * 4 + 2] = srgbEncode(sum[i * 3 + 2]! * k);
      out[i * 4 + 3] = 255;
    }
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
  }

  private start(): void {
    this.epoch++;
    const n = this.workers.length;
    this.workers.forEach((w, k) => {
      const message: LiveStart = {
        epoch: this.epoch,
        description: this.description,
        res: this.res,
        tracer: this.opts.tracer,
        maxBounces: this.opts.maxBounces ?? 8,
        worker: k,
        workers: n,
        chunk: this.opts.chunk ?? 4096,
        maxSpp: this.opts.maxSpp ?? 4096,
      };
      w.postMessage(message);
    });
  }

  private receive(c: LiveChunk): void {
    if (c.epoch !== this.epoch) return;
    for (let t = c.start; t < c.end; t++) {
      const i = this.order[t]!;
      const o = (t - c.start) * 3;
      this.sum[i * 3]! += c.sums[o]!;
      this.sum[i * 3 + 1]! += c.sums[o + 1]!;
      this.sum[i * 3 + 2]! += c.sums[o + 2]!;
      this.count[i]!++;
    }
    this.paths += c.end - c.start;
  }
}

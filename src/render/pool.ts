// Sample-parallel worker pool: worker k renders sample indices k, k+N,
// k+2N, … of FULL frames. Seed keys are per-(pixel, sample), so there is
// no coordination, no tiles, no scheduler. Each worker accumulates its own
// film and ships snapshots; the pool merges them by summation IN WORKER
// ORDER (films are sums, so the completed render is bit-deterministic;
// intermediate merges contain whichever passes have arrived — timing-
// dependent but statistically equivalent).
import type { SceneDescription } from '../core/scene/scene';
import type { FilmPassMessage, InitMessage, IntegratorName, WorkerToMain } from './protocol';
import { developFilm, passesAreExchangeable, type DevelopedFrame } from './renderer';
import { Film } from './film';

export interface PoolUpdate {
  totalSpp: number; // for MMLT: total mutation batches = mutations/pixel
  wallMillis: number;
  film: Film; // merged — raw, if a caller wants the numbers
  // The merged film developed under this integrator's conventions (splat
  // normalization, and whether an error view is meaningful). Callers should
  // prefer this to developing `film` themselves.
  frame(): DevelopedFrame;
}

export interface PoolOptions {
  size: number;
  description: SceneDescription;
  width: number;
  height: number;
  seed: number;
  integrator: IntegratorName;
  // Shared depth cap forwarded to every worker (see protocol.ts).
  maxDepth?: number;
  // Stop scheduling when total spp reaches maxSpp, or (if set) when wall
  // time since restart exceeds maxMillis — whichever the comparison
  // protocol fixes. In-flight passes still land (labels stay honest).
  maxSpp: number;
  maxMillis?: number;
  onUpdate: (u: PoolUpdate) => void;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private films: (Float64Array | null)[] = [];
  private passCounts: number[] = [];
  private epoch = 0;
  private startTime = 0;
  private splatNorm = 1;
  private opts: PoolOptions;
  private readonly merged: Film;

  // Workers that actually render. An integrator whose passes are NOT
  // exchangeable (restir: pass k consumes pass k-1's reservoirs) must run
  // alone — read off the algorithm rather than set by hand at every call
  // site, which is what the old `activeWorkers` option required.
  private get active(): number {
    return passesAreExchangeable(this.opts.integrator) ? this.opts.size : 1;
  }

  constructor(opts: PoolOptions) {
    this.opts = opts;
    this.merged = new Film(opts.width, opts.height);
    for (let k = 0; k < opts.size; k++) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const index = k;
      worker.onmessage = (e: MessageEvent<WorkerToMain>) => this.onMessage(index, e.data);
      this.workers.push(worker);
      this.films.push(null);
      this.passCounts.push(0);
    }
    this.restart(opts.description);
  }

  restart(
    description: SceneDescription,
    overrides: Partial<Pick<PoolOptions, 'integrator' | 'maxSpp' | 'maxMillis'>> = {},
  ): void {
    this.epoch += 1;
    this.opts = { ...this.opts, description, ...overrides };
    this.films.fill(null);
    this.passCounts.fill(0);
    this.splatNorm = 1;
    this.startTime = performance.now();
    const active = this.active;
    this.workers.forEach((worker, k) => {
      if (k >= active) return; // idle worker under this configuration
      const init: InitMessage = {
        type: 'init',
        description,
        width: this.opts.width,
        height: this.opts.height,
        seed: this.opts.seed,
        integrator: this.opts.integrator,
        ...(this.opts.maxDepth !== undefined ? { maxDepth: this.opts.maxDepth } : {}),
        epoch: this.epoch,
        reply: 'film',
      };
      worker.postMessage(init);
      worker.postMessage({ type: 'pass', sampleIndex: k });
    });
  }

  private onMessage(index: number, msg: WorkerToMain): void {
    if (msg.type !== 'filmPass' || msg.epoch !== this.epoch) return;
    const m = msg as FilmPassMessage;
    this.films[index] = m.film;
    this.passCounts[index] = m.passesDone;
    this.splatNorm = m.splatNorm;

    // Next sample index for this worker: k + passesDone * active.
    const active = this.active;
    const next = index + m.passesDone * active;
    const withinTime =
      this.opts.maxMillis === undefined || performance.now() - this.startTime < this.opts.maxMillis;
    if (next < this.opts.maxSpp && withinTime) {
      this.workers[index]!.postMessage({ type: 'pass', sampleIndex: next });
    }

    // Merge in worker order and report.
    this.merged.data.fill(0);
    let totalSpp = 0;
    for (let k = 0; k < this.films.length; k++) {
      const f = this.films[k];
      if (!f) continue;
      totalSpp += this.passCounts[k]!;
      const dst = this.merged.data;
      for (let i = 0; i < dst.length; i++) dst[i]! += f[i]!;
    }
    const { integrator } = this.opts;
    const splatNorm = this.splatNorm;
    this.opts.onUpdate({
      totalSpp,
      wallMillis: performance.now() - this.startTime,
      film: this.merged,
      frame: () => developFilm(integrator, this.merged, totalSpp, splatNorm),
    });
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
  }
}

// Sample-parallel worker pool: worker k renders sample indices k, k+N,
// k+2N, … of FULL frames. Seed keys are per-(pixel, sample), so there is
// no coordination, no tiles, no scheduler. Each worker accumulates its own
// film and ships snapshots; the pool merges them by summation IN WORKER
// ORDER (films are sums, so the completed render is bit-deterministic;
// intermediate merges contain whichever passes have arrived — timing-
// dependent but statistically equivalent).
import type { SceneDescription } from '../core/scene/scene';
import type { FilmPassMessage, InitMessage, IntegratorName, WorkerToMain } from './protocol';
import { Film } from './film';

export interface PoolUpdate {
  totalSpp: number;
  wallMillis: number;
  film: Film; // merged — develop()/developError() as needed
}

export interface PoolOptions {
  size: number;
  description: SceneDescription;
  width: number;
  height: number;
  seed: number;
  integrator: IntegratorName;
  maxSpp: number;
  onUpdate: (u: PoolUpdate) => void;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private films: (Float64Array | null)[] = [];
  private passCounts: number[] = [];
  private epoch = 0;
  private startTime = 0;
  private opts: PoolOptions;
  private readonly merged: Film;

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

  restart(description: SceneDescription): void {
    this.epoch += 1;
    this.opts = { ...this.opts, description };
    this.films.fill(null);
    this.passCounts.fill(0);
    this.startTime = performance.now();
    this.workers.forEach((worker, k) => {
      const init: InitMessage = {
        type: 'init',
        description,
        width: this.opts.width,
        height: this.opts.height,
        seed: this.opts.seed,
        integrator: this.opts.integrator,
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

    // Next sample index for this worker: k + passesDone * size.
    const next = index + m.passesDone * this.opts.size;
    if (next < this.opts.maxSpp) {
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
    this.opts.onUpdate({
      totalSpp,
      wallMillis: performance.now() - this.startTime,
      film: this.merged,
    });
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
  }
}

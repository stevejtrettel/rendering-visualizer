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
  totalSpp: number; // for MMLT: total mutation batches = mutations/pixel
  wallMillis: number;
  film: Film; // merged — develop()/developError() as needed
  // MMLT only: bootstrap normalization (identical across workers).
  // Develop the merged film with splatScale = mltB / totalSpp.
  mltB?: number;
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
  // How many of the pool's workers actually render (default: all).
  // Integrators with non-exchangeable passes (restir) must use 1 — pass k
  // depends on pass k-1's worker-side state, so sample-parallel splitting
  // would silently break the algorithm.
  activeWorkers?: number;
  onUpdate: (u: PoolUpdate) => void;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private films: (Float64Array | null)[] = [];
  private passCounts: number[] = [];
  private epoch = 0;
  private startTime = 0;
  private mltB: number | undefined;
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

  restart(
    description: SceneDescription,
    overrides: Partial<Pick<PoolOptions, 'integrator' | 'maxSpp' | 'maxMillis' | 'activeWorkers'>> = {},
  ): void {
    this.epoch += 1;
    this.opts = { ...this.opts, description, ...overrides };
    this.films.fill(null);
    this.passCounts.fill(0);
    this.mltB = undefined;
    this.startTime = performance.now();
    const active = Math.min(this.opts.activeWorkers ?? this.opts.size, this.opts.size);
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
    if (m.mltB !== undefined) this.mltB = m.mltB;

    // Next sample index for this worker: k + passesDone * activeWorkers.
    const active = Math.min(this.opts.activeWorkers ?? this.opts.size, this.opts.size);
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
    this.opts.onUpdate({
      totalSpp,
      wallMillis: performance.now() - this.startTime,
      film: this.merged,
      ...(this.mltB !== undefined ? { mltB: this.mltB } : {}),
    });
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
  }
}

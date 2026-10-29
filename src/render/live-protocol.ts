// Messages between LiveRender (live.ts) and its workers (live-worker.ts).
import type { SceneDescription } from '../core/scene/scene';

export interface LiveStart {
  epoch: number;
  description: SceneDescription;
  res: number;
  tracer: 'plain' | 'nee';
  maxBounces: number;
  /** This worker renders passes worker, worker + workers, … */
  worker: number;
  workers: number;
  /** Pixels per posted chunk. */
  chunk: number;
  maxSpp: number;
}

export interface LiveChunk {
  epoch: number;
  pass: number;
  /** Positions start .. end - 1 in scatteredOrder(res). */
  start: number;
  end: number;
  /** Per pixel in that range, the path's rgb. */
  sums: Float32Array;
}

/** Every pixel index once, in a fixed scattered order (both sides compute it). */
export function scatteredOrder(res: number): Uint32Array {
  // A seeded Fisher-Yates shuffle: linear time, so a large film (a million
  // pixels) does not hold up the first chunk the way a sort would.
  const order = new Uint32Array(res * res);
  for (let i = 0; i < order.length; i++) order[i] = i;
  let seed = 0x2545f491;
  for (let i = order.length - 1; i > 0; i--) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const j = (seed >>> 0) % (i + 1);
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
  }
  return order;
}

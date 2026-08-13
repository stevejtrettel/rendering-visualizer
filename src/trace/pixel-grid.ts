// Trace every pixel of a small grid, every sample, keeping both halves of
// what the figure needs: the value each sample contributed (so the image
// can form) and the path it travelled (so the calculation can be watched).
//
// On the main thread rather than in a worker, because the worker protocol
// ships developed FILMS, not paths — determinism is the storage, and a
// pixel's path is re-traced wherever it is needed. The grids here are tiny
// (a few thousand paths), and the walk yields between rows so the page
// stays responsive and can show progress.
import type { Scene } from '../core/scene/scene';
import type { Integrator } from '../core/integrators/types';
import { IndependentSampler } from '../core/sampler/independent';
import { pixelSeedKey } from '../core/sampler/sampler';
import { luminanceOf } from '../core/math/color';
import { ArrayRecorder, type Tuple3 } from './records';

/** One sample's path from one pixel, flattened to what drawing needs. */
export interface TracedPath {
  /** Camera through each scattering vertex, world space. */
  points: Tuple3[];
  /** Throughput luminance along it — drives brightness, as elsewhere. */
  beta: number;
  /** Did this sample carry any light home? */
  lit: boolean;
  /**
   * Index into `points` of the first vertex that landed ON an emitter, or
   * null if the walk never touched one.
   *
   * `lit` and this are different questions and a figure may want either.
   * `lit` asks whether the sample delivered anything, however it got there —
   * under NEE that is a shadow connection, and no vertex of the walk is on
   * the light at all. This asks where the WALK hit an emitter, which is the
   * event a figure about brute-force path tracing is about: the moment a ray
   * stumbles onto the lamp. Null under NEE for exactly that reason.
   */
  litAt: number | null;
}

export interface PixelGridTrace {
  res: number;
  samples: number;
  /** Indexed [sample][y * res + x]. */
  paths: TracedPath[][];
  /**
   * What each sample contributed ON ITS OWN, in the layout
   *   value[(s * res * res + y * res + x) * 3 + channel]
   * A single sample IS an unbiased estimate of the pixel, so these are
   * directly comparable to the converged image — which is what lets a
   * figure show one landing on the running mean.
   */
  perSample: Float32Array;
  /** The same values summed along the sample axis, for meanAt(). */
  cumulative: Float32Array;
  /** How many of the res² x samples paths carried light. */
  litCount: number;
}

export interface PixelGridOptions {
  scene: Scene;
  integrator: Integrator;
  res: number;
  samples: number;
  seed?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

const aborted = () => Object.assign(new Error('pixel grid trace aborted'), { name: 'AbortError' });

export async function tracePixelGrid(options: PixelGridOptions): Promise<PixelGridTrace> {
  const { scene, integrator, res, samples, seed = 0, signal, onProgress } = options;
  const sampler = new IndependentSampler(seed);
  const stride = res * res * 3;
  const values = new Float32Array(samples * stride);
  const paths: TracedPath[][] = Array.from({ length: samples }, () => new Array(res * res));
  let litCount = 0;
  // The flattened records name their primitive but do not carry its
  // material, so "is this vertex on a lamp?" is answered by name against the
  // scene the walk ran in. buildScene guarantees the names are unique.
  const emissive = new Set(scene.primitives.filter((p) => p.light).map((p) => p.name));

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const pixelIndex = y * res + x;
      for (let s = 0; s < samples; s++) {
        const key = pixelSeedKey(x, y, s);
        sampler.startPixelSample(key);
        const recorder = new ArrayRecorder();
        recorder.beginPath(key);
        integrator.sampleContributions([x, y], sampler, scene, recorder);
        recorder.endPath();
        const record = recorder.records[0]!;

        // The camera walk is the ray the audience follows. (BDPT also grows
        // a light subpath; this figure is about what leaves the eye.)
        const points = record.vertices.map((v) => v.p);
        const last = record.vertices[record.vertices.length - 1];
        const beta = last ? luminanceOf(last.beta[0], last.beta[1], last.beta[2]) : 0;

        let r = 0, g = 0, b = 0;
        for (const c of record.contributions) {
          if (c.kind !== 'sample') continue; // splats land elsewhere on the film
          r += c.value[0];
          g += c.value[1];
          b += c.value[2];
        }
        const lit = r > 0 || g > 0 || b > 0;
        if (lit) litCount += 1;

        // From vertex 1: vertex 0 is the camera itself, which is on no
        // primitive at all.
        let litAt: number | null = null;
        for (let v = 1; v < record.vertices.length; v++) {
          const name = record.vertices[v]!.primitiveName;
          if (name !== null && emissive.has(name)) {
            litAt = v;
            break;
          }
        }
        paths[s]![pixelIndex] = { points, beta, lit, litAt };

        const o = s * stride + pixelIndex * 3;
        values[o] = r;
        values[o + 1] = g;
        values[o + 2] = b;
      }
    }
    onProgress?.((y + 1) * res * samples, res * res * samples);
    // Yield so the progress bar actually paints between rows.
    await new Promise((r) => setTimeout(r));
    if (signal?.aborted) throw aborted();
  }

  // Keep the raw values; accumulate into a copy. Both are wanted — the raw
  // ones to show what a sample contributed, the running totals to show the
  // image it is being averaged into.
  const perSample = values.slice();
  for (let s = 1; s < samples; s++) {
    const base = s * stride;
    const prev = base - stride;
    for (let i = 0; i < stride; i++) values[base + i]! += values[prev + i]!;
  }

  return { res, samples, paths, perSample, cumulative: values, litCount };
}

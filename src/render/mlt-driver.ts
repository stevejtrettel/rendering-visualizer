// MMLT render driver (pbrt v3 §16.4.5's Render). MltRunner bootstraps once
// and then runs any subset of the global chain list — the worker protocol
// maps each render "pass" to a disjoint batch of chain indices, so a pool
// of workers with the SAME seed runs the same deterministic bootstrap
// redundantly and partitions chains without coordination (design-v3 §5).
//
// Seek / find / mutate:
// - BOOTSTRAP: nBootstrap independent states (depth i mod (maxDepth+1),
//   each a fresh MLTSampler seeded by chainSeedKey(i)) are evaluated and
//   their luminances recorded — a census of primary sample space. Their
//   mean gives b, the total image brightness, the one number Metropolis
//   cannot supply itself: splat images are normalized by
//   splatScale = b / mutationsPerPixel at develop time.
// - CHAINS: each chain draws a bootstrap seed proportionally to luminance
//   and REGENERATES that state by re-seeding — chains start distributed by
//   the target, so there is no burn-in. Depth stays fixed per chain.
// - MUTATE: per mutation, both-states expected-value splatting — the
//   proposal weighted by its acceptance probability a, the current state
//   by 1 - a, each normalized to unit luminance. MLT never touches
//   addSample; the standardError view is meaningless here (correlated
//   samples) and stays off.
//
// Accept/reject draws and seed picks come from a DRIVER-side RNG keyed by
// (seed, chainIndex) — they are not part of the Markov state, and per-chain
// keying makes every chain independent of scheduling (worker-safe).
import { PCG32 } from '../core/math/pcg32';
import { hashInts } from '../core/math/hash';
import { U64_ZERO, fromNumber } from '../core/math/u64';
import type { Scene } from '../core/scene/scene';
import { MLTSampler } from '../core/sampler/mlt';
import { chainSeedKey } from '../core/sampler/sampler';
import { mmltState, type MMLTState, type MMLTStateOptions } from '../core/integrators/mmlt';
import type { MisHeuristic } from '../core/integrators/bdpt-mis';
import { NULL_RECORDER, type Recorder } from '../trace/recorder';
import type { Film } from './film';

export interface MLTOptions {
  maxDepth: number;
  nBootstrap: number;
  nChains: number;
  mutationsPerPixel: number; // the quality knob; total = x nPixels
  sigma: number;
  largeStepProbability: number;
  heuristic: MisHeuristic;
  assertWeights: boolean;
  seed: number;
}

export const DEFAULT_MLT_OPTIONS: MLTOptions = {
  maxDepth: 8,
  nBootstrap: 65536,
  nChains: 256,
  mutationsPerPixel: 100,
  sigma: 0.01,
  largeStepProbability: 0.3,
  heuristic: 'balance',
  assertWeights: false,
  seed: 0,
};

export interface MLTResult {
  b: number; // bootstrap estimate of mean image luminance
  totalMutations: number;
  splatScale: number; // pass to film.develop/pixel
}

// Tag for the driver-side RNG streams, disjoint from sampler hashing.
const DRIVER_TAG = 0x4d4c5444; // 'MLTD'

const driverRng = (seed: number, chainIndex: number): PCG32 => {
  const rng = new PCG32(U64_ZERO, U64_ZERO);
  rng.setSequence(hashInts([DRIVER_TAG, seed, chainIndex]), fromNumber(0));
  return rng;
};

// First index whose cumulative weight exceeds target (weights are >= 0).
const pickSeed = (cdf: Float64Array, target: number): number => {
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

export class MltRunner {
  readonly b: number;
  private readonly o: MLTOptions;
  private readonly stateOptions: MMLTStateOptions;
  private readonly nDepths: number;
  private readonly sampler: MLTSampler;
  private readonly cdf: Float64Array;
  private readonly sumW: number;

  constructor(
    private readonly scene: Scene,
    private readonly film: Film,
    options: Partial<MLTOptions> = {},
  ) {
    this.o = { ...DEFAULT_MLT_OPTIONS, ...options };
    this.stateOptions = {
      width: film.width,
      height: film.height,
      heuristic: this.o.heuristic,
      assertWeights: this.o.assertWeights,
    };
    this.nDepths = this.o.maxDepth + 1;
    this.sampler = new MLTSampler(this.o.seed, {
      sigma: this.o.sigma,
      largeStepProbability: this.o.largeStepProbability,
    });

    // The bootstrap census. Variance is dominated by rare-but-huge weights
    // (e.g. depth 0: a raster sample landing on the light), so b needs the
    // full default census size — see the sizing note in tests/mmlt.test.ts.
    this.cdf = new Float64Array(this.o.nBootstrap);
    let sumW = 0;
    for (let i = 0; i < this.o.nBootstrap; i++) {
      this.sampler.startPixelSample(chainSeedKey(i));
      sumW += mmltState(this.scene, this.sampler, i % this.nDepths, this.stateOptions, NULL_RECORDER)
        .L.luminance();
      this.cdf[i] = sumW;
    }
    this.sumW = sumW;
    // Each depth's integral is estimated by nBootstrap/nDepths of the
    // samples; b sums the per-depth means.
    this.b = (sumW / this.o.nBootstrap) * this.nDepths;
  }

  // Run chains [firstChain, firstChain + count), each for mutationsPerChain
  // mutations, splatting into the film. Chain behavior depends only on
  // (seed, chain index) — batches can run on any worker in any order.
  runChains(
    firstChain: number,
    count: number,
    mutationsPerChain: number,
    recorder: Recorder = NULL_RECORDER,
  ): void {
    if (this.b === 0) return; // black scene: nothing to distribute
    for (let c = firstChain; c < firstChain + count; c++) {
      const rng = driverRng(this.o.seed, c);
      const seedIndex = pickSeed(this.cdf, rng.nextFloat() * this.sumW);
      const depth = seedIndex % this.nDepths;
      const key = chainSeedKey(seedIndex);

      // Regenerate the bootstrap state — seed replay, not storage. Its
      // luminance is positive by construction (picked proportionally).
      // Recorded as a chain-start record (mutation stays null): the chain
      // visualizer needs the starting path, not only the proposals.
      this.sampler.startPixelSample(key);
      recorder.beginPath(key);
      let cur: MMLTState = mmltState(this.scene, this.sampler, depth, this.stateOptions, recorder);
      recorder.endPath();
      let curLum = cur.L.luminance();

      for (let m = 0; m < mutationsPerChain; m++) {
        this.sampler.startIteration();
        recorder.beginPath(key);
        const prop = mmltState(this.scene, this.sampler, depth, this.stateOptions, recorder);
        const propLum = prop.L.luminance();
        const a = curLum > 0 ? Math.min(1, propLum / curLum) : 1;

        // Both-states expected-value splatting, unit-luminance colors.
        if (propLum > 0 && a > 0) {
          const value = prop.L.scale(a / propLum);
          this.film.splat(prop.raster, value);
          recorder.contribution({ kind: 'splat', raster: prop.raster, value });
        }
        if (curLum > 0 && a < 1) {
          const value = cur.L.scale((1 - a) / curLum);
          this.film.splat(cur.raster, value);
          recorder.contribution({ kind: 'splat', raster: cur.raster, value });
        }

        const accepted = rng.nextFloat() < a;
        recorder.mutation({
          index: m,
          type: this.sampler.isLargeStep ? 'large' : 'small',
          accepted,
          a,
          proposalLum: propLum,
          currentLum: curLum,
        });
        recorder.endPath();
        if (accepted) {
          this.sampler.accept();
          cur = prop;
          curLum = propLum;
        } else {
          this.sampler.reject();
        }
      }
    }
  }
}

// One-call driver over the full chain list (tests, offline renders).
export function runMlt(
  scene: Scene,
  film: Film,
  options: Partial<MLTOptions> = {},
  recorder: Recorder = NULL_RECORDER,
  onChainDone?: (chainIndex: number) => void,
): MLTResult {
  const o = { ...DEFAULT_MLT_OPTIONS, ...options };
  const runner = new MltRunner(scene, film, o);
  const nPixels = film.width * film.height;
  const targetMutations = o.mutationsPerPixel * nPixels;
  const perChain = Math.floor(targetMutations / o.nChains);
  const remainder = targetMutations - perChain * o.nChains; // first chains take one extra
  for (let c = 0; c < o.nChains; c++) {
    runner.runChains(c, 1, perChain + (c < remainder ? 1 : 0), recorder);
    onChainDone?.(c);
  }
  return { b: runner.b, totalMutations: targetMutations, splatScale: runner.b / o.mutationsPerPixel };
}

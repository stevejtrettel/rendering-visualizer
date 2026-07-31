// Multiplexed MLT state evaluation (Hachisuka et al. 2014; pbrt v3 §16.4.5's
// MLTIntegrator::L). One Markov state = one BDPT strategy applied at one
// raster position, all encoded in primary sample space: camera-stream dim 0
// picks the strategy for this chain's fixed depth, dims 1-2 are the raster,
// and everything after is ordinary walk/connection consumption. The
// integrator machinery below is BDPT's, unchanged — the Metropolis layer
// swaps only where the randomness comes from (the design's V0 promise).
//
// Conventions (design-v3.md):
// - depth is FIXED per chain; s and t mutate within nStrategies = depth + 2
//   (depth 0 forces (0, 2) and draws no strategy dim — fixed layout per
//   chain, matching pbrt).
// - Subpaths are generated at EXACTLY t and s vertices (walk caps trimmed,
//   roulette off); a shortfall means this strategy cannot form here and the
//   state evaluates to black.
// - The MIS heuristic defaults to balance: the multiplexed strategy pick is
//   one-sample MIS, where balance is exactly optimal (Veach Thm 9.4).
// - The returned L is the MIS-weighted contribution x nStrategies (the
//   one-sample estimator's inverse pick probability).
import { Color } from '../math/color';
import type { Sample2D } from '../math/sampling';
import type { Scene } from '../scene/scene';
import type { Sampler } from '../sampler/sampler';
import { CAMERA_STREAM, CONNECTION_STREAM } from '../sampler/sampler';
import type { Recorder } from '../../trace/recorder';
import type { PathVertex } from './vertex';
import type { MisHeuristic } from './bdpt-mis';
import {
  DEFAULT_BDPT_OPTIONS,
  cameraSubpathFromRaster,
  connectStrategy,
  generateLightSubpath,
  type BDPTOptions,
  type ConnectionSample,
} from './bdpt';

export interface MMLTStateOptions {
  width: number; // film size: dims 1-2 map to [0, width) x [0, height)
  height: number;
  heuristic: MisHeuristic; // default balance (one-sample MIS, Thm 9.4)
  assertWeights: boolean;
}

export const DEFAULT_MMLT_STATE_OPTIONS: Omit<MMLTStateOptions, 'width' | 'height'> = {
  heuristic: 'balance',
  assertWeights: false,
};

// The evaluated state: L is the splat value before the global b /
// mutationsPerPixel normalization; raster the splat target (for t = 1 the
// connection dictates it via sampleWi, not the mutated dims).
export interface MMLTState {
  L: Color;
  raster: Sample2D;
  s: number;
  t: number;
}

const walkOpts = (options: MMLTStateOptions, maxBounces: number): BDPTOptions => ({
  ...DEFAULT_BDPT_OPTIONS,
  maxBounces,
  rrStartDepth: Number.POSITIVE_INFINITY, // exact-length subpaths, no roulette
  heuristic: options.heuristic,
  assertWeights: options.assertWeights,
});

export function mmltState(
  scene: Scene,
  sampler: Sampler,
  depth: number,
  options: MMLTStateOptions,
  recorder: Recorder,
): MMLTState {
  sampler.startStream(CAMERA_STREAM);
  let nStrategies: number;
  let s: number;
  let t: number;
  if (depth === 0) {
    nStrategies = 1;
    s = 0;
    t = 2;
  } else {
    nStrategies = depth + 2;
    s = Math.min(Math.floor(sampler.next1D() * nStrategies), nStrategies - 1);
    t = nStrategies - s; // t >= 1 always; (1,1) only at depth 0, where (0,2) is forced
  }
  const raster: Sample2D = [sampler.next1D() * options.width, sampler.next1D() * options.height];
  const black = (): MMLTState => ({ L: Color.BLACK, raster, s, t });

  const cameraVs = cameraSubpathFromRaster(scene, raster, sampler, recorder, walkOpts(options, t - 1));
  if (cameraVs.length !== t) return black();

  let lightVs: PathVertex[] = [];
  if (s > 0) {
    lightVs = generateLightSubpath(scene, sampler, recorder, walkOpts(options, s - 1));
    if (lightVs.length !== s) return black();
  }

  sampler.startStream(CONNECTION_STREAM);
  const u: ConnectionSample | null =
    s === 1 ? { select: sampler.next1D(), point: sampler.next2D() } : null;
  const outcome = connectStrategy(scene, cameraVs, lightVs, s, t, walkOpts(options, depth), u);
  if (!outcome) return black();
  if (outcome.connection) recorder.connection({ s, t, ...outcome.connection, weight: outcome.weight });

  return {
    L: outcome.unweighted.scale(outcome.weight * nStrategies),
    raster: t === 1 ? outcome.raster! : raster,
    s,
    t,
  };
}

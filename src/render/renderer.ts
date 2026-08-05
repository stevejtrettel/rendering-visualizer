// One interface over the three execution models.
//
// Most integrators are per-pixel and stateless between passes, so they
// implement `Integrator` and ride `renderPass`. MMLT owns a bootstrap and a
// chain list; ReSTIR owns per-pixel reservoirs that survive across passes.
// Both are legitimate reasons not to be an `Integrator` — but they were not
// a reason to have no common type at all, which is what left worker.ts
// branching on `if (mlt) / else if (restir) / else`, protocol.ts carrying an
// `mltB?` field, and pool.ts taking `activeWorkers` on faith.
//
// Everything algorithm-specific now lives behind this interface: how a pass
// is spent, how splats are normalized, and whether a standard-error view
// means anything.
import type { Scene } from '../core/scene/scene';
import type { Recorder } from '../trace/recorder';
import { NULL_RECORDER } from '../trace/recorder';
import { IndependentSampler } from '../core/sampler/independent';
import { UnidirectionalPT } from '../core/integrators/pt';
import { SingleTermPT } from '../core/integrators/pt-term';
import { NEEPathTracer } from '../core/integrators/pt-nee';
import { SMSPathTracer } from '../core/integrators/pt-sms';
import { BDPT } from '../core/integrators/bdpt';
import { DEFAULT_WALK_OPTIONS } from '../core/integrators/walk';
import type { Integrator } from '../core/integrators/types';
import { uniformSampledScene } from '../core/materials/uniform-sampled';
import { Film } from './film';
import { renderPass } from './driver';
import { MltRunner } from './mlt-driver';
import { RestirRunner } from './restir-driver';
import type { IntegratorDescription, IntegratorName } from './protocol';

export interface DevelopedFrame {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  errorRgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface Renderer {
  // Spend one pass. `index` is the sample index for per-pixel integrators,
  // a disjoint mutation BATCH index for MMLT, and advisory for ReSTIR
  // (whose runner owns its own pass sequence).
  pass(index: number, recorder?: Recorder): void;

  // Splat normalization factored so that splatScale = splatNorm /
  // totalPasses. Factored this way because a worker pool merges films from
  // several workers and scales by a TOTAL pass count no single worker
  // knows — this is the piece that used to travel as `mltB`.
  splatNorm(): number;

  // This renderer's own film, developed after `totalPasses` passes.
  develop(totalPasses: number): DevelopedFrame;
}

// Whether pass k may be rendered independently of pass k-1. False only for
// ReSTIR, where pass k consumes pass k-1's reservoirs: such a renderer must
// run alone with sequential passes, and sample-parallel splitting across a
// pool would silently break the algorithm. Pure and main-thread-safe, so
// the pool can consult it before spawning anything.
export function passesAreExchangeable(name: IntegratorName): boolean {
  return name !== 'restir';
}

// Whether a per-pixel standard-error view is meaningful. MMLT's splats are
// a correlated Markov chain, so there is nothing honest to show.
function hasErrorView(name: IntegratorName): boolean {
  return name !== 'mmlt';
}

// Flat dark frame, standing in for the error view where none is meaningful.
function flatErrorFrame(pixels: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    out[i * 4] = 24;
    out[i * 4 + 1] = 24;
    out[i * 4 + 2] = 28;
    out[i * 4 + 3] = 255;
  }
  return out;
}

// Develop any film under a named integrator's conventions. Exported so the
// main thread can develop a POOL-MERGED film — which no Renderer instance
// owns — without branching on the algorithm itself.
export function developFilm(
  name: IntegratorName,
  film: Film,
  totalPasses: number,
  splatNorm: number,
): DevelopedFrame {
  const passes = Math.max(1, totalPasses);
  return {
    rgba: film.develop({ splatScale: splatNorm / passes }),
    errorRgba: hasErrorView(name) ? film.developError() : flatErrorFrame(film.width * film.height),
  };
}

// --- per-pixel integrators (pt, pt-term, pt-nee, pt-sms, bdpt) ---

// Drop the keys a description left undefined, so each integrator's own
// defaults survive rather than being overwritten with `undefined`.
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function makeIntegrator(spec: IntegratorDescription): Integrator {
  switch (spec.name) {
    case 'bdpt':
      return new BDPT(
        defined({
          maxBounces: spec.maxBounces,
          rrStartDepth: spec.rrStartDepth,
          heuristic: spec.heuristic,
        }),
      );
    case 'pt-sms':
      // Interactive panes run the UNBIASED estimator config by default:
      // measured (design-v5 §V5b checkpoint-2 note) 7× cheaper per pass than
      // the biased-M8 library default AND closer to reference (−1.1% vs
      // −1.5% zone) — a failed first walk ends the estimate. A biased-M8
      // pass on cornell-glass at 320² is ~140 s, which reads as a dead pane.
      // It is a DEFAULT here rather than a hard override, so a figure that
      // wants to show the ladder can ask for 'biasedM'.
      return new SMSPathTracer({
        estimator: 'unbiased',
        ...defined({ maxBounces: spec.maxBounces, rrStartDepth: spec.rrStartDepth, estimator: spec.estimator }),
      });
    case 'pt-nee':
      return new NEEPathTracer(defined({ maxBounces: spec.maxBounces, rrStartDepth: spec.rrStartDepth }));
    case 'pt-term':
      return new SingleTermPT(
        defined({ maxBounces: spec.maxBounces, continueProb: spec.continueProb }),
      );
    case 'pt':
      return new UnidirectionalPT({
        ...DEFAULT_WALK_OPTIONS,
        ...defined({ maxBounces: spec.maxBounces, rrStartDepth: spec.rrStartDepth }),
      });
    default:
      // mmlt and restir are not Integrators — createRenderer routes them to
      // their own drivers before reaching here.
      throw new Error(`makeIntegrator: ${spec.name} is driver-backed, not an Integrator`);
  }
}

/**
 * The scene this estimator actually samples against. Uniform direction
 * sampling is an estimator choice implemented as a material decorator, so
 * this is the one seam where the two meet — the scene library stays
 * untouched and every caller gets the behaviour for free.
 */
function sceneFor(spec: IntegratorDescription, scene: Scene): Scene {
  return 'directions' in spec && spec.directions === 'uniform'
    ? uniformSampledScene(scene)
    : scene;
}

class IntegratorRenderer implements Renderer {
  private readonly integrator: Integrator;
  private readonly sampler: IndependentSampler;

  private readonly name: IntegratorName;
  private readonly scene: Scene;

  constructor(
    spec: IntegratorDescription,
    scene: Scene,
    private readonly film: Film,
    seed: number,
  ) {
    this.name = spec.name;
    this.scene = sceneFor(spec, scene);
    this.integrator = makeIntegrator(spec);
    this.sampler = new IndependentSampler(seed);
  }

  pass(index: number, recorder: Recorder = NULL_RECORDER): void {
    renderPass(this.scene, this.integrator, this.sampler, this.film, index, recorder);
  }

  // BDPT's t = 1 light-tracing splats average over passes: splatScale = 1/spp.
  splatNorm(): number {
    return 1;
  }

  develop(totalPasses: number): DevelopedFrame {
    return developFilm(this.name, this.film, totalPasses, this.splatNorm());
  }
}

// --- MMLT ---

// Each pass spends ~nPixels mutations, split into chains of roughly this
// many mutations each. Long chains keep the footprint noise low; the exact
// split is recomputed per resolution.
const TARGET_CHAIN_LENGTH = 4096;

class MltRenderer implements Renderer {
  private readonly runner: MltRunner;
  private readonly chainsPerBatch: number;
  private readonly mutationsPerChain: number;

  constructor(
    private readonly film: Film,
    scene: Scene,
    seed: number,
    maxDepth: number | undefined,
  ) {
    this.runner = new MltRunner(scene, film, {
      seed,
      ...(maxDepth !== undefined ? { maxDepth } : {}),
    });
    const nPixels = film.width * film.height;
    this.chainsPerBatch = Math.max(1, Math.round(nPixels / TARGET_CHAIN_LENGTH));
    this.mutationsPerChain = Math.ceil(nPixels / this.chainsPerBatch);
  }

  get b(): number {
    return this.runner.b;
  }

  pass(index: number, recorder: Recorder = NULL_RECORDER): void {
    this.runner.runChains(
      index * this.chainsPerBatch, this.chainsPerBatch, this.mutationsPerChain, recorder,
    );
  }

  // The splat-only image normalizes by b over the mutations per pixel
  // actually spent. Batches overshoot nPixels slightly, so this divides by
  // the real budget rather than by nPixels — which is why callers no longer
  // approximate it as b/totalSpp.
  splatNorm(): number {
    const nPixels = this.film.width * this.film.height;
    return (this.runner.b * nPixels) / (this.chainsPerBatch * this.mutationsPerChain);
  }

  develop(totalPasses: number): DevelopedFrame {
    return developFilm('mmlt', this.film, totalPasses, this.splatNorm());
  }
}

// --- ReSTIR ---

class RestirRenderer implements Renderer {
  private readonly runner: RestirRunner;

  constructor(
    private readonly film: Film,
    scene: Scene,
    seed: number,
    maxDepth: number | undefined,
  ) {
    this.runner = new RestirRunner(scene, film, {
      seed,
      ...(maxDepth !== undefined ? { maxBounces: maxDepth } : {}),
    });
  }

  // The pass index is advisory: the runner counts its own passes, because
  // pass k consumes pass k-1's reservoirs (passesAreExchangeable is false).
  pass(_index: number, recorder: Recorder = NULL_RECORDER): void {
    this.runner.pass(recorder);
  }

  splatNorm(): number {
    return 1; // shading uses addSample only; the splat planes stay zero
  }

  develop(totalPasses: number): DevelopedFrame {
    return developFilm('restir', this.film, totalPasses, this.splatNorm());
  }
}

export interface RendererOptions {
  seed: number;
}

/**
 * Turn an estimator DESCRIPTION plus a live scene into a running renderer —
 * the counterpart to `buildScene`, and the one place a description becomes
 * objects. See `IntegratorDescription` in protocol.ts for why the estimator
 * is described rather than named.
 */
export function createRenderer(
  spec: IntegratorDescription,
  scene: Scene,
  film: Film,
  options: RendererOptions,
): Renderer {
  if (spec.name === 'mmlt') return new MltRenderer(film, scene, options.seed, spec.maxBounces);
  if (spec.name === 'restir') return new RestirRenderer(film, scene, options.seed, spec.maxBounces);
  return new IntegratorRenderer(spec, scene, film, options.seed);
}

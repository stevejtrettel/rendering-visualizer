// Web Worker entry: builds the scene from its description, renders passes on
// request, ships back developed frames. The film stays worker-side; the main
// thread re-traces individual paths itself when the user inspects a pixel
// (determinism is the storage — nothing per-path crosses over).
//
// MMLT mode: init runs the deterministic bootstrap (redundant across
// workers — same seed, same census, same b); each 'pass' runs one disjoint
// batch of chains worth one mutation per pixel, so pass accounting works
// like spp and pooled films merge by summation exactly as for the other
// integrators.
import { buildScene, type Scene } from '../core/scene/scene';
import { IndependentSampler } from '../core/sampler/independent';
import { UnidirectionalPT } from '../core/integrators/pt';
import { NEEPathTracer } from '../core/integrators/pt-nee';
import { SMSPathTracer } from '../core/integrators/pt-sms';
import { BDPT } from '../core/integrators/bdpt';
import { DEFAULT_WALK_OPTIONS } from '../core/integrators/walk';
import type { Integrator } from '../core/integrators/types';
import { Film } from './film';
import { renderPass } from './driver';
import { MltRunner } from './mlt-driver';
import { RestirRunner } from './restir-driver';
import type { MainToWorker, PassDoneMessage } from './protocol';

// MMLT batch geometry: each pass spends ~nPixels mutations, split into
// chains of roughly this many mutations each. Long chains keep the
// footprint noise low; the exact split is recomputed per resolution.
const TARGET_CHAIN_LENGTH = 4096;

let scene: Scene | null = null;
let film: Film | null = null;
let sampler: IndependentSampler | null = null;
let integrator: Integrator = new UnidirectionalPT();
let mlt: MltRunner | null = null;
let restir: RestirRunner | null = null;
let chainsPerBatch = 0;
let mutationsPerChain = 0;
let epoch = 0;
let replyMode: 'rgba' | 'film' = 'rgba';
let passesDone = 0;

// Flat dark frame: the standard-error view assumes independent samples,
// which MMLT's correlated splats are not — there is nothing honest to show.
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

self.onmessage = (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;
  if (msg.type === 'init') {
    scene = buildScene(msg.description, msg.width, msg.height);
    film = new Film(msg.width, msg.height);
    sampler = new IndependentSampler(msg.seed);
    const depth = msg.maxDepth;
    restir = null;
    if (msg.integrator === 'mmlt') {
      mlt = new MltRunner(scene, film, { seed: msg.seed, ...(depth !== undefined ? { maxDepth: depth } : {}) });
      const nPixels = msg.width * msg.height;
      chainsPerBatch = Math.max(1, Math.round(nPixels / TARGET_CHAIN_LENGTH));
      mutationsPerChain = Math.ceil(nPixels / chainsPerBatch);
    } else if (msg.integrator === 'restir') {
      // Non-exchangeable passes: callers must schedule this worker alone
      // (pool activeWorkers = 1); msg.sampleIndex is advisory — the runner
      // owns the pass sequence.
      mlt = null;
      restir = new RestirRunner(scene, film, {
        seed: msg.seed,
        ...(depth !== undefined ? { maxBounces: depth } : {}),
      });
    } else {
      mlt = null;
      integrator =
        msg.integrator === 'bdpt'
          ? new BDPT(depth !== undefined ? { maxBounces: depth } : {})
          : msg.integrator === 'pt-sms'
            ? new SMSPathTracer(depth !== undefined ? { maxBounces: depth } : {})
            : msg.integrator === 'pt-nee'
              ? new NEEPathTracer(depth !== undefined ? { maxBounces: depth } : {})
              : new UnidirectionalPT(depth !== undefined ? { ...DEFAULT_WALK_OPTIONS, maxBounces: depth } : DEFAULT_WALK_OPTIONS);
    }
    epoch = msg.epoch ?? 0;
    replyMode = msg.reply ?? 'rgba';
    passesDone = 0;
    return;
  }
  if (msg.type === 'pass') {
    if (!scene || !film || !sampler) throw new Error('worker: pass before init');
    const t0 = performance.now();
    if (mlt) {
      mlt.runChains(msg.sampleIndex * chainsPerBatch, chainsPerBatch, mutationsPerChain);
    } else if (restir) {
      restir.pass();
    } else {
      renderPass(scene, integrator, sampler, film, msg.sampleIndex);
    }
    const passMillis = performance.now() - t0;
    passesDone += 1;
    if (replyMode === 'film') {
      const snapshot = new Float64Array(film.data); // copy, then transfer
      (self as unknown as Worker).postMessage(
        {
          type: 'filmPass',
          epoch,
          sampleIndex: msg.sampleIndex,
          passesDone,
          passMillis,
          film: snapshot,
          ...(mlt ? { mltB: mlt.b } : {}),
        },
        [snapshot.buffer],
      );
      return;
    }
    // splatScale: BDPT's t=1 light-tracing splats average over passes
    // (1/spp); MMLT's splat-only image normalizes by b over the mutations
    // per pixel actually spent (batches may overshoot nPixels slightly).
    const nPixels = film.width * film.height;
    const splatScale = mlt
      ? (mlt.b * nPixels) / (passesDone * chainsPerBatch * mutationsPerChain)
      : 1 / passesDone;
    const rgba = film.develop({ splatScale });
    const errorRgba = mlt ? flatErrorFrame(nPixels) : film.developError();
    const reply: PassDoneMessage = {
      type: 'passDone',
      epoch,
      sampleIndex: msg.sampleIndex,
      samplesPerPixel: msg.sampleIndex + 1,
      passMillis,
      rgba,
      errorRgba,
      ...(mlt ? { mltB: mlt.b } : {}),
    };
    (self as unknown as Worker).postMessage(reply, [rgba.buffer, errorRgba.buffer]);
  }
};

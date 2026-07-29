// Web Worker entry: builds the scene from its description, renders passes on
// request, ships back developed frames. The film stays worker-side; the main
// thread re-traces individual paths itself when the user inspects a pixel
// (determinism is the storage — nothing per-path crosses over).
import { buildScene, type Scene } from '../core/scene/scene';
import { IndependentSampler } from '../core/sampler/independent';
import { UnidirectionalPT } from '../core/integrators/pt';
import { NEEPathTracer } from '../core/integrators/pt-nee';
import { BDPT } from '../core/integrators/bdpt';
import type { Integrator } from '../core/integrators/types';
import { Film } from './film';
import { renderPass } from './driver';
import type { MainToWorker, PassDoneMessage } from './protocol';

let scene: Scene | null = null;
let film: Film | null = null;
let sampler: IndependentSampler | null = null;
let integrator: Integrator = new UnidirectionalPT();
let epoch = 0;
let replyMode: 'rgba' | 'film' = 'rgba';
let passesDone = 0;

self.onmessage = (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;
  if (msg.type === 'init') {
    scene = buildScene(msg.description, msg.width, msg.height);
    film = new Film(msg.width, msg.height);
    sampler = new IndependentSampler(msg.seed);
    integrator =
      msg.integrator === 'bdpt'
        ? new BDPT()
        : msg.integrator === 'pt-nee'
          ? new NEEPathTracer()
          : new UnidirectionalPT();
    epoch = msg.epoch ?? 0;
    replyMode = msg.reply ?? 'rgba';
    passesDone = 0;
    return;
  }
  if (msg.type === 'pass') {
    if (!scene || !film || !sampler) throw new Error('worker: pass before init');
    const t0 = performance.now();
    renderPass(scene, integrator, sampler, film, msg.sampleIndex);
    const passMillis = performance.now() - t0;
    passesDone += 1;
    if (replyMode === 'film') {
      const snapshot = new Float64Array(film.data); // copy, then transfer
      (self as unknown as Worker).postMessage(
        { type: 'filmPass', epoch, sampleIndex: msg.sampleIndex, passesDone, passMillis, film: snapshot },
        [snapshot.buffer],
      );
      return;
    }
    const rgba = film.develop();
    const errorRgba = film.developError();
    const reply: PassDoneMessage = {
      type: 'passDone',
      epoch,
      sampleIndex: msg.sampleIndex,
      samplesPerPixel: msg.sampleIndex + 1,
      passMillis,
      rgba,
      errorRgba,
    };
    (self as unknown as Worker).postMessage(reply, [rgba.buffer, errorRgba.buffer]);
  }
};

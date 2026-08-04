// Web Worker entry: build the scene from its description, render passes on
// request, ship back either developed frames or raw film data. The film
// stays worker-side; the main thread re-traces individual paths itself when
// the user inspects a pixel (determinism is the storage — nothing per-path
// crosses over).
//
// Everything algorithm-specific lives behind `Renderer` (see renderer.ts):
// how a pass is spent, how splats are normalized, whether an error view
// means anything. This file is only the message plumbing.
import { buildScene } from '../core/scene/scene';
import { Film } from './film';
import { createRenderer, type Renderer } from './renderer';
import type { MainToWorker, PassDoneMessage } from './protocol';

let film: Film | null = null;
let renderer: Renderer | null = null;
let epoch = 0;
let replyMode: 'rgba' | 'film' = 'rgba';
let passesDone = 0;

self.onmessage = (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;

  if (msg.type === 'init') {
    const scene = buildScene(msg.description, msg.width, msg.height);
    film = new Film(msg.width, msg.height);
    renderer = createRenderer(msg.integrator, scene, film, {
      seed: msg.seed,
      ...(msg.maxDepth !== undefined ? { maxDepth: msg.maxDepth } : {}),
    });
    epoch = msg.epoch ?? 0;
    replyMode = msg.reply ?? 'rgba';
    passesDone = 0;
    return;
  }

  if (msg.type === 'pass') {
    if (!film || !renderer) throw new Error('worker: pass before init');
    const t0 = performance.now();
    renderer.pass(msg.sampleIndex);
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
          splatNorm: renderer.splatNorm(),
        },
        [snapshot.buffer],
      );
      return;
    }

    const { rgba, errorRgba } = renderer.develop(passesDone);
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

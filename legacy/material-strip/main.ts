// SHOWS: one sphere per MaterialDescription kind, lit identically, in a single
// render. The four spheres are the entire material library — the labels under
// the canvas name them left to right, and the note beneath names the gaps.
import { SCENES } from '../../src/scenes/registry';
import type { IntegratorName, MainToWorker, PassDoneMessage } from '../../src/render/protocol';

// --- Figure spec ---
const SCENE = SCENES['material-row'];
const INTEGRATOR: IntegratorName = 'pt-nee';
const WIDTH = 512; // 2:1 film — the wide scene of the registry
const HEIGHT = 256;
const DISPLAY_WIDTH = 1024;
const TARGET_SPP = 512;
const SEED = 0;

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
canvas.width = WIDTH;
canvas.height = HEIGHT;
canvas.style.width = `${DISPLAY_WIDTH}px`;
canvas.style.height = `${(DISPLAY_WIDTH * HEIGHT) / WIDTH}px`;
const ctx = canvas.getContext('2d')!;
const statusEl = document.getElementById('status')!;

const worker = new Worker(new URL('../../src/render/worker.ts', import.meta.url), { type: 'module' });
const post = (m: MainToWorker) => worker.postMessage(m);

worker.onmessage = (event: MessageEvent<PassDoneMessage>) => {
  const msg = event.data;
  ctx.putImageData(new ImageData(msg.rgba, WIDTH, HEIGHT), 0, 0);
  const done = msg.samplesPerPixel >= TARGET_SPP;
  statusEl.textContent =
    `${INTEGRATOR} · ${WIDTH}×${HEIGHT} · ${msg.samplesPerPixel}/${TARGET_SPP} spp` +
    `${done ? ' · complete' : ''}`;
  if (!done) post({ type: 'pass', sampleIndex: msg.samplesPerPixel });
};

post({ type: 'init', description: SCENE, width: WIDTH, height: HEIGHT, seed: SEED, integrator: INTEGRATOR });
post({ type: 'pass', sampleIndex: 0 });

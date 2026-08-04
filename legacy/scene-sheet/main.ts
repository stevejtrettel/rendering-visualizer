// SHOWS: every registry scene at once, equal resolution and equal samples.
// One worker per scene, all progressing together, so a new or edited scene
// gets judged against the others immediately.
import { loadSceneRegistry } from '../../src/scenes/assets';
import type { IntegratorName, MainToWorker, PassDoneMessage } from '../../src/render/protocol';

// --- Figure spec ---
const INTEGRATOR: IntegratorName = 'pt-nee';
const RES = 128;
const DISPLAY = 224;
const TARGET_SPP = 64;
const SEED = 0;
// The one non-square scene in the registry renders on a 2:1 film.
const WIDE = new Set(['material-row']);

const SCENES = await loadSceneRegistry();
const sheetEl = document.getElementById('sheet')!;
const statusEl = document.getElementById('status')!;
const spp = new Map<string, number>();

function report(): void {
  const counts = [...spp.values()];
  const min = counts.length > 0 ? Math.min(...counts) : 0;
  statusEl.textContent =
    min >= TARGET_SPP
      ? `${spp.size} scenes · ${TARGET_SPP} spp each · complete`
      : `${spp.size} scenes · ${INTEGRATOR} · ${min}/${TARGET_SPP} spp (slowest)`;
}

for (const [name, description] of Object.entries(SCENES)) {
  const width = WIDE.has(name) ? RES * 2 : RES;
  const height = RES;

  const tile = document.createElement('div');
  tile.className = 'tile';
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${WIDE.has(name) ? DISPLAY * 2 : DISPLAY}px`;
  canvas.style.height = `${DISPLAY}px`;
  const cap = document.createElement('span');
  cap.className = 'cap';
  cap.textContent = name;
  tile.append(canvas, cap);
  sheetEl.appendChild(tile);

  const ctx = canvas.getContext('2d')!;
  const worker = new Worker(new URL('../../src/render/worker.ts', import.meta.url), { type: 'module' });
  const post = (m: MainToWorker) => worker.postMessage(m);
  worker.onmessage = (event: MessageEvent<PassDoneMessage>) => {
    const msg = event.data;
    ctx.putImageData(new ImageData(msg.rgba, width, height), 0, 0);
    spp.set(name, msg.samplesPerPixel);
    cap.textContent = `${name} · ${msg.samplesPerPixel} spp`;
    report();
    if (msg.samplesPerPixel < TARGET_SPP) post({ type: 'pass', sampleIndex: msg.samplesPerPixel });
  };
  post({ type: 'init', description, width, height, seed: SEED, integrator: INTEGRATOR });
  post({ type: 'pass', sampleIndex: 0 });
}

report();

// SHOWS: the same scene converging under all three integrators at once — equal
// seed, equal samples, one worker each. They must agree in the limit (that is
// the cross-integrator convergence property the tests assert), so any lasting
// difference is noise, and the per-pane ms/pass is the price each one charges.
import { SCENES, type SceneName } from '../_shared/scenes';
import type { IntegratorName, MainToWorker, PassDoneMessage } from '../../src/render/protocol';

// --- Figure spec ---
const SCENE_NAME: SceneName = 'cornell';
const INTEGRATORS: readonly IntegratorName[] = ['pt', 'pt-nee', 'bdpt', 'mmlt', 'restir'];
const LABELS: Record<IntegratorName, string> = {
  pt: 'PT (BSDF sampling only)',
  'pt-nee': 'PT + NEE (MIS)',
  bdpt: 'BDPT',
  mmlt: 'MMLT (Metropolis)',
  restir: 'ReSTIR (reservoir reuse)',
};
// One shared depth cap: four estimators of the SAME truncated integral —
// any lasting difference between panes is noise or a bug, never transport
// the caps admit unequally. (MMLT's "spp" is mutations/pixel.)
const MAX_DEPTH = 8;
const RES = 256;
const DISPLAY = 400;
const TARGET_SPP = 512;
const SEED = 0;

const description = SCENES[SCENE_NAME];
const statusEl = document.getElementById('status')!;
const panesEl = document.getElementById('panes')!;

interface Pane {
  name: IntegratorName;
  spp: number;
  avgMillis: number;
}

const panes: Pane[] = INTEGRATORS.map((name) => {
  const pane: Pane = { name, spp: 0, avgMillis: 0 };

  const holder = document.createElement('div');
  holder.className = 'pane';
  const canvas = document.createElement('canvas');
  canvas.width = RES;
  canvas.height = RES;
  canvas.style.width = `${DISPLAY}px`;
  canvas.style.height = `${DISPLAY}px`;
  const cap = document.createElement('span');
  cap.className = 'cap';
  cap.textContent = LABELS[name];
  holder.append(canvas, cap);
  panesEl.appendChild(holder);

  const ctx = canvas.getContext('2d')!;
  const worker = new Worker(new URL('../../src/render/worker.ts', import.meta.url), { type: 'module' });
  const post = (m: MainToWorker) => worker.postMessage(m);
  let totalMillis = 0;
  worker.onmessage = (event: MessageEvent<PassDoneMessage>) => {
    const msg = event.data;
    ctx.putImageData(new ImageData(msg.rgba, RES, RES), 0, 0);
    totalMillis += msg.passMillis;
    pane.spp = msg.samplesPerPixel;
    pane.avgMillis = totalMillis / pane.spp;
    cap.textContent = `${LABELS[name]} · ${pane.spp} ${name === 'mmlt' ? 'mpp' : 'spp'} · ${pane.avgMillis.toFixed(0)} ms/pass`;
    report();
    if (msg.samplesPerPixel < TARGET_SPP) post({ type: 'pass', sampleIndex: msg.samplesPerPixel });
  };
  post({ type: 'init', description, width: RES, height: RES, seed: SEED, integrator: name, maxDepth: MAX_DEPTH });
  post({ type: 'pass', sampleIndex: 0 });
  return pane;
});

function report(): void {
  const slowest = Math.min(...panes.map((p) => p.spp));
  // Cost relative to the cheapest estimator, once every pane has timed a pass.
  const cheapest = Math.min(...panes.map((p) => p.avgMillis || Infinity));
  const costs = panes
    .map((p) => (p.avgMillis > 0 ? `${p.name} ×${(p.avgMillis / cheapest).toFixed(1)}` : null))
    .filter(Boolean)
    .join(' · ');
  statusEl.textContent =
    (slowest >= TARGET_SPP
      ? `${SCENE_NAME} · ${RES}² · ${TARGET_SPP} spp all three · complete`
      : `${SCENE_NAME} · ${RES}² · ${slowest}/${TARGET_SPP} spp (slowest pane)`) +
    (costs ? ` · cost per pass: ${costs}` : '');
}

report();

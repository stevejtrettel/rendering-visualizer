// D5: the standing integrator-comparison harness. Two workers render the
// same scene; snapshots are kept at exponentially spaced sample counts
// (1, 2, 4, … spp). A wipe compositor shows integrator A left of the
// divider and B right of it — scrub through snapshots (equal-sample or
// equal-time), toggle image vs false-color error view, drag the divider,
// export movies. BDPT and MLT drop into this same harness when they exist.
import { loadSceneRegistry } from '../_shared/scenes';
import type { IntegratorName, MainToWorker, PassDoneMessage } from '../../src/render/protocol';

const SCENES = await loadSceneRegistry();
import { Timeline, type TimelineElement } from '../../src/viz/timeline';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';

const RES = 320;
const DISPLAY = 640;
const SEED = 0;
const MAX_SPP = 256;

interface Snapshot {
  spp: number;
  cumMillis: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
  errorRgba: Uint8ClampedArray<ArrayBuffer>;
}

interface Pane {
  name: IntegratorName;
  label: string;
  snapshots: Snapshot[];
  cumMillis: number;
  restart: () => void;
}

const isPowerOfTwo = (n: number) => (n & (n - 1)) === 0;

const infoEl = document.getElementById('info')!;
const timeline = new Timeline();

let sceneName = 'cornell';
let sceneEpoch = 0;
const desc = () => SCENES[sceneName]!;

function makePane(name: IntegratorName, label: string): Pane {
  const worker = new Worker(new URL('../../src/render/worker.ts', import.meta.url), { type: 'module' });
  const post = (m: MainToWorker) => worker.postMessage(m);
  const pane: Pane = {
    name,
    label,
    snapshots: [],
    cumMillis: 0,
    restart: () => {
      pane.snapshots = [];
      pane.cumMillis = 0;
      post({ type: 'init', description: desc(), width: RES, height: RES, seed: SEED, integrator: name, epoch: sceneEpoch });
      post({ type: 'pass', sampleIndex: 0 });
    },
  };
  worker.onmessage = (event: MessageEvent<PassDoneMessage>) => {
    const msg = event.data;
    if (msg.epoch !== sceneEpoch) return; // stale result from a previous scene
    pane.cumMillis += msg.passMillis;
    if (isPowerOfTwo(msg.samplesPerPixel)) {
      pane.snapshots.push({
        spp: msg.samplesPerPixel,
        cumMillis: pane.cumMillis,
        rgba: msg.rgba,
        errorRgba: msg.errorRgba,
      });
      onSnapshotsChanged();
    }
    if (msg.samplesPerPixel < MAX_SPP) post({ type: 'pass', sampleIndex: msg.samplesPerPixel });
    else onSnapshotsChanged(); // final state
  };
  pane.restart();
  return pane;
}

const panes = [makePane('pt', 'PT'), makePane('pt-nee', 'NEE')];

// --- The compositor element ---
type ViewKind = 'image' | 'error';
type CompareMode = 'sample' | 'time';

let view: ViewKind = 'image';
let mode: CompareMode = 'sample';
let wipe = 0.5;

const canvas = document.getElementById('compare') as HTMLCanvasElement;
canvas.width = RES;
canvas.height = RES;
canvas.style.width = `${DISPLAY}px`;
canvas.style.height = `${DISPLAY}px`;
const ctx = canvas.getContext('2d')!;
ctx.imageSmoothingEnabled = false;

// Offscreen canvases hold the currently displayed snapshot per pane.
const offscreens = panes.map(() => {
  const c = document.createElement('canvas');
  c.width = RES;
  c.height = RES;
  return c;
});

// In equal-time mode the scrub axis is the union of both panes' snapshot
// times; each pane shows its best snapshot within the budget.
function timeBudgets(): number[] {
  return [...new Set(panes.flatMap((p) => p.snapshots.map((s) => s.cumMillis)))].sort((a, b) => a - b);
}

function snapshotFor(pane: Pane, step: number): Snapshot | null {
  if (pane.snapshots.length === 0) return null;
  if (mode === 'sample') {
    return pane.snapshots[Math.min(step, pane.snapshots.length - 1)]!;
  }
  const budgets = timeBudgets();
  const budget = budgets[Math.min(step, budgets.length - 1)]!;
  let best: Snapshot | null = null;
  for (const s of pane.snapshots) if (s.cumMillis <= budget) best = s;
  return best ?? pane.snapshots[0]!;
}

function stepCount(): number {
  return mode === 'sample'
    ? Math.max(...panes.map((p) => p.snapshots.length), 1)
    : Math.max(timeBudgets().length, 1);
}

class CompareElement implements TimelineElement {
  drawAt(t: number): void {
    const step = Math.min(stepCount() - 1, Math.max(0, Math.floor(t)));
    ctx.clearRect(0, 0, RES, RES);
    const split = Math.round(wipe * RES);

    panes.forEach((pane, i) => {
      const snap = snapshotFor(pane, step);
      if (!snap) return;
      const data = view === 'image' ? snap.rgba : snap.errorRgba;
      offscreens[i]!.getContext('2d')!.putImageData(new ImageData(data, RES, RES), 0, 0);
      const [sx, sw] = i === 0 ? [0, split] : [split, RES - split];
      if (sw > 0) ctx.drawImage(offscreens[i]!, sx, 0, sw, RES, sx, 0, sw, RES);
    });

    // Divider + in-canvas labels (exports carry them).
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillRect(split - 1, 0, 2, RES);
    ctx.font = '11px ui-sans-serif, system-ui';
    panes.forEach((pane, i) => {
      const snap = snapshotFor(pane, step);
      if (!snap) return;
      const text = `${pane.label} · ${snap.spp} spp · ${(snap.cumMillis / 1000).toFixed(1)}s`;
      const x = i === 0 ? 8 : RES - 8 - ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x - 4, RES - 22, ctx.measureText(text).width + 8, 16);
      ctx.fillStyle = '#eaeaea';
      ctx.fillText(text, x, RES - 10);
    });
  }

  dispose(): void {}
}

timeline.add(new CompareElement(), stepCount());

function onSnapshotsChanged(): void {
  timeline.duration = stepCount();
  const done = panes.map((p) => p.snapshots.at(-1)?.spp ?? 0);
  infoEl.textContent =
    done.every((s) => s >= MAX_SPP)
      ? `complete: ${MAX_SPP} spp both sides`
      : `rendering… PT ${done[0]} spp · NEE ${done[1]} spp (to ${MAX_SPP})`;
  timeline.setTime(timeline.time); // refresh with new data
}

// --- Wipe dragging ---
let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const rect = canvas.getBoundingClientRect();
  wipe = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  timeline.setTime(timeline.time);
});
canvas.addEventListener('pointerup', () => (dragging = false));

// --- Controls ---
(document.getElementById('mode') as HTMLSelectElement).addEventListener('change', (e) => {
  mode = (e.target as HTMLSelectElement).value as CompareMode;
  timeline.duration = stepCount();
  timeline.setTime(timeline.time);
});
(document.getElementById('view') as HTMLSelectElement).addEventListener('change', (e) => {
  view = (e.target as HTMLSelectElement).value as ViewKind;
  timeline.setTime(timeline.time);
});
const sceneSelect = document.getElementById('scene') as HTMLSelectElement;
for (const name of Object.keys(SCENES)) {
  sceneSelect.add(new Option(name, name, undefined, name === sceneName));
}
sceneSelect.addEventListener('change', () => {
  sceneName = sceneSelect.value;
  sceneEpoch += 1;
  for (const pane of panes) pane.restart();
  timeline.duration = stepCount();
  timeline.setTime(0);
});

const frameSource = {
  canvas,
  renderFrame(t: number) {
    timeline.playing = false;
    timeline.setTime(t);
  },
};
attachControls({
  container: document.getElementById('controls')!,
  timeline,
  // 1 step/second; fps 30 gives clean holds on each snapshot.
  onRecordWebM: () => recordWebM(frameSource, { fps: 30, duration: timeline.duration }),
  onRecordFrames: () => recordFrames(frameSource, { fps: 30, duration: timeline.duration }),
});

let last = performance.now();
const loop = () => {
  const now = performance.now();
  timeline.tick((now - last) / 1000);
  last = now;
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
timeline.setTime(0);

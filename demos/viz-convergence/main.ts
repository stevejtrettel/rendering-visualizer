// D5: the standing integrator-comparison harness. Two worker pools render
// the same scene under one of two explicit comparison protocols
// (reworked 2026-07-31):
//
// - EQUAL SAMPLES: fix a target count N; both panes snapshot at the SAME
//   counts 1, 2, 4, …, N, and the scrub steps through counts. The labels
//   show what each count COSTS each integrator in wall time.
// - EQUAL TIME: fix a wall-time budget T; both panes snapshot at the SAME
//   fixed times k·T/12, and the scrub steps through times. The labels show
//   how far each integrator GOT in the same time.
//
// Checkpoints fill in progressively while rendering runs — scrubbing to a
// not-yet-reached checkpoint shows the pane's latest earlier one, honestly
// labeled. (MMLT's unit is mutations/pixel; its bootstrap is part of its
// wall time.)
import { loadSceneRegistry } from '../_shared/scenes';
import type { IntegratorName } from '../../src/render/protocol';
import { WorkerPool } from '../../src/render/pool';

const SCENES = await loadSceneRegistry();
import { Timeline, type TimelineElement } from '../../src/viz/timeline';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';

const RES = 320;
const DISPLAY = 640;
const SEED = 0;
// All panes share one depth cap: comparisons must estimate the SAME
// truncated transport integral (MMLT fixes depth per chain; the walk-based
// integrators get the equivalent maxBounces).
const MAX_DEPTH = 8;
const TIME_CHECKPOINTS = 12;

type ViewKind = 'image' | 'error';
type CompareMode = 'sample' | 'time';

let view: ViewKind = 'image';
let mode: CompareMode = 'sample';
let sampleTarget = 256;
let timeBudgetSec = 60;
let wipe = 0.5;
let sceneName = 'cornell';
const desc = () => SCENES[sceneName]!;

// The shared checkpoint axis for the current protocol: sample counts
// (powers of two up to the target) or wall times (uniform twelfths of the
// budget, in ms).
function marks(): number[] {
  if (mode === 'sample') {
    const out: number[] = [];
    for (let n = 1; n < sampleTarget; n *= 2) out.push(n);
    out.push(sampleTarget);
    return out;
  }
  return Array.from(
    { length: TIME_CHECKPOINTS },
    (_, k) => ((k + 1) * timeBudgetSec * 1000) / TIME_CHECKPOINTS,
  );
}

interface Snapshot {
  count: number; // spp (mpp for MMLT) actually accumulated
  cumMillis: number; // wall time actually elapsed
  rgba: Uint8ClampedArray<ArrayBuffer>;
  errorRgba: Uint8ClampedArray<ArrayBuffer>;
}

interface Pane {
  name: IntegratorName;
  label: string;
  snapshots: (Snapshot | null)[]; // parallel to marks(); filled as reached
  restart: () => void;
}

const infoEl = document.getElementById('info')!;
const timeline = new Timeline();

// Split the machine's cores between the two panes.
const POOL_SIZE = Math.max(1, Math.floor(((navigator.hardwareConcurrency || 4) - 2) / 2));

const unitOf = (name: IntegratorName): string => (name === 'mmlt' ? 'mpp' : 'spp');
// ReSTIR passes are not exchangeable (pass k needs pass k-1's reservoirs):
// its panes run one sequential worker; everything else uses the full pool.
const workersFor = (name: IntegratorName): number => (name === 'restir' ? 1 : POOL_SIZE);
const labelOf = (name: IntegratorName): string =>
  `${{ pt: 'PT', 'pt-nee': 'NEE', bdpt: 'BDPT', mmlt: 'MMLT', restir: 'ReSTIR' }[name]} ×${workersFor(name)}`;

// Flat dark frame for MMLT's error view (no honest per-pixel SE exists).
function flatErrorFrame(): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(RES * RES * 4);
  for (let i = 0; i < RES * RES; i++) {
    out[i * 4] = 24;
    out[i * 4 + 1] = 24;
    out[i * 4 + 2] = 28;
    out[i * 4 + 3] = 255;
  }
  return out;
}

// Pool stop conditions for the current protocol.
const poolCaps = (): { maxSpp: number; maxMillis: number | undefined } =>
  mode === 'sample'
    ? { maxSpp: sampleTarget, maxMillis: undefined }
    : { maxSpp: Number.MAX_SAFE_INTEGER, maxMillis: timeBudgetSec * 1000 };

function makePane(name: IntegratorName): Pane {
  let paneMarks = marks();
  let nextIdx = 0;
  const pane: Pane = {
    name,
    label: labelOf(name),
    snapshots: paneMarks.map(() => null),
    restart: () => {},
  };
  const pool = new WorkerPool({
    size: POOL_SIZE,
    description: desc(),
    width: RES,
    height: RES,
    seed: SEED,
    integrator: name,
    maxDepth: MAX_DEPTH,
    activeWorkers: workersFor(name),
    ...poolCaps(),
    onUpdate: (u) => {
      const reached = (mark: number): boolean =>
        mode === 'sample' ? u.totalSpp >= mark : u.wallMillis >= mark;
      let changed = false;
      while (nextIdx < paneMarks.length && reached(paneMarks[nextIdx]!)) {
        // splatScale normalizes splats: BDPT's t=1 light tracing by 1/spp;
        // MMLT's splat-only image by b/mutationsPerPixel (u.mltB rides the
        // pool update). MMLT's error view is blank — correlated splats
        // have no per-pixel SE.
        const scale = (u.mltB ?? 1) / Math.max(1, u.totalSpp);
        pane.snapshots[nextIdx] = {
          count: u.totalSpp,
          cumMillis: u.wallMillis,
          rgba: u.film.develop({ splatScale: scale }),
          errorRgba: u.mltB !== undefined ? flatErrorFrame() : u.film.developError(),
        };
        nextIdx += 1;
        changed = true;
      }
      if (changed) onSnapshotsChanged();
    },
  });
  pane.restart = () => {
    paneMarks = marks();
    pane.snapshots = paneMarks.map(() => null);
    nextIdx = 0;
    pane.label = labelOf(pane.name);
    pool.restart(desc(), { integrator: pane.name, activeWorkers: workersFor(pane.name), ...poolCaps() });
  };
  return pane;
}

const panes = [makePane('pt'), makePane('pt-nee')];

// --- The compositor element ---
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

// The pane's snapshot for scrub step `step`: exactly that checkpoint when
// reached, otherwise the latest earlier one (rendering still under way).
function snapshotFor(pane: Pane, step: number): { snap: Snapshot; exact: boolean } | null {
  for (let k = Math.min(step, pane.snapshots.length - 1); k >= 0; k--) {
    const snap = pane.snapshots[k];
    if (snap) return { snap, exact: k === step };
  }
  return null;
}

class CompareElement implements TimelineElement {
  drawAt(t: number): void {
    const step = Math.min(marks().length - 1, Math.max(0, Math.floor(t)));
    ctx.clearRect(0, 0, RES, RES);
    const split = Math.round(wipe * RES);

    panes.forEach((pane, i) => {
      const found = snapshotFor(pane, step);
      if (!found) return;
      const data = view === 'image' ? found.snap.rgba : found.snap.errorRgba;
      offscreens[i]!.getContext('2d')!.putImageData(new ImageData(data, RES, RES), 0, 0);
      const [sx, sw] = i === 0 ? [0, split] : [split, RES - split];
      if (sw > 0) ctx.drawImage(offscreens[i]!, sx, 0, sw, RES, sx, 0, sw, RES);
    });

    // Divider + in-canvas labels (exports carry them).
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillRect(split - 1, 0, 2, RES);
    ctx.font = '11px ui-sans-serif, system-ui';
    panes.forEach((pane, i) => {
      const found = snapshotFor(pane, step);
      if (!found) return;
      const { snap, exact } = found;
      const text =
        `${pane.label} · ${snap.count} ${unitOf(pane.name)} · ${(snap.cumMillis / 1000).toFixed(1)}s` +
        (exact ? '' : ' · rendering…');
      const x = i === 0 ? 8 : RES - 8 - ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x - 4, RES - 22, ctx.measureText(text).width + 8, 16);
      ctx.fillStyle = '#eaeaea';
      ctx.fillText(text, x, RES - 10);
    });
  }

  dispose(): void {}
}

timeline.add(new CompareElement(), marks().length);

function onSnapshotsChanged(): void {
  timeline.duration = marks().length;
  const done = panes.map((p) => p.snapshots.filter(Boolean).length);
  const axis =
    mode === 'sample'
      ? `equal samples to ${sampleTarget}`
      : `equal time to ${timeBudgetSec}s (${TIME_CHECKPOINTS} checkpoints)`;
  infoEl.textContent = done.every((d) => d >= marks().length)
    ? `${axis} · complete`
    : `${axis} · rendering: ${panes[0]!.label} ${done[0]}/${marks().length} · ` +
      `${panes[1]!.label} ${done[1]}/${marks().length}`;
  timeline.setTime(timeline.time); // refresh with new data
}

function restartAll(): void {
  for (const pane of panes) pane.restart();
  timeline.duration = marks().length;
  timeline.setTime(Math.min(timeline.time, timeline.duration));
  onSnapshotsChanged();
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
  restartAll();
});
(document.getElementById('samples') as HTMLInputElement).addEventListener('change', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(v) && v >= 1) {
    sampleTarget = Math.floor(v);
    if (mode === 'sample') restartAll();
  }
});
(document.getElementById('seconds') as HTMLInputElement).addEventListener('change', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(v) && v >= 1) {
    timeBudgetSec = v;
    if (mode === 'time') restartAll();
  }
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
  restartAll();
  timeline.setTime(0);
});
(['pane0', 'pane1'] as const).forEach((id, i) => {
  const sel = document.getElementById(id) as HTMLSelectElement;
  sel.addEventListener('change', () => {
    panes[i]!.name = sel.value as IntegratorName;
    panes[i]!.restart();
    onSnapshotsChanged();
    timeline.setTime(0);
  });
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
onSnapshotsChanged();

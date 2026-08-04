/**
 * SHOWS: two tracers converging on the same scene, in ONE frame, under a
 * divider you drag.
 *
 * The split-screen sibling puts the pair side by side, which is right when
 * the difference is obvious. This page is for when it is not: both images
 * occupy the same rectangle at full size, pixel-registered, so the eye
 * compares the same wall and the same shadow rather than scanning between
 * two smaller panels.
 *
 * Drag anywhere on the image to move the divider. For an export, turn
 * `sweep` on and the divider crosses the frame on the stage clock — the
 * split is just a number, so it animates and exports like anything else.
 *
 * Held level by samples (default) or by wall-clock time; see the split
 * page's header for what that choice means. The two renders run one after
 * the other, so the wait is roughly two convergence runs.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import type { SceneDescription } from '@/core/scene/scene';
import type { IntegratorName } from '@/render/protocol';
import { WipePanel } from '@/viz/wipe-panel';
import { ASPECT } from '@/viz/stage';
import { ConvergenceComparison, type SyncMode } from '@/render/comparison';
import { msSchedule, sppSchedule, type Pacing } from '@/render/convergence';
import { label, setText } from '@/viz/text';
import { ProgressBar } from '@/viz/progress-bar';

// --- Figure spec -----------------------------------------------------------
const RES = 320;
const MAX_SPP = 128; // x2 tracers
const MAX_DEPTH = 8;
const SEED = 0;
const FPS = 60;
const DURATION = 14;
const HOLD_START = 1.0;
const HOLD_END = 1.8;
const PANEL = { center: [0, 0.1] as [number, number], height: 1.5 };

const SCENE_NAMES = Object.keys(SCENES) as SceneName[];
const TRACERS: IntegratorName[] = ['pt', 'pt-term', 'pt-nee', 'pt-sms', 'bdpt', 'mmlt', 'restir'];

const filmSize = (scene: SceneName) =>
  scene === 'material-row'
    ? { width: RES, height: Math.round(RES / 2) }
    : { width: RES, height: RES };

const hasDeltaLight = (d: SceneDescription) => (d.pointLights?.length ?? 0) > 0;
const refuse = (scene: SceneName, tracers: IntegratorName[]): string | null =>
  hasDeltaLight(SCENES[scene]) && tracers.includes('restir')
    ? `restir has no delta-light support — ${scene} needs another tracer`
    : null;

// --- Stage -----------------------------------------------------------------
const stage = createStage({ lights: false, controls: false });
stage.duration = DURATION;
const ui = createUI(stage, { fps: FPS });
stage.camera.position.set(0, 0, 5);

const status = label('', {
  size: 0.062,
  color: C.ash,
  anchorX: 'center',
  anchorY: 'top',
  position: [0, PANEL.center[1] - PANEL.height / 2 - 0.09, 0],
});
stage.hud.add(status);

// Two renders back to back is a long wait; show it as one bar across
// both, so the page never looks stalled.
const progress = new ProgressBar({ center: [0, -0.9], width: 1.1 });
stage.hud.add(progress.group);

// Names sit at the top corners, on their own side of the divider.
const sideLabels = [0, 1].map((i) => {
  const l = label('', {
    size: 0.058,
    color: C.bone,
    anchorX: i === 0 ? 'left' : 'right',
    anchorY: 'top',
    position: [0, PANEL.center[1] + PANEL.height / 2 - 0.03, 0],
  });
  stage.hud.add(l);
  return l;
});

let panel: WipePanel | null = null;
function ensurePanel(width: number, height: number): WipePanel {
  if (panel && panel.width === width && panel.height === height) return panel;
  const keep = panel?.split ?? 0.5;
  panel?.dispose();
  panel = new WipePanel({ width, height, center: PANEL.center, drawnHeight: PANEL.height });
  panel.split = keep;
  stage.hud.add(panel.group);
  return panel;
}

// --- Controls --------------------------------------------------------------
const params = {
  scene: 'cornell' as SceneName,
  left: 'pt' as IntegratorName,
  right: 'pt-nee' as IntegratorName,
  sync: 'samples' as SyncMode,
  pacing: 'log' as Pacing,
  maxSpp: MAX_SPP,
  split: 0.5,
  // Animate the divider across the frame instead of holding it. Off by
  // default so the page opens ready to drag; on for an export that should
  // reveal both sides on its own.
  sweep: false,
  holdStart: HOLD_START,
  holdEnd: HOLD_END,
};

let schedule: number[] = [];
let scheduledFor = -1;
function rebuildSchedule(): void {
  scheduledFor = stage.duration;
  const frames = Math.max(1, Math.round(stage.duration * FPS));
  const common = {
    frames,
    pacing: params.pacing,
    holdStart: Math.round(params.holdStart * FPS),
    holdEnd: Math.round(params.holdEnd * FPS),
  };
  schedule =
    params.sync === 'time' && comparison
      ? msSchedule({ ...common, maxMs: comparison.sharedMillis })
      : sppSchedule({ ...common, maxSpp: Math.min(params.maxSpp, MAX_SPP) });
}

ui.params.add(params, 'scene', SCENE_NAMES).onChange(restart);
ui.params.add(params, 'left', TRACERS).name('left of divider').onChange(restart);
ui.params.add(params, 'right', TRACERS).name('right of divider').onChange(restart);
ui.params.add(params, 'sync', ['samples', 'time']).name('hold level by').onChange(rebuildSchedule);
ui.params.add(params, 'pacing', ['log', 'linear', 'sqrt']).onChange(rebuildSchedule);
ui.params.add(params, 'maxSpp', 1, MAX_SPP, 1).name('up to (spp)').onChange(rebuildSchedule);
const splitC = ui.params.add(params, 'split', 0, 1, 0.005).name('divider');
ui.params.add(params, 'sweep').name('sweep divider');
ui.params.add(params, 'holdStart', 0, 5, 0.1).name('hold first (s)').onChange(rebuildSchedule);
ui.params.add(params, 'holdEnd', 0, 5, 0.1).name('hold last (s)').onChange(rebuildSchedule);

// --- Dragging --------------------------------------------------------------
// Pointer x -> HUD x. The canvas is letterboxed, so use its rect rather
// than the window; the HUD spans +-ASPECT horizontally.
function hudX(clientX: number): number {
  const r = stage.canvas.getBoundingClientRect();
  return ((clientX - r.left) / r.width - 0.5) * 2 * ASPECT;
}
let dragging = false;
const applyDrag = (clientX: number): void => {
  const s = panel?.splitAtHudX(hudX(clientX));
  if (s === null || s === undefined) return;
  params.split = s;
  params.sweep = false; // a drag takes over from the animation
  splitC.updateDisplay();
};
stage.canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  stage.canvas.setPointerCapture(e.pointerId);
  applyDrag(e.clientX);
});
stage.canvas.addEventListener('pointermove', (e) => dragging && applyDrag(e.clientX));
stage.canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  stage.canvas.releasePointerCapture(e.pointerId);
});

// --- Playback --------------------------------------------------------------
let comparison: ConvergenceComparison | null = null;
let shown = '';

stage.frame((t) => {
  if (!panel) return;

  // The divider first — it moves whether or not the sequences are ready.
  // A cosine sweep dwells at both ends, where each image is fully visible.
  const split = params.sweep
    ? 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / Math.max(stage.duration, 1e-6))
    : params.split;
  panel.split = split;
  const half = panel.drawnWidth / 2;
  sideLabels[0]!.position.x = PANEL.center[0] - half + 0.03;
  sideLabels[1]!.position.x = PANEL.center[0] + half - 0.03;

  if (!comparison) return;
  if (stage.duration !== scheduledFor) rebuildSchedule();
  const i = Math.min(schedule.length - 1, Math.max(0, Math.floor(t * FPS)));
  const value = schedule[i] ?? 1;
  const [sppA, sppB] = comparison.sppFor(params.sync, value);
  const key = `${sppA}/${sppB}`;
  if (key === shown) return;
  shown = key;

  const a = comparison.a.at(sppA);
  const b = comparison.b.at(sppB);
  if (a) panel.updateA(a);
  if (b) panel.updateB(b);
  const unit = (n: 0 | 1) => (comparison!.tracers[n] === 'mmlt' ? 'mutations' : 'samples');
  setText(sideLabels[0]!, `${comparison.tracers[0]} · ${sppA} ${unit(0)}`);
  setText(sideLabels[1]!, `${comparison.tracers[1]} · ${sppB} ${unit(1)}`);
  setText(
    status,
    params.sync === 'time'
      ? `equal time · ${(value / 1000).toFixed(2)} s of tracing each`
      : `equal samples · ${value} per pixel`,
  );
});

// --- Tracing ---------------------------------------------------------------
let ready: Promise<void> = Promise.resolve();
let inFlight: AbortController | null = null;
let generation = 0;

function restart(): void {
  const gen = ++generation;
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  comparison = null;
  shown = '';
  stage.speed = 0;
  stage.t = 0;
  rebuildSchedule();

  const { scene, left, right } = params;
  const size = filmSize(scene);
  ensurePanel(size.width, size.height);
  setText(sideLabels[0]!, left);
  setText(sideLabels[1]!, right);

  const refusal = refuse(scene, [left, right]);
  if (refusal) {
    progress.visible = false;
    setText(status, refusal);
    ready = Promise.resolve();
    return;
  }

  progress.visible = true;
  progress.set(0);
  setText(status, `${left} vs ${right} · ${scene} · rendering…`);
  ready = ConvergenceComparison.render({
    description: SCENES[scene],
    tracers: [left, right],
    width: size.width,
    height: size.height,
    maxSpp: MAX_SPP,
    seed: SEED,
    maxDepth: MAX_DEPTH,
    signal: controller.signal,
    onProgress: ({ side, tracer, spp, maxSpp, rgba }) => {
      if (gen !== generation) return;
      if (side === 0) panel?.updateA(rgba);
      else panel?.updateB(rgba);
      progress.visible = true;
      progress.set((side + spp / maxSpp) / 2);
      setText(status, `${tracer} (${side + 1} of 2) · rendering ${spp} / ${maxSpp}`);
    },
  })
    .then((c) => {
      if (gen !== generation) return;
      comparison = c;
      shown = '';
      progress.visible = false;
      rebuildSchedule();
      console.log(
        `[convergence-wipe] ${left} ${(c.a.totalMillis / 1000).toFixed(1)}s vs ` +
          `${right} ${(c.b.totalMillis / 1000).toFixed(1)}s to ${MAX_SPP} spp`,
      );
      stage.t = 0;
      stage.speed = 1;
    })
    .catch((err: Error) => {
      if (err.name === 'AbortError') return;
      setText(status, `render failed: ${err.message}`);
    });
}

stage.onReady(() => ready);
stage.start();
restart();

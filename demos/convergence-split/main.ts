/**
 * SHOWS: two tracers converging on the same scene, side by side.
 *
 * Same scene, one tracer per side, held level in one of two ways:
 *
 *   samples  both show the same sample count at the same moment. "Same
 *            work per pixel — look at the difference in noise." The usual
 *            figure, and the default.
 *   time     both get the same wall-clock budget and show how far each
 *            actually got. The stronger claim, and a claim about a
 *            machine: the timings are measured on whatever renders it.
 *
 * The two renders run one after the other, never at once — two workers
 * competing for cores would make each other slower by an unaccountable
 * amount, and an equal-time comparison built on that measures nothing. So
 * the wait is roughly twice a single convergence run.
 *
 * Sibling page: convergence-wipe puts the same pair in ONE frame under a
 * draggable divider, pixel-registered, for when the difference is subtle.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import type { SceneDescription } from '@/core/scene/scene';
import { describeIntegrator, type IntegratorName } from '@/render/protocol';
import { FilmPanel } from '@/viz/film-panel';
import { ConvergenceComparison, type SyncMode } from '@/render/comparison';
import { msSchedule, sppSchedule, type Pacing } from '@/render/convergence';
import { label, setText } from '@/viz/text';
import { ProgressBar } from '@/viz/progress-bar';

// --- Figure spec -----------------------------------------------------------
const RES = 260; // two panels share the frame, so smaller than the solo page
const MAX_SPP = 128; // x2 tracers: keep modest while tuning, raise to export
const MAX_DEPTH = 8; // shared cap: both estimate the SAME truncated integral
const SEED = 0;
const FPS = 60;
const DURATION = 14;
const HOLD_START = 1.0;
const HOLD_END = 1.8;
// Panel centres in HUD units (frame is 2 tall, +-16/9 wide).
const PANEL_X = 0.92;
const PANEL_Y = 0.12;
const PANEL_H = 1.34;

const SCENE_NAMES = Object.keys(SCENES) as SceneName[];
const TRACERS: IntegratorName[] = ['pt', 'pt-term', 'pt-nee', 'pt-sms', 'bdpt', 'mmlt', 'restir'];

const filmSize = (scene: SceneName) =>
  scene === 'material-row'
    ? { width: RES, height: Math.round(RES / 2) }
    : { width: RES, height: RES };

// ReSTIR alone has no delta-light support: its reservoir target is zero at
// a delta emitter. BDPT and MMLT carry them fine (see
// tests/delta-light-mis.test.ts) and plain PT correctly renders black.
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
  position: [0, -0.74, 0],
});
stage.hud.add(status);

// Two renders back to back is a long wait; show it as one bar across
// both, so the page never looks stalled.
const progress = new ProgressBar({ center: [0, -0.9], width: 1.1 });
stage.hud.add(progress.group);

const sideLabels = [0, 1].map((i) => {
  const l = label('', {
    size: 0.058,
    color: C.bone,
    anchorX: 'center',
    anchorY: 'top',
    position: [i === 0 ? -PANEL_X : PANEL_X, PANEL_Y - PANEL_H / 2 - 0.06, 0],
  });
  stage.hud.add(l);
  return l;
});

let panels: [FilmPanel, FilmPanel] | null = null;
function ensurePanels(width: number, height: number): [FilmPanel, FilmPanel] {
  if (panels && panels[0].width === width && panels[0].height === height) return panels;
  panels?.forEach((p) => p.dispose());
  panels = [0, 1].map((i) =>
    new FilmPanel({
      width,
      height,
      center: [i === 0 ? -PANEL_X : PANEL_X, PANEL_Y],
      drawnHeight: PANEL_H,
    }),
  ) as [FilmPanel, FilmPanel];
  panels.forEach((p) => stage.hud.add(p.group));
  return panels;
}

// --- Controls --------------------------------------------------------------
const params = {
  scene: 'cornell' as SceneName,
  left: 'pt' as IntegratorName,
  right: 'pt-nee' as IntegratorName,
  sync: 'samples' as SyncMode,
  pacing: 'log' as Pacing,
  maxSpp: MAX_SPP,
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
  // In time mode the ramp runs over a shared ms budget instead of samples,
  // capped at what BOTH sides reached — past that the faster one would
  // freeze while the slower carried on, and it would stop being a
  // comparison.
  schedule =
    params.sync === 'time' && comparison
      ? msSchedule({ ...common, maxMs: comparison.sharedMillis })
      : sppSchedule({ ...common, maxSpp: Math.min(params.maxSpp, MAX_SPP) });
}

ui.params.add(params, 'scene', SCENE_NAMES).onChange(restart);
ui.params.add(params, 'left', TRACERS).onChange(restart);
ui.params.add(params, 'right', TRACERS).onChange(restart);
ui.params.add(params, 'sync', ['samples', 'time']).name('hold level by').onChange(rebuildSchedule);
ui.params.add(params, 'pacing', ['log', 'linear', 'sqrt']).onChange(rebuildSchedule);
ui.params.add(params, 'maxSpp', 1, MAX_SPP, 1).name('up to (spp)').onChange(rebuildSchedule);
ui.params.add(params, 'holdStart', 0, 5, 0.1).name('hold first (s)').onChange(rebuildSchedule);
ui.params.add(params, 'holdEnd', 0, 5, 0.1).name('hold last (s)').onChange(rebuildSchedule);

// --- Playback --------------------------------------------------------------
let comparison: ConvergenceComparison | null = null;
let shown = '';

stage.frame((t) => {
  if (!comparison || !panels) return;
  if (stage.duration !== scheduledFor) rebuildSchedule();
  const i = Math.min(schedule.length - 1, Math.max(0, Math.floor(t * FPS)));
  const value = schedule[i] ?? 1;
  const [sppA, sppB] = comparison.sppFor(params.sync, value);
  const key = `${sppA}/${sppB}`;
  if (key === shown) return;
  shown = key;

  const seqs = [comparison.a, comparison.b] as const;
  [sppA, sppB].forEach((spp, side) => {
    const rgba = seqs[side]!.at(spp);
    if (rgba) panels![side]!.update(rgba);
    const unit = comparison!.tracers[side]!.name === 'mmlt' ? 'mutation' : 'sample';
    setText(sideLabels[side]!, `${comparison!.tracers[side]!.name} · ${spp} ${unit}${spp === 1 ? '' : 's'}`);
  });
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
  ensurePanels(size.width, size.height);
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
    tracers: [describeIntegrator(left, MAX_DEPTH), describeIntegrator(right, MAX_DEPTH)],
    width: size.width,
    height: size.height,
    maxSpp: MAX_SPP,
    seed: SEED,
    signal: controller.signal,
    onProgress: ({ side, tracer, spp, maxSpp, rgba }) => {
      if (gen !== generation) return;
      panels?.[side]?.update(rgba);
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
      rebuildSchedule(); // time mode needs the measured budgets
      console.log(
        `[convergence-split] ${left} ${(c.a.totalMillis / 1000).toFixed(1)}s vs ` +
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

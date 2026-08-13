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
import type { IntegratorDescription } from '@/render/protocol';
import { FilmPanel } from '@/viz/film-panel';
import { ConvergenceComparison, type SyncMode } from '@/render/comparison';
import { msSchedule, sppSchedule, type Pacing } from '@/render/convergence';
import { label, setText } from '@/viz/text';
import { ProgressBar } from '@/viz/progress-bar';

// --- Figure spec -----------------------------------------------------------
const RES = 260; // two panels share the frame, so smaller than the solo page
const MAX_SPP = 256; // x2 tracers: the whole ladder is traced every restart
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

// Presets, not bare integrator names — the same table `convergence` and
// `still` use, so all three pages mean the same thing by the same word.
//
// The one that was missing here, and the reason this page exists: `pt-naive`
// is naive on BOTH axes at once (uniform directions AND an up-front
// path-length draw), which is the left-hand side of the naive-vs-standard
// figure. `pt-term` is easy to mistake for it and is not — it is naive on
// the length axis only, still importance-sampling directions.
const TRACERS = {
  'pt-naive': (d: number): IntegratorDescription => ({ name: 'pt-term', maxBounces: d, directions: 'uniform' }),
  pt: (d: number): IntegratorDescription => ({ name: 'pt', maxBounces: d }),
  'pt-nee': (d: number): IntegratorDescription => ({ name: 'pt-nee', maxBounces: d }),
  'pt-sms': (d: number): IntegratorDescription => ({ name: 'pt-sms', maxBounces: d }),
  bdpt: (d: number): IntegratorDescription => ({ name: 'bdpt', maxBounces: d }),
  mmlt: (d: number): IntegratorDescription => ({ name: 'mmlt', maxBounces: d }),
  restir: (d: number): IntegratorDescription => ({ name: 'restir', maxBounces: d }),
};
type TracerName = keyof typeof TRACERS;
const TRACER_NAMES = Object.keys(TRACERS) as TracerName[];

const filmSize = (scene: SceneName) =>
  scene === 'material-row'
    ? { width: RES, height: Math.round(RES / 2) }
    : { width: RES, height: RES };

// ReSTIR alone has no delta-light support: its reservoir target is zero at
// a delta emitter. BDPT and MMLT carry them fine (see
// tests/delta-light-mis.test.ts) and plain PT correctly renders black.
const hasDeltaLight = (d: SceneDescription) => (d.pointLights?.length ?? 0) > 0;
const refuse = (scene: SceneName, tracers: TracerName[]): string | null =>
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
  left: 'pt' as TracerName,
  right: 'pt-nee' as TracerName,
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
ui.params.add(params, 'left', TRACER_NAMES).onChange(restart);
ui.params.add(params, 'right', TRACER_NAMES).onChange(restart);
// These reshape the movie without re-tracing anything, so they replay from
// the top rather than cutting to wherever the new schedule happens to land
// at the current time.
function replay(): void {
  rebuildSchedule();
  shown = '';
  stage.t = 0;
}

ui.params.add(params, 'sync', ['samples', 'time']).name('hold level by').onChange(replay);
ui.params.add(params, 'pacing', ['log', 'linear', 'sqrt']).onChange(replay);
ui.params.add(params, 'maxSpp', 1, MAX_SPP, 1).name('up to (spp)').onChange(replay);
ui.params.add(params, 'holdStart', 0, 5, 0.1).name('hold first (s)').onChange(replay);
ui.params.add(params, 'holdEnd', 0, 5, 0.1).name('hold last (s)').onChange(replay);

// --- Playback --------------------------------------------------------------
let comparison: ConvergenceComparison | null = null;
let shown = '';
// The PRESET names of the pair on screen, captured with the comparison.
// ConvergenceComparison only knows the integrator underneath, which would
// caption the naive tracer "pt-term" — true of the estimator, wrong as a
// label for the thing the figure is about.
let shownNames: [TracerName, TracerName] = ['pt', 'pt-nee'];

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
    const name = shownNames[side as 0 | 1];
    const unit = name === 'mmlt' ? 'mutation' : 'sample';
    setText(sideLabels[side]!, `${name} · ${spp} ${unit}${spp === 1 ? '' : 's'}`);
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
  // Blank both: a panel holds its last upload, and the two sides trace one
  // after the other, so without this the right one would show the PREVIOUS
  // run's converged image — under its new caption — for the whole time the
  // left one is tracing. That reads as "the right side is broken" rather
  // than "the right side is next".
  ensurePanels(size.width, size.height).forEach((p) => p.clear());
  setText(sideLabels[0]!, left);
  setText(sideLabels[1]!, `${right} · queued`);

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
    tracers: [TRACERS[left](MAX_DEPTH), TRACERS[right](MAX_DEPTH)],
    width: size.width,
    height: size.height,
    maxSpp: MAX_SPP,
    seed: SEED,
    signal: controller.signal,
    // Captions carry the PRESET name, not the integrator underneath: the
    // naive tracer is a `pt-term` to the renderer and "pt-naive" to anyone
    // reading the figure.
    onProgress: ({ side, spp, maxSpp, rgba }) => {
      if (gen !== generation) return;
      const name = [left, right][side]!;
      panels?.[side]?.update(rgba);
      progress.visible = true;
      progress.set((side + spp / maxSpp) / 2);
      setText(sideLabels[side]!, `${name} · tracing`);
      setText(status, `${name} (${side + 1} of 2) · rendering ${spp} / ${maxSpp}`);
    },
  })
    .then((c) => {
      if (gen !== generation) return;
      comparison = c;
      shownNames = [left, right];
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

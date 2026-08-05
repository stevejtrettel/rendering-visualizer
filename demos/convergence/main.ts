/**
 * SHOWS: noise falling away as samples accumulate — pick a scene and a
 * tracer, watch the sample count climb from 1 to MAX_SPP.
 *
 * The renderer works pass by pass, so the figure is just: save the passes,
 * play them back. What the page decides is the PACING — how movie time is
 * spent across the sample range:
 *
 *   log     equal doublings per second (default). Noise falls as
 *           1/sqrt(spp), so equal doublings are roughly equal visible
 *           change: it dwells on 1 -> 32 and races through 128 -> 512,
 *           which is where nothing is happening anyway.
 *   linear  equal samples per second. Honest, and mostly boring.
 *   sqrt    between the two.
 *
 * Scene and tracer are menus because this figure gets made several times
 * over. Changing either re-traces from scratch — the wait is the renderer
 * doing MAX_SPP passes — and the clock holds until it finishes, so an
 * export always covers the whole range rather than catching the trace
 * mid-flight.
 *
 * Set the range to export in Capture > from/to, the movie length in
 * Time > loop (s), then press V.
 *
 * Cost is linear in MAX_SPP x RES². Both are constants below: keep them
 * modest while tuning the pacing, raise them for the final export.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import type { SceneDescription } from '@/core/scene/scene';
import type { IntegratorDescription } from '@/render/protocol';
import { FilmPanel } from '@/viz/film-panel';
import { ConvergenceSequence, sppSchedule, type Pacing } from '@/render/convergence';
import { label, setText } from '@/viz/text';
import { ProgressBar } from '@/viz/progress-bar';

// --- Figure spec -----------------------------------------------------------
const RES = 320; // film resolution; the pane shows it a little over 2x up
const MAX_SPP = 256; // raise for the final export — cost is linear in this
const MAX_DEPTH = 8; // shared cap, so every tracer estimates the same integral
const SEED = 0;
const FPS = 60; // the schedule's time base; independent of the export fps
const DURATION = 14; // seconds of movie (Time > loop (s))
const PANEL = { center: [0, 0.06] as [number, number], height: 1.62 };
const HOLD_START = 1.0; // seconds on the first, noisiest sample
const HOLD_END = 1.8; // seconds on the converged image
// Distinct sample counts to show. Undefined = every one, i.e. a continuous
// settle; a number gives deliberate beats instead.
const STEPS: number | undefined = undefined;

const SCENE_NAMES = Object.keys(SCENES) as SceneName[];

// What you can record, as ONE choice — ordered naive to sophisticated.
//
// Naivety has two independent axes: how directions are chosen, and how the
// path's length is decided. They are different KINDS of thing underneath (a
// material decorator versus a genuinely different estimator class), which is
// why IntegratorDescription keeps them apart — but that is the renderer's
// business, not the operator's. Assembling a tracer out of two dropdowns
// made a preset into a puzzle, so the presets are named here instead.
//
//   pt-naive  uniform directions AND an up-front path-length draw — naive on
//             both axes at once. Measured 0.66 sigma from `pt` on cornell
//             (the same integral, as an unbiased estimator must be) at 2.19x
//             the noise and ~2x the cost per sample: a ~10x equal-time gap.
//   pt        the standard tracer: importance-sampled, roulette on.
//   the rest  the ladder, in the order the talk climbs it.
//
// The half-naive rungs (uniform directions alone; the length draw alone) are
// deliberately NOT here — they are a decomposition for a variance argument,
// not a figure. Either is one line if a slide ever wants it:
// { name: 'pt', directions: 'uniform' } or { name: 'pt-term' }.
const TRACERS: Record<string, IntegratorDescription> = {
  'pt-naive': { name: 'pt-term', maxBounces: MAX_DEPTH, directions: 'uniform' },
  pt: { name: 'pt', maxBounces: MAX_DEPTH },
  'pt-nee': { name: 'pt-nee', maxBounces: MAX_DEPTH },
  'pt-sms': { name: 'pt-sms', maxBounces: MAX_DEPTH },
  bdpt: { name: 'bdpt', maxBounces: MAX_DEPTH },
  mmlt: { name: 'mmlt', maxBounces: MAX_DEPTH },
  restir: { name: 'restir', maxBounces: MAX_DEPTH },
};
type TracerName = keyof typeof TRACERS;
const TRACER_NAMES = Object.keys(TRACERS);

// Only `material-row` is authored for a non-square film (registry.ts).
const filmSize = (scene: SceneName): { width: number; height: number } =>
  scene === 'material-row'
    ? { width: RES, height: Math.round(RES / 2) }
    : { width: RES, height: RES };

// Delta-lit scenes: BDPT and MMLT DO carry a point light — V5c gave
// PointLight a real sampleLe/pdfLe and bdpt.ts the lightIsDelta handling,
// and tests/delta-light-mis.test.ts measures both agreeing with NEE. Plain
// PT correctly renders black (a delta light cannot be hit), which is the
// whole point of those scenes rather than a fault.
//
// ReSTIR is the one genuine exception, and not for a reason MIS can fix:
// its reservoir target is the luminance of f*G*Le at a sampled light
// vertex, and PointLight.le() is black by construction, so the target is
// identically zero and direct lighting at the primary vertex vanishes.
// Measured at ~0.42x NEE. Recorded in docs/design-cleanup.md §7.
const hasDeltaLight = (d: SceneDescription): boolean => (d.pointLights?.length ?? 0) > 0;
const unsupported = (scene: SceneName, tracer: TracerName): string | null =>
  hasDeltaLight(SCENES[scene]) && TRACERS[tracer]!.name === 'restir'
    ? `restir has no delta-light support (reservoir target is zero) — ${scene} needs another tracer`
    : null;

// --- Stage -----------------------------------------------------------------
const stage = createStage({ lights: false, controls: false });
stage.duration = DURATION;
const ui = createUI(stage, { fps: FPS });
stage.camera.position.set(0, 0, 5); // the figure is entirely the HUD

const caption = label('', {
  size: 0.075,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'top',
  position: [0, -0.79, 0],
});
stage.hud.add(caption);

// Visible while the passes are being traced, so the wait reads as work.
const progress = new ProgressBar({ center: [0, -0.9], width: 1.1 });
stage.hud.add(progress.group);

let panel: FilmPanel | null = null;
function ensurePanel(width: number, height: number): FilmPanel {
  if (panel && panel.width === width && panel.height === height) return panel;
  panel?.dispose();
  panel = new FilmPanel({ width, height, center: PANEL.center, drawnHeight: PANEL.height });
  stage.hud.add(panel.group);
  return panel;
}

// --- Controls --------------------------------------------------------------
const params = {
  scene: 'cornell' as SceneName,
  tracer: 'pt-nee' as TracerName,
  pacing: 'log' as Pacing,
  maxSpp: MAX_SPP,
  holdStart: HOLD_START,
  holdEnd: HOLD_END,
};

// The preset names itself, so a recorded clip says what it is.
const integratorSpec = (): IntegratorDescription => TRACERS[params.tracer]!;
const tracerLabel = (): string => String(params.tracer);

let schedule: number[] = [];
let scheduledFor = -1; // the stage duration this schedule was built for
function rebuildSchedule(): void {
  scheduledFor = stage.duration;
  schedule = sppSchedule({
    frames: Math.max(1, Math.round(stage.duration * FPS)),
    maxSpp: Math.min(params.maxSpp, MAX_SPP), // never beyond what we rendered
    pacing: params.pacing,
    ...(STEPS !== undefined ? { steps: STEPS } : {}),
    holdStart: Math.round(params.holdStart * FPS),
    holdEnd: Math.round(params.holdEnd * FPS),
  });
}

// Scene and tracer change WHAT is rendered, so they re-trace; the rest only
// change how the finished sequence is paced, so they take effect instantly.
ui.params.add(params, 'scene', SCENE_NAMES).onChange(restart);
ui.params.add(params, 'tracer', TRACER_NAMES).onChange(restart);
ui.params.add(params, 'pacing', ['log', 'linear', 'sqrt']).onChange(rebuildSchedule);
ui.params.add(params, 'maxSpp', 1, MAX_SPP, 1).name('up to (spp)').onChange(rebuildSchedule);
ui.params.add(params, 'holdStart', 0, 5, 0.1).name('hold first (s)').onChange(rebuildSchedule);
ui.params.add(params, 'holdEnd', 0, 5, 0.1).name('hold last (s)').onChange(rebuildSchedule);

// --- Playback --------------------------------------------------------------
let sequence: ConvergenceSequence | null = null;
let shownSpp = -1;

stage.frame((t) => {
  if (!sequence || !panel) return;
  if (stage.duration !== scheduledFor) rebuildSchedule(); // loop (s) was dragged
  const i = Math.min(schedule.length - 1, Math.max(0, Math.floor(t * FPS)));
  const spp = schedule[i] ?? 1;
  if (spp === shownSpp) return; // most movie frames repeat a sample
  shownSpp = spp;
  const rgba = sequence.at(spp);
  if (rgba) panel.update(rgba);
  // MMLT spends mutations, not independent samples; calling them "samples"
  // would misdescribe what the number counts.
  const unit = params.tracer === 'mmlt' ? 'mutation' : 'sample';
  setText(caption, `${tracerLabel()} · ${spp} ${unit}${spp === 1 ? '' : 's'} per pixel`);
});

// --- Tracing ---------------------------------------------------------------
// `ready` is what the exporter waits on (stage.onReady, below). It is
// reassigned on every switch and the closure always reads the current one.
let ready: Promise<void> = Promise.resolve();
let inFlight: AbortController | null = null;
let generation = 0;

function restart(): void {
  const gen = ++generation;
  inFlight?.abort(); // a switch mid-trace must not leave two workers running
  const controller = new AbortController();
  inFlight = controller;

  sequence = null;
  shownSpp = -1;
  stage.speed = 0; // hold the preview; the exporter is held by onReady
  stage.t = 0;
  rebuildSchedule();

  const { scene, tracer } = params;
  const description = SCENES[scene];
  const size = filmSize(scene);
  ensurePanel(size.width, size.height);

  const refusal = unsupported(scene, tracer);
  if (refusal) {
    progress.visible = false;
    setText(caption, refusal);
    ready = Promise.resolve();
    return;
  }

  progress.visible = true;
  progress.set(0);
  setText(caption, `${tracerLabel()} · ${scene} · rendering…`);
  ready = ConvergenceSequence.render({
    description,
    integrator: integratorSpec(),
    width: size.width,
    height: size.height,
    maxSpp: MAX_SPP,
    seed: SEED,
    signal: controller.signal,
    onProgress: ({ spp, maxSpp, msPerPass, rgba }) => {
      if (gen !== generation) return;
      panel?.update(rgba);
      progress.visible = true;
      progress.set(spp / maxSpp);
      setText(caption, `${tracerLabel()} · rendering ${spp} / ${maxSpp} · ${msPerPass.toFixed(0)} ms/pass`);
    },
  })
    .then((seq) => {
      if (gen !== generation) return; // superseded by a later switch
      sequence = seq;
      shownSpp = -1;
      progress.visible = false;
      console.log(
        `[convergence] ${tracer} · ${scene} · ${size.width}x${size.height} to ${MAX_SPP} spp · ` +
          `${(seq.bytes / 1e6).toFixed(0)} MB held · press V to export`,
      );
      stage.t = 0;
      stage.speed = 1;
    })
    .catch((err: Error) => {
      if (err.name === 'AbortError') return; // expected on a switch
      setText(caption, `render failed: ${err.message}`);
    });
}

// The exporter drives setTime directly and ignores `speed`, so without this
// pressing V during a trace would capture the live render mid-flight — the
// movie would show the picture wherever the tracer happened to be, not the
// sample counts the schedule asks for. Now V simply waits.
stage.onReady(() => ready);

stage.start();
restart();

/**
 * SHOWS: one material, on its own.
 *
 * The Cornell shell with a single sphere in the middle and nothing else to
 * look at. Set the sphere's material in the Parameters folder, wait for the
 * render, then press V to record it converging. Change the material and
 * record again — the takes cut together, because the scene, the camera and
 * the sample schedule are identical every time.
 *
 * All four kinds the renderer has, with the properties that matter for each:
 *
 *   lambert     albedo. The reference: no highlight, no view dependence.
 *   mirror      f0. A delta lobe — one outgoing direction, and no roughness
 *               to vary, which is what makes it the degenerate case.
 *   conductor   f0 and roughness. Roughness 0.02 is nearly the mirror;
 *               0.5 is brushed metal. The interesting continuous family.
 *   dielectric  ior. 1.0 is invisible, 1.5 is glass, 2.4 is diamond.
 *
 * The tracer matters here: glass throws caustics that plain NEE finds only
 * by luck, so pt-sms is worth trying on a dielectric before concluding the
 * render is just noisy.
 */

import { createStage, createUI, C } from '@';
import { materialTestScene } from '@/scenes/registry';
import type { MaterialDescription } from '@/core/scene/scene';
import type { IntegratorName } from '@/render/protocol';
import { FilmPanel } from '@/viz/film-panel';
import { ProgressBar } from '@/viz/progress-bar';
import { ConvergenceSequence, sppSchedule, type Pacing } from '@/render/convergence';
import { label, setText } from '@/viz/text';

// --- Figure spec -----------------------------------------------------------
const RES = 320;
const MAX_SPP = 256; // raise for a final take — cost is linear in this
const MAX_DEPTH = 12; // glass needs depth; a dielectric ball eats bounces
const SEED = 0;
const FPS = 60;
const DURATION = 12;
const PACING: Pacing = 'log';
const HOLD_START = 0.8;
const HOLD_END = 2.0;
const PANEL = { center: [0, 0.08] as [number, number], height: 1.6 };

const TRACERS: IntegratorName[] = ['pt-nee', 'pt-sms', 'pt', 'bdpt', 'mmlt'];
type Kind = MaterialDescription['kind'];
const KINDS: Kind[] = ['lambert', 'mirror', 'conductor', 'dielectric'];

// --- Stage -----------------------------------------------------------------
const stage = createStage({ lights: false, controls: false });
stage.duration = DURATION;
const ui = createUI(stage, { fps: FPS });
stage.camera.position.set(0, 0, 5); // the figure is entirely the HUD

const panel = new FilmPanel({
  width: RES,
  height: RES,
  center: PANEL.center,
  drawnHeight: PANEL.height,
});
stage.hud.add(panel.group);

const caption = label('', {
  size: 0.068,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'top',
  position: [0, -0.78, 0],
});
stage.hud.add(caption);

const progress = new ProgressBar({ center: [0, -0.9], width: 1.1 });
stage.hud.add(progress.group);

// --- Controls --------------------------------------------------------------
// One flat object with every property; only those belonging to the current
// kind are shown, so the panel says exactly what this material has.
const params = {
  kind: 'conductor' as Kind,
  tracer: 'pt-nee' as IntegratorName,
  albedo: [0.75, 0.75, 0.78] as [number, number, number],
  f0: [1.0, 0.77, 0.34] as [number, number, number],
  roughness: 0.25,
  ior: 1.5,
  maxSpp: MAX_SPP,
};

const material = (): MaterialDescription => {
  switch (params.kind) {
    case 'lambert':
      return { kind: 'lambert', albedo: params.albedo };
    case 'mirror':
      return { kind: 'mirror', f0: params.f0 };
    case 'dielectric':
      return { kind: 'dielectric', ior: params.ior };
    case 'conductor':
      return { kind: 'conductor', f0: params.f0, roughness: params.roughness };
  }
};

/** What the caption says the sphere is. */
const describe = (): string => {
  switch (params.kind) {
    case 'lambert':
      return 'lambert';
    case 'mirror':
      return 'mirror (delta lobe)';
    case 'dielectric':
      return `glass · ior ${params.ior.toFixed(2)}`;
    case 'conductor':
      return `metal · roughness ${params.roughness.toFixed(2)}`;
  }
};

ui.params.add(params, 'kind', KINDS).onChange(() => {
  showRelevant();
  restart();
});
ui.params.add(params, 'tracer', TRACERS).onChange(restart);
const albedoC = ui.params.addColor(params, 'albedo').onChange(restart);
const f0C = ui.params.addColor(params, 'f0').name('reflectance (f0)').onChange(restart);
const roughC = ui.params.add(params, 'roughness', 0.005, 1, 0.005).onChange(restart);
const iorC = ui.params.add(params, 'ior', 1.0, 2.6, 0.01).onChange(restart);
ui.params.add(params, 'maxSpp', 1, MAX_SPP, 1).name('up to (spp)').onChange(rebuildSchedule);

function showRelevant(): void {
  albedoC.show(params.kind === 'lambert');
  f0C.show(params.kind === 'mirror' || params.kind === 'conductor');
  roughC.show(params.kind === 'conductor');
  iorC.show(params.kind === 'dielectric');
}
showRelevant();

// --- Pacing ----------------------------------------------------------------
let schedule: number[] = [];
let scheduledFor = -1;
function rebuildSchedule(): void {
  scheduledFor = stage.duration;
  schedule = sppSchedule({
    frames: Math.max(1, Math.round(stage.duration * FPS)),
    maxSpp: Math.min(params.maxSpp, MAX_SPP),
    pacing: PACING,
    holdStart: Math.round(HOLD_START * FPS),
    holdEnd: Math.round(HOLD_END * FPS),
  });
}
rebuildSchedule();

// --- Playback --------------------------------------------------------------
let sequence: ConvergenceSequence | null = null;
let shownSpp = -1;

stage.frame((t) => {
  if (!sequence) return;
  if (stage.duration !== scheduledFor) rebuildSchedule();
  const i = Math.min(schedule.length - 1, Math.max(0, Math.floor(t * FPS)));
  const spp = schedule[i] ?? 1;
  if (spp === shownSpp) return;
  shownSpp = spp;
  const rgba = sequence.at(spp);
  if (rgba) panel.update(rgba);
  setText(caption, `${describe()} · ${spp} ${spp === 1 ? 'sample' : 'samples'} per pixel`);
});

// --- Rendering -------------------------------------------------------------
let ready: Promise<void> = Promise.resolve();
let inFlight: AbortController | null = null;
let generation = 0;

function restart(): void {
  const gen = ++generation;
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  sequence = null;
  shownSpp = -1;
  stage.speed = 0;
  stage.t = 0;
  rebuildSchedule();
  progress.visible = true;
  progress.set(0);
  setText(caption, `${describe()} · rendering…`);

  ready = ConvergenceSequence.render({
    description: materialTestScene(material()),
    integrator: params.tracer,
    width: RES,
    height: RES,
    maxSpp: MAX_SPP,
    seed: SEED,
    maxDepth: MAX_DEPTH,
    signal: controller.signal,
    onProgress: ({ spp, maxSpp, msPerPass, rgba }) => {
      if (gen !== generation) return;
      panel.update(rgba);
      progress.set(spp / maxSpp);
      setText(caption, `${describe()} · rendering ${spp} / ${maxSpp} · ${msPerPass.toFixed(0)} ms/pass`);
    },
  })
    .then((seq) => {
      if (gen !== generation) return;
      sequence = seq;
      shownSpp = -1;
      progress.visible = false;
      console.log(`[material-test] ${describe()} · ${params.tracer} · ${MAX_SPP} spp`);
      stage.t = 0;
      stage.speed = 1;
    })
    .catch((err: Error) => {
      if (err.name === 'AbortError') return;
      progress.visible = false;
      setText(caption, `render failed: ${err.message}`);
    });
}

// Pressing V mid-render waits rather than capturing a half-converged take.
stage.onReady(() => ready);
stage.start();
restart();

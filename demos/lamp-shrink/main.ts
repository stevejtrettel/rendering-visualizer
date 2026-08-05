/**
 * SHOWS: why most paths report nothing — one tracer, three lamps, the same
 * room brightness, and a picture that falls apart anyway.
 *
 * Three panels of the same scene. The lamp shrinks left to right, and its
 * radiance rises to match so that TOTAL EMITTED POWER is unchanged: a
 * Lambertian emitter radiates in proportion to L·A, so holding L·A fixed
 * means quadrupling the radiance each time the side halves.
 *
 * That compensation is what makes the figure about the lamp's SIZE instead
 * of about exposure. Measured on `cornell` (24², pt-nee, 256 spp): mean
 * image luminance 0.397 / 0.399 / 0.398 across a 64× change in area — the
 * three rooms really are equally bright. Take the compensation away and the
 * same series falls to 1.6% of its starting brightness, and the only thing
 * a viewer sees is that someone turned the lights off.
 *
 * What does change is how FINDABLE the lamp is. A BSDF-sampled walk reaches
 * an emitter by accident, and accidents get rare as the target shrinks:
 * plain PT's hit rate falls 9.20% → 0.73% → 0.15% across these three, a 60×
 * collapse. Equal samples, equal light in the room, and the right-hand panel
 * is ruined — that is the argument for next-event estimation, made before
 * NEE is mentioned.
 *
 * This page is one method at a time, on purpose: first watch a tracer fail
 * alone. The comparison against a method that does NOT fail is a separate
 * figure.
 */

import { createStage, createUI, C } from '@';
import { SCENES, withLampShrunk, type SceneName } from '@/scenes/registry';
import type { IntegratorDescription } from '@/render/protocol';
import { FilmPanel } from '@/viz/film-panel';
import { ConvergenceSequence, sppSchedule, type Pacing } from '@/render/convergence';
import { label, setText } from '@/viz/text';
import { ProgressBar } from '@/viz/progress-bar';

// --- Figure spec -----------------------------------------------------------
// Three panels share the frame, and the figure is about NOISE rather than
// detail — so the film stays small. 128² is ~3x less work than 220² and
// ~14 MB of kept frames per panel instead of 41 (memory is distinct-spp x
// RES² x 4; see sppLadder in render/convergence.ts).
//
// It is upscaled about 4.5x at export, and the panel texture uses
// NearestFilter, so a pixel is a visible square. That is deliberate here:
// the point is how many pixels found the lamp, and a hard pixel edge counts
// better than a smoothed one.
const RES = 128;
const MAX_SPP = 256;
const MAX_DEPTH = 8;
const SEED = 0;
const FPS = 60;
const DURATION = 14;
const HOLD_START = 1.0;
const HOLD_END = 1.8;
// 1 / 4 / 8 rather than 1 / 2 / 4: the hit rate falls with AREA, so halving
// steps read as a decline (9.2 → 2.5 → 0.7) where these read as a collapse
// (9.2 → 0.7 → 0.15). Measured, see withLampShrunk.
const SHRINKS = [1, 4, 8] as const;
// Three square panels across a 16:9 HUD, which is 2*ASPECT = 3.556 wide.
// The drawn width of a square film equals PANEL_H, so the constraint is
// 3*PANEL_H + 2*gutter <= 3.556, and the outer centres must satisfy
// PANEL_X + PANEL_H/2 <= 1.778 or they run off the frame.
const PANEL_H = 1.08;
const PANEL_X = 1.15; // leaves a 0.07 gutter; outer edge at 1.69
const PANEL_Y = 0.16;

const SCENE_NAMES = Object.keys(SCENES) as SceneName[];

// One method at a time. The naive tracer is the honest subject of the
// slide, but plain `pt` is the one the talk has been building on, so it is
// the default; the rest are here because the same figure is worth making
// for a method that does NOT collapse.
const TRACERS: Record<string, IntegratorDescription> = {
  pt: { name: 'pt', maxBounces: MAX_DEPTH },
  'pt-naive': { name: 'pt-term', maxBounces: MAX_DEPTH, directions: 'uniform' },
  'pt-nee': { name: 'pt-nee', maxBounces: MAX_DEPTH },
  bdpt: { name: 'bdpt', maxBounces: MAX_DEPTH },
};
type TracerName = keyof typeof TRACERS;
const TRACER_NAMES = Object.keys(TRACERS);

// --- Stage -----------------------------------------------------------------
const stage = createStage({ lights: false, controls: false });
stage.duration = DURATION;
const ui = createUI(stage, { fps: FPS });
stage.camera.position.set(0, 0, 5);

const caption = label('', {
  size: 0.062,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'top',
  position: [0, -0.78, 0],
});
stage.hud.add(caption);

const progress = new ProgressBar({ center: [0, -0.92], width: 1.1 });
stage.hud.add(progress.group);

// Per-panel label: the lamp's size, and how often a blind walk finds it.
const panelLabels = SHRINKS.map((_, i) =>
  label('', {
    size: 0.05,
    color: C.ash,
    anchorX: 'center',
    anchorY: 'top',
    position: [(i - 1) * PANEL_X, PANEL_Y - PANEL_H / 2 - 0.05, 0],
  }),
);
panelLabels.forEach((l) => stage.hud.add(l));

let panels: FilmPanel[] | null = null;
function ensurePanels(width: number, height: number): FilmPanel[] {
  if (panels && panels[0]!.width === width && panels[0]!.height === height) return panels;
  panels?.forEach((p) => p.dispose());
  panels = SHRINKS.map((_, i) =>
    new FilmPanel({
      width,
      height,
      center: [(i - 1) * PANEL_X, PANEL_Y],
      drawnHeight: PANEL_H,
    }),
  );
  panels.forEach((p) => stage.hud.add(p.group));
  return panels;
}

// --- Controls --------------------------------------------------------------
const params = {
  scene: 'cornell' as SceneName,
  tracer: 'pt' as TracerName,
  pacing: 'log' as Pacing,
  maxSpp: MAX_SPP,
  holdStart: HOLD_START,
  holdEnd: HOLD_END,
};

ui.params.add(params, 'scene', SCENE_NAMES).onChange(restart);
ui.params.add(params, 'tracer', TRACER_NAMES).onChange(restart);
ui.params.add(params, 'pacing', ['log', 'linear', 'sqrt']).onChange(rebuildSchedule);
ui.params.add(params, 'maxSpp', 1, MAX_SPP, 1).name('up to (spp)').onChange(rebuildSchedule);
ui.params.add(params, 'holdStart', 0, 5, 0.1).name('hold first (s)').onChange(rebuildSchedule);
ui.params.add(params, 'holdEnd', 0, 5, 0.1).name('hold last (s)').onChange(rebuildSchedule);

let schedule: number[] = [];
let scheduledFor = -1;
function rebuildSchedule(): void {
  scheduledFor = stage.duration;
  schedule = sppSchedule({
    frames: Math.max(1, Math.round(stage.duration * FPS)),
    maxSpp: Math.min(params.maxSpp, MAX_SPP),
    pacing: params.pacing,
    holdStart: Math.round(params.holdStart * FPS),
    holdEnd: Math.round(params.holdEnd * FPS),
  });
}

// --- Rendering -------------------------------------------------------------
let sequences: (ConvergenceSequence | null)[] = [null, null, null];
let shownSpp = -1;
let ready: Promise<unknown> = Promise.resolve();
let inFlight: AbortController | null = null;
let generation = 0;

/** The lamp's side length, for the label. */
function lampSide(scene: SceneName, shrink: number): number {
  const lamp = withLampShrunk(SCENES[scene], shrink).primitives.find((p) => p.emission);
  if (!lamp || lamp.shape.kind !== 'quad') return 0;
  const { e1 } = lamp.shape;
  return Math.hypot(e1[0], e1[1], e1[2]);
}

function restart(): void {
  const gen = ++generation;
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  sequences = [null, null, null];
  shownSpp = -1;
  stage.speed = 0;
  stage.t = 0;
  rebuildSchedule();

  const { scene, tracer } = params;
  ensurePanels(RES, RES);
  SHRINKS.forEach((shrink, i) => {
    const side = lampSide(scene, shrink);
    setText(panelLabels[i]!, side > 0 ? `${side.toFixed(2)} × ${side.toFixed(2)}` : '—');
  });

  progress.visible = true;
  progress.set(0);
  setText(caption, `${tracer} · ${scene} · rendering three lamps…`);

  // CONCURRENTLY, and blitting every pass as it lands.
  //
  // The first version rendered the three in turn and showed nothing until
  // all three had finished — three black panels for about three minutes,
  // which reads as a broken page rather than as a slow one. Each render is
  // its own worker, so running them together costs nothing on any machine
  // with three spare cores, and `onProgress` already carries the developed
  // frame, so the panels can converge live in front of you. There is no
  // black period at all now: the first pass appears within a second.
  const fraction = SHRINKS.map(() => 0);
  ready = Promise.all(
    SHRINKS.map((shrink, i) =>
      ConvergenceSequence.render({
        description: withLampShrunk(SCENES[scene], shrink),
        integrator: TRACERS[tracer]!,
        width: RES,
        height: RES,
        maxSpp: MAX_SPP,
        seed: SEED,
        signal: controller.signal,
        onProgress: ({ spp, maxSpp, rgba }) => {
          if (gen !== generation) return;
          fraction[i] = spp / maxSpp;
          progress.set(fraction.reduce((a, b) => a + b, 0) / SHRINKS.length);
          if (rgba) panels?.[i]?.update(rgba);
          // The slowest panel names the count, so the caption never claims
          // more samples than every panel has actually reached.
          const least = Math.round(Math.min(...fraction) * maxSpp);
          setText(caption, `${tracer} · ${scene} · rendering… ${least} / ${maxSpp} spp`);
        },
      }).then((seq) => {
        if (gen === generation) sequences[i] = seq;
      }),
    ),
  )
    .then(() => {
      if (gen !== generation) return;
      progress.visible = false;
      shownSpp = -1;
      stage.speed = 1;
    })
    .catch((err: Error) => {
      if (gen !== generation || controller.signal.aborted) return;
      progress.visible = false;
      setText(caption, `render failed: ${err.message}`);
    });
}

stage.onReady(async () => {
  await ready;
});

stage.frame((t) => {
  if (stage.duration !== scheduledFor) rebuildSchedule();
  if (sequences.some((s) => s === null)) return;
  const frame = Math.min(schedule.length - 1, Math.max(0, Math.floor(t * FPS)));
  const spp = schedule[frame] ?? 1;
  if (spp === shownSpp) return;
  shownSpp = spp;
  sequences.forEach((seq, i) => {
    const rgba = seq?.at(spp);
    if (rgba) panels?.[i]?.update(rgba);
  });
  setText(
    caption,
    `${params.tracer} · ${spp} sample${spp === 1 ? '' : 's'} per pixel · ` +
      `equal light in every room`,
  );
});

stage.start();
restart();

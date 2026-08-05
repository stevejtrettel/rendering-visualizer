/**
 * SHOWS: why next-event estimation exists — the same three shrinking lamps,
 * run by two methods, one of which does not care.
 *
 * The companion to `lamp-shrink`, which watches ONE method fail alone. Here
 * the columns are the same three lamps at constant total emitted power
 * (radiance scaled by 1/area — see withLampShrunk), and the rows are two
 * tracers at identical sample counts.
 *
 * The top row collapses across the columns and the bottom row barely moves.
 * That gap IS the argument: a BSDF-sampled walk reaches the emitter by
 * accident, and accidents get rare as the target shrinks — measured hit
 * rates 9.20% / 0.73% / 0.15% — while a method that CONNECTS to the light
 * on purpose is indifferent to how big it is. Nothing about the scene
 * changed between the rows; only the sampling strategy did.
 *
 * Read down a column rather than across a row and it says the same thing
 * the other way: at the widest lamp the two methods are close, and by the
 * narrowest one of them has stopped working.
 */

import { createStage, createUI, C } from '@';
import { SCENES, withLampShrunk, type SceneName } from '@/scenes/registry';
import type { IntegratorDescription } from '@/render/protocol';
import { FilmPanel } from '@/viz/film-panel';
import { ConvergenceSequence, sppSchedule, type Pacing } from '@/render/convergence';
import { label, setText } from '@/viz/text';
import { ProgressBar } from '@/viz/progress-bar';

// --- Figure spec -----------------------------------------------------------
// Six panels at once, so the film is small — and the figure is about noise,
// not detail. NearestFilter means one film pixel is a visible square at
// export, which is what you want when the question is how many pixels found
// the lamp. Memory is distinct-spp x RES² x 4 per panel: ~14 MB here.
const RES = 128;
const MAX_SPP = 256;
const MAX_DEPTH = 8;
const SEED = 0;
const FPS = 60;
const DURATION = 14;
const HOLD_START = 1.0;
const HOLD_END = 1.8;
// Shrink factors, not sizes: the hit rate falls with AREA, so 1/4/8 reads as
// a collapse (9.20% / 0.73% / 0.15%) where halving steps read as a decline.
const SHRINKS = [1, 4, 8] as const;

const PANEL_H = 0.68; // square film, so this is the drawn width too
const COL_X = [-0.62, 0.16, 0.94] as const; // shifted right to clear the row labels
const ROW_Y = [0.42, -0.36] as const;
const COL_LABEL_Y = ROW_Y[0] + PANEL_H / 2 + 0.11;
const ROW_LABEL_X = COL_X[0] - PANEL_H / 2 - 0.07;

const SCENE_NAMES = Object.keys(SCENES) as SceneName[];

const TRACERS: Record<string, IntegratorDescription> = {
  'pt-naive': { name: 'pt-term', maxBounces: MAX_DEPTH, directions: 'uniform' },
  pt: { name: 'pt', maxBounces: MAX_DEPTH },
  'pt-nee': { name: 'pt-nee', maxBounces: MAX_DEPTH },
  'pt-sms': { name: 'pt-sms', maxBounces: MAX_DEPTH },
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
  size: 0.058,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'top',
  position: [0, -0.8, 0],
});
stage.hud.add(caption);

const progress = new ProgressBar({ center: [0, -0.93], width: 1.1 });
stage.hud.add(progress.group);

// Columns are lamps, rows are methods, so each gets its own heading — a
// caption naming six panels at once would be unreadable.
const colLabels = SHRINKS.map((_, c) =>
  label('', {
    size: 0.05,
    color: C.ash,
    anchorX: 'center',
    anchorY: 'bottom',
    position: [COL_X[c]!, COL_LABEL_Y, 0],
  }),
);
const rowLabels = ROW_Y.map((y) =>
  label('', {
    size: 0.055,
    color: C.bone,
    anchorX: 'right',
    anchorY: 'middle',
    position: [ROW_LABEL_X, y, 0],
  }),
);
[...colLabels, ...rowLabels].forEach((l) => stage.hud.add(l));

// Panels in row-major order: index = row * 3 + column.
let panels: FilmPanel[] | null = null;
function ensurePanels(): FilmPanel[] {
  if (panels && panels[0]!.width === RES) return panels;
  panels?.forEach((p) => p.dispose());
  panels = ROW_Y.flatMap((y, r) =>
    SHRINKS.map((_, c) =>
      new FilmPanel({
        width: RES,
        height: RES,
        center: [COL_X[c]!, y],
        drawnHeight: PANEL_H,
      }),
    ),
  );
  panels.forEach((p) => stage.hud.add(p.group));
  return panels;
}

// --- Controls --------------------------------------------------------------
const params = {
  scene: 'cornell' as SceneName,
  top: 'pt' as TracerName,
  bottom: 'pt-nee' as TracerName,
  pacing: 'log' as Pacing,
  maxSpp: MAX_SPP,
  holdStart: HOLD_START,
  holdEnd: HOLD_END,
};

ui.params.add(params, 'scene', SCENE_NAMES).onChange(restart);
ui.params.add(params, 'top', TRACER_NAMES).name('top row').onChange(restart);
ui.params.add(params, 'bottom', TRACER_NAMES).name('bottom row').onChange(restart);
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
const CELLS = ROW_Y.length * SHRINKS.length;
let sequences: (ConvergenceSequence | null)[] = new Array(CELLS).fill(null);
let shownSpp = -1;
let ready: Promise<unknown> = Promise.resolve();
let inFlight: AbortController | null = null;
let generation = 0;

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

  sequences = new Array(CELLS).fill(null);
  shownSpp = -1;
  stage.speed = 0;
  stage.t = 0;
  rebuildSchedule();
  ensurePanels();

  const { scene } = params;
  const rows: TracerName[] = [params.top, params.bottom];
  SHRINKS.forEach((shrink, c) => {
    const side = lampSide(scene, shrink);
    setText(colLabels[c]!, side > 0 ? `${side.toFixed(2)} × ${side.toFixed(2)}` : '—');
  });
  rows.forEach((name, r) => setText(rowLabels[r]!, String(name)));

  progress.visible = true;
  progress.set(0);

  // All six at once, each blitting its passes as they land — see the note in
  // lamp-shrink: rendering these in turn shows nothing for minutes, which
  // reads as a broken page rather than a slow one.
  const fraction = new Array(CELLS).fill(0);
  ready = Promise.all(
    rows.flatMap((tracer, r) =>
      SHRINKS.map((shrink, c) => {
        const i = r * SHRINKS.length + c;
        return ConvergenceSequence.render({
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
            progress.set(fraction.reduce((a: number, b: number) => a + b, 0) / CELLS);
            if (rgba) panels?.[i]?.update(rgba);
            const least = Math.round(Math.min(...fraction) * maxSpp);
            setText(caption, `${scene} · rendering… ${least} / ${maxSpp} spp`);
          },
        }).then((seq) => {
          if (gen === generation) sequences[i] = seq;
        });
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
    `${spp} sample${spp === 1 ? '' : 's'} per pixel · equal light in every room · ` +
      `the lamp shrinks left to right`,
  );
});

stage.start();
restart();

/**
 * SHOWS: one finished image. Pick a scene, pick a tracer, pick a sample
 * count, wait, look at it.
 *
 * The plainest page in the set, and the one that was missing. `convergence`
 * has the same three controls but is built on ConvergenceSequence, which
 * exists to RETAIN every intermediate pass so it can play them back as a
 * movie; that is the wrong machine when all you want is the last frame, and
 * at high spp it is a lot of held memory for images nobody looks at.
 * `cornell-tune` renders a plain still but is welded to the Cornell box with
 * material dials instead of a scene menu.
 *
 * So this page keeps nothing. It runs a WorkerPool — every core on ONE
 * image — and blits each merged update straight into the panel. The pool is
 * exactly what `convergence` may not use: it merges "whichever passes have
 * arrived", so the intermediate states are timing-dependent and a movie
 * built from them would not replay. Here only the final image is the output,
 * and THAT is bit-deterministic (films are sums, merged in worker order), so
 * the objection does not apply and the page is several times faster for it.
 *
 * Resolution is a control because there is no movie to budget for: this is
 * the page you use to make a still for a slide, so make it big. Press S when
 * the caption stops moving.
 *
 * Any control change re-renders from scratch — including raising the sample
 * count, which does NOT continue from where it was. Restarting is the
 * predictable thing, and the alternative (resume on raise, restart on
 * everything else) is a rule you would have to remember at the podium.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import type { SceneDescription } from '@/core/scene/scene';
import type { IntegratorDescription } from '@/render/protocol';
import { WorkerPool, type PoolUpdate } from '@/render/pool';
import { passesAreExchangeable } from '@/render/renderer';
import { FilmPanel } from '@/viz/film-panel';
import { label, setText } from '@/viz/text';
import { ProgressBar } from '@/viz/progress-bar';

// --- Figure spec -----------------------------------------------------------
const SEED = 0;
const PANEL = { center: [0, 0.06] as [number, number], height: 1.62 };
const RESOLUTIONS = [160, 240, 320, 480, 640, 800];
const MAX_SPP = 8192;

// Leave the browser and the compositor a core each; the pool would otherwise
// starve the main thread and the page would stop repainting the very image
// it is rendering.
const POOL_SIZE = Math.max(1, (navigator.hardwareConcurrency || 4) - 2);

const SCENE_NAMES = Object.keys(SCENES) as SceneName[];

// The same preset table as `convergence`, so the two pages name the same
// tracers the same way — a still and its convergence movie should not
// disagree about what "pt-naive" means. Depth is a parameter here rather
// than a baked constant, since a still is also how you check what a depth
// cap is actually costing you.
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

// Only `material-row` is authored for a non-square film (registry.ts).
const filmSize = (scene: SceneName, res: number): { width: number; height: number } =>
  scene === 'material-row' ? { width: res, height: Math.round(res / 2) } : { width: res, height: res };

// ReSTIR alone has no delta-light support: its reservoir target is the
// luminance of f*G*Le at a sampled light vertex, and PointLight.le() is
// black by construction, so the target is identically zero. BDPT and MMLT
// carry point lights fine (tests/delta-light-mis.test.ts) and plain PT
// correctly renders black, which is those scenes' whole point rather than a
// fault. Recorded in docs/design-cleanup.md §7.
const hasDeltaLight = (d: SceneDescription): boolean => (d.pointLights?.length ?? 0) > 0;
const unsupported = (scene: SceneName, tracer: TracerName): string | null =>
  hasDeltaLight(SCENES[scene]) && tracer === 'restir'
    ? `restir has no delta-light support (reservoir target is zero) — ${scene} needs another tracer`
    : null;

// MMLT spends mutations, not independent samples; calling them "samples"
// would misdescribe what the number counts.
const unitOf = (tracer: TracerName): string => (tracer === 'mmlt' ? 'mpp' : 'spp');

// --- Stage -----------------------------------------------------------------
// No timeline: nothing here moves, so a speed slider and a loop length would
// be controls for a thing that does not exist. S (save PNG) is unaffected —
// it lives in Capture, which stays.
const stage = createStage({ lights: false, controls: false });
const ui = createUI(stage, { timeline: false });
stage.camera.position.set(0, 0, 5); // the figure is entirely the HUD
stage.speed = 0; // a still has no clock to run

const caption = label('', {
  size: 0.075,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'top',
  position: [0, -0.79, 0],
});
stage.hud.add(caption);

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
  spp: 256,
  maxDepth: 8,
  resolution: 320,
};

ui.params.add(params, 'scene', SCENE_NAMES).onChange(restart);
ui.params.add(params, 'tracer', TRACER_NAMES).onChange(restart);
ui.params.add(params, 'spp', 1, MAX_SPP, 1).name('samples').onChange(restart);
ui.params.add(params, 'maxDepth', 1, 24, 1).name('max depth').onChange(restart);
ui.params.add(params, 'resolution', RESOLUTIONS).name('resolution (px)').onChange(restart);

// --- Rendering -------------------------------------------------------------
// The pool fixes width and height at construction (its merge film is sized
// there), so a resolution change needs a fresh one. Everything else is a
// restart on the pool we already have, which keeps the workers warm.
//
// PoolOptions.onUpdate is likewise fixed at construction, so the live one
// sits behind this indirection and a restart just swaps it.
let pool: WorkerPool | null = null;
let poolSize: { width: number; height: number } | null = null;
let onUpdate: (u: PoolUpdate) => void = () => {};

// `ready` is what the exporter waits on. S saves immediately and
// deliberately — sometimes the half-converged image IS the figure — but V
// holds until the render finishes.
let ready: Promise<void> = Promise.resolve();
let resolveReady: (() => void) | null = null;

function restart(): void {
  resolveReady?.(); // release anyone waiting on the superseded render
  ready = new Promise<void>((res) => (resolveReady = res));
  const settle = resolveReady!;

  const { scene, tracer, spp, maxDepth, resolution } = params;
  const size = filmSize(scene, resolution);
  // A panel holds its last upload, so without this the previous render stays
  // on screen — under the new caption — until the first pass of the new one
  // lands.
  ensurePanel(size.width, size.height).clear();

  const refusal = unsupported(scene, tracer);
  if (refusal) {
    pool?.dispose();
    pool = null;
    poolSize = null;
    onUpdate = () => {};
    progress.visible = false;
    setText(caption, refusal);
    settle();
    return;
  }

  progress.visible = true;
  progress.set(0);
  setText(caption, `${tracer} · ${scene} · rendering…`);

  const integrator = TRACERS[tracer](maxDepth);
  const workers = passesAreExchangeable(integrator.name) ? POOL_SIZE : 1;
  let done = false;

  onUpdate = (u) => {
    panel?.update(u.frame().rgba);
    const secs = (u.wallMillis / 1000).toFixed(1);
    if (u.totalSpp < spp) {
      progress.set(u.totalSpp / spp);
      setText(caption, `${tracer} · ${scene} · ${u.totalSpp} / ${spp} ${unitOf(tracer)} · ${secs} s`);
      return;
    }
    if (done) return; // trailing in-flight passes after the target was met
    done = true;
    progress.visible = false;
    setText(caption, `${tracer} · ${scene} · ${spp} ${unitOf(tracer)} · ${secs} s`);
    console.log(
      `[still] ${tracer} · ${scene} · ${size.width}x${size.height} · ${spp} ${unitOf(tracer)} · ` +
        `${secs} s on ${workers} worker${workers === 1 ? '' : 's'} · press S to save`,
    );
    settle();
  };

  if (pool && poolSize && poolSize.width === size.width && poolSize.height === size.height) {
    pool.restart(SCENES[scene], { integrator, maxSpp: spp });
    return;
  }
  pool?.dispose();
  poolSize = size;
  pool = new WorkerPool({
    size: POOL_SIZE,
    description: SCENES[scene],
    width: size.width,
    height: size.height,
    seed: SEED,
    integrator,
    maxSpp: spp,
    onUpdate: (u) => onUpdate(u),
  });
}

stage.onReady(() => ready);
stage.start();
restart();

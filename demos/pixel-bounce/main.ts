/**
 * SHOWS: rays groping for the light. One ray per pixel leaves the grid on
 * the camera frustum, and the whole population walks out in lockstep — one
 * bounce per beat, ten beats — dark the whole way. A ray that lands on the
 * lamp flips to ochre, whole path at once, and stops there.
 *
 * The rest of the pixel series is about the image: pixel-grid watches one
 * form sample by sample, pixel-grid-still shows the finished computation,
 * pixel-sweep slows to a single cell. This one drops the image entirely —
 * no plane content, no panel, just the box — because the subject is what
 * happens BEFORE any of that: a few hundred rays wandering a room, and how
 * few of them ever touch the light.
 *
 * Two things about it are deliberate:
 *
 *   brute force   the tracer is `pt`, BSDF sampling only. Under NEE the
 *                 light arrives down a shadow ray and no vertex of the walk
 *                 is ever ON the lamp, so there is no moment to flip. The
 *                 event this figure is built around only exists for the
 *                 tracer that has to find the emitter by luck.
 *   lockstep      every ray's k-th flight takes the same beat however far
 *                 it travels, so "bounce 4" is a moment you can count to
 *                 and the hits arrive in visible waves. pixel-grid is the
 *                 constant-speed version, for when the figure is about one
 *                 sample's flight rather than about depth.
 *
 * The last frame is the whole census: N rays, ten bounces, this many lit.
 * `hold` keeps it up before the loop starts over.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { UnidirectionalPT } from '@/core/integrators/pt';
import { tracePixelGrid, type PixelGridTrace } from '@/trace/pixel-grid';
import { sceneToThree } from '@/viz/three-scene';
import { PixelPlane } from '@/viz/pixel-plane';
import { BounceCloud } from '@/viz/bounce-cloud';
import { ProgressBar } from '@/viz/progress-bar';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const PLANE_DISTANCE = 1.4; // pinhole -> grid, world units, as in the series
// Pull back from the scene's standard vantage so the whole spray fits with
// the caption legible under it.
const ZOOM_OUT = 1.45;

const SCENE_NAMES = Object.keys(SCENES) as SceneName[];
const grouped = (n: number) => n.toLocaleString('en-US');

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });

// --- Controls --------------------------------------------------------------
// Declared before createUI: this figure's loop is derived (bounces x beat,
// plus the hold), and the Capture folder reads `duration` ONCE to default
// its export range.
const params = {
  scene: 'cornell' as SceneName,
  // 24 x 24 = 576 rays. The census (cornell, pt, cap 10, one ray per pixel)
  // is what picked it: about 1.3% of paths ever touch the lamp, so a small
  // grid is a figure where nothing happens — 16 x 16 at seed 0 lights ONE
  // ray of 256. At 24 the default seed lights 11, spread over bounces 1, 2,
  // 3, 4, 5, 7 and 9, so the hits arrive right through the build instead of
  // clumping. 32 x 32 works too and is denser (16 of 1024 at seed 0).
  grid: 24,
  bounces: 10,
  // Seconds a bounce spends in flight, and the beat after it lands. The
  // beat is what makes the depth countable — without it the waves run
  // together and ten bounces read as one continuous scribble.
  flySeconds: 0.55,
  settleSeconds: 0.25,
  hold: 2,
  // One ray per pixel — which sample it is, is a choice, so it is a knob.
  seed: 0,
  opacity: 0.9,
  // How far into the void the misses are pushed. Low is truthful and
  // reads badly on a projector; the default keeps them visible as a mass.
  darkDim: 0.7,
  grid3d: true, // the cell grid on the frustum plane
  captions: true,
};

const initialBeat = params.flySeconds + params.settleSeconds;
stage.duration = params.bounces * initialBeat + params.hold;
const ui = createUI(stage);

let sceneGroup: THREE.Group | null = null;
const rayGroup = new THREE.Group();
const planeGroup = new THREE.Group();
stage.add(rayGroup, planeGroup);

const caption = label('', {
  size: 0.06,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'top',
  position: [0, -0.8, 0],
});
stage.hud.add(caption);

const progress = new ProgressBar({ center: [0, -0.92], width: 1.1 });
stage.hud.add(progress.group);

ui.params.add(params, 'scene', SCENE_NAMES).onChange(restart);
ui.params.add(params, 'grid', [4, 8, 12, 16, 24, 32]).name('grid (n x n)').onChange(restart);
ui.params.add(params, 'bounces', 1, 16, 1).name('bounces').onChange(restart);
ui.params.add(params, 'flySeconds', 0.1, 1.5, 0.05).name('flight (s)').onChange(retime);
ui.params.add(params, 'settleSeconds', 0, 1, 0.05).name('beat (s)').onChange(retime);
ui.params.add(params, 'hold', 0, 6, 0.5).name('hold (s)').onChange(retime);
ui.params.add(params, 'seed', 0, 32, 1).name('sample seed').onChange(restart);
ui.params.add(params, 'opacity', 0.05, 1, 0.05).onChange(() => cloud?.setOpacity(params.opacity));
ui.params
  .add(params, 'darkDim', 0.1, 1, 0.05)
  .name('miss brightness')
  .onChange(() => cloud?.setDark(C.slateDeep, params.darkDim));
ui.params.add(params, 'grid3d').name('cell grid').onChange(() => {
  if (plane) plane.group.visible = params.grid3d;
});
ui.params.add(params, 'captions').onChange(() => {
  caption.visible = params.captions;
});

// --- Playback --------------------------------------------------------------
let trace: PixelGridTrace | null = null;
let cloud: BounceCloud | null = null;
let plane: PixelPlane | null = null;
let shown = '';

function retime(): void {
  if (trace) rebuildElements();
}

function rebuildElements(): void {
  if (!trace) return;
  cloud?.dispose();
  shown = '';

  cloud = new BounceCloud({
    paths: trace.paths[0]!,
    maxBounces: params.bounces,
    flySeconds: params.flySeconds,
    settleSeconds: params.settleSeconds,
    holdSeconds: params.hold,
    darkDim: params.darkDim,
    opacity: params.opacity,
  });
  rayGroup.add(cloud.group);

  stage.duration = cloud.duration;
  stage.t = 0;
  console.log(
    `[pixel-bounce] ${grouped(cloud.pathCount)} rays · ${cloud.litCount} reach the lamp ` +
      `within ${params.bounces} bounces · deepest walk ${cloud.deepest}`,
  );
}

stage.frame((t) => {
  if (!cloud) return;
  cloud.drawAt(t);
  if (!params.captions) return;

  const bounce = cloud.bounceAt(t);
  const found = cloud.litBy(t);
  const key = `${bounce}/${found}`;
  if (key === shown) return;
  shown = key;
  setText(
    caption,
    `${grouped(cloud.pathCount)} rays · bounce ${bounce} of ${cloud.deepest} · ` +
      `${found} ${found === 1 ? 'has' : 'have'} found the light`,
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

  trace = null;
  cloud?.dispose();
  cloud = null;
  shown = '';
  stage.speed = 0;
  stage.t = 0;

  // Swap the 3D scene.
  if (sceneGroup) stage.scene.remove(sceneGroup);
  sceneGroup = sceneToThree(SCENES[params.scene]);
  stage.add(sceneGroup);
  const view = vizViewFor(params.scene);
  const target = new THREE.Vector3(...view.target);
  // Back off along the view direction rather than widening the fov: the
  // frustum the grid hangs on has to keep matching the CPU camera.
  const eye = new THREE.Vector3(...view.eye).sub(target).multiplyScalar(ZOOM_OUT).add(target);
  stage.camera.position.copy(eye);
  stage.controls?.target.copy(target);
  stage.controls?.update();

  const res = params.grid;
  // The plane carries no image — it is never blitted, so its texture stays
  // fully transparent and only the cell grid shows. That IS the point: the
  // rays have to come from somewhere the audience reads as film, and the
  // picture those rays are for is not this figure's business.
  plane?.dispose();
  plane = new PixelPlane({ camera: SCENES[params.scene].camera, distance: PLANE_DISTANCE, res },
    planeGroup);
  plane.group.visible = params.grid3d;

  progress.visible = true;
  progress.set(0);
  setText(caption, `pt · ${params.scene} · tracing…`);

  ready = tracePixelGrid({
    scene: buildScene(SCENES[params.scene], res, res),
    // Brute force, no NEE, no Russian roulette: the walk must survive to
    // `bounces` on its own, and the only way it sees the lamp is by hitting
    // it. Both are the figure.
    integrator: new UnidirectionalPT({
      maxBounces: params.bounces,
      rrStartDepth: 99,
      sampleNEE: false,
    }),
    res,
    samples: 1,
    seed: params.seed,
    signal: controller.signal,
    onProgress: (done, total) => {
      if (gen !== generation) return;
      progress.set(done / total);
      setText(caption, `pt · tracing ${Math.round((100 * done) / total)}%`);
    },
  })
    .then((result) => {
      if (gen !== generation) return;
      trace = result;
      progress.visible = false;
      rebuildElements();
      stage.speed = 1;
    })
    .catch((err: Error) => {
      if (err.name === 'AbortError') return;
      progress.visible = false;
      setText(caption, `trace failed: ${err.message}`);
    });
}

stage.onReady(() => ready);
stage.start();
restart();

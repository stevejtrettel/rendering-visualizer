/**
 * SHOWS: level zero, the picture-maker before path tracing. The same film
 * grid as pixel-grid floats on the camera frustum; one ray leaves through
 * each pixel, stops at the first thing it hits, and the pixel takes that
 * thing's colour. No lighting, no bounces, one ray per pixel.
 *
 * pixel-grid comes later in the talk and is this figure with everything
 * added: bounces, light, and many samples averaged. Same scene, camera and
 * grid, so the two read as one picture growing up.
 *
 * The rays sweep in raster order, and a pixel lights the moment its own ray
 * lands, on the plane and in the square-on inset alike. The figure ramps to
 * the finished image and holds it.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { FirstHitColor, surfaceColors } from '@/core/integrators/first-hit';
import { tracePixelGrid, type PixelGridTrace } from '@/trace/pixel-grid';
import { sceneToThree } from '@/viz/three-scene';
import { ImagePlaneElement } from '@/viz/image-plane';
import { PixelRays } from '@/viz/pixel-rays';
import { FilmPanel } from '@/viz/film-panel';
import { srgbEncode } from '@/render/film';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
// Matched to pixel-grid, so the two figures share a frame.
const SEED = 0;
const PLANE_DISTANCE = 1.4;
const ZOOM_OUT = 1.45;
const INSET = { center: [-1.3, -0.42] as [number, number], height: 0.62 };
// Seconds the slowest ray spends in flight, and on the finished image.
const FLIGHT = 1.2;
const HOLD = 2.5;
/** What a pixel shows before its ray lands. */
const BLANK = 18;

const SCENE_NAMES = Object.keys(SCENES) as SceneName[];

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });
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

let inset: FilmPanel | null = null;
let insetPixels: Uint8ClampedArray | null = null;

// --- Controls --------------------------------------------------------------
const params = {
  scene: 'cornell' as SceneName,
  grid: 8,
  sweepSeconds: 6,
};
ui.params.add(params, 'scene', SCENE_NAMES).onChange(restart);
ui.params.add(params, 'grid', [4, 6, 8, 12, 16, 32]).name('grid (n x n)').onChange(restart);
ui.params.add(params, 'sweepSeconds', 0.5, 20, 0.5).name('sweep (s)').onChange(rebuild);

// --- Playback --------------------------------------------------------------
let trace: PixelGridTrace | null = null;
let rays: PixelRays | null = null;
let plane: ImagePlaneElement | null = null;
let revealAt: Float32Array | null = null;
let shown = -1;

function rebuild(): void {
  if (!trace) return;
  rays?.dispose();
  plane?.dispose();
  shown = -1;

  const period = params.sweepSeconds + FLIGHT + HOLD;
  rays = new PixelRays({
    paths: trace.paths,
    samplePeriod: period,
    launch: 'sweep',
    sweepSeconds: params.sweepSeconds,
    drawFraction: (params.sweepSeconds + FLIGHT) / period,
    fadeFraction: 0, // the rays stay: the finished figure shows every one
    darkDim: 1,
  });
  rayGroup.add(rays.group);

  const n = trace.res * trace.res;
  revealAt = new Float32Array(n);
  for (let i = 0; i < n; i++) revealAt[i] = rays.landTime(0, i);

  plane = new ImagePlaneElement(
    {
      camera: SCENES[params.scene].camera,
      distance: PLANE_DISTANCE,
      res: trace.res,
      samples: 1,
      dwell: period,
      cumulative: trace.cumulative,
      highlight: null,
      revealAt,
    },
    planeGroup,
  );

  stage.duration = period;
  stage.t = 0;
}

function paintInset(t: number): void {
  if (!trace || !inset || !insetPixels || !revealAt) return;
  const { res, cumulative } = trace;
  for (let i = 0; i < res * res; i++) {
    const o = i * 4;
    if (t < revealAt[i]!) {
      insetPixels[o] = insetPixels[o + 1] = insetPixels[o + 2] = BLANK;
    } else {
      insetPixels[o] = srgbEncode(cumulative[i * 3]!);
      insetPixels[o + 1] = srgbEncode(cumulative[i * 3 + 1]!);
      insetPixels[o + 2] = srgbEncode(cumulative[i * 3 + 2]!);
    }
    insetPixels[o + 3] = 255;
  }
  inset.update(insetPixels);
}

stage.frame((t) => {
  if (!trace || !rays || !plane || !revealAt) return;
  rays.drawAt(t);
  plane.drawAt(t);
  let landed = 0;
  for (let i = 0; i < revealAt.length; i++) if (t >= revealAt[i]!) landed++;
  if (landed === shown) return;
  shown = landed;
  paintInset(t);
  setText(caption, `${trace.res}x${trace.res} pixels · ${landed} of ${revealAt.length} rays`);
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
  stage.speed = 0;
  stage.t = 0;

  if (sceneGroup) stage.scene.remove(sceneGroup);
  sceneGroup = sceneToThree(SCENES[params.scene]);
  stage.add(sceneGroup);
  const view = vizViewFor(params.scene);
  const target = new THREE.Vector3(...view.target);
  // Back off along the view direction rather than widening the fov: the
  // frustum has to keep matching the CPU camera the image plane sits on.
  const eye = new THREE.Vector3(...view.eye).sub(target).multiplyScalar(ZOOM_OUT).add(target);
  stage.camera.position.copy(eye);
  stage.controls?.target.copy(target);
  stage.controls?.update();

  const res = params.grid;
  if (!inset || inset.width !== res) {
    inset?.dispose();
    inset = new FilmPanel({ width: res, height: res, center: INSET.center, drawnHeight: INSET.height });
    insetPixels = new Uint8ClampedArray(res * res * 4);
    stage.hud.add(inset.group);
  }
  setText(caption, 'tracing…');

  ready = tracePixelGrid({
    scene: buildScene(SCENES[params.scene], res, res),
    integrator: new FirstHitColor(surfaceColors(SCENES[params.scene])),
    res,
    samples: 1,
    seed: SEED,
    signal: controller.signal,
  })
    .then((result) => {
      if (gen !== generation) return;
      trace = result;
      rebuild();
      stage.speed = 1;
    })
    .catch((err: Error) => {
      if (err.name === 'AbortError') return;
      setText(caption, `trace failed: ${err.message}`);
    });
}

stage.onReady(() => ready);
stage.start();
restart();

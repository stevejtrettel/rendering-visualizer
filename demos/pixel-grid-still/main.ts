/**
 * SHOWS: the finished computation, all at once. The cousin of pixel-grid,
 * which animates an image forming one sample at a time — this one skips to
 * the end and draws EVERY ray of EVERY sample simultaneously, with the
 * converged image on the frustum plane inside the scene and the same image
 * large beside it.
 *
 * The reading is different from its cousin's, and that is the point.
 * pixel-grid says "here is the loop". This says "here is the work": tens of
 * thousands of paths, most of them reporting nothing, and the picture that
 * fell out of averaging them. The left panel is not a prettier render — it
 * is the identical n x n image the plane carries, blown up, so every square
 * on it is one cell of the plane and one bundle in the fog.
 *
 * Static by default: every frame is identical and `S` gives you the PNG.
 * Turn `orbit` up and the camera arcs there-and-back over one loop, which
 * makes the cloud read as a volume rather than a tangle — the geometry is
 * built once either way, so the motion is free.
 */

import { createStage, createUI, C, EXPORT_W, EXPORT_H } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { UnidirectionalPT } from '@/core/integrators/pt';
import { SingleTermPT } from '@/core/integrators/pt-term';
import { NEEPathTracer } from '@/core/integrators/pt-nee';
import { SMSPathTracer } from '@/core/integrators/pt-sms';
import { BDPT } from '@/core/integrators/bdpt';
import type { Integrator } from '@/core/integrators/types';
import { tracePixelGrid, type PixelGridTrace } from '@/trace/pixel-grid';
import { sceneToThree } from '@/viz/three-scene';
import { ImagePlaneElement, meanAt } from '@/viz/image-plane';
import { PixelRayCloud, type CloudBlend } from '@/viz/pixel-ray-cloud';
import { FilmPanel } from '@/viz/film-panel';
import { ProgressBar } from '@/viz/progress-bar';
import { srgbEncode } from '@/render/film';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SEED = 0;
const MAX_DEPTH = 6; // matches pixel-grid, so the two figures cut together
const PLANE_DISTANCE = 1.4; // pinhole -> grid, world units
const DARK_DIM = 0.45; // unlit paths, dimmed rather than dropped
const LOOP_SECONDS = 8; // only matters when orbiting
// The panel is the figure's other half, so it gets real estate: a third of
// the frame, with the scene pushed right to clear it (see `shift`).
const PANEL = { center: [-1.05, 0.06] as [number, number], height: 1.32 };

// The two halves are one pair of squares, sized and aligned to match.
//
// Cornell's opening is 4 x 4 world units at z = 11, and the panel is 1.32
// HUD units — 66% of the frame's height. A 42-degree vertical fov puts
// those equal when the eye sits 4 / (0.66 · 2 tan 21°) = 7.89 units back
// from the opening, which off the standard vantage (14.56 units from its
// target) is a distance multiplier of 1.23. At that distance the 4-wide
// opening also spans 1.32 HUD units across, so the box and the image are
// literally the same square. `shift`/`raise` then centre one in each half
// of the frame; the defaults below are those numbers, and every one of
// them is a slider because they are numbers about THIS scene.
const DEFAULT_ZOOM = 1.23;
const DEFAULT_SHIFT = 0.19; // scene right by 0.19 frame widths
const DEFAULT_RAISE = 0.03; // and up onto the panel's centre line

// Which tracers can replay "this pixel, this sample" at all — same list as
// pixel-grid, and absent for the same reasons (MMLT mutates a chain, ReSTIR
// reuses across whole-frame passes; neither has "this pixel's sample s").
type GridTracer = 'pt' | 'pt-term' | 'pt-nee' | 'pt-sms' | 'bdpt';
const TRACERS: GridTracer[] = ['pt', 'pt-term', 'pt-nee', 'pt-sms', 'bdpt'];
const makeIntegrator = (name: GridTracer): Integrator => {
  const depth = { maxBounces: MAX_DEPTH };
  switch (name) {
    case 'pt':
      return new UnidirectionalPT({ ...depth, rrStartDepth: 99, sampleNEE: false });
    case 'pt-term':
      return new SingleTermPT(depth);
    case 'pt-nee':
      return new NEEPathTracer({ ...depth, rrStartDepth: 99 });
    case 'pt-sms':
      return new SMSPathTracer({ ...depth, rrStartDepth: 99, estimator: 'unbiased' });
    case 'bdpt':
      return new BDPT({ ...depth, rrStartDepth: 99 });
  }
};

const SCENE_NAMES = Object.keys(SCENES) as SceneName[];
const hasDeltaLight = (name: SceneName) => (SCENES[name].pointLights?.length ?? 0) > 0;
const grouped = (n: number) => n.toLocaleString('en-US');

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });
const ui = createUI(stage);
stage.duration = LOOP_SECONDS;

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

// The plane inside the scene is seen obliquely; the panel shows the same
// image square-on and large. Same pixels, not a second render.
let panel: FilmPanel | null = null;
let panelPixels: Uint8ClampedArray | null = null;
function ensurePanel(res: number): FilmPanel {
  if (panel && panel.width === res) return panel;
  panel?.dispose();
  panel = new FilmPanel({
    width: res,
    height: res,
    center: PANEL.center,
    drawnHeight: PANEL.height,
  });
  panelPixels = new Uint8ClampedArray(res * res * 4);
  stage.hud.add(panel.group);
  return panel;
}

// --- Controls --------------------------------------------------------------
const params = {
  scene: 'cornell' as SceneName,
  tracer: 'pt-nee' as GridTracer,
  grid: 32,
  samples: 32,
  // How many of those samples get DRAWN. The image is always the full
  // `samples`; this only thins the fog when every sample at once is too
  // much to read.
  raysFrom: 32,
  opacity: 0.15,
  blend: 'normal' as CloudBlend,
  // Degrees of there-and-back azimuth over one loop. 0 = a true still, and
  // leaves the mouse free to orbit.
  orbit: 0,
  // Multiplier on the standard vantage's distance — below 1 is closer in.
  zoom: DEFAULT_ZOOM,
  // Degrees the eye is raised above the box's own axis. 0 is straight on:
  // the viz camera then shares the CPU camera's axis, so the frustum and
  // the image plane on it are seen face-on rather than foreshortened.
  elevation: 0,
  // Share of the frame the scene is pushed right by, to clear the panel.
  shift: DEFAULT_SHIFT,
  // …and up, onto the panel's centre line.
  raise: DEFAULT_RAISE,
};

ui.params.add(params, 'scene', SCENE_NAMES).onChange(restart);
ui.params.add(params, 'tracer', TRACERS).onChange(restart);
ui.params.add(params, 'grid', [8, 16, 32, 64]).name('grid (n x n)').onChange(restart);
// Drawing more samples than were traced is meaningless, so the fog slider's
// ceiling follows the sample count and its value comes down with it.
ui.params.add(params, 'samples', [8, 16, 32, 64]).name('samples (image)').onChange(() => {
  params.raysFrom = Math.min(params.raysFrom, params.samples);
  raysCtrl.max(params.samples).updateDisplay();
  restart();
});
const raysCtrl = ui.params
  .add(params, 'raysFrom', 1, params.samples, 1)
  .name('samples drawn')
  .onChange(rebuildCloud);
ui.params.add(params, 'opacity', 0.01, 1, 0.01).onChange(() => cloud?.setOpacity(params.opacity));
ui.params.add(params, 'blend', ['normal', 'additive']).onChange(rebuildCloud);
ui.params.add(params, 'orbit', 0, 40, 1).name('orbit (deg)');
ui.params.add(params, 'zoom', 0.6, 2, 0.01).name('distance (x)').onChange(placeCamera);
ui.params.add(params, 'elevation', -20, 30, 1).name('elevation (deg)').onChange(placeCamera);
ui.params.add(params, 'shift', -0.4, 0.4, 0.01).name('shift right').onChange(frameView);
ui.params.add(params, 'raise', -0.2, 0.2, 0.005).name('raise').onChange(frameView);

/**
 * Slide the rendered image inside the frame without moving the camera — an
 * off-axis frustum, so nothing skews and orbiting still works.
 *
 * Stage.shiftView does the horizontal half of this; the pair here needs the
 * vertical too, to sit the box on the panel's centre line. The x offset is
 * negated so both sliders read the way they are named — positive is right
 * and up — where the raw offsets move the subject left and up.
 */
function frameView(): void {
  stage.camera.setViewOffset(
    EXPORT_W,
    EXPORT_H,
    -params.shift * EXPORT_W,
    params.raise * EXPORT_H,
    EXPORT_W,
    EXPORT_H,
  );
}

// --- Elements --------------------------------------------------------------
let trace: PixelGridTrace | null = null;
let cloud: PixelRayCloud | null = null;
let plane: ImagePlaneElement | null = null;
// The vantage the orbit swings around, recomputed whenever the framing
// changes.
const baseEye = new THREE.Vector3();
const orbitTarget = new THREE.Vector3();

/**
 * Put the eye on the box's own axis, `zoom` times the standard vantage's
 * distance away.
 *
 * The scene's vizView is a three-quarter vantage that suits a figure about
 * trajectories. This figure is about a CORRESPONDENCE — cell (i, j) of the
 * plane is square (i, j) of the panel — and that only reads if the plane is
 * seen face-on. So the vantage's azimuth and distance are kept and its
 * elevation is dropped: the eye goes to the height of the CPU camera's
 * pinhole, which is the axis the whole frustum is built on. `elevation`
 * puts a tilt back for scenes that want one.
 */
function placeCamera(): void {
  const view = vizViewFor(params.scene);
  orbitTarget.set(view.target[0], SCENES[params.scene].camera.eye[1], view.target[2]);
  const offset = new THREE.Vector3(...view.eye).sub(new THREE.Vector3(...view.target));
  const distance = offset.length() * params.zoom;
  const e = THREE.MathUtils.degToRad(params.elevation);
  baseEye
    .set(offset.x, 0, offset.z)
    .normalize()
    .multiplyScalar(distance * Math.cos(e));
  baseEye.y = distance * Math.sin(e);
  baseEye.add(orbitTarget);
  stage.camera.position.copy(baseEye);
  stage.controls?.target.copy(orbitTarget);
  stage.camera.lookAt(orbitTarget);
  stage.controls?.update();
}

function rebuildCloud(): void {
  if (!trace) return;
  cloud?.dispose();
  cloud = new PixelRayCloud({
    paths: trace.paths,
    sampleCount: Math.min(params.raysFrom, trace.samples),
    opacity: params.opacity,
    blend: params.blend,
    darkDim: DARK_DIM,
  });
  rayGroup.add(cloud.group);
  updateCaption();
  console.log(
    `[pixel-grid-still] ${grouped(cloud.pathCount)} paths · ` +
      `${grouped(cloud.segmentCount)} segments in one draw call`,
  );
}

function updateCaption(): void {
  if (!trace || !cloud) return;
  const drawn = Math.min(params.raysFrom, trace.samples);
  const note = drawn < trace.samples ? ` (${drawn} of them drawn)` : '';
  setText(
    caption,
    `${trace.res}x${trace.res} pixels · ${trace.samples} samples${note} · ` +
      `${grouped(cloud.pathCount)} rays`,
  );
}

/** The converged image, painted once — this figure has no running mean. */
function paintPanel(): void {
  if (!trace || !panel || !panelPixels) return;
  const { res, cumulative, samples } = trace;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const [r, g, b] = meanAt(cumulative, res, samples - 1, x, y);
      const o = (y * res + x) * 4;
      panelPixels[o] = srgbEncode(r);
      panelPixels[o + 1] = srgbEncode(g);
      panelPixels[o + 2] = srgbEncode(b);
      panelPixels[o + 3] = 255;
    }
  }
  panel.update(panelPixels);
}

function rebuildElements(): void {
  if (!trace) return;
  plane?.dispose();
  plane = new ImagePlaneElement(
    {
      camera: SCENES[params.scene].camera,
      distance: PLANE_DISTANCE,
      res: trace.res,
      samples: trace.samples,
      dwell: 1,
      cumulative: trace.cumulative,
      highlight: null,
    },
    planeGroup,
  );
  // Straight to the final sample, once. The plane is a still like the rest
  // of the figure, so it never consults the clock again.
  plane.drawAt(trace.samples);

  paintPanel();
  rebuildCloud();
}

// The only thing on the clock, and only when asked for: a there-and-back
// azimuth sweep, so the exported loop closes on itself exactly.
stage.frame((t) => {
  if (params.orbit === 0) return; // a true still — and the mouse stays free
  const a = THREE.MathUtils.degToRad(params.orbit) * Math.sin((2 * Math.PI * t) / stage.duration);
  const offset = baseEye.clone().sub(orbitTarget).applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
  stage.camera.position.copy(orbitTarget).add(offset);
  stage.controls?.target.copy(orbitTarget);
  stage.camera.lookAt(orbitTarget);
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
  stage.t = 0;

  // Swap the 3D scene.
  if (sceneGroup) stage.scene.remove(sceneGroup);
  sceneGroup = sceneToThree(SCENES[params.scene]);
  stage.add(sceneGroup);
  // Dolly rather than widen the fov: the frustum has to keep matching the
  // CPU camera the image plane sits on.
  placeCamera();
  frameView();

  const res = params.grid;
  ensurePanel(res);
  progress.visible = true;
  progress.set(0);

  const note = params.tracer === 'pt' && hasDeltaLight(params.scene)
    ? ' (a delta light cannot be hit — every sample will be black, which is the point)'
    : '';
  setText(caption, `${params.tracer} · ${params.scene} · tracing…${note}`);

  ready = tracePixelGrid({
    scene: buildScene(SCENES[params.scene], res, res),
    integrator: makeIntegrator(params.tracer),
    res,
    samples: params.samples,
    seed: SEED,
    signal: controller.signal,
    onProgress: (done, total) => {
      if (gen !== generation) return;
      progress.set(done / total);
      setText(caption, `${params.tracer} · tracing ${Math.round((100 * done) / total)}%`);
    },
  })
    .then((result) => {
      if (gen !== generation) return;
      trace = result;
      progress.visible = false;
      rebuildElements();
      console.log(
        `[pixel-grid-still] ${params.tracer} · ${params.scene} · ${res}x${res} x ` +
          `${params.samples} samples · ${grouped(result.litCount)} of ` +
          `${grouped(res * res * params.samples)} carried light`,
      );
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

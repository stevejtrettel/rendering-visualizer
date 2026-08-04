/**
 * SHOWS: an image being computed. A small grid of pixels floats on the
 * camera frustum in front of the scene; every sample fires one ray per
 * pixel through it, the rays bounce around the room, and the mini-image
 * fills in as their contributions accumulate.
 *
 * This is the whole renderer in one picture: the grid IS the film, the
 * spray IS the estimator, and the image on the plane is the running mean
 * of what came back. The inset shows the same image square-on, because the
 * plane itself is seen obliquely.
 *
 * Launch modes:
 *   sweep      rays leave in raster order across the grid, so you can see
 *              it being scanned and follow individual paths.
 *   together   every pixel fires on the same frame — the strongest reading
 *              of "one sample = one ray per pixel", and the right choice
 *              for a short sample period over many samples.
 *
 * MMLT and ReSTIR are absent by nature rather than by omission: MMLT
 * mutates a chain instead of sampling pixels independently, and ReSTIR's
 * estimate depends on whole-frame passes of reuse. Neither has "this
 * pixel's sample s" to replay.
 */

import { createStage, createUI, C } from '@';
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
import { SampleDropElement } from '@/viz/sample-drop';
import { PixelRays, type LaunchMode } from '@/viz/pixel-rays';
import { FilmPanel } from '@/viz/film-panel';
import { ProgressBar } from '@/viz/progress-bar';
import { srgbEncode } from '@/render/film';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SEED = 0;
const MAX_DEPTH = 6; // short paths stay readable as paths
const PLANE_DISTANCE = 1.4; // pinhole -> grid, world units
// Pull the eye back from each scene's standard vantage, so the box sits
// smaller in frame and leaves the caption below it legible.
const ZOOM_OUT = 1.45;
// The longest path finishes by this fraction of the sample period; the
// growth rate is fitted from the traced geometry so it works whatever the
// scene's scale. Must leave room ahead of the fade below.
const DRAW_FRACTION = 0.6;
const FADE_FRACTION = 0.3; // tail of each sample spent fading out
// Beside the scene, the sample being gathered fades into existence above
// the running average and then falls into it. The average advances to
// include that sample AT the landing — so the accumulation is something
// you watch happen, not something that already happened. Fractions of the
// sample period; the in-scene plane is untouched by all this.
const DROP_FADE_IN_END = 0.45; // tile has fully appeared by here
const DROP_START = 0.6; // starts falling (after the rays have landed)
const DROP_LAND = 0.95; // merges into the average
const DROP_HEIGHT = 0.86; // HUD units above the inset it hovers
const INSET = { center: [-1.3, -0.42] as [number, number], height: 0.62 };

// Which tracers can replay "this pixel, this sample" at all.
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

const progress = new ProgressBar({ center: [0, -0.92], width: 1.1 });
stage.hud.add(progress.group);

// The plane is seen obliquely in the scene; the inset shows it square-on.
let inset: FilmPanel | null = null;
let insetPixels: Uint8ClampedArray | null = null;
function ensureInset(res: number): FilmPanel {
  if (inset && inset.width === res) return inset;
  inset?.dispose();
  inset = new FilmPanel({
    width: res,
    height: res,
    center: INSET.center,
    drawnHeight: INSET.height,
  });
  insetPixels = new Uint8ClampedArray(res * res * 4);
  stage.hud.add(inset.group);
  return inset;
}

// --- Controls --------------------------------------------------------------
const params = {
  scene: 'cornell' as SceneName,
  tracer: 'pt-nee' as GridTracer,
  grid: 8,
  samples: 32,
  launch: 'sweep' as LaunchMode,
  samplePeriod: 0.9,
  sweepSeconds: 0.25,
};

ui.params.add(params, 'scene', SCENE_NAMES).onChange(restart);
ui.params.add(params, 'tracer', TRACERS).onChange(restart);
ui.params.add(params, 'grid', [4, 6, 8, 12, 16, 32]).name('grid (n x n)').onChange(restart);
ui.params.add(params, 'samples', [8, 16, 32, 64, 128]).name('samples').onChange(restart);
ui.params.add(params, 'launch', ['sweep', 'together']).onChange(retime);
ui.params.add(params, 'samplePeriod', 0.1, 2, 0.05).name('seconds/sample').onChange(retime);
ui.params.add(params, 'sweepSeconds', 0, 1, 0.02).name('sweep (s)').onChange(retime);

// --- Playback --------------------------------------------------------------
let trace: PixelGridTrace | null = null;
let rays: PixelRays | null = null;
let plane: ImagePlaneElement | null = null;
let drop: SampleDropElement | null = null;
let shownSample = '';

// The SIDE image lags by the landing, so during a sample's flight it shows
// the mean WITHOUT that sample and advances exactly when the tile merges.
// The in-scene plane keeps its own plain clock — it is the film, and the
// film does not wait for an animation.
const averagedSample = (t: number): number =>
  Math.floor((t - DROP_LAND * params.samplePeriod) / params.samplePeriod);

function retime(): void {
  if (!trace) return;
  rebuildElements();
}

function rebuildElements(): void {
  if (!trace) return;
  rays?.dispose();
  plane?.dispose();
  drop?.dispose();
  shownSample = '';

  rays = new PixelRays({
    paths: trace.paths,
    samplePeriod: params.samplePeriod,
    launch: params.launch,
    sweepSeconds: params.sweepSeconds,
    drawFraction: DRAW_FRACTION,
    fadeFraction: FADE_FRACTION,
  });
  rayGroup.add(rays.group);
  console.log(
    `[pixel-grid] longest path ${rays.maxPathLength.toFixed(1)} world units · ` +
      `drawn at ${rays.speed.toFixed(1)} units/s`,
  );

  plane = new ImagePlaneElement(
    {
      camera: SCENES[params.scene].camera,
      distance: PLANE_DISTANCE,
      res: trace.res,
      samples: trace.samples,
      dwell: params.samplePeriod,
      cumulative: trace.cumulative,
      highlight: null,
    },
    planeGroup,
  );

  drop = new SampleDropElement(
    {
      res: trace.res,
      samples: trace.samples,
      dwell: params.samplePeriod,
      perSample: trace.perSample,
      target: INSET.center,
      drawnHeight: INSET.height,
      riseHeight: DROP_HEIGHT,
      fadeInEnd: DROP_FADE_IN_END,
      dropStart: DROP_START,
      dropLand: DROP_LAND,
    },
    stage.hud,
  );

  stage.duration = rays.duration;
  stage.t = 0;
}

// Fill the inset from the same running mean the plane shows.
function paintInset(sample: number): void {
  if (!trace || !inset || !insetPixels) return;
  const { res, cumulative } = trace;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const [r, g, b] = meanAt(cumulative, res, sample, x, y);
      const o = (y * res + x) * 4;
      insetPixels[o] = srgbEncode(r);
      insetPixels[o + 1] = srgbEncode(g);
      insetPixels[o + 2] = srgbEncode(b);
      insetPixels[o + 3] = 255;
    }
  }
  inset.update(insetPixels);
}

stage.frame((t) => {
  if (!trace || !rays || !plane || !drop) return;
  rays.drawAt(t);
  drop.drawAt(t);
  plane.drawAt(t);

  const sample = rays.sampleAt(t);
  const landed = averagedSample(t);
  // Nothing has been averaged in until the first tile lands, so the side
  // image stays dark rather than showing sample 0 before it arrives.
  inset!.group.visible = landed >= 0;
  const key = `${sample}/${landed}`;
  if (key === shownSample) return;
  shownSample = key;
  if (landed >= 0) paintInset(landed);
  setText(
    caption,
    `${trace.res}x${trace.res} pixels · sample ${sample + 1} of ${trace.samples}`,
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
  shownSample = '';
  stage.speed = 0;
  stage.t = 0;

  // Swap the 3D scene.
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
  ensureInset(res);
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
        `[pixel-grid] ${params.tracer} · ${params.scene} · ${res}x${res} x ${params.samples} samples · ` +
          `${result.litCount} of ${res * res * params.samples} carried light`,
      );
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

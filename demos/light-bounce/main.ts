/**
 * SHOWS: the same search, run backwards. Photons leave the lamp, the whole
 * population walks out in lockstep — a bounce per beat, ten beats — dark,
 * and a path that lands on the film flips to ochre and stops there. The
 * cell it landed in lights up and stays lit, so the film fills in photon by
 * photon while you watch.
 *
 * The dual of pixel-bounce, and meant to be cut against it: same box, same
 * pacing, same colour language, both targets a small square that almost
 * nothing finds. Camera side, the rays start at the pinhole and hunt for the
 * lamp; light side, they start on the lamp and hunt for the film. Neither
 * one is finding much.
 *
 * The asymmetry that is real, and worth saying out loud in the talk: the
 * lamp is a surface in the scene, so a camera walk hits it because the
 * intersector says so. The film is not in the scene, and a PINHOLE camera
 * records only rays through a single point — probability zero. So the film
 * here is read as a bare finite sensor, an open shutter with no lens, and a
 * photon "lands" when its segment crosses that rectangle. Which is exactly
 * why a real light tracer connects every vertex to the camera instead of
 * waiting for a hit — and this figure is the argument for that connection.
 *
 * The census (cornell, 576 photons, cap 10, the series' standard 1.4-unit
 * plane): 27 land, 4.7%, spread over the whole depth — 2 on the first
 * bounce, 5 on the tenth, and every bounce but the seventh represented.
 * They land in 25 distinct cells of 256, so the film comes up as scattered
 * points rather than a picture, which is the honest result: this is what
 * light tracing gets for free before anything is connected to the camera.
 * Seeds 1 and 2 give 37 and 28. The `film distance` knob is a sensor-size
 * knob as much as a placement one — a square on the frustum grows with
 * distance, so 2.8 doubles its width and takes the rate to 16.3%.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { traceLightPaths, type FilmRect, type LightPathTrace } from '@/trace/light-paths';
import { sceneToThree } from '@/viz/three-scene';
import { imagePlaneFrame } from '@/viz/image-plane';
import { PixelPlane } from '@/viz/pixel-plane';
import { BounceCloud } from '@/viz/bounce-cloud';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
// Pull back from the scene's standard vantage, as in pixel-bounce, so the
// two figures frame the box identically and cut together.
const ZOOM_OUT = 1.45;
// A cell's first photon comes up at this brightness; further ones climb
// toward full. One photon has to be clearly visible — most cells that ever
// light up only ever get the one.
const FIRST_HIT = 0.55;
const HIT_GAIN = 0.45; // added share of the remaining headroom per extra photon

const SCENE_NAMES = Object.keys(SCENES) as SceneName[];
const grouped = (n: number) => n.toLocaleString('en-US');

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });

// --- Controls --------------------------------------------------------------
// Before createUI: the Capture folder reads `duration` once.
const params = {
  scene: 'cornell' as SceneName,
  // Photons emitted. 576 is pixel-bounce's ray count, so the two figures
  // put the same number of lines on screen and their hit rates are
  // comparable by eye: 11 of 576 there, 30 of 576 here.
  photons: 576,
  bounces: 10,
  // Where the film hangs on the frustum — and therefore how big it is.
  // 1.4 is the series' standard, so the plane sits exactly where
  // pixel-bounce's grid does.
  distance: 1.4,
  grid: 16,
  flySeconds: 0.55,
  settleSeconds: 0.25,
  hold: 2,
  seed: 0,
  opacity: 0.9,
  darkDim: 0.7,
  film: true, // the plane and its cell grid
  record: true, // cells light up as photons land
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

ui.params.add(params, 'scene', SCENE_NAMES).onChange(restart);
ui.params.add(params, 'photons', [144, 288, 576, 1152, 2304]).name('photons').onChange(restart);
ui.params.add(params, 'bounces', 1, 16, 1).name('bounces').onChange(restart);
ui.params.add(params, 'distance', 0.8, 4, 0.1).name('film distance').onChange(restart);
ui.params.add(params, 'grid', [8, 12, 16, 24, 32]).name('film cells').onChange(restart);
ui.params.add(params, 'flySeconds', 0.1, 1.5, 0.05).name('flight (s)').onChange(retime);
ui.params.add(params, 'settleSeconds', 0, 1, 0.05).name('beat (s)').onChange(retime);
ui.params.add(params, 'hold', 0, 6, 0.5).name('hold (s)').onChange(retime);
ui.params.add(params, 'seed', 0, 32, 1).name('seed').onChange(restart);
ui.params.add(params, 'opacity', 0.05, 1, 0.05).onChange(() => cloud?.setOpacity(params.opacity));
ui.params
  .add(params, 'darkDim', 0.1, 1, 0.05)
  .name('miss brightness')
  .onChange(() => cloud?.setDark(C.slateDeep, params.darkDim));
ui.params.add(params, 'film').name('show film').onChange(() => {
  if (plane) plane.group.visible = params.film;
});
ui.params.add(params, 'record').name('film records').onChange(() => {
  shownHits = -1; // force a repaint at the next frame
});
ui.params.add(params, 'captions').onChange(() => {
  caption.visible = params.captions;
});

// --- Elements --------------------------------------------------------------
let trace: LightPathTrace | null = null;
let cloud: BounceCloud | null = null;
let plane: PixelPlane | null = null;
let filmPixels: Uint8ClampedArray | null = null;
let cellCounts: Uint16Array | null = null;
/** Hits already painted, so the film is repainted only when one lands. */
let shownHits = -1;
let shownCaption = '';

/** The film rectangle, in the form the trace tests segments against. */
function filmRect(scene: SceneName, distance: number): FilmRect {
  const f = imagePlaneFrame(SCENES[scene].camera, distance);
  return {
    center: [f.center.x, f.center.y, f.center.z],
    right: [f.right.x, f.right.y, f.right.z],
    up: [f.up.x, f.up.y, f.up.z],
    forward: [f.forward.x, f.forward.y, f.forward.z],
    half: f.halfW,
  };
}

function retime(): void {
  if (trace) rebuildElements();
}

function rebuildElements(): void {
  if (!trace) return;
  cloud?.dispose();
  shownHits = -1;
  shownCaption = '';

  cloud = new BounceCloud({
    paths: trace.paths,
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
}

/**
 * Paint the first `landed` hits onto the film.
 *
 * Repainted from zero rather than incrementally, because the figure is
 * scrubbable: the exporter and the timeline both set t backwards as freely
 * as forwards, and an accumulating buffer would remember photons that have
 * not landed yet at the t being drawn.
 */
function paintFilm(landed: number): void {
  if (!trace || !plane || !filmPixels || !cellCounts) return;
  const { res } = trace;
  filmPixels.fill(0);
  cellCounts.fill(0);
  if (params.record) {
    const color = new THREE.Color(C.ochreLight);
    for (let i = 0; i < landed; i++) {
      const [x, y] = trace.hits[i]!.cell;
      const cell = y * res + x;
      const n = (cellCounts[cell]! += 1);
      // First photon lands at FIRST_HIT; each further one closes part of
      // the gap to full, so a cell that collects several is visibly hotter
      // without the first one being invisible.
      const b = 1 - (1 - FIRST_HIT) * (1 - HIT_GAIN) ** (n - 1);
      const o = cell * 4;
      filmPixels[o] = Math.round(255 * color.r * b);
      filmPixels[o + 1] = Math.round(255 * color.g * b);
      filmPixels[o + 2] = Math.round(255 * color.b * b);
      filmPixels[o + 3] = 255;
    }
  }
  plane.update(filmPixels);
}

stage.frame((t) => {
  if (!cloud || !trace) return;
  cloud.drawAt(t);

  // A photon lights its cell on the frame its path turns — same instant,
  // from the same clock, so the two never disagree by a frame.
  let landed = 0;
  while (landed < trace.hits.length && t >= cloud.flipTime(trace.hits[landed]!.bounce)) landed += 1;
  if (landed !== shownHits) {
    shownHits = landed;
    paintFilm(landed);
  }

  if (!params.captions) return;
  const bounce = cloud.bounceAt(t);
  const key = `${bounce}/${landed}`;
  if (key === shownCaption) return;
  shownCaption = key;
  setText(
    caption,
    `${grouped(cloud.pathCount)} photons · bounce ${bounce} of ${cloud.deepest} · ` +
      `${landed} ${landed === 1 ? 'has' : 'have'} landed on the film`,
  );
});

// --- Tracing ---------------------------------------------------------------
function restart(): void {
  trace = null;
  cloud?.dispose();
  cloud = null;
  shownHits = -1;
  shownCaption = '';
  stage.t = 0;

  // Swap the 3D scene.
  if (sceneGroup) stage.scene.remove(sceneGroup);
  sceneGroup = sceneToThree(SCENES[params.scene]);
  stage.add(sceneGroup);
  const view = vizViewFor(params.scene);
  const target = new THREE.Vector3(...view.target);
  const eye = new THREE.Vector3(...view.eye).sub(target).multiplyScalar(ZOOM_OUT).add(target);
  stage.camera.position.copy(eye);
  stage.controls?.target.copy(target);
  stage.controls?.update();

  const res = params.grid;
  plane?.dispose();
  plane = new PixelPlane(
    { camera: SCENES[params.scene].camera, distance: params.distance, res },
    planeGroup,
  );
  plane.group.visible = params.film;
  filmPixels = new Uint8ClampedArray(res * res * 4);
  cellCounts = new Uint16Array(res * res);

  // A few thousand walks of ten bounces: fast enough to do on the spot, so
  // this figure has no progress bar and no async plumbing. (tracePixelGrid
  // yields between rows because it is res^2 x samples paths, which is a
  // different order of work.)
  trace = traceLightPaths({
    scene: buildScene(SCENES[params.scene], res, res),
    count: params.photons,
    maxBounces: params.bounces,
    film: filmRect(params.scene, params.distance),
    res,
    seed: params.seed,
  });
  rebuildElements();
  console.log(
    `[light-bounce] ${grouped(params.photons)} photons · ${trace.hits.length} land on the film ` +
      `(${((100 * trace.hits.length) / params.photons).toFixed(1)}%) within ${params.bounces} bounces`,
  );
}

stage.start();
restart();

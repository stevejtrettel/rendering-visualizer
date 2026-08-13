/**
 * SHOWS: one ray, bouncing. The simplest true statement the talk can make
 * about a path tracer, in two takes off one page.
 *
 *   grow      a single ray leaves the camera and grows at constant speed,
 *             turning at each surface, out to the depth cap. Nothing else
 *             happens: no shadow rays, no light subpath, no accumulating
 *             image. Just the walk being built.
 *
 *   flicker   the same walk, already complete, replaced by a DIFFERENT one
 *             every 1/rate seconds. Same camera ray every time — the first
 *             segment never moves — so what you are watching is one pixel's
 *             estimator thrashing: the same question answered a hundred
 *             different ways.
 *
 * The pair is the point. One ray looks like a tidy diagram of light
 * transport; thirty a second look like what it actually is, which is why
 * the picture is noisy and why the rest of the talk exists.
 *
 * Plain PT with roulette off, so the depth cap is the only thing that ends a
 * walk — except a walk that lands on the lamp, whose albedo is black, and
 * stops there with its throughput. Cornell's lamp is small enough that most
 * of them run the full depth.
 *
 * Determinism: the flicker index is floor(t * rate), so the sequence is a
 * pure function of the clock. Set `rate` to a divisor of the export fps (30
 * against 60) and each ray lands on a whole number of frames.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { UnidirectionalPT } from '@/core/integrators/pt';
import { tracePaths } from '@/trace/replay';
import type { PathRecord } from '@/trace/records';
import { luminanceOf } from '@/core/math/color';
import { sceneToThree } from '@/viz/three-scene';
import { RayTrail, type TrailSegment } from '@/viz/ray-trail';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SEED = 0;
const FILM = 160; // film resolution the pixel coordinate is taken against
const NO_RR = 999; // roulette off: the depth cap is the only terminator
// Seconds the finished ray is held at full length before the loop restarts,
// so the shape can be read before it vanishes.
const HOLD = 1.2;
// Loop length in flicker mode. Also sets how many distinct rays are traced:
// the sequence has to close on itself at the loop boundary.
const FLICKER_SECONDS = 8;
// Never trace fewer than this, so the `sample` slider has somewhere to go
// even at a slow flicker rate.
const MIN_PATHS = 64;
// Distance multiplier on the standard vantage, chosen to leave a margin
// around the box rather than by eye: Cornell's opening is 4 world units
// square at z = 11, and under a 42-degree vertical fov it fills 80% of the
// frame's height from 6.5 units back — which off the vantage's own 14.56
// units from its target is 1.13. At the old 1.05 the opening filled 98% and
// the box ran to the edges of the frame.
const DEFAULT_ZOOM = 1.13;

type Mode = 'grow' | 'flicker';

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.5, 9], target: [0, 1.5, 0], fov: 42 });
const ui = createUI(stage);

let sceneGroup: THREE.Group | null = null;
const trailGroup = new THREE.Group();
stage.add(trailGroup);

// --- Controls --------------------------------------------------------------
const params = {
  scene: 'cornell' as SceneName,
  mode: 'grow' as Mode,
  bounces: 10,
  // The one pixel every ray leaves through. Fixed on purpose: in flicker
  // mode the camera ray must not move, or the figure stops being about one
  // pixel's variance and becomes about the whole image.
  //
  // Surveyed across the film rather than guessed: the box is elongated and
  // the camera sits at z = 9.5, so EVERY first flight is long, but this one
  // lands on the blue sphere at 8.5 units where the middle of the film runs
  // 11.5 to the back wall. A curved first bounce also reads better than a
  // flat one. Walks from here average 9.5 of 10 bounces.
  pixelX: 0.65,
  pixelY: 0.7,
  // Which ray, in grow mode.
  sample: 0,
  // World units per second of growth. Fast enough to watch several times,
  // slow enough to follow.
  speed: 14,
  // Rays per second, in flicker mode.
  rate: 30,
  zoom: DEFAULT_ZOOM,
  // Degrees the eye is raised above the box's axis. 0 is dead level, which
  // is what centres the box; a few degrees puts back a depth cue if the
  // head-on view reads flat.
  elevation: 0,
};

ui.params.add(params, 'scene', Object.keys(SCENES)).onChange(rebuild);
ui.params.add(params, 'mode', ['grow', 'flicker']).onChange(retime);
ui.params.add(params, 'bounces', 1, 20, 1).name('bounces (depth)').onChange(rebuild);
const sampleCtrl = ui.params.add(params, 'sample', 0, MIN_PATHS - 1, 1).name('which ray').onChange(retime);
ui.params.add(params, 'pixelX', 0, 1, 0.005).name('pixel x').onChange(rebuild);
ui.params.add(params, 'pixelY', 0, 1, 0.005).name('pixel y').onChange(rebuild);
ui.params.add(params, 'speed', 2, 40, 1).name('growth speed').onChange(retime);
ui.params.add(params, 'rate', 2, 60, 1).name('rays/second').onChange(rebuild);
ui.params.add(params, 'zoom', 0.6, 2, 0.01).name('distance (x)').onChange(placeCamera);
ui.params.add(params, 'elevation', -20, 30, 1).name('elevation (deg)').onChange(placeCamera);

// --- Paths -----------------------------------------------------------------
// Every ray of the sequence, precomputed. A depth-10 walk is tens of
// microseconds, so a few hundred of them cost less than one frame — there is
// no reason to re-trace during playback, and precomputing keeps the frame
// loop a pure lookup.
let paths: TrailSegment[][] = [];

/**
 * A record's camera walk as drawable segments.
 *
 * Same mapping buildSchedule uses: a segment carries the throughput of the
 * vertex it ARRIVES at, so brightness falls along the path as each surface
 * takes its cut.
 */
function toSegments(record: PathRecord): TrailSegment[] {
  const out: TrailSegment[] = [];
  const vs = record.vertices;
  for (let k = 1; k < vs.length; k++) {
    const v = vs[k]!;
    out.push({
      from: vs[k - 1]!.p,
      to: v.p,
      betaLuminance: luminanceOf(v.beta[0], v.beta[1], v.beta[2]),
      delta: v.delta,
    });
  }
  return out;
}

let trail: RayTrail | null = null;

/**
 * Centre the box in the frame.
 *
 * The scene's vizView is a three-quarter vantage aimed BELOW the box's
 * middle and raised above it — good for looking down onto trajectories,
 * which is what it was chosen for, and it leaves the box riding low and
 * cropped here. So its azimuth and distance are kept and the rest is
 * rebuilt: the eye goes level with the height of the CPU camera's own
 * pinhole, which in every Cornell variant is the box's mid-height, and aims
 * at it. Box centre, frame centre, same point.
 */
function placeCamera(): void {
  const view = vizViewFor(params.scene);
  const target = new THREE.Vector3(
    view.target[0],
    SCENES[params.scene].camera.eye[1],
    view.target[2],
  );
  const offset = new THREE.Vector3(...view.eye).sub(new THREE.Vector3(...view.target));
  const distance = offset.length() * params.zoom;
  const e = THREE.MathUtils.degToRad(params.elevation);
  const eye = new THREE.Vector3(offset.x, 0, offset.z)
    .normalize()
    .multiplyScalar(distance * Math.cos(e));
  eye.y = distance * Math.sin(e);
  eye.add(target);
  stage.camera.position.copy(eye);
  stage.controls?.target.copy(target);
  stage.camera.lookAt(target);
  stage.controls?.update();
}

/** Re-time the loop for the current mode without re-tracing anything. */
function retime(): void {
  if (params.mode === 'flicker') {
    stage.duration = FLICKER_SECONDS;
  } else {
    const segments = paths[params.sample] ?? [];
    stage.duration = RayTrail.length(segments) / params.speed + HOLD;
  }
  stage.t = 0;
}

function rebuild(): void {
  trail?.dispose();

  const description = SCENES[params.scene];
  const scene = buildScene(description, FILM, FILM);
  const integrator = new UnidirectionalPT({
    maxBounces: params.bounces,
    rrStartDepth: NO_RR,
    sampleNEE: false,
  });

  // Enough rays that the flicker sequence closes exactly on the loop.
  const count = Math.max(MIN_PATHS, Math.ceil(FLICKER_SECONDS * params.rate));
  const pixel: [number, number] = [
    Math.min(FILM - 1, Math.floor(params.pixelX * FILM)),
    Math.min(FILM - 1, Math.floor(params.pixelY * FILM)),
  ];
  const indices = Array.from({ length: count }, (_, i) => i);
  paths = tracePaths(scene, integrator, pixel, indices, { seed: SEED }).map(toSegments);

  params.sample = Math.min(params.sample, count - 1);
  sampleCtrl.max(count - 1).updateDisplay();

  // Swap the 3D scene.
  if (sceneGroup) stage.scene.remove(sceneGroup);
  sceneGroup = sceneToThree(description);
  stage.add(sceneGroup);
  placeCamera();

  // One slot per possible segment: a walk of n bounces has n segments from
  // the camera, and the cap is the only thing that ends it.
  trail = new RayTrail({ maxSegments: params.bounces + 1, lineWidth: 4 });
  trailGroup.add(trail.group);

  const longest = Math.max(...paths.map((p) => p.length));
  console.log(
    `[one-ray] ${params.scene} · depth ${params.bounces} · ${count} rays traced · ` +
      `longest walk ${longest} segments`,
  );
  retime();
}

// --- Playback --------------------------------------------------------------
stage.frame((t) => {
  if (!trail) return;
  if (params.mode === 'grow') {
    trail.show(paths[params.sample] ?? [], t * params.speed);
  } else {
    // Pure function of the clock: the same t always shows the same ray, in
    // preview and in a frame-stepped export alike.
    const index = Math.min(paths.length - 1, Math.floor(t * params.rate));
    trail.show(paths[index] ?? []);
  }
});

stage.start();
rebuild();

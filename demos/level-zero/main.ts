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
 * Built to be followed from the back of a room:
 *   - the first few rays each get a beat of their own, then the rest of the
 *     grid sweeps through faster;
 *   - the CURRENT ray is a thick bright line growing from the eye, with a
 *     dot where it lands, and its pixel is outlined on the grid and in the
 *     square-on inset;
 *   - a ray that has landed stays as a thin line in the colour it found, so
 *     the colour visibly travels back to its pixel.
 * The figure ramps to the finished image and holds it.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { FirstHitColor, surfaceColors } from '@/core/integrators/first-hit';
import { tracePixelGrid, type PixelGridTrace } from '@/trace/pixel-grid';
import { sceneToThree } from '@/viz/three-scene';
import { ImagePlaneElement, imagePlaneFrame } from '@/viz/image-plane';
import { FilmPanel } from '@/viz/film-panel';
import { polyline, setPolyline } from '@/viz/lines';
import { srgbEncode } from '@/render/film';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
// Matched to pixel-grid, so the two figures share a frame.
const SEED = 0;
const PLANE_DISTANCE = 1.4;
const ZOOM_OUT = 1.45;
const INSET = { center: [-1.3, -0.42] as [number, number], height: 0.62 };
// Pacing: the slow rays each own SLOW_STEP seconds and fly in SLOW_FLIGHT;
// the rest launch evenly over params.restSeconds and fly in FAST_FLIGHT.
const SLOW_STEP = 1.6;
const SLOW_FLIGHT = 0.9;
const FAST_FLIGHT = 0.3;
const HOLD = 2.5;
/** What a pixel shows before its ray lands. */
const BLANK = 18;
/** How strongly a landed ray keeps the colour it found. */
const PAST_DIM = 0.75;

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

// The current ray, its landing dot, and the outline of its pixel in both
// places the pixel appears.
const current = polyline([[0, 0, 0], [0, 0, 0]], { color: C.bone, width: 9 });
const dot = new THREE.Mesh(
  new THREE.SphereGeometry(0.09, 20, 12),
  new THREE.MeshBasicMaterial({ color: C.bone, toneMapped: false }),
);
const cellOnPlane = polyline(Array.from({ length: 5 }, () => [0, 0, 0] as [number, number, number]), {
  color: C.ochre,
  width: 4,
});
const cellInInset = polyline(Array.from({ length: 5 }, () => [0, 0, 0] as [number, number, number]), {
  color: C.ochre,
  width: 4,
});
rayGroup.add(current, dot, cellOnPlane);
stage.hud.add(cellInInset);

// Every landed ray, one thick line each (THREE.Line is a single pixel).
const pastGroup = new THREE.Group();
rayGroup.add(pastGroup);
let past: ReturnType<typeof polyline>[] = [];

// --- Controls --------------------------------------------------------------
const params = {
  scene: 'cornell-short' as SceneName,
  grid: 8,
  slowRays: 3,
  restSeconds: 5,
};
ui.params.add(params, 'scene', SCENE_NAMES).onChange(restart);
// A continuous range, so a slide can offer it as a slider; retracing is
// instant at level zero, so dragging re-runs the figure at each size.
ui.params.add(params, 'grid', 2, 32, 1).name('film resolution').onChange(restart);
ui.params.add(params, 'slowRays', 0, 8, 1).name('slow rays').onChange(rebuild);
ui.params.add(params, 'restSeconds', 1, 20, 0.5).name('rest (s)').onChange(rebuild);

// --- Playback --------------------------------------------------------------
let trace: PixelGridTrace | null = null;
let plane: ImagePlaneElement | null = null;
/** Per pixel, in raster order: launch, landing, eye and hit points, colour. */
let launch = new Float32Array(0);
let land = new Float32Array(0);
let eyes: THREE.Vector3[] = [];
let hits: (THREE.Vector3 | null)[] = [];
let colors: THREE.Color[] = [];
let shown = '';

function rebuild(): void {
  if (!trace) return;
  plane?.dispose();
  shown = '';

  const n = trace.res * trace.res;
  const slow = Math.min(params.slowRays, n);
  launch = new Float32Array(n);
  land = new Float32Array(n);
  eyes = [];
  hits = [];
  colors = [];
  for (let i = 0; i < n; i++) {
    const fast = i - slow;
    launch[i] = i < slow
      ? i * SLOW_STEP
      : slow * SLOW_STEP + (n > slow ? (fast / (n - slow)) * params.restSeconds : 0);
    land[i] = launch[i]! + (i < slow ? SLOW_FLIGHT : FAST_FLIGHT);
    const pts = trace.paths[0]![i]!.points;
    eyes.push(new THREE.Vector3(...pts[0]!));
    hits.push(pts[1] ? new THREE.Vector3(...pts[1]) : null);
    const v = trace.perSample.subarray(i * 3, i * 3 + 3);
    colors.push(new THREE.Color(v[0]!, v[1]!, v[2]!));
  }

  plane = new ImagePlaneElement(
    {
      camera: SCENES[params.scene].camera,
      distance: PLANE_DISTANCE,
      res: trace.res,
      samples: 1,
      dwell: Infinity,
      cumulative: trace.cumulative,
      highlight: null,
      revealAt: land,
    },
    planeGroup,
  );

  // One line per pixel, in the colour its ray found, shown once it lands.
  for (const line of past) {
    line.geometry.dispose();
    (line.material as THREE.Material).dispose();
  }
  pastGroup.clear();
  past = [];
  for (let i = 0; i < n; i++) {
    const h = hits[i];
    const line = polyline([eyes[i]!, h ?? eyes[i]!], {
      color: colors[i]!.clone().multiplyScalar(PAST_DIM).getHex(),
      width: 3,
    });
    line.visible = false;
    past.push(line);
    pastGroup.add(line);
  }

  stage.duration = land[n - 1]! + HOLD;
  stage.t = 0;
}

/** The current pixel at time t: the latest one launched. */
function currentAt(t: number): number {
  let c = 0;
  while (c + 1 < launch.length && launch[c + 1]! <= t) c++;
  return c;
}

function outlineCell(i: number): void {
  if (!trace) return;
  const res = trace.res;
  const x = i % res;
  const y = Math.floor(i / res);

  // On the plane, exactly where ImagePlaneElement puts the cell.
  const { center, right, up, forward, halfW, halfH } = imagePlaneFrame(SCENES[params.scene].camera, PLANE_DISTANCE);
  const cell = (2 * halfW) / res;
  const x0 = -halfW + x * cell;
  const y0 = halfH - (y + 1) * cell; // raster y grows downward
  const corner = (px: number, py: number) =>
    center.clone().addScaledVector(right, px).addScaledVector(up, py).addScaledVector(forward, -0.01);
  setPolyline(cellOnPlane, [
    corner(x0, y0), corner(x0 + cell, y0), corner(x0 + cell, y0 + cell), corner(x0, y0 + cell), corner(x0, y0),
  ]);

  // In the inset, row 0 at the top.
  const h = INSET.height;
  const cs = h / res;
  const left = INSET.center[0] - h / 2 + x * cs;
  const top = INSET.center[1] + h / 2 - y * cs;
  setPolyline(cellInInset, [
    [left, top, 0.01], [left + cs, top, 0.01], [left + cs, top - cs, 0.01], [left, top - cs, 0.01], [left, top, 0.01],
  ]);
}

function paintInset(t: number): void {
  if (!trace || !inset || !insetPixels) return;
  const { res, cumulative } = trace;
  for (let i = 0; i < res * res; i++) {
    const o = i * 4;
    if (t < land[i]!) {
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
  if (!trace || !plane) return;
  plane.drawAt(t);
  const n = launch.length;
  const done = t >= land[n - 1]!;
  const c = currentAt(t);

  // The current ray grows from the eye to its hit; once the whole grid is
  // done it steps aside and leaves the finished picture.
  const hit = hits[c];
  const live = !done && t >= launch[c]! && hit !== null;
  current.visible = live;
  dot.visible = live && t >= land[c]!;
  cellOnPlane.visible = cellInInset.visible = !done;
  if (live && hit) {
    const f = Math.min(1, (t - launch[c]!) / (land[c]! - launch[c]!));
    setPolyline(current, [eyes[c]!, eyes[c]!.clone().lerp(hit, f)]);
    dot.position.copy(hit);
    (dot.material as THREE.MeshBasicMaterial).color.copy(colors[c]!);
  }

  // Landed rays, in the colour they found.
  for (let i = 0; i < n; i++) {
    past[i]!.visible = t >= land[i]! && hits[i] !== null && (done || i !== c);
  }

  let landed = 0;
  for (let i = 0; i < n; i++) if (t >= land[i]!) landed++;
  const key = `${c}/${landed}/${done}`;
  if (key === shown) return;
  shown = key;
  outlineCell(c);
  paintInset(t);
  setText(caption, `${trace.res}x${trace.res} pixels · ${landed} of ${n} rays`);
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
  // cornell-short's view is already framed for this figure.
  const zoom = params.scene === 'cornell-short' ? 1 : ZOOM_OUT;
  const eye = new THREE.Vector3(...view.eye).sub(target).multiplyScalar(zoom).add(target);
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

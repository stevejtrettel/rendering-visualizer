/**
 * SHOWS: one pixel at a time getting its value.
 *
 * The third of the series. pixel-grid fires every pixel at once and watches
 * the whole image form; pixel-grid-still shows the finished computation with
 * every ray at once. This one slows all the way down to the unit of work
 * underneath both: a single cell of the film, a handful of rays fired
 * through it, and the average they settle on. Then the next cell.
 *
 * The beat is the argument. A ray leaves the cell, bounces around the room,
 * lands — and only THEN does the cell change colour.
 *
 * What it changes TO is the `cell shows` control, and it is the difference
 * between two claims. `sample` puts up what that one ray reported on its
 * own: a legitimate unbiased estimate of the pixel that looks nothing like
 * it, lurching between wildly different values as the rays come in. That is
 * the noise, at its source, before any averaging hides it. `average` puts up
 * the running mean instead, and the cell settles. Cells already finished
 * always keep their average either way — that is the image being built.
 *
 * Two modes, one code path — `dwell` is a sweep of length one:
 *
 *   sweep   move on once a cell has its average. The pixels visited are a
 *           seeded random spread rather than a raster run, so successive
 *           cells land on different content and each averages to an
 *           obviously different colour. `pixel seed` rerolls it.
 *   dwell   stay on ONE cell and keep pouring samples in. With `sample`
 *           that is one square flickering through every answer the
 *           estimator gives it; with `average` it is the same square
 *           settling down as the count climbs. The cell is deliberately off
 *           to one side — see dwellCell.
 *
 * Rays are never cleared, in two layers. The most recent `history` of them
 * stay drawn as real trails behind the one in flight, fading back from
 * `fanDim` to `tailDim` along the window — a tail of attempts dying away
 * rather than a wall of equal lines. Everything older collapses into one
 * flat haze at `pastDim`, along with every ray from cells already finished,
 * so the last frame of a loop is a sparse version of pixel-grid-still and
 * the three figures cut together. Drop `pastDim` to its minimum to keep
 * only the fading window.
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
import { tracePixelGrid, type PixelGridTrace, type TracedPath } from '@/trace/pixel-grid';
import { tracePaths } from '@/trace/replay';
import type { PathRecord } from '@/trace/records';
import { luminanceOf } from '@/core/math/color';
import { PCG32 } from '@/core/math/pcg32';
import { fromNumber, U64_ZERO } from '@/core/math/u64';
import { sceneToThree } from '@/viz/three-scene';
import { meanAt } from '@/viz/image-plane';
import { PixelPlane } from '@/viz/pixel-plane';
import { PixelRayCloud } from '@/viz/pixel-ray-cloud';
import { RayTrail, type TrailSegment } from '@/viz/ray-trail';
import { FilmPanel } from '@/viz/film-panel';
import { ProgressBar } from '@/viz/progress-bar';
import { polyline, setPolyline } from '@/viz/lines';
import { srgbEncode } from '@/render/film';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SEED = 0;
const MAX_DEPTH = 6; // matches the rest of the series
const PLANE_DISTANCE = 1.4; // pinhole -> grid, world units
// The ray has finished flying by this fraction of its slot; the rest of the
// slot is the beat where the cell updates and you look at what changed.
const DRAW_FRACTION = 0.6;
const DARK_DIM = 0.45; // unlit paths in the haze cloud
// Layout, framing and distances are pixel-grid-still's, so the two figures
// cut together without the box moving between them.
const PANEL = { center: [-1.05, 0.06] as [number, number], height: 1.32 };
const DEFAULT_ZOOM = 1.23;
const DEFAULT_SHIFT = 0.19;
const DEFAULT_RAISE = 0.03;

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

type Mode = 'sweep' | 'dwell';
// Trail slots allocated; the `history` control cannot exceed this. Each
// slot is a handful of Line2 objects, so this is the ceiling on how much
// recent history can stay drawn as real lines rather than as haze.
const MAX_TRAILS = 16;

/**
 * The cell `dwell` starts on, as a fraction of the film so the same PLACE
 * in the image is picked whatever the grid resolution is. At the default
 * 8x8 that is cell (1, 5).
 *
 * Deliberately not the middle. A figure that dwells on the exact centre of
 * the film reads as having chosen a special pixel — as if that one were the
 * subject — when the whole claim is that every pixel is the same
 * calculation and this one is arbitrary. Off to one side says "any of them".
 *
 * What it sees, measured over 24 samples (pt-nee, cap 6):
 *
 *   6x6   cell (1,4)   left 12, floor 9, ball 2, back 1   lit 22/24
 *   8x8   cell (1,5)   left 24                            lit 24/24
 *   12x12 cell (2,8)   left 24                            lit 24/24
 *   16x16 cell (3,11)  left 24                            lit 24/24
 *
 * At the default 8x8 every sample hits the RED left wall and every one of
 * them carries light home — and they still report values from 0.027 to
 * 0.395, a factor of fourteen apart, sd/mean 0.56. That is the figure with
 * `cell shows: sample`: the same pixel, the same wall, fourteen-fold
 * disagreement between one ray and the next. A cell whose samples agreed
 * would make the whole business look unnecessary.
 */
const DWELL_U = 0.1875; // (1 + 0.5) / 8
const DWELL_V = 0.6875; // (5 + 0.5) / 8
const dwellCell = (res: number): [number, number] => [
  Math.min(res - 1, Math.floor(res * DWELL_U)),
  Math.min(res - 1, Math.floor(res * DWELL_V)),
];
// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });

// --- Controls --------------------------------------------------------------
// Declared before the UI is built: this figure's loop is a derived quantity
// (a sweep of N cells, each taking as long as its samples do), and the
// Capture folder reads `duration` ONCE to default its export range. Set it
// afterwards and V exports the stage's generic 8 s of a 32 s figure.
const params = {
  scene: 'cornell' as SceneName,
  tracer: 'pt-nee' as GridTracer,
  // sweep  move on to a new cell once this one has its average
  // dwell   stay on ONE cell and keep pouring samples into it, so the
  //         figure is about a single estimate converging rather than about
  //         the film being covered. Same beats, same code path — the sweep
  //         is just a sweep of length one.
  mode: 'sweep' as Mode,
  grid: 8,
  // How many cells one loop visits. Ignored in dwell.
  pixels: 8,
  // The cell dwell sits on. Defaults follow the grid size; see dwellCell.
  dwellX: 1,
  dwellY: 5,
  // Rays fired through each cell before moving on, in sweep.
  samplesPer: 4,
  // Rays poured into the one cell, in dwell. Its own number because the
  // two modes want wildly different counts: four is a fan you can take in
  // at a glance, and dwelling wants to just keep going.
  dwellSamples: 24,
  sampleSeconds: 0.85,
  // Beat after a cell's last sample lands, before moving on.
  settle: 0.6,
  pixelSeed: 0,
  // How many PREVIOUS rays stay drawn as real trails behind the one in
  // flight. They fade back along the window, from fanDim at the most
  // recent to tailDim at the oldest, so the recent history reads as a
  // trail of attempts dying away rather than as a wall of equal lines.
  history: 8,
  // The ray just before the one in flight…
  fanDim: 0.5,
  // …and the oldest one still drawn.
  tailDim: 0.06,
  // Everything that has aged out of the window, and every ray from cells
  // already finished: one flat haze. Set to the minimum to clear it and
  // leave only the fading window.
  pastDim: 0.22,
  // What the cell being worked puts up: this sample alone, or the running
  // mean over the samples so far.
  cellShows: 'sample' as 'sample' | 'average',
  captions: true,
  zoom: DEFAULT_ZOOM,
  elevation: 0,
  shift: DEFAULT_SHIFT,
  raise: DEFAULT_RAISE,
};

stage.duration =
  params.pixels * (params.samplesPer * params.sampleSeconds + params.settle);
const ui = createUI(stage);

let sceneGroup: THREE.Group | null = null;
const rayGroup = new THREE.Group();
const planeGroup = new THREE.Group();
stage.add(rayGroup, planeGroup);

const caption = label('', {
  size: 0.055,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'top',
  position: [0, -0.8, 0],
});
stage.hud.add(caption);

const progress = new ProgressBar({ center: [0, -0.92], width: 1.1 });
stage.hud.add(progress.group);

ui.params.add(params, 'scene', SCENE_NAMES).onChange(restart);
ui.params.add(params, 'tracer', TRACERS).onChange(restart);
ui.params.add(params, 'mode', ['sweep', 'dwell']).onChange(() => {
  applyMode();
  restart();
});
ui.params.add(params, 'grid', [6, 8, 12, 16]).name('grid (n x n)').onChange(() => {
  // The dwell cell is defined relative to the grid, so a coarser or finer
  // film moves it rather than leaving it pointing at a stale coordinate.
  const [x, y] = dwellCell(params.grid);
  params.dwellX = x;
  params.dwellY = y;
  dwellXCtrl.max(params.grid - 1).updateDisplay();
  dwellYCtrl.max(params.grid - 1).updateDisplay();
  restart();
});
const pixelsCtrl = ui.params.add(params, 'pixels', 1, 24, 1).name('pixels per loop').onChange(restart);
const dwellXCtrl = ui.params.add(params, 'dwellX', 0, 7, 1).name('dwell cell x').onChange(restart);
const dwellYCtrl = ui.params.add(params, 'dwellY', 0, 7, 1).name('dwell cell y').onChange(restart);

/** Only one of the two modes' controls is meaningful at a time. */
function applyMode(): void {
  const dwelling = params.mode === 'dwell';
  pixelsCtrl.enable(!dwelling);
  samplesCtrl.enable(!dwelling);
  dwellSamplesCtrl.enable(dwelling);
  dwellXCtrl.enable(dwelling);
  dwellYCtrl.enable(dwelling);
}
const samplesCtrl = ui.params
  .add(params, 'samplesPer', 1, 32, 1)
  .name('samples per pixel')
  .onChange(restart);
const dwellSamplesCtrl = ui.params
  .add(params, 'dwellSamples', 1, 128, 1)
  .name('samples (dwell)')
  .onChange(restart);
ui.params.add(params, 'pixelSeed', 0, 32, 1).name('pixel seed').onChange(restart);
ui.params.add(params, 'history', 0, MAX_TRAILS - 1, 1).name('rays kept visible');
ui.params.add(params, 'sampleSeconds', 0.2, 2, 0.05).name('seconds/sample').onChange(retime);
ui.params.add(params, 'settle', 0, 2, 0.05).name('settle (s)').onChange(retime);
ui.params.add(params, 'fanDim', 0.05, 1, 0.01).name('newest kept ray');
ui.params.add(params, 'tailDim', 0.01, 1, 0.01).name('oldest kept ray');
ui.params.add(params, 'pastDim', 0.02, 1, 0.01).name('earlier pixels').onChange(() => {
  haze?.setOpacity(params.pastDim);
});
ui.params.add(params, 'cellShows', ['sample', 'average']).name('cell shows').onChange(() => {
  paintedFor = ''; // repaint on the next frame under the new reading
});
ui.params.add(params, 'captions').name('caption').onChange(() => {
  caption.visible = params.captions;
});
ui.params.add(params, 'zoom', 0.6, 2, 0.01).name('distance (x)').onChange(placeCamera);
ui.params.add(params, 'elevation', -20, 30, 1).name('elevation (deg)').onChange(placeCamera);
ui.params.add(params, 'shift', -0.4, 0.4, 0.01).name('shift right').onChange(frameView);
ui.params.add(params, 'raise', -0.2, 0.2, 0.005).name('raise').onChange(frameView);

// --- Framing (as pixel-grid-still) -----------------------------------------
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

// --- The panel, its grid and its highlight ---------------------------------
// FilmPanel is a bare quad, so the cell grid and the moving outline are drawn
// beside it in HUD coordinates. They have to agree with the panel's geometry
// exactly, which is one number: a square film's drawn width is its height.
let panel: FilmPanel | null = null;
let panelPixels: Uint8ClampedArray | null = null;
const panelOverlay = new THREE.Group();
let panelOutline: ReturnType<typeof polyline> | null = null;
stage.hud.add(panelOverlay);

const panelCell = (res: number) => PANEL.height / res;

/** Corner of cell (x, y) in HUD coordinates. */
function panelCorner(res: number, x: number, y: number): [number, number, number] {
  const c = panelCell(res);
  return [
    PANEL.center[0] - PANEL.height / 2 + x * c,
    PANEL.center[1] + PANEL.height / 2 - y * c,
    0.01,
  ];
}

function ensurePanel(res: number): void {
  if (panel && panel.width === res) return;
  panel?.dispose();
  panel = new FilmPanel({
    width: res,
    height: res,
    center: PANEL.center,
    drawnHeight: PANEL.height,
    border: false, // the cell grid below draws the outer edge too
  });
  panelPixels = new Uint8ClampedArray(res * res * 4);
  stage.hud.add(panel.group);

  panelOverlay.clear();
  for (let i = 0; i <= res; i++) {
    panelOverlay.add(
      polyline([panelCorner(res, i, 0), panelCorner(res, i, res)], {
        color: C.slateDeep,
        width: 1.4,
      }),
    );
    panelOverlay.add(
      polyline([panelCorner(res, 0, i), panelCorner(res, res, i)], {
        color: C.slateDeep,
        width: 1.4,
      }),
    );
  }
  panelOutline = polyline(
    new Array(5).fill(null).map(() => panelCorner(res, 0, 0)),
    { color: C.ochre, width: 3 },
  );
  panelOutline.visible = false;
  panelOverlay.add(panelOutline);
}

function highlightPanel(res: number, cell: readonly [number, number] | null): void {
  if (!panelOutline) return;
  if (!cell) {
    panelOutline.visible = false;
    return;
  }
  const [x, y] = cell;
  setPolyline(panelOutline, [
    panelCorner(res, x, y),
    panelCorner(res, x + 1, y),
    panelCorner(res, x + 1, y + 1),
    panelCorner(res, x, y + 1),
    panelCorner(res, x, y),
  ]);
  panelOutline.visible = true;
}

// --- The sweep -------------------------------------------------------------
let trace: PixelGridTrace | null = null;
let plane: PixelPlane | null = null;
// Everything that has aged out of the bright window, as one draw call.
let haze: PixelRayCloud | null = null;
let hazeBuiltFor = '';
let trails: RayTrail[] = [];
let cells: Array<[number, number]> = [];
// [visit][sample] — the fan for each visited cell, with per-vertex
// throughput, which the grid trace's flattened paths do not carry.
let fans: TrailSegment[][][] = [];
let rayBuffer: Uint8ClampedArray | null = null;
let paintedFor = '';
let growthSpeed = 10;

/** Samples poured into whichever cell is current — the modes differ. */
const activeSamples = () =>
  params.mode === 'dwell' ? params.dwellSamples : params.samplesPer;

const visitSeconds = () => activeSamples() * params.sampleSeconds + params.settle;

/**
 * Distinct cells, seeded, spread over the grid.
 *
 * Rejection over the whole grid rather than a shuffle: at 8x8 with a dozen
 * picks the retry count is negligible, and drawing independently is what
 * makes successive cells land on unrelated content, which is the point of
 * choosing them at random at all.
 */
function chooseCells(res: number, count: number, seed: number): Array<[number, number]> {
  const rng = new PCG32(fromNumber(seed + 1), U64_ZERO);
  const seen = new Set<number>();
  const out: Array<[number, number]> = [];
  const wanted = Math.min(count, res * res);
  let guard = 0;
  while (out.length < wanted && guard++ < 10_000) {
    const x = Math.min(res - 1, Math.floor(rng.nextFloat() * res));
    const y = Math.min(res - 1, Math.floor(rng.nextFloat() * res));
    const key = y * res + x;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([x, y]);
  }
  return out;
}

/** A record's camera walk as drawable segments, throughput per segment. */
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

function retime(): void {
  // Off `cells`, not `pixels` — dwell is a sweep of length one.
  stage.duration = Math.max(1, cells.length) * visitSeconds();
  // Every ray must finish inside its own slot, whatever the scene's scale —
  // an absolute world-units-per-second has to be retuned per scene and gets
  // it silently wrong (a Cornell camera ray is ~11 units before its first
  // bounce). So the rate is fitted to the longest path actually drawn.
  let longest = 0;
  for (const visit of fans) {
    for (const fan of visit) longest = Math.max(longest, RayTrail.length(fan));
  }
  growthSpeed = longest > 0 ? longest / (DRAW_FRACTION * params.sampleSeconds) : 10;
  paintedFor = '';
  stage.t = 0;
}

/**
 * The film as it stands: finished cells at their full mean, the cell being
 * worked at its mean over the samples that have LANDED, everything else
 * black. One buffer, shown both in the scene and on the panel.
 */
function paint(visit: number, landed: number): void {
  if (!trace || !rayBuffer) return;
  const { res, cumulative, perSample, samples } = trace;
  rayBuffer.fill(0);
  for (let v = 0; v <= visit && v < cells.length; v++) {
    const cell = cells[v]!;
    const upTo = v < visit ? samples - 1 : landed - 1;
    if (upTo < 0) continue;
    // Cells already finished keep their average — that is the image being
    // built, and it is the thing the other two figures show. The cell being
    // WORKED is the one whose reading changes: `sample` puts up what this
    // one ray alone reported, which is an unbiased estimate of the pixel and
    // looks nothing like it, and `average` puts up the running mean.
    const one = v === visit && params.cellShows === 'sample';
    const i = (upTo * res * res + cell[1] * res + cell[0]) * 3;
    const [r, g, b] = one
      ? [perSample[i]!, perSample[i + 1]!, perSample[i + 2]!]
      : meanAt(cumulative, res, upTo, cell[0], cell[1]);
    const o = (cell[1] * res + cell[0]) * 4;
    rayBuffer[o] = srgbEncode(r);
    rayBuffer[o + 1] = srgbEncode(g);
    rayBuffer[o + 2] = srgbEncode(b);
    rayBuffer[o + 3] = 255;
  }
  plane?.update(rayBuffer);
  panel?.update(rayBuffer);
}

/**
 * Every ray that has fallen out of the bright window, as one static draw
 * call: all of the cells already finished, plus however many of the current
 * cell's samples have aged out. Dwelling on one cell is the case that needs
 * the second half — there the first term is empty for the whole loop and
 * the haze is built entirely out of this cell's own history.
 */
function buildHaze(visit: number, cloudUpTo: number): void {
  if (!trace) return;
  haze?.dispose();
  haze = null;
  const done: TracedPath[] = [];
  const pathsOf = (cell: readonly [number, number], upTo: number) => {
    const index = cell[1] * trace!.res + cell[0];
    for (let s = 0; s < upTo; s++) {
      const path = trace!.paths[s]?.[index];
      if (path) done.push(path);
    }
  };
  for (let v = 0; v < visit && v < cells.length; v++) pathsOf(cells[v]!, trace.samples);
  const current = cells[visit];
  if (current) pathsOf(current, cloudUpTo);
  if (done.length === 0) return;
  // One "sample" row holding every past path: the cloud iterates whatever it
  // is given, so a subset of (pixel, sample) pairs fits its shape unchanged.
  haze = new PixelRayCloud({
    paths: [done],
    opacity: params.pastDim,
    darkDim: DARK_DIM,
  });
  rayGroup.add(haze.group);
}

stage.frame((t) => {
  if (!trace || !plane || cells.length === 0) return;
  const visitLength = visitSeconds();
  const visit = Math.min(cells.length - 1, Math.max(0, Math.floor(t / visitLength)));
  const u = t - visit * visitLength;
  const samples = activeSamples();
  const j = Math.min(samples - 1, Math.floor(u / params.sampleSeconds));
  const uj = u - j * params.sampleSeconds;
  // A sample counts as landed once its ray has finished flying — the cell
  // changes when the light gets home, not when the ray sets out.
  const landTime = DRAW_FRACTION * params.sampleSeconds;
  const landed = Math.min(samples, j + (uj >= landTime ? 1 : 0));

  // The bright window slides with the sample in flight: slot 0 is the ray
  // being drawn, the slots behind it are the ones it is being averaged
  // with, and anything older has gone into the haze.
  const kept = Math.min(params.history, trails.length - 1);
  const cloudUpTo = Math.max(0, j - kept);
  const hazeKey = `${visit}/${cloudUpTo}`;
  if (hazeBuiltFor !== hazeKey) {
    hazeBuiltFor = hazeKey;
    buildHaze(visit, cloudUpTo);
  }

  const fan = fans[visit] ?? [];
  for (let i = 0; i < trails.length; i++) {
    const trail = trails[i]!;
    const k = j - i; // slot 0 is the sample in flight
    if (i > kept || k < 0) {
      trail.show([]);
      continue;
    }
    const segments = fan[k] ?? [];
    if (i === 0) {
      trail.show(segments, uj * growthSpeed, 1);
      continue;
    }
    // Fade back along the window rather than holding every kept ray at one
    // opacity: a wall of equal lines reads as clutter, a graded tail reads
    // as attempts dying away behind the one being made.
    const f = kept <= 1 ? 0 : (i - 1) / (kept - 1);
    trail.show(segments, Infinity, params.fanDim + (params.tailDim - params.fanDim) * f);
  }

  const cell = cells[visit]!;
  plane.highlight(cell);
  highlightPanel(trace.res, cell);

  const key = `${visit}/${landed}`;
  if (key === paintedFor) return;
  paintedFor = key;
  paint(visit, landed);
  setText(
    caption,
    `pixel (${cell[0]}, ${cell[1]}) · ` +
      (landed === 0
        ? `sample 1 of ${samples} in flight`
        : params.cellShows === 'sample'
          ? `sample ${landed} of ${samples}, on its own`
          : `averaged over ${landed} of ${samples} samples`),
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
  haze?.dispose();
  haze = null;
  hazeBuiltFor = '';
  for (const trail of trails) trail.dispose();
  trails = [];
  plane?.dispose();
  plane = null;
  paintedFor = '';
  stage.t = 0;

  if (sceneGroup) stage.scene.remove(sceneGroup);
  sceneGroup = sceneToThree(SCENES[params.scene]);
  stage.add(sceneGroup);
  placeCamera();
  frameView();

  const res = params.grid;
  ensurePanel(res);
  rayBuffer = new Uint8ClampedArray(res * res * 4);
  cells =
    params.mode === 'dwell'
      ? [[Math.min(res - 1, params.dwellX), Math.min(res - 1, params.dwellY)]]
      : chooseCells(res, params.pixels, params.pixelSeed);
  progress.visible = true;
  progress.set(0);
  caption.visible = params.captions;
  setText(caption, `${params.tracer} · ${params.scene} · tracing…`);

  const description = SCENES[params.scene];
  ready = tracePixelGrid({
    scene: buildScene(description, res, res),
    integrator: makeIntegrator(params.tracer),
    res,
    samples: activeSamples(),
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

      plane = new PixelPlane(
        {
          camera: description.camera,
          distance: PLANE_DISTANCE,
          res,
        },
        planeGroup,
      );

      // The fans, re-traced for their per-vertex throughput. Identical walks
      // to the grid trace's — the sampler is keyed by (pixel, sample), so
      // asking twice asks the same question.
      const scene = buildScene(description, res, res);
      const integrator = makeIntegrator(params.tracer);
      const indices = Array.from({ length: activeSamples() }, (_, i) => i);
      fans = cells.map((cell) =>
        tracePaths(scene, integrator, cell, indices, { seed: SEED }).map(toSegments),
      );

      // One trail per sample slot, reused for every cell in the sweep.
      let maxSegments = 1;
      for (const visit of fans) {
        for (const fan of visit) maxSegments = Math.max(maxSegments, fan.length);
      }
      trails = Array.from({ length: MAX_TRAILS }, () => {
        const trail = new RayTrail({ maxSegments, lineWidth: 3.5, dotRadius: 0.045 });
        rayGroup.add(trail.group);
        return trail;
      });

      retime();
      console.log(
        `[pixel-sweep] ${params.tracer} · ${params.scene} · ${res}x${res} · ` +
          `${cells.length} pixels x ${activeSamples()} samples · ` +
          `longest walk ${maxSegments} segments · ${growthSpeed.toFixed(1)} units/s`,
      );
    })
    .catch((err: Error) => {
      if (err.name === 'AbortError') return;
      progress.visible = false;
      setText(caption, `trace failed: ${err.message}`);
    });
}

stage.onReady(() => ready);
applyMode();
stage.start();
restart();

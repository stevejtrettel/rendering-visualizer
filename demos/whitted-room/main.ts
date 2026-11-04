/**
 * SHOWS: the talk's 1980s room, rendered by Whitted's tracer with every pass
 * in: albedo, brightness, shadow, Phong, reflection, refraction (Steve,
 * 2026-11-03: "a scene that has all the classic 1980s computer science
 * components"; a box room, and we are in it; "just filled in is fine").
 *
 * The whole frame is the image, 16:9. It fills in top to bottom over FILL
 * seconds, then holds. The film resolution slider is its height in pixels
 * (the width follows); changing it shows the finished image at once.
 * Computing is spread over frames (a budget per frame), so the page never
 * freezes; the fill never runs ahead of what is computed.
 *
 * The scene is `whitted-room` (src/scenes/registry.ts): cream and charcoal
 * tiles; `&tiles=classic` for Whitted's own red and yellow. The tracer is
 * src/core/integrators/whitted.ts, the same code as the rasterize slides'
 * passes: the white ball and both shiny balls get a Phong highlight, the
 * mirror is tinted blue, the glass is clear, index 1.5.
 */

import { createStage, createUI } from '@';
import { SCENES } from '@/scenes/registry';
import { buildScene } from '@/core/scene/scene';
import { cameraSample } from '@/core/integrators/estimators';
import { IndependentSampler } from '@/core/sampler/independent';
import { pixelSeedKey } from '@/core/sampler/sampler';
import { srgbEncode } from '@/render/film';
import { whittedTracer, WHITTED_PASSES } from '@/core/integrators/whitted';
import { FilmPanel } from '@/viz/film-panel';
import { ASPECT } from '@/viz/stage';

// --- Figure spec -----------------------------------------------------------
const CLASSIC = new URLSearchParams(location.search).get('tiles') === 'classic';
const desc = SCENES[CLASSIC ? 'whitted-room-classic' : 'whitted-room'];
const SPP = 8; // antialiasing only
const ALL = new Set(WHITTED_PASSES);
const START = 0.5;
const FILL = 4; // seconds, top to bottom
const HOLD = 3;
const BLANK = 18;
const BUDGET_MS = 12; // computing per frame

// --- Stage -----------------------------------------------------------------
const stage = createStage({ lights: false, controls: false });
const ui = createUI(stage);
stage.camera.position.set(0, 0, 5); // the figure is entirely the HUD
stage.loop = false;
stage.duration = START + FILL + HOLD;

const scene = buildScene(desc, 1, 1);
const { trace } = whittedTracer(desc, {
  agg: scene.aggregate,
  mirror: 'mirrorBall',
  glass: 'glassBall',
  ks: { ball: 0.5, mirrorBall: 0.5, glassBall: 0.5 },
});

// --- The image, computed a few rows at a time ---------------------------------
const params = { grid: 270 };
let width = 0;
let height = 0;
let panel: FilmPanel | null = null;
let image = new Uint8ClampedArray(0); // finished rows, RGBA
let rowsDone = 0;
let shownRows = -1;
let camScene: ReturnType<typeof buildScene> | null = null;
const sampler = new IndependentSampler(0);

function restart(jump: boolean): void {
  height = Math.round(params.grid);
  width = Math.round(height * ASPECT);
  camScene = buildScene(desc, width, height);
  image = new Uint8ClampedArray(width * height * 4);
  rowsDone = 0;
  shownRows = -1;
  panel?.dispose();
  panel = new FilmPanel({ width, height, center: [0, 0], drawnHeight: 2, border: false });
  stage.hud.add(panel.group);
  stage.t = jump ? START + FILL : 0;
}

function computeRow(y: number): void {
  for (let x = 0; x < width; x++) {
    const sum = [0, 0, 0];
    for (let s = 0; s < SPP; s++) {
      sampler.startPixelSample(pixelSeedKey(x, y, s));
      const rgb = trace(cameraSample(camScene!, [x, y], sampler).ray, ALL, scene.aggregate);
      for (let ch = 0; ch < 3; ch++) sum[ch]! += srgbEncode(rgb[ch]!);
    }
    const o = (y * width + x) * 4;
    for (let ch = 0; ch < 3; ch++) image[o + ch] = sum[ch]! / SPP;
    image[o + 3] = 255;
  }
}

ui.params.add(params, 'grid', 18, 540, 1).name('film resolution').onChange(() => restart(true));

stage.frame((t) => {
  if (!panel) return;
  const start = performance.now();
  while (rowsDone < height && performance.now() - start < BUDGET_MS) computeRow(rowsDone++);
  // The fill, eased in, never ahead of the computing.
  const u = Math.min(1, Math.max(0, (t - START) / FILL));
  const rows = Math.min(rowsDone, Math.floor(height * u * (2 - u)));
  if (rows === shownRows) return;
  shownRows = rows;
  const pixels = new Uint8ClampedArray(width * height * 4);
  pixels.set(image.subarray(0, rows * width * 4));
  for (let i = rows * width; i < width * height; i++) {
    pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = BLANK;
    pixels[i * 4 + 3] = 255;
  }
  panel.update(pixels);
});

stage.start();
restart(false);

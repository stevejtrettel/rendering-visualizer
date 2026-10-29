/**
 * SHOWS: what variance means for one pixel, the slide before `variance`
 * (Steve, 2026-10-29: help people see what variance means for a single
 * pixel; the earlier number line with s and s / sqrt N brackets was
 * confusing). The pixel's paths arrive one at a time, each as a square in
 * the colour it brought back, filling a 16 x 16 mosaic:
 *
 *   - the mosaic: the paths disagree wildly about this pixel's colour, some
 *     black (found nothing), most an ordinary shade, a few very bright. That
 *     disagreement is the variance, and the mosaic stays a patchwork;
 *   - the big square: the pixel itself, the average of the squares so far.
 *     It lurches with each new square early on and then stops moving.
 *
 * (A histogram of the paths' brightness was tried under the two and taken
 * out, Steve 2026-10-29: the mosaic and the average carry it.)
 *
 * Same tracer (pt-aim), seeds (pass s is sample s of every pixel), RES and
 * luminance as `variance`, so this is one of its pixels.
 *
 * Which pixel: picked, not hand-placed. Among floor pixels (by what the
 * pixel's centre sees) whose average luminance at PICK_N paths lies in
 * PICK_BAND and none of whose paths exceeds PICK_MAX (no lamp in the
 * pixel), away from the frame's edge: of the PICK_DARK share of them with
 * the fewest paths that found nothing (black squares say little; Steve,
 * 2026-10-29: too many of them hid what was happening), the one with the
 * largest spread relative to its average.
 *
 * Click a pixel of the image to do it for that pixel instead: its MAX_N
 * paths are traced on the spot and the figure starts again.
 *
 * Readability: colours are shown at exposure 1, clipped hue-preservingly at
 * 1, as on the slides before, so a very bright path shows as a saturated
 * square. N advances one path at a time for the first
 * SLOW, then in equal steps of log N.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { buildScene } from '@/core/scene/scene';
import { AimAtLightPT } from '@/core/integrators/pt-aim';
import { IndependentSampler } from '@/core/sampler/independent';
import { pixelSeedKey } from '@/core/sampler/sampler';
import { NULL_RECORDER } from '@/trace/recorder';
import { FilmPanel } from '@/viz/film-panel';
import { cellInPanel } from '@/viz/film-cell';
import { polyline, segments, setPolyline, setSegments } from '@/viz/lines';
import { srgbEncode } from '@/render/film';
import { label, setText } from '@/viz/text';
import { ASPECT } from '@/viz/stage';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
const RES = 45; // as variance
const SIDE = 16; // the mosaic is SIDE x SIDE paths
const MAX_N = SIDE * SIDE;
const MAX_BOUNCES = 8;
const PICK_N = 64;
const PICK_BAND = [0.15, 0.6];
const PICK_MAX = 5;
const PICK_DARK = 0.1; // the share of candidates, fewest black paths first, the pick is made from
const MARGIN = 4; // pixels kept clear of the image's edge, so the chosen one is easy to point at
const BLANK = 18;
/** HUD layout. */
const IMAGE = { center: [-1.38, -0.05] as [number, number], height: 0.75 };
const MOSAIC = { center: [-0.25, -0.05] as [number, number], height: 1.15 };
const PIXEL = { center: [1.05, -0.05] as [number, number], height: 0.75 };
// Timing, seconds.
const START = 0.8;
const SLOW = 12; // the first paths, one at a time
const SLOW_STEP = 0.6;
const RAMP = 11; // then SLOW .. MAX_N in equal steps of log N
const HOLD = 3;

// --- Stage -----------------------------------------------------------------
const stage = createStage({ lights: false, controls: false });
createUI(stage); // no parameters: one fixed pixel
stage.camera.position.set(0, 0, 5); // the figure is entirely the HUD

const image = new FilmPanel({ width: RES, height: RES, center: IMAGE.center, drawnHeight: IMAGE.height, border: false });
const mosaic = new FilmPanel({ width: SIDE, height: SIDE, center: MOSAIC.center, drawnHeight: MOSAIC.height, border: false });
const pixel = new FilmPanel({ width: 1, height: 1, center: PIXEL.center, drawnHeight: PIXEL.height, borderColor: C.ochre });
stage.hud.add(image.group, mosaic.group, pixel.group);

const zeros = (n: number) => Array.from({ length: n }, () => [0, 0, 0] as [number, number, number]);
const cellOutline = polyline(zeros(5), { color: C.ochre, width: 4 });
const leader = polyline(zeros(2), { color: C.ochre, width: 2 });
stage.hud.add(cellOutline, leader);

// The mosaic's cell lines, so each path reads as its own square.
const solid = (count: number, hex: number) => {
  const c = new THREE.Color(hex);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 3) c.toArray(out, i);
  return out;
};
{
  const grid = segments({ width: 1.5 });
  const h = MOSAIC.height;
  const [cx, cy] = MOSAIC.center;
  const pos: number[] = [];
  for (let i = 0; i <= SIDE; i++) {
    const f = -h / 2 + (h * i) / SIDE;
    pos.push(cx + f, cy - h / 2, 0.02, cx + f, cy + h / 2, 0.02, cx - h / 2, cy + f, 0.02, cx + h / 2, cy + f, 0.02);
  }
  setSegments(grid, new Float32Array(pos), solid(pos.length, C.slateDeep));
  stage.hud.add(grid);
}

const caption = label('', { size: 0.06, color: C.bone, anchorX: 'center', anchorY: 'top', position: [PIXEL.center[0], PIXEL.center[1] - PIXEL.height / 2 - 0.05, 0] });
stage.hud.add(caption);

// --- The pixel and its paths ------------------------------------------------------
/** Each path's colour (linear) and luminance, in arrival order. */
let paths: { rgb: [number, number, number]; lum: number }[] = [];

const scene = buildScene(SCENES[SCENE], RES, RES);
const integrator = new AimAtLightPT({ maxBounces: MAX_BOUNCES });
const sampler = new IndependentSampler(0);
const sample = (x: number, y: number, s: number): [number, number, number] => {
    sampler.startPixelSample(pixelSeedKey(x, y, s));
    let r = 0;
    let g = 0;
    let b = 0;
    for (const c of integrator.sampleContributions([x, y], sampler, scene, NULL_RECORDER)) {
      if (c.kind !== 'sample') continue;
      r += c.value.r;
      g += c.value.g;
      b += c.value.b;
    }
    return [r, g, b];
};
const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const ready = (async () => {

  // The image at PICK_N paths, and each pixel's statistics there.
  const sum = new Float64Array(RES * RES * 3);
  const sumY = new Float64Array(RES * RES);
  const sumY2 = new Float64Array(RES * RES);
  const maxY = new Float64Array(RES * RES);
  const dark = new Float64Array(RES * RES);
  for (let s = 0; s < PICK_N; s++) {
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        const c = sample(x, y, s);
        const i = y * RES + x;
        sum[i * 3]! += c[0];
        sum[i * 3 + 1]! += c[1];
        sum[i * 3 + 2]! += c[2];
        const lum = luminance(c);
        sumY[i]! += lum;
        sumY2[i]! += lum * lum;
        maxY[i] = Math.max(maxY[i]!, lum);
        if (lum === 0) dark[i]!++;
      }
    }
    if (s % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
  const onFloor = (i: number) => {
    const hit = scene.aggregate.intersect(scene.camera.generateRay([(i % RES) + 0.5, Math.floor(i / RES) + 0.5]));
    return (hit?.primitive as unknown as { name?: string } | undefined)?.name === 'floor';
  };
  const candidates: number[] = [];
  for (let i = 0; i < RES * RES; i++) {
    const [x, y] = [i % RES, Math.floor(i / RES)];
    if (x < MARGIN || y < MARGIN || x >= RES - MARGIN || y >= RES - MARGIN) continue; // not at the frame's edge
    if (!onFloor(i)) continue;
    const mean = sumY[i]! / PICK_N;
    if (mean < PICK_BAND[0]! || mean > PICK_BAND[1]! || maxY[i]! > PICK_MAX) continue;
    candidates.push(i);
  }
  candidates.sort((a, b) => dark[a]! - dark[b]!);
  let pick = candidates[0] ?? Math.floor((RES * RES) / 2);
  let best = -1;
  for (const i of candidates.slice(0, Math.max(1, Math.ceil(candidates.length * PICK_DARK)))) {
    const mean = sumY[i]! / PICK_N;
    const sd = Math.sqrt(Math.max(0, (sumY2[i]! - PICK_N * mean * mean) / (PICK_N - 1)));
    if (sd / mean > best) [best, pick] = [sd / mean, i];
  }

  const rgba = new Uint8ClampedArray(RES * RES * 4);
  for (let i = 0; i < RES * RES; i++) {
    const c = shown([sum[i * 3]! / PICK_N, sum[i * 3 + 1]! / PICK_N, sum[i * 3 + 2]! / PICK_N]);
    for (let j = 0; j < 3; j++) rgba[i * 4 + j] = srgbEncode(c[j]!);
    rgba[i * 4 + 3] = 255;
  }
  image.update(rgba);
  choose(pick % RES, Math.floor(pick / RES));
})();

/** Do it for pixel (px, py): its MAX_N paths (the same ones the bar slide averages), and start again. */
function choose(px: number, py: number): void {
  const outline = cellInPanel(IMAGE.center, IMAGE.height, RES, px, py);
  setPolyline(cellOutline, outline);
  const right = outline[1]!;
  setPolyline(leader, [[right[0], right[1] - IMAGE.height / RES / 2, 0], [MOSAIC.center[0] - MOSAIC.height / 2 - 0.02, MOSAIC.center[1], 0]]);
  paths = [];
  for (let s = 0; s < MAX_N; s++) {
    const rgb = sample(px, py, s);
    paths.push({ rgb, lum: luminance(rgb) });
  }
  shownN = -1;
  stage.t = 0;
  console.log(`[pixel-samples] pixel (${px}, ${py}): ${paths.filter((p) => p.lum === 0).length} of ${MAX_N} paths found nothing`);
}

// --- Clicking the image ------------------------------------------------------
// The HUD spans x in [-ASPECT, ASPECT], y in [-1, 1] over the letterboxed
// canvas. A click on a pixel of the image does it for that pixel.
const canvas = stage.renderer.domElement;
function cellUnder(e: PointerEvent): [number, number] | null {
  const r = canvas.getBoundingClientRect();
  const hx = (((e.clientX - r.left) / r.width) * 2 - 1) * ASPECT;
  const hy = -(((e.clientY - r.top) / r.height) * 2 - 1);
  const h = IMAGE.height;
  const x = Math.floor(((hx - (IMAGE.center[0] - h / 2)) / h) * RES);
  const y = Math.floor((((IMAGE.center[1] + h / 2) - hy) / h) * RES);
  return x >= 0 && x < RES && y >= 0 && y < RES ? [x, y] : null;
}
canvas.addEventListener('pointerup', (e) => {
  const cell = paths.length ? cellUnder(e) : null;
  if (cell) choose(cell[0], cell[1]);
});
canvas.addEventListener('pointermove', (e) => {
  canvas.style.cursor = cellUnder(e) ? 'pointer' : '';
});

/** A colour at exposure 1, clipped at 1 without changing its hue. */
function shown(c: [number, number, number] | number[]): [number, number, number] {
  const m = Math.max(c[0]!, c[1]!, c[2]!);
  const k = m > 1 ? 1 / m : 1;
  return [c[0]! * k, c[1]! * k, c[2]! * k];
}

// --- Playback --------------------------------------------------------------
const nAt = (t: number): number => {
  const slow = Math.floor((t - START) / SLOW_STEP) + 1;
  if (slow <= SLOW) return Math.max(0, slow);
  const u = Math.min(1, Math.max(0, (t - START - SLOW * SLOW_STEP) / RAMP));
  return Math.round(SLOW * Math.pow(MAX_N / SLOW, u));
};
const mosaicPixels = new Uint8ClampedArray(MAX_N * 4);
const pixelPixels = new Uint8ClampedArray(4);
let shownN = -1;

stage.frame((t) => {
  if (!paths.length) return;
  const n = nAt(t);
  if (n === shownN) return;
  shownN = n;

  // The mosaic: a square per path, in arrival order, row by row.
  for (let s = 0; s < MAX_N; s++) {
    const c = s < n ? shown(paths[s]!.rgb) : null;
    for (let j = 0; j < 3; j++) mosaicPixels[s * 4 + j] = c ? srgbEncode(c[j]!) : BLANK;
    mosaicPixels[s * 4 + 3] = 255;
  }
  mosaic.update(mosaicPixels);

  // The pixel: the average of the squares so far.
  const mean = [0, 0, 0];
  for (let s = 0; s < n; s++) for (let j = 0; j < 3; j++) mean[j]! += paths[s]!.rgb[j]! / Math.max(1, n);
  const m = n ? shown(mean) : null;
  for (let j = 0; j < 3; j++) pixelPixels[j] = m ? srgbEncode(m[j]!) : BLANK;
  pixelPixels[3] = 255;
  pixel.update(pixelPixels);

  setText(caption, n === 0 ? '' : n === 1 ? '1 path' : `${n} paths`);
});

stage.duration = START + SLOW * SLOW_STEP + RAMP + HOLD;
stage.onReady(() => ready);
stage.start();

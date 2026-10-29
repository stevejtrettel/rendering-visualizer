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
 *     It lurches with each new square early on and then stops moving;
 *   - the histogram: the paths' brightnesses (luminance), as a share of the
 *     paths so far, with the average marked. More paths fill in its shape;
 *     they do not narrow it.
 *
 * Same tracer (pt-aim), seeds (pass s is sample s of every pixel), RES and
 * luminance as `variance`, so this is one of its pixels.
 *
 * Which pixel: picked, not hand-placed. Among floor pixels (by what the
 * pixel's centre sees) whose average luminance at PICK_N paths lies in
 * PICK_BAND, none of whose paths exceeds PICK_MAX (no lamp in the pixel)
 * and at most PICK_DARK of whose paths found nothing (a pixel in a shadow
 * shows mostly black squares and a histogram that is one bar at zero), the
 * one with the largest spread relative to its average, away from the edge.
 *
 * Readability: colours are shown at exposure 1, clipped hue-preservingly at
 * 1, as on the slides before, so a very bright path shows as a saturated
 * square. The histogram's last bin collects everything from HIST_QUANTILE
 * of the pixel's values up. N advances one path at a time for the first
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
const PICK_DARK = 0.3;
const MARGIN = 4; // pixels kept clear of the image's edge, so the chosen one is easy to point at
const BINS = 24;
const HIST_QUANTILE = 0.97;
const BLANK = 18;
/** HUD layout. */
const IMAGE = { center: [-1.38, 0.22] as [number, number], height: 0.7 };
const MOSAIC = { center: [-0.3, 0.22] as [number, number], height: 0.9 };
const PIXEL = { center: [0.95, 0.22] as [number, number], height: 0.6 };
const HIST = { left: -0.75, right: 1.25, bottom: -0.78, height: 0.36 };
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

// The histogram: a bar per bin, its height the share of paths in the bin.
const binWidth = (HIST.right - HIST.left) / BINS;
const histBars = new THREE.InstancedMesh(
  new THREE.PlaneGeometry(binWidth * 0.86, 1).translate(0, 0.5, 0),
  new THREE.MeshBasicMaterial({ color: C.bone, toneMapped: false }),
  BINS,
);
stage.hud.add(histBars);
stage.hud.add(polyline([[HIST.left, HIST.bottom, 0], [HIST.right, HIST.bottom, 0]], { color: C.ash, width: 2 }));
stage.hud.add(label('0', { size: 0.045, color: C.ash, anchorX: 'center', anchorY: 'top', position: [HIST.left + binWidth / 2, HIST.bottom - 0.02, 0] }));
const meanMark = polyline(zeros(2), { color: C.ochre, width: 4 });
stage.hud.add(meanMark);

const caption = label('', { size: 0.06, color: C.bone, anchorX: 'center', anchorY: 'top', position: [PIXEL.center[0], PIXEL.center[1] - PIXEL.height / 2 - 0.05, 0] });
stage.hud.add(caption);

// --- The pixel and its paths ------------------------------------------------------
/** Each path's colour (linear) and luminance, in arrival order. */
let paths: { rgb: [number, number, number]; lum: number }[] = [];
let histMax = 1;
let histTop = 1; // the largest bin share at MAX_N, which sets the vertical scale

const ready = (async () => {
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
  let pick = 0;
  let best = -1;
  for (let i = 0; i < RES * RES; i++) {
    const [x, y] = [i % RES, Math.floor(i / RES)];
    if (x < MARGIN || y < MARGIN || x >= RES - MARGIN || y >= RES - MARGIN) continue; // not at the frame's edge
    if (!onFloor(i)) continue;
    const mean = sumY[i]! / PICK_N;
    if (mean < PICK_BAND[0]! || mean > PICK_BAND[1]! || maxY[i]! > PICK_MAX || dark[i]! / PICK_N > PICK_DARK) continue;
    const sd = Math.sqrt(Math.max(0, (sumY2[i]! - PICK_N * mean * mean) / (PICK_N - 1)));
    if (sd / mean > best) [best, pick] = [sd / mean, i];
  }
  const [px, py] = [pick % RES, Math.floor(pick / RES)];

  const rgba = new Uint8ClampedArray(RES * RES * 4);
  for (let i = 0; i < RES * RES; i++) {
    const c = shown([sum[i * 3]! / PICK_N, sum[i * 3 + 1]! / PICK_N, sum[i * 3 + 2]! / PICK_N]);
    for (let j = 0; j < 3; j++) rgba[i * 4 + j] = srgbEncode(c[j]!);
    rgba[i * 4 + 3] = 255;
  }
  image.update(rgba);
  const outline = cellInPanel(IMAGE.center, IMAGE.height, RES, px, py);
  setPolyline(cellOutline, outline);
  const right = outline[1]!;
  setPolyline(leader, [[right[0], right[1] - IMAGE.height / RES / 2, 0], [MOSAIC.center[0] - MOSAIC.height / 2 - 0.02, MOSAIC.center[1], 0]]);

  // That pixel's MAX_N paths, the same ones the bar slide averages.
  paths = [];
  for (let s = 0; s < MAX_N; s++) {
    const rgb = sample(px, py, s);
    paths.push({ rgb, lum: luminance(rgb) });
  }
  const sorted = paths.map((p) => p.lum).sort((a, b) => a - b);
  histMax = Math.max(1e-3, sorted[Math.floor(HIST_QUANTILE * (MAX_N - 1))]!);
  histTop = Math.max(...histogram(MAX_N)) / MAX_N;
  console.log(`[pixel-samples] pixel (${px}, ${py}), spread/mean ${best.toFixed(2)} at ${PICK_N} paths`);
})();

/** A colour at exposure 1, clipped at 1 without changing its hue. */
function shown(c: [number, number, number] | number[]): [number, number, number] {
  const m = Math.max(c[0]!, c[1]!, c[2]!);
  const k = m > 1 ? 1 / m : 1;
  return [c[0]! * k, c[1]! * k, c[2]! * k];
}

const binOf = (lum: number) => Math.min(BINS - 1, Math.floor((lum / histMax) * (BINS - 1)));
function histogram(n: number): number[] {
  const counts = new Array<number>(BINS).fill(0);
  for (let s = 0; s < n; s++) counts[binOf(paths[s]!.lum)]!++;
  return counts;
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
const matrix = new THREE.Matrix4();
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

  // The histogram, as shares of the paths so far, and the average marked.
  const counts = histogram(n);
  counts.forEach((count, b) => {
    const h = n ? (count / n / histTop) * HIST.height : 0;
    matrix.makeScale(1, Math.max(1e-4, h), 1).setPosition(HIST.left + (b + 0.5) * binWidth, HIST.bottom, 0);
    histBars.setMatrixAt(b, matrix);
  });
  histBars.instanceMatrix.needsUpdate = true;
  meanMark.visible = n > 0;
  if (n) {
    const meanLum = paths.slice(0, n).reduce((a, p) => a + p.lum, 0) / n;
    const x = HIST.left + Math.min(1, meanLum / histMax) * (BINS - 1) * binWidth + binWidth / 2;
    setPolyline(meanMark, [[x, HIST.bottom - 0.03, 0], [x, HIST.bottom + HIST.height * 1.08, 0]]);
  }
  setText(caption, n === 0 ? '' : n === 1 ? '1 path' : `${n} paths`);
});

stage.duration = START + SLOW * SLOW_STEP + RAMP + HOLD;
stage.onReady(() => ready);
stage.start();

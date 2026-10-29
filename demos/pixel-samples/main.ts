/**
 * SHOWS: one pixel up close, the slide before `variance`. Its paths arrive
 * one by one as dots on a number line at their values; the running average
 * is a line through them; under them two brackets round the average:
 *
 *   s          the spread of the path values (sample standard deviation):
 *              it settles to the pixel's own spread and stays there;
 *   s / sqrt N  the standard error of the average: it keeps shrinking.
 *
 * The samples stay as wild as ever; only the average tightens. The final
 * s / sqrt N is this pixel's bar on the next slide: same tracer (pt-aim),
 * same seeds (pass s is sample s of every pixel), same RES, same luminance.
 *
 * Which pixel: picked, not hand-placed. Among floor pixels (by what the
 * pixel's centre sees; the ceiling, edge-on to the lamp, has mostly zero
 * paths and makes a dull start) whose average luminance at PICK_N paths
 * lies in PICK_BAND and none of whose paths exceeds PICK_MAX (no lamp in
 * the pixel), the one with the largest spread relative to its average.
 *
 * Readability: values beyond the axis's end are drawn at the end, a
 * little larger (the axis runs to AXIS_QUANTILE of the pixel's 256 values;
 * the rare lucky path would otherwise squash the rest against zero). Dots
 * are spread up and down by a fixed per-sample hash, only so that equal
 * values do not stack into one dot. N advances one path at a time for the
 * first SLOW, then in equal steps of log N.
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
import { polyline, setPolyline } from '@/viz/lines';
import { srgbEncode } from '@/render/film';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
const RES = 45; // as variance
const MAX_N = 256;
const MAX_BOUNCES = 8;
const PICK_N = 64;
const PICK_BAND = [0.15, 0.6];
const PICK_MAX = 5;
const AXIS_QUANTILE = 0.97;
/** HUD layout: the image at the left, the number line at the right. */
const IMAGE = { center: [-1.25, 0.05] as [number, number], height: 0.95 };
const AXIS = { left: -0.45, right: 1.6, y: -0.18 };
const DOTS = { bottom: AXIS.y + 0.04, height: 0.55, radius: 0.016 };
const BRACKETS = { se: AXIS.y - 0.12, s: AXIS.y - 0.26 };
// Timing, seconds.
const START = 0.8;
const SLOW = 6; // the first paths, one at a time
const SLOW_STEP = 0.8;
const RAMP = 12; // then SLOW .. MAX_N in equal steps of log N
const HOLD = 3;

// --- Stage -----------------------------------------------------------------
const stage = createStage({ lights: false, controls: false });
createUI(stage); // no parameters: one fixed pixel
stage.camera.position.set(0, 0, 5); // the figure is entirely the HUD

const image = new FilmPanel({ width: RES, height: RES, center: IMAGE.center, drawnHeight: IMAGE.height, border: false });
stage.hud.add(image.group);
const cellOutline = polyline(Array.from({ length: 5 }, () => [0, 0, 0] as [number, number, number]), { color: C.ochre, width: 4 });
stage.hud.add(cellOutline);

stage.hud.add(polyline([[AXIS.left, AXIS.y, 0], [AXIS.right, AXIS.y, 0]], { color: C.ash, width: 2 }));
stage.hud.add(polyline([[AXIS.left, AXIS.y, 0], [AXIS.left, AXIS.y - 0.025, 0]], { color: C.ash, width: 2 }));
stage.hud.add(label('0', { size: 0.045, color: C.ash, anchorX: 'center', anchorY: 'top', position: [AXIS.left, AXIS.y - 0.035, 0] }));

const dots = new THREE.InstancedMesh(
  new THREE.CircleGeometry(DOTS.radius, 16),
  new THREE.MeshBasicMaterial({ color: C.bone, transparent: true, opacity: 0.85, toneMapped: false }),
  MAX_N,
);
dots.count = 0;
stage.hud.add(dots);

const meanLine = polyline([[0, 0, 0], [0, 1, 0]], { color: C.bone, width: 3 });
const bracketPoints = () => Array.from({ length: 6 }, () => [0, 0, 0] as [number, number, number]);
const seBracket = polyline(bracketPoints(), { color: C.ochre, width: 4 });
const sBracket = polyline(bracketPoints(), { color: C.ash, width: 3 });
stage.hud.add(meanLine, seBracket, sBracket);
const seLabel = label('s/√N', { size: 0.05, color: C.ochre, anchorX: 'left', anchorY: 'middle' });
const sLabel = label('s', { size: 0.05, color: C.ash, anchorX: 'left', anchorY: 'middle' });
stage.hud.add(seLabel, sLabel);
const caption = label('', { size: 0.06, color: C.bone, anchorX: 'center', anchorY: 'top', position: [(AXIS.left + AXIS.right) / 2, -0.62, 0] });
stage.hud.add(caption);

// --- The pixel and its paths ------------------------------------------------------
let values: number[] = [];
let axisMax = 1;

const ready = (async () => {
  const scene = buildScene(SCENES[SCENE], RES, RES);
  const integrator = new AimAtLightPT({ maxBounces: MAX_BOUNCES });
  const sampler = new IndependentSampler(0);
  const sample = (x: number, y: number, s: number) => {
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
    return [r, g, b] as const;
  };

  // The image at PICK_N paths, and each pixel's statistics there.
  const sum = new Float64Array(RES * RES * 3);
  const sumY = new Float64Array(RES * RES);
  const sumY2 = new Float64Array(RES * RES);
  const maxY = new Float64Array(RES * RES);
  for (let s = 0; s < PICK_N; s++) {
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        const [r, g, b] = sample(x, y, s);
        const i = y * RES + x;
        sum[i * 3]! += r;
        sum[i * 3 + 1]! += g;
        sum[i * 3 + 2]! += b;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sumY[i]! += lum;
        sumY2[i]! += lum * lum;
        maxY[i] = Math.max(maxY[i]!, lum);
      }
    }
    if (s % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
  // What each pixel's centre sees.
  const onFloor = (i: number) => {
    const hit = scene.aggregate.intersect(scene.camera.generateRay([(i % RES) + 0.5, Math.floor(i / RES) + 0.5]));
    return (hit?.primitive as unknown as { name?: string } | undefined)?.name === 'floor';
  };
  let pick = 0;
  let best = -1;
  for (let i = 0; i < RES * RES; i++) {
    if (!onFloor(i)) continue;
    const mean = sumY[i]! / PICK_N;
    if (mean < PICK_BAND[0]! || mean > PICK_BAND[1]! || maxY[i]! > PICK_MAX) continue;
    const sd = Math.sqrt(Math.max(0, (sumY2[i]! - PICK_N * mean * mean) / (PICK_N - 1)));
    if (sd / mean > best) [best, pick] = [sd / mean, i];
  }
  const [px, py] = [pick % RES, Math.floor(pick / RES)];

  const rgba = new Uint8ClampedArray(RES * RES * 4);
  for (let i = 0; i < RES * RES; i++) {
    const c = [sum[i * 3]! / PICK_N, sum[i * 3 + 1]! / PICK_N, sum[i * 3 + 2]! / PICK_N];
    const m = Math.max(...c);
    const k = m > 1 ? 1 / m : 1;
    for (let j = 0; j < 3; j++) rgba[i * 4 + j] = srgbEncode(c[j]! * k);
    rgba[i * 4 + 3] = 255;
  }
  image.update(rgba);
  setPolyline(cellOutline, cellInPanel(IMAGE.center, IMAGE.height, RES, px, py));

  // That pixel's MAX_N paths, the same ones the bar slide averages.
  values = [];
  for (let s = 0; s < MAX_N; s++) {
    const [r, g, b] = sample(px, py, s);
    values.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  const sorted = [...values].sort((a, b) => a - b);
  axisMax = Math.max(1e-3, sorted[Math.floor(AXIS_QUANTILE * (MAX_N - 1))]!) * 1.1;
  console.log(`[pixel-samples] pixel (${px}, ${py}), spread/mean ${best.toFixed(2)} at ${PICK_N} paths`);
})();

// --- Playback --------------------------------------------------------------
const nAt = (t: number): number => {
  const slow = Math.floor((t - START) / SLOW_STEP) + 1;
  if (slow <= SLOW) return Math.max(0, slow);
  const u = Math.min(1, Math.max(0, (t - START - SLOW * SLOW_STEP) / RAMP));
  return Math.round(SLOW * Math.pow(MAX_N / SLOW, u));
};
const toX = (v: number) => AXIS.left + Math.min(1, v / axisMax) * (AXIS.right - AXIS.left);
const jitter = (s: number) => (Math.imul(s + 1, 0x9e3779b1) >>> 0) / 4294967296;
const matrix = new THREE.Matrix4();
let shownN = -1;

function bracket(y: number, from: number, to: number): [number, number, number][] {
  const h = 0.025;
  return [[from, y + h, 0], [from, y - h, 0], [from, y, 0], [to, y, 0], [to, y + h, 0], [to, y - h, 0]];
}

stage.frame((t) => {
  if (!values.length) return;
  const n = nAt(t);
  if (n === shownN) return;
  shownN = n;

  for (let s = 0; s < n; s++) {
    const over = values[s]! > axisMax;
    matrix.makeScale(over ? 1.5 : 1, over ? 1.5 : 1, 1).setPosition(toX(values[s]!), DOTS.bottom + jitter(s) * DOTS.height, 0.01);
    dots.setMatrixAt(s, matrix);
  }
  dots.count = n;
  dots.instanceMatrix.needsUpdate = true;

  const shown = n >= 1;
  meanLine.visible = shown;
  for (const o of [seBracket, sBracket, seLabel, sLabel]) o.visible = n >= 2;
  setText(caption, n === 0 ? '' : n === 1 ? '1 path' : `${n} paths`);
  if (!shown) return;
  const mean = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  setPolyline(meanLine, [[toX(mean), AXIS.y, 0], [toX(mean), DOTS.bottom + DOTS.height + 0.03, 0]]);
  if (n < 2) return;
  const s = Math.sqrt(values.slice(0, n).reduce((a, v) => a + (v - mean) * (v - mean), 0) / (n - 1));
  const se = s / Math.sqrt(n);
  const clampX = (v: number) => Math.max(AXIS.left, toX(v));
  setPolyline(seBracket, bracket(BRACKETS.se, clampX(mean - se), toX(mean + se)));
  setPolyline(sBracket, bracket(BRACKETS.s, clampX(mean - s), toX(mean + s)));
  seLabel.position.set(toX(mean + se) + 0.03, BRACKETS.se, 0);
  sLabel.position.set(toX(mean + s) + 0.03, BRACKETS.s, 0);
});

stage.duration = START + SLOW * SLOW_STEP + RAMP + HOLD;
stage.onReady(() => ready);
stage.start();

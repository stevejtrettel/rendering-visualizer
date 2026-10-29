/**
 * SHOWS: how fast the noise goes away, per pixel and for the whole image.
 * The image lies tilted back like a floor, and on every pixel stands a bar
 * as tall as that pixel's standard error; beside it, a graph of the image's
 * mean standard error against the number of paths per pixel (Steve,
 * 2026-10-29: a bar graph over the image per pixel, then a single number
 * per image plotted on a graph; standard error, ordinary axes; no fitted
 * c / sqrt(N) drawn for comparison).
 *
 * Which tracer (`?tracer=` in the URL): plain (bounce until the lamp is hit
 * by luck: one-path's), aim (bounce a while, then aim at the lamp: one-sample
 * and many-samples', the default, whose first 64 passes are exactly
 * many-samples'), nee (aim at the lamp at every bounce, MIS-weighted:
 * full-render's). `?compare` also draws the mean standard error of the other
 * two on the same axes (Steve, 2026-10-29: the naive picture and the
 * optimized one, to see both are sqrt but one faster). Pass s is sample s of
 * every pixel throughout, up to MAX_N.
 *
 * A pixel's standard error after N paths is s / sqrt(N), s the sample
 * standard deviation of its N path values' luminance (Rec. 709 weights):
 * what the renderer itself could compute, no reference image needed, and an
 * estimate, so it wobbles a little before it settles. It falls like
 * 1 / sqrt(N) because s settles to the pixel's own spread and only the
 * sqrt(N) changes: the paths stay as wild as ever, their average improves.
 * The graph's number is the mean of the bars. (The plain tracer's path
 * values are dominated by rare lucky hits on the lamp, so with few paths a
 * pixel's own estimate of its spread runs low and grows as the rare hits
 * turn up: early on, a heavy-tailed estimator underestimates its own
 * error.) Undefined at N = 1 (one path has
 * no spread), so the figure starts at N = 2.
 *
 * Readability choices: bar heights are capped at BAR_CAP (the few pixels
 * that see the lamp directly, or catch a rare bright path, would otherwise
 * stand far above the rest); the graph's mean uses the true, uncapped
 * values. Bars carry their pixel's current colour, so they read as the
 * image lifted up. N advances in equal steps of log N, so the early doublings,
 * where the bars shrink most, get the time.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { buildScene } from '@/core/scene/scene';
import { AimAtLightPT } from '@/core/integrators/pt-aim';
import { UnidirectionalPT } from '@/core/integrators/pt';
import { NEEPathTracer } from '@/core/integrators/pt-nee';
import type { Integrator } from '@/core/integrators/types';
import { IndependentSampler } from '@/core/sampler/independent';
import { pixelSeedKey } from '@/core/sampler/sampler';
import { NULL_RECORDER } from '@/trace/recorder';
import { polyline, segments, setSegments } from '@/viz/lines';
import { srgbEncode } from '@/render/film';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
const RES = 45; // as one-sample and many-samples
const MAX_N = 256;
const MAX_BOUNCES = 8;
const SIZE = 4; // the image's side, world units
const BAR_CAP = 1.6; // world units
const BAR_FILL = 0.8; // a bar's width as a share of its pixel
// Timing, seconds.
const HOLD_START = 1.0;
const RAMP = 16; // N from 2 to MAX_N, in equal steps of log N
const HOLD = 3;
type Tracer = 'plain' | 'aim' | 'nee';
const TRACERS: Record<Tracer, () => Integrator> = {
  plain: () => new UnidirectionalPT({ maxBounces: MAX_BOUNCES, rrStartDepth: 99, sampleNEE: false }),
  aim: () => new AimAtLightPT({ maxBounces: MAX_BOUNCES }),
  nee: () => new NEEPathTracer({ maxBounces: MAX_BOUNCES, rrStartDepth: 99 }),
};
const CURVE_COLOUR: Record<Tracer, number> = { plain: C.rust, aim: C.ochre, nee: C.blue };
const query = new URLSearchParams(location.search);
const TRACER: Tracer = (['plain', 'aim', 'nee'] as const).find((n) => n === query.get('tracer')) ?? 'aim';
const COMPARE = query.has('compare');
const ON_GRAPH: Tracer[] = COMPARE ? ['plain', 'aim', 'nee'] : [TRACER];
/** The graph, in HUD units. */
const GRAPH = { left: 0.45, bottom: -0.55, width: 1.15, height: 1.0 };

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 5.2, 6.2], target: [0, 0.4, 0.3], fov: 42 });
createUI(stage); // no parameters: the figure is one fixed render
stage.shiftView(0.22); // the image and its bars at the left, the graph at the right

const imageData = new Uint8Array(RES * RES * 4);
const imageTexture = new THREE.DataTexture(imageData, RES, RES, THREE.RGBAFormat);
imageTexture.colorSpace = THREE.SRGBColorSpace;
imageTexture.magFilter = THREE.NearestFilter;
imageTexture.minFilter = THREE.NearestFilter;
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(SIZE, SIZE),
  new THREE.MeshBasicMaterial({ map: imageTexture, toneMapped: false }),
);
floor.rotation.x = -Math.PI / 2; // lying flat; texture row 0 (the image's bottom) toward the viewer
stage.add(floor);

const cell = SIZE / RES;
const barGeometry = new THREE.BoxGeometry(cell * BAR_FILL, 1, cell * BAR_FILL).translate(0, 0.5, 0);
const bars = new THREE.InstancedMesh(
  barGeometry,
  new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0 }),
  RES * RES,
);
bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
stage.add(bars);
/** Where pixel (x, y) stands: raster y grows away from the viewer's near edge to the far one. */
const cellCentre = (x: number, y: number) => new THREE.Vector3(-SIZE / 2 + (x + 0.5) * cell, 0, -SIZE / 2 + (y + 0.5) * cell);

// The graph.
const g = GRAPH;
const toGraph = (n: number, v: number, vMax: number): [number, number, number] => [
  g.left + (n / MAX_N) * g.width,
  g.bottom + Math.min(1.05, v / vMax) * g.height,
  0,
];
stage.hud.add(
  polyline([[g.left, g.bottom + g.height, 0], [g.left, g.bottom, 0], [g.left + g.width, g.bottom, 0]], { color: C.ash, width: 2 }),
);
// Curves as segment sets, which grow safely (lines.ts, setSegments).
const curves = Object.fromEntries(ON_GRAPH.map((n) => [n, segments({ width: 4 })])) as Record<Tracer, ReturnType<typeof segments>>;
for (const n of ON_GRAPH) stage.hud.add(curves[n]);
const curveLabels = Object.fromEntries(
  ON_GRAPH.map((n) => [n, label(COMPARE ? n : '', { size: 0.045, color: CURVE_COLOUR[n], anchorX: 'left', anchorY: 'middle' })]),
) as Record<Tracer, ReturnType<typeof label>>;
for (const n of ON_GRAPH) stage.hud.add(curveLabels[n]);
const solid = (count: number, hex: number) => {
  const c = new THREE.Color(hex);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 3) c.toArray(out, i);
  return out;
};
/** A polyline through pts, as segments. */
function drawPolyline(lines: ReturnType<typeof segments>, pts: [number, number, number][], hex: number): void {
  const pos: number[] = [];
  for (let k = 1; k < pts.length; k++) pos.push(...pts[k - 1]!, ...pts[k]!);
  setSegments(lines, new Float32Array(pos), solid(pos.length, hex));
}
for (const n of [64, 128, 192, 256]) {
  const [x] = toGraph(n, 0, 1);
  stage.hud.add(polyline([[x, g.bottom, 0], [x, g.bottom - 0.025, 0]], { color: C.ash, width: 2 }));
  stage.hud.add(label(String(n), { size: 0.045, color: C.ash, anchorX: 'center', anchorY: 'top', position: [x, g.bottom - 0.04, 0] }));
}
stage.hud.add(label('0', { size: 0.045, color: C.ash, anchorX: 'center', anchorY: 'top', position: [g.left, g.bottom - 0.04, 0] }));
const caption = label('', { size: 0.06, color: C.bone, anchorX: 'center', anchorY: 'top', position: [g.left + g.width / 2, g.bottom - 0.14, 0] });
stage.hud.add(caption);


// --- The paths ---------------------------------------------------------------
// Per N = 1..MAX_N: each pixel's mean colour (display, exposure 1, clipped)
// and its standard error of luminance; and the image's mean standard error.
// The bars and floor are TRACER's; the graph has a curve per ON_GRAPH.
let means: Float32Array[] = [];
let errors: Float32Array[] = [];
const meanError = {} as Record<Tracer, number[]>;

async function run(tracer: Tracer, keep: boolean): Promise<void> {
  const scene = buildScene(SCENES[SCENE], RES, RES);
  const integrator = TRACERS[tracer]();
  const sampler = new IndependentSampler(0);
  const sum = new Float64Array(RES * RES * 3);
  const sumY = new Float64Array(RES * RES);
  const sumY2 = new Float64Array(RES * RES);
  const curve: number[] = [];
  for (let s = 0; s < MAX_N; s++) {
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        sampler.startPixelSample(pixelSeedKey(x, y, s));
        let r = 0;
        let gg = 0;
        let b = 0;
        for (const c of integrator.sampleContributions([x, y], sampler, scene, NULL_RECORDER)) {
          if (c.kind !== 'sample') continue;
          r += c.value.r;
          gg += c.value.g;
          b += c.value.b;
        }
        const i = y * RES + x;
        sum[i * 3]! += r;
        sum[i * 3 + 1]! += gg;
        sum[i * 3 + 2]! += b;
        const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        sumY[i]! += lum;
        sumY2[i]! += lum * lum;
      }
    }
    const n = s + 1;
    const mean = new Float32Array(RES * RES * 3);
    const err = new Float32Array(RES * RES);
    let total = 0;
    for (let i = 0; i < RES * RES; i++) {
      const c = [sum[i * 3]! / n, sum[i * 3 + 1]! / n, sum[i * 3 + 2]! / n];
      const m = Math.max(c[0]!, c[1]!, c[2]!);
      const k = m > 1 ? 1 / m : 1; // clipped at 1 without changing the hue, as the slides before
      mean[i * 3] = c[0]! * k;
      mean[i * 3 + 1] = c[1]! * k;
      mean[i * 3 + 2] = c[2]! * k;
      if (n > 1) {
        const variance = Math.max(0, (sumY2[i]! - (sumY[i]! * sumY[i]!) / n) / (n - 1));
        err[i] = Math.sqrt(variance / n);
        total += err[i]!;
      }
    }
    if (keep) {
      means.push(mean);
      errors.push(err);
    }
    curve.push(total / (RES * RES));
    if (s % 8 === 7) await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
  }
  meanError[tracer] = curve;
}

const ready = (async () => {
  await run(TRACER, true);
  for (const n of ON_GRAPH) if (n !== TRACER) await run(n, false);
})();

// --- Playback --------------------------------------------------------------
const nAt = (t: number) => {
  const u = Math.min(1, Math.max(0, (t - HOLD_START) / RAMP));
  return Math.round(2 * Math.pow(MAX_N / 2, u)); // 2 .. MAX_N, equal steps of log N
};
let shownN = -1;
const matrix = new THREE.Matrix4();
const colour = new THREE.Color();

stage.frame((t) => {
  if (ON_GRAPH.some((k) => !meanError[k])) return;
  const n = nAt(t);
  if (n === shownN) return;
  shownN = n;
  const mean = means[n - 1]!;
  const err = errors[n - 1]!;

  // The bar scale is fixed by the first frame, N = 2, so the bars visibly fall.
  const scale = barScale();
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const i = y * RES + x;
      const h = Math.max(0.002, Math.min(BAR_CAP, err[i]! * scale));
      matrix.makeScale(1, h, 1).setPosition(cellCentre(x, y));
      bars.setMatrixAt(i, matrix);
      colour.setRGB(mean[i * 3]!, mean[i * 3 + 1]!, mean[i * 3 + 2]!);
      bars.setColorAt(i, colour);
      // The floor: texture row 0 is the near edge, which is raster row RES - 1.
      const o = ((RES - 1 - y) * RES + x) * 4;
      imageData[o] = srgbEncode(mean[i * 3]!);
      imageData[o + 1] = srgbEncode(mean[i * 3 + 1]!);
      imageData[o + 2] = srgbEncode(mean[i * 3 + 2]!);
      imageData[o + 3] = 255;
    }
  }
  bars.instanceMatrix.needsUpdate = true;
  if (bars.instanceColor) bars.instanceColor.needsUpdate = true;
  imageTexture.needsUpdate = true;

  // The graph: each tracer's mean standard error from N = 2 to now. One
  // vertical scale for all, set by the highest.
  const vMax = Math.max(...ON_GRAPH.map((k) => meanError[k][1]!)) * 1.05;
  for (const tracer of ON_GRAPH) {
    const curve = meanError[tracer];
    const pts: [number, number, number][] = [];
    for (let k = 2; k <= n; k++) pts.push(toGraph(k, curve[k - 1]!, vMax));
    drawPolyline(curves[tracer], pts, CURVE_COLOUR[tracer]);
    const end = pts[pts.length - 1]!;
    curveLabels[tracer].position.set(end[0] + 0.02, end[1], 0);
  }
  setText(caption, `${n} paths per pixel`);
});

let fixedScale = 0;
function barScale(): number {
  if (fixedScale) return fixedScale;
  // Fit so the 95th-percentile pixel at N = 2 stands BAR_CAP / 2 tall.
  const sorted = Array.from(errors[1]!).sort((a, b) => a - b);
  fixedScale = BAR_CAP / 2 / Math.max(1e-6, sorted[Math.floor(sorted.length * 0.95)]!);
  return fixedScale;
}

stage.duration = HOLD_START + RAMP + HOLD;
stage.onReady(() => ready);
stage.start();

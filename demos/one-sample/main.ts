/**
 * SHOWS: one path per pixel, every pixel at once, and the noisy image that
 * makes. one-path followed a single pixel's ray to the light and back; this
 * is the same thing for the whole film in lockstep.
 *
 *   1. Every pixel's ray leaves together, one bounce per step, drawn dark:
 *      routes, nothing carried yet.
 *   2. The paths that landed on the lamp fill with colour from the lamp end,
 *      again one bounce per step, so a short path's pixel lights first.
 *   3. Paths that never found the lamp fade back once every ray is out (so
 *      the few that did can be seen), and their pixels stay black.
 *
 * What is left is a single sample per pixel: most of the film black, a
 * scatter of lit pixels. The counter says how many paths found the light.
 *
 * Two strategies (`strategy`, or ?strategy=aim in the URL):
 *
 *   wait  plain unidirectional path tracing, as in one-path: bounce by BSDF
 *         sampling and count the light only if a bounce happens to land on
 *         the lamp. Most never do.
 *   aim   pt-aim: bounce a random number of times N, then send one ray
 *         straight at a point on the lamp (drawn amber); if nothing blocks
 *         it, light comes back. Weighted by 1/pmf(N), it converges to the
 *         same image (tests/pt-aim.test.ts), and far more paths find light.
 *
 * Brightness is real: a pixel shows its sample's radiance at exposure 1 (the
 * true image is mostly 0.1 .. 0.7 here), clipped hue-preservingly at 1. So a
 * lucky wait-path that lands on the lamp shows as a saturated pixel (its
 * value is many times the true one) and an aimed path as an ordinary one.
 * Light along a path is the radiance leaving vertex k toward the eye on
 * segment k, C / beta_k with C the sample's value (estimator weight
 * removed); the aimed ray carries the lamp's own Le. Readability choice: the
 * LINES are drawn LINE_GAIN brighter than the film, and never dimmer than
 * LINE_FLOOR, keeping their hue. At true brightness the stretch back to the
 * eye carries the pixel's own value (0.1 .. 0.4 here), which on black reads
 * as a path that vanished while its pixel lit up. The film stays true.
 * `sample` draws a different set of paths.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { UnidirectionalPT } from '@/core/integrators/pt';
import { AimAtLightPT } from '@/core/integrators/pt-aim';
import { IndependentSampler } from '@/core/sampler/independent';
import { pixelSeedKey } from '@/core/sampler/sampler';
import { ArrayRecorder } from '@/trace/records';
import { sceneToThree } from '@/viz/three-scene';
import { ImagePlaneElement } from '@/viz/image-plane';
import { FilmPanel } from '@/viz/film-panel';
import { segments, setSegments } from '@/viz/lines';
import { lampOutline, lampColor, styleShortBox } from '@/viz/short-box';
import { srgbEncode } from '@/render/film';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
const PLANE_DISTANCE = 1.4; // as level-zero, one-path and pixel-grid
const INSET = { center: [-1.3, -0.42] as [number, number], height: 0.62 };
const MAX_BOUNCES = 8;
/** The paths before light travels them. */
const DARK = new THREE.Color(0x2a2f35);
/** The aimed ray before light comes back: a direction chosen on purpose. */
const AIMED = new THREE.Color(C.ochreDeep);
const LINE_GAIN = 4; // returning light, drawn brighter than the film (see header)
const LINE_FLOOR = 0.35; // and never dimmer than this, so a lit path stays visible
const BLANK = 18;
// Timing, seconds.
const OUT_STEP = 0.8; // one bounce, every path
const DEAD_OPACITY = 0.12; // unlit paths, once they have faded back
const AT_LIGHT = 1.0;
const BACK_STEP = 0.8; // one bounce back, every lit path
const HOLD = 3.0;

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });
const ui = createUI(stage);

const desc = SCENES[SCENE];
const sceneGroup = sceneToThree(desc);
stage.add(sceneGroup);
styleShortBox(stage.renderer, stage.scene, sceneGroup, desc);
const view = vizViewFor(SCENE);
stage.camera.position.set(...view.eye);
stage.controls?.target.set(...view.target);
stage.controls?.update();

const { Le } = lampColor(desc);
stage.add(lampOutline(desc));

const caption = label('', { size: 0.06, color: C.bone, anchorX: 'center', anchorY: 'top', position: [0, -0.8, 0] });
stage.hud.add(caption);

// Three sets: lit paths going out, unlit paths (which fade back), and the
// colour returning along lit paths.
const outLines = segments({ width: 2 });
const deadLines = segments({ width: 2, opacity: 0.999 });
const backLines = segments({ width: 5, toneMapped: false }); // computed colours, shown as they are
const planeGroup = new THREE.Group();
stage.add(outLines, deadLines, backLines, planeGroup);

// --- Controls --------------------------------------------------------------
type Strategy = 'wait' | 'aim';
const fromUrl = new URLSearchParams(location.search).get('strategy');
const params = { strategy: (fromUrl === 'aim' ? 'aim' : 'wait') as Strategy, grid: 16, sample: 0 };
ui.params.add(params, 'strategy', ['wait', 'aim']).onChange(trace);
ui.params.add(params, 'grid', 2, 32, 1).name('film resolution').onChange(trace);
ui.params.add(params, 'sample', 0, 63, 1).onChange(trace);

// --- The paths -------------------------------------------------------------
interface Path {
  pts: THREE.Vector3[]; // camera .. last vertex (on the lamp, if lit)
  lit: boolean;
  /** Index of the aimed segment (the shadow ray), or 0 if there is none. */
  aimed: number;
  /** Light on segment k (vertex k-1 to k), as displayed; [0] unused. */
  color: THREE.Color[];
  /** When this pixel's light arrives (lit) or the film completes (unlit). */
  revealAt: number;
}
let paths: Path[] = [];
let outEnd = 0;
let backStart = 0;
let litCount = 0;
let plane: ImagePlaneElement | null = null;
let inset: FilmPanel | null = null;
let insetPixels: Uint8ClampedArray | null = null;
let values = new Float32Array(0);

function trace(): void {
  const res = params.grid;
  const scene = buildScene(desc, res, res);
  const integrator = params.strategy === 'aim'
    ? new AimAtLightPT({ maxBounces: MAX_BOUNCES })
    : new UnidirectionalPT({ maxBounces: MAX_BOUNCES, rrStartDepth: 99, sampleNEE: false });
  const sampler = new IndependentSampler(0);
  paths = [];
  values = new Float32Array(res * res * 3);
  litCount = 0;
  let maxOut = 0;
  let maxBack = 0;

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const key = pixelSeedKey(x, y, params.sample);
      sampler.startPixelSample(key);
      const recorder = new ArrayRecorder();
      recorder.beginPath(key);
      integrator.sampleContributions([x, y], sampler, scene, recorder);
      recorder.endPath();
      const record = recorder.records[0]!;
      let vs = record.vertices;
      const C = new THREE.Color(0, 0, 0);
      for (const c of record.contributions) if (c.kind === 'sample') C.add(new THREE.Color(...c.value));
      const lit = C.r > 0 || C.g > 0 || C.b > 0;
      const weight = record.lengthDraw?.pmf ?? 1; // undo 1/pmf: show the light, not the estimator

      // The route: plain PT is cut where it lands on the lamp; an aimed path
      // ends with its shadow ray, at the lamp or at whatever blocked it.
      const hit = vs.findIndex((v, i) => i > 0 && v.primitiveName === 'light');
      if (hit > 0) vs = vs.slice(0, hit + 1);
      const pts = vs.map((v) => new THREE.Vector3(...v.p));
      const shadow = hit > 0 ? undefined : record.shadowRays[0];
      let aimed = 0;
      if (shadow) {
        pts.push(new THREE.Vector3(...(shadow.blockedAt ?? shadow.to)));
        aimed = pts.length - 1;
      }

      const n = pts.length - 1;
      const color: THREE.Color[] = [new THREE.Color()];
      if (lit) {
        litCount++;
        for (let k = 1; k <= n; k++) {
          if (k === aimed || k > vs.length - 1) {
            color.push(lineDisplay(Le.clone()));
            continue;
          }
          const bk = vs[k]!.beta;
          const ch = (v: number, b: number) => (b > 0 ? (v * weight) / b : 0);
          color.push(lineDisplay(new THREE.Color(ch(C.r, bk[0]), ch(C.g, bk[1]), ch(C.b, bk[2]))));
        }
        const shown = display(C.clone());
        const p = (y * res + x) * 3;
        values[p] = shown.r;
        values[p + 1] = shown.g;
        values[p + 2] = shown.b;
        maxBack = Math.max(maxBack, n);
      }
      maxOut = Math.max(maxOut, n);
      paths.push({ pts, lit, aimed, color, revealAt: 0 });
    }
  }

  outEnd = maxOut * OUT_STEP;
  backStart = outEnd + AT_LIGHT;
  const backEnd = backStart + maxBack * BACK_STEP;
  for (const p of paths) p.revealAt = p.lit ? backStart + (p.pts.length - 1) * BACK_STEP : backEnd;

  plane?.dispose();
  plane = new ImagePlaneElement(
    {
      camera: desc.camera,
      distance: PLANE_DISTANCE,
      res,
      samples: 1,
      dwell: Infinity,
      cumulative: values,
      highlight: null,
      revealAt: Float32Array.from(paths, (p) => p.revealAt),
    },
    planeGroup,
  );
  if (!inset || inset.width !== res) {
    inset?.dispose();
    inset = new FilmPanel({ width: res, height: res, center: INSET.center, drawnHeight: INSET.height });
    insetPixels = new Uint8ClampedArray(res * res * 4);
    stage.hud.add(inset.group);
  }
  shownRevealed = -1;
  stage.duration = backEnd + HOLD;
  stage.t = 0;
}

/** Radiance at exposure 1, clipped at 1 without changing its hue. */
function display(c: THREE.Color): THREE.Color {
  const m = Math.max(c.r, c.g, c.b);
  return m > 1 ? c.multiplyScalar(1 / m) : c;
}

/** Returning light on a line: LINE_GAIN brighter, at least LINE_FLOOR, same hue. */
function lineDisplay(c: THREE.Color): THREE.Color {
  c.multiplyScalar(LINE_GAIN);
  const m = Math.max(c.r, c.g, c.b);
  if (m > 1) return c.multiplyScalar(1 / m);
  if (m > 0 && m < LINE_FLOOR) return c.multiplyScalar(LINE_FLOOR / m);
  return c;
}

let shownRevealed = -1;
function paintInset(t: number): void {
  if (!inset || !insetPixels) return;
  let revealed = 0;
  for (const p of paths) if (t >= p.revealAt) revealed++;
  if (revealed === shownRevealed) return;
  shownRevealed = revealed;
  paths.forEach((p, i) => {
    const o = i * 4;
    const on = t >= p.revealAt;
    insetPixels![o] = on ? srgbEncode(values[i * 3]!) : BLANK;
    insetPixels![o + 1] = on ? srgbEncode(values[i * 3 + 1]!) : BLANK;
    insetPixels![o + 2] = on ? srgbEncode(values[i * 3 + 2]!) : BLANK;
    insetPixels![o + 3] = 255;
  });
  inset.update(insetPixels);
}

const clamp01 = (u: number) => Math.min(1, Math.max(0, u));

stage.frame((t) => {
  plane?.drawAt(t);
  paintInset(t);

  const outPos: number[] = [];
  const outCol: number[] = [];
  const deadPos: number[] = [];
  const deadCol: number[] = [];
  const backPos: number[] = [];
  const backCol: number[] = [];
  const push = (pos: number[], col: number[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Color) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
  };

  for (const p of paths) {
    const n = p.pts.length - 1;
    for (let k = 1; k <= n; k++) {
      const a = p.pts[k - 1]!;
      const b = p.pts[k]!;
      // Outgoing: step k grows segment k of every path at once.
      const u = clamp01((t - (k - 1) * OUT_STEP) / OUT_STEP);
      if (u <= 0) continue;
      // Returning (lit only): segment k fills from vertex k back to k-1 at
      // step n - k + 1, counted from the lamp.
      const v = p.lit ? clamp01((t - backStart - (n - k) * BACK_STEP) / BACK_STEP) : 0;
      const front = b.clone().lerp(a, v);
      const dark = k === p.aimed ? AIMED : DARK;
      if (v < 1) push(p.lit ? outPos : deadPos, p.lit ? outCol : deadCol, a, v > 0 ? front : a.clone().lerp(b, u), dark);
      if (v > 0) push(backPos, backCol, b, front, p.color[k]!);
    }
  }
  setSegments(outLines, new Float32Array(outPos), new Float32Array(outCol));
  setSegments(deadLines, new Float32Array(deadPos), new Float32Array(deadCol));
  deadLines.material.opacity = 1 - (1 - DEAD_OPACITY) * clamp01((t - outEnd) / AT_LIGHT);
  setSegments(backLines, new Float32Array(backPos), new Float32Array(backCol));

  const step = Math.min(Math.ceil(t / OUT_STEP), Math.round(outEnd / OUT_STEP));
  setText(
    caption,
    t < outEnd ? `${paths.length} paths · bounce ${Math.max(1, step)}` : `${litCount} of ${paths.length} paths found the light`,
  );
});

stage.start();
trace();

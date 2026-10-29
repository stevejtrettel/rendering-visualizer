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
 * Every path is a real sample of plain unidirectional path tracing (BSDF
 * sampling only, as in one-path), cut at the lamp. Colours follow one-path's
 * rule, Le * beta_n / beta_k from the walk's recorded throughputs, shown
 * relative to the lamp's brightest channel; a pixel shows Le * beta_n on the
 * same scale. `sample` draws a different set of paths.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { UnidirectionalPT } from '@/core/integrators/pt';
import { IndependentSampler } from '@/core/sampler/independent';
import { pixelSeedKey } from '@/core/sampler/sampler';
import { ArrayRecorder } from '@/trace/records';
import { sceneToThree } from '@/viz/three-scene';
import { ImagePlaneElement } from '@/viz/image-plane';
import { FilmPanel } from '@/viz/film-panel';
import { segments, setSegments } from '@/viz/lines';
import { lampOutline, lampColor, translucent } from '@/viz/short-box';
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
translucent(sceneGroup, desc, 'right');
const view = vizViewFor(SCENE);
stage.camera.position.set(...view.eye);
stage.controls?.target.set(...view.target);
stage.controls?.update();

const { Le, relative } = lampColor(desc);
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
const params = { grid: 16, sample: 0 };
ui.params.add(params, 'grid', 2, 32, 1).name('film resolution').onChange(trace);
ui.params.add(params, 'sample', 0, 63, 1).onChange(trace);

// --- The paths -------------------------------------------------------------
interface Path {
  pts: THREE.Vector3[]; // camera .. last vertex (on the lamp, if lit)
  lit: boolean;
  /** Colour on segment k (vertex k-1 to k), relative to the lamp; [0] unused. */
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
  const integrator = new UnidirectionalPT({ maxBounces: MAX_BOUNCES, rrStartDepth: 99, sampleNEE: false });
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
      let vs = recorder.records[0]!.vertices;
      const hit = vs.findIndex((v, i) => i > 0 && v.primitiveName === 'light');
      const lit = hit > 0;
      if (lit) vs = vs.slice(0, hit + 1);
      const n = vs.length - 1;
      const color: THREE.Color[] = [new THREE.Color()];
      if (lit) {
        litCount++;
        const bn = vs[n]!.beta;
        for (let k = 1; k <= n; k++) {
          const bk = vs[k]!.beta;
          const ch = (i: 0 | 1 | 2) => (bk[i] > 0 ? bn[i] / bk[i] : 0);
          color.push(new THREE.Color(
            Math.min(1, relative.r * ch(0)),
            Math.min(1, relative.g * ch(1)),
            Math.min(1, relative.b * ch(2)),
          ));
        }
        const p = (y * res + x) * 3;
        values[p] = color[1]!.r;
        values[p + 1] = color[1]!.g;
        values[p + 2] = color[1]!.b;
        maxBack = Math.max(maxBack, n);
      }
      maxOut = Math.max(maxOut, n);
      paths.push({ pts: vs.map((v) => new THREE.Vector3(...v.p)), lit, color, revealAt: 0 });
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
      if (v < 1) push(p.lit ? outPos : deadPos, p.lit ? outCol : deadCol, a, v > 0 ? front : a.clone().lerp(b, u), DARK);
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

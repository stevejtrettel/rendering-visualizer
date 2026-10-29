/**
 * SHOWS: many single-sample images added up. one-sample made one noisy
 * image, one path per pixel; this makes that image again and again, each
 * time with fresh paths, and averages them.
 *
 * Each pass is one-sample in miniature, on the same box and camera:
 *
 *   1. every pixel's path goes out, drawn dark;
 *   2. light comes back along the paths that reached the lamp, and each
 *      pixel of the partial image lights as its light arrives, both on the
 *      film in the scene and on a copy hovering above the running image;
 *   3. the copy drops into the running image, which becomes the average of
 *      every pass so far.
 *
 * The first passes are slow enough to follow; then they speed up, and the
 * average visibly settles while each new partial image stays just as noisy.
 * The figure ramps to the average of all SAMPLES passes and holds it.
 *
 * The tracer is pt-aim, as on the slide before (one-sample ?strategy=aim):
 * bounce a random number of times, then send one ray at the lamp. Pass s is
 * that tracer's sample s for every pixel, so the running image is exactly
 * the estimator's running mean. Brightness, line colours and readability
 * choices are one-sample's (see its header): film at exposure 1, clipped
 * hue-preservingly; lines LINE_GAIN brighter with a floor.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { AimAtLightPT } from '@/core/integrators/pt-aim';
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
const PLANE_DISTANCE = 1.4; // as level-zero, one-path and one-sample
/** The running image, and the partial image hovering above it. */
const INSET = { center: [-1.3, -0.55] as [number, number], height: 0.6 };
const RISE = 0.8; // how far above the running image a partial image hovers
const MAX_BOUNCES = 8;
const SAMPLES = 64;
const DARK = new THREE.Color(0x2a2f35);
const AIMED = new THREE.Color(C.ochreDeep);
const LINE_GAIN = 4;
const LINE_FLOOR = 0.35;
const BLANK = 18;
const DEAD_OPACITY = 0.12;
// Pacing, seconds: the first pass takes FIRST, each next one SPEEDUP of the
// one before, down to FASTEST.
const FIRST = 7;
const SPEEDUP = 0.6;
const FASTEST = 0.35;
const HOLD = 3;
// Beats within a pass, as fractions of it.
const OUT_END = 0.3; // every path is out
const BACK_START = 0.38; // light starts back from the lamp
const BACK_END = 0.66; // and has reached every lit pixel
const DROP_START = 0.72;
const DROP_LAND = 0.92; // merged: the running image now includes this pass

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

const { Le } = lampColor(desc);
stage.add(lampOutline(desc));

const caption = label('', { size: 0.06, color: C.bone, anchorX: 'center', anchorY: 'top', position: [0, -0.8, 0] });
stage.hud.add(caption);

const outLines = segments({ width: 2, opacity: 0.999 });
const deadLines = segments({ width: 2, opacity: 0.999 });
const backLines = segments({ width: 5, opacity: 0.999, toneMapped: false });
const planeGroup = new THREE.Group();
stage.add(outLines, deadLines, backLines, planeGroup);

// --- Controls --------------------------------------------------------------
const params = { grid: 16 };
ui.params.add(params, 'grid', 2, 32, 1).name('film resolution').onChange(trace);

// --- The passes ------------------------------------------------------------
interface Path {
  pts: THREE.Vector3[];
  lit: boolean;
  aimed: number;
  color: THREE.Color[];
}
interface Pass {
  start: number;
  length: number;
  paths: Path[];
  maxOut: number;
  maxBack: number;
  /** This pass's image as shown: radiance at exposure 1, clipped. */
  shown: Float32Array;
}
let passes: Pass[] = [];
/** Running sums of the raw values over passes: sums[s] = passes 0..s. */
let sums: Float32Array[] = [];
let res = 0;

function trace(): void {
  res = params.grid;
  const scene = buildScene(desc, res, res);
  const integrator = new AimAtLightPT({ maxBounces: MAX_BOUNCES });
  const sampler = new IndependentSampler(0);
  passes = [];
  sums = [];
  let start = 0;
  const running = new Float32Array(res * res * 3);

  for (let s = 0; s < SAMPLES; s++) {
    const paths: Path[] = [];
    const shown = new Float32Array(res * res * 3);
    let maxOut = 0;
    let maxBack = 0;
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const key = pixelSeedKey(x, y, s);
        sampler.startPixelSample(key);
        const recorder = new ArrayRecorder();
        recorder.beginPath(key);
        integrator.sampleContributions([x, y], sampler, scene, recorder);
        recorder.endPath();
        const record = recorder.records[0]!;
        let vs = record.vertices;
        const value = new THREE.Color(0, 0, 0);
        for (const c of record.contributions) if (c.kind === 'sample') value.add(new THREE.Color(...c.value));
        const lit = value.r > 0 || value.g > 0 || value.b > 0;
        const weight = record.lengthDraw?.pmf ?? 1;

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
        const p = (y * res + x) * 3;
        if (lit) {
          for (let k = 1; k <= n; k++) {
            if (k === aimed || k > vs.length - 1) {
              color.push(lineDisplay(Le.clone()));
              continue;
            }
            const bk = vs[k]!.beta;
            const ch = (v: number, b: number) => (b > 0 ? (v * weight) / b : 0);
            color.push(lineDisplay(new THREE.Color(ch(value.r, bk[0]), ch(value.g, bk[1]), ch(value.b, bk[2]))));
          }
          const d = display(value.clone());
          shown[p] = d.r;
          shown[p + 1] = d.g;
          shown[p + 2] = d.b;
          running[p]! += value.r;
          running[p + 1]! += value.g;
          running[p + 2]! += value.b;
          maxBack = Math.max(maxBack, n);
        }
        maxOut = Math.max(maxOut, n);
        paths.push({ pts, lit, aimed, color });
      }
    }
    const length = Math.max(FASTEST, FIRST * SPEEDUP ** s);
    passes.push({ start, length, paths, maxOut, maxBack, shown });
    sums.push(running.slice());
    start += length;
  }

  if (!inset || inset.width !== res) {
    inset?.dispose();
    tile?.dispose();
    inset = new FilmPanel({ width: res, height: res, center: INSET.center, drawnHeight: INSET.height });
    tile = new FilmPanel({ width: res, height: res, center: INSET.center, drawnHeight: INSET.height, opacity: 0.999 });
    insetPixels = new Uint8ClampedArray(res * res * 4);
    tilePixels = new Uint8ClampedArray(res * res * 4);
    stage.hud.add(inset.group, tile.group);
  }
  shownPass = -1;
  shownAverage = -2;
  shownTile = '';
  stage.duration = start + HOLD;
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

// --- Timing within a pass --------------------------------------------------
/** Seconds into the pass at which light reaches this path's pixel (Infinity if it never does). */
function revealAt(pass: Pass, path: Path): number {
  if (!path.lit) return Infinity;
  const backStep = ((BACK_END - BACK_START) * pass.length) / Math.max(1, pass.maxBack);
  return BACK_START * pass.length + (path.pts.length - 1) * backStep;
}

function passAt(t: number): number {
  let s = 0;
  while (s < passes.length - 1 && t >= passes[s + 1]!.start) s++;
  return s;
}

// --- Drawing ---------------------------------------------------------------
let inset: FilmPanel | null = null;
let tile: FilmPanel | null = null;
let insetPixels: Uint8ClampedArray | null = null;
let tilePixels: Uint8ClampedArray | null = null;
let plane: ImagePlaneElement | null = null;
let shownPass = -1;
let shownAverage = -2;
let shownTile = '';

function fill(out: Uint8ClampedArray, rgb: (i: number) => [number, number, number] | null): void {
  for (let i = 0; i < res * res; i++) {
    const c = rgb(i);
    const o = i * 4;
    out[o] = c ? srgbEncode(c[0]) : BLANK;
    out[o + 1] = c ? srgbEncode(c[1]) : BLANK;
    out[o + 2] = c ? srgbEncode(c[2]) : BLANK;
    out[o + 3] = 255;
  }
}

/** The running image: the mean of passes 0..landed, or blank before the first lands. */
function paintAverage(landed: number): void {
  if (landed === shownAverage || !inset || !insetPixels) return;
  shownAverage = landed;
  const mean = landed >= 0 ? averageShown(landed) : null;
  fill(insetPixels, (i) => (mean ? [mean[i * 3]!, mean[i * 3 + 1]!, mean[i * 3 + 2]!] : null));
  inset.update(insetPixels);
}

/** The partial image hovering above: pixels light as their light arrives. */
function paintTile(s: number, local: number): void {
  if (!tile || !tilePixels) return;
  const pass = passes[s]!;
  let revealed = 0;
  for (const p of pass.paths) if (local >= revealAt(pass, p)) revealed++;
  const key = `${s}/${revealed}`;
  if (key === shownTile) return;
  shownTile = key;
  fill(tilePixels, (i) =>
    local >= revealAt(pass, pass.paths[i]!) ? [pass.shown[i * 3]!, pass.shown[i * 3 + 1]!, pass.shown[i * 3 + 2]!] : null,
  );
  tile.update(tilePixels);
}

/**
 * The film in the scene shows the pass being made, revealing as one-sample's
 * does; once every pass is in (key = passes.length), the finished average.
 */
function ensurePlane(key: number): void {
  if (key === shownPass) return;
  shownPass = key;
  const pass = passes[key];
  const config = pass
    ? { cumulative: pass.shown, revealAt: Float32Array.from(pass.paths, (p) => pass.start + revealAt(pass, p)) }
    : { cumulative: averageShown(passes.length - 1) };
  plane?.dispose();
  plane = new ImagePlaneElement(
    { camera: desc.camera, distance: PLANE_DISTANCE, res, samples: 1, dwell: Infinity, highlight: null, ...config },
    planeGroup,
  );
}

/** The mean of passes 0..landed as shown: exposure 1, clipped. */
function averageShown(landed: number): Float32Array {
  const sum = sums[landed]!;
  const out = new Float32Array(res * res * 3);
  for (let i = 0; i < res * res; i++) {
    const c = display(new THREE.Color(sum[i * 3]!, sum[i * 3 + 1]!, sum[i * 3 + 2]!).multiplyScalar(1 / (landed + 1)));
    out[i * 3] = c.r;
    out[i * 3 + 1] = c.g;
    out[i * 3 + 2] = c.b;
  }
  return out;
}

const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
const tileMaterial = () => (tile!.group.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;

stage.frame((t) => {
  if (!passes.length) return;
  const s = passAt(t);
  const pass = passes[s]!;
  const local = t - pass.start;
  const u = local / pass.length;
  const done = t >= pass.start + pass.length; // past the last pass: holding

  ensurePlane(done ? passes.length : s);
  plane!.drawAt(t);
  paintTile(s, local);
  paintAverage(done || u >= DROP_LAND ? s : s - 1);

  // The partial image hovers, falls in, and dissolves as it lands.
  const p = clamp01((u - DROP_START) / (DROP_LAND - DROP_START));
  tile!.group.visible = !done && u < DROP_LAND;
  tile!.group.position.set(INSET.center[0], INSET.center[1] + RISE * (1 - p * p), 0.01);
  tileMaterial().opacity = p < 0.7 ? 0.999 : Math.max(0, 1 - (p - 0.7) / 0.3);

  // The paths of this pass: out dark, light back from the lamp, then gone.
  const outStep = (OUT_END * pass.length) / Math.max(1, pass.maxOut);
  const backStep = ((BACK_END - BACK_START) * pass.length) / Math.max(1, pass.maxBack);
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
  if (!done) {
    for (const path of pass.paths) {
      const n = path.pts.length - 1;
      for (let k = 1; k <= n; k++) {
        const a = path.pts[k - 1]!;
        const b = path.pts[k]!;
        const w = clamp01((local - (k - 1) * outStep) / outStep);
        if (w <= 0) continue;
        const v = path.lit ? clamp01((local - BACK_START * pass.length - (n - k) * backStep) / backStep) : 0;
        const front = b.clone().lerp(a, v);
        const dark = k === path.aimed ? AIMED : DARK;
        if (v < 1) push(path.lit ? outPos : deadPos, path.lit ? outCol : deadCol, a, v > 0 ? front : a.clone().lerp(b, w), dark);
        if (v > 0) push(backPos, backCol, b, front, path.color[k]!);
      }
    }
  }
  setSegments(outLines, new Float32Array(outPos), new Float32Array(outCol));
  setSegments(deadLines, new Float32Array(deadPos), new Float32Array(deadCol));
  setSegments(backLines, new Float32Array(backPos), new Float32Array(backCol));
  const fade = 1 - clamp01((u - DROP_START) / (1 - DROP_START));
  outLines.material.opacity = 0.999 * fade;
  backLines.material.opacity = 0.999 * fade;
  deadLines.material.opacity = fade * (1 - (1 - DEAD_OPACITY) * clamp01((u - OUT_END) / (BACK_START - OUT_END)));

  const landed = done || u >= DROP_LAND ? s + 1 : s;
  setText(caption, landed === 0 ? '' : landed === 1 ? '1 path per pixel' : `${landed} paths per pixel, averaged`);
});

stage.start();
trace();

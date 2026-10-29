/**
 * SHOWS: many single-sample images added up. one-sample made one noisy
 * image, one path per pixel; this makes that image again and again, each
 * time with fresh paths, and averages them.
 *
 * Laid out as the slides before it (screen-layout.ts): the running image is
 * the screen at the left, the box at the right with the camera's eye, plane
 * and frustum, 64 x 64 pixels. Each pass happens in one shot: its lit paths
 * appear in their colours (no dark stage: one-path and one-sample, the
 * slides before, walked a pass step by step already), its partial image
 * appears small between the screen and the scene, then flies onto the
 * screen and merges into the running image, which becomes the average of
 * every pass so far. The first
 * passes take FIRST seconds or so; then they speed up, and the average
 * visibly settles while each new partial image stays just as noisy. The
 * figure ramps to the average of all SAMPLES passes and holds it.
 *
 * Every lit path stays, faintly: a pass's paths sink into a haze that the
 * next pass adds to, so the room fills with the light paths being averaged.
 * With N passes in, each path in the haze is drawn at opacity HAZE_C / N
 * (capped at HAZE_MAX): the weight it has in the average. So the haze does
 * not pile up into a white-out; like the image, it smooths out. (The haze
 * writes no depth, or faint lines in front would hide the ones behind and
 * it could never build up.) Steve, 2026-10-29, on the earlier version that
 * redrew every path dark-then-coloured each pass: "less flash-bangy".
 *
 * Readability choice: every pixel's path is traced and averaged, but only
 * the paths of a fixed scattered subset of DRAWN pixels are drawn in the
 * scene (the same pixels every pass). At 64 x 64 a pass is 4096 paths, and
 * 64 passes of them would bury the room.
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
import { NULL_RECORDER } from '@/trace/recorder';
import { sceneToThree } from '@/viz/three-scene';
import { screenLayout, SCREEN, BLANK } from '@/viz/screen-layout';
import { FilmPanel } from '@/viz/film-panel';
import { segments, setSegments } from '@/viz/lines';
import { lampOutline, lampColor, styleShortBox } from '@/viz/short-box';
import { srgbEncode } from '@/render/film';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
/** Where a pass's partial image appears before flying onto the screen: HUD centre, and size relative to the screen. */
const TILE = { center: [-0.02, 0.33] as [number, number], scale: 0.3 };
const DRAWN = 256; // pixels whose paths are drawn (see header)
const MAX_BOUNCES = 8;
const SAMPLES = 64;
const LINE_GAIN = 4;
const LINE_FLOOR = 0.35;
const HAZE_C = 1.0; // a haze path's opacity with N passes in: HAZE_C / N ...
const HAZE_MAX = 0.35; // ... at most this
const HAZE_WIDTH = 2;
const FRESH = 0.7; // a pass's paths as they appear
// Pacing, seconds: the first pass takes FIRST, each next one SPEEDUP of the
// one before, down to FASTEST.
const FIRST = 1.6;
const SPEEDUP = 0.8;
const FASTEST = 0.35;
const HOLD = 3;
// Beats within a pass, as fractions of it.
const APPEAR = 0.2; // paths and partial image have faded in
const DROP_START = 0.6;
const DROP_LAND = 0.92; // merged: the running image now includes this pass

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
const layout = screenLayout(stage, desc.camera, new THREE.Vector3(0, 4.35, 0));

const { Le } = lampColor(desc);
stage.add(lampOutline(desc));

const caption = label('', { size: 0.06, color: C.bone, anchorX: 'center', anchorY: 'top', position: [0, -0.8, 0] });
stage.hud.add(caption);

const freshLines = segments({ width: HAZE_WIDTH, opacity: 0.999, toneMapped: false });
const hazeLines = segments({ width: HAZE_WIDTH, opacity: 0.999, toneMapped: false });
for (const lines of [hazeLines, freshLines]) lines.material.depthWrite = false;
const hazeOpacity = (n: number) => Math.min(HAZE_MAX, HAZE_C / Math.max(1, n));
stage.add(hazeLines, freshLines);

// --- Controls --------------------------------------------------------------
const params = { grid: 64 };
ui.params.add(params, 'grid', 2, 64, 1).name('film resolution').onChange(trace);

// --- The passes ------------------------------------------------------------
interface Pass {
  start: number;
  length: number;
  /** This pass's image as shown: radiance at exposure 1, clipped. */
  shown: Float32Array;
  /** Every segment of its lit paths, in their colours: 6 numbers each. */
  litPos: Float32Array;
  litCol: Float32Array;
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
  // The drawn pixels: every pixel up to DRAWN of them, else a fixed scatter.
  const drawn = new Uint8Array(res * res);
  if (res * res <= DRAWN) drawn.fill(1);
  else {
    const scramble = (i: number) => (Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) >>> 0) / 4294967296;
    const byHash = Array.from({ length: res * res }, (_, i) => i).sort((a, b) => scramble(a) - scramble(b));
    for (const i of byHash.slice(0, DRAWN)) drawn[i] = 1;
  }

  for (let s = 0; s < SAMPLES; s++) {
    const shown = new Float32Array(res * res * 3);
    const litPos: number[] = [];
    const litCol: number[] = [];
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const key = pixelSeedKey(x, y, s);
        sampler.startPixelSample(key);
        const p = (y * res + x) * 3;
        if (!drawn[y * res + x]) {
          // Not drawn: its value only.
          const value = new THREE.Color(0, 0, 0);
          for (const c of integrator.sampleContributions([x, y], sampler, scene, NULL_RECORDER)) {
            if (c.kind === 'sample') value.add(new THREE.Color(c.value.r, c.value.g, c.value.b));
          }
          const d = display(value.clone());
          shown[p] = d.r;
          shown[p + 1] = d.g;
          shown[p + 2] = d.b;
          running[p]! += value.r;
          running[p + 1]! += value.g;
          running[p + 2]! += value.b;
          continue;
        }
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

        if (!lit) continue;
        // Light on segment k (vertex k-1 to k), as one-sample draws it.
        for (let k = 1; k < pts.length; k++) {
          let c: THREE.Color;
          if (k === aimed || k > vs.length - 1) {
            c = lineDisplay(Le.clone());
          } else {
            const bk = vs[k]!.beta;
            const ch = (v: number, b: number) => (b > 0 ? (v * weight) / b : 0);
            c = lineDisplay(new THREE.Color(ch(value.r, bk[0]), ch(value.g, bk[1]), ch(value.b, bk[2])));
          }
          const a = pts[k - 1]!;
          const b = pts[k]!;
          litPos.push(a.x, a.y, a.z, b.x, b.y, b.z);
          litCol.push(c.r, c.g, c.b, c.r, c.g, c.b);
        }
        const d = display(value.clone());
        shown[p] = d.r;
        shown[p + 1] = d.g;
        shown[p + 2] = d.b;
        running[p]! += value.r;
        running[p + 1]! += value.g;
        running[p + 2]! += value.b;
      }
    }
    const length = Math.max(FASTEST, FIRST * SPEEDUP ** s);
    passes.push({ start, length, shown, litPos: new Float32Array(litPos), litCol: new Float32Array(litCol) });
    sums.push(running.slice());
    start += length;
  }

  if (!inset || inset.width !== res) {
    inset?.dispose();
    tile?.dispose();
    inset = new FilmPanel({ width: res, height: res, center: SCREEN.center, drawnHeight: SCREEN.height, border: false });
    tile = new FilmPanel({ width: res, height: res, drawnHeight: SCREEN.height, opacity: 0.999 });
    insetPixels = new Uint8ClampedArray(res * res * 4);
    tilePixels = new Uint8ClampedArray(res * res * 4);
    stage.hud.add(inset.group, tile.group);
    layout.drawGrid(res);
  }
  shownAverage = -2;
  shownTile = -1;
  shownHaze = -1;
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
let shownAverage = -2;
let shownTile = -1;
let shownHaze = -1;

/** The haze: every lit path of passes 0 .. upTo-1. */
function paintHaze(upTo: number): void {
  if (upTo === shownHaze) return;
  shownHaze = upTo;
  let n = 0;
  for (let i = 0; i < upTo; i++) n += passes[i]!.litPos.length;
  const pos = new Float32Array(n);
  const col = new Float32Array(n);
  let o = 0;
  for (let i = 0; i < upTo; i++) {
    pos.set(passes[i]!.litPos, o);
    col.set(passes[i]!.litCol, o);
    o += passes[i]!.litPos.length;
  }
  setSegments(hazeLines, pos, col);
  hazeLines.material.opacity = hazeOpacity(upTo);
}

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

/** A pass's partial image, on its way to the screen. */
function paintTile(s: number): void {
  if (s === shownTile || !tile || !tilePixels) return;
  shownTile = s;
  const { shown } = passes[s]!;
  fill(tilePixels, (i) => [shown[i * 3]!, shown[i * 3 + 1]!, shown[i * 3 + 2]!]);
  tile.update(tilePixels);
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
  const u = (t - pass.start) / pass.length;
  const done = t >= pass.start + pass.length; // past the last pass: holding
  const averaged = done || u >= DROP_LAND ? s : s - 1;

  layout.update();
  paintTile(s);
  paintAverage(averaged);
  paintHaze(done ? passes.length : s);

  // The partial image fades in small beside the screen, flies onto it,
  // growing to its size, and dissolves into the running image as it lands.
  const p = clamp01((u - DROP_START) / (DROP_LAND - DROP_START));
  const e = p * p * (3 - 2 * p);
  tile!.group.visible = !done && u < DROP_LAND;
  tile!.group.position.set(
    TILE.center[0] + (SCREEN.center[0] - TILE.center[0]) * e,
    TILE.center[1] + (SCREEN.center[1] - TILE.center[1]) * e,
    0.05,
  );
  tile!.group.scale.setScalar(TILE.scale + (1 - TILE.scale) * e);
  tileMaterial().opacity = clamp01(u / APPEAR) * (p < 0.7 ? 0.999 : Math.max(0, 1 - (p - 0.7) / 0.3));
  // Under a landed image the grid lines give way, as on the slides before.
  layout.gridLines.material.opacity = averaged >= 0 ? Math.min(1, 24 / res) : 0.999;

  // The pass's lit paths appear in colour and sink into the haze.
  if (done) {
    freshLines.visible = false;
  } else {
    setSegments(freshLines, pass.litPos, pass.litCol);
    const haze = hazeOpacity(s + 1);
    freshLines.material.opacity = u < APPEAR ? FRESH * (u / APPEAR) : FRESH + (haze - FRESH) * ((u - APPEAR) / (1 - APPEAR));
  }

  const landed = averaged + 1;
  setText(caption, landed === 0 ? '' : landed === 1 ? '1 path per pixel' : `${landed} paths per pixel, averaged`);
});

stage.start();
trace();

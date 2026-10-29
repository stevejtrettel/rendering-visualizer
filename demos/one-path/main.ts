/**
 * SHOWS: one path, all the way. The layout of the slides before it (rasterize
 * and its shaded and traced versions): the screen square-on at the left, the
 * short open box at the right with the camera's eye, image plane and
 * frustum in front of it, 64 x 64 pixels. But now a single pixel's ray does
 * not stop at its first hit: it bounces, segment by segment, until it lands on the lamp. Then light
 * comes back down the same path: it leaves the lamp in the lamp's colour,
 * and at every bounce it is multiplied by exactly the factor the path tracer
 * applied there, until it reaches the eye and the pixel takes what arrived.
 *
 * Nothing here is drawn by hand. The path is a real sample of plain
 * unidirectional path tracing (BSDF sampling only, no light sampling), so
 * the only way it finds the light is to hit it. The colour on each segment is
 *
 *     Le * beta_n / beta_k        (per channel)
 *
 * where beta_k is the walk's recorded throughput arriving at vertex k and
 * vertex n is on the lamp: the light that has scattered off vertices
 * k .. n-1 on its way back. On segment 1 it is Le * beta_n, which is exactly
 * the contribution the tracer adds to the pixel. For a Lambertian wall the
 * factor is the wall's albedo; for the glossy blue ball it is f cos / pdf.
 *
 * Readability choice: colours are shown relative to the lamp, i.e. divided by
 * the lamp's brightest channel, so the light leaves the lamp near white and
 * each bounce visibly darkens and tints it. The pixel shows the same scaled
 * value.
 *
 * Which path: the search runs pixel by pixel, sample by sample, and keeps
 * paths that reach the lamp in 2..5 bounces after touching a coloured wall,
 * so the tint is visible. They are ranked by how bright the light is when it
 * reaches the pixel, so the default (path 0) is one whose result can be seen:
 * red-then-green nearly cancels, honestly, and sinks down the list. `path`
 * steps through the ranking.
 *
 * Before the light comes back, the path is drawn dark: it is a route, not
 * yet carrying anything. It fills with colour from the lamp end.
 *
 * Click a pixel of the screen to throw a path from THAT pixel: its own
 * samples are traced until PIXEL_POOL reach the lamp, those with at least
 * two bounces are ranked by brightness (the slide is about bouncing), and
 * one is drawn from the ranking at random, favouring the bright end but
 * reaching anywhere in it (index = floor(len * u^2)). Taking the brightest
 * outright always gave the shortest allowed path; this shows longer ones
 * too. The draw is a hash of the pixel and the click count, so clicking the
 * same cell again throws another path. If none of PIXEL_SAMPLES reach the
 * lamp, its first sample is shown as it is, dark, and the pixel stays
 * black: most paths find nothing.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { UnidirectionalPT } from '@/core/integrators/pt';
import { IndependentSampler } from '@/core/sampler/independent';
import { pixelSeedKey } from '@/core/sampler/sampler';
import { ArrayRecorder, type VertexRecord } from '@/trace/records';
import { sceneToThree } from '@/viz/three-scene';
import { imagePlaneFrame } from '@/viz/image-plane';
import { cellOnPlane, cellInPanel } from '@/viz/film-cell';
import { FilmPanel } from '@/viz/film-panel';
import { polyline, segments, setPolyline, setSegments } from '@/viz/lines';
import { srgbEncode } from '@/render/film';
import { label, setText } from '@/viz/text';
import { ASPECT } from '@/viz/stage';
import { lampOutline, lampColor, styleShortBox } from '@/viz/short-box';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
// Layout as rasterize: the screen on the HUD, the 3D view slid right, the
// plane out at PLANE_DISTANCE.
const PLANE_DISTANCE = 3;
const SCREEN = { center: [-0.85, -0.13] as [number, number], height: 1.15 };
const SHIFT = -0.25;
const FAR = 9.5; // how far the frustum edges are drawn, from the eye
const BLANK = 18;
const MAX_BOUNCES = 8;
const SEARCH_SAMPLES = 400; // per pixel
const MAX_CANDIDATES = 24; // shown, after ranking
const SEARCH_POOL = 240; // gathered before ranking
const PIXEL_SAMPLES = 4000; // tried for a clicked pixel
const PIXEL_POOL = 16; // lit paths gathered for a clicked pixel before choosing
/** The path before light travels it: a route, nothing carried yet. */
const DARK = 0x2a2f35;
const COLORED = new Set(['left', 'right']); // the red and green walls
// Timing, seconds.
const GROW = 1.0; // one outgoing segment
const AT_VERTEX = 0.45; // pause at each bounce
const AT_LIGHT = 1.4; // the hit
const BACK = 1.0; // one returning segment
const TINT = 0.6; // pause where the colour changes
const AT_PIXEL = 1.0;
const HOLD = 3.0;

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });
const ui = createUI(stage);

const desc = SCENES[SCENE];
const sceneGroup = sceneToThree(desc);
stage.add(sceneGroup);
// The near side wall (green, the one the view looks across) is drawn
// translucent, still green, so a path that goes behind it stays visible.
styleShortBox(stage.renderer, stage.scene, sceneGroup, desc);
const view = vizViewFor(SCENE);
stage.camera.position.set(...view.eye);
stage.controls?.target.set(...view.target);
stage.controls?.update();
stage.shiftView(SHIFT);

// The camera: eye, plane outline, frustum edges (as rasterize).
const frame = imagePlaneFrame(desc.camera, PLANE_DISTANCE);
const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) =>
  frame.center.clone().addScaledVector(frame.right, x! * frame.halfW).addScaledVector(frame.up, y! * frame.halfH),
);
const eyeDot = new THREE.Mesh(
  new THREE.SphereGeometry(0.08, 20, 12),
  new THREE.MeshBasicMaterial({ color: C.bone, toneMapped: false }),
);
eyeDot.position.copy(frame.eye);
const planeOutline = polyline([...corners, corners[0]!], { color: C.bone, width: 3 });
const toPlane = segments({ width: 2, opacity: 0.9 });
const beyond = segments({ width: 1.5, opacity: 0.3 });
const solid = (n: number, hex: number) => {
  const c = new THREE.Color(hex);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 3) c.toArray(out, i);
  return out;
};
{
  const near: number[] = [];
  const far: number[] = [];
  for (const c of corners) {
    const f = frame.eye.clone().add(c.clone().sub(frame.eye).multiplyScalar(FAR / PLANE_DISTANCE));
    near.push(frame.eye.x, frame.eye.y, frame.eye.z, c.x, c.y, c.z);
    far.push(c.x, c.y, c.z, f.x, f.y, f.z);
  }
  setSegments(toPlane, new Float32Array(near), solid(near.length, C.bone));
  setSegments(beyond, new Float32Array(far), solid(far.length, C.bone));
}
stage.add(eyeDot, planeOutline, toPlane, beyond);

// Labels, as rasterize.
const screenLabel = label('screen', {
  size: 0.08,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'bottom',
  position: [SCREEN.center[0], SCREEN.center[1] + SCREEN.height / 2 + 0.05, 0],
});
const sceneLabel = label('scene', { size: 0.08, color: C.bone, anchorX: 'center', anchorY: 'bottom' });
stage.hud.add(screenLabel, sceneLabel);
const sceneTop = new THREE.Vector3(0, 4.35, 0);
function toHud(p: THREE.Vector3): [number, number] {
  const ndc = p.clone().project(stage.camera);
  return [ndc.x * ASPECT, ndc.y];
}

// The screen's pixel grid.
const gridLines = segments({ width: 1.5 });
stage.hud.add(gridLines);
function drawGrid(res: number): void {
  const h = SCREEN.height;
  const [cx, cy] = SCREEN.center;
  const pos: number[] = [];
  for (let i = 0; i <= res; i++) {
    const f = -h / 2 + (h * i) / res;
    pos.push(cx + f, cy - h / 2, 0.02, cx + f, cy + h / 2, 0.02);
    pos.push(cx - h / 2, cy + f, 0.02, cx + h / 2, cy + f, 0.02);
  }
  setSegments(gridLines, new Float32Array(pos), solid(pos.length, C.slate));
  gridLines.material.linewidth = res > 32 ? 1 : 1.5;
}

const caption = label('', { size: 0.06, color: C.bone, anchorX: 'center', anchorY: 'top', position: [0, -0.8, 0] });
stage.hud.add(caption);

// The lamp, outlined so nobody has to guess where the light is.
const { Le } = lampColor(desc);
const LeMax = Math.max(Le.r, Le.g, Le.b);
const lamp = lampOutline(desc);
stage.add(lamp);

const pathGroup = new THREE.Group();
stage.add(pathGroup);

const cellLine = polyline(Array.from({ length: 5 }, () => [0, 0, 0] as [number, number, number]), { color: C.ochre, width: 4 });
const insetCell = polyline(Array.from({ length: 5 }, () => [0, 0, 0] as [number, number, number]), { color: C.ochre, width: 4 });
pathGroup.add(cellLine);
stage.hud.add(insetCell);

// --- Controls --------------------------------------------------------------
const params = { grid: 64, path: 0 };
ui.params.add(params, 'grid', 2, 64, 1).name('film resolution').onChange(search);
const pathControl = ui.params.add(params, 'path', 0, MAX_CANDIDATES - 1, 1).onChange(() => {
  chosen = null;
  build();
});

// --- The path --------------------------------------------------------------
interface Candidate {
  x: number;
  y: number;
  vertices: VertexRecord[]; // camera .. the lamp hit inclusive, or the whole walk if it found none
}
let candidates: Candidate[] = [];
/** A path thrown from a clicked pixel; overrides `path` until that is moved. */
let chosen: Candidate | null = null;

const integrator = new UnidirectionalPT({ maxBounces: MAX_BOUNCES, rrStartDepth: 99, sampleNEE: false });
const lampHit = (vs: VertexRecord[]) => vs.findIndex((v, i) => i > 0 && v.primitiveName === 'light');
// Brightest result first: the pixel value is Le * beta_n, so rank by the
// luminance of beta_n weighted by the lamp's colour.
const brightness = (c: Candidate) => {
  const b = c.vertices[c.vertices.length - 1]!.beta;
  return 0.2126 * Le.r * b[0] + 0.7152 * Le.g * b[1] + 0.0722 * Le.b * b[2];
};

/** One real plain-PT sample of pixel (x, y). */
function sample(scene: ReturnType<typeof buildScene>, sampler: IndependentSampler, x: number, y: number, s: number): VertexRecord[] {
  const key = pixelSeedKey(x, y, s);
  sampler.startPixelSample(key);
  const recorder = new ArrayRecorder();
  recorder.beginPath(key);
  integrator.sampleContributions([x, y], sampler, scene, recorder);
  recorder.endPath();
  return recorder.records[0]!.vertices;
}

/** Throw paths from one pixel until some reach the lamp (see header). */
function pathFromPixel(x: number, y: number): Candidate {
  const res = params.grid;
  const scene = buildScene(desc, res, res);
  const sampler = new IndependentSampler(0);
  let first: Candidate | null = null;
  const lit: Candidate[] = [];
  for (let s = 0; s < PIXEL_SAMPLES && lit.length < PIXEL_POOL; s++) {
    const vs = sample(scene, sampler, x, y, s);
    first ??= { x, y, vertices: vs };
    const hit = lampHit(vs);
    if (hit > 0) lit.push({ x, y, vertices: vs.slice(0, hit + 1) });
  }
  if (!lit.length) return first!;
  const bouncy = lit.filter((c) => c.vertices.length - 2 >= 2);
  const ranked = (bouncy.length ? bouncy : lit).sort((a, b) => brightness(b) - brightness(a));
  const u = hash01(x, y, ++clicks);
  return ranked[Math.floor(ranked.length * u * u)]!;
}

/** A deterministic number in [0, 1) from integers. */
let clicks = 0;
function hash01(...ns: number[]): number {
  let h = 2166136261;
  for (const n of ns) h = Math.imul(h ^ n, 16777619) ^ (h >>> 13);
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Real plain-PT samples, pixel by pixel, keeping the ones worth showing. */
function search(): void {
  const res = params.grid;
  const scene = buildScene(desc, res, res);
  const sampler = new IndependentSampler(0);
  candidates = [];
  chosen = null;
  // Pixels in a fixed scrambled order, not raster order: at a fine grid the
  // pool fills within the first pass, and raster order would take every
  // candidate from the top of the picture.
  const pixelOrder = Array.from({ length: res * res }, (_, i) => i).sort((a, b) => hash01(a, 7) - hash01(b, 7));
  for (let s = 0; s < SEARCH_SAMPLES && candidates.length < SEARCH_POOL; s++) {
    for (const i of pixelOrder) {
      if (candidates.length >= SEARCH_POOL) break;
      const [x, y] = [i % res, Math.floor(i / res)];
      {
        const vs = sample(scene, sampler, x, y, s);
        const hit = lampHit(vs);
        // vertices[hit] is on the lamp; bounces before it = hit - 1.
        if (hit < 3 || hit > 6) continue;
        if (!vs.slice(1, hit).some((v) => COLORED.has(v.primitiveName ?? ''))) continue;
        candidates.push({ x, y, vertices: vs.slice(0, hit + 1) });
      }
    }
  }
  candidates.sort((a, b) => brightness(b) - brightness(a));
  candidates = candidates.slice(0, MAX_CANDIDATES);
  pathControl.max(Math.max(0, candidates.length - 1));
  params.path = Math.min(params.path, Math.max(0, candidates.length - 1));
  pathControl.updateDisplay();
  build();
}

// --- The figure ------------------------------------------------------------
interface Built {
  cand: Candidate;
  /** Did this path reach the lamp? An unlit one goes out and stops. */
  lit: boolean;
  pts: THREE.Vector3[];
  /** Colour on segment k (from vertex k-1 to k), k = 1..n, relative to the lamp. */
  segColor: THREE.Color[];
  out: ReturnType<typeof polyline>[];
  back: ReturnType<typeof polyline>[];
  dots: THREE.Mesh[];
  /** Timeline marks. */
  outStart: number[];
  hitAt: number;
  backStart: number[];
  pixelAt: number;
  end: number;
}
let built: Built | null = null;
let inset: FilmPanel | null = null;
let insetPixels: Uint8ClampedArray | null = null;

function disposeBuilt(): void {
  if (!built) return;
  for (const o of [...built.out, ...built.back, ...built.dots]) {
    pathGroup.remove(o);
    (o as THREE.Mesh).geometry.dispose();
    ((o as THREE.Mesh).material as THREE.Material).dispose();
  }
  built = null;
}

function build(): void {
  disposeBuilt();
  const cand = chosen ?? candidates[params.path];
  insetLit = null;
  if (!cand) {
    setText(caption, 'no path found at this resolution');
    return;
  }
  const res = params.grid;
  const vs = cand.vertices;
  const n = vs.length - 1; // the lamp vertex, if the path is lit
  const lit = vs[n]!.primitiveName === 'light';
  const pts = vs.map((v) => new THREE.Vector3(...v.p));
  const betaN = lit ? vs[n]!.beta : ([0, 0, 0] as const);

  // Light leaving the lamp, then scaled at each bounce on the way back.
  const segColor: THREE.Color[] = [new THREE.Color()]; // index 0 unused
  for (let k = 1; k <= n; k++) {
    const bk = vs[k]!.beta;
    const ch = (i: 0 | 1 | 2) => (bk[i] > 0 ? betaN[i] / bk[i] : 0);
    segColor.push(
      new THREE.Color(
        Math.min(1, (Le.r / LeMax) * ch(0)),
        Math.min(1, (Le.g / LeMax) * ch(1)),
        Math.min(1, (Le.b / LeMax) * ch(2)),
      ),
    );
  }

  const out: ReturnType<typeof polyline>[] = [];
  const back: ReturnType<typeof polyline>[] = [];
  const dots: THREE.Mesh[] = [];
  for (let k = 1; k <= n; k++) {
    const o = polyline([pts[k - 1]!, pts[k - 1]!], { color: DARK, width: 6 });
    const b = polyline([pts[k]!, pts[k]!], { color: C.bone, width: 11 });
    // Colours here are computed, not scenery: show them as they are.
    (b.material as THREE.Material & { color: THREE.Color }).color.copy(segColor[k]!);
    b.material.toneMapped = false;
    out.push(o);
    back.push(b);
    pathGroup.add(o, b);
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 20, 12),
      new THREE.MeshBasicMaterial({ color: DARK, toneMapped: false }),
    );
    dot.position.copy(pts[k]!);
    dots.push(dot);
    pathGroup.add(dot);
  }

  // Timeline.
  const outStart: number[] = [0];
  let t = 0;
  for (let k = 1; k <= n; k++) {
    outStart[k] = t;
    t += GROW + (k < n ? AT_VERTEX : 0);
  }
  const hitAt = t;
  const backStart: number[] = [];
  if (lit) {
    t += AT_LIGHT;
    for (let k = n; k >= 1; k--) {
      backStart[k] = t;
      t += BACK + (k > 1 ? TINT : 0);
    }
  } else {
    for (let k = 1; k <= n; k++) backStart[k] = Infinity; // nothing comes back
  }
  const pixelAt = t;
  const end = pixelAt + AT_PIXEL + HOLD;
  built = { cand, lit, pts, segColor, out, back, dots, outStart, hitAt, backStart, pixelAt, end };

  setPolyline(cellLine, cellOnPlane(desc.camera, PLANE_DISTANCE, res, cand.x, cand.y));

  if (!inset || inset.width !== res) {
    inset?.dispose();
    inset = new FilmPanel({ width: res, height: res, center: SCREEN.center, drawnHeight: SCREEN.height, border: false });
    insetPixels = new Uint8ClampedArray(res * res * 4);
    stage.hud.add(inset.group);
    drawGrid(res);
  }
  setPolyline(insetCell, cellInPanel(SCREEN.center, SCREEN.height, res, cand.x, cand.y));
  paintInset(false);

  stage.duration = end;
  stage.t = 0;
}

let insetLit: boolean | null = null;
function paintInset(lit: boolean): void {
  if (!inset || !insetPixels || !built || lit === insetLit) return;
  insetLit = lit;
  const { cand } = built;
  const res = params.grid;
  for (let i = 0; i < res * res; i++) {
    const o = i * 4;
    const on = lit && i === cand.y * res + cand.x;
    const c = built.segColor[1]!;
    insetPixels[o] = on ? srgbEncode(c.r) : BLANK;
    insetPixels[o + 1] = on ? srgbEncode(c.g) : BLANK;
    insetPixels[o + 2] = on ? srgbEncode(c.b) : BLANK;
    insetPixels[o + 3] = 255;
  }
  inset.update(insetPixels);
}

const ease = (u: number) => u * u * (3 - 2 * u);
const clamp01 = (u: number) => Math.min(1, Math.max(0, u));

stage.frame((t) => {
  if (!built) return;
  const { pts, out, back, dots, outStart, hitAt, backStart, pixelAt } = built;
  const n = out.length;
  sceneLabel.position.set(...toHud(sceneTop), 0);

  // Outgoing: segment k grows from vertex k-1 to vertex k.
  for (let k = 1; k <= n; k++) {
    const u = ease(clamp01((t - outStart[k]!) / GROW));
    out[k - 1]!.visible = u > 0;
    if (u > 0) setPolyline(out[k - 1]!, [pts[k - 1]!, pts[k - 1]!.clone().lerp(pts[k]!, u)]);
    dots[k - 1]!.visible = u >= 1;
  }

  // The hit: the lamp's outline swells for a moment.
  const pulse = built.lit && t >= hitAt && t < hitAt + AT_LIGHT ? Math.sin((Math.PI * (t - hitAt)) / AT_LIGHT) : 0;
  lamp.material.linewidth = 4 + 8 * pulse;

  // Returning: segment k fills with its colour from vertex k back to k-1,
  // and the dot it arrives at takes the new colour.
  for (let k = n; k >= 1; k--) {
    const u = ease(clamp01((t - backStart[k]!) / BACK));
    back[k - 1]!.visible = u > 0;
    if (u > 0) {
      const front = pts[k]!.clone().lerp(pts[k - 1]!, u);
      setPolyline(back[k - 1]!, [pts[k]!, front]);
      // The dark outgoing line gives way to the colour, so the two never overlap.
      out[k - 1]!.visible = u < 1;
      if (u < 1) setPolyline(out[k - 1]!, [pts[k - 1]!, front]);
    }
    if (k > 1) {
      const dot = dots[k - 2]!;
      const mat = dot.material as THREE.MeshBasicMaterial;
      if (u >= 1) mat.color.copy(built.segColor[k - 1]!);
      else mat.color.setHex(DARK);
    }
  }
  // The lamp-end dot glows in the lamp's own colour once it is hit.
  (dots[n - 1]!.material as THREE.MeshBasicMaterial).color.copy(
    built.lit && t >= hitAt ? built.segColor[n]! : new THREE.Color(DARK),
  );

  paintInset(t >= pixelAt + AT_PIXEL * 0.5);

  // A counter, not narration: the slide and the speaker carry the story.
  let k = 1;
  while (k < n && t >= outStart[k + 1]!) k++;
  const bounces = (m: number) => `${m} bounce${m === 1 ? '' : 's'}`;
  const text = t < hitAt
    ? (k > 1 ? `bounce ${k - 1}` : '')
    : built.lit ? bounces(n - 1) : `${bounces(n)} · no light`;
  setText(caption, text);
});

// --- Clicking the film -----------------------------------------------------
// The HUD spans x in [-ASPECT, ASPECT], y in [-1, 1] over the letterboxed
// canvas. A click (not a drag, which orbits) on a pixel of the screen throws a
// path from that pixel.
const canvas = stage.renderer.domElement;
function cellUnder(e: PointerEvent): [number, number] | null {
  const r = canvas.getBoundingClientRect();
  const hx = (((e.clientX - r.left) / r.width) * 2 - 1) * ASPECT;
  const hy = -(((e.clientY - r.top) / r.height) * 2 - 1);
  const res = params.grid;
  const h = SCREEN.height;
  const left = SCREEN.center[0] - h / 2;
  const top = SCREEN.center[1] + h / 2;
  const x = Math.floor(((hx - left) / h) * res);
  const y = Math.floor(((top - hy) / h) * res);
  return x >= 0 && x < res && y >= 0 && y < res ? [x, y] : null;
}
let downAt: [number, number] | null = null;
canvas.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
canvas.addEventListener('pointerup', (e) => {
  const moved = downAt ? Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) : Infinity;
  downAt = null;
  const cell = moved < 5 ? cellUnder(e) : null;
  if (!cell) return;
  chosen = pathFromPixel(cell[0], cell[1]);
  build();
});
canvas.addEventListener('pointermove', (e) => {
  canvas.style.cursor = cellUnder(e) ? 'pointer' : '';
});

stage.start();
search();

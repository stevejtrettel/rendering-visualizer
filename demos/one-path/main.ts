/**
 * SHOWS: one path, all the way. The set-up of level-zero (the short open box,
 * the eye, the film), but now a single pixel's ray does not stop at its first
 * hit: it bounces, segment by segment, until it lands on the lamp. Then light
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
 * so the tint is visible. `path` steps through those candidates.
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
import { ImagePlaneElement } from '@/viz/image-plane';
import { cellOnPlane, cellInPanel } from '@/viz/film-cell';
import { FilmPanel } from '@/viz/film-panel';
import { polyline, setPolyline } from '@/viz/lines';
import { srgbEncode } from '@/render/film';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
const PLANE_DISTANCE = 1.4; // as level-zero and pixel-grid
const INSET = { center: [-1.3, -0.42] as [number, number], height: 0.62 };
const MAX_BOUNCES = 8;
const SEARCH_SAMPLES = 400; // per pixel
const MAX_CANDIDATES = 24;
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
// sceneToThree adds one mesh per primitive, in order.
{
  const i = desc.primitives.findIndex((p) => p.name === 'right');
  const wall = sceneGroup.children[i] as THREE.Mesh;
  const mat = wall.material as THREE.MeshStandardMaterial;
  mat.transparent = true;
  mat.opacity = 0.3;
  mat.depthWrite = false;
}
const view = vizViewFor(SCENE);
stage.camera.position.set(...view.eye);
stage.controls?.target.set(...view.target);
stage.controls?.update();

const caption = label('', { size: 0.06, color: C.bone, anchorX: 'center', anchorY: 'top', position: [0, -0.8, 0] });
stage.hud.add(caption);

// The lamp, outlined so nobody has to guess where the light is.
const lampDesc = desc.primitives.find((p) => p.name === 'light')!;
const Le = new THREE.Color(...lampDesc.emission!.radiance);
const LeMax = Math.max(Le.r, Le.g, Le.b);
const lampOutline = (() => {
  if (lampDesc.shape.kind !== 'quad') throw new Error('one-path expects a quad lamp');
  const { q, e1, e2 } = lampDesc.shape;
  const o = new THREE.Vector3(q[0], q[1] - 0.01, q[2]);
  const a = new THREE.Vector3(...e1);
  const b = new THREE.Vector3(...e2);
  return polyline([o, o.clone().add(a), o.clone().add(a).add(b), o.clone().add(b), o], { color: C.ochre, width: 4 });
})();
stage.add(lampOutline);

const pathGroup = new THREE.Group();
const planeGroup = new THREE.Group();
stage.add(pathGroup, planeGroup);

const cellLine = polyline(Array.from({ length: 5 }, () => [0, 0, 0] as [number, number, number]), { color: C.ochre, width: 4 });
const insetCell = polyline(Array.from({ length: 5 }, () => [0, 0, 0] as [number, number, number]), { color: C.ochre, width: 4 });
pathGroup.add(cellLine);
stage.hud.add(insetCell);

// --- Controls --------------------------------------------------------------
const params = { grid: 8, path: 0 };
ui.params.add(params, 'grid', 2, 32, 1).name('film resolution').onChange(search);
const pathControl = ui.params.add(params, 'path', 0, MAX_CANDIDATES - 1, 1).onChange(build);

// --- The path --------------------------------------------------------------
interface Candidate {
  x: number;
  y: number;
  vertices: VertexRecord[]; // camera .. the lamp hit, inclusive
}
let candidates: Candidate[] = [];

/** Real plain-PT samples, pixel by pixel, keeping the ones worth showing. */
function search(): void {
  const res = params.grid;
  const scene = buildScene(desc, res, res);
  const integrator = new UnidirectionalPT({ maxBounces: MAX_BOUNCES, rrStartDepth: 99, sampleNEE: false });
  const sampler = new IndependentSampler(0);
  candidates = [];
  for (let s = 0; s < SEARCH_SAMPLES && candidates.length < MAX_CANDIDATES; s++) {
    for (let y = 0; y < res && candidates.length < MAX_CANDIDATES; y++) {
      for (let x = 0; x < res && candidates.length < MAX_CANDIDATES; x++) {
        const key = pixelSeedKey(x, y, s);
        sampler.startPixelSample(key);
        const recorder = new ArrayRecorder();
        recorder.beginPath(key);
        integrator.sampleContributions([x, y], sampler, scene, recorder);
        recorder.endPath();
        const vs = recorder.records[0]!.vertices;
        const hit = vs.findIndex((v, i) => i > 0 && v.primitiveName === 'light');
        // vertices[hit] is on the lamp; bounces before it = hit - 1.
        if (hit < 3 || hit > 6) continue;
        if (!vs.slice(1, hit).some((v) => COLORED.has(v.primitiveName ?? ''))) continue;
        candidates.push({ x, y, vertices: vs.slice(0, hit + 1) });
      }
    }
  }
  pathControl.max(Math.max(0, candidates.length - 1));
  params.path = Math.min(params.path, Math.max(0, candidates.length - 1));
  pathControl.updateDisplay();
  build();
}

// --- The figure ------------------------------------------------------------
interface Built {
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
let plane: ImagePlaneElement | null = null;
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
  plane?.dispose();
  plane = null;
  const cand = candidates[params.path];
  if (!cand) {
    setText(caption, 'no path found at this resolution');
    return;
  }
  const res = params.grid;
  const vs = cand.vertices;
  const n = vs.length - 1; // index of the lamp vertex
  const pts = vs.map((v) => new THREE.Vector3(...v.p));
  const betaN = vs[n]!.beta;

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
    const o = polyline([pts[k - 1]!, pts[k - 1]!], { color: C.bone, width: 6 });
    const b = polyline([pts[k]!, pts[k]!], { color: C.bone, width: 11 });
    // Colours here are computed, not scenery: show them as they are.
    (b.material as THREE.Material & { color: THREE.Color }).color.copy(segColor[k]!);
    b.material.toneMapped = false;
    out.push(o);
    back.push(b);
    pathGroup.add(o, b);
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 20, 12),
      new THREE.MeshBasicMaterial({ color: C.bone, toneMapped: false }),
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
  t += AT_LIGHT;
  const backStart: number[] = [];
  for (let k = n; k >= 1; k--) {
    backStart[k] = t;
    t += BACK + (k > 1 ? TINT : 0);
  }
  const pixelAt = t;
  const end = pixelAt + AT_PIXEL + HOLD;
  built = { pts, segColor, out, back, dots, outStart, hitAt, backStart, pixelAt, end };

  // The film: blank, except this pixel once the light arrives.
  const value = segColor[1]!;
  const cumulative = new Float32Array(res * res * 3);
  const idx = cand.y * res + cand.x;
  cumulative[idx * 3] = value.r;
  cumulative[idx * 3 + 1] = value.g;
  cumulative[idx * 3 + 2] = value.b;
  const revealAt = new Float32Array(res * res).fill(Infinity);
  revealAt[idx] = pixelAt + AT_PIXEL * 0.5;
  plane = new ImagePlaneElement(
    { camera: desc.camera, distance: PLANE_DISTANCE, res, samples: 1, dwell: Infinity, cumulative, highlight: null, revealAt },
    planeGroup,
  );
  setPolyline(cellLine, cellOnPlane(desc.camera, PLANE_DISTANCE, res, cand.x, cand.y));

  if (!inset || inset.width !== res) {
    inset?.dispose();
    inset = new FilmPanel({ width: res, height: res, center: INSET.center, drawnHeight: INSET.height });
    insetPixels = new Uint8ClampedArray(res * res * 4);
    stage.hud.add(inset.group);
  }
  setPolyline(insetCell, cellInPanel(INSET.center, INSET.height, res, cand.x, cand.y));
  paintInset(false);

  stage.duration = end;
  stage.t = 0;
}

let insetLit: boolean | null = null;
function paintInset(lit: boolean): void {
  if (!inset || !insetPixels || !built || lit === insetLit) return;
  insetLit = lit;
  const cand = candidates[params.path]!;
  const res = params.grid;
  for (let i = 0; i < res * res; i++) {
    const o = i * 4;
    const on = lit && i === cand.y * res + cand.x;
    const c = built.segColor[1]!;
    insetPixels[o] = on ? srgbEncode(c.r) : 18;
    insetPixels[o + 1] = on ? srgbEncode(c.g) : 18;
    insetPixels[o + 2] = on ? srgbEncode(c.b) : 18;
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
  plane?.drawAt(t);

  // Outgoing: segment k grows from vertex k-1 to vertex k.
  for (let k = 1; k <= n; k++) {
    const u = ease(clamp01((t - outStart[k]!) / GROW));
    out[k - 1]!.visible = u > 0;
    if (u > 0) setPolyline(out[k - 1]!, [pts[k - 1]!, pts[k - 1]!.clone().lerp(pts[k]!, u)]);
    dots[k - 1]!.visible = u >= 1;
  }

  // The hit: the lamp's outline swells for a moment.
  const pulse = t >= hitAt && t < hitAt + AT_LIGHT ? Math.sin((Math.PI * (t - hitAt)) / AT_LIGHT) : 0;
  lampOutline.material.linewidth = 4 + 8 * pulse;

  // Returning: segment k fills with its colour from vertex k back to k-1,
  // and the dot it arrives at takes the new colour.
  for (let k = n; k >= 1; k--) {
    const u = ease(clamp01((t - backStart[k]!) / BACK));
    back[k - 1]!.visible = u > 0;
    if (u > 0) {
      const front = pts[k]!.clone().lerp(pts[k - 1]!, u);
      setPolyline(back[k - 1]!, [pts[k]!, front]);
      // The white outgoing line gives way to the colour, so the two never overlap.
      out[k - 1]!.visible = u < 1;
      if (u < 1) setPolyline(out[k - 1]!, [pts[k - 1]!, front]);
    }
    if (k > 1) {
      const dot = dots[k - 2]!;
      const mat = dot.material as THREE.MeshBasicMaterial;
      if (u >= 1) mat.color.copy(built.segColor[k - 1]!);
      else mat.color.setHex(C.bone);
    }
  }
  // The lamp-end dot glows in the lamp's own colour once it is hit.
  (dots[n - 1]!.material as THREE.MeshBasicMaterial).color.copy(t >= hitAt ? built.segColor[n]! : new THREE.Color(C.bone));

  paintInset(t >= pixelAt + AT_PIXEL * 0.5);

  // A counter, not narration: the slide and the speaker carry the story.
  let k = 1;
  while (k < n && t >= outStart[k + 1]!) k++;
  const text = t < hitAt ? (k > 1 ? `bounce ${k - 1}` : '') : `${n - 1} bounces`;
  setText(caption, text);
});

stage.start();
search();

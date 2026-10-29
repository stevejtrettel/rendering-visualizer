/**
 * SHOWS: the two things a picture is made from, side by side. A scene, the
 * 3D model (the short open box of level-zero, one-path and one-sample), and
 * a screen, a grid of pixels drawn square-on beside it. The screen starts
 * blank; then an image of the scene loads onto it, pixel by pixel in raster
 * order: rendering, before anything is said about how.
 *
 * The image is real: the scene's own camera, rendered by path tracing with
 * light sampling (pt-nee) at SPP samples per pixel, exposure 1. The grid
 * lines stay on so the pixels stay pixels.
 *
 * The figure ramps to the loaded image and holds it.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { NEEPathTracer } from '@/core/integrators/pt-nee';
import { IndependentSampler } from '@/core/sampler/independent';
import { Film, srgbEncode } from '@/render/film';
import { renderPass } from '@/render/driver';
import { sceneToThree } from '@/viz/three-scene';
import { FilmPanel } from '@/viz/film-panel';
import { segments, setSegments } from '@/viz/lines';
import { label } from '@/viz/text';
import { ASPECT } from '@/viz/stage';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
const SPP = 128;
/** The screen, on the HUD (x in [-ASPECT, ASPECT], y in [-1, 1]). */
const SCREEN = { center: [0.85, -0.02] as [number, number], height: 1.15 };
/** Share of the frame width the 3D view slides left (stage.shiftView), freeing the right for the screen. */
const SHIFT = 0.25;
const BLANK = 18;
// Timing, seconds.
const SCENE_LABEL = [0.6, 1.4];
const SCREEN_IN = [1.6, 2.4];
const SCREEN_LABEL = [2.0, 2.8];
const LOAD = [3.4, 6.4]; // the image loads, first pixel to last
const HOLD = 3;

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });
const ui = createUI(stage);

const desc = SCENES[SCENE];
stage.add(sceneToThree(desc));
const view = vizViewFor(SCENE);
stage.camera.position.set(...view.eye);
stage.controls?.target.set(...view.target);
stage.controls?.update();
stage.shiftView(SHIFT);

const sceneLabel = label('scene', { size: 0.08, color: C.bone, anchorX: 'center', anchorY: 'bottom', opacity: 0.999 });
const screenLabel = label('screen', {
  size: 0.08,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'bottom',
  opacity: 0.999,
  position: [SCREEN.center[0], SCREEN.center[1] + SCREEN.height / 2 + 0.05, 0],
});
stage.hud.add(sceneLabel, screenLabel);

// The scene's label sits just above the box, wherever the view puts it.
const box = new THREE.Box3();
for (const p of desc.primitives) {
  if (p.shape.kind !== 'quad') continue;
  const { q, e1, e2 } = p.shape;
  const o = new THREE.Vector3(...q);
  const a = new THREE.Vector3(...e1);
  const b = new THREE.Vector3(...e2);
  for (const v of [o, o.clone().add(a), o.clone().add(b), o.clone().add(a).add(b)]) box.expandByPoint(v);
}
const sceneTop = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y + 0.35, (box.min.z + box.max.z) / 2);
function toHud(p: THREE.Vector3): [number, number] {
  const ndc = p.clone().project(stage.camera);
  return [ndc.x * ASPECT, ndc.y];
}

// --- The screen ------------------------------------------------------------
let screen: FilmPanel | null = null;
let pixels: Uint8ClampedArray | null = null;
const gridLines = segments({ width: 1.5, opacity: 0.999 });
stage.hud.add(gridLines);

const params = { grid: 24 };
ui.params.add(params, 'grid', 2, 64, 1).name('film resolution').onChange(restart);

/** The rendered image, sRGB bytes per pixel in raster order. */
let image: Uint8ClampedArray | null = null;
let shownLoaded = -1;

function buildScreen(res: number): void {
  screen?.dispose();
  screen = new FilmPanel({
    width: res,
    height: res,
    center: SCREEN.center,
    drawnHeight: SCREEN.height,
    opacity: 0.999,
    border: false,
  });
  pixels = new Uint8ClampedArray(res * res * 4);
  stage.hud.add(screen.group);

  // Pixel boundaries, just in front of the panel.
  const h = SCREEN.height;
  const [cx, cy] = SCREEN.center;
  const pos: number[] = [];
  for (let i = 0; i <= res; i++) {
    const f = -h / 2 + (h * i) / res;
    pos.push(cx + f, cy - h / 2, 0.02, cx + f, cy + h / 2, 0.02);
    pos.push(cx - h / 2, cy + f, 0.02, cx + h / 2, cy + f, 0.02);
  }
  const grey = new THREE.Color(C.slateDeep);
  const col = new Float32Array(pos.length);
  for (let i = 0; i < col.length; i += 3) grey.toArray(col, i);
  setSegments(gridLines, new Float32Array(pos), col);
}

// --- Rendering -------------------------------------------------------------
let ready: Promise<void> = Promise.resolve();
let generation = 0;

function restart(): void {
  const gen = ++generation;
  const res = params.grid;
  image = null;
  shownLoaded = -1;
  buildScreen(res);
  stage.speed = 0;
  stage.t = 0;

  ready = (async () => {
    const scene = buildScene(desc, res, res);
    const integrator = new NEEPathTracer({ maxBounces: 8 });
    const sampler = new IndependentSampler(0);
    const film = new Film(res, res);
    for (let s = 0; s < SPP; s++) {
      renderPass(scene, integrator, sampler, film, s);
      if (s % 8 === 7) await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
      if (gen !== generation) return;
    }
    const out = new Uint8ClampedArray(res * res * 3);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const [r, g, b] = film.pixel(x, y);
        const o = (y * res + x) * 3;
        out[o] = srgbEncode(r);
        out[o + 1] = srgbEncode(g);
        out[o + 2] = srgbEncode(b);
      }
    }
    image = out;
    stage.speed = 1;
  })();
}

// --- Playback --------------------------------------------------------------
const ramp = (t: number, [a, b]: number[]) => Math.min(1, Math.max(0, (t - a!) / (b! - a!)));

stage.frame((t) => {
  sceneLabel.position.set(...toHud(sceneTop), 0);
  sceneLabel.material.opacity = 0.999 * ramp(t, SCENE_LABEL);
  screenLabel.material.opacity = 0.999 * ramp(t, SCREEN_LABEL);

  if (!screen || !pixels) return;
  const fadeIn = ramp(t, SCREEN_IN);
  screen.group.visible = gridLines.visible = fadeIn > 0;
  ((screen.group.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.999 * fadeIn;
  gridLines.material.opacity = 0.999 * fadeIn;

  // Pixel by pixel, in raster order.
  const n = params.grid * params.grid;
  const loaded = image ? Math.floor(n * ramp(t, LOAD)) : 0;
  if (loaded === shownLoaded) return;
  shownLoaded = loaded;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const on = i < loaded && image;
    pixels[o] = on ? image![i * 3]! : BLANK;
    pixels[o + 1] = on ? image![i * 3 + 1]! : BLANK;
    pixels[o + 2] = on ? image![i * 3 + 2]! : BLANK;
    pixels[o + 3] = 255;
  }
  screen.update(pixels);
});

stage.duration = LOAD[1]! + HOLD;
stage.onReady(() => ready);
stage.start();
restart();

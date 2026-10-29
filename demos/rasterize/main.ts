/**
 * SHOWS: rasterization, the map from scene to screen. Same layout as
 * scene-and-screen, the slide before: the screen square-on at the left, the
 * scene at the right. In the scene, the camera's eye and its image plane
 * appear in front of the box; then the scene is projected piece by piece,
 * back to front (back wall, side walls, floor, ceiling, lamp, the two
 * balls): each piece slides as a whole along the lines to the eye until it
 * lies flat on the plane, and as it lands its pixels appear on the screen,
 * painted over what is already there. One piece at a time, so the map from
 * scene to screen can be followed (Steve, 2026-10-29).
 *
 * What is drawn is what a rasterizer computes:
 *
 *   - the projection: a point p moves along the ray from the eye through p,
 *     never off it, so it lands exactly where the ray crosses the plane;
 *   - the depth test: the flattened scene is not squashed to zero thickness
 *     but to a slab of relative thickness DEPTH_KEEP, depth order intact,
 *     so nearer surfaces still cover farther ones on the plane, as a
 *     z-buffer resolves them (drawing it at zero thickness would leave the
 *     overlap to the order the meshes happen to be drawn in);
 *   - clipping: only what the camera sees is projected; the rest of the
 *     scene is cut away at the frustum when the plane appears;
 *   - colour: flat surface colour, no lighting. As a piece flattens its
 *     shading fades to that flat colour. On the screen each piece is
 *     painted where it covers: the piece is rendered alone at SPP jittered
 *     samples a pixel (the same rays for every piece), and each SAMPLE
 *     takes the colour of the last landed piece covering it, the pixel the
 *     mean of its samples. (Blending whole-pixel coverages instead left dark
 *     seams where two pieces share a pixel.) Back to front
 *     here is a true depth order, so the finished screen is exactly
 *     FirstHitColor's image, the colour of the nearest surface along each
 *     pixel's ray, which level-zero builds ray by ray later. The colours
 *     are the ones three-scene draws (first-hit shares them).
 *
 * The plane sits at PLANE_DISTANCE, further out than level-zero's film, so
 * the flattened scene is big enough to read. The figure ramps to the
 * finished image and holds.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { FirstHitColor, surfaceColors } from '@/core/integrators/first-hit';
import { Color } from '@/core/math/color';
import { IndependentSampler } from '@/core/sampler/independent';
import { srgbEncode } from '@/render/film';
import { pixelSeedKey } from '@/core/sampler/sampler';
import { NULL_RECORDER } from '@/trace/recorder';
import { sceneToThree } from '@/viz/three-scene';
import { imagePlaneFrame } from '@/viz/image-plane';
import { FilmPanel } from '@/viz/film-panel';
import { polyline, segments, setSegments } from '@/viz/lines';
import { label } from '@/viz/text';
import { ASPECT } from '@/viz/stage';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
const SPP = 8; // antialiasing only: the image is flat colour
/** Projected one at a time, in this order: back to front, a true depth order for this scene. */
const PIECES = ['back', 'left', 'right', 'floor', 'ceiling', 'light', 'ball', 'ballBlue'];
/** The screen, on the HUD, and the 3D view's sideways slide: as scene-and-screen. */
const SCREEN = { center: [-0.85, -0.02] as [number, number], height: 1.15 };
const SHIFT = -0.25;
const PLANE_DISTANCE = 3;
const DEPTH_KEEP = 0.03; // the flattened slab's thickness, relative to the scene's depth
const FAR = 9.5; // how far the frustum edges are drawn, from the eye
const BLANK = 18;
// Timing, seconds.
const PLANE_IN = [0.6, 1.4]; // eye, plane and frustum appear; the unseen scene is cut away
const FIRST_PIECE = 2.0;
const PIECE = 0.9; // one piece's flight
const STAGGER = 0.7; // between one piece leaving and the next
const LAND = 0.3; // a landed piece's pixels fade in over this
const lastLands = FIRST_PIECE + (PIECES.length - 1) * STAGGER + PIECE + LAND;
const HOLD = 3;

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });
const ui = createUI(stage);
stage.renderer.localClippingEnabled = true;

const desc = SCENES[SCENE];
const sceneGroup = sceneToThree(desc);
stage.add(sceneGroup);
const view = vizViewFor(SCENE);
stage.camera.position.set(...view.eye);
stage.controls?.target.set(...view.target);
stage.controls?.update();
stage.shiftView(SHIFT);

// --- The camera: eye, plane, frustum ---------------------------------------
const frame = imagePlaneFrame(desc.camera, PLANE_DISTANCE);
const { eye, center, right, up, forward, halfW, halfH } = frame;
const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) =>
  center.clone().addScaledVector(right, x! * halfW).addScaledVector(up, y! * halfH),
);

const eyeDot = new THREE.Mesh(
  new THREE.SphereGeometry(0.08, 20, 12),
  new THREE.MeshBasicMaterial({ color: C.bone, transparent: true, toneMapped: false }),
);
eyeDot.position.copy(eye);
const planeOutline = polyline([...corners, corners[0]!], { color: C.bone, width: 3, opacity: 0.999 });
const toPlane = segments({ width: 2, opacity: 0.999 });
const beyond = segments({ width: 1.5, opacity: 0.999 });
{
  const near: number[] = [];
  const far: number[] = [];
  for (const c of corners) {
    const f = eye.clone().add(c.clone().sub(eye).multiplyScalar(FAR / PLANE_DISTANCE));
    near.push(eye.x, eye.y, eye.z, c.x, c.y, c.z);
    far.push(c.x, c.y, c.z, f.x, f.y, f.z);
  }
  const bone = new THREE.Color(C.bone);
  const cols = (n: number) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 3) bone.toArray(out, i);
    return out;
  };
  setSegments(toPlane, new Float32Array(near), cols(near.length));
  setSegments(beyond, new Float32Array(far), cols(far.length));
}
const cameraParts = [eyeDot, planeOutline, toPlane, beyond];
stage.add(...cameraParts);

// The frustum's four sides, normals inward: three clips the negative side.
// While the camera is not yet shown they are pushed far out, cutting nothing.
const frustum = corners.map((c, i) => {
  const plane = new THREE.Plane().setFromCoplanarPoints(eye, c, corners[(i + 1) % 4]!);
  if (plane.distanceToPoint(center) < 0) plane.negate();
  return plane;
});
const frustumConstants = frustum.map((p) => p.constant);
const OFF = 1000;

// --- Flattening, in the vertex shader --------------------------------------
const shared = {
  uEye: { value: eye.clone() },
  uFwd: { value: forward.clone() },
  uD: { value: PLANE_DISTANCE },
  uK: { value: DEPTH_KEEP },
};
interface Piece {
  mat: THREE.MeshStandardMaterial;
  color: THREE.Color;
  emissive: THREE.Color;
  flat: { value: number };
}
// sceneToThree adds one mesh per primitive, in order.
const pieces: Piece[] = PIECES.map((name) => {
  const i = desc.primitives.findIndex((p) => p.name === name);
  if (i < 0) throw new Error(`no primitive ${name}`);
  const mat = (sceneGroup.children[i] as THREE.Mesh).material as THREE.MeshStandardMaterial;
  const flat = { value: 0 };
  mat.clippingPlanes = frustum;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, { uFlat: flat });
    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        'uniform float uFlat; uniform vec3 uEye; uniform vec3 uFwd; uniform float uD; uniform float uK;\nvoid main() {',
      )
      .replace(
        '#include <project_vertex>',
        `vec4 wp = modelMatrix * vec4( transformed, 1.0 );
        vec3 rel = wp.xyz - uEye;
        float ze = dot( rel, uFwd );
        float zFlat = uD + uK * ( ze - uD );
        wp.xyz = uEye + rel * ( mix( ze, zFlat, uFlat ) / ze );
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  mat.needsUpdate = true;
  return { mat, color: mat.color.clone(), emissive: mat.emissive.clone(), flat };
});

/** A piece flattened by f: on its way to the plane, its shading fading to flat surface colour. */
function setFlat(piece: Piece, f: number): void {
  piece.flat.value = f;
  const { mat, color, emissive } = piece;
  if (emissive.r + emissive.g + emissive.b > 0) return; // the lamp already shows its own colour
  mat.color.copy(color).multiplyScalar(1 - f);
  mat.emissive.copy(color).multiplyScalar(f);
}

// --- Labels ----------------------------------------------------------------
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

const params = { grid: 64 };
ui.params.add(params, 'grid', 2, 64, 1).name('film resolution').onChange(restart);

/** Per piece: its flat colour (sRGB bytes) and, per pixel, which of the SPP samples it covers (a bitmask). */
let layers: { rgb: [number, number, number]; covers: Uint8Array }[] = [];
let shownFill = '';

function buildScreen(res: number): void {
  screen?.dispose();
  screen = new FilmPanel({ width: res, height: res, center: SCREEN.center, drawnHeight: SCREEN.height, border: false });
  pixels = new Uint8ClampedArray(res * res * 4);
  stage.hud.add(screen.group);

  const h = SCREEN.height;
  const [cx, cy] = SCREEN.center;
  const pos: number[] = [];
  for (let i = 0; i <= res; i++) {
    const f = -h / 2 + (h * i) / res;
    pos.push(cx + f, cy - h / 2, 0.02, cx + f, cy + h / 2, 0.02);
    pos.push(cx - h / 2, cy + f, 0.02, cx + h / 2, cy + f, 0.02);
  }
  const grey = new THREE.Color(C.slate);
  const col = new Float32Array(pos.length);
  for (let i = 0; i < col.length; i += 3) grey.toArray(col, i);
  setSegments(gridLines, new Float32Array(pos), col);
  gridLines.material.linewidth = res > 32 ? 1 : 1.5;
}

function restart(): void {
  const res = params.grid;
  buildScreen(res);
  shownFill = '';
  const colors = surfaceColors(desc);
  const sampler = new IndependentSampler(0);
  // Each piece rendered alone: which samples of each pixel it covers.
  layers = PIECES.map((name) => {
    const alone = { ...desc, primitives: desc.primitives.filter((p) => p.name === name) };
    const integrator = new FirstHitColor(new Map([[name, new Color(1, 1, 1)]]));
    const scene = buildScene(alone, res, res);
    const covers = new Uint8Array(res * res);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        for (let s = 0; s < SPP; s++) {
          sampler.startPixelSample(pixelSeedKey(x, y, s));
          const [c] = integrator.sampleContributions([x, y], sampler, scene, NULL_RECORDER);
          if (c && c.value.r > 0) covers[y * res + x]! |= 1 << s;
        }
      }
    }
    const c = colors.get(name)!;
    return { rgb: [srgbEncode(c.r), srgbEncode(c.g), srgbEncode(c.b)], covers };
  });
  stage.t = 0;
}

// --- Playback --------------------------------------------------------------
const ramp = (t: number, [a, b]: number[]) => Math.min(1, Math.max(0, (t - a!) / (b! - a!)));
const smooth = (u: number) => u * u * (3 - 2 * u);

stage.frame((t) => {
  sceneLabel.position.set(...toHud(sceneTop), 0);

  // The camera appears, and what it cannot see is cut away.
  const shown = ramp(t, PLANE_IN);
  for (const part of cameraParts) part.visible = shown > 0;
  (eyeDot.material as THREE.MeshBasicMaterial).opacity = shown;
  planeOutline.material.opacity = 0.999 * shown;
  toPlane.material.opacity = 0.9 * shown;
  beyond.material.opacity = 0.3 * shown;
  frustum.forEach((p, i) => (p.constant = frustumConstants[i]! + (shown > 0 ? 0 : OFF)));

  // The pieces fly one at a time, each flattening onto the plane, and
  // each appears on the screen as it lands, over the ones before.
  const landed = pieces.map((piece, k) => {
    const start = FIRST_PIECE + k * STAGGER;
    setFlat(piece, smooth(ramp(t, [start, start + PIECE])));
    return ramp(t, [start + PIECE, start + PIECE + LAND]);
  });

  if (!screen || !pixels || !layers.length) return;
  const under = Math.min(1, 24 / params.grid);
  gridLines.material.opacity = 0.999 * (1 + (under - 1) * ramp(t, [FIRST_PIECE + PIECE, lastLands]));
  const key = landed.map((a) => Math.round(a * 32)).join();
  if (key === shownFill) return;
  shownFill = key;
  const n = params.grid * params.grid;
  for (let i = 0; i < n; i++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let s = 0; s < SPP; s++) {
      // Painted back to front: each landed piece over what is there.
      let sr = BLANK;
      let sg = BLANK;
      let sb = BLANK;
      layers.forEach(({ rgb, covers }, k) => {
        const a = covers[i]! & (1 << s) ? landed[k]! : 0;
        if (a <= 0) return;
        sr += (rgb[0] - sr) * a;
        sg += (rgb[1] - sg) * a;
        sb += (rgb[2] - sb) * a;
      });
      r += sr;
      g += sg;
      b += sb;
    }
    const o = i * 4;
    pixels[o] = r / SPP;
    pixels[o + 1] = g / SPP;
    pixels[o + 2] = b / SPP;
    pixels[o + 3] = 255;
  }
  screen.update(pixels);
});

stage.duration = lastLands + HOLD;
stage.start();
restart();

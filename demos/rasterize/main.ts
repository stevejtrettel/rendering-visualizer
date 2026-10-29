/**
 * SHOWS: rasterization, the map from scene to screen. Same layout as
 * scene-and-screen, the slide before: the screen square-on at the left, the
 * scene at the right. In the scene, the camera's eye and its image plane
 * appear in front of the box; then every point of the scene slides along its
 * line to the eye until the whole scene lies flat on the plane, and the
 * screen fills with the image that landed there.
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
 *   - colour: flat surface colour, no lighting. As the scene flattens its
 *     shading fades to that flat colour, and the screen's image is
 *     FirstHitColor, the colour of the nearest surface along each pixel's
 *     ray: the same colours (three-scene and first-hit share them), and the
 *     same image level-zero builds ray by ray later.
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
import { IndependentSampler } from '@/core/sampler/independent';
import { Film, srgbEncode } from '@/render/film';
import { renderPass } from '@/render/driver';
import { sceneToThree } from '@/viz/three-scene';
import { imagePlaneFrame } from '@/viz/image-plane';
import { FilmPanel } from '@/viz/film-panel';
import { polyline, segments, setSegments } from '@/viz/lines';
import { label } from '@/viz/text';
import { ASPECT } from '@/viz/stage';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
const SPP = 16; // antialiasing only: the image is flat colour
/** The screen, on the HUD, and the 3D view's sideways slide: as scene-and-screen. */
const SCREEN = { center: [-0.85, -0.02] as [number, number], height: 1.15 };
const SHIFT = -0.25;
const PLANE_DISTANCE = 3;
const DEPTH_KEEP = 0.03; // the flattened slab's thickness, relative to the scene's depth
const FAR = 9.5; // how far the frustum edges are drawn, from the eye
const BLANK = 18;
// Timing, seconds.
const PLANE_IN = [0.6, 1.4]; // eye, plane and frustum appear; the unseen scene is cut away
const FLATTEN = [2.0, 5.0];
const FILL = [5.2, 6.2]; // the screen takes the image
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
const uniforms = {
  uFlat: { value: 0 },
  uEye: { value: eye.clone() },
  uFwd: { value: forward.clone() },
  uD: { value: PLANE_DISTANCE },
  uK: { value: DEPTH_KEEP },
};
const lit: { mat: THREE.MeshStandardMaterial; color: THREE.Color; emissive: THREE.Color }[] = [];
sceneGroup.traverse((o) => {
  if (!(o instanceof THREE.Mesh)) return;
  const mat = o.material as THREE.MeshStandardMaterial;
  mat.clippingPlanes = frustum;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
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
  lit.push({ mat, color: mat.color.clone(), emissive: mat.emissive.clone() });
});

/** Shading fades to flat surface colour: the lit part out, the same colour as emission in. */
function setFlatColour(f: number): void {
  for (const { mat, color, emissive } of lit) {
    if (emissive.r + emissive.g + emissive.b > 0) continue; // the lamp already shows its own colour
    mat.color.copy(color).multiplyScalar(1 - f);
    mat.emissive.copy(color).multiplyScalar(f);
  }
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

let image: Uint8ClampedArray | null = null;
let shownFill = -1;

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
  shownFill = -1;
  const scene = buildScene(desc, res, res);
  const integrator = new FirstHitColor(surfaceColors(desc));
  const sampler = new IndependentSampler(0);
  const film = new Film(res, res);
  for (let s = 0; s < SPP; s++) renderPass(scene, integrator, sampler, film, s);
  image = new Uint8ClampedArray(res * res * 3);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const [r, g, b] = film.pixel(x, y);
      const o = (y * res + x) * 3;
      image[o] = srgbEncode(r);
      image[o + 1] = srgbEncode(g);
      image[o + 2] = srgbEncode(b);
    }
  }
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

  // The scene flattens onto the plane, its shading going flat as it lands.
  const f = smooth(ramp(t, FLATTEN));
  uniforms.uFlat.value = f;
  setFlatColour(f);

  // The screen takes the image.
  if (!screen || !pixels || !image) return;
  const fill = ramp(t, FILL);
  const under = Math.min(1, 24 / params.grid);
  gridLines.material.opacity = 0.999 * (1 + (under - 1) * fill);
  const key = Math.round(fill * 64);
  if (key === shownFill) return;
  shownFill = key;
  const n = params.grid * params.grid;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) pixels[o + c] = BLANK + (image[i * 3 + c]! - BLANK) * fill;
    pixels[o + 3] = 255;
  }
  screen.update(pixels);
});

stage.duration = FILL[1]! + HOLD;
stage.start();
restart();

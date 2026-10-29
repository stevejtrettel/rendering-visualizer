/**
 * SHOWS: the price of path tracing: move the camera and the picture starts
 * over. The screen at the left is a live render by plain path tracing (the
 * naive tracer of one-path: light only when a bounce happens onto the lamp),
 * so it converges slowly and noisily; at the right the box, with the camera
 * drawn in front of it (eye, image plane, frustum). Drag on the 3D side to
 * move the camera round the box (left/right) and up or down (Steve,
 * 2026-10-29); the `camera` slider does the left/right part, for the deck.
 * Every move throws the image away: it dims at once and is re-rendered from
 * nothing for the new viewpoint, noisy again, because every path starts at
 * the eye. While the camera moves, the picture never gets past noisy.
 *
 * The render runs on this page, BUDGET_MS of it a frame, a pass at a time
 * (one path per pixel), each pass visiting the pixels in a fixed scattered
 * order so it fills in as speckle rather than a wipe; a move clears it and
 * the next frame starts again (Steve, 2026-10-29: accumulate live, start
 * over instantly). A worker pool was tried first and was wrong for this: a
 * move waited for whole passes to come back from the workers, then rushed.
 *
 * The camera orbits the box's centre at the scene camera's distance, looking
 * at it, inside YAW and PITCH so it always looks in through the open front.
 * The 3D view does not orbit (drag moves the
 * camera instead); it is the screen-left layout of the slides before.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import type { SceneDescription } from '@/core/scene/scene';
import { buildScene } from '@/core/scene/scene';
import { UnidirectionalPT } from '@/core/integrators/pt';
import { IndependentSampler } from '@/core/sampler/independent';
import { pixelSeedKey } from '@/core/sampler/sampler';
import { NULL_RECORDER } from '@/trace/recorder';
import { srgbEncode } from '@/render/film';
import { vizViewFor } from '@/viz/views';
import { sceneToThree } from '@/viz/three-scene';
import { styleShortBox, lampOutline } from '@/viz/short-box';
import { imagePlaneFrame } from '@/viz/image-plane';
import { FilmPanel } from '@/viz/film-panel';
import { SCREEN, SCREEN_SHIFT } from '@/viz/screen-layout';
import { polyline, segments, setPolyline, setSegments } from '@/viz/lines';
import { label, setText } from '@/viz/text';
import { ASPECT } from '@/viz/stage';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
const RES = 320;
const MAX_SPP = 4096;
const BUDGET_MS = 12; // rendering per frame, on this page
const PLANE_DISTANCE = 3; // as the screen-left slides
const FAR = 9.5;
/** How far the camera may swing, degrees, so it always looks in through the open front. */
const YAW = 32;
const PITCH = [-12, 22];
const DRAG_DEG_PER_PX = 0.15;


// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42, controls: false });
const ui = createUI(stage);
const desc = SCENES[SCENE];
const sceneGroup = sceneToThree(desc);
stage.add(sceneGroup);
styleShortBox(stage.renderer, stage.scene, sceneGroup, desc);
stage.add(lampOutline(desc));
const view = vizViewFor(SCENE);
stage.camera.position.set(...view.eye);
stage.camera.lookAt(...view.target);
stage.shiftView(SCREEN_SHIFT);

// The scene camera, as an orbit round the point it looks at.
const base = desc.camera;
const target = new THREE.Vector3(...base.lookAt);
const radius = new THREE.Vector3(...base.eye).distanceTo(target);
const params = { camera: 0, pitch: 0 };
function cameraAt(yawDeg: number, pitchDeg: number): SceneDescription['camera'] {
  const a = THREE.MathUtils.degToRad(yawDeg);
  const e = THREE.MathUtils.degToRad(pitchDeg);
  const eye = target.clone().add(new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).multiplyScalar(radius));
  return { ...base, eye: [eye.x, eye.y, eye.z] };
}

// --- The camera, drawn ----------------------------------------------------------
const eyeDot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 12), new THREE.MeshBasicMaterial({ color: C.bone, toneMapped: false }));
const planeOutline = polyline(Array.from({ length: 5 }, () => [0, 0, 0] as [number, number, number]), { color: C.bone, width: 3 });
const toPlane = segments({ width: 2, opacity: 0.9 });
const beyond = segments({ width: 1.5, opacity: 0.3 });
stage.add(eyeDot, planeOutline, toPlane, beyond);
const solid = (n: number) => {
  const c = new THREE.Color(C.bone);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 3) c.toArray(out, i);
  return out;
};
function drawCamera(camera: SceneDescription['camera']): void {
  const f = imagePlaneFrame(camera, PLANE_DISTANCE);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) =>
    f.center.clone().addScaledVector(f.right, x! * f.halfW).addScaledVector(f.up, y! * f.halfH),
  );
  eyeDot.position.copy(f.eye);
  setPolyline(planeOutline, [...corners, corners[0]!]);
  const near: number[] = [];
  const far: number[] = [];
  for (const c of corners) {
    const end = f.eye.clone().add(c.clone().sub(f.eye).multiplyScalar(FAR / PLANE_DISTANCE));
    near.push(f.eye.x, f.eye.y, f.eye.z, c.x, c.y, c.z);
    far.push(c.x, c.y, c.z, end.x, end.y, end.z);
  }
  setSegments(toPlane, new Float32Array(near), solid(near.length));
  setSegments(beyond, new Float32Array(far), solid(far.length));
}

// --- The screen ----------------------------------------------------------------
const screen = new FilmPanel({ width: RES, height: RES, center: SCREEN.center, drawnHeight: SCREEN.height, border: false });
stage.hud.add(screen.group);
stage.hud.add(label('screen', { size: 0.08, color: C.bone, anchorX: 'center', anchorY: 'bottom', position: [SCREEN.center[0], SCREEN.center[1] + SCREEN.height / 2 + 0.05, 0] }));
const sceneLabel = label('scene', { size: 0.08, color: C.bone, anchorX: 'center', anchorY: 'bottom' });
stage.hud.add(sceneLabel);
const caption = label('', { size: 0.06, color: C.bone, anchorX: 'center', anchorY: 'top', position: [SCREEN.center[0], SCREEN.center[1] - SCREEN.height / 2 - 0.04, 0] });
stage.hud.add(caption);

// --- Rendering -----------------------------------------------------------------
const integrator = new UnidirectionalPT({ maxBounces: 8, rrStartDepth: 99, sampleNEE: false });
const sampler = new IndependentSampler(0);
let scene = buildScene({ ...desc, camera: cameraAt(0, 0) }, RES, RES);
const sum = new Float32Array(RES * RES * 3);
let pass = 0; // paths per pixel completed
let cursor = 0; // how far through the current pass
const order = Array.from({ length: RES * RES }, (_, i) => i).sort(
  (a, b) => (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) >>> 0) - (Math.imul(b ^ 0x9e3779b9, 0x85ebca6b) >>> 0),
);
const rgba = new Uint8ClampedArray(RES * RES * 4);

/** Spend BUDGET_MS on paths, then show the running average. */
function renderSome(): void {
  const until = performance.now() + BUDGET_MS;
  while (pass < MAX_SPP && performance.now() < until) {
    for (let k = 0; k < 256 && cursor < order.length; k++, cursor++) {
      const i = order[cursor]!;
      const x = i % RES;
      const y = Math.floor(i / RES);
      sampler.startPixelSample(pixelSeedKey(x, y, pass));
      for (const c of integrator.sampleContributions([x, y], sampler, scene, NULL_RECORDER)) {
        if (c.kind !== 'sample') continue;
        sum[i * 3]! += c.value.r;
        sum[i * 3 + 1]! += c.value.g;
        sum[i * 3 + 2]! += c.value.b;
      }
    }
    if (cursor >= order.length) {
      cursor = 0;
      pass++;
    }
  }
  // A pixel's average over the paths it has had: pass + 1 if this pass has
  // reached it yet, else pass. Black until it has had one.
  const reached = new Uint8Array(RES * RES);
  for (let k = 0; k < cursor; k++) reached[order[k]!] = 1;
  for (let i = 0; i < RES * RES; i++) {
    const n = pass + reached[i]!;
    const inv = n ? 1 / n : 0;
    for (let j = 0; j < 3; j++) rgba[i * 4 + j] = srgbEncode(sum[i * 3 + j]! * inv);
    rgba[i * 4 + 3] = 255;
  }
  screen.update(rgba);
  setText(caption, pass ? `${pass.toLocaleString('en-US')} path${pass === 1 ? '' : 's'} per pixel` : '');
}

/** The camera moved: draw it there, and throw the picture away. */
function moved(): void {
  const camera = cameraAt(params.camera, params.pitch);
  drawCamera(camera);
  scene = buildScene({ ...desc, camera }, RES, RES);
  sum.fill(0);
  pass = 0;
  cursor = 0;
}

ui.params.add(params, 'camera', -YAW, YAW, 0.5).onChange(moved);

// Dragging on the 3D side moves the camera.
const canvas = stage.renderer.domElement;
let dragFrom: { x: number; y: number; yaw: number; pitch: number } | null = null;
const onScreenSide = (e: PointerEvent) => {
  const r = canvas.getBoundingClientRect();
  const hx = (((e.clientX - r.left) / r.width) * 2 - 1) * ASPECT;
  return hx < SCREEN.center[0] + SCREEN.height / 2 + 0.1;
};
canvas.addEventListener('pointerdown', (e) => {
  if (onScreenSide(e)) return;
  dragFrom = { x: e.clientX, y: e.clientY, yaw: params.camera, pitch: params.pitch };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  canvas.style.cursor = dragFrom ? 'grabbing' : onScreenSide(e) ? '' : 'grab';
  if (!dragFrom) return;
  // The camera follows the hand: drag right, it moves right; drag up, it rises.
  params.camera = THREE.MathUtils.clamp(dragFrom.yaw + (e.clientX - dragFrom.x) * DRAG_DEG_PER_PX, -YAW, YAW);
  params.pitch = THREE.MathUtils.clamp(dragFrom.pitch - (e.clientY - dragFrom.y) * DRAG_DEG_PER_PX, PITCH[0]!, PITCH[1]!);
  ui.params.controllers.forEach((c) => c.updateDisplay());
  moved();
});
const endDrag = () => {
  dragFrom = null;
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

stage.frame(() => {
  renderSome();
  const ndc = new THREE.Vector3(0, 4.35, 0).project(stage.camera);
  sceneLabel.position.set(ndc.x * ASPECT, ndc.y, 0);
});

drawCamera(cameraAt(0, 0));
stage.start();

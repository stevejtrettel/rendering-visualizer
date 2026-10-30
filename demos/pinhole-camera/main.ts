/**
 * SHOWS: a pinhole camera photographing a room. The short box of Part I,
 * shaded as on every slide of that sequence (styleShortBox), and in front of
 * it a camera made a camera: a box, a pinhole in its front at the scene
 * camera's eye, the sensor on its back wall. Pixel by pixel, each pixel's
 * ray runs from the sensor through the pinhole into the room, and the pixel
 * takes the colour of what that ray sees. The image lands on the sensor
 * turned half round, as a pinhole's does; the screen at the left (the
 * screen-left layout of Part I) shows it the right way up.
 *
 * Steve, 2026-10-29: a normal three.js scene rather than the pixelated
 * stored light field of light-field-pinhole (rendering-talk-visuals); render
 * the scene well, then literally image it with a pinhole camera.
 *
 * What the image is, honestly: the room as three.js draws it (a raster
 * preview, not the light transport), seen from the pinhole. It is rendered
 * once at exactly the screen's resolution, with no antialiasing, so each
 * pixel is the one ray through the pinhole and the pixel's centre; through
 * the same tone curve (ACES, applied here by hand, since three applies it
 * only on the way to the canvas) and sRGB encoding as the view beside it.
 * For the capture the near green wall is made solid (on the slides it is
 * drawn translucent so we can see in; the camera should see a wall) and the
 * camera's own drawing is hidden: the camera is not in the scene.
 *
 * Drag to turn the 3D view round (orbit controls), as on the Part I slides.
 *
 * The scan starts one ray at a time and speeds up (pixels done grow as the
 * cube of the time), with the latest rays trailing behind it; the rays clear
 * once the image is done, and the figure holds it.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { sceneToThree } from '@/viz/three-scene';
import { styleShortBox } from '@/viz/short-box';
import { imagePlaneFrame } from '@/viz/image-plane';
import { FilmPanel } from '@/viz/film-panel';
import { SCREEN, BLANK } from '@/viz/screen-layout';
import { polyline, setPolyline } from '@/viz/lines';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
/** Pinhole to sensor, world units. */
const SENSOR_DISTANCE = 1.1;
/** The 3D view pulled back from Part I's, and slid less far, so the camera's box clears the screen. */
const PULL_BACK = 1.15;
const SHIFT = -0.17;
// Timing, seconds.
const LOAD = [1.5, 10.5]; // first pixel to last
const RAY_FADE = 1.2;
const HOLD = 3;
const TRAIL = 40; // rays drawn behind the scan

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });
const ui = createUI(stage);

const desc = SCENES[SCENE];
const sceneGroup = sceneToThree(desc);
stage.add(sceneGroup);
styleShortBox(stage.renderer, stage.scene, sceneGroup, desc);
const view = vizViewFor(SCENE);
const viewTarget = new THREE.Vector3(...view.target);
stage.camera.position.set(...view.eye).sub(viewTarget).multiplyScalar(PULL_BACK).add(viewTarget);
stage.controls?.target.copy(viewTarget);
stage.controls?.update();
stage.shiftView(SHIFT);

// --- The camera: pinhole, box, sensor ----------------------------------------------
const frame = imagePlaneFrame(desc.camera, SENSOR_DISTANCE); // the plane in front; the sensor is its reflection through the pinhole
const eye = frame.eye;
const through = (p: THREE.Vector3) => eye.clone().multiplyScalar(2).sub(p);
const onPlane = (fx: number, fy: number) =>
  frame.center.clone().addScaledVector(frame.right, fx * frame.halfW).addScaledVector(frame.up, fy * frame.halfH);

const cameraGroup = new THREE.Group();
stage.add(cameraGroup);
const pinhole = new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 12), new THREE.MeshBasicMaterial({ color: C.bone, toneMapped: false }));
pinhole.position.copy(eye);
cameraGroup.add(pinhole);
{
  const M = 1.08; // the box a little larger than the sensor
  const back = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => through(onPlane(x! * M, y! * M)).addScaledVector(frame.forward, -0.03));
  const front = back.map((p) => p.clone().addScaledVector(frame.forward, SENSOR_DISTANCE + 0.03));
  const edge = (pts: THREE.Vector3[]) => cameraGroup.add(polyline(pts, { color: C.bone, width: 3 }));
  edge([...back, back[0]!]);
  edge([...front, front[0]!]);
  for (let k = 0; k < 4; k++) edge([back[k]!, front[k]!]);
}

// --- The image ------------------------------------------------------------------------
const params = { grid: 24 };
let res = params.grid;
/** The photograph, sRGB bytes, rows bottom to top (as read back; also the sensor's texture order). */
let shot = new Uint8ClampedArray(0);
/** Where each pixel's ray lands, world units, raster order (row 0 at the top). */
let hits: THREE.Vector3[] = [];

const aces = (() => {
  const fit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const srgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  return (r: number, g: number, b: number, exposure: number): [number, number, number] => {
    const k = exposure / 0.6;
    r *= k;
    g *= k;
    b *= k;
    const x = fit(0.59719 * r + 0.35458 * g + 0.04823 * b);
    const y = fit(0.076 * r + 0.90834 * g + 0.01566 * b);
    const z = fit(0.0284 * r + 0.13383 * g + 0.83777 * b);
    const out = [1.60475 * x - 0.53108 * y - 0.07367 * z, -0.10208 * x + 1.10813 * y - 0.00605 * z, -0.00327 * x - 0.07276 * y + 1.07602 * z];
    return out.map((c) => Math.round(255 * srgb(Math.min(1, Math.max(0, c))))) as [number, number, number];
  };
})();

/** Photograph the room from the pinhole, at res × res, one ray per pixel. */
function photograph(): void {
  const r = stage.renderer;
  const cam = new THREE.PerspectiveCamera(desc.camera.fovDegrees, 1, 0.01, 100);
  cam.position.copy(eye);
  cam.up.copy(frame.up);
  cam.lookAt(frame.center);
  const target = new THREE.WebGLRenderTarget(res, res, { type: THREE.FloatType, samples: 0 });
  const wall = (sceneGroup.children[desc.primitives.findIndex((p) => p.name === 'right')] as THREE.Mesh).material as THREE.MeshStandardMaterial;
  const saved = { transparent: wall.transparent, opacity: wall.opacity, depthWrite: wall.depthWrite };
  Object.assign(wall, { transparent: false, opacity: 1, depthWrite: true });
  const shown = stage.scene.children.filter((o) => o.visible && o !== sceneGroup && !(o instanceof THREE.Light));
  for (const o of shown) o.visible = false;
  r.setRenderTarget(target);
  r.render(stage.scene, cam);
  r.setRenderTarget(null);
  for (const o of shown) o.visible = true;
  Object.assign(wall, saved);
  const raw = new Float32Array(res * res * 4);
  r.readRenderTargetPixels(target, 0, 0, res, res, raw);
  target.dispose();
  shot = new Uint8ClampedArray(res * res * 4);
  for (let i = 0; i < res * res; i++) {
    const [R, G, B] = aces(raw[i * 4]!, raw[i * 4 + 1]!, raw[i * 4 + 2]!, r.toneMappingExposure);
    shot.set([R, G, B, 255], i * 4);
  }
  // The rays: through the pinhole and each pixel's centre, to what they hit.
  const ray = new THREE.Raycaster();
  const meshes = sceneGroup.children.filter((o) => o instanceof THREE.Mesh);
  hits = [];
  for (let py = 0; py < res; py++) {
    for (let px = 0; px < res; px++) {
      const p = onPlane(((px + 0.5) / res) * 2 - 1, 1 - ((py + 0.5) / res) * 2);
      ray.set(eye, p.clone().sub(eye).normalize());
      const h = ray.intersectObjects(meshes, false)[0];
      hits.push(h ? h.point : p.clone().sub(eye).multiplyScalar(6).add(eye));
    }
  }
}

// The sensor: the image as it lands, turned half round (the plane reflected through the pinhole).
let sensorTex: THREE.DataTexture | null = null;
const sensor = new THREE.Mesh(new THREE.PlaneGeometry(2 * frame.halfW, 2 * frame.halfH), new THREE.MeshBasicMaterial({ toneMapped: false, side: THREE.DoubleSide }));
sensor.position.copy(through(frame.center));
sensor.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(frame.right.clone().negate(), frame.up.clone().negate(), frame.forward.clone().negate()));
cameraGroup.add(sensor);
const sensorBytes = () => new Uint8Array(res * res * 4);
let sensorData = sensorBytes();

// The screen, square-on at the left: the image the right way up, without pixel
// lines (Steve: the pixels are big enough to read as pixels).
let screen: FilmPanel | null = null;
let screenPixels = new Uint8ClampedArray(0);
const rays = Array.from({ length: TRAIL }, () => {
  const l = polyline([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], { color: C.bone, width: 2, opacity: 0.9 });
  l.visible = false;
  cameraGroup.add(l);
  return l;
});

function rebuild(): void {
  res = params.grid;
  photograph();
  screen?.dispose();
  screen = new FilmPanel({ width: res, height: res, center: SCREEN.center, drawnHeight: SCREEN.height, border: false });
  stage.hud.add(screen.group);
  screenPixels = new Uint8ClampedArray(res * res * 4);
  sensorData = sensorBytes();
  sensorTex?.dispose();
  sensorTex = new THREE.DataTexture(sensorData, res, res, THREE.RGBAFormat);
  sensorTex.colorSpace = THREE.SRGBColorSpace;
  sensorTex.magFilter = sensorTex.minFilter = THREE.NearestFilter;
  (sensor.material as THREE.MeshBasicMaterial).map = sensorTex;
  (sensor.material as THREE.MeshBasicMaterial).needsUpdate = true;
  shownCount = -1;
}
ui.params.add(params, 'grid', 2, 64, 1).name('film resolution').onChange(rebuild);

// --- Playback ----------------------------------------------------------------------------
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => clamp01(x) ** 2 * (3 - 2 * clamp01(x));
/** The pixel (raster order) shown the colour of photo row py, column px. */
const shotAt = (px: number, py: number) => ((res - 1 - py) * res + px) * 4;
let shownCount = -1;

stage.frame((t) => {
  const n = res * res;
  const u = clamp01((t - LOAD[0]!) / (LOAD[1]! - LOAD[0]!));
  const done = Math.floor(n * u ** 3);
  if (done !== shownCount) {
    shownCount = done;
    for (let i = 0; i < n; i++) {
      const px = i % res;
      const py = (i - px) / res;
      const s = shotAt(px, py);
      const on = i < done;
      for (let c = 0; c < 3; c++) {
        screenPixels[i * 4 + c] = on ? shot[s + c]! : BLANK;
        sensorData[s + c] = on ? shot[s + c]! : BLANK;
      }
      screenPixels[i * 4 + 3] = sensorData[s + 3] = 255;
    }
    screen?.update(screenPixels);
    if (sensorTex) sensorTex.needsUpdate = true;
  }
  // The latest rays, fading with age; all of them clear once the image is done.
  const fade = 1 - smooth((t - LOAD[1]!) / RAY_FADE);
  for (let j = 0; j < TRAIL; j++) {
    const i = done - 1 - j;
    const l = rays[j]!;
    l.visible = i >= 0 && fade > 0.002;
    if (!l.visible) continue;
    const px = i % res;
    const py = (i - px) / res;
    const s = shotAt(px, py);
    setPolyline(l, [through(onPlane(((px + 0.5) / res) * 2 - 1, 1 - ((py + 0.5) / res) * 2)), eye, hits[i]!]);
    const m = l.material as THREE.Material & { opacity: number; color: THREE.Color };
    const c = new THREE.Color().setRGB(shot[s]! / 255, shot[s + 1]! / 255, shot[s + 2]! / 255, THREE.SRGBColorSpace);
    const k = Math.max(c.r, c.g, c.b, 1e-4);
    m.color.copy(c.multiplyScalar(Math.min(1, 1.1 / k)));
    m.opacity = 0.9 * (1 - j / TRAIL) ** 1.6 * fade;
  }
});

stage.duration = LOAD[1]! + RAY_FADE + HOLD;
stage.start();
rebuild();

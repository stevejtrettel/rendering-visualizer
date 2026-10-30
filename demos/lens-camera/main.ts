/**
 * SHOWS: a camera whose pixel gathers the light of many rays and keeps their
 * average. The pinhole camera of pinhole-camera with a lens where the pinhole
 * was: one pixel on the sensor, and through points all over the lens, one ray
 * each from that pixel out into the room, drawn in the colour of the light it
 * brings back. The pixel, large at the left, takes the colour of their running
 * average. Steve, 2026-10-29: teach that a camera's gathering step can be an
 * integral, an accumulation, across a lens; nothing about focal planes. The
 * slides before have a pixel turn a spectrum into a colour; this one is only
 * about which light reaches the pixel, so the spectra are not drawn (each ray
 * carries one, as the audience knows).
 *
 * ?gather=spectra: the first version, with a graph at the left drawing each
 * ray's spectrum as it arrives and the pixel's, their average, bold. The
 * colour is the same either way: turning a spectrum into a colour is linear,
 * so the colour of the average spectrum is the average of the colours.
 *
 * What is computed, honestly: each ray's spectrum is the light arriving along
 * that exact ray in a spectral version of the short box (real light transport,
 * wavelength by wavelength: scripts/bake-lens-spectra.ts, and the reflectance
 * and lamp spectra in scripts/spectral-scene.ts), baked into
 * src/data/lens-spectra.json. The rays and the pixel are src/viz/lens-camera.ts,
 * shared with the bake: a thin lens sends every ray from the pixel through one
 * point in front of it, set short of the scene so the rays spread over the
 * white ball's edge and the red wall behind it and bring back different
 * spectra. The average is an average over the lens points (a sunflower spiral,
 * evenly spread), which is the integral over the lens of the pixel, sampled.
 *
 * Readability: the lens is large, so the fan of rays is wide enough to see;
 * colours are exposed so the brightest ray's spectrum is near white. Drag to
 * turn the 3D view.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { sceneToThree } from '@/viz/three-scene';
import { styleShortBox } from '@/viz/short-box';
import { polyline, setPolyline } from '@/viz/lines';
import { label } from '@/viz/text';
import { toXYZ, xyzToSrgb, nmSrgb } from '@/viz/spectra';
import { LENS_CENTRE, FORWARD, UP, RIGHT, FOV_DEGREES, SENSOR_DISTANCE, LENS_RADIUS, PIXEL, K, lensRay } from '@/viz/lens-camera';
import LENS from '@/data/lens-spectra.json';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
const PULL_BACK = 1.15; // the pinhole slide's view
const SHIFT = -0.17;
// Timing, seconds.
const RAYS = [1.5, 13]; // first ray to last
const HOLD = 3;
/** The graph, HUD units (x in [-ASPECT, ASPECT], y in [-1, 1]). */
const G = { x0: -1.62, x1: -0.42, y0: -0.42, y1: 0.42 };
/** ?gather=spectra: draw the spectra the rays bring back, and their average, as they accumulate. */
const GATHER_SPECTRA = new URLSearchParams(location.search).get('gather') === 'spectra';

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

// --- The camera: lens, box, sensor, pixel ---------------------------------------------
const V3 = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]);
const centre = V3(LENS_CENTRE);
const forward = V3(FORWARD);
const up = V3(UP);
const right = V3(RIGHT);
const half = SENSOR_DISTANCE * Math.tan((FOV_DEGREES * Math.PI) / 360); // the sensor's half-size, as the pinhole camera's
{
  const M = 1.08;
  const back = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) =>
    centre.clone().addScaledVector(forward, -SENSOR_DISTANCE - 0.03).addScaledVector(right, x! * half * M).addScaledVector(up, y! * half * M),
  );
  const front = back.map((p) => p.clone().addScaledVector(forward, SENSOR_DISTANCE + 0.03));
  const edge = (pts: THREE.Vector3[], color: number = C.bone, width = 3) => stage.add(polyline(pts, { color, width }));
  edge([...back, back[0]!]);
  edge([...front, front[0]!]);
  for (let k = 0; k < 4; k++) edge([back[k]!, front[k]!]);
  // The lens: a disc in the front face.
  const ring = Array.from({ length: 65 }, (_, k) => {
    const a = (2 * Math.PI * k) / 64;
    return centre.clone().addScaledVector(right, LENS_RADIUS * Math.cos(a)).addScaledVector(up, LENS_RADIUS * Math.sin(a));
  });
  edge(ring, C.blue, 3);
  const glass = new THREE.Mesh(
    new THREE.CircleGeometry(LENS_RADIUS, 64),
    new THREE.MeshBasicMaterial({ color: C.blue, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
  );
  glass.position.copy(centre);
  glass.lookAt(centre.clone().add(forward));
  stage.add(glass);
}
// The sensor's outline and the one pixel on it.
const PIX = (2 * half) / 24; // a pixel of the pinhole slide's 24 × 24
const pixelMat = new THREE.MeshBasicMaterial({ color: 0x121212, side: THREE.DoubleSide, toneMapped: false });
const pixel = new THREE.Mesh(new THREE.PlaneGeometry(PIX * 1.6, PIX * 1.6), pixelMat);
pixel.position.copy(V3(PIXEL));
pixel.lookAt(V3(PIXEL).add(forward));
stage.add(pixel);
stage.add(polyline(
  [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([x, y]) => centre.clone().addScaledVector(forward, -SENSOR_DISTANCE).addScaledVector(right, x! * half).addScaledVector(up, y! * half)),
  { color: C.slate, width: 1.5 },
));

// --- The rays and their spectra ----------------------------------------------------------
const NM = LENS.nm as number[];
const spectra = (LENS.spectra as number[][]).slice(0, K);
const peak = Math.max(...spectra.map((s) => toXYZ(s, NM)[1]));
const EXPOSURE = 0.95 / peak;
const colourOf = (s: ArrayLike<number>) => {
  const [X, Y, Z] = toXYZ(s, NM);
  const [r, g, b] = xyzToSrgb(X * EXPOSURE, Y * EXPOSURE, Z * EXPOSURE);
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
};
const rayColours = spectra.map(colourOf);

const meshes = sceneGroup.children.filter((o) => o instanceof THREE.Mesh);
const caster = new THREE.Raycaster();
const rayLines = Array.from({ length: K }, (_, k) => {
  const { origin, dir } = lensRay(k);
  caster.set(V3(origin), V3(dir));
  const hit = caster.intersectObjects(meshes, false)[0]?.point ?? V3(origin).addScaledVector(V3(dir), 8);
  const l = polyline([V3(PIXEL), V3(origin), hit], { color: rayColours[k]!.getHex(), width: 2.5, opacity: 0.9 });
  l.visible = false;
  stage.add(l);
  return l;
});

// The graph (?gather=spectra only): each ray's spectrum, thin, in its colour;
// the pixel's, their average, bold.
const graph = new THREE.Group();
graph.visible = GATHER_SPECTRA;
stage.hud.add(graph);
const SMAX = Math.max(...spectra.flat()) * 1.05;
const gx = (nm: number) => G.x0 + ((nm - NM[0]!) / (NM[NM.length - 1]! - NM[0]!)) * (G.x1 - G.x0);
const gy = (v: number) => G.y0 + (v / SMAX) * (G.y1 - G.y0);
const curvePts = (s: ArrayLike<number>) => NM.map((nm, i) => [gx(nm), gy(s[i]!), 0] as [number, number, number]);
graph.add(polyline([[G.x0, G.y0, 0], [G.x1, G.y0, 0]], { color: C.slateDeep, width: 2 }));
for (const nm of [400, 500, 600, 700]) {
  graph.add(polyline([[gx(nm), G.y0 - 0.025, 0], [gx(nm), G.y0, 0]], { color: C.slateDeep, width: 2 }));
  graph.add(label(String(nm), { size: 0.045, color: C.slate, anchorX: 'center', anchorY: 'top', position: [gx(nm), G.y0 - 0.08, 0] }));
}
for (let i = 0; i < 120; i++) {
  const nm = 400 + (300 * (i + 0.5)) / 120;
  const [r, g, b] = nmSrgb(nm);
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(((G.x1 - G.x0) / 120) * 1.03, 0.025), new THREE.MeshBasicMaterial({ toneMapped: false }));
  strip.material.color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  strip.position.set(gx(nm), G.y0 - 0.04, 0);
  graph.add(strip);
}
graph.add(label('Spectrum', { size: 0.055, color: C.ash, anchorX: 'center', anchorY: 'top', position: [(G.x0 + G.x1) / 2, G.y0 - 0.15, 0] }));
const thin = spectra.map((s, k) => {
  const l = polyline(curvePts(s), { color: rayColours[k]!.getHex(), width: 1.5, opacity: 0.6 });
  l.visible = false;
  graph.add(l);
  return l;
});
const mean = polyline(curvePts(new Array(NM.length).fill(0)), { color: C.bone, width: 4.5 });
mean.position.z = 0.01;
graph.add(mean);
const swatchMat = new THREE.MeshBasicMaterial({ color: 0x121212, toneMapped: false });
// The pixel, large: beside the graph when it is drawn, on its own otherwise.
const swatch = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), swatchMat);
if (GATHER_SPECTRA) swatch.position.set(G.x1 - 0.1, G.y1 + 0.2, 0);
else {
  swatch.scale.setScalar(2.4);
  swatch.position.set(-1.0, -0.05, 0);
}
stage.hud.add(swatch);

// --- Playback ----------------------------------------------------------------------------
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
let shown = -1;
stage.frame((t) => {
  // The first rays one at a time, slowly; then faster (the count grows as a power of the time).
  const n = Math.min(K, Math.floor(K * clamp01((t - RAYS[0]!) / (RAYS[1]! - RAYS[0]!)) ** 1.7 + (t >= RAYS[0]! ? 1 : 0)));
  if (n === shown) return;
  shown = n;
  for (let k = 0; k < K; k++) {
    const on = k < n;
    const newest = k === n - 1;
    rayLines[k]!.visible = thin[k]!.visible = on;
    (rayLines[k]!.material as THREE.Material & { opacity: number }).opacity = newest && n < K ? 1 : 0.45;
    (thin[k]!.material as THREE.Material & { opacity: number }).opacity = newest && n < K ? 1 : 0.4;
  }
  mean.visible = n > 0;
  if (n === 0) {
    swatchMat.color.setHex(0x121212);
    pixelMat.color.setHex(0x121212);
    return;
  }
  const avg = NM.map((_, i) => spectra.slice(0, n).reduce((a, s) => a + s[i]!, 0) / n);
  setPolyline(mean, curvePts(avg));
  const c = colourOf(avg);
  swatchMat.color.copy(c);
  pixelMat.color.copy(c);
});

stage.duration = RAYS[1]! + HOLD;
void ui;
stage.start();

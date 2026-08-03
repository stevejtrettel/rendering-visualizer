// SHOWS: one complete transport path as a physical object in the scene. A
// single long light walk — thrown from the lamp, wandering the box for
// LIGHT_BOUNCES bounces, its last vertex connecting cleanly to the pinhole —
// built as tube geometry and rendered, scene and path together, with
// three-gpu-pathtracer. This is tier 3 of docs/design-viz.md ("a path-traced
// movie of path tracing"), proven here as a converging still: the first page
// to import the package at all.
//
// The one control is WHAT LIGHTS THE ROOM:
//   'path' — the walk itself glows and carries the illumination (the lamp is
//            dimmed to a whisper); stylized, and slower to converge because
//            the tubes' own glow is unsampled;
//   'lamp' — the ceiling emitter lights the room at its true radiance
//            through a sampled RectAreaLight, and the path is plain colored
//            geometry; fully sampled, so it converges fast.
//
// The path is the BDPT t = 1 family (light tracing) on one deterministic
// sample: the seeded scan below always lands on the same walk.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { SCENES, vizViewFor, type SceneName } from '../_shared/scenes';
import { buildScene } from '../../src/core/scene/scene';
import { IndependentSampler } from '../../src/core/sampler/independent';
import { pixelSeedKey } from '../../src/core/sampler/sampler';
import { BDPT } from '../../src/core/integrators/bdpt';
import { ArrayRecorder, type PathRecord } from '../../src/trace/records';
import { sceneToBeautyThree } from '../../src/viz/three-scene';
import { brightness, segmentColor } from '../../src/viz/path-elements';
import type { Tuple3 } from '../../src/trace/records';

// --- Figure spec ---
const SCENE_NAME: SceneName = 'cornell';
const FILM = 160;
const SEED = 0;
// The walk's length: LIGHT_BOUNCES + 1 vertices, the lamp point included.
// Roulette is off — a LONG path is the whole subject — so only absorption on
// the (black-albedo) emitter can end a walk early; the scan skips those.
const LIGHT_BOUNCES = 8;
const NO_RR = 999;
const SCAN_LIMIT = 4096;
// Light tracing is not driven by a pixel; the pixel is only a seed-key
// ingredient, held fixed (same convention as light-swarm).
const KEY_PIXEL = [0, 0] as const;
// Tubes: radius in world units (the box is 4 wide), scaled by throughput.
const TUBE_RADIUS = 0.025;
const JOINT_RADIUS = 0.05;
const CONNECTION_COLOR = 0x44cc66; // design language: a clear connection is green
const CONNECTION_RADIUS = 0.018;
// 'path' mode — "the room is lit by the path": the scene's own lamp is
// dimmed to a fraction of its CPU radiance, the tubes glow, and the real
// illumination comes from a sampleable PointLight at each path vertex (the
// tracer has no NEE for emissive meshes, so the tubes' glow cannot light the
// room noiselessly — delta point lights can). Stylized by design; the CPU
// renderer stays the physical ground truth.
const TUBE_EMISSIVE = 2.0; // the tubes' own visible glow — decorative
const EMITTER_SCALE = 0.05; // lamp at 5% of its CPU radiance
const PATH_LIGHT_INTENSITY = 0.6; // per-vertex, inverse-square units; by eye
// The vertex lights float this far off the surface along the normal —
// clear of the joint sphere and tube mouths, which would otherwise
// swallow every shadow ray sent to a light buried inside them.
const PATH_LIGHT_OFFSET = 0.12;
// 'lamp' mode — the ceiling emitter at TRUE radiance via the sampled
// RectAreaLight; the path is plain colored geometry lit like everything
// else. The visible lamp face stays at a dim cosmetic emission: face
// emission is unsampled, and at full radiance it alone would re-create the
// slow convergence the RectAreaLight exists to fix.
const LAMP_FACE_SCALE = 0.15;
const MATTE_TUBE_ROUGHNESS = 0.35;
// Path tracer.
const PT_BOUNCES = 8;
const TILES = 2; // 2×2 tiles keep orbiting responsive
const EXPOSURE = 1.0;
const VIEW_W = 900;
const VIEW_H = 620;

type Mode = 'path' | 'lamp';
const MODES: ReadonlyArray<{ id: Mode; label: string }> = [
  { id: 'path', label: 'lit by the path' },
  { id: 'lamp', label: 'lit by the lamp' },
];

const description = SCENES[SCENE_NAME];
const view = vizViewFor(SCENE_NAME);
const infoEl = document.getElementById('info')!;

// --- Tracing: find THE path ---
const scene = buildScene(description, FILM, FILM);
const sampler = new IndependentSampler(SEED);
const integrator = new BDPT({
  maxBounces: LIGHT_BOUNCES,
  rrStartDepth: NO_RR,
  strategyFilter: (_s, t) => t === 1,
});

function traced(sampleIndex: number): PathRecord {
  const key = pixelSeedKey(KEY_PIXEL[0], KEY_PIXEL[1], sampleIndex);
  sampler.startPixelSample(key);
  const recorder = new ArrayRecorder();
  recorder.beginPath(key);
  integrator.sampleContributions(KEY_PIXEL, sampler, scene, recorder);
  recorder.endPath();
  return recorder.records[0]!;
}

// First sample whose walk reaches the full length AND whose last vertex sees
// the pinhole. Deterministic under the seeded RNG: always the same walk.
function pickSample(): { index: number; record: PathRecord } | null {
  for (let i = 0; i < SCAN_LIMIT; i++) {
    const record = traced(i);
    if (record.lightVertices.length !== LIGHT_BOUNCES + 1) continue;
    const closes = record.connections.some((c) => c.s === LIGHT_BOUNCES + 1 && !c.occluded);
    if (closes) return { index: i, record };
  }
  return null;
}

const picked = pickSample();
if (!picked) {
  infoEl.textContent =
    `no sample in the first ${SCAN_LIMIT} reaches ${LIGHT_BOUNCES} bounces with a clear ` +
    `connection — loosen LIGHT_BOUNCES or raise SCAN_LIMIT`;
  throw new Error('no qualifying light path');
}
const { index: SAMPLE_FOUND, record } = picked;

// --- The path as geometry ---
const v3 = (t: Tuple3) => new THREE.Vector3(t[0], t[1], t[2]);
const luminance = (c: Tuple3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// Glowing in 'path' mode; plain colored geometry, lit by the lamp, in 'lamp'.
function pathMaterial(color: THREE.Color, mode: Mode): THREE.MeshStandardMaterial {
  return mode === 'path'
    ? new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: TUBE_EMISSIVE, roughness: 0.4 })
    : new THREE.MeshStandardMaterial({ color, roughness: MATTE_TUBE_ROUGHNESS });
}

function tube(a: Tuple3, b: Tuple3, radius: number, color: THREE.Color, mode: Mode): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.LineCurve3(v3(a), v3(b)), 1, radius, 12),
    pathMaterial(color, mode),
  );
}

function pathGroup(mode: Mode): THREE.Group {
  const group = new THREE.Group();
  const vs = record.lightVertices;
  for (let k = 1; k < vs.length; k++) {
    const arriving = vs[k]!;
    const b = brightness(luminance(arriving.beta));
    const color = segmentColor(luminance(arriving.beta), arriving.delta, 'light');
    group.add(tube(vs[k - 1]!.p, arriving.p, TUBE_RADIUS * (0.6 + 0.6 * b), color, mode));
  }
  for (let k = 0; k < vs.length; k++) {
    const vtx = vs[k]!;
    // The lamp point warm white; scattering vertices in the cyan family.
    const color = k === 0 ? new THREE.Color(0xfff0c8) : segmentColor(luminance(vtx.beta), vtx.delta, 'light');
    const joint = new THREE.Mesh(new THREE.SphereGeometry(JOINT_RADIUS, 16, 12), pathMaterial(color, mode));
    joint.position.copy(v3(vtx.p));
    group.add(joint);
    if (mode === 'path') {
      // The vertex's sampleable stand-in: the pool of colored light the
      // glowing path throws on the nearby walls, offset off the surface so
      // the joint and tube geometry don't shadow it.
      const light = new THREE.PointLight(color, PATH_LIGHT_INTENSITY);
      light.position.copy(v3(vtx.p)).addScaledVector(v3(vtx.ns), PATH_LIGHT_OFFSET);
      group.add(light);
    }
  }
  // The closing connection: last light vertex straight to the pinhole, green.
  const connection = record.connections.find((c) => c.s === LIGHT_BOUNCES + 1 && !c.occluded)!;
  group.add(tube(connection.to, connection.from, CONNECTION_RADIUS, new THREE.Color(CONNECTION_COLOR), mode));
  return group;
}

// A small camera at the pinhole, so the green segment lands on something:
// a dark body with a lens barrel facing down the view axis (+z of the glyph).
function cameraGlyph(): THREE.Group {
  const glyph = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.5, metalness: 0.3 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.34), dark);
  glyph.add(body);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.14, 24), dark);
  lens.rotation.x = Math.PI / 2;
  lens.position.z = 0.24;
  glyph.add(lens);
  glyph.position.copy(v3(description.camera.eye as unknown as Tuple3));
  glyph.lookAt(v3(description.camera.lookAt as unknown as Tuple3));
  return glyph;
}

function buildThreeScene(mode: Mode): THREE.Scene {
  const s = new THREE.Scene();
  s.background = new THREE.Color(0x050505);
  s.add(
    mode === 'path'
      ? sceneToBeautyThree(description, { emitterScale: EMITTER_SCALE })
      : sceneToBeautyThree(description, { emitterScale: 1, faceEmissiveScale: LAMP_FACE_SCALE }),
  );
  s.add(pathGroup(mode));
  s.add(cameraGlyph());
  return s;
}

function disposeScene(s: THREE.Scene): void {
  s.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
}

// --- three.js + path tracer ---
// NO preserveDrawingBuffer: a severe frame-rate hit on macOS ANGLE/Metal;
// save PNG re-renders synchronously before reading the canvas back.
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(VIEW_W, VIEW_H);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE;
document.getElementById('viz-pane')!.appendChild(renderer.domElement);

// LTC tables for the raster fallback's RectAreaLight shading (the path
// tracer has its own sampler and doesn't need them).
RectAreaLightUniformsLib.init();

const threeCamera = new THREE.PerspectiveCamera(45, VIEW_W / VIEW_H, 0.01, 100);
threeCamera.position.set(...view.eye);

// Orient the camera BEFORE setScene snapshots it: orbit.update() applies the
// target, and setScene's internal updateCamera picks the final view up.
const orbit = new OrbitControls(threeCamera, renderer.domElement);
orbit.target.set(...view.target);
orbit.update();

let mode: Mode = 'path';
let threeScene = buildThreeScene(mode);

const pathTracer = new WebGLPathTracer(renderer);
pathTracer.bounces = PT_BOUNCES;
pathTracer.filterGlossyFactor = 0.5;
pathTracer.tiles.set(TILES, TILES);
pathTracer.setScene(threeScene, threeCamera);

orbit.addEventListener('change', () => pathTracer.updateCamera());

// --- The switch (the page's subject: what lights the room) ---
function setMode(next: Mode): void {
  mode = next;
  disposeScene(threeScene);
  threeScene = buildThreeScene(mode);
  pathTracer.setScene(threeScene, threeCamera);
}

const switchEl = document.getElementById('switch')!;
const buttons = MODES.map((spec) => {
  const b = document.createElement('button');
  b.textContent = spec.label;
  b.setAttribute('aria-pressed', String(spec.id === mode));
  b.addEventListener('click', () => {
    setMode(spec.id);
    for (const [i, other] of buttons.entries()) {
      other.setAttribute('aria-pressed', String(MODES[i]!.id === mode));
    }
  });
  switchEl.appendChild(b);
  return b;
});

document.getElementById('save')!.addEventListener('click', () => {
  pathTracer.renderSample(); // fresh buffer for the read-back
  const a = document.createElement('a');
  a.download = `light-path-beauty-${mode}-${SAMPLE_FOUND}-${Math.round(pathTracer.samples)}spp.png`;
  a.href = renderer.domElement.toDataURL('image/png');
  a.click();
});

renderer.setAnimationLoop(() => {
  pathTracer.renderSample();
  infoEl.textContent =
    `one light path · ${LIGHT_BOUNCES} bounces, lamp → box → pinhole · ` +
    `sample ${SAMPLE_FOUND} of seed ${SEED} (first of ${SCAN_LIMIT} to run full length and ` +
    `see the camera) · ${Math.round(pathTracer.samples)} samples accumulated`;
});

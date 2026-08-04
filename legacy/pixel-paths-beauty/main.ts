// SHOWS: everything that feeds one pixel. NUM_PATHS unidirectional walks
// through one fixed pixel — the renderer's real sampling: BSDF-only, roulette
// from depth RR_START — drawn as matte tube strands fanning from the pinhole.
// The population IS the estimator: most strands die dark, the few that end on
// the lamp are the samples that carried this pixel's light.
//
// Render modes (mirrors the studio pattern in Steve's elliptic-curve-viz):
// the page STARTS as a plain three.js raster preview — instant, orbitable —
// and only builds the WebGLPathTracer when the switch asks for it. The matte
// strands + sampled-lamp configuration is the one that scales to many paths:
// the paths are plain geometry, so path count costs BVH size, not noise
// (unlike light-path-beauty's glowing mode, whose emissive tubes are
// unsampled light).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { SCENES, type SceneName } from '../../src/scenes/registry';
import { vizViewFor } from '../../src/viz/views';
import { buildScene } from '../../src/core/scene/scene';
import { IndependentSampler } from '../../src/core/sampler/independent';
import { pixelSeedKey } from '../../src/core/sampler/sampler';
import { UnidirectionalPT } from '../../src/core/integrators/pt';
import { ArrayRecorder, type PathRecord } from '../../src/trace/records';
import { sceneToBeautyThree } from '../../src/viz/three-scene';
import { brightness, segmentColor } from '../../src/viz/path-elements';
import type { Tuple3 } from '../../src/trace/records';

// --- Figure spec ---
const SCENE_NAME: SceneName = 'cornell';
const FILM = 160;
const SEED = 0;
const PIXEL = [88, 118] as const; // the floor, in front of the spheres (as path-swarm)
const NUM_PATHS = 50;
// The renderer's REAL walk settings — this page shows the sampled population,
// deaths included, not an idealized one (contrast: path-strategies turns
// roulette off because there it would wreck a comparison).
const MAX_BOUNCES = 8;
const RR_START = 3;
// Tubes: thin — fifty strands share the box.
const TUBE_RADIUS = 0.012;
const JOINT_RADIUS = 0.028;
// Lamp-lit beauty configuration (the scalable one): emitter at true radiance
// through the sampled RectAreaLight, strands as plain matte geometry. The
// visible lamp face stays at a dim cosmetic emission — its emission is
// unsampled, and at full radiance it alone would drag convergence back down.
const LAMP_FACE_SCALE = 0.15;
const MATTE_TUBE_ROUGHNESS = 0.35;
// Raster-preview helpers, zeroed while the path tracer runs.
const PREVIEW_AMBIENT = 0.35;
const PREVIEW_POINT = 20;
// Path tracer. 5 bounces, not 8: ~35% cheaper per sample and visually near
// identical in this box (see depth-sweep — little image survives depth 4).
const PT_BOUNCES = 5;
const TILES = 2;
const EXPOSURE = 1.0;
const VIEW_W = 900;
const VIEW_H = 620;

type Mode = 'live' | 'trace';
const MODES: ReadonlyArray<{ id: Mode; label: string }> = [
  { id: 'live', label: 'live preview' },
  { id: 'trace', label: 'path traced' },
];

const description = SCENES[SCENE_NAME];
const view = vizViewFor(SCENE_NAME);
const infoEl = document.getElementById('info')!;

// --- Tracing: the pixel's sample population ---
const scene = buildScene(description, FILM, FILM);
const sampler = new IndependentSampler(SEED);
const integrator = new UnidirectionalPT({ maxBounces: MAX_BOUNCES, rrStartDepth: RR_START, sampleNEE: false });

function traced(sampleIndex: number): PathRecord {
  const key = pixelSeedKey(PIXEL[0], PIXEL[1], sampleIndex);
  sampler.startPixelSample(key);
  const recorder = new ArrayRecorder();
  recorder.beginPath(key);
  integrator.sampleContributions(PIXEL, sampler, scene, recorder);
  recorder.endPath();
  return recorder.records[0]!;
}

const records: PathRecord[] = [];
for (let i = 0; i < NUM_PATHS; i++) records.push(traced(i));
const carried = records.filter((r) => r.contributions.some((c) => c.value.some((v) => v > 0))).length;

// --- The population as geometry ---
const v3 = (t: Tuple3) => new THREE.Vector3(t[0], t[1], t[2]);
const luminance = (c: Tuple3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function matte(color: THREE.Color): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: MATTE_TUBE_ROUGHNESS });
}

function swarmGroup(): THREE.Group {
  const group = new THREE.Group();
  for (const record of records) {
    const vs = record.vertices;
    for (let k = 1; k < vs.length; k++) {
      const arriving = vs[k]!;
      const b = brightness(luminance(arriving.beta));
      const color = segmentColor(luminance(arriving.beta), arriving.delta, 'camera');
      const radius = TUBE_RADIUS * (0.6 + 0.6 * b);
      group.add(new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.LineCurve3(v3(vs[k - 1]!.p), v3(arriving.p)), 1, radius, 8),
        matte(color),
      ));
      const joint = new THREE.Mesh(new THREE.SphereGeometry(JOINT_RADIUS, 12, 8), matte(color));
      joint.position.copy(v3(arriving.p));
      group.add(joint);
    }
  }
  return group;
}

// A small camera at the pinhole the fan emerges from.
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

// --- One scene, two renderers ---
// NO preserveDrawingBuffer: a severe frame-rate hit on macOS ANGLE/Metal
// (lesson taken from elliptic-curve-viz); save PNG re-renders synchronously.
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(VIEW_W, VIEW_H);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE;
document.getElementById('viz-pane')!.appendChild(renderer.domElement);

RectAreaLightUniformsLib.init(); // raster RectAreaLight shading (LTC tables)

const threeScene = new THREE.Scene();
threeScene.background = new THREE.Color(0x050505);
threeScene.add(sceneToBeautyThree(description, { emitterScale: 1, faceEmissiveScale: LAMP_FACE_SCALE }));
threeScene.add(swarmGroup());
threeScene.add(cameraGlyph());

// Raster-only helpers so the live preview is legible; zeroed in trace mode.
const previewLights: THREE.Light[] = [new THREE.AmbientLight(0xffffff, PREVIEW_AMBIENT)];
{
  const p = new THREE.PointLight(0xffffff, PREVIEW_POINT);
  p.position.set(0, 3.6, 0);
  previewLights.push(p);
}
const previewBase = previewLights.map((l) => l.intensity);
for (const l of previewLights) threeScene.add(l);

const threeCamera = new THREE.PerspectiveCamera(45, VIEW_W / VIEW_H, 0.01, 100);
threeCamera.position.set(...view.eye);
const orbit = new OrbitControls(threeCamera, renderer.domElement);
orbit.target.set(...view.target);
orbit.update();

// --- Modes: raster now, tracer only when asked for ---
let mode: Mode = 'live';
let pathTracer: WebGLPathTracer | null = null;

function setMode(next: Mode): void {
  if (next === mode) return;
  mode = next;
  previewLights.forEach((l, i) => { l.intensity = next === 'trace' ? 0 : previewBase[i]!; });
  if (next === 'trace') {
    if (!pathTracer) {
      pathTracer = new WebGLPathTracer(renderer);
      pathTracer.bounces = PT_BOUNCES;
      pathTracer.filterGlossyFactor = 0.5;
      pathTracer.tiles.set(TILES, TILES);
    }
    pathTracer.setScene(threeScene, threeCamera);
  }
}

orbit.addEventListener('change', () => { if (mode === 'trace') pathTracer!.updateCamera(); });

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
  // Fresh synchronous render so the read-back is valid without a preserved buffer.
  if (mode === 'trace' && pathTracer) pathTracer.renderSample();
  else renderer.render(threeScene, threeCamera);
  const spp = mode === 'trace' && pathTracer ? Math.round(pathTracer.samples) : 0;
  const a = document.createElement('a');
  a.download = `pixel-paths-beauty-${mode}${spp ? `-${spp}spp` : ''}.png`;
  a.href = renderer.domElement.toDataURL('image/png');
  a.click();
});

const head =
  `pixel (${PIXEL[0]}, ${PIXEL[1]}) · ${NUM_PATHS} unidirectional walks (roulette from depth ` +
  `${RR_START}) · ${carried} found the light`;
renderer.setAnimationLoop(() => {
  if (mode === 'trace' && pathTracer) {
    pathTracer.renderSample();
    infoEl.textContent = `${head} · path tracing: ${Math.round(pathTracer.samples)} samples accumulated`;
  } else {
    renderer.render(threeScene, threeCamera);
    infoEl.textContent = `${head} · live preview`;
  }
});

// SHOWS: one NEE connection, succeeding or failing — the switch between those
// two outcomes is the subject, so it is the only control.
//
// Both modes keep just the camera ray, its first hit, and that vertex's single
// shadow ray: the sampled bounce direction is dropped and later vertices are
// cut, so nothing on the page competes with the connection. The pixel is
// searched for on a coarse grid, since a blocked first connection needs a
// receiver that actually lies in shadow.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SCENES, emissiveNames, type SceneName } from '../../src/scenes/registry';
import { vizViewFor } from '../../src/viz/views';
import { buildScene } from '../../src/core/scene/scene';
import { IndependentSampler } from '../../src/core/sampler/independent';
import { pixelSeedKey } from '../../src/core/sampler/sampler';
import { NEEPathTracer } from '../../src/core/integrators/pt-nee';
import { ArrayRecorder, type PathRecord, type ShadowRayRecord } from '../../src/trace/records';
import { sceneToThree } from '../../src/viz/three-scene';
import { Timeline } from '../../src/viz/timeline';
import { buildSchedule, type ScheduleConfig } from '../../src/viz/path-schedule';
import { pathElements, type PathStyle } from '../../src/viz/path-elements';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';

// --- Figure spec ---
const SCENE_NAME: SceneName = 'cornell';
const FILM = 160;
const START_PIXEL = [88, 118] as const; // tried first; the search fans out from here
const SEED = 0;
const GRID_STRIDE = 8;
const SAMPLES_PER_PIXEL = 8;
const SCHEDULE: ScheduleConfig = { speed: 14, momentSeconds: 0.9, startTime: 0, escapeLength: 3 };
const LOOP_HOLD = 0.8;
const VIEW_W = 900;
const VIEW_H = 620;

type Mode = 'through' | 'blocked';
const MODES: ReadonlyArray<{ id: Mode; label: string }> = [
  { id: 'through', label: 'reaches the light' },
  { id: 'blocked', label: 'blocked by an occluder' },
];

const description = SCENES[SCENE_NAME];
const view = vizViewFor(SCENE_NAME);
const emissive = emissiveNames(description);

// --- three.js pane ---
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(VIEW_W, VIEW_H);
renderer.setPixelRatio(window.devicePixelRatio);
document.getElementById('viz-pane')!.appendChild(renderer.domElement);

const threeScene = new THREE.Scene();
threeScene.background = new THREE.Color(0x141414);
threeScene.add(sceneToThree(description));
const threeCamera = new THREE.PerspectiveCamera(45, VIEW_W / VIEW_H, 0.01, 100);
threeCamera.position.set(...view.eye);
const orbit = new OrbitControls(threeCamera, renderer.domElement);
orbit.target.set(...view.target);
orbit.update();
const pathsGroup = new THREE.Group();
threeScene.add(pathsGroup);

const style: PathStyle = {
  tier: 'lines',
  lineWidth: 4,
  tubeRadius: 0.02,
  resolution: new THREE.Vector2(VIEW_W * devicePixelRatio, VIEW_H * devicePixelRatio),
};

// --- Tracing + search ---
const scene = buildScene(description, FILM, FILM);
const sampler = new IndependentSampler(SEED);
const integrator = new NEEPathTracer();

function trace(pixel: readonly [number, number], sampleIndex: number): PathRecord {
  const key = pixelSeedKey(pixel[0], pixel[1], sampleIndex);
  sampler.startPixelSample(key);
  const recorder = new ArrayRecorder();
  recorder.beginPath(key);
  integrator.sampleContributions(pixel, sampler, scene, recorder);
  recorder.endPath();
  return recorder.records[0]!;
}

// Candidate pixels: the nominal one first, then a coarse grid over the lower
// half of the film, where the floor and the spheres are.
function* candidates(): Generator<readonly [number, number]> {
  yield START_PIXEL;
  for (let y = FILM / 2; y < FILM; y += GRID_STRIDE) {
    for (let x = GRID_STRIDE; x < FILM; x += GRID_STRIDE) yield [x, y];
  }
}

function search(
  want: (sr: ShadowRayRecord) => boolean,
): { pixel: readonly [number, number]; sample: number; record: PathRecord; sr: ShadowRayRecord } | null {
  for (const pixel of candidates()) {
    for (let s = 0; s < SAMPLES_PER_PIXEL; s++) {
      const record = trace(pixel, s);
      const sr = record.shadowRays.find((e) => e.depth === 1);
      if (sr && want(sr)) return { pixel, sample: s, record, sr };
    }
  }
  return null;
}

const timeline = new Timeline();
const infoEl = document.getElementById('info')!;
const len = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
  Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

function build(mode: Mode): void {
  timeline.clear();
  const found = search(
    mode === 'through' ? (sr) => !sr.occluded : (sr) => sr.occluded && sr.blockedAt != null,
  );
  if (!found) {
    infoEl.textContent = `no ${mode === 'through' ? 'unoccluded' : 'blocked'} first connection found in the search grid`;
    timeline.setTime(0);
    return;
  }
  const { pixel, sample, record: full, sr } = found;
  // Keep the camera ray, its first hit, and that one connection.
  const record: PathRecord = {
    ...full,
    vertices: full.vertices.slice(0, 2).map((v, i) => (i === 1 ? { ...v, wiSampled: null } : v)),
    rr: [],
    shadowRays: [sr],
    connections: [],
  };
  const schedule = buildSchedule(record, emissive, SCHEDULE);
  for (const el of pathElements(schedule, record.vertices.map((v) => v.delta), style, pathsGroup)) {
    timeline.add(el, schedule.duration);
  }
  timeline.setTime(0);
  timeline.playing = true;

  const head = `pixel (${pixel[0]}, ${pixel[1]}) · sample ${sample} · hit '${record.vertices[1]!.primitiveName}'`;
  infoEl.textContent =
    mode === 'through'
      ? `${head} · connection to a light point ${len(sr.from, sr.to).toFixed(2)} units away: clear`
      : `${head} · connection blocked after ${len(sr.from, sr.blockedAt!).toFixed(2)} of ` +
        `${len(sr.from, sr.to).toFixed(2)} units — contributes zero`;
}

// --- The switch ---
let mode: Mode = 'through';
const switchEl = document.getElementById('switch')!;
const buttons = MODES.map(({ id, label }) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.setAttribute('aria-pressed', String(id === mode));
  b.addEventListener('click', () => {
    mode = id;
    for (const [i, other] of buttons.entries()) {
      other.setAttribute('aria-pressed', String(MODES[i]!.id === mode));
    }
    build(mode);
  });
  switchEl.appendChild(b);
  return b;
});

build(mode);

// --- Clock (loops) ---
const frameSource = {
  canvas: renderer.domElement,
  renderFrame(t: number) {
    timeline.playing = false;
    timeline.setTime(t);
    renderer.render(threeScene, threeCamera);
  },
};
attachControls({
  container: document.getElementById('controls')!,
  timeline,
  onRecordWebM: () => recordWebM(frameSource, { fps: 30, duration: timeline.duration }),
  onRecordFrames: () => recordFrames(frameSource, { fps: 30, duration: timeline.duration }),
});

let last = performance.now();
let replayAt = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const wasPlaying = timeline.playing;
  timeline.tick((now - last) / 1000);
  last = now;
  if (wasPlaying && !timeline.playing) replayAt = now + LOOP_HOLD * 1000;
  if (replayAt > 0 && now >= replayAt) {
    replayAt = 0;
    timeline.setTime(0);
    timeline.playing = true;
  }
  renderer.render(threeScene, threeCamera);
});

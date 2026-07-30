// SHOWS: the three endings a random walk can have — emitter, roulette death,
// escape. Switching between them is the subject, so it is the only control.
//
// Each mode SEARCHES for the first sample with that ending and reports the
// index it needed, which is itself informative: at this pixel a roulette death
// is immediate and a light hit takes a dozen tries. Escaping requires the open
// scene, so that mode swaps scene and vantage.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SCENES, emissiveNames, vizViewFor, type SceneName } from '../_shared/scenes';
import { buildScene, type Scene } from '../../src/core/scene/scene';
import { IndependentSampler } from '../../src/core/sampler/independent';
import { pixelSeedKey } from '../../src/core/sampler/sampler';
import { UnidirectionalPT } from '../../src/core/integrators/pt';
import { ArrayRecorder, type PathRecord } from '../../src/trace/records';
import { sceneToThree } from '../../src/viz/three-scene';
import { Timeline } from '../../src/viz/timeline';
import { buildSchedule, type ScheduleConfig } from '../../src/viz/path-schedule';
import { pathElements, type PathStyle } from '../../src/viz/path-elements';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';

// --- Figure spec ---
const FILM = 160;
const SEED = 0;
const MAX_SEARCH = 256;
const MIN_ESCAPE_BOUNCES = 3; // a one-bounce escape is a line and a stub
const SCHEDULE: ScheduleConfig = { speed: 14, momentSeconds: 0.3, startTime: 0, escapeLength: 3 };
const LOOP_HOLD = 0.8;
const VIEW_W = 900;
const VIEW_H = 620;

type Mode = 'light' | 'roulette' | 'escape';
interface ModeSpec {
  id: Mode;
  label: string;
  scene: SceneName;
  pixel: readonly [number, number];
  wants: (r: PathRecord, emissive: ReadonlySet<string>) => boolean;
}
const MODES: readonly ModeSpec[] = [
  {
    id: 'light',
    label: 'reaching the light',
    scene: 'cornell',
    pixel: [88, 118],
    wants: (r, emissive) => {
      const last = r.vertices[r.vertices.length - 1];
      return last?.primitiveName != null && emissive.has(last.primitiveName);
    },
  },
  {
    id: 'roulette',
    label: 'Russian roulette',
    scene: 'cornell',
    pixel: [88, 118],
    wants: (r) => r.rr.some((e) => !e.survived),
  },
  {
    id: 'escape',
    label: 'escaping the scene',
    scene: 'open-stage',
    pixel: [88, 112],
    wants: (r) => {
      const last = r.vertices[r.vertices.length - 1];
      return (
        last?.wiSampled != null &&
        !r.rr.some((e) => !e.survived) &&
        r.vertices.length - 1 >= MIN_ESCAPE_BOUNCES
      );
    },
  },
];

// --- three.js pane ---
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(VIEW_W, VIEW_H);
renderer.setPixelRatio(window.devicePixelRatio);
document.getElementById('viz-pane')!.appendChild(renderer.domElement);

const threeScene = new THREE.Scene();
threeScene.background = new THREE.Color(0x141414);
const threeCamera = new THREE.PerspectiveCamera(45, VIEW_W / VIEW_H, 0.01, 100);
const orbit = new OrbitControls(threeCamera, renderer.domElement);
const pathsGroup = new THREE.Group();
threeScene.add(pathsGroup);

const style: PathStyle = {
  tier: 'lines',
  lineWidth: 4,
  tubeRadius: 0.02,
  resolution: new THREE.Vector2(VIEW_W * devicePixelRatio, VIEW_H * devicePixelRatio),
};

// --- Per-scene state, built once each ---
const sampler = new IndependentSampler(SEED);
const integrator = new UnidirectionalPT();
const built = new Map<SceneName, { scene: Scene; group: THREE.Group; emissive: Set<string> }>();

function sceneFor(name: SceneName) {
  let entry = built.get(name);
  if (!entry) {
    const description = SCENES[name];
    entry = {
      scene: buildScene(description, FILM, FILM),
      group: sceneToThree(description),
      emissive: emissiveNames(description),
    };
    built.set(name, entry);
  }
  return entry;
}

let shownScene: SceneName | null = null;
function showScene(name: SceneName): void {
  if (shownScene === name) return;
  if (shownScene) threeScene.remove(sceneFor(shownScene).group);
  threeScene.add(sceneFor(name).group);
  const view = vizViewFor(name);
  threeCamera.position.set(...view.eye);
  orbit.target.set(...view.target);
  orbit.update();
  shownScene = name;
}

function trace(scene: Scene, pixel: readonly [number, number], sampleIndex: number): PathRecord {
  const key = pixelSeedKey(pixel[0], pixel[1], sampleIndex);
  sampler.startPixelSample(key);
  const recorder = new ArrayRecorder();
  recorder.beginPath(key);
  integrator.sampleContributions(pixel, sampler, scene, recorder);
  recorder.endPath();
  return recorder.records[0]!;
}

const timeline = new Timeline();
const infoEl = document.getElementById('info')!;

function build(spec: ModeSpec): void {
  showScene(spec.scene);
  const { scene, emissive } = sceneFor(spec.scene);
  timeline.clear();

  let sample = -1;
  let record: PathRecord | null = null;
  for (let s = 0; s < MAX_SEARCH; s++) {
    const candidate = trace(scene, spec.pixel, s);
    if (spec.wants(candidate, emissive)) {
      sample = s;
      record = candidate;
      break;
    }
  }

  if (!record) {
    infoEl.textContent = `no path ${spec.label} among the first ${MAX_SEARCH} samples of pixel (${spec.pixel[0]}, ${spec.pixel[1]})`;
    timeline.setTime(0);
    return;
  }

  const schedule = buildSchedule(record, emissive, SCHEDULE);
  for (const el of pathElements(schedule, record.vertices.map((v) => v.delta), style, pathsGroup)) {
    timeline.add(el, schedule.duration);
  }
  timeline.setTime(0);
  timeline.playing = true;

  const bounces = record.vertices.length - 1;
  const head =
    `${spec.scene} · pixel (${spec.pixel[0]}, ${spec.pixel[1]}) · sample ${sample}` +
    `${sample > 0 ? ` (first of ${sample + 1} to end this way)` : ''} · ` +
    `${bounces} bounce${bounces === 1 ? '' : 's'}`;
  if (spec.id === 'light') {
    infoEl.textContent = `${head} · found the emitter — this sample carries light`;
  } else if (spec.id === 'roulette') {
    const death = record.rr.find((e) => !e.survived)!;
    infoEl.textContent =
      `${head} · killed at bounce ${death.depth}, survival probability ` +
      `${death.probability.toFixed(3)} · contributes nothing`;
  } else {
    infoEl.textContent = `${head} · left the scene; no environment light, so it contributes nothing`;
  }
}

// --- The switch ---
let mode: Mode = 'light';
const switchEl = document.getElementById('switch')!;
const buttons = MODES.map((spec) => {
  const b = document.createElement('button');
  b.textContent = spec.label;
  b.setAttribute('aria-pressed', String(spec.id === mode));
  b.addEventListener('click', () => {
    mode = spec.id;
    for (const [i, other] of buttons.entries()) {
      other.setAttribute('aria-pressed', String(MODES[i]!.id === mode));
    }
    build(spec);
  });
  switchEl.appendChild(b);
  return b;
});

build(MODES[0]!);

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

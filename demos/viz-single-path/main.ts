// D2: single-path construction, animated. Pick a pixel on the CPU preview,
// pick a sample index, and watch that exact path grow bounce by bounce —
// sampled-direction arrows, shadow rays, RR deaths, emission flash.
// Deterministic: the same pixel + sample always plays the same animation,
// live or exported.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VIZ_VIEW } from '../_shared/cornell';
import { emissiveNames, loadSceneRegistry } from '../_shared/scenes';

const SCENES = await loadSceneRegistry();
import { buildScene } from '../../src/core/scene/scene';
import { IndependentSampler } from '../../src/core/sampler/independent';
import { pixelSeedKey } from '../../src/core/sampler/sampler';
import { NEEPathTracer } from '../../src/core/integrators/pt-nee';
import { ArrayRecorder } from '../../src/trace/records';
import type { MainToWorker, PassDoneMessage } from '../../src/render/protocol';
import { sceneToThree } from '../../src/viz/three-scene';
import { Timeline } from '../../src/viz/timeline';
import { buildSchedule } from '../../src/viz/path-schedule';
import { pathElements, type PathStyle, type RenderTier } from '../../src/viz/path-elements';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';

const PREVIEW_SIZE = 160;
const VIEW_W = 860;
const VIEW_H = 620;
const SEED = 0;

let sceneName = 'cornell';
let sceneEpoch = 0;
const desc = () => SCENES[sceneName]!;

// --- CPU preview (worker, NEE) for pixel picking ---
const preview = document.getElementById('preview') as HTMLCanvasElement;
const previewCtx = preview.getContext('2d')!;
const worker = new Worker(new URL('../../src/render/worker.ts', import.meta.url), { type: 'module' });
const post = (m: MainToWorker) => worker.postMessage(m);
function initPreview(): void {
  sceneEpoch += 1;
  post({ type: 'init', description: desc(), width: PREVIEW_SIZE, height: PREVIEW_SIZE, seed: SEED, integrator: 'pt-nee', epoch: sceneEpoch });
  post({ type: 'pass', sampleIndex: 0 });
}
worker.onmessage = (e: MessageEvent<PassDoneMessage>) => {
  if (e.data.epoch !== sceneEpoch) return; // stale frame from a previous scene
  previewCtx.putImageData(new ImageData(e.data.rgba, PREVIEW_SIZE, PREVIEW_SIZE), 0, 0);
  if (e.data.samplesPerPixel < 256) post({ type: 'pass', sampleIndex: e.data.samplesPerPixel });
};
initPreview();

// --- three.js view ---
const vizPane = document.getElementById('viz-pane')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(VIEW_W, VIEW_H);
renderer.setPixelRatio(window.devicePixelRatio);
vizPane.appendChild(renderer.domElement);

const threeScene = new THREE.Scene();
threeScene.background = new THREE.Color(0x141414);
let sceneGroup = sceneToThree(desc());
threeScene.add(sceneGroup);

const threeCamera = new THREE.PerspectiveCamera(45, VIEW_W / VIEW_H, 0.01, 100);
threeCamera.position.set(...VIZ_VIEW.eye);
const controls = new OrbitControls(threeCamera, renderer.domElement);
controls.target.set(...VIZ_VIEW.target);
controls.update();

const pathsGroup = new THREE.Group();
threeScene.add(pathsGroup);

// --- Path selection + timeline ---
let inspectScene = buildScene(desc(), PREVIEW_SIZE, PREVIEW_SIZE);
const integrator = new NEEPathTracer();
const sampler = new IndependentSampler(SEED);
const timeline = new Timeline();

let pixel: readonly [number, number] = [88, 118]; // floor, default
let sampleIndex = 0;
let tier: RenderTier = 'lines';
const infoEl = document.getElementById('info')!;
const sampleLabel = document.getElementById('sample-label')!;

function style(): PathStyle {
  return {
    tier,
    lineWidth: 3,
    tubeRadius: 0.02,
    resolution: new THREE.Vector2(VIEW_W * devicePixelRatio, VIEW_H * devicePixelRatio),
  };
}

function rebuild(): void {
  const key = pixelSeedKey(pixel[0], pixel[1], sampleIndex);
  sampler.startPixelSample(key);
  const recorder = new ArrayRecorder();
  recorder.beginPath(key);
  integrator.sampleContributions(pixel, sampler, inspectScene, recorder);
  recorder.endPath();
  const record = recorder.records[0]!;

  timeline.clear();
  const schedule = buildSchedule(record, emissiveNames(desc()));
  const deltas = record.vertices.map((v) => v.delta);
  for (const el of pathElements(schedule, deltas, style(), pathsGroup)) {
    timeline.add(el, schedule.duration);
  }
  timeline.setTime(0);
  timeline.playing = true;

  const bounces = record.vertices.length - 1;
  const shadows = record.shadowRays.length;
  const blocked = record.shadowRays.filter((s) => s.occluded).length;
  const lit = record.contributions.some((c) => c.value.some((v) => v > 0));
  infoEl.textContent =
    `pixel (${pixel[0]}, ${pixel[1]}) sample ${sampleIndex}: ${bounces} bounces, ` +
    `${shadows} shadow rays (${blocked} blocked) — ${lit ? 'carried light' : 'found nothing'}`;
  sampleLabel.textContent = `sample ${sampleIndex}`;
}

preview.addEventListener('click', (event) => {
  const rect = preview.getBoundingClientRect();
  pixel = [
    Math.floor(((event.clientX - rect.left) / rect.width) * PREVIEW_SIZE),
    Math.floor(((event.clientY - rect.top) / rect.height) * PREVIEW_SIZE),
  ];
  sampleIndex = 0;
  rebuild();
});
document.getElementById('prev-sample')!.addEventListener('click', () => {
  sampleIndex = Math.max(0, sampleIndex - 1);
  rebuild();
});
document.getElementById('next-sample')!.addEventListener('click', () => {
  sampleIndex += 1;
  rebuild();
});
document.getElementById('tier')!.addEventListener('change', (e) => {
  tier = (e.target as HTMLSelectElement).value as RenderTier;
  rebuild();
});
const sceneSelect = document.getElementById('scene') as HTMLSelectElement;
for (const name of Object.keys(SCENES)) {
  sceneSelect.add(new Option(name, name, undefined, name === sceneName));
}
sceneSelect.addEventListener('change', () => {
  sceneName = sceneSelect.value;
  threeScene.remove(sceneGroup);
  sceneGroup = sceneToThree(desc());
  threeScene.add(sceneGroup);
  inspectScene = buildScene(desc(), PREVIEW_SIZE, PREVIEW_SIZE);
  initPreview();
  rebuild();
});

// --- Clock + controls + recording ---
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
renderer.setAnimationLoop(() => {
  const now = performance.now();
  timeline.tick((now - last) / 1000);
  last = now;
  renderer.render(threeScene, threeCamera);
});

rebuild();

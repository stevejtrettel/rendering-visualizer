// The flipbook: for one pixel, each sample's complete path appears at once,
// then the next, then the next — the scene rapidly cycling through the
// estimator's draws. Accumulate mode lets them pile up instead, newest
// bright, older dimmed, until the pixel's whole path family is visible.
// With integrator = pt this is the variance story told visually: sample
// after sample finding nothing, then one that suddenly connects.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CORNELL, VIZ_VIEW } from '../_shared/cornell';
import { buildScene } from '../../src/core/scene/scene';
import { IndependentSampler } from '../../src/core/sampler/independent';
import { pixelSeedKey } from '../../src/core/sampler/sampler';
import { UnidirectionalPT } from '../../src/core/integrators/pt';
import { NEEPathTracer } from '../../src/core/integrators/pt-nee';
import type { Integrator } from '../../src/core/integrators/types';
import { ArrayRecorder, type PathRecord } from '../../src/trace/records';
import type { IntegratorName, MainToWorker, PassDoneMessage } from '../../src/render/protocol';
import { sceneToThree } from '../../src/viz/three-scene';
import { Timeline } from '../../src/viz/timeline';
import type { PathStyle, RenderTier } from '../../src/viz/path-elements';
import { sampleFlipElements, type SampleMode } from '../../src/viz/sample-flip';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';

const PREVIEW_SIZE = 160;
const VIEW_W = 860;
const VIEW_H = 620;
const SEED = 0;

// --- CPU preview for pixel picking ---
const preview = document.getElementById('preview') as HTMLCanvasElement;
const previewCtx = preview.getContext('2d')!;
const worker = new Worker(new URL('../../src/render/worker.ts', import.meta.url), { type: 'module' });
const post = (m: MainToWorker) => worker.postMessage(m);
post({ type: 'init', description: CORNELL, width: PREVIEW_SIZE, height: PREVIEW_SIZE, seed: SEED, integrator: 'pt-nee' });
post({ type: 'pass', sampleIndex: 0 });
worker.onmessage = (e: MessageEvent<PassDoneMessage>) => {
  previewCtx.putImageData(new ImageData(e.data.rgba, PREVIEW_SIZE, PREVIEW_SIZE), 0, 0);
  if (e.data.samplesPerPixel < 256) post({ type: 'pass', sampleIndex: e.data.samplesPerPixel });
};

// --- three.js view ---
const vizPane = document.getElementById('viz-pane')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(VIEW_W, VIEW_H);
renderer.setPixelRatio(window.devicePixelRatio);
vizPane.appendChild(renderer.domElement);

const threeScene = new THREE.Scene();
threeScene.background = new THREE.Color(0x141414);
threeScene.add(sceneToThree(CORNELL));

const threeCamera = new THREE.PerspectiveCamera(45, VIEW_W / VIEW_H, 0.01, 100);
threeCamera.position.set(...VIZ_VIEW.eye);
const controls = new OrbitControls(threeCamera, renderer.domElement);
controls.target.set(...VIZ_VIEW.target);
controls.update();

const pathsGroup = new THREE.Group();
threeScene.add(pathsGroup);

// --- State + rebuild ---
const inspectScene = buildScene(CORNELL, PREVIEW_SIZE, PREVIEW_SIZE);
const integrators: Record<IntegratorName, Integrator> = {
  pt: new UnidirectionalPT(),
  'pt-nee': new NEEPathTracer(),
};
const sampler = new IndependentSampler(SEED);
const timeline = new Timeline();
const infoEl = document.getElementById('info')!;

let pixel: readonly [number, number] = [80, 118];
let integratorName: IntegratorName = 'pt-nee';
let mode: SampleMode = 'flip';
let dwell = 0.1;
let count = 100;
let tier: RenderTier = 'lines';
let shadowRays = true;

const sel = (id: string) => document.getElementById(id) as HTMLSelectElement;

function traceSamples(): PathRecord[] {
  const recorder = new ArrayRecorder();
  const integrator = integrators[integratorName];
  for (let s = 0; s < count; s++) {
    const key = pixelSeedKey(pixel[0], pixel[1], s);
    sampler.startPixelSample(key);
    recorder.beginPath(key);
    integrator.sampleContributions(pixel, sampler, inspectScene, recorder);
    recorder.endPath();
  }
  return recorder.records;
}

function rebuild(): void {
  const records = traceSamples();
  timeline.clear();
  const style: PathStyle = {
    tier,
    lineWidth: 3,
    tubeRadius: 0.014,
    resolution: new THREE.Vector2(VIEW_W * devicePixelRatio, VIEW_H * devicePixelRatio),
  };
  const { elements, duration } = sampleFlipElements(records, { mode, dwell, shadowRays }, style, pathsGroup);
  for (const el of elements) timeline.add(el, duration);
  timeline.setTime(0);
  timeline.playing = true;

  const lit = records.filter((r) => r.contributions.some((c) => c.value.some((v) => v > 0))).length;
  infoEl.textContent =
    `pixel (${pixel[0]}, ${pixel[1]}) · ${integratorName} · ${count} samples, ${lit} carried light`;
}

preview.addEventListener('click', (event) => {
  const rect = preview.getBoundingClientRect();
  pixel = [
    Math.floor(((event.clientX - rect.left) / rect.width) * PREVIEW_SIZE),
    Math.floor(((event.clientY - rect.top) / rect.height) * PREVIEW_SIZE),
  ];
  rebuild();
});
sel('integrator').addEventListener('change', (e) => {
  integratorName = (e.target as HTMLSelectElement).value as IntegratorName;
  rebuild();
});
sel('mode').addEventListener('change', (e) => {
  mode = (e.target as HTMLSelectElement).value as SampleMode;
  // Default shadow rays per mode (overridable): on for flip, off for accumulate.
  shadowRays = mode === 'flip';
  (document.getElementById('shadow-rays') as HTMLInputElement).checked = shadowRays;
  rebuild();
});
sel('dwell').addEventListener('change', (e) => {
  dwell = Number((e.target as HTMLSelectElement).value);
  rebuild();
});
sel('count').addEventListener('change', (e) => {
  count = Number((e.target as HTMLSelectElement).value);
  rebuild();
});
sel('tier').addEventListener('change', (e) => {
  tier = (e.target as HTMLSelectElement).value as RenderTier;
  rebuild();
});
document.getElementById('shadow-rays')!.addEventListener('change', (e) => {
  shadowRays = (e.target as HTMLInputElement).checked;
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

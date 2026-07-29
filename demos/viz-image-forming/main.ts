// The image-forming demo: a low-res (default 16x16) version of the render
// accumulates ON a floating plane placed exactly on the camera frustum,
// while one highlighted cell also draws its actual paths. Same sample
// clock for both — scrub time and you scrub the image's convergence.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VIZ_VIEW } from '../_shared/cornell';
import { loadSceneRegistry } from '../_shared/scenes';

const SCENES = await loadSceneRegistry();
import { buildScene, type Scene } from '../../src/core/scene/scene';
import { IndependentSampler } from '../../src/core/sampler/independent';
import { pixelSeedKey } from '../../src/core/sampler/sampler';
import { UnidirectionalPT } from '../../src/core/integrators/pt';
import { NEEPathTracer } from '../../src/core/integrators/pt-nee';
import type { Integrator } from '../../src/core/integrators/types';
import { ArrayRecorder, type PathRecord } from '../../src/trace/records';
import { NULL_RECORDER } from '../../src/trace/recorder';
import type { IntegratorName, MainToWorker, PassDoneMessage } from '../../src/render/protocol';
import { sceneToThree } from '../../src/viz/three-scene';
import { Timeline } from '../../src/viz/timeline';
import type { PathStyle } from '../../src/viz/path-elements';
import { sampleFlipElements, type SampleMode } from '../../src/viz/sample-flip';
import { ImagePlaneElement, toCumulative } from '../../src/viz/image-plane';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';

const PREVIEW_SIZE = 160;
const VIEW_W = 860;
const VIEW_H = 620;
const SEED = 0;
const PLANE_DISTANCE = 1.4;

let sceneName = 'cornell';
let sceneEpoch = 0;
const desc = () => SCENES[sceneName]!;

// --- CPU preview (what the plane is converging toward) ---
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
  if (e.data.epoch !== sceneEpoch) return;
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

const contentGroup = new THREE.Group();
threeScene.add(contentGroup);

// --- State ---
const integrators: Record<IntegratorName, Integrator> = {
  pt: new UnidirectionalPT(),
  'pt-nee': new NEEPathTracer(),
};
const sampler = new IndependentSampler(SEED);
const timeline = new Timeline();
const infoEl = document.getElementById('info')!;

let integratorName: IntegratorName = 'pt-nee';
let res = 16;
let count = 100;
let dwell = 0.1;
let mode: SampleMode = 'flip';
let shadowRays = false;
let highlight: readonly [number, number] = [6, 12]; // cell in plane-res coords

// Accumulation cache, keyed by everything that changes the traced data.
let cachedKey = '';
let cachedCumulative: Float32Array | null = null;
let cachedScene: Scene | null = null;
let rebuildToken = 0;

const sel = (id: string) => document.getElementById(id) as HTMLSelectElement;

// Trace res*res*count samples in row chunks, yielding to the UI between
// chunks. Returns per-sample values laid out for toCumulative.
async function tracePlane(scene: Scene, token: number): Promise<Float32Array | null> {
  const integrator = integrators[integratorName];
  const values = new Float32Array(count * res * res * 3);
  const stride = res * res * 3;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      for (let s = 0; s < count; s++) {
        sampler.startPixelSample(pixelSeedKey(x, y, s));
        const [c] = integrator.sampleContributions([x, y], sampler, scene, NULL_RECORDER);
        const o = s * stride + (y * res + x) * 3;
        values[o] = c!.value.r;
        values[o + 1] = c!.value.g;
        values[o + 2] = c!.value.b;
      }
    }
    infoEl.textContent = `tracing… ${Math.round(((y + 1) / res) * 100)}%`;
    await new Promise((r) => setTimeout(r));
    if (token !== rebuildToken) return null; // superseded by newer rebuild
  }
  toCumulative(values, res, count);
  return values;
}

function traceHighlightRecords(scene: Scene): PathRecord[] {
  const integrator = integrators[integratorName];
  const recorder = new ArrayRecorder();
  for (let s = 0; s < count; s++) {
    const key = pixelSeedKey(highlight[0], highlight[1], s);
    sampler.startPixelSample(key);
    recorder.beginPath(key);
    integrator.sampleContributions([highlight[0], highlight[1]], sampler, scene, recorder);
    recorder.endPath();
  }
  return recorder.records;
}

async function rebuild(): Promise<void> {
  const token = ++rebuildToken;
  const key = `${sceneName}/${integratorName}/${res}/${count}`;
  if (cachedKey !== key) {
    const scene = buildScene(desc(), res, res);
    const cumulative = await tracePlane(scene, token);
    if (!cumulative) return; // superseded
    cachedKey = key;
    cachedCumulative = cumulative;
    cachedScene = scene;
  }

  const records = traceHighlightRecords(cachedScene!);
  timeline.clear();

  const style: PathStyle = {
    tier: 'lines',
    lineWidth: 3,
    tubeRadius: 0.014,
    resolution: new THREE.Vector2(VIEW_W * devicePixelRatio, VIEW_H * devicePixelRatio),
  };
  const duration = count * dwell + 1;
  timeline.add(
    new ImagePlaneElement(
      {
        camera: desc().camera,
        distance: PLANE_DISTANCE,
        res,
        samples: count,
        dwell,
        cumulative: cachedCumulative!,
        highlight,
      },
      contentGroup,
    ),
    duration,
  );
  const flip = sampleFlipElements(records, { mode, dwell, shadowRays }, style, contentGroup);
  for (const el of flip.elements) timeline.add(el, duration);
  timeline.setTime(0);
  timeline.playing = true;

  const lit = records.filter((r) => r.contributions.some((c) => c.value.some((v) => v > 0))).length;
  infoEl.textContent =
    `cell (${highlight[0]}, ${highlight[1]}) of ${res}×${res} · ${integratorName} · ${count} samples, ${lit} carried light`;
}

preview.addEventListener('click', (event) => {
  const rect = preview.getBoundingClientRect();
  highlight = [
    Math.min(res - 1, Math.floor(((event.clientX - rect.left) / rect.width) * res)),
    Math.min(res - 1, Math.floor(((event.clientY - rect.top) / rect.height) * res)),
  ];
  void rebuild();
});
sel('integrator').addEventListener('change', (e) => {
  integratorName = (e.target as HTMLSelectElement).value as IntegratorName;
  void rebuild();
});
sel('res').addEventListener('change', (e) => {
  const newRes = Number((e.target as HTMLSelectElement).value);
  highlight = [
    Math.min(newRes - 1, Math.round((highlight[0] / res) * newRes)),
    Math.min(newRes - 1, Math.round((highlight[1] / res) * newRes)),
  ];
  res = newRes;
  void rebuild();
});
sel('count').addEventListener('change', (e) => {
  count = Number((e.target as HTMLSelectElement).value);
  void rebuild();
});
sel('dwell').addEventListener('change', (e) => {
  dwell = Number((e.target as HTMLSelectElement).value);
  void rebuild();
});
sel('mode').addEventListener('change', (e) => {
  mode = (e.target as HTMLSelectElement).value as SampleMode;
  void rebuild();
});
document.getElementById('shadow-rays')!.addEventListener('change', (e) => {
  shadowRays = (e.target as HTMLInputElement).checked;
  void rebuild();
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
  initPreview();
  void rebuild();
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

void rebuild();

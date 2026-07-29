// V0 walking-skeleton demo: CPU Cornell render in a worker (left), the same
// scene in three.js (right). Clicking a pixel re-derives that pixel's paths
// by seed replay — nothing was stored — and draws them into the scene.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CORNELL, VIZ_VIEW } from '../_shared/cornell';
import { buildScene } from '../../src/core/scene/scene';
import { IndependentSampler } from '../../src/core/sampler/independent';
import { pixelSeedKey } from '../../src/core/sampler/sampler';
import { UnidirectionalPT } from '../../src/core/integrators/pt';
import { ArrayRecorder } from '../../src/trace/records';
import type { PassDoneMessage, MainToWorker } from '../../src/render/protocol';
import { sceneToThree } from '../../src/viz/three-scene';
import { disposeGroup, pathsToThree } from '../../src/viz/three-paths';

const WIDTH = 384;
const HEIGHT = 384;
const SEED = 0;
const INSPECT_SAMPLES = 24; // paths re-traced per clicked pixel
const MAX_PASSES = 512;

// --- Left pane: worker-rendered progressive CPU image ---
const renderCanvas = document.getElementById('render-canvas') as HTMLCanvasElement;
renderCanvas.width = WIDTH;
renderCanvas.height = HEIGHT;
renderCanvas.style.width = '512px';
renderCanvas.style.height = '512px';
const ctx = renderCanvas.getContext('2d')!;
const statusEl = document.getElementById('status')!;

const worker = new Worker(new URL('../../src/render/worker.ts', import.meta.url), { type: 'module' });
const post = (m: MainToWorker) => worker.postMessage(m);

let passTimes: number[] = [];
post({ type: 'init', description: CORNELL, width: WIDTH, height: HEIGHT, seed: SEED, integrator: 'pt' });
post({ type: 'pass', sampleIndex: 0 });

worker.onmessage = (event: MessageEvent<PassDoneMessage>) => {
  const msg = event.data;
  ctx.putImageData(new ImageData(msg.rgba, WIDTH, HEIGHT), 0, 0);
  passTimes.push(msg.passMillis);
  const avg = passTimes.reduce((a, b) => a + b, 0) / passTimes.length;
  statusEl.textContent =
    `${msg.samplesPerPixel} spp · ${msg.passMillis.toFixed(0)} ms/pass (avg ${avg.toFixed(0)})`;
  if (msg.samplesPerPixel < MAX_PASSES) {
    post({ type: 'pass', sampleIndex: msg.samplesPerPixel });
  }
};

// --- Right pane: three.js view of the same scene ---
const vizPane = document.getElementById('viz-pane')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(512, 512);
renderer.setPixelRatio(window.devicePixelRatio);
vizPane.appendChild(renderer.domElement);

const threeScene = new THREE.Scene();
threeScene.background = new THREE.Color(0x181818);
threeScene.add(sceneToThree(CORNELL));

const threeCamera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
threeCamera.position.set(...VIZ_VIEW.eye);
const controls = new OrbitControls(threeCamera, renderer.domElement);
controls.target.set(...VIZ_VIEW.target);
controls.update();

let pathsGroup: THREE.Group | null = null;
renderer.setAnimationLoop(() => renderer.render(threeScene, threeCamera));

// --- Click-to-inspect: replay the pixel's paths on the main thread ---
// The same core code the worker runs, seeded identically — so these ARE the
// paths that produced the pixel, not a re-enactment.
const inspectScene = buildScene(CORNELL, WIDTH, HEIGHT);
const inspectIntegrator = new UnidirectionalPT();
const inspectSampler = new IndependentSampler(SEED);

renderCanvas.addEventListener('click', (event) => {
  const rect = renderCanvas.getBoundingClientRect();
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * WIDTH);
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * HEIGHT);

  const recorder = new ArrayRecorder();
  for (let s = 0; s < INSPECT_SAMPLES; s++) {
    const key = pixelSeedKey(x, y, s);
    inspectSampler.startPixelSample(key);
    recorder.beginPath(key);
    inspectIntegrator.sampleContributions([x, y], inspectSampler, inspectScene, recorder);
    recorder.endPath();
  }

  if (pathsGroup) {
    threeScene.remove(pathsGroup);
    disposeGroup(pathsGroup);
  }
  pathsGroup = pathsToThree(recorder.records);
  threeScene.add(pathsGroup);

  const hits = recorder.records.filter((r) => r.contributions.some((c) => c.value.some((v) => v > 0))).length;
  document.getElementById('inspect')!.textContent =
    `pixel (${x}, ${y}): ${recorder.records.length} paths re-traced, ${hits} reached the light`;
});

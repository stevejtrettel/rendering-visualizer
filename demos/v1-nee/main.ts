// The talk's first comparison figure, live: unidirectional PT and PT+NEE
// render the same Cornell box with the same seeds and pass counts, side by
// side. Clicking either image re-traces that pixel's paths WITH THAT PANE'S
// integrator and draws them — including NEE shadow rays, green where the
// connection reached the light, red where it died at an occluder.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CORNELL, VIZ_VIEW } from '../_shared/cornell';
import { buildScene } from '../../src/core/scene/scene';
import { IndependentSampler } from '../../src/core/sampler/independent';
import { pixelSeedKey } from '../../src/core/sampler/sampler';
import { UnidirectionalPT } from '../../src/core/integrators/pt';
import { NEEPathTracer } from '../../src/core/integrators/pt-nee';
import { BDPT } from '../../src/core/integrators/bdpt';
import type { Integrator } from '../../src/core/integrators/types';
import { ArrayRecorder } from '../../src/trace/records';
import type { IntegratorName, MainToWorker, PassDoneMessage } from '../../src/render/protocol';
import { sceneToThree } from '../../src/viz/three-scene';
import { disposeGroup, pathsToThree } from '../../src/viz/three-paths';

const WIDTH = 320;
const HEIGHT = 320;
const DISPLAY = 420;
const SEED = 0;
const INSPECT_SAMPLES = 16;
const MAX_PASSES = 1024;

interface Pane {
  name: IntegratorName;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  worker: Worker;
  spp: number;
}

const statusEl = document.getElementById('status')!;
const inspectEl = document.getElementById('inspect')!;

function makePane(name: IntegratorName, canvasId: string): Pane {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.style.width = `${DISPLAY}px`;
  canvas.style.height = `${DISPLAY}px`;
  const worker = new Worker(new URL('../../src/render/worker.ts', import.meta.url), { type: 'module' });
  const pane: Pane = { name, canvas, ctx: canvas.getContext('2d')!, worker, spp: 0 };
  const post = (m: MainToWorker) => worker.postMessage(m);
  post({ type: 'init', description: CORNELL, width: WIDTH, height: HEIGHT, seed: SEED, integrator: name });
  post({ type: 'pass', sampleIndex: 0 });
  worker.onmessage = (event: MessageEvent<PassDoneMessage>) => {
    const msg = event.data;
    pane.ctx.putImageData(new ImageData(msg.rgba, WIDTH, HEIGHT), 0, 0);
    pane.spp = msg.samplesPerPixel;
    statusEl.textContent = `PT ${panes[0]!.spp} spp · NEE ${panes[1]!.spp} spp`;
    if (msg.samplesPerPixel < MAX_PASSES) post({ type: 'pass', sampleIndex: msg.samplesPerPixel });
  };
  return pane;
}

const panes = [makePane('pt', 'pt-canvas'), makePane('pt-nee', 'nee-canvas')];

// --- three.js pane ---
const vizPane = document.getElementById('viz-pane')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(DISPLAY, DISPLAY);
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

// --- Click-to-inspect with the clicked pane's own integrator ---
const inspectScene = buildScene(CORNELL, WIDTH, HEIGHT);
const integrators: Record<IntegratorName, Integrator> = {
  pt: new UnidirectionalPT(),
  'pt-nee': new NEEPathTracer(),
  bdpt: new BDPT(),
};
const inspectSampler = new IndependentSampler(SEED);

for (const pane of panes) {
  pane.canvas.addEventListener('click', (event) => {
    const rect = pane.canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * WIDTH);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * HEIGHT);

    const recorder = new ArrayRecorder();
    for (let s = 0; s < INSPECT_SAMPLES; s++) {
      const key = pixelSeedKey(x, y, s);
      inspectSampler.startPixelSample(key);
      recorder.beginPath(key);
      integrators[pane.name].sampleContributions([x, y], inspectSampler, inspectScene, recorder);
      recorder.endPath();
    }

    if (pathsGroup) {
      threeScene.remove(pathsGroup);
      disposeGroup(pathsGroup);
    }
    pathsGroup = pathsToThree(recorder.records);
    threeScene.add(pathsGroup);

    const shadowRays = recorder.records.flatMap((r) => r.shadowRays);
    const blocked = shadowRays.filter((sr) => sr.occluded).length;
    inspectEl.textContent =
      `${pane.name} pixel (${x}, ${y}): ${recorder.records.length} paths` +
      (shadowRays.length > 0 ? `, ${shadowRays.length} shadow rays (${blocked} blocked)` : '');
  });
}

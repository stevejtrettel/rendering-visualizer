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
import { BDPT } from '../../src/core/integrators/bdpt';
import type { Integrator } from '../../src/core/integrators/types';
import { ArrayRecorder, type PathRecord } from '../../src/trace/records';
import type { MainToWorker, PassDoneMessage } from '../../src/render/protocol';
import { sceneToThree } from '../../src/viz/three-scene';
import { Timeline } from '../../src/viz/timeline';
import { buildSchedule, type PathSchedule } from '../../src/viz/path-schedule';
import {
  ConnectionFlash,
  pathElements,
  type PathStyle,
  type RenderTier,
} from '../../src/viz/path-elements';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';

const PREVIEW_SIZE = 160;
const VIEW_W = 860;
const VIEW_H = 620;
const SEED = 0;

// Deep-linkable for cross-demo jumps (the pyramid's cells open us):
// ?scene=..&integrator=bdpt&px=..&py=..&s=..&t=..
const params = new URLSearchParams(location.search);
const paramScene = params.get('scene');

let sceneName = paramScene && SCENES[paramScene] ? paramScene : 'cornell';
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
const integrators: Record<'pt-nee' | 'bdpt', Integrator> = {
  'pt-nee': new NEEPathTracer(),
  bdpt: new BDPT(),
};
let integratorName: keyof typeof integrators =
  params.get('integrator') === 'bdpt' ? 'bdpt' : 'pt-nee';
const sampler = new IndependentSampler(SEED);
const timeline = new Timeline();

const clampPx = (v: string | null, fallback: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < PREVIEW_SIZE ? n : fallback;
};
let pixel: readonly [number, number] = [clampPx(params.get('px'), 88), clampPx(params.get('py'), 118)];
let sampleIndex = 0;
// A specific (s, t) to isolate: only the two subpath prefixes and that one
// connection are drawn, and samples auto-advance until the strategy forms.
let strategy: { s: number; t: number } | 'all' =
  params.has('s') && params.has('t')
    ? { s: Number(params.get('s')), t: Number(params.get('t')) }
    : 'all';
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

// When a connection endpoint is a walk vertex, the flash waits for that
// vertex's arrival on its walk's clock; endpoints that are not walk vertices
// (the eye, an s=1 resampled light point) are ready at time 0.
function arrivalTime(
  schedule: PathSchedule,
  vertices: PathRecord['vertices'],
  p: readonly [number, number, number],
): number {
  const idx = vertices.findIndex(
    (v) =>
      Math.abs(v.p[0] - p[0]) < 1e-9 &&
      Math.abs(v.p[1] - p[1]) < 1e-9 &&
      Math.abs(v.p[2] - p[2]) < 1e-9,
  );
  if (idx <= 0) return 0;
  return schedule.moments.find((m) => m.vertexIndex === idx)?.start ?? 0;
}

function tracePath(idx: number): PathRecord {
  const key = pixelSeedKey(pixel[0], pixel[1], idx);
  sampler.startPixelSample(key);
  const recorder = new ArrayRecorder();
  recorder.beginPath(key);
  integrators[integratorName].sampleContributions(pixel, sampler, inspectScene, recorder);
  recorder.endPath();
  return recorder.records[0]!;
}

// Did strategy (s, t) form in this sample? s >= 1 leaves a connection event;
// s = 0 is the camera walk reaching an emitter at exactly vertex t.
function hasStrategy(r: PathRecord, st: { s: number; t: number }, emissive: ReadonlySet<string>): boolean {
  if (st.s === 0) {
    const v = r.vertices[st.t - 1];
    return v != null && v.primitiveName != null && emissive.has(v.primitiveName);
  }
  return r.connections.some((c) => c.s === st.s && c.t === st.t);
}

// Offer the strategies present in this sample (plus the one currently
// isolated, so a failed search doesn't drop the selection).
function syncStrategyOptions(record: PathRecord, emissive: ReadonlySet<string>): void {
  const select = document.getElementById('strategy') as HTMLSelectElement;
  select.disabled = integratorName !== 'bdpt';
  const keys = new Set(record.connections.map((c) => `${c.s},${c.t}`));
  const last = record.vertices[record.vertices.length - 1];
  if (last?.primitiveName != null && emissive.has(last.primitiveName)) {
    keys.add(`0,${record.vertices.length}`);
  }
  if (strategy !== 'all') keys.add(`${strategy.s},${strategy.t}`);
  const sorted = [...keys].sort((a, b) => {
    const [as, at] = a.split(',').map(Number);
    const [bs, bt] = b.split(',').map(Number);
    return as! + at! - (bs! + bt!) || as! - bs!;
  });
  select.replaceChildren(new Option('all', 'all'));
  for (const key of sorted) {
    const [s, t] = key.split(',');
    select.add(new Option(`s=${s} t=${t}`, key));
  }
  select.value = strategy === 'all' ? 'all' : `${strategy.s},${strategy.t}`;
}

function rebuild(): void {
  const names = emissiveNames(desc());
  let record = tracePath(sampleIndex);
  let note = '';
  const wanted = integratorName === 'bdpt' && strategy !== 'all' ? strategy : null;
  if (wanted && !hasStrategy(record, wanted, names)) {
    // Auto-advance: not every sample forms every strategy.
    for (let tries = 0; tries < 64 && !hasStrategy(record, wanted, names); tries++) {
      sampleIndex += 1;
      record = tracePath(sampleIndex);
    }
  }
  const isolated = wanted && hasStrategy(record, wanted, names) ? wanted : null;
  if (wanted && !isolated) note = ` — no (s=${wanted.s}, t=${wanted.t}) within 64 samples; showing all`;

  syncStrategyOptions(record, names);
  timeline.clear();
  const camVerts = isolated ? record.vertices.slice(0, isolated.t) : record.vertices;
  const camSchedule = buildSchedule(record, names, undefined, { vertices: camVerts, role: 'camera' });
  const camDeltas = camVerts.map((v) => v.delta);
  for (const el of pathElements(camSchedule, camDeltas, style(), pathsGroup)) {
    timeline.add(el, camSchedule.duration);
  }

  // Same clock, growing simultaneously: light subpath in cyan. An isolated
  // s=1 draws no walked light path — that strategy RESAMPLES the light, and
  // the flash to the fresh point is the whole light side.
  let lightSchedule: PathSchedule | null = null;
  const lightVerts =
    integratorName !== 'bdpt' ? []
    : isolated ? (isolated.s >= 2 ? record.lightVertices.slice(0, isolated.s) : [])
    : record.lightVertices;
  if (lightVerts.length > 0) {
    lightSchedule = buildSchedule(record, names, undefined, { vertices: lightVerts, role: 'light' });
    const lightDeltas = lightVerts.map((v) => v.delta);
    const lightStyle: PathStyle = { ...style(), palette: 'light' };
    for (const el of pathElements(lightSchedule, lightDeltas, lightStyle, pathsGroup)) {
      timeline.add(el, lightSchedule.duration);
    }
  }

  // Connection attempts flash once both endpoints have arrived, spaced out
  // enough to read individually.
  if (integratorName === 'bdpt') {
    const shown = isolated
      ? record.connections.filter((c) => c.s === isolated.s && c.t === isolated.t)
      : record.connections;
    const timed = shown
      .map((c) => ({
        c,
        time: Math.max(
          arrivalTime(camSchedule, camVerts, c.from),
          lightSchedule ? arrivalTime(lightSchedule, lightVerts, c.to) : 0,
        ),
      }))
      .sort((a, b) => a.time - b.time);
    let prev = -Infinity;
    for (const entry of timed) {
      const at = Math.max(entry.time, prev + 0.35);
      prev = at;
      timeline.add(new ConnectionFlash(entry.c, at, style(), pathsGroup), at + 2);
    }
  }

  timeline.setTime(0);
  timeline.playing = true;

  const bounces = record.vertices.length - 1;
  if (integratorName === 'bdpt') {
    const lightBounces = Math.max(0, record.lightVertices.length - 1);
    const blocked = record.connections.filter((c) => c.occluded).length;
    const head = isolated
      ? `strategy (s=${isolated.s}, t=${isolated.t})`
      : `camera walk ${bounces} bounces, light walk ${lightBounces} — ` +
        `${record.connections.length} connections (${blocked} blocked)`;
    infoEl.textContent = `pixel (${pixel[0]}, ${pixel[1]}) sample ${sampleIndex}: ${head}${note}`;
  } else {
    const shadows = record.shadowRays.length;
    const blocked = record.shadowRays.filter((s) => s.occluded).length;
    const lit = record.contributions.some((c) => c.value.some((v) => v > 0));
    infoEl.textContent =
      `pixel (${pixel[0]}, ${pixel[1]}) sample ${sampleIndex}: ${bounces} bounces, ` +
      `${shadows} shadow rays (${blocked} blocked) — ${lit ? 'carried light' : 'found nothing'}`;
  }
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
document.getElementById('integrator')!.addEventListener('change', (e) => {
  integratorName = (e.target as HTMLSelectElement).value as keyof typeof integrators;
  rebuild();
});
document.getElementById('strategy')!.addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  if (v === 'all') {
    strategy = 'all';
  } else {
    const [s, t] = v.split(',').map(Number);
    strategy = { s: s!, t: t! };
  }
  rebuild();
});
// Sync selects with any URL-supplied initial state.
(document.getElementById('integrator') as HTMLSelectElement).value = integratorName;
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

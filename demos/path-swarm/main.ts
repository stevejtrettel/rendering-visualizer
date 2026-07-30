// SHOWS: one pixel's samples as a churning POPULATION — 100 on screen, 10
// retired and replaced per refresh. The switch is path length, because that is
// what changes the question being asked: one bounce shows the material's
// scattering distribution, full length shows the path family whose mean is the
// pixel value.
//
// The window is a pure function of time (see swarmWindow), so this animates,
// scrubs and exports like every other page — it only looks live.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SCENES, emissiveNames, vizViewFor, type SceneName } from '../_shared/scenes';
import { buildScene } from '../../src/core/scene/scene';
import { IndependentSampler } from '../../src/core/sampler/independent';
import { pixelSeedKey } from '../../src/core/sampler/sampler';
import { UnidirectionalPT } from '../../src/core/integrators/pt';
import { ArrayRecorder, type PathRecord } from '../../src/trace/records';
import { sceneToThree } from '../../src/viz/three-scene';
import { Timeline, type TimelineElement } from '../../src/viz/timeline';
import { PathSwarm, swarmWindow, type SwarmPolyline } from '../../src/viz/path-swarm';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';

// --- Figure spec ---
const SCENE_NAME: SceneName = 'cornell';
const FILM = 160;
const PIXEL = [88, 118] as const; // the floor, in front of the spheres
const SEED = 0;
const POPULATION = 100; // paths on screen at once
const REPLACE = 10; // retired and replaced per refresh
const RATE = 12; // refreshes per second
const DURATION = 30; // seconds of clock before it loops
const VIEW_W = 900;
const VIEW_H = 620;

// `walkCap` is maxBounces, which counts SURFACE VERTICES — one more than the
// number of scattering events you see. A cap of 1 stops at the first hit and
// draws only the camera ray; the spray is the segment LEAVING that hit, so one
// scattering event needs a cap of 2.
type Mode = 'one' | 'two' | 'full';
const MODES: ReadonlyArray<{ id: Mode; label: string; walkCap: number }> = [
  { id: 'one', label: '1 scattering event — the material’s spray', walkCap: 2 },
  { id: 'two', label: '2 events', walkCap: 3 },
  { id: 'full', label: 'full paths (6)', walkCap: 7 },
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
const swarmGroup = new THREE.Group();
threeScene.add(swarmGroup);

// --- Tracing, with a cache so scrubbing backwards is free ---
const scene = buildScene(description, FILM, FILM);
const sampler = new IndependentSampler(SEED);
let integrator = new UnidirectionalPT({ maxBounces: 1, rrStartDepth: 999, sampleNEE: false });
const cache = new Map<number, PathRecord>();

function traced(sampleIndex: number): PathRecord {
  let record = cache.get(sampleIndex);
  if (!record) {
    const key = pixelSeedKey(PIXEL[0], PIXEL[1], sampleIndex);
    sampler.startPixelSample(key);
    const recorder = new ArrayRecorder();
    recorder.beginPath(key);
    integrator.sampleContributions(PIXEL, sampler, scene, recorder);
    recorder.endPath();
    record = recorder.records[0]!;
    cache.set(sampleIndex, record);
    // Bound the cache; the window only ever looks a few hundred samples back.
    if (cache.size > 4000) for (const k of cache.keys()) { if (cache.size <= 2000) break; cache.delete(k); }
  }
  return record;
}

const luminance = (c: readonly [number, number, number]) =>
  0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const swarm = new PathSwarm(POPULATION * 8, swarmGroup);
const infoEl = document.getElementById('info')!;
let litCount = 0;

class SwarmElement implements TimelineElement {
  drawAt(t: number): void {
    const indices = swarmWindow(t, RATE, REPLACE, POPULATION);
    const lines: SwarmPolyline[] = [];
    litCount = 0;
    indices.forEach((index, i) => {
      const record = traced(index);
      if (record.vertices.length < 2) return;
      const last = record.vertices[record.vertices.length - 1]!;
      if (last.primitiveName != null && emissive.has(last.primitiveName)) litCount += 1;
      lines.push({
        points: record.vertices.map((v) => v.p),
        beta: luminance(last.beta),
        palette: 'camera',
        // Oldest in the window is fully aged, newest is fresh.
        age: 1 - i / Math.max(1, indices.length - 1),
      });
    });
    swarm.update(lines);
    infoEl.textContent =
      `pixel (${PIXEL[0]}, ${PIXEL[1]}) · samples ${indices[0]}–${indices[indices.length - 1]} · ` +
      `${POPULATION} on screen, ${REPLACE} replaced ${RATE}×/s · ` +
      `${litCount} of ${POPULATION} reached the light`;
  }

  dispose(): void {}
}

const timeline = new Timeline();
timeline.add(new SwarmElement(), DURATION);

// --- The switch: path length ---
let mode: Mode = 'one';
function setMode(spec: (typeof MODES)[number]): void {
  mode = spec.id;
  integrator = new UnidirectionalPT({
    maxBounces: spec.walkCap,
    rrStartDepth: 999, // roulette would make the population ragged for no gain
    sampleNEE: false,
  });
  cache.clear();
  timeline.setTime(timeline.time); // redraw the current window with the new depth
}

const switchEl = document.getElementById('switch')!;
const buttons = MODES.map((spec) => {
  const b = document.createElement('button');
  b.textContent = spec.label;
  b.setAttribute('aria-pressed', String(spec.id === mode));
  b.addEventListener('click', () => {
    setMode(spec);
    for (const [i, other] of buttons.entries()) {
      other.setAttribute('aria-pressed', String(MODES[i]!.id === mode));
    }
  });
  switchEl.appendChild(b);
  return b;
});

timeline.setTime(0);
timeline.playing = true;

// --- Clock ---
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
  const wasPlaying = timeline.playing;
  timeline.tick((now - last) / 1000);
  last = now;
  if (wasPlaying && !timeline.playing) {
    timeline.setTime(0); // the swarm has no ending to hold on: loop straight back
    timeline.playing = true;
  }
  renderer.render(threeScene, threeCamera);
});

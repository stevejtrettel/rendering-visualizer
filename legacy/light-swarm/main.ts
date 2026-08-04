// SHOWS: light tracing as a population. Paths start AT the emitter, scatter
// once or twice, and try to connect to the camera — BDPT's t = 1 strategies,
// isolated with the integrator's own strategyFilter. Nothing new is computed
// here: this is the code path whose contributions land in the film's splat
// slots, which until now no page has ever drawn.
//
// The cyan subpaths are what the light throws out; the green segments are the
// ones that reach the pinhole and deposit energy; red ones die on an occluder.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SCENES, type SceneName } from '../../src/scenes/registry';
import { vizViewFor } from '../../src/viz/views';
import { buildScene } from '../../src/core/scene/scene';
import { IndependentSampler } from '../../src/core/sampler/independent';
import { pixelSeedKey } from '../../src/core/sampler/sampler';
import { BDPT } from '../../src/core/integrators/bdpt';
import { ArrayRecorder, type PathRecord } from '../../src/trace/records';
import { sceneToThree } from '../../src/viz/three-scene';
import { Timeline, type TimelineElement } from '../../src/viz/timeline';
import { PathSwarm, swarmWindow, type SwarmPolyline } from '../../src/viz/path-swarm';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';

// --- Figure spec ---
const SCENE_NAME: SceneName = 'cornell';
const FILM = 160;
const SEED = 0;
const POPULATION = 100;
const REPLACE = 10;
const RATE = 12;
const DURATION = 30;
const VIEW_W = 900;
const VIEW_H = 620;
// Light tracing is not driven by a pixel — every sample throws a fresh path out
// of the lamp — so the pixel is only a seed-key ingredient, held fixed.
const KEY_PIXEL = [0, 0] as const;

type Mode = 'one' | 'two';
const MODES: ReadonlyArray<{ id: Mode; label: string; walkCap: number }> = [
  { id: 'one', label: '1 bounce', walkCap: 1 },
  { id: 'two', label: '2 bounces', walkCap: 2 },
];

const description = SCENES[SCENE_NAME];
const view = vizViewFor(SCENE_NAME);

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

// --- Tracing ---
const scene = buildScene(description, FILM, FILM);
const sampler = new IndependentSampler(SEED);
// t === 1 only: the light-tracing strategies, whose contributions are splats.
let integrator = new BDPT({ maxBounces: 1, rrStartDepth: 999, strategyFilter: (_s, t) => t === 1 });
const cache = new Map<number, PathRecord>();

function traced(sampleIndex: number): PathRecord {
  let record = cache.get(sampleIndex);
  if (!record) {
    const key = pixelSeedKey(KEY_PIXEL[0], KEY_PIXEL[1], sampleIndex);
    sampler.startPixelSample(key);
    const recorder = new ArrayRecorder();
    recorder.beginPath(key);
    integrator.sampleContributions(KEY_PIXEL, sampler, scene, recorder);
    recorder.endPath();
    record = recorder.records[0]!;
    cache.set(sampleIndex, record);
    if (cache.size > 4000) for (const k of cache.keys()) { if (cache.size <= 2000) break; cache.delete(k); }
  }
  return record;
}

const luminance = (c: readonly [number, number, number]) =>
  0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const swarm = new PathSwarm(POPULATION * 8, swarmGroup);
const infoEl = document.getElementById('info')!;

class SwarmElement implements TimelineElement {
  drawAt(t: number): void {
    const indices = swarmWindow(t, RATE, REPLACE, POPULATION);
    const lines: SwarmPolyline[] = [];
    let reached = 0;
    let blocked = 0;
    indices.forEach((index, i) => {
      const record = traced(index);
      const age = 1 - i / Math.max(1, indices.length - 1);
      if (record.lightVertices.length >= 2) {
        const last = record.lightVertices[record.lightVertices.length - 1]!;
        lines.push({
          points: record.lightVertices.map((v) => v.p),
          beta: luminance(last.beta),
          palette: 'light',
          age,
        });
      }
      for (const c of record.connections) {
        if (c.occluded) blocked += 1;
        else reached += 1;
        lines.push({
          points: [c.to, c.occluded && c.blockedAt ? c.blockedAt : c.from],
          beta: 1,
          palette: c.occluded ? 'blocked' : 'connection',
          age,
        });
      }
    });
    swarm.update(lines);
    infoEl.textContent =
      `${POPULATION} light paths on screen, ${REPLACE} replaced ${RATE}×/s · ` +
      `${reached} reached the camera, ${blocked} blocked · ` +
      `the rest could not see the pinhole at all`;
  }

  dispose(): void {}
}

const timeline = new Timeline();
timeline.add(new SwarmElement(), DURATION);

// --- The switch ---
let mode: Mode = 'one';
function setMode(spec: (typeof MODES)[number]): void {
  mode = spec.id;
  integrator = new BDPT({
    maxBounces: spec.walkCap,
    rrStartDepth: 999,
    strategyFilter: (_s, t) => t === 1,
  });
  cache.clear();
  timeline.setTime(timeline.time);
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
    timeline.setTime(0);
    timeline.playing = true;
  }
  renderer.render(threeScene, threeCamera);
});

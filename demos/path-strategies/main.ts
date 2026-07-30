// SHOWS: one pixel, one sample, three integrators — the switch between them IS
// the subject, so it is the one control on the page. Same seed, same depth cap,
// roulette off: the only difference is what kind of path the algorithm builds.
//
// At sample 0 plain PT finds nothing, NEE carries light from its first vertex,
// and BDPT has a whole second subpath to connect to. That contrast is the
// figure; the info line states each outcome.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SCENES, emissiveNames, vizViewFor, type SceneName } from '../_shared/scenes';
import { buildScene } from '../../src/core/scene/scene';
import { IndependentSampler } from '../../src/core/sampler/independent';
import { pixelSeedKey } from '../../src/core/sampler/sampler';
import { UnidirectionalPT } from '../../src/core/integrators/pt';
import { NEEPathTracer } from '../../src/core/integrators/pt-nee';
import { BDPT } from '../../src/core/integrators/bdpt';
import type { Integrator } from '../../src/core/integrators/types';
import { ArrayRecorder, type PathRecord } from '../../src/trace/records';
import { sceneToThree } from '../../src/viz/three-scene';
import { Timeline } from '../../src/viz/timeline';
import { buildSchedule, type PathSchedule, type ScheduleConfig } from '../../src/viz/path-schedule';
import { ConnectionFlash, pathElements, type PathStyle } from '../../src/viz/path-elements';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';

// --- Figure spec ---
const SCENE_NAME: SceneName = 'cornell';
const FILM = 160;
const PIXEL = [88, 118] as const;
const SAMPLE = 0;
const SEED = 0;
// Why the paths stop where they do: this cap, and nothing else. Roulette is off
// here — it would kill one integrator's walk earlier than another's and wreck
// the comparison — and in a closed box nothing else ends a walk (measured:
// plain PT with roulette off averages 46 bounces against a 64 cap).
//
// 6 is chosen against measurement, not taste: with a hard cap and roulette off,
// paths of ≤6 bounces carry 99.1% of `cornell`'s converged image energy (≤3
// carries 93.5%, ≤8 carries 99.8%) — the walls are albedo 0.73, so energy decays
// like 0.73^k. Under the renderer's real defaults the SAMPLED lengths are
// shorter still: mean 3.5, median 3, p99 9. Production renderers set total
// depth around 8–16, but that is a ceiling, not a typical path length.
// (Roulette itself is the subject of path-outcomes, where it belongs.)
const MAX_BOUNCES = 6;
const NO_RR = 999;
// Fast enough to watch repeatedly: ~14 world units of segment growth per second
// and a brief pause at each vertex, instead of the substrate's slow default.
const SCHEDULE: ScheduleConfig = { speed: 14, momentSeconds: 0.3, startTime: 0, escapeLength: 3 };
const CONNECTION_SPACING = 0.12; // seconds between BDPT connection flashes
const LOOP_HOLD = 0.8; // seconds the finished path holds before replaying
const VIEW_W = 900;
const VIEW_H = 620;

type Mode = 'pt' | 'pt-nee' | 'bdpt';
const MODES: ReadonlyArray<{ id: Mode; label: string }> = [
  { id: 'pt', label: 'PT — bounce and hope' },
  { id: 'pt-nee', label: 'PT + NEE — connect at every vertex' },
  { id: 'bdpt', label: 'BDPT — two subpaths, connected' },
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

// --- Tracing ---
const scene = buildScene(description, FILM, FILM);
const sampler = new IndependentSampler(SEED);
const integrators: Record<Mode, Integrator> = {
  pt: new UnidirectionalPT({ maxBounces: MAX_BOUNCES, rrStartDepth: NO_RR, sampleNEE: false }),
  'pt-nee': new NEEPathTracer({ maxBounces: MAX_BOUNCES, rrStartDepth: NO_RR }),
  bdpt: new BDPT({ maxBounces: MAX_BOUNCES, rrStartDepth: NO_RR }),
};

function trace(mode: Mode): PathRecord {
  const key = pixelSeedKey(PIXEL[0], PIXEL[1], SAMPLE);
  sampler.startPixelSample(key);
  const recorder = new ArrayRecorder();
  recorder.beginPath(key);
  integrators[mode].sampleContributions(PIXEL, sampler, scene, recorder);
  recorder.endPath();
  return recorder.records[0]!;
}

// A connection can only flash once both of its endpoints have been drawn; the
// eye and a resampled light point are there from the start.
function arrivalTime(
  schedule: PathSchedule,
  vertices: PathRecord['vertices'],
  p: readonly [number, number, number],
): number {
  const idx = vertices.findIndex(
    (v) => Math.abs(v.p[0] - p[0]) < 1e-9 && Math.abs(v.p[1] - p[1]) < 1e-9 && Math.abs(v.p[2] - p[2]) < 1e-9,
  );
  if (idx <= 0) return 0;
  return schedule.moments.find((m) => m.vertexIndex === idx)?.start ?? 0;
}

const timeline = new Timeline();
const infoEl = document.getElementById('info')!;

function build(mode: Mode): void {
  const record = trace(mode);
  timeline.clear();

  const camSchedule = buildSchedule(record, emissive, SCHEDULE, {
    vertices: record.vertices,
    role: 'camera',
  });
  for (const el of pathElements(camSchedule, record.vertices.map((v) => v.delta), style, pathsGroup)) {
    timeline.add(el, camSchedule.duration);
  }

  // BDPT only: the light subpath grows on the same clock, in cyan, and every
  // connection attempt flashes once its two endpoints exist.
  let lightSchedule: PathSchedule | null = null;
  if (mode === 'bdpt' && record.lightVertices.length > 0) {
    lightSchedule = buildSchedule(record, emissive, SCHEDULE, {
      vertices: record.lightVertices,
      role: 'light',
    });
    const lightStyle: PathStyle = { ...style, palette: 'light' };
    const deltas = record.lightVertices.map((v) => v.delta);
    for (const el of pathElements(lightSchedule, deltas, lightStyle, pathsGroup)) {
      timeline.add(el, lightSchedule.duration);
    }
  }
  if (mode === 'bdpt') {
    const timed = record.connections
      .map((c) => ({
        c,
        time: Math.max(
          arrivalTime(camSchedule, record.vertices, c.from),
          lightSchedule ? arrivalTime(lightSchedule, record.lightVertices, c.to) : 0,
        ),
      }))
      .sort((a, b) => a.time - b.time);
    let prev = -Infinity;
    for (const entry of timed) {
      const at = Math.max(entry.time, prev + CONNECTION_SPACING);
      prev = at;
      timeline.add(new ConnectionFlash(entry.c, at, style, pathsGroup), at + 1.2);
    }
  }

  timeline.setTime(0);
  timeline.playing = true;

  const bounces = record.vertices.length - 1;
  const carried = record.contributions.some((c) => c.value.some((v) => v > 0));
  const stopped = bounces >= MAX_BOUNCES ? ` (the ${MAX_BOUNCES}-bounce cap)` : '';
  const head =
    `pixel (${PIXEL[0]}, ${PIXEL[1]}) · sample ${SAMPLE} · ` +
    `${bounces} camera bounce${bounces === 1 ? '' : 's'}${stopped}`;
  if (mode === 'pt') {
    const hitLight = record.vertices.some((v) => v.primitiveName != null && emissive.has(v.primitiveName));
    infoEl.textContent = `${head} · BSDF sampling only · ${hitLight ? 'happened to hit the light' : 'never found the light — this sample is black'}`;
  } else if (mode === 'pt-nee') {
    const blocked = record.shadowRays.filter((sr) => sr.occluded).length;
    infoEl.textContent =
      `${head} · ${record.shadowRays.length} light connections (${blocked} blocked) · ` +
      `${carried ? 'carried light' : 'found nothing'}`;
  } else {
    const lightBounces = Math.max(0, record.lightVertices.length - 1);
    const blocked = record.connections.filter((c) => c.occluded).length;
    infoEl.textContent =
      `${head}, ${lightBounces} light-subpath bounce${lightBounces === 1 ? '' : 's'} · ` +
      `${record.connections.length} connections tried (${blocked} blocked) · ` +
      `${carried ? 'carried light' : 'found nothing'}`;
  }
}

// --- The switch (the page's subject, hence its only control) ---
let mode: Mode = 'pt';
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

// --- Clock (loops, so a short animation stays readable) ---
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
  // Only a playthrough that ran to the end schedules a replay — pausing or
  // scrubbing to the end leaves the clock alone.
  if (wasPlaying && !timeline.playing) replayAt = now + LOOP_HOLD * 1000;
  if (replayAt > 0 && now >= replayAt) {
    replayAt = 0;
    timeline.setTime(0);
    timeline.playing = true;
  }
  renderer.render(threeScene, threeCamera);
});

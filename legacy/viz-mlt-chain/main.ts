// SHOWS: one Metropolis chain walking through path space — the design
// language's MLT row made real: the current path solid, each proposal
// ghosted beside it, accepted proposals solidifying into the new current
// path, rejected ones evaporating. Beside the scene, the chain's splats
// accumulate on the film: Metropolis renders by leaving footprints where
// the energy is. Everything replays deterministically from the constants
// below — the chain IS its seed (bootstrap index picked ∝ luminance,
// re-run, never stored).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { SCENES } from '../../src/scenes/registry';
import { vizViewFor } from '../../src/viz/views';
import { buildScene } from '../../src/core/scene/scene';
import { Film } from '../../src/render/film';
import { srgbEncode } from '../../src/render/film';
import { MltRunner } from '../../src/render/mlt-driver';
import { ArrayRecorder, type PathRecord } from '../../src/trace/records';
import { sceneToThree } from '../../src/viz/three-scene';
import { Timeline, type TimelineElement } from '../../src/viz/timeline';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';

// --- Figure spec (every parameter a constant; the chain index is the one
// worth playing with — each value replays a different deterministic chain) ---
const SCENE_NAME = 'cornell-glass';
const FILM_RES = 96;
const MAX_DEPTH = 8;
const N_BOOTSTRAP = 16384;
// Chain 8 (with SEED 0, N_BOOTSTRAP 16384): a depth-5 chain that lives in
// the glass — 7-vertex paths, ~55% acceptance, half its proposals crossing
// the glass ball. Other values replay other deterministic chains.
const CHAIN_INDEX = 8;
const N_MUTATIONS = 150;
const STEP_SECONDS = 0.9; // one mutation per step
const SPLAT_EXPOSURE = 0.9;
const VIEW_W = 860;
const VIEW_H = 620;
const SEED = 0;

const GHOST_OPACITY = 0.3;
const CURRENT_OPACITY = 0.95;
const CAMERA_COLOR = 0xffb054; // design language amber
const LIGHT_COLOR = 0x33ccee; // light-subpath cyan
const CONNECT_OK = 0x44cc66;
const CONNECT_BLOCKED = 0xdd4444;

const infoEl = document.getElementById('info')!;
const mutationEl = document.getElementById('mutation')!;
const factsEl = document.getElementById('chain-facts')!;

// --- Trace the chain (main thread; bootstrap runs once, then seed replay) ---
const description = SCENES[SCENE_NAME];
const scene = buildScene(description, FILM_RES, FILM_RES);
const film = new Film(FILM_RES, FILM_RES);
const runner = new MltRunner(scene, film, {
  seed: SEED,
  maxDepth: MAX_DEPTH,
  nBootstrap: N_BOOTSTRAP,
});
const recorder = new ArrayRecorder();
runner.runChains(CHAIN_INDEX, 1, N_MUTATIONS, recorder);
// records[0] is the chain-start state (mutation null); [1..] the proposals.
const records = recorder.records;
const seedIndex = records[0]!.key.seq[1]!;
const chainDepth = seedIndex % (MAX_DEPTH + 1);
factsEl.textContent =
  `chain ${CHAIN_INDEX} · bootstrap seed ${seedIndex} · path depth ${chainDepth} ` +
  `(${chainDepth + 2} vertices) · b = ${runner.b.toFixed(3)}`;

// --- three.js scene ---
const vizPane = document.getElementById('viz-pane')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(VIEW_W, VIEW_H);
renderer.setPixelRatio(window.devicePixelRatio);
vizPane.appendChild(renderer.domElement);

const threeScene = new THREE.Scene();
threeScene.background = new THREE.Color(0x141414);
threeScene.add(sceneToThree(description));

const view = vizViewFor(SCENE_NAME);
const threeCamera = new THREE.PerspectiveCamera(45, VIEW_W / VIEW_H, 0.01, 100);
threeCamera.position.set(...view.eye);
const controls = new OrbitControls(threeCamera, renderer.domElement);
controls.target.set(...view.target);
controls.update();

const pathsGroup = new THREE.Group();
threeScene.add(pathsGroup);

// --- One record -> one drawable bundle (camera amber, light cyan,
// connection green/red), opacity-controllable as a unit ---
interface Bundle {
  group: THREE.Group;
  materials: LineMaterial[];
}

const resolution = new THREE.Vector2(VIEW_W * devicePixelRatio, VIEW_H * devicePixelRatio);

function polyline(points: ReadonlyArray<readonly [number, number, number]>, color: number, width: number): Line2 | null {
  if (points.length < 2) return null;
  const g = new LineGeometry();
  g.setPositions(points.flatMap((p) => [...p]));
  const material = new LineMaterial({ color, linewidth: width, transparent: true, opacity: 0 });
  material.resolution.copy(resolution);
  return new Line2(g, material);
}

function makeBundle(r: PathRecord): Bundle {
  const group = new THREE.Group();
  const materials: LineMaterial[] = [];
  const add = (line: Line2 | null) => {
    if (!line) return;
    materials.push(line.material as LineMaterial);
    group.add(line);
  };
  add(polyline(r.vertices.map((v) => v.p), CAMERA_COLOR, 3));
  add(polyline(r.lightVertices.map((v) => v.p), LIGHT_COLOR, 3));
  for (const c of r.connections) {
    const to = c.occluded && c.blockedAt ? c.blockedAt : c.to;
    add(polyline([c.from, to], c.occluded ? CONNECT_BLOCKED : CONNECT_OK, 2.2));
  }
  group.visible = false;
  pathsGroup.add(group);
  return { group, materials };
}

const bundles = records.map(makeBundle);

// currentOf[m]: index into records of the chain's CURRENT state while
// mutation m is being proposed (the latest accepted record before m+1).
const currentOf: number[] = [];
{
  let cur = 0;
  for (let m = 0; m < N_MUTATIONS; m++) {
    currentOf.push(cur);
    if (records[m + 1]!.mutation!.accepted) cur = m + 1;
  }
}

// Strategy label for a record: the connection event carries (s, t); an
// s = 0 record has none — its whole path is the camera walk.
function strategyOf(r: PathRecord): string {
  const c = r.connections[0];
  return c ? `s=${c.s} t=${c.t}` : `s=0 t=${r.vertices.length}`;
}

const setOpacity = (b: Bundle, opacity: number): void => {
  b.group.visible = opacity > 0.01;
  for (const m of b.materials) m.opacity = opacity;
};

class ChainReplay implements TimelineElement {
  private lastInfoStep = -1;

  drawAt(t: number): void {
    const step = Math.min(N_MUTATIONS - 1, Math.max(0, Math.floor(t / STEP_SECONDS)));
    const frac = Math.min(1, t / STEP_SECONDS - step);
    const currentIdx = currentOf[step]!;
    const proposalIdx = step + 1;
    const mut = records[proposalIdx]!.mutation!;

    for (let i = 0; i < bundles.length; i++) {
      if (i !== currentIdx && i !== proposalIdx) setOpacity(bundles[i]!, 0);
    }

    // Ghost breathes in, then the decision lands at 70% of the step:
    // accept — the ghost solidifies while the old current fades;
    // reject — the ghost evaporates and the current holds.
    const ghostIn = Math.min(1, frac / 0.25) * GHOST_OPACITY;
    if (frac < 0.7) {
      setOpacity(bundles[currentIdx]!, CURRENT_OPACITY);
      setOpacity(bundles[proposalIdx]!, ghostIn);
    } else {
      const d = (frac - 0.7) / 0.3;
      if (mut.accepted) {
        setOpacity(bundles[proposalIdx]!, GHOST_OPACITY + (CURRENT_OPACITY - GHOST_OPACITY) * d);
        setOpacity(bundles[currentIdx]!, CURRENT_OPACITY * (1 - d));
      } else {
        setOpacity(bundles[proposalIdx]!, GHOST_OPACITY * (1 - d));
        setOpacity(bundles[currentIdx]!, CURRENT_OPACITY);
      }
    }

    if (step !== this.lastInfoStep) {
      this.lastInfoStep = step;
      let accepted = 0;
      for (let m = 1; m <= step + 1; m++) if (records[m]!.mutation!.accepted) accepted += 1;
      const cls = mut.accepted ? 'accept' : 'reject';
      mutationEl.innerHTML =
        `mutation ${step + 1}/${N_MUTATIONS} · ` +
        `<span class="${mut.type === 'large' ? 'large' : ''}">${mut.type} step</span> · ` +
        `${strategyOf(records[proposalIdx]!)} · a = ${mut.a.toFixed(3)} · ` +
        `<span class="${cls}">${mut.accepted ? 'accepted' : 'rejected'}</span> · ` +
        `rate ${((accepted / (step + 1)) * 100).toFixed(0)}%`;
    }
  }

  dispose(): void {
    for (const b of bundles) setOpacity(b, 0);
  }
}

// --- The splat film panel, on the same clock ---
const splatCanvas = document.getElementById('splats') as HTMLCanvasElement;
const splatCtx = splatCanvas.getContext('2d')!;

class SplatFilm implements TimelineElement {
  private readonly sums = new Float64Array(FILM_RES * FILM_RES * 3);
  private applied = 0; // records[1..applied] accumulated

  private apply(idx: number, sign: 1): void {
    for (const c of records[idx]!.contributions) {
      const x = Math.min(FILM_RES - 1, Math.max(0, Math.floor(c.raster[0])));
      const y = Math.min(FILM_RES - 1, Math.max(0, Math.floor(c.raster[1])));
      const o = (y * FILM_RES + x) * 3;
      this.sums[o]! += sign * c.value[0];
      this.sums[o + 1]! += sign * c.value[1];
      this.sums[o + 2]! += sign * c.value[2];
    }
  }

  drawAt(t: number): void {
    const step = Math.min(N_MUTATIONS, Math.max(0, Math.floor(t / STEP_SECONDS) + 1));
    if (step < this.applied) {
      this.sums.fill(0);
      this.applied = 0;
    }
    while (this.applied < step) {
      this.applied += 1;
      this.apply(this.applied, 1);
    }
    // Production normalization for this many mutations, times a display
    // exposure (one chain covers only its own footprint of the film).
    const scale = (runner.b * FILM_RES * FILM_RES * SPLAT_EXPOSURE) / Math.max(1, this.applied);
    const image = splatCtx.createImageData(FILM_RES, FILM_RES);
    for (let i = 0; i < FILM_RES * FILM_RES; i++) {
      image.data[i * 4] = srgbEncode(this.sums[i * 3]! * scale);
      image.data[i * 4 + 1] = srgbEncode(this.sums[i * 3 + 1]! * scale);
      image.data[i * 4 + 2] = srgbEncode(this.sums[i * 3 + 2]! * scale);
      image.data[i * 4 + 3] = 255;
    }
    splatCtx.putImageData(image, 0, 0);
  }

  dispose(): void {}
}

// --- Clock, controls, recording ---
const timeline = new Timeline();
timeline.add(new ChainReplay(), N_MUTATIONS * STEP_SECONDS);
timeline.add(new SplatFilm(), N_MUTATIONS * STEP_SECONDS);

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

const nLarge = records.slice(1).filter((r) => r.mutation!.type === 'large').length;
infoEl.textContent =
  `${SCENE_NAME} · ${N_MUTATIONS} mutations (${nLarge} large steps) · deterministic replay of one chain`;

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  timeline.tick((now - last) / 1000);
  last = now;
  renderer.render(threeScene, threeCamera);
});
timeline.setTime(0);
timeline.playing = true;

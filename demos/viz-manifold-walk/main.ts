// SHOWS: the manifold walk itself — seed, Newton iterates sliding on the
// caster, and the solved specular connection — for one fixed receiver/light
// pair, played as the M attempts of one biased-SMS estimate. Scenes: the
// V5a single-bounce trio (mirror ball / glass bulb / mirror dome) and the
// V5b TWO-BOUNCE glass ball (cornell-glass: the classic caustic, both
// candidate crossings sliding in step). Switches: constraint formulation
// (the measured success-rate story), seed mode (random vs the MNEE-style
// deterministic seed — which can only ever find ONE root), and M.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { SCENES, vizViewFor } from '../_shared/scenes';
import { buildScene, type Scene, type SceneDescription } from '../../src/core/scene/scene';
import { Sphere } from '../../src/core/geometry/sphere';
import { Vec3 } from '../../src/core/math/vec3';
import { Ray } from '../../src/core/math/ray';
import { PCG32 } from '../../src/core/math/pcg32';
import { u64 } from '../../src/core/math/u64';
import { uniformSampleSphere } from '../../src/core/math/sampling';
import { RAY_EPSILON } from '../../src/core/geometry/offset';
import {
  manifoldWalk,
  sameSolution,
  DEFAULT_WALK_OPTIONS,
  type ManifoldWalkOptions,
  type ManifoldWalkOutcome,
} from '../../src/core/manifold/newton';
import { chainSeed, chainWalk, type ChainLink } from '../../src/core/manifold/chain';
import type { ConstraintType } from '../../src/core/manifold/constraints';
import { Timeline, type TimelineElement } from '../../src/viz/timeline';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';
import { sceneToThree } from '../../src/viz/three-scene';

// --- Figure spec ---
const VIEW_W = 900;
const VIEW_H = 620;
const SEED = 0;
const SEED_SECONDS = 0.5; // dotted seed chain draw time
const ITER_SECONDS = 0.35; // per Newton iterate
const RESOLVE_SECONDS = 0.9; // solid-chain flash / evaporate time
const LOOP_HOLD = 1.5;
const SOLVED_OPACITY = 0.9;
const ROOT_HUES = [0.33, 0.55, 0.78, 0.12, 0.9]; // one hue per distinct root
const CHAIN_MAX_ITERATIONS = 32; // chains ramp beta from 0.1 (see chain.ts)

// The refractive companion scene (the glass bulb of the V5 tests): an
// emitter inside a solid glass sphere — NEE is always occluded here.
const WHITE = { kind: 'lambert' as const, albedo: [0.73, 0.73, 0.73] as const };
const GLASS_BULB: SceneDescription = {
  camera: { eye: [0, 1.6, 5], lookAt: [0, 0.6, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-4, 0, -4], e1: [0, 0, 9], e2: [8, 0, 0] }, material: WHITE },
    { name: 'back', shape: { kind: 'quad', q: [-4, 0, -4], e1: [8, 0, 0], e2: [0, 4, 0] }, material: WHITE },
    { name: 'glassShell', shape: { kind: 'sphere', center: [0, 1, 0], radius: 0.6 }, material: { kind: 'dielectric', ior: 1.5 } },
    { name: 'bulb', shape: { kind: 'quad', q: [-0.15, 1.02, -0.15], e1: [0.3, 0, 0], e2: [0, 0, 0.3] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [60, 60, 60] } },
  ],
};

// The mirror dome of viz-caustic-fold: concave, so the fiber has MULTIPLE
// roots — the configuration where MNEE's single deterministic seed
// provably under-counts and random seeds pay off.
const MIRROR_DOME: SceneDescription = {
  camera: { eye: [0, 1.9, 2.5], lookAt: [0, 0.2, 0], up: [0, 1, 0], fovDegrees: 55 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-2.4, 0, -2.4], e1: [0, 0, 4.8], e2: [4.8, 0, 0] }, material: WHITE },
    { name: 'light', shape: { kind: 'quad', q: [1.1, 2.0, -0.1], e1: [0.2, 0, 0], e2: [0, 0, 0.2] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [120, 120, 120] } },
    { name: 'dome', shape: { kind: 'sphere', center: [0, 0.8, 0], radius: 3 }, material: { kind: 'mirror', f0: [0.95, 0.95, 0.95] } },
  ],
};

interface SceneConfig {
  description: SceneDescription;
  casterName: string;
  eta: number;
  bounces: 1 | 2; // 2 = the V5b chain through the same caster twice
  receiver: Vec3; // fixed shading point a on the floor
  lightP: Vec3; // fixed light point b
  view: { eye: readonly [number, number, number]; target: readonly [number, number, number] };
}

const SCENE_CONFIGS: Record<'mirror' | 'bulb' | 'dome' | 'glass2', SceneConfig> = {
  mirror: {
    description: SCENES['caustic-ring'],
    casterName: 'mirrorBall',
    eta: 1,
    bounces: 1,
    receiver: new Vec3(-0.8, 0.001, 0.55), // in the ball's connectible zone (left, toward the light)
    lightP: new Vec3(-1.999, 2.6, 0), // wall-light center
    view: vizViewFor('caustic-ring'),
  },
  bulb: {
    description: GLASS_BULB,
    casterName: 'glassShell',
    eta: 1.5,
    bounces: 1,
    receiver: new Vec3(0.55, 0.001, 0.45),
    lightP: new Vec3(0, 1.02, 0), // bulb center
    view: { eye: [3.6, 2.6, 5.2], target: [0, 0.8, 0] },
  },
  dome: {
    description: MIRROR_DOME,
    casterName: 'dome',
    eta: 1,
    bounces: 1,
    receiver: new Vec3(0.2, 0.001, 0), // inside the two-branch band past the fold
    lightP: new Vec3(1.2, 2.0, 0), // lamp center
    view: { eye: [1.5, 2.1, 1.9], target: [-0.4, 0.2, 0] }, // inside the dome
  },
  glass2: {
    description: SCENES['cornell-glass'],
    casterName: 'glassBall',
    eta: 1.5,
    bounces: 2,
    receiver: new Vec3(-1.2, 0.001, -1.2), // floor caustic left-behind the ball (probed: 8/8 random seeds converge)
    lightP: new Vec3(0, 3.998, 0), // ceiling-light center
    view: vizViewFor('cornell-glass'),
  },
};

type SceneMode = keyof typeof SCENE_CONFIGS;
type SeedMode = 'random' | 'mnee';

let sceneMode: SceneMode = 'glass2';
let constraint: ConstraintType = 'halfvector';
let seedMode: SeedMode = 'random';
let M = 8;

// --- three.js boilerplate ---
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(VIEW_W, VIEW_H);
renderer.setPixelRatio(window.devicePixelRatio);
document.getElementById('viz-pane')!.appendChild(renderer.domElement);

const threeScene = new THREE.Scene();
threeScene.background = new THREE.Color(0x141414);
let sceneGroup = sceneToThree(SCENE_CONFIGS[sceneMode].description);
threeScene.add(sceneGroup);

const threeCamera = new THREE.PerspectiveCamera(45, VIEW_W / VIEW_H, 0.01, 100);
const controls = new OrbitControls(threeCamera, renderer.domElement);
const applyView = () => {
  const view = SCENE_CONFIGS[sceneMode].view;
  threeCamera.position.set(...view.eye);
  controls.target.set(...view.target);
  controls.update();
};
applyView();

const pathsGroup = new THREE.Group();
threeScene.add(pathsGroup);
const resolution = new THREE.Vector2(VIEW_W * devicePixelRatio, VIEW_H * devicePixelRatio);
const infoEl = document.getElementById('info')!;
const timeline = new Timeline();

// --- Walk data (chain-generic: an m = 1 walk is a chain of length 1) ---
interface WalkVisual {
  seedChain: Vec3[] | null; // null: seed ray missed the caster entirely
  iterates: { chain: Vec3[]; cNorm: number }[];
  outcome: ManifoldWalkOutcome | 'missed-caster';
  solution: Vec3[] | null;
  rootIndex: number; // distinct-root index for coloring, -1 if failed
}

function computeWalks(): { walks: WalkVisual[]; scene: Scene; roots: Vec3[] } {
  const cfg = SCENE_CONFIGS[sceneMode];
  const scene = buildScene(cfg.description, 64, 64);
  const caster = scene.primitives.find((p) => p.name === cfg.casterName)!;
  const sphere = caster.shape as Sphere;
  const rng = new PCG32(u64(0, SEED), u64(0, 0));
  const walks: WalkVisual[] = [];
  const roots: Vec3[] = [];
  const attempts = seedMode === 'mnee' ? 1 : M;
  const walkOptions: ManifoldWalkOptions = {
    ...DEFAULT_WALK_OPTIONS,
    constraint,
    ...(cfg.bounces === 2 ? { maxIterations: CHAIN_MAX_ITERATIONS } : {}),
  };

  for (let m = 0; m < attempts; m++) {
    let target: Vec3;
    if (seedMode === 'mnee') {
      target = cfg.eta !== 1 || cfg.bounces === 2 ? cfg.lightP : sphere.center;
    } else {
      target = sphere.center.add(uniformSampleSphere([rng.nextFloat(), rng.nextFloat()]).scale(sphere.radius));
    }

    let visual: WalkVisual;
    if (cfg.bounces === 2) {
      const links: ChainLink[] = [
        { primitive: caster, eta: cfg.eta },
        { primitive: caster, eta: cfg.eta },
      ];
      const seeds = chainSeed(cfg.receiver, target, links, scene.aggregate);
      if (!seeds) {
        visual = { seedChain: null, iterates: [], outcome: 'missed-caster', solution: null, rootIndex: -1 };
      } else {
        const result = chainWalk(cfg.receiver, seeds, links, cfg.lightP, scene.aggregate, walkOptions);
        visual = {
          seedChain: seeds.map((h) => h.p),
          iterates: result.iterates,
          outcome: result.outcome,
          solution: result.vertices ? result.vertices.map((v) => v.p) : null,
          rootIndex: -1,
        };
      }
    } else {
      const dir = target.sub(cfg.receiver).normalize();
      const seedHit = scene.aggregate.intersect(new Ray(cfg.receiver.add(dir.scale(RAY_EPSILON)), dir));
      if (!seedHit || seedHit.primitive !== caster) {
        visual = { seedChain: null, iterates: [], outcome: 'missed-caster', solution: null, rootIndex: -1 };
      } else {
        const result = manifoldWalk(cfg.receiver, seedHit, cfg.eta, cfg.lightP, caster, scene.aggregate, walkOptions);
        visual = {
          seedChain: [seedHit.p],
          iterates: result.iterates.map((it) => ({ chain: [it.p], cNorm: it.cNorm })),
          outcome: result.outcome,
          solution: result.vertex ? [result.vertex.p] : null,
          rootIndex: -1,
        };
      }
    }

    if (visual.solution) {
      const d = visual.solution[0]!.sub(cfg.receiver).normalize();
      visual.rootIndex = roots.findIndex((r) => sameSolution(r.sub(cfg.receiver).normalize(), d));
      if (visual.rootIndex < 0) {
        visual.rootIndex = roots.length;
        roots.push(visual.solution[0]!);
      }
    }
    walks.push(visual);
  }
  return { walks, scene, roots };
}

// --- Drawing ---
const t3 = (v: Vec3): [number, number, number] => [v.x, v.y, v.z];

function fatLine(points: ReadonlyArray<readonly [number, number, number]>, color: number, width: number): Line2 {
  const g = new LineGeometry();
  g.setPositions(points.flatMap((p) => [...p]));
  const material = new LineMaterial({ color, linewidth: width, transparent: true, opacity: 0 });
  material.resolution.copy(resolution);
  return new Line2(g, material);
}

function marker(p: Vec3, color: number, r = 0.05): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(r, 12, 8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
  );
  mesh.position.set(...t3(p));
  return mesh;
}

// Residual → color ramp: red (large ‖C‖) → green (at the threshold).
function residualColor(cNorm: number): THREE.Color {
  const hi = Math.log10(2);
  const lo = Math.log10(DEFAULT_WALK_OPTIONS.solverThreshold);
  const x = Math.min(1, Math.max(0, (hi - Math.log10(Math.max(cNorm, 1e-12))) / (hi - lo)));
  return new THREE.Color().setHSL(0.33 * x, 0.9, 0.55);
}

let currentSphereCenter = new THREE.Vector3();

// One walk attempt on the timeline: dotted seed chain, iterate dots with
// one sliding "current" dot PER CHAIN VERTEX (the two-bounce mode slides
// both crossings in step), then a solid chain or evaporation.
class WalkElement implements TimelineElement {
  private readonly group = new THREE.Group();
  private readonly seedLine: THREE.Line | null = null;
  private readonly iterateDots: THREE.Mesh[][] = []; // [iterate][vertex]
  private readonly sliders: THREE.Mesh[] = [];
  private readonly normalArrows: THREE.ArrowHelper[] = [];
  private readonly chainLine: Line2 | null = null;
  readonly duration: number;

  constructor(
    private readonly walk: WalkVisual,
    private readonly start: number,
    receiver: Vec3,
    lightP: Vec3,
    parent: THREE.Object3D,
  ) {
    parent.add(this.group);
    this.duration = SEED_SECONDS + this.walk.iterates.length * ITER_SECONDS + RESOLVE_SECONDS;
    if (!walk.seedChain) return;

    const seedPts = [receiver, ...walk.seedChain].map((p) => new THREE.Vector3(...t3(p)));
    const seedGeom = new THREE.BufferGeometry().setFromPoints(seedPts);
    const seedMat = new THREE.LineDashedMaterial({ color: 0x9a9a9a, dashSize: 0.08, gapSize: 0.06, transparent: true, opacity: 0 });
    this.seedLine = new THREE.Line(seedGeom, seedMat);
    this.seedLine.computeLineDistances();
    this.group.add(this.seedLine);

    const nVerts = walk.seedChain.length;
    for (const it of walk.iterates) {
      const row: THREE.Mesh[] = [];
      for (const p of it.chain) {
        const dot = marker(p, 0xffffff, 0.022);
        (dot.material as THREE.MeshBasicMaterial).color = residualColor(it.cNorm);
        (dot.material as THREE.MeshBasicMaterial).opacity = 0;
        this.group.add(dot);
        row.push(dot);
      }
      this.iterateDots.push(row);
    }
    if (walk.iterates.length > 0) {
      for (let v = 0; v < nVerts; v++) {
        const slider = marker(new Vec3(0, 0, 0), 0xffffff, 0.034);
        this.group.add(slider);
        this.sliders.push(slider);
        const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.45, 0xdddddd, 0.1, 0.05);
        this.group.add(arrow);
        this.normalArrows.push(arrow);
      }
    }
    if (walk.solution) {
      const hue = ROOT_HUES[walk.rootIndex % ROOT_HUES.length]!;
      const color = new THREE.Color().setHSL(hue, 0.85, 0.6).getHex();
      this.chainLine = fatLine([t3(receiver), ...walk.solution.map(t3), t3(lightP)], color, 4);
      this.group.add(this.chainLine);
    }
  }

  drawAt(t: number): void {
    const local = t - this.start;
    const iterates = this.walk.iterates;
    const iterEnd = SEED_SECONDS + iterates.length * ITER_SECONDS;
    const converged = this.walk.solution !== null;

    if (this.seedLine) {
      const m = this.seedLine.material as THREE.LineDashedMaterial;
      if (local < 0) m.opacity = 0;
      else if (local < iterEnd) m.opacity = 0.55 * Math.min(1, local / SEED_SECONDS);
      else m.opacity = Math.max(0, 0.55 * (1 - (local - iterEnd) / RESOLVE_SECONDS));
    }

    const failFade = converged ? 1 : Math.max(0, 1 - Math.max(0, local - iterEnd) / RESOLVE_SECONDS);
    for (const [i, row] of this.iterateDots.entries()) {
      const at = SEED_SECONDS + i * ITER_SECONDS;
      for (const dot of row) {
        (dot.material as THREE.MeshBasicMaterial).opacity = (local >= at ? 0.85 : 0) * failFade;
      }
    }

    if (this.sliders.length > 0 && iterates.length > 0) {
      const active = local >= SEED_SECONDS && local < iterEnd + (converged ? 0 : RESOLVE_SECONDS);
      const k = Math.min(iterates.length - 1, Math.max(0, Math.floor((local - SEED_SECONDS) / ITER_SECONDS)));
      const frac = Math.min(1, Math.max(0, (local - SEED_SECONDS) / ITER_SECONDS - k));
      for (const [v, slider] of this.sliders.entries()) {
        const sm = slider.material as THREE.MeshBasicMaterial;
        sm.opacity = active ? 0.95 * failFade : 0;
        const arrow = this.normalArrows[v]!;
        arrow.visible = active && failFade > 0.05;
        if (active) {
          const a = iterates[k]!.chain[v]!;
          const b = iterates[Math.min(iterates.length - 1, k + 1)]!.chain[v] ?? a;
          slider.position.set(a.x + (b.x - a.x) * frac, a.y + (b.y - a.y) * frac, a.z + (b.z - a.z) * frac);
          sm.color = residualColor(iterates[k]!.cNorm);
          arrow.position.copy(slider.position);
          arrow.setDirection(slider.position.clone().sub(currentSphereCenter).normalize());
        }
      }
    }

    if (this.chainLine) {
      const dt = local - iterEnd;
      const o = dt <= 0 ? 0 : Math.min(1, dt / 0.25) * (SOLVED_OPACITY + 0.4 * Math.exp(-3 * dt));
      (this.chainLine.material as LineMaterial).opacity = o;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) (mesh.material as THREE.Material).dispose();
    });
  }
}

// --- Build / rebuild ---
function build(): void {
  timeline.clear();
  pathsGroup.clear();

  const cfg = SCENE_CONFIGS[sceneMode];
  const { walks, scene, roots } = computeWalks();
  const caster = scene.primitives.find((p) => p.name === cfg.casterName)!;
  const sphere = caster.shape as Sphere;
  currentSphereCenter = new THREE.Vector3(...t3(sphere.center));

  pathsGroup.add(marker(cfg.receiver, 0xffb054, 0.06)); // receiver: amber
  pathsGroup.add(marker(cfg.lightP, 0xffffcc, 0.06)); // light point

  let at = 0;
  for (const walk of walks) {
    const el = new WalkElement(walk, at, cfg.receiver, cfg.lightP, pathsGroup);
    at += el.duration;
    timeline.add(el, at);
  }

  const outcomes: Record<string, number> = {};
  let iterTotal = 0;
  let converged = 0;
  for (const w of walks) {
    outcomes[w.outcome] = (outcomes[w.outcome] ?? 0) + 1;
    if (w.solution) {
      converged++;
      iterTotal += w.iterates.length;
    }
  }
  const parts = Object.entries(outcomes)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(' · ');
  infoEl.textContent =
    `${cfg.bounces === 2 ? 'two-bounce chain, ' : ''}` +
    `${seedMode === 'mnee' ? 'MNEE seed' : `M = ${M} random seeds`}, ${constraint}: ` +
    `${parts} — ${roots.length} distinct root${roots.length === 1 ? '' : 's'}` +
    (converged ? `, mean ${(iterTotal / converged).toFixed(1)} iterations` : '');

  timeline.setTime(0);
  timeline.playing = true;
}

// --- Switches ---
function makeSwitch<T extends string>(
  containerId: string,
  options: ReadonlyArray<{ id: T; label: string }>,
  get: () => T,
  set: (v: T) => void,
): void {
  const el = document.getElementById(containerId)!;
  const buttons = options.map(({ id, label }) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-pressed', String(id === get()));
    b.addEventListener('click', () => {
      set(id);
      for (const [i, other] of buttons.entries()) {
        other.setAttribute('aria-pressed', String(options[i]!.id === get()));
      }
      if (containerId === 'switch-scene') {
        threeScene.remove(sceneGroup);
        sceneGroup = sceneToThree(SCENE_CONFIGS[sceneMode].description);
        threeScene.add(sceneGroup);
        applyView();
      }
      build();
    });
    el.appendChild(b);
    return b;
  });
}

makeSwitch('switch-scene', [
  { id: 'glass2', label: 'glass ball (two-bounce)' },
  { id: 'mirror', label: 'mirror ball (reflection)' },
  { id: 'bulb', label: 'glass bulb (refraction)' },
  { id: 'dome', label: 'mirror dome (multi-root)' },
], () => sceneMode, (v) => { sceneMode = v; });
makeSwitch('switch-constraint', [
  { id: 'halfvector', label: 'half-vector' },
  { id: 'anglediff', label: 'angle difference' },
], () => constraint, (v) => { constraint = v; });
makeSwitch('switch-seed', [
  { id: 'random', label: 'random' },
  { id: 'mnee', label: 'MNEE (deterministic)' },
], () => seedMode, (v) => { seedMode = v; });
makeSwitch('switch-m', [
  { id: '1', label: '1' },
  { id: '4', label: '4' },
  { id: '8', label: '8' },
  { id: '16', label: '16' },
], () => String(M) as '1' | '4' | '8' | '16', (v) => { M = Number(v); });

// --- Clock / controls ---
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

build();

let last = performance.now();
let replayAt = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const wasPlaying = timeline.playing;
  timeline.tick((now - last) / 1000);
  last = now;
  if (wasPlaying && !timeline.playing) replayAt = now + LOOP_HOLD * 1000;
  if (replayAt > 0 && now >= replayAt) {
    replayAt = 0;
    timeline.setTime(0);
    timeline.playing = true;
  }
  renderer.render(threeScene, threeCamera);
});

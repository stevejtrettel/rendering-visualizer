// SHOWS: the manifold walk itself — seed, Newton iterates sliding on the
// caster, and the solved specular connection — for one fixed receiver/light
// pair, played as the M attempts of one biased-SMS estimate. Switches: the
// scene (reflective mirror ball / refractive glass bulb), the constraint
// formulation (the measured success-rate story: anglediff wins refraction
// 82% vs 27%, halfvector edges ahead on pure reflection), the seed mode
// (random vs MNEE's deterministic straight line — which can only ever find
// ONE root), and the trial budget M.
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
  type ManifoldWalkResult,
} from '../../src/core/manifold/newton';
import type { ConstraintType } from '../../src/core/manifold/constraints';
import { Timeline, type TimelineElement } from '../../src/viz/timeline';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';
import { sceneToThree } from '../../src/viz/three-scene';

// --- Figure spec ---
const VIEW_W = 900;
const VIEW_H = 620;
const SEED = 0;
const SEED_SECONDS = 0.5; // dotted seed line draw time
const ITER_SECONDS = 0.35; // per Newton iterate
const RESOLVE_SECONDS = 0.9; // solid-chain flash / evaporate time
const LOOP_HOLD = 1.5;
const SOLVED_OPACITY = 0.9;
const ROOT_HUES = [0.33, 0.55, 0.78, 0.12, 0.9]; // one hue per distinct root

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

interface SceneConfig {
  description: SceneDescription;
  casterName: string;
  eta: number;
  receiver: Vec3; // fixed shading point a on the floor
  lightP: Vec3; // fixed light point b
  view: { eye: readonly [number, number, number]; target: readonly [number, number, number] };
}

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

const SCENE_CONFIGS: Record<'mirror' | 'bulb' | 'dome', SceneConfig> = {
  mirror: {
    description: SCENES['caustic-ring'],
    casterName: 'mirrorBall',
    eta: 1,
    receiver: new Vec3(-0.8, 0.001, 0.55), // in the ball's connectible zone (left, toward the light)
    lightP: new Vec3(-1.999, 2.6, 0), // wall-light center
    view: vizViewFor('caustic-ring'),
  },
  bulb: {
    description: GLASS_BULB,
    casterName: 'glassShell',
    eta: 1.5,
    receiver: new Vec3(0.55, 0.001, 0.45),
    lightP: new Vec3(0, 1.02, 0), // bulb center
    view: { eye: [3.6, 2.6, 5.2], target: [0, 0.8, 0] },
  },
  dome: {
    description: MIRROR_DOME,
    casterName: 'dome',
    eta: 1,
    receiver: new Vec3(0.2, 0.001, 0), // inside the two-branch band past the fold
    lightP: new Vec3(1.2, 2.0, 0), // lamp center
    view: { eye: [1.5, 2.1, 1.9], target: [-0.4, 0.2, 0] }, // inside the dome
  },
};

type SceneMode = keyof typeof SCENE_CONFIGS;
type SeedMode = 'random' | 'mnee';

let sceneMode: SceneMode = 'mirror';
let constraint: ConstraintType = 'anglediff';
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

// --- Walk data ---
interface WalkVisual {
  seedP: Vec3 | null; // null: seed ray missed the caster entirely
  result: ManifoldWalkResult | null;
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
  for (let m = 0; m < attempts; m++) {
    let target: Vec3;
    if (seedMode === 'mnee') {
      target = cfg.eta !== 1 ? cfg.lightP : sphere.center;
    } else {
      target = sphere.center.add(uniformSampleSphere([rng.nextFloat(), rng.nextFloat()]).scale(sphere.radius));
    }
    const dir = target.sub(cfg.receiver).normalize();
    const seedHit = scene.aggregate.intersect(new Ray(cfg.receiver.add(dir.scale(RAY_EPSILON)), dir));
    if (!seedHit || seedHit.primitive !== caster) {
      walks.push({ seedP: null, result: null, rootIndex: -1 });
      continue;
    }
    const result = manifoldWalk(cfg.receiver, seedHit, cfg.eta, cfg.lightP, caster, scene.aggregate, {
      ...DEFAULT_WALK_OPTIONS,
      constraint,
    });
    let rootIndex = -1;
    if (result.outcome === 'converged') {
      const d = result.vertex!.p.sub(cfg.receiver).normalize();
      rootIndex = roots.findIndex((r) => sameSolution(r.sub(cfg.receiver).normalize(), d));
      if (rootIndex < 0) {
        rootIndex = roots.length;
        roots.push(result.vertex!.p);
      }
    }
    walks.push({ seedP: seedHit.p, result, rootIndex });
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
  const hi = Math.log10(2); // residuals start O(1)
  const lo = Math.log10(DEFAULT_WALK_OPTIONS.solverThreshold);
  const x = Math.min(1, Math.max(0, (hi - Math.log10(Math.max(cNorm, 1e-12))) / (hi - lo)));
  return new THREE.Color().setHSL(0.33 * x, 0.9, 0.55);
}

// One walk attempt on the timeline: dotted seed line, iterate dots with a
// sliding "current" dot, then a solid chain (converged) or evaporation.
class WalkElement implements TimelineElement {
  private readonly group = new THREE.Group();
  private readonly seedLine: THREE.Line | null = null;
  private readonly iterateDots: THREE.Mesh[] = [];
  private readonly slider: THREE.Mesh | null = null;
  private readonly normalArrow: THREE.ArrowHelper | null = null;
  private readonly chainIn: Line2 | null = null;
  private readonly chainOut: Line2 | null = null;
  readonly duration: number;

  constructor(
    private readonly walk: WalkVisual,
    private readonly start: number,
    receiver: Vec3,
    lightP: Vec3,
    parent: THREE.Object3D,
  ) {
    parent.add(this.group);
    const iterates = walk.result?.iterates ?? [];
    this.duration = SEED_SECONDS + iterates.length * ITER_SECONDS + RESOLVE_SECONDS;
    if (!walk.seedP) return;

    const seedGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...t3(receiver)),
      new THREE.Vector3(...t3(walk.seedP)),
    ]);
    const seedMat = new THREE.LineDashedMaterial({ color: 0x9a9a9a, dashSize: 0.08, gapSize: 0.06, transparent: true, opacity: 0 });
    this.seedLine = new THREE.Line(seedGeom, seedMat);
    this.seedLine.computeLineDistances();
    this.group.add(this.seedLine);

    for (const it of iterates) {
      const dot = marker(new Vec3(it.p.x, it.p.y, it.p.z), 0xffffff, 0.022);
      (dot.material as THREE.MeshBasicMaterial).color = residualColor(it.cNorm);
      (dot.material as THREE.MeshBasicMaterial).opacity = 0;
      this.group.add(dot);
      this.iterateDots.push(dot);
    }
    if (iterates.length > 0) {
      this.slider = marker(new Vec3(0, 0, 0), 0xffffff, 0.034);
      this.group.add(this.slider);
      this.normalArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.45, 0xdddddd, 0.1, 0.05);
      this.group.add(this.normalArrow);
    }
    if (this.walk.result?.outcome === 'converged') {
      const root = this.walk.result.vertex!.p;
      const hue = ROOT_HUES[this.walk.rootIndex % ROOT_HUES.length]!;
      const color = new THREE.Color().setHSL(hue, 0.85, 0.6).getHex();
      this.chainIn = fatLine([t3(receiver), t3(root)], color, 4);
      this.chainOut = fatLine([t3(root), t3(lightP)], color, 4);
      this.group.add(this.chainIn, this.chainOut);
    }
  }

  drawAt(t: number): void {
    const local = t - this.start;
    const iterates = this.walk.result?.iterates ?? [];
    const iterEnd = SEED_SECONDS + iterates.length * ITER_SECONDS;
    const converged = this.walk.result?.outcome === 'converged';

    // Seed line: fades in during its phase, fades once resolved.
    if (this.seedLine) {
      const m = this.seedLine.material as THREE.LineDashedMaterial;
      if (local < 0) m.opacity = 0;
      else if (local < iterEnd) m.opacity = 0.55 * Math.min(1, local / SEED_SECONDS);
      else m.opacity = Math.max(0, 0.55 * (1 - (local - iterEnd) / RESOLVE_SECONDS));
    }

    // Iterate dots appear one by one; on failure everything evaporates.
    const failFade = converged ? 1 : Math.max(0, 1 - Math.max(0, local - iterEnd) / RESOLVE_SECONDS);
    for (const [i, dot] of this.iterateDots.entries()) {
      const at = SEED_SECONDS + i * ITER_SECONDS;
      const m = dot.material as THREE.MeshBasicMaterial;
      m.opacity = (local >= at ? 0.85 : 0) * failFade;
    }
    if (this.slider && this.normalArrow) {
      const active = local >= SEED_SECONDS && local < iterEnd + (converged ? 0 : RESOLVE_SECONDS);
      const sm = this.slider.material as THREE.MeshBasicMaterial;
      sm.opacity = active ? 0.95 * failFade : 0;
      this.normalArrow.visible = active && failFade > 0.05;
      if (active) {
        const k = Math.min(iterates.length - 1, Math.floor((local - SEED_SECONDS) / ITER_SECONDS));
        const frac = Math.min(1, (local - SEED_SECONDS) / ITER_SECONDS - k);
        const a = iterates[k]!.p;
        const b = iterates[Math.min(iterates.length - 1, k + 1)]!.p;
        this.slider.position.set(a.x + (b.x - a.x) * frac, a.y + (b.y - a.y) * frac, a.z + (b.z - a.z) * frac);
        sm.color = residualColor(iterates[k]!.cNorm);
        this.normalArrow.position.copy(this.slider.position);
        if (this.walk.result?.vertex || iterates.length > 0) {
          // Surface normal at the sliding dot: radial for the sphere caster.
          const n = this.slider.position.clone().sub(sphereCenterOf()).normalize();
          this.normalArrow.setDirection(n);
        }
      }
    }

    // The solved chain flashes in and settles.
    if (this.chainIn && this.chainOut) {
      const dt = local - iterEnd;
      const o = dt <= 0 ? 0 : Math.min(1, dt / 0.25) * (SOLVED_OPACITY + 0.4 * Math.exp(-3 * dt));
      (this.chainIn.material as LineMaterial).opacity = o;
      (this.chainOut.material as LineMaterial).opacity = o;
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

let currentSphereCenter = new THREE.Vector3();
const sphereCenterOf = () => currentSphereCenter;

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
    const key = w.result?.outcome ?? 'missed-caster';
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    if (w.result?.outcome === 'converged') {
      converged++;
      iterTotal += w.result.iterates.length;
    }
  }
  const parts = Object.entries(outcomes)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(' · ');
  infoEl.textContent =
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
  { id: 'mirror', label: 'mirror ball (reflection)' },
  { id: 'bulb', label: 'glass bulb (refraction)' },
  { id: 'dome', label: 'mirror dome (multi-root)' },
], () => sceneMode, (v) => { sceneMode = v; });
makeSwitch('switch-constraint', [
  { id: 'anglediff', label: 'angle difference' },
  { id: 'halfvector', label: 'half-vector' },
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

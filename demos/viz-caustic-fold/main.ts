// SHOWS: the caustic as a singularity of the projection π that forgets
// the specular vertex. A receiver point sweeps along a floor line inside a
// MIRROR DOME (the coffee-cup caustic staged as a room: a CONCAVE
// reflector — measured fact: a convex ball has a single root and no fold
// anywhere, an interior source refracting out of glass diverges; the
// concave interior is where m = 1 folds live). At every position the
// manifold solver finds the fiber's roots, and the graph tracks each
// branch's |det ∂x₁/∂x₂| — the determinant inside the generalized G. At
// the fold (x ≈ −0.8) two branches are born together and the determinant
// spikes ~400×; the pt-sms render beside it glows along the same line.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { buildScene, type SceneDescription } from '../../src/core/scene/scene';
import { Sphere } from '../../src/core/geometry/sphere';
import { Vec3 } from '../../src/core/math/vec3';
import { Ray } from '../../src/core/math/ray';
import { PCG32 } from '../../src/core/math/pcg32';
import { u64 } from '../../src/core/math/u64';
import { uniformSampleSphere } from '../../src/core/math/sampling';
import { RAY_EPSILON } from '../../src/core/geometry/offset';
import { OrthonormalBasis } from '../../src/core/math/onb';
import { ManifoldVertex } from '../../src/core/manifold/vertex';
import { manifoldWalk, sameSolution, DEFAULT_WALK_OPTIONS } from '../../src/core/manifold/newton';
import { specularManifoldDetRatio } from '../../src/core/manifold/geometry-term';
import { WorkerPool } from '../../src/render/pool';
import { Timeline, type TimelineElement } from '../../src/viz/timeline';
import { attachControls } from '../../src/viz/controls';
import { recordFrames, recordWebM } from '../../src/viz/recording';
import { sceneToThree } from '../../src/viz/three-scene';

// --- Figure spec ---
const VIEW_W = 860;
const VIEW_H = 620;
const SEED = 0;
const RENDER_RES = 96; // pt-sms floor render (side pane)
const RENDER_SPP = 128;
const SWEEP_Z = 0; // the line z = const on the floor
const SWEEP_X0 = -1.7; // approach…
const SWEEP_X1 = 0.7; // …through the fold at x ≈ −0.8 into the two-branch band
const SWEEP_STEPS = 150;
const SEEDS_PER_POINT = 40;
const BRANCH_MAX_GAP = 3; // steps a branch may miss before it is closed
const SWEEP_SECONDS = 18;
const LOOP_HOLD = 2;
const CASTER = 'dome';
const LIGHT_P = new Vec3(1.2, 2.0, 0); // lamp center
const LIGHT_N = new Vec3(0, -1, 0); // it faces the floor
const BRANCH_HUES = [0.33, 0.55, 0.78, 0.12, 0.9];
const BRANCH_MATCH_DIST = 0.35; // root continuity threshold between steps

// The mirror dome: floor and lamp inside a large concave mirror sphere.
// Viewed from inside, the dome mesh backface-culls away, so the three.js
// pane just sees floor + paths.
const WHITE = { kind: 'lambert' as const, albedo: [0.73, 0.73, 0.73] as const };
const description: SceneDescription = {
  camera: { eye: [0, 1.9, 2.5], lookAt: [0, 0.2, 0], up: [0, 1, 0], fovDegrees: 55 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-2.4, 0, -2.4], e1: [0, 0, 4.8], e2: [4.8, 0, 0] }, material: WHITE },
    { name: 'light', shape: { kind: 'quad', q: [1.1, 2.0, -0.1], e1: [0.2, 0, 0], e2: [0, 0, 0.2] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [120, 120, 120] } },
    { name: 'dome', shape: { kind: 'sphere', center: [0, 0.8, 0], radius: 3 }, material: { kind: 'mirror', f0: [0.95, 0.95, 0.95] } },
  ],
};

const scene = buildScene(description, RENDER_RES, RENDER_RES);
const caster = scene.primitives.find((p) => p.name === CASTER)!;
const sphere = caster.shape as Sphere;

// --- Solve the sweep ---
interface RootSample {
  x1: Vec3;
  ratio: number | null; // |det ∂x₁/∂x₂|, unclamped
}
interface Branch {
  samples: (RootSample | null)[]; // indexed by sweep step
}

const receiverAt = (i: number): Vec3 =>
  new Vec3(SWEEP_X0 + ((SWEEP_X1 - SWEEP_X0) * i) / (SWEEP_STEPS - 1), 0.001, SWEEP_Z);

function detRatioOf(receiver: Vec3, root: Vec3): number | null {
  const hit = scene.aggregate.intersect(
    new Ray(receiver.add(root.sub(receiver).normalize().scale(RAY_EPSILON)), root.sub(receiver).normalize()),
  );
  if (!hit || hit.primitive !== caster) return null;
  const v1 = new ManifoldVertex(hit, 1);
  v1.makeOrthonormal();
  const mk = (p: Vec3, n: Vec3) => {
    const onb = OrthonormalBasis.fromZ(n);
    return new ManifoldVertex({ p, ns: n, ng: n, dpdu: onb.u, dpdv: onb.v, dndu: Vec3.ZERO, dndv: Vec3.ZERO }, 1);
  };
  return specularManifoldDetRatio(mk(receiver, new Vec3(0, 1, 0)), v1, mk(LIGHT_P, LIGHT_N));
}

function solveSweep(): Branch[] {
  const branches: Branch[] = [];
  // Recently-seen roots per branch; a branch survives BRANCH_MAX_GAP
  // seedless steps before closing (occasional seed misses must not
  // fragment a branch into new hues).
  let prev: { x1: Vec3; branch: number; age: number }[] = [];
  for (let i = 0; i < SWEEP_STEPS; i++) {
    const receiver = receiverAt(i);
    const rng = new PCG32(u64(0, SEED), u64(0, i));
    const roots: Vec3[] = [];
    for (let s = 0; s < SEEDS_PER_POINT; s++) {
      const target = sphere.center.add(uniformSampleSphere([rng.nextFloat(), rng.nextFloat()]).scale(sphere.radius));
      const dir = target.sub(receiver).normalize();
      const seedHit = scene.aggregate.intersect(new Ray(receiver.add(dir.scale(RAY_EPSILON)), dir));
      if (!seedHit || seedHit.primitive !== caster) continue;
      const r = manifoldWalk(receiver, seedHit, 1, LIGHT_P, caster, scene.aggregate, DEFAULT_WALK_OPTIONS);
      if (r.outcome !== 'converged') continue;
      const dirTo = r.vertex!.p.sub(receiver).normalize();
      if (!roots.some((q) => sameSolution(q.sub(receiver).normalize(), dirTo))) roots.push(r.vertex!.p);
    }
    // Continuity: match each root to the nearest recently-active branch.
    const now: { x1: Vec3; branch: number; age: number }[] = [];
    for (const root of roots) {
      let best = -1;
      let bestD = BRANCH_MATCH_DIST;
      for (const p of prev) {
        const d = p.x1.distanceTo(root);
        if (d < bestD && !now.some((n) => n.branch === p.branch)) {
          best = p.branch;
          bestD = d;
        }
      }
      if (best < 0) {
        best = branches.length;
        branches.push({ samples: new Array<RootSample | null>(SWEEP_STEPS).fill(null) });
      }
      branches[best]!.samples[i] = { x1: root, ratio: detRatioOf(receiver, root) };
      now.push({ x1: root, branch: best, age: 0 });
    }
    for (const p of prev) {
      if (p.age + 1 <= BRANCH_MAX_GAP && !now.some((n) => n.branch === p.branch)) {
        now.push({ x1: p.x1, branch: p.branch, age: p.age + 1 });
      }
    }
    prev = now;
  }
  return branches;
}

const branches = solveSweep();

// --- three.js ---
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(VIEW_W, VIEW_H);
renderer.setPixelRatio(window.devicePixelRatio);
document.getElementById('viz-pane')!.appendChild(renderer.domElement);

const threeScene = new THREE.Scene();
threeScene.background = new THREE.Color(0x141414);
threeScene.add(sceneToThree(description));

// Eye INSIDE the dome (within r = 3 of its center) or the mirror sphere
// would hide the whole scene.
const threeCamera = new THREE.PerspectiveCamera(55, VIEW_W / VIEW_H, 0.01, 100);
threeCamera.position.set(1.35, 2.25, 1.8);
const controls = new OrbitControls(threeCamera, renderer.domElement);
controls.target.set(-0.2, 0.7, 0);
controls.update();

const drawGroup = new THREE.Group();
threeScene.add(drawGroup);
const resolution = new THREE.Vector2(VIEW_W * devicePixelRatio, VIEW_H * devicePixelRatio);
const t3 = (v: Vec3): [number, number, number] => [v.x, v.y, v.z];

function fatLine(points: ReadonlyArray<readonly [number, number, number]>, color: number, width: number, opacity: number): Line2 {
  const g = new LineGeometry();
  g.setPositions(points.flatMap((p) => [...p]));
  const material = new LineMaterial({ color, linewidth: width, transparent: true, opacity });
  material.resolution.copy(resolution);
  return new Line2(g, material);
}

// Static: the sweep line on the floor and the light marker.
drawGroup.add(fatLine([t3(receiverAt(0)), t3(receiverAt(SWEEP_STEPS - 1))], 0x777777, 2, 0.5));
const lightDot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffcc }));
lightDot.position.set(...t3(LIGHT_P));
drawGroup.add(lightDot);

// Per-branch root trace curves on the caster, revealed with the sweep.
interface TraceCurve {
  line: Line2;
  counts: number[]; // cumulative vertex count per sweep step
}
const traceCurves: TraceCurve[] = branches.map((branch, bi) => {
  const pts: number[] = [];
  const counts: number[] = [];
  let n = 0;
  for (let i = 0; i < SWEEP_STEPS; i++) {
    const s = branch.samples[i];
    if (s) {
      pts.push(s.x1.x, s.x1.y, s.x1.z);
      n++;
    }
    counts.push(n);
  }
  const g = new LineGeometry();
  g.setPositions(pts.length >= 6 ? pts : [0, -10, 0, 0, -10, 0]);
  const material = new LineMaterial({
    color: new THREE.Color().setHSL(BRANCH_HUES[bi % BRANCH_HUES.length]!, 0.85, 0.6).getHex(),
    linewidth: 3,
    transparent: true,
    opacity: 0.85,
  });
  material.resolution.copy(resolution);
  const line = new Line2(g, material);
  drawGroup.add(line);
  return { line, counts };
});

// Moving parts: receiver dot + per-branch chains (rebuilt cheaply per step).
const receiverDot = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffb054 }));
drawGroup.add(receiverDot);
const chainLines: Line2[] = branches.map((_, bi) => {
  const l = fatLine([[0, -10, 0], [0, -10, 0], [0, -10, 0]], new THREE.Color().setHSL(BRANCH_HUES[bi % BRANCH_HUES.length]!, 0.85, 0.6).getHex(), 3.5, 0);
  drawGroup.add(l);
  return l;
});

// --- Side panes ---
const renderCanvas = document.getElementById('render') as HTMLCanvasElement;
const renderCtx = renderCanvas.getContext('2d')!;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
const overlayCtx = overlay.getContext('2d')!;
const graph = document.getElementById('graph') as HTMLCanvasElement;
const graphCtx = graph.getContext('2d')!;
const infoEl = document.getElementById('info')!;
const readoutEl = document.getElementById('readout')!;

// Background pt-sms render of the same scene, accumulating while you watch.
const POOL_SIZE = Math.max(1, (navigator.hardwareConcurrency || 4) - 2);
new WorkerPool({
  size: POOL_SIZE,
  description,
  width: RENDER_RES,
  height: RENDER_RES,
  seed: SEED,
  integrator: 'pt-sms',
  maxSpp: RENDER_SPP,
  onUpdate: (u) => {
    renderCtx.putImageData(new ImageData(u.film.develop({ splatScale: 1 / Math.max(1, u.totalSpp) }), RENDER_RES, RENDER_RES), 0, 0);
    infoEl.textContent = `pt-sms render: ${u.totalSpp} spp`;
  },
});

// The sweep line projected onto the render via the CPU camera.
const rasterOf = (p: Vec3): [number, number] | null => {
  const s = scene.camera.sampleWi(p);
  if (!s) return null;
  const scale = overlay.width / RENDER_RES;
  return [s.raster[0] * scale, s.raster[1] * scale];
};

const log10 = (x: number) => Math.log(x) / Math.LN10;
const GRAPH_LO = -2;
const GRAPH_HI = 3;

function drawGraph(step: number): void {
  const w = graph.width;
  const h = graph.height;
  graphCtx.clearRect(0, 0, w, h);
  // Clamp line at ratio = 1 (log = 0).
  const yOf = (lg: number) => h - ((lg - GRAPH_LO) / (GRAPH_HI - GRAPH_LO)) * h;
  graphCtx.strokeStyle = '#555';
  graphCtx.setLineDash([4, 4]);
  graphCtx.beginPath();
  graphCtx.moveTo(0, yOf(0));
  graphCtx.lineTo(w, yOf(0));
  graphCtx.stroke();
  graphCtx.setLineDash([]);
  // Branch curves.
  for (const [bi, branch] of branches.entries()) {
    graphCtx.strokeStyle = `hsl(${360 * BRANCH_HUES[bi % BRANCH_HUES.length]!} 85% 60%)`;
    graphCtx.lineWidth = 1.6;
    graphCtx.beginPath();
    let pen = false;
    for (let i = 0; i < SWEEP_STEPS; i++) {
      const s = branch.samples[i];
      if (!s || s.ratio === null) {
        pen = false;
        continue;
      }
      const x = (i / (SWEEP_STEPS - 1)) * w;
      const y = yOf(Math.max(GRAPH_LO, Math.min(GRAPH_HI, log10(Math.max(1e-9, s.ratio)))));
      if (pen) graphCtx.lineTo(x, y);
      else graphCtx.moveTo(x, y);
      pen = true;
    }
    graphCtx.stroke();
  }
  // Cursor.
  graphCtx.strokeStyle = '#ffaa33';
  graphCtx.beginPath();
  const cx = (step / (SWEEP_STEPS - 1)) * w;
  graphCtx.moveTo(cx, 0);
  graphCtx.lineTo(cx, h);
  graphCtx.stroke();
}

function drawOverlay(step: number): void {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  overlayCtx.strokeStyle = 'rgba(255,255,255,0.6)';
  overlayCtx.beginPath();
  let pen = false;
  for (let i = 0; i < SWEEP_STEPS; i += 3) {
    const r = rasterOf(receiverAt(i));
    if (!r) {
      pen = false;
      continue;
    }
    if (pen) overlayCtx.lineTo(r[0], r[1]);
    else overlayCtx.moveTo(r[0], r[1]);
    pen = true;
  }
  overlayCtx.stroke();
  const cur = rasterOf(receiverAt(step));
  if (cur) {
    overlayCtx.fillStyle = '#ffb054';
    overlayCtx.beginPath();
    overlayCtx.arc(cur[0], cur[1], 4, 0, 2 * Math.PI);
    overlayCtx.fill();
  }
}

// --- The sweep element ---
class FoldSweep implements TimelineElement {
  drawAt(t: number): void {
    const step = Math.min(SWEEP_STEPS - 1, Math.max(0, Math.round((t / SWEEP_SECONDS) * (SWEEP_STEPS - 1))));
    const receiver = receiverAt(step);
    receiverDot.position.set(...t3(receiver));

    for (const [bi, branch] of branches.entries()) {
      const s = branch.samples[step];
      const line = chainLines[bi]!;
      if (s) {
        const g = new LineGeometry();
        g.setPositions([...t3(receiver), ...t3(s.x1), ...t3(LIGHT_P)]);
        line.geometry.dispose();
        line.geometry = g;
        (line.material as LineMaterial).opacity = 0.9;
      } else {
        (line.material as LineMaterial).opacity = 0;
      }
      // Reveal the trace curve up to the current step.
      const tc = traceCurves[bi]!;
      const upTo = tc.counts[step]!;
      const total = tc.counts[SWEEP_STEPS - 1]!;
      const inst = tc.line.geometry as LineGeometry;
      inst.instanceCount = Math.max(0, Math.min(total - 1, upTo - 1));
    }

    drawGraph(step);
    drawOverlay(step);

    const live = branches
      .map((b, bi) => ({ s: b.samples[step], bi }))
      .filter((e) => e.s !== null);
    readoutEl.textContent =
      `x = ${receiver.x.toFixed(2)} · ${live.length} root${live.length === 1 ? '' : 's'}` +
      (live.length
        ? ` · |det| ${live.map((e) => (e.s!.ratio === null ? '—' : e.s!.ratio.toPrecision(3))).join(' / ')}`
        : '');
  }

  dispose(): void {}
}

const timeline = new Timeline();
timeline.add(new FoldSweep(), SWEEP_SECONDS);

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

timeline.setTime(0);
timeline.playing = true;

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

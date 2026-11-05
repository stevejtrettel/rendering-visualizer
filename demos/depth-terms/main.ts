/**
 * SHOWS: the photograph, one path length at a time.
 *
 * For the light-field deck (Steve, 2026-10-30): the terms of
 * C(Id - T)^-1 E = Σ C T^n E, each drawn as what it computes, the photo the
 * camera takes from paths of exactly that length. Three films in a row with
 * + between them: paths from film to light of length 2 (the camera sees the
 * lamp), 3 (direct light), 4 (one bounce of indirect light). The deck sets
 * the integrals over them and the words under them.
 *
 * Rendered with the BDPT of bdpt-pyramid, its per-strategy sink, and every
 * strategy of one depth summed: the MIS weights of one depth sum to one, so
 * a row's sum is all of that depth's transport, the same image a path tracer
 * would converge to restricted to that length, at far less noise. Depth d
 * (s + t - 2 = d) is a path of d + 1 segments from the lens, so d + 2 from
 * the film. One exposure across the three films, so the longer terms are
 * dimmer, as they are.
 *
 * ?sum (Steve: "combine the images we have into a single one summing them up,
 * to get the final image"): the three films smaller, then + ⋯ =, then the
 * whole photograph, every path length up to SUM_DEPTH, large. That last film
 * takes every contribution of the same render (paths up to SUM_DEPTH + 1
 * segments; longer ones carry a negligible share here).
 *
 * ?paths (Steve, 2026-11-05: "paths above the images that are converging, in
 * the room of each length, rapidly firing randomly — 3 simulated rooms with
 * paths firing madly, then the 3 converging images below"): the same three
 * films, smaller and lower, and above film k a small 3D view of the same
 * scene, drawn as many-samples draws its box (sceneToThree + styleShortBox,
 * lamp outlined, the camera's eye with a small image plane and frustum), but
 * seen over the camera's shoulder rather than from vizViewFor's vantage:
 * from CORNELL_VIEW the eye sat mid-frame inside a large image plane and the
 * paths were small. In room k, paths of exactly k + 1 segments from the
 * camera to the lamp fire: each flashes in, drawn out from the eye to the
 * lamp over FIRE.draw seconds, and fades over FIRE.life.
 * Paths are made as pt-aim makes them ("aim at the lamp"): from the camera,
 * n - 1 bounces by BSDF sampling (walkFromCamera), then one shadow-ray
 * connection to a sampled point on the lamp; a path is kept only if that
 * connection is unoccluded and carries light, and none of its bounces landed
 * on the lamp. Length 1 aims a camera ray through the film at a sampled lamp
 * point (camera.sampleWi) and keeps it only if the ray's first hit IS the
 * lamp. FIRE.count kept paths per room are traced once, seeded, and fired in
 * turn off the stage clock, so the firing is the same every run and the loop
 * (stage.duration = count / perSecond) is seamless. Line colours are
 * many-samples' (the light each segment carries, LINE_GAIN brighter, floored).
 * The three views are drawn into scissored viewports of the one canvas
 * (stage.renderWith), so they export with everything else.
 *
 * Main thread, chunked, as bdpt-pyramid (the per-strategy sink is local-only).
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { buildScene } from '@/core/scene/scene';
import { IndependentSampler } from '@/core/sampler/independent';
import { pixelSeedKey } from '@/core/sampler/sampler';
import { BDPT, type StrategyContribution, type StrategySink } from '@/core/integrators/bdpt';
import { Film } from '@/render/film';
import { NULL_RECORDER } from '@/trace/recorder';
import { FilmPanel } from '@/viz/film-panel';
import { label } from '@/viz/text';
import { ASPECT } from '@/viz/stage';
import { sceneToThree } from '@/viz/three-scene';
import { segments, setSegments, polyline } from '@/viz/lines';
import { lampOutline, styleShortBox } from '@/viz/short-box';
import { imagePlaneFrame } from '@/viz/image-plane';
import { cameraSample, walkFromCamera } from '@/core/integrators/estimators';
import { occlusionPoint } from '@/core/geometry/visibility';
import { TransportMode, hasNonSpecular } from '@/core/materials/bsdf';
import { Vec3, absDot } from '@/core/math/vec3';
import type { Scene, ScenePrimitive } from '@/core/scene/scene';
import type { Sampler } from '@/core/sampler/sampler';
import * as THREE from 'three';

const RES = 128;
const DEPTHS = [0, 1, 2];
const SUM = new URLSearchParams(location.search).has('sum');
const PATHS = !SUM && new URLSearchParams(location.search).has('paths');
const SUM_DEPTH = 7;
const CHUNK = 16;

/** ?paths firing: per room, `count` kept paths, `perSecond` of them fired a second, each drawn out over `draw` s and gone after `life` s. */
const FIRE = { count: 480, perSecond: 60, life: 0.5, draw: 0.09, buckets: 10 };

const stage = createStage({ lights: false, controls: false });
stage.duration = PATHS ? FIRE.count / FIRE.perSecond : 1; // before createUI, which reads it for the export range
const ui = createUI(stage);
stage.camera.position.set(0, 0, 5);

const params = { scene: 'cornell' as SceneName, spp: 24, exposure: 1 };
ui.params.add(params, 'scene', Object.keys(SCENES)).onChange(restart);
ui.params.add(params, 'spp', 1, 256, 1).onChange(restart);
ui.params.add(params, 'exposure', 0.1, 8, 0.05).onChange(show);

// Layout, HUD units (y in [-1, 1], x in [-16/9, 16/9]).
// ?paths: rooms in the top band, films below them, one column each.
const H = SUM ? 0.5 : PATHS ? 0.6 : 0.78;
const XS = SUM ? [-1.45, -0.8, -0.15] : [-1.18, 0, 1.18];
const FILM_Y = PATHS ? -0.43 : 0;
const ROOM = { w: 1.1, h: 0.84, cy: 0.54 }; // ?paths: each room's viewport, HUD units
const FINAL = { x: 1.12, h: 1.0 };
const panels = XS.map((x) => {
  const p = new FilmPanel({ width: RES, height: RES, center: [x, FILM_Y], drawnHeight: H });
  stage.hud.add(p.group);
  return p;
});
const plusSize = SUM || PATHS ? 0.07 : 0.09;
for (const x of [(XS[0]! + XS[1]!) / 2, (XS[1]! + XS[2]!) / 2, XS[2]! + H / 2 + plusSize]) {
  stage.hud.add(label('+', { size: plusSize, color: C.bone, anchorX: 'center', anchorY: 'middle', position: [x, FILM_Y, 0] }));
}
stage.hud.add(label('⋯', { size: plusSize, color: C.bone, anchorX: 'left', anchorY: 'middle', position: [XS[2]! + H / 2 + plusSize * 1.8, FILM_Y, 0] }));
const finalPanel = SUM ? new FilmPanel({ width: RES, height: RES, center: [FINAL.x, 0], drawnHeight: FINAL.h }) : null;
if (finalPanel) {
  stage.hud.add(finalPanel.group);
  stage.hud.add(label('=', { size: 0.09, color: C.bone, anchorX: 'center', anchorY: 'middle', position: [FINAL.x - FINAL.h / 2 - 0.1, 0, 0] }));
}

let films: Film[] = [];
let finalFilm = new Film(RES, RES);
let spp = 0;
let generation = 0;

function show(): void {
  if (!spp) return;
  const opts = { exposure: params.exposure, splatScale: 1 / spp };
  films.forEach((f, i) => panels[i]!.update(f.develop(opts)));
  finalPanel?.update(finalFilm.develop(opts));
}

function restart(): void {
  const gen = ++generation;
  films = DEPTHS.map(() => new Film(RES, RES));
  finalFilm = new Film(RES, RES);
  spp = 0;
  for (const p of panels) p.clear();
  finalPanel?.clear();
  if (PATHS) buildRooms();
  void render(gen);
}

async function render(gen: number): Promise<void> {
  const scene = buildScene(SCENES[params.scene], RES, RES);
  const sampler = new IndependentSampler(0);
  const maxDepth = SUM ? SUM_DEPTH : DEPTHS[DEPTHS.length - 1]!;
  const sink: StrategySink = {
    add(c: StrategyContribution): void {
      const d = c.s + c.t - 2;
      films[d]?.splat(c.raster, c.weighted);
    },
  };
  const bdpt = new BDPT({
    maxBounces: maxDepth + 1,
    rrStartDepth: 999,
    heuristic: 'power',
    strategyFilms: sink,
    strategyFilter: (s, t) => s + t - 2 <= maxDepth,
  });
  for (let i = 0; i < params.spp; i++) {
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        sampler.startPixelSample(pixelSeedKey(x, y, i));
        for (const c of bdpt.sampleContributions([x, y], sampler, scene, NULL_RECORDER)) {
          if (c.kind === 'sample') finalFilm.addSample(c.raster, c.value);
          else finalFilm.splat(c.raster, c.value);
        }
      }
      if (y % CHUNK === CHUNK - 1) {
        await new Promise((r) => setTimeout(r));
        if (gen !== generation) return;
      }
    }
    spp = i + 1;
    show();
  }
}

// --- ?paths: the rooms ------------------------------------------------------
const ROOM_FOV = 38;
const LINE_GAIN = 4; // many-samples' line colours
const LINE_FLOOR = 0.35;
const LINE_WIDTH = 2.5;

/** One fired path: its points from the eye to the lamp, the light each segment carries, cumulative length. */
interface Fired {
  pts: THREE.Vector3[];
  cols: THREE.Color[];
  arc: number[];
  start: number;
}

const roomCamera = new THREE.PerspectiveCamera(ROOM_FOV, ROOM.w / ASPECT / ROOM.h, 0.01, 200);
const roomWorld = new THREE.Group(); // the box, lamp outline, eye: rebuilt on a scene change
/** Per room: its group (shown only while its viewport draws) and its fading buckets of lines. */
const rooms = XS.map(() => {
  const group = new THREE.Group();
  const buckets = Array.from({ length: FIRE.buckets }, (_, b) => {
    const lines = segments({ width: LINE_WIDTH, opacity: 0.999, toneMapped: false });
    lines.material.depthWrite = false;
    lines.material.opacity = 0.999 * (1 - b / FIRE.buckets) ** 1.5;
    lines.renderOrder = 10;
    group.add(lines);
    return lines;
  });
  return { group, buckets, fired: [] as Fired[] };
});
let roomsBuilt = false;

/** Returning light on a line: LINE_GAIN brighter, at least LINE_FLOOR, same hue (many-samples). */
function lineDisplay(r: number, g: number, b: number): THREE.Color {
  const c = new THREE.Color(r, g, b).multiplyScalar(LINE_GAIN);
  const m = Math.max(c.r, c.g, c.b);
  if (m > 1) return c.multiplyScalar(1 / m);
  if (m > 0 && m < LINE_FLOOR) return c.multiplyScalar(LINE_FLOOR / m);
  return c;
}

const v3 = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);

/**
 * One attempt at a path of exactly n segments from the eye to the lamp, or
 * null. n = 1: a camera ray aimed through the film at a sampled lamp point,
 * kept if it hits the lamp first. n > 1: pt-aim's path with its stopping
 * depth fixed at n - 1 (walkFromCamera, then one shadow-ray connection).
 */
function tracePath(scene: Scene, n: number, sampler: Sampler, eyeForward: Vec3): Omit<Fired, 'arc' | 'start'> | null {
  const cam = scene.camera;
  if (n === 1) {
    const selected = scene.lightDistribution.sample(sampler.next1D());
    const li = selected?.light.sampleLi({ p: cam.eye, ng: eyeForward, ns: eyeForward }, sampler.next2D());
    if (!li) return null;
    const w = cam.sampleWi(li.pLight.p);
    if (!w) return null;
    const hit = scene.aggregate.intersect(cam.generateRay(w.raster));
    if (!hit || !(hit.primitive as ScenePrimitive).light) return null;
    return { pts: [v3(cam.eye), v3(hit.p)], cols: [lineDisplay(li.L.r, li.L.g, li.L.b)] };
  }
  const pixel: [number, number] = [Math.floor(sampler.next1D() * cam.width), Math.floor(sampler.next1D() * cam.height)];
  const { ray } = cameraSample(scene, pixel, sampler);
  const vs = walkFromCamera(scene, ray, sampler, NULL_RECORDER, { maxBounces: n - 1, rrStartDepth: n, sampleNEE: true });
  if (vs.length !== n) return null;
  for (let i = 1; i < n; i++) if (vs[i]!.primitive?.light) return null;
  const v = vs[n - 1]!;
  if (!v.bsdf || !v.wo || !v.neeSamples || !hasNonSpecular(v.bsdf.flags)) return null;
  const selected = scene.lightDistribution.sample(v.neeSamples.select);
  const li = selected?.light.sampleLi({ p: v.p, ng: v.ng, ns: v.ns }, v.neeSamples.point);
  if (!selected || !li) return null;
  const f = v.bsdf.eval(v.wo, li.wi, TransportMode.Radiance);
  if (f.isBlack()) return null;
  if (occlusionPoint(scene.aggregate, { p: v.p, ng: v.ng }, li.pLight) !== null) return null;
  const value = v.beta.mul(f).mul(li.L).scale(absDot(li.wi, v.ns) / (selected.pmf * li.pdf));
  const pts = [...vs.map((u) => v3(u.p)), v3(li.pLight.p)];
  const cols: THREE.Color[] = [];
  // Segment k (vertex k-1 to k) carries value / beta_k toward the eye; the last carries the lamp's Le.
  for (let k = 1; k < n; k++) {
    const bk = vs[k]!.beta;
    const ch = (x: number, b: number) => (b > 0 ? x / b : 0);
    cols.push(lineDisplay(ch(value.r, bk.r), ch(value.g, bk.g), ch(value.b, bk.b)));
  }
  cols.push(lineDisplay(li.L.r, li.L.g, li.L.b));
  return { pts, cols };
}

function buildRooms(): void {
  const desc = SCENES[params.scene];
  // The 3D room, dressed as many-samples dresses its box.
  for (const o of [...roomWorld.children]) roomWorld.remove(o);
  if (!roomsBuilt) {
    stage.add(roomWorld, ...rooms.map((r) => r.group));
    stage.renderWith(renderRooms);
    roomsBuilt = true;
  }
  const sceneGroup = sceneToThree(desc);
  roomWorld.add(sceneGroup);
  const hasLampQuad = desc.primitives.some((p) => p.emission && p.shape.kind === 'quad');
  if (hasLampQuad && desc.primitives.some((p) => p.name === 'right')) styleShortBox(stage.renderer, stage.scene, sceneGroup, desc);
  if (hasLampQuad) roomWorld.add(lampOutline(desc, 3));
  const frame = imagePlaneFrame(desc.camera, 0.6); // a small camera: eye, image plane, frustum to it
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) =>
    frame.center.clone().addScaledVector(frame.right, x! * frame.halfW).addScaledVector(frame.up, y! * frame.halfH),
  );
  const eyeDot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 20, 12), new THREE.MeshBasicMaterial({ color: C.bone, toneMapped: false }));
  eyeDot.position.copy(frame.eye);
  roomWorld.add(eyeDot, polyline([...corners, corners[0]!], { color: C.bone, width: 2, opacity: 0.7 }));
  for (const c of corners) roomWorld.add(polyline([frame.eye, c], { color: C.bone, width: 1.5, opacity: 0.45 }));
  // Over the camera's shoulder: behind and above its eye, looking where it looks.
  roomCamera.position.copy(frame.eye).addScaledVector(frame.forward, -4).addScaledVector(frame.up, 1.4);
  roomCamera.lookAt(frame.eye.clone().addScaledVector(frame.forward, 7.5).addScaledVector(frame.up, -0.3));

  // The paths, traced once, seeded: room k fires paths of k + 1 segments.
  const scene = buildScene(desc, RES, RES);
  const sampler = new IndependentSampler(0);
  const eyeForward = new Vec3(...desc.camera.lookAt).sub(new Vec3(...desc.camera.eye)).normalize();
  const scramble = (i: number) => (Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) >>> 0) / 4294967296;
  rooms.forEach((room, k) => {
    const n = DEPTHS[k]! + 1;
    room.fired = [];
    for (let a = 0; room.fired.length < FIRE.count && a < FIRE.count * 500; a++) {
      sampler.startPixelSample(pixelSeedKey(a, 1000 + n, 0)); // y >= 1000: disjoint from the films' pixel streams
      const path = tracePath(scene, n, sampler, eyeForward);
      if (!path) continue;
      const arc = [0];
      for (let i = 1; i < path.pts.length; i++) arc.push(arc[i - 1]! + path.pts[i]!.distanceTo(path.pts[i - 1]!));
      const i = room.fired.length;
      room.fired.push({ ...path, arc, start: (i + 0.9 * scramble(i + 7919 * n)) / FIRE.perSecond });
    }
  });
}

/** Each room's live paths at time t, sorted into fade buckets by age. */
function fire(t: number): void {
  const period = FIRE.count / FIRE.perSecond;
  for (const room of rooms) {
    const pos: number[][] = room.buckets.map(() => []);
    const col: number[][] = room.buckets.map(() => []);
    for (const p of room.fired) {
      const age = (((t - p.start) % period) + period) % period;
      if (age >= FIRE.life) continue;
      const b = Math.min(FIRE.buckets - 1, Math.floor((age / FIRE.life) * FIRE.buckets));
      const reach = p.arc[p.arc.length - 1]! * Math.min(1, age / FIRE.draw);
      for (let i = 1; i < p.pts.length && p.arc[i - 1]! < reach; i++) {
        const a = p.pts[i - 1]!;
        const e = p.arc[i]! <= reach ? p.pts[i]! : a.clone().lerp(p.pts[i]!, (reach - p.arc[i - 1]!) / (p.arc[i]! - p.arc[i - 1]!));
        const c = p.cols[i - 1]!;
        pos[b]!.push(a.x, a.y, a.z, e.x, e.y, e.z);
        col[b]!.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    room.buckets.forEach((lines, b) => setSegments(lines, new Float32Array(pos[b]!), new Float32Array(col[b]!)));
  }
}

const viewSize = new THREE.Vector2();
/** The three rooms, each into its own scissored viewport of the canvas; the HUD (films, borders) goes on top. */
function renderRooms(): void {
  const r = stage.renderer;
  r.getSize(viewSize);
  r.setScissorTest(false);
  r.setViewport(0, 0, viewSize.x, viewSize.y);
  r.clear();
  XS.forEach((cx, k) => {
    const x = ((cx - ROOM.w / 2) / ASPECT + 1) / 2 * viewSize.x;
    const y = ((ROOM.cy - ROOM.h / 2) + 1) / 2 * viewSize.y;
    const w = (ROOM.w / ASPECT / 2) * viewSize.x;
    const h = (ROOM.h / 2) * viewSize.y;
    r.setViewport(x, y, w, h);
    r.setScissor(x, y, w, h);
    r.setScissorTest(true);
    roomCamera.aspect = w / h;
    roomCamera.updateProjectionMatrix();
    rooms.forEach((room, j) => (room.group.visible = j === k));
    r.render(stage.scene, roomCamera);
  });
  r.setScissorTest(false);
  r.setViewport(0, 0, viewSize.x, viewSize.y);
}

if (PATHS) {
  for (const cx of XS) {
    const hw = ROOM.w / 2;
    const hh = ROOM.h / 2;
    const outline = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(cx - hw, ROOM.cy - hh, 0), new THREE.Vector3(cx + hw, ROOM.cy - hh, 0),
      new THREE.Vector3(cx + hw, ROOM.cy + hh, 0), new THREE.Vector3(cx - hw, ROOM.cy + hh, 0),
      new THREE.Vector3(cx - hw, ROOM.cy - hh, 0),
    ]);
    stage.hud.add(new THREE.Line(outline, new THREE.LineBasicMaterial({ color: C.slateDeep })));
  }
  stage.frame((t) => fire(t));
}

stage.onReady(async () => {
  while (spp < params.spp) await new Promise((r) => setTimeout(r, 100));
});
stage.start();
restart();

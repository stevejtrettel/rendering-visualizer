/**
 * SHOWS: what importance sampling actually is, by drawing the samples.
 *
 * One pixel, one primary ray, and the population of paths that pixel's
 * estimator draws. N are on screen at once; a few are retired and replaced
 * each refresh, so you watch the distribution being sampled rather than
 * looking at a finished picture of it.
 *
 * A path's contribution is f·cos/pdf, and the density of rays IS pdf, so
 * those are the two factors of one estimator — and the `sampling` control
 * moves the structure from one to the other:
 *
 *   uniform    every direction equally likely. The spray is even and the
 *              tubes vary enormously in thickness: the lobe appears as
 *              WEIGHT. Unbiased, and terrible.
 *   bsdf       what the renderer actually does. Rays cluster into the lobe
 *              and the weights flatten: the lobe appears as DENSITY.
 *
 * On Lambert the flattening is exact — f·cos/pdf = albedo for every
 * direction — so under `bsdf` every tube is the same thickness and all the
 * information is in where the rays went. That is the point, and it is
 * invisible until you can flip back to `uniform` and see the same integral
 * being estimated the hard way.
 *
 * Thickness tracks throughput AT each point along the path, so a tube also
 * tapers as light is lost at successive bounces.
 *
 * Aim at a GGX surface (the gold ball in cornell-glass) to see a tight
 * lobe; aim at a wall for the broad cosine one.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene, type Scene, type ScenePrimitive } from '@/core/scene/scene';
import { LinearAggregate } from '@/core/geometry/aggregate';
import { UniformSamplingBxDF } from '@/core/materials/uniform-sampled';
import { UnidirectionalPT } from '@/core/integrators/pt';
import { tracePaths } from '@/trace/replay';
import { luminanceOf } from '@/core/math/color';
import type { PathRecord, Tuple3 } from '@/trace/records';
import { sceneToThree } from '@/viz/three-scene';
import { PathTubes, type TubeEndpoint, type TubeSegment } from '@/viz/path-tubes';
import { ramp } from '@/viz/style';
import { swarmWindow } from '@/viz/path-swarm';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
// A fine film, so the sub-pixel jitter across samples is far too small to
// separate the first hit points: every path shares one primary ray and the
// fan is a clean lobe from a single vertex.
const FILM = 320;
const SEED = 0;
const DURATION = 12; // seconds per loop
const ZOOM_OUT = 1.15;
// Tube radii in world units, at the dimmest and brightest throughput.
const MIN_RADIUS = 0.0015;
const MAX_RADIUS = 0.018;
// Bead marking where a path stopped, as a multiple of the last radius.
const BEAD_SCALE = 2.2;
// A 64-step lookup of the palette's cold->hot ramp. Built once: the ramp
// helper allocates a THREE.Color, and this is read per segment per frame.
const RAMP_STEPS = 64;
const RAMP = (() => {
  const out = new Float32Array(RAMP_STEPS * 3);
  const c = new THREE.Color();
  for (let i = 0; i < RAMP_STEPS; i++) {
    c.setHex(ramp(i / (RAMP_STEPS - 1)));
    out[i * 3] = c.r;
    out[i * 3 + 1] = c.g;
    out[i * 3 + 2] = c.b;
  }
  return out;
})();
// Ceiling on how many paths are traced up front. At high swap rates the
// window would otherwise ask for tens of thousands and stall the page; past
// this the pool simply wraps, which nobody can see when members are being
// replaced every frame.
const MAX_PATHS = 12000;

const SCENE_NAMES = Object.keys(SCENES) as SceneName[];

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });
const ui = createUI(stage);

let sceneGroup: THREE.Group | null = null;
let tubes: PathTubes | null = null;

const caption = label('', {
  size: 0.058,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'top',
  position: [0, -0.82, 0],
});
stage.hud.add(caption);

// --- Controls --------------------------------------------------------------
const params = {
  scene: 'cornell' as SceneName,
  sampling: 'bsdf' as 'bsdf' | 'uniform',
  bounces: 1,
  onScreen: 64,
  // Swapping several members every frame is what makes the population read
  // as stochastic noise rather than as an animation of individual rays.
  // 60 ticks/second is per-frame on a 60 Hz display.
  replace: 8,
  rate: 60, // ticks per second
  // Radius mapping. 1 is proportional to throughput; below 1 lifts the
  // faint paths so they stay visible when the spread is enormous — which
  // it is under uniform sampling.
  gamma: 0.5,
  thickness: 1,
  // Draw the ray leaving the LAST bounce as a fixed-length stub instead of
  // flying to wherever it happens to hit. Equal-length stubs make the fan
  // read as density and thickness rather than as "how far it got", which is
  // the whole subject here. 0 restores the true segment.
  stub: 2.2,
  beads: true,
  pixelX: 0.42,
  pixelY: 0.62,
};

ui.params.add(params, 'scene', SCENE_NAMES).onChange(rebuild);
ui.params.add(params, 'sampling', ['bsdf', 'uniform']).onChange(rebuild);
ui.params.add(params, 'bounces', 1, 5, 1).name('bounces (k)').onChange(rebuild);
ui.params.add(params, 'onScreen', 8, 256, 1).name('paths on screen').onChange(rebuild);
ui.params.add(params, 'replace', 1, 64, 1).name('swapped per tick').onChange(rebuild);
ui.params.add(params, 'rate', 1, 60, 1).name('ticks / second').onChange(rebuild);
ui.params.add(params, 'gamma', 0.2, 1, 0.05).name('radius gamma');
ui.params.add(params, 'thickness', 0.2, 3, 0.05).name('thickness');
ui.params.add(params, 'stub', 0, 8, 0.1).name('last ray length');
ui.params.add(params, 'beads').name('end markers');
ui.params.add(params, 'pixelX', 0, 1, 0.005).name('pixel x').onChange(rebuild);
ui.params.add(params, 'pixelY', 0, 1, 0.005).name('pixel y').onChange(rebuild);

// --- Tracing ---------------------------------------------------------------
// Swap every material for one that samples uniformly. The walk is
// untouched: it multiplies throughput by f·|cos|/pdf from whatever the
// BxDF reports, so the estimator stays correct and only its variance moves.
function uniformScene(scene: Scene): Scene {
  const primitives: ScenePrimitive[] = scene.primitives.map((p) => ({
    ...p,
    bxdf: new UniformSamplingBxDF(p.bxdf),
  }));
  return { ...scene, primitives, aggregate: new LinearAggregate(primitives) };
}

let records: PathRecord[] = [];
let lastStep = -1;

function rebuild(): void {
  const base = buildScene(SCENES[params.scene], FILM, FILM);
  const scene = params.sampling === 'uniform' ? uniformScene(base) : base;
  // k bounces means k scattering events, so the walk needs one more vertex
  // to show the direction sampled at the last of them.
  const integrator = new UnidirectionalPT({
    maxBounces: params.bounces + 1,
    rrStartDepth: 999, // roulette off: the cap is the only reason a path ends
    sampleNEE: false,
  });

  const pixel = [
    Math.min(FILM - 1, Math.round(params.pixelX * FILM)),
    Math.min(FILM - 1, Math.round(params.pixelY * FILM)),
  ] as const;

  // Enough samples that the rolling window never runs off the end, within
  // the tracing budget.
  const wanted = params.onScreen + Math.ceil(DURATION * params.rate + 2) * params.replace;
  const total = Math.min(wanted, MAX_PATHS);
  records = tracePaths(scene, integrator, pixel, Array.from({ length: total }, (_, i) => i), {
    seed: SEED,
  });

  const view = vizViewFor(params.scene);
  if (sceneGroup) stage.scene.remove(sceneGroup);
  sceneGroup = sceneToThree(SCENES[params.scene]);
  stage.add(sceneGroup);
  const target = new THREE.Vector3(...view.target);
  stage.camera.position.copy(
    new THREE.Vector3(...view.eye).sub(target).multiplyScalar(ZOOM_OUT).add(target),
  );
  stage.controls?.target.copy(target);
  stage.controls?.update();

  // The buffer is preallocated, so it is sized here and reused for every
  // frame until the population or the path length changes.
  tubes?.dispose();
  tubes = new PathTubes(stage.scene, {
    capacity: params.onScreen * (params.bounces + 1),
    endpointCapacity: params.onScreen,
    radialSegments: 6,
  });

  stage.duration = DURATION;
  lastStep = -1;
}

// --- Population ------------------------------------------------------------
function refresh(t: number): void {
  const indices = swarmWindow(t, params.rate, params.replace, params.onScreen);
  // Wrap rather than run dry if the pool was capped.
  const visible = indices
    .map((i) => records[i % Math.max(1, records.length)])
    .filter(Boolean) as PathRecord[];

  // Normalise radii against the brightest throughput ON SCREEN, so the
  // spread is readable whichever sampling is in use — under uniform
  // sampling it covers orders of magnitude.
  let peak = 0;
  for (const r of visible) {
    for (let k = 1; k < r.vertices.length; k++) {
      const v = r.vertices[k]!;
      peak = Math.max(peak, luminanceOf(v.beta[0], v.beta[1], v.beta[2]));
    }
  }
  // Throughput drives BOTH thickness and colour, so a heavy path is fat and
  // hot and a negligible one is a thin cold thread — which is what makes
  // the uniform-vs-importance contrast legible at a glance.
  const weightOf = (beta: number): number =>
    peak > 0 ? Math.pow(Math.min(1, beta / peak), params.gamma) : 0;
  const radiusFor = (w: number): number =>
    (MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * w) * params.thickness;
  const colorFor = (w: number, dim: number): Tuple3 => {
    const i = Math.min(RAMP_STEPS - 1, Math.max(0, Math.round(w * (RAMP_STEPS - 1)))) * 3;
    return [RAMP[i]! * dim, RAMP[i + 1]! * dim, RAMP[i + 2]! * dim];
  };

  const segments: TubeSegment[] = [];
  const endpoints: TubeEndpoint[] = [];
  visible.forEach((record, n) => {
    // Older members dim, so the churn reads as flow rather than flicker.
    const age = visible.length > 1 ? 1 - n / (visible.length - 1) : 0;
    const dim = 1 - 0.6 * age;
    const last = record.vertices.length - 1;
    let tail: Tuple3 | null = null;
    let tailW = 0;

    for (let k = 1; k <= last; k++) {
      const a = record.vertices[k - 1]!;
      const b = record.vertices[k]!;
      const wA = weightOf(luminanceOf(a.beta[0], a.beta[1], a.beta[2]));
      const wB = weightOf(luminanceOf(b.beta[0], b.beta[1], b.beta[2]));

      // The final segment is cut to a fixed length when `stub` is set: the
      // fan then reads as density and thickness instead of as however far
      // each ray happened to fly before hitting something.
      let to = b.p;
      if (k === last && params.stub > 0) {
        const dx = b.p[0] - a.p[0];
        const dy = b.p[1] - a.p[1];
        const dz = b.p[2] - a.p[2];
        const len = Math.hypot(dx, dy, dz);
        if (len > params.stub) {
          const f = params.stub / len;
          to = [a.p[0] + dx * f, a.p[1] + dy * f, a.p[2] + dz * f];
        }
      }

      segments.push({
        from: a.p,
        to,
        radiusFrom: radiusFor(wA),
        radiusTo: radiusFor(wB),
        color: colorFor(wB, dim),
      });
      if (k === last) {
        tail = to;
        tailW = wB;
      }
    }

    // A bead where the path stopped, so it reads as an ending rather than
    // as a tube that ran out of geometry.
    if (params.beads && tail) {
      endpoints.push({
        p: tail,
        radius: radiusFor(tailW) * BEAD_SCALE,
        color: colorFor(tailW, dim),
      });
    }
  });
  tubes?.set(segments);
  tubes?.setEndpoints(params.beads ? endpoints : []);

  const lit = visible.filter((r) => r.contributions.some((c) => c.value.some((v) => v > 0))).length;
  setText(
    caption,
    `${params.sampling === 'uniform' ? 'uniform sampling' : 'importance sampling'} · ` +
      `${visible.length} paths · ${params.bounces} bounce${params.bounces === 1 ? '' : 's'} · ` +
      `${lit} carried light`,
  );
}

stage.frame((t) => {
  const step = Math.max(0, Math.floor(t * params.rate));
  if (step === lastStep) return; // the population only changes on a tick
  lastStep = step;
  refresh(t);
});

stage.start();
rebuild();

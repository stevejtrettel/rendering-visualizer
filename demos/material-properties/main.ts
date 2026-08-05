/**
 * SHOWS: what a material DOES, by drawing the rays it scatters.
 *
 * One sphere in the middle of the Cornell shell, one pixel aimed at it, and
 * the population of paths that pixel's estimator draws. N are on screen at
 * once; several are retired and replaced every frame, so the picture is the
 * distribution being sampled rather than a tidy diagram of it.
 *
 * Change the material and the spray changes shape: a broad cosine fan for
 * lambert, a tightening cone as conductor roughness falls, a single hard
 * direction for a mirror, a split into reflected and refracted branches for
 * glass. That is the BSDF, drawn by sampling it.
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
 * The scene is fixed on purpose — one object, nothing else to look at, so
 * the only thing changing between takes is the material. Aim with the pixel
 * sliders; the caption names the surface actually being hit.
 */

import { createStage, createUI, C } from '@';
import { materialTestScene } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene, type MaterialDescription, type Scene, type SceneDescription, type ScenePrimitive } from '@/core/scene/scene';
import { LinearAggregate } from '@/core/geometry/aggregate';
import { UniformSamplingBxDF } from '@/core/materials/uniform-sampled';
import { UnidirectionalPT } from '@/core/integrators/pt';
import { tracePaths } from '@/trace/replay';
import { luminanceOf } from '@/core/math/color';
import type { PathRecord, Tuple3 } from '@/trace/records';
import { sceneToThree } from '@/viz/three-scene';
import { PathTubes, type TubeEndpoint, type TubeSegment } from '@/viz/path-tubes';

import { swarmWindow } from '@/viz/path-swarm';
import { label, setText } from '@/viz/text';
import { BeautyPass } from '@/viz/beauty';
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
// Colour schemes for the paths, all out of the talk's palette. Throughput
// picks a position along whichever is selected, so colour and thickness
// carry the same quantity and reinforce each other.
const RAMPS = {
  // Bright warm yellow throughout — ochre is the palette's colour for light
  // itself. No dark end at all, which is the point: a ray that carried
  // little energy is THIN, and does not also need to be invisible. Both
  // ends stay SATURATED; running up to bone made them read as silver.
  gold: [C.ochre, C.ochreLight],
  // Warm with a dark end, so colour carries more of the range.
  ember: [C.rustDeep, C.rust, C.ochre, C.bone],
  // Cold to hot — the most quantitative, and the busiest.
  heat: [C.blueDeep, C.blue, C.moss, C.ochre, C.rust],
  // Cool: strongest contrast against a warm-lit box.
  ice: [C.slateDeep, C.blueDeep, C.blue, C.bone],
  // Achromatic: nothing competes with the scene's own colours.
  bone: [C.slateDeep, C.ash, C.bone],
} as const;
type RampName = keyof typeof RAMPS;

// A 64-step lookup, rebuilt only when the scheme changes: mixing allocates
// a THREE.Color, and this is read per segment per frame.
const RAMP_STEPS = 64;
let RAMP = new Float32Array(RAMP_STEPS * 3);
function buildRamp(name: RampName): void {
  const stops = RAMPS[name];
  const c = new THREE.Color();
  const a = new THREE.Color();
  for (let i = 0; i < RAMP_STEPS; i++) {
    const x = (i / (RAMP_STEPS - 1)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(x));
    a.setHex(stops[k]!);
    c.setHex(stops[k + 1]!).lerp(a, 1 - (x - k));
    RAMP[i * 3] = c.r;
    RAMP[i * 3 + 1] = c.g;
    RAMP[i * 3 + 2] = c.b;
  }
}
// Ceiling on how many paths are traced up front. At high swap rates the
// window would otherwise ask for tens of thousands and stall the page; past
// this the pool simply wraps, which nobody can see when members are being
// replaced every frame.
const MAX_PATHS = 12000;


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
type Kind = MaterialDescription['kind'];
const KINDS: Kind[] = ['lambert', 'mirror', 'conductor', 'dielectric'];

const params = {
  kind: 'conductor' as Kind,
  albedo: [0.75, 0.75, 0.78] as [number, number, number],
  f0: [1.0, 0.77, 0.34] as [number, number, number],
  roughness: 0.25,
  ior: 1.5,
  sampling: 'bsdf' as 'bsdf' | 'uniform',
  colour: 'gold' as RampName,
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
  stub: 1.6,
  beads: true,
  glow: 0.2,
  rayRoughness: 0.35,
  rayMetalness: 0,
  pixelX: 0.43,
  pixelY: 0.58,
  // Path-trace each EXPORTED frame instead of rasterising it. The preview
  // stays raster whatever this says — nothing that takes seconds a frame
  // belongs in a live view — so turning it on changes only what V produces.
  beauty: false,
  beautySamples: 128,
  beautyScale: 0.5,
  beautyBounces: 8,
};

ui.params.add(params, 'kind', KINDS).onChange(() => {
  showRelevant();
  rebuild();
});
const albedoC = ui.params.addColor(params, 'albedo').onChange(rebuild);
const f0C = ui.params.addColor(params, 'f0').name('reflectance (f0)').onChange(rebuild);
const roughC = ui.params.add(params, 'roughness', 0.005, 1, 0.005).onChange(rebuild);
const iorC = ui.params.add(params, 'ior', 1.0, 2.6, 0.01).onChange(rebuild);
ui.params.add(params, 'sampling', ['bsdf', 'uniform']).onChange(rebuild);
ui.params.add(params, 'bounces', 1, 5, 1).name('bounces (k)').onChange(rebuild);
ui.params.add(params, 'onScreen', 8, 256, 1).name('paths on screen').onChange(rebuild);
ui.params.add(params, 'replace', 1, 64, 1).name('swapped per tick').onChange(rebuild);
ui.params.add(params, 'rate', 1, 60, 1).name('ticks / second').onChange(rebuild);
ui.params.add(params, 'colour', Object.keys(RAMPS)).name('path colour').onChange(() => buildRamp(params.colour));
ui.params.add(params, 'gamma', 0.2, 1, 0.05).name('radius gamma');
ui.params.add(params, 'thickness', 0.2, 3, 0.05).name('thickness');
ui.params.add(params, 'stub', 0, 8, 0.1).name('last ray length');
ui.params.add(params, 'beads').name('end markers');
ui.params.add(params, 'glow', 0, 1, 0.05).name('ray glow').onChange(() => tubes?.setGlow(params.glow));
const setSurface = () => tubes?.setSurface(params.rayRoughness, params.rayMetalness);
ui.params.add(params, 'rayRoughness', 0.02, 1, 0.02).name('ray roughness').onChange(setSurface);
ui.params.add(params, 'rayMetalness', 0, 1, 0.05).name('ray metalness').onChange(setSurface);
ui.params.add(params, 'pixelX', 0, 1, 0.005).name('pixel x').onChange(rebuild);
ui.params.add(params, 'pixelY', 0, 1, 0.005).name('pixel y').onChange(rebuild);
const beautyFolder = ui.gui.addFolder('Path-traced export');
beautyFolder.add(params, 'beauty').name('path trace on V').onChange(setBeauty);
beautyFolder.add(params, 'beautySamples', 8, 2048, 8).name('samples / frame');
beautyFolder.add(params, 'beautyScale', 0.25, 1, 0.05).name('render scale');
beautyFolder.add(params, 'beautyBounces', 1, 16, 1).name('bounces');

// Only the properties this kind actually has are shown, so the panel says
// exactly what the material is.
function showRelevant(): void {
  albedoC.show(params.kind === 'lambert');
  f0C.show(params.kind === 'mirror' || params.kind === 'conductor');
  roughC.show(params.kind === 'conductor');
  iorC.show(params.kind === 'dielectric');
}
showRelevant();

const material = (): MaterialDescription => {
  switch (params.kind) {
    case 'lambert':
      return { kind: 'lambert', albedo: params.albedo };
    case 'mirror':
      return { kind: 'mirror', f0: params.f0 };
    case 'dielectric':
      return { kind: 'dielectric', ior: params.ior };
    case 'conductor':
      return { kind: 'conductor', f0: params.f0, roughness: params.roughness };
  }
};

const describe = (): string => {
  switch (params.kind) {
    case 'lambert':
      return 'lambert';
    case 'mirror':
      return 'mirror';
    case 'dielectric':
      return `glass · ior ${params.ior.toFixed(2)}`;
    case 'conductor':
      return `metal · roughness ${params.roughness.toFixed(2)}`;
  }
};

// A delta lobe has no density to replace, so UniformSamplingBxDF passes it
// straight through and the sampling toggle genuinely does nothing. Say so
// rather than let it look broken.
const isDelta = (): boolean => params.kind === 'mirror' || params.kind === 'dielectric';

// --- Path-traced export ----------------------------------------------------
// The tubes are REPARENTED into the traced scene rather than copied, so the
// export renders exactly the geometry the preview is showing — the same
// MeshStandardMaterial, the same per-frame ray population.
let beauty: BeautyPass | null = null;

// Turning it on gives a LIVE converging preview, not just a different
// export: you see the frame you are about to record. That means freezing
// the swarm — the tracer accumulates into one image, and a population that
// churned every frame would reset it before it ever converged.
function setBeauty(): void {
  if (!params.beauty) {
    if (beauty && tubes) stage.scene.add(tubes.group); // hand the tubes back
    beauty?.dispose();
    beauty = null;
    stage.renderWith(null);
    stage.speed = 1;
    return;
  }
  beauty = new BeautyPass(stage.renderer, stage.camera, {
    bounces: params.beautyBounces,
    samplesPerFrame: params.beautySamples,
    renderScale: params.beautyScale,
  });
  stage.speed = 0; // hold this frame's rays still so samples can accumulate
  syncBeauty();
  stage.renderWith(() => {
    beauty?.renderSample();
    if (beauty) {
      setText(
        caption,
        beauty.compiling
          ? 'path tracer · compiling shaders (first run is slow)…'
          : `path tracer · ${beauty.samples} samples · ${describe()}`,
      );
    }
  });
}

/** Point the tracer at the current material and the current ray population. */
function syncBeauty(): void {
  if (!beauty || !tubes) return;
  beauty.sync(materialTestScene(material()), tubes.group);
}

// Orbiting invalidates the accumulated image; the tracer needs telling.
stage.controls?.addEventListener('change', () => beauty?.updateCamera());

// Per EXPORTED frame: re-aim at this frame's tubes (the geometry changed,
// so the BVH is rebuilt and accumulation resets) and converge. This is the
// call that takes seconds, and the exporter simply waits for it.
stage.beforeCapture(async () => {
  if (!params.beauty || !beauty || !tubes) return;
  beauty.setSampleTarget(params.beautySamples);
  syncBeauty();
  const t0 = performance.now();
  await beauty.renderFrame((n, target) => {
    setText(caption, `path tracing · ${n} / ${target} samples`);
  });
  console.log(
    `[beauty] frame in ${((performance.now() - t0) / 1000).toFixed(1)}s · ` +
      `${params.beautySamples} samples at scale ${params.beautyScale}`,
  );
});

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
let aimedAt = '';
let lastStep = -1;

function rebuild(): void {
  const description = materialTestScene(material());
  const base = buildScene(description, FILM, FILM);
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

  // Which surface the pixel actually landed on. Aiming by two sliders is
  // otherwise pure guesswork, and a fan off the back wall looks plausible
  // enough to mislead.
  aimedAt = records[0]?.vertices[1]?.primitiveName ?? 'nothing';

  const view = vizViewFor('material-test');
  if (sceneGroup) stage.scene.remove(sceneGroup);
  sceneGroup = sceneToThree(description);
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
    glow: params.glow,
    roughness: params.rayRoughness,
    metalness: params.rayMetalness,
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
    // Gently: the ramp's low end is already dark, and 60% off on top of it
    // left the oldest half of the swarm effectively black.
    const age = visible.length > 1 ? 1 - n / (visible.length - 1) : 0;
    const dim = 1 - 0.3 * age;
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
  // The traced scene has to be re-aimed at the geometry that just changed.
  // Populating happens here rather than in rebuild(), so syncing there
  // would hand the tracer an empty buffer.
  if (params.beauty) syncBeauty();

  const sampling = isDelta()
    ? 'delta lobe — sampling toggle has no effect'
    : params.sampling === 'uniform'
      ? 'uniform sampling'
      : 'importance sampling';
  const aim = aimedAt === 'testObject' ? '' : ` · aimed at ${aimedAt}`;
  setText(
    caption,
    `${describe()} · ${sampling} · ` +
      `${params.bounces} bounce${params.bounces === 1 ? '' : 's'}${aim}`,
  );
}

stage.frame((t) => {
  const step = Math.max(0, Math.floor(t * params.rate));
  if (step === lastStep) return; // the population only changes on a tick
  lastStep = step;
  refresh(t);
});

buildRamp(params.colour);
stage.start();
rebuild();

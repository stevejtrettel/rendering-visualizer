/**
 * SHOWS: one dial, turned. Three materials side by side that differ in
 * exactly one number, and the three sprays that come back.
 *
 * The companion to material-properties, which draws one material's scattered
 * population beautifully and one at a time — deliberately, so that between
 * takes the ONLY thing changing is the material. This one gives that up to
 * get the comparison into a single frame: three Cornell shells, three
 * spheres, the same ray arriving at the same point on each.
 *
 *   fully rough  a Lambert surface. Directions scatter over the whole
 *                hemisphere on a cosine — there is no lobe at all, and the
 *                surface has no idea where the light came from.
 *   glossy       roughness 0.25. A recognisable lobe around the mirror
 *                direction, broad enough that the reflection it makes is
 *                soft.
 *   near mirror  roughness 0.03. The lobe collapses to a narrow cone —
 *                almost, but not quite, the single hard direction of a
 *                true mirror.
 *
 * Same geometry, same lighting, same incoming ray in all three, and the
 * last two are one BSDF with one number moved. So there is nothing to
 * attribute a difference to but the surface itself, which is the argument
 * the figure makes: a material is not a look, it is a distribution over
 * directions, and this is that distribution being drawn.
 *
 * Framing: all three boxes sit at the SAME place in world space, and the
 * frame is split in thirds with each third rendered by the same camera. The
 * three panes are therefore pixel-identical in framing, lighting and
 * vantage, head-on and centred. Orbit with the mouse and all three turn
 * together — there is only one camera to turn.
 *
 * One scatter per ray, drawn as an equal-length stub: the fan is then the
 * lobe read as DENSITY rather than as "how far each ray happened to fly
 * before it hit a wall". Rays churn, a few retired and replaced every tick,
 * so what you are looking at is the distribution being sampled rather than
 * a diagram of it.
 */

import { createStage, createUI, C, ASPECT } from '@';
import { materialTestScene } from '@/scenes/registry';
import { buildScene, type MaterialDescription } from '@/core/scene/scene';
import { UnidirectionalPT } from '@/core/integrators/pt';
import { tracePaths } from '@/trace/replay';
import { luminanceOf } from '@/core/math/color';
import type { PathRecord, Tuple3 } from '@/trace/records';
import { sceneToThree } from '@/viz/three-scene';
import { PathTubes, type TubeEndpoint, type TubeSegment } from '@/viz/path-tubes';
import { swarmWindow } from '@/viz/path-swarm';
import { polyline } from '@/viz/lines';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
// A fine film, so sub-pixel jitter across samples cannot separate the first
// hit points: every path shares one primary ray and the fan is a clean lobe
// from a single vertex.
const FILM = 320;
const SEED = 0;
const DURATION = 10; // seconds per loop
// Head-on and centred, rather than the three-quarter vantage vizViewFor
// hands out for this scene. materialTestScene's shell runs x [-1.3, 1.3],
// y [0, 2.3], z [-1.1, 2.8], so this aims at the box's own centre from
// straight in front of it, outside the (ghosted) front wall. A third of a
// 16:9 frame is much taller than it is wide, so the fit is set by WIDTH:
// at distance d a pane shows ±d·tan(21°)·(16/9)/3 = ±0.2275d, and 7.2 puts
// the box's 1.3 half-width at 79% of the pane. All three panes share this
// one camera, so they start — and stay — identically framed.
const VIEW_TARGET: [number, number, number] = [0, 1.15, 0];
const VIEW_DISTANCE = 7.2;
// Tube radii in world units, at the dimmest and brightest throughput.
const MIN_RADIUS = 0.0015;
const MAX_RADIUS = 0.016;
const BEAD_SCALE = 2.2; // terminal bead, as a multiple of the last radius
// Ceiling on paths traced per pane, so a fast churn cannot ask for tens of
// thousands and stall the page. Past this the pool wraps, which nobody can
// see when members are replaced every frame.
const MAX_PATHS = 9000;

/**
 * The three materials, broadest lobe to narrowest. Neutral throughout, so
 * no hue competes with the shape of the spray, and these three lines are
 * the whole story if the trio needs retuning for a projector.
 *
 * The two metals are ONE BSDF with one number moved. The rough pane is
 * Lambert rather than the same conductor at roughness 1.0, and that is a
 * measured choice, not a shortcut: at this pixel, over 400 samples, GGX
 * throws away the sample whenever it picks a direction below the horizon,
 * and it does that
 *
 *   roughness  1.0   0.9   0.8   0.7   0.6   0.5
 *   no ray     44%   35%   25%   18%   11%    6%
 *
 * of the time. A roughness-1.0 pane would therefore draw at barely half
 * the density of its neighbours, and since this figure reads a lobe AS
 * density, that misstates the material — it would say rough surfaces
 * scatter fewer rays, which they do not. Lambert loses none of them (0/400)
 * and still gives a wider fan than conductor 0.8 does: median 43 degrees
 * off the mean direction against 48, p90 70 against 77, at full density.
 * It is also simply what "fully rough" means.
 */
const NEUTRAL: [number, number, number] = [0.95, 0.95, 0.97];
interface Pane {
  title: string;
  material: MaterialDescription;
}
const PANES: Pane[] = [
  {
    title: 'fully rough — diffuse',
    material: { kind: 'lambert', albedo: NEUTRAL },
  },
  {
    title: 'glossy — roughness 0.25',
    material: { kind: 'conductor', f0: NEUTRAL, roughness: 0.25 },
  },
  {
    title: 'near mirror — roughness 0.03',
    material: { kind: 'conductor', f0: NEUTRAL, roughness: 0.03 },
  },
];

// Ray colour: the palette's warm end, bright throughout. A ray that carried
// little energy is THIN, and does not also need to be invisible.
const RAMP_STEPS = 64;
const RAMP = new Float32Array(RAMP_STEPS * 3);
{
  const a = new THREE.Color(C.ochre);
  const b = new THREE.Color(C.ochreLight);
  const c = new THREE.Color();
  for (let i = 0; i < RAMP_STEPS; i++) {
    c.copy(a).lerp(b, i / (RAMP_STEPS - 1));
    RAMP[i * 3] = c.r;
    RAMP[i * 3 + 1] = c.g;
    RAMP[i * 3 + 2] = c.b;
  }
}

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });
stage.duration = DURATION; // before createUI: it reads duration once
const ui = createUI(stage);

// Each pane's box and its rays live in one group, shown only while its own
// third of the frame is being drawn. All three sit at the same origin.
const groups = PANES.map(() => new THREE.Group());
stage.add(...groups);
let tubes: Array<PathTubes | null> = PANES.map(() => null);
let records: PathRecord[][] = PANES.map(() => []);

const captions = PANES.map((pane, i) =>
  label(pane.title, {
    size: 0.05,
    color: C.bone,
    anchorX: 'center',
    anchorY: 'top',
    // Pane centres in HUD coordinates: the frame runs ±ASPECT.
    position: [ASPECT * (-1 + (2 * i + 1) / 3), -0.78, 0],
  }),
);
for (const c of captions) stage.hud.add(c);

// Hairlines between the panes, so three renders read as three panels.
for (const x of [-ASPECT / 3, ASPECT / 3]) {
  stage.hud.add(
    polyline(
      [
        [x, -1, 0],
        [x, 1, 0],
      ],
      { color: C.slateDeep, width: 1.5 },
    ),
  );
}

const aimCaption = label('', {
  size: 0.045,
  color: C.ash,
  anchorX: 'center',
  anchorY: 'top',
  position: [0, -0.88, 0],
});
stage.hud.add(aimCaption);

// --- Controls --------------------------------------------------------------
const params = {
  // Where the single incoming ray lands. Shared by all three panes — the
  // geometry is identical, so the same pixel hits the same point on each
  // sphere and the fans are directly comparable.
  pixelX: 0.43,
  pixelY: 0.58,
  onScreen: 160,
  // Swapping several members every tick is what makes the population read
  // as stochastic noise rather than as an animation of individual rays.
  replace: 8,
  rate: 60,
  // Radius mapping. 1 is proportional to throughput; below 1 lifts the
  // faint rays so they stay visible when the spread runs over orders of
  // magnitude — which on the near mirror it does.
  gamma: 0.5,
  thickness: 1,
  // The scattered ray is cut to this length rather than flying to wherever
  // it happens to hit. Equal-length stubs make the fan read as density and
  // thickness, which is the whole subject.
  stub: 1.4,
  beads: true,
  zoom: 1,
};

ui.params.add(params, 'pixelX', 0, 1, 0.005).name('pixel x').onChange(rebuild);
ui.params.add(params, 'pixelY', 0, 1, 0.005).name('pixel y').onChange(rebuild);
ui.params.add(params, 'onScreen', 8, 384, 1).name('rays on screen').onChange(rebuild);
ui.params.add(params, 'replace', 1, 64, 1).name('swapped per tick').onChange(rebuild);
ui.params.add(params, 'rate', 1, 60, 1).name('ticks / second').onChange(rebuild);
ui.params.add(params, 'gamma', 0.2, 1, 0.05).name('radius gamma');
ui.params.add(params, 'thickness', 0.2, 3, 0.05).name('thickness');
ui.params.add(params, 'stub', 0.2, 4, 0.1).name('ray length');
ui.params.add(params, 'beads').name('end markers');
ui.params.add(params, 'zoom', 0.6, 2.5, 0.01).name('distance (x)').onChange(placeCamera);

// --- Three panes out of one camera -----------------------------------------
// The stage draws one scene with one camera; this replaces that with three
// scissored passes over the same scene, showing one group each. Nothing
// about the camera changes between them, which is the point — the panes
// cannot drift apart because there is only one vantage.
const paneAspect = ASPECT / 3;
const size = new THREE.Vector2();

stage.renderWith(() => {
  const renderer = stage.renderer;
  renderer.getSize(size);
  renderer.setScissorTest(true);
  for (let i = 0; i < groups.length; i++) {
    // Integer boundaries, or rounding leaves an uncleared seam between panes.
    const x0 = Math.round((i * size.x) / groups.length);
    const x1 = Math.round(((i + 1) * size.x) / groups.length);
    renderer.setViewport(x0, 0, x1 - x0, size.y);
    renderer.setScissor(x0, 0, x1 - x0, size.y);
    groups.forEach((g, k) => (g.visible = k === i));
    renderer.render(stage.scene, stage.camera);
  }
  // Hand the renderer back whole, or the HUD is clipped to the last pane.
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.setScissor(0, 0, size.x, size.y);
  groups.forEach((g) => (g.visible = true));
});

function placeCamera(): void {
  const target = new THREE.Vector3(...VIEW_TARGET);
  stage.camera.position.set(target.x, target.y, target.z + VIEW_DISTANCE * params.zoom);
  stage.camera.lookAt(target);
  stage.controls?.target.copy(target);
  stage.controls?.update();
  // A third of the frame is much taller than it is wide, and the camera is
  // only ever rendered into one of those thirds.
  if (stage.camera instanceof THREE.PerspectiveCamera) {
    stage.camera.aspect = paneAspect;
    stage.camera.updateProjectionMatrix();
  }
}

// --- Tracing ---------------------------------------------------------------
let lastStep = -1;

function rebuild(): void {
  const pixel = [
    Math.min(FILM - 1, Math.round(params.pixelX * FILM)),
    Math.min(FILM - 1, Math.round(params.pixelY * FILM)),
  ] as const;
  // Enough samples that the rolling window never runs off the end.
  const wanted = params.onScreen + Math.ceil(DURATION * params.rate + 2) * params.replace;
  const total = Math.min(wanted, MAX_PATHS);
  const indices = Array.from({ length: total }, (_, i) => i);

  let aimedAt = 'nothing';
  PANES.forEach((pane, i) => {
    const description = materialTestScene(pane.material);
    // One scattering event needs two bounces of walk: one more vertex than
    // events, to show the direction sampled at it. Roulette off, so the cap
    // is the only reason a path ends.
    const integrator = new UnidirectionalPT({
      maxBounces: 2,
      rrStartDepth: 999,
      sampleNEE: false,
    });
    records[i] = tracePaths(buildScene(description, FILM, FILM), integrator, pixel, indices, {
      seed: SEED,
    });
    aimedAt = records[i]![0]?.vertices[1]?.primitiveName ?? aimedAt;

    groups[i]!.clear();
    groups[i]!.add(sceneToThree(description));
    tubes[i]?.dispose();
    tubes[i] = new PathTubes(groups[i]!, {
      capacity: params.onScreen * 2,
      endpointCapacity: params.onScreen,
      radialSegments: 6,
      glow: 0.2,
      roughness: 0.35,
      metalness: 0,
    });
  });

  // Which surface the pixel landed on. Aiming by two sliders is otherwise
  // guesswork, and a fan off the back wall looks plausible enough to mislead.
  setText(
    aimCaption,
    aimedAt === 'testObject'
      ? `${params.onScreen} rays · one scatter each`
      : `aimed at ${aimedAt}, not the sphere`,
  );

  placeCamera();
  lastStep = -1;
}

function refresh(t: number): void {
  const indices = swarmWindow(t, params.rate, params.replace, params.onScreen);

  for (let i = 0; i < PANES.length; i++) {
    const pool = records[i]!;
    if (pool.length === 0) continue;
    const visible = indices.map((k) => pool[k % pool.length]!).filter(Boolean);

    // Normalise radii against the brightest throughput ON SCREEN — and per
    // pane, because the three materials do not carry comparable energy: a
    // near mirror returns nearly everything down one direction while glass
    // splits it, and a single shared scale would leave one pane a smear of
    // hairlines.
    let peak = 0;
    for (const r of visible) {
      for (let k = 1; k < r.vertices.length; k++) {
        const v = r.vertices[k]!;
        peak = Math.max(peak, luminanceOf(v.beta[0], v.beta[1], v.beta[2]));
      }
    }
    const weightOf = (beta: number) =>
      peak > 0 ? Math.pow(Math.min(1, beta / peak), params.gamma) : 0;
    const radiusFor = (w: number) =>
      (MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * w) * params.thickness;
    const colorFor = (w: number, dim: number): Tuple3 => {
      const j = Math.min(RAMP_STEPS - 1, Math.max(0, Math.round(w * (RAMP_STEPS - 1)))) * 3;
      return [RAMP[j]! * dim, RAMP[j + 1]! * dim, RAMP[j + 2]! * dim];
    };

    const segments: TubeSegment[] = [];
    const endpoints: TubeEndpoint[] = [];
    visible.forEach((record, n) => {
      // Older members dim, so the churn reads as flow rather than flicker.
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

        // The scattered ray is cut to a fixed length, so the fan reads as
        // density rather than as however far each ray flew.
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

      if (params.beads && tail) {
        endpoints.push({
          p: tail,
          radius: radiusFor(tailW) * BEAD_SCALE,
          color: colorFor(tailW, dim),
        });
      }
    });

    tubes[i]?.set(segments);
    tubes[i]?.setEndpoints(params.beads ? endpoints : []);
  }
}

stage.frame((t) => {
  const step = Math.max(0, Math.floor(t * params.rate));
  if (step === lastStep) return; // the population only changes on a tick
  lastStep = step;
  refresh(t);
});

stage.start();
rebuild();

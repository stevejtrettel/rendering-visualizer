// The scene registry: named scene descriptions a demo picks ONE of, as a
// constant. `cornell` stays the pedagogically clean Lambert default;
// `cornell-glass` swaps the spheres for a glass ball (the caustic-maker) and
// a gold GGX ball. New scenes are new entries here.
//
// Library content, not demo content: `tests/` reads this registry too, so it
// must stay importable from plain Node. Everything needing a bundler (the
// fetched OBJ models) lives in ./assets.ts, and the three.js vantage points
// live in src/viz/views.ts.
import type { SceneDescription } from '../core/scene/scene';
import { CORNELL } from './cornell';
const CORNELL_GLASS: SceneDescription = {
  camera: CORNELL.camera,
  primitives: [
    ...CORNELL.primitives.filter((p) => p.name !== 'ball' && p.name !== 'ballBlue'),
    {
      name: 'glassBall',
      shape: { kind: 'sphere', center: [-0.55, 0.8, -0.35], radius: 0.8 },
      material: { kind: 'dielectric', ior: 1.5 },
    },
    {
      name: 'goldBall',
      shape: { kind: 'sphere', center: [1.05, 0.55, 0.7], radius: 0.55 },
      material: { kind: 'conductor', f0: [1.0, 0.77, 0.34], roughness: 0.25 },
    },
  ],
};

// The SMS refraction showcase (V5b): cornell-glass with the ceiling light
// shrunk to 0.3² at ×28 radiance (equal power). Under the broad 1.6²
// light, BSDF luck finds the caustic cheaply and SMS's discovery
// correction only adds heavy-tailed noise (measured: relVar 5.7 unbiased
// vs 2.1 NEE); under this small hard light the solver wins 32× per
// sample. The pair IS the regime figure.
// The ball FLOATS and the small light sits behind it, so the refracted
// focus lands on VISIBLE floor in front (a ball resting on the floor
// hides its own caustic underneath itself — found out in the panes).
const CORNELL_CAUSTIC: SceneDescription = {
  camera: CORNELL.camera,
  primitives: [
    ...CORNELL_GLASS.primitives.filter((p) => p.name !== 'light' && p.name !== 'glassBall'),
    { name: 'light', shape: { kind: 'quad', q: [-1.0, 3.998, -1.25], e1: [0.3, 0, 0], e2: [0, 0, 0.3] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [400, 400, 400] } },
    { name: 'glassBall', shape: { kind: 'sphere', center: [-0.2, 1.0, 0.5], radius: 0.6 }, material: { kind: 'dielectric', ior: 1.5 } },
  ],
};

// The CATEGORICAL scene (V5c, 2026-08-03): cornell-caustic with a POINT
// light. S(D)S transport from a delta emitter has measure-zero
// probability under every local strategy — PT can never hit the light,
// NEE's shadow rays refract away at the glass, BDPT dies on the delta
// chain (and its sampleLe returns null here anyway). The caustic EXISTS
// only in the pt-sms pane; everywhere else that floor patch is black.
// pt / pt-nee / pt-sms only — bidirectional integrators must not rely on
// delta lights (the V2 lock stands).
const CORNELL_DELTA: SceneDescription = {
  camera: CORNELL.camera,
  primitives: CORNELL_CAUSTIC.primitives.filter((p) => p.name !== 'light'),
  pointLights: [{ p: [-0.85, 3.9, -1.1], intensity: [36, 36, 36] }],
};

// The BDPT showcase: an uplight — the emitter faces the CEILING, recessed
// inside a shaded fixture, so the room is lit entirely by the ceiling
// bounce. Below the fixture rim the emitting side is invisible: depth-1 NEE
// is exactly zero there and PT must blindly find the bright ceiling pool,
// while every BDPT light subpath starts at the source, lands its first
// vertex in the pool, and connects outward from there.
const SHADE = { kind: 'lambert' as const, albedo: [0.25, 0.25, 0.25] as const };
const CORNELL_LAMP: SceneDescription = {
  camera: CORNELL.camera,
  primitives: [
    ...CORNELL.primitives.filter((p) => p.name !== 'light'),
    { name: 'lampEmitter', shape: { kind: 'quad', q: [-0.4, 2.7, -0.4], e1: [0, 0, 0.8], e2: [0.8, 0, 0] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [100, 100, 100] } },
    { name: 'lampPlate', shape: { kind: 'quad', q: [-0.6, 2.55, -0.6], e1: [1.2, 0, 0], e2: [0, 0, 1.2] }, material: SHADE },
    { name: 'lampSkirtFront', shape: { kind: 'quad', q: [-0.6, 2.55, 0.6], e1: [1.2, 0, 0], e2: [0, 0.4, 0] }, material: SHADE },
    { name: 'lampSkirtBack', shape: { kind: 'quad', q: [-0.6, 2.55, -0.6], e1: [0, 0.4, 0], e2: [1.2, 0, 0] }, material: SHADE },
    { name: 'lampSkirtLeft', shape: { kind: 'quad', q: [-0.6, 2.55, -0.6], e1: [0, 0, 1.2], e2: [0, 0.4, 0] }, material: SHADE },
    { name: 'lampSkirtRight', shape: { kind: 'quad', q: [0.6, 2.55, -0.6], e1: [0, 0.4, 0], e2: [0, 0, 1.2] }, material: SHADE },
  ],
};

// An OPEN scene: floor and back wall only — no ceiling, no sides, no front.
// Every Cornell variant is a closed box, where a walk can only end by hitting
// an emitter or dying to Russian roulette; here most walks eventually leave
// the scene entirely, which is the only way to see an escaped ray.
const WHITE = { kind: 'lambert' as const, albedo: [0.73, 0.73, 0.73] as const };
const OPEN_STAGE: SceneDescription = {
  camera: { eye: [0, 2, 9.5], lookAt: [0, 1.2, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-4, 0, -4], e1: [0, 0, 12], e2: [8, 0, 0] }, material: WHITE },
    { name: 'back', shape: { kind: 'quad', q: [-4, 0, -4], e1: [8, 0, 0], e2: [0, 5, 0] }, material: WHITE },
    { name: 'light', shape: { kind: 'quad', q: [-0.8, 3.5, -1.2], e1: [1.6, 0, 0], e2: [0, 0, 1.6] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [22, 22, 22] } },
    { name: 'ball', shape: { kind: 'sphere', center: [-0.9, 0.8, -0.6], radius: 0.8 }, material: WHITE },
    { name: 'ballBlue', shape: { kind: 'sphere', center: [0.9, 0.55, 0.6], radius: 0.55 }, material: { kind: 'lambert', albedo: [0.35, 0.45, 0.8] } },
  ],
};

// The material library in one image: four spheres in a row, one per
// MaterialDescription kind, in a shallow wide box open at the front. Rendered
// on a 2:1 film — the only non-square scene, which also exercises the
// camera's aspect handling. `mirror` (SmoothConductor) appears in no other
// scene.
const MATERIAL_ROW: SceneDescription = {
  camera: { eye: [0, 1.6, 7.5], lookAt: [0, 0.8, 0], up: [0, 1, 0], fovDegrees: 30 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-4, 0, -3], e1: [0, 0, 9], e2: [8, 0, 0] }, material: WHITE },
    { name: 'ceiling', shape: { kind: 'quad', q: [-4, 4, -3], e1: [8, 0, 0], e2: [0, 0, 9] }, material: WHITE },
    { name: 'back', shape: { kind: 'quad', q: [-4, 0, -3], e1: [8, 0, 0], e2: [0, 4, 0] }, material: WHITE },
    { name: 'left', shape: { kind: 'quad', q: [-4, 0, -3], e1: [0, 4, 0], e2: [0, 0, 9] }, material: { kind: 'lambert', albedo: [0.65, 0.05, 0.05] } },
    { name: 'right', shape: { kind: 'quad', q: [4, 0, -3], e1: [0, 0, 9], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.12, 0.45, 0.15] } },
    { name: 'light', shape: { kind: 'quad', q: [-3, 3.99, -1.5], e1: [6, 0, 0], e2: [0, 0, 3] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [3, 3, 3] } },
    { name: 'lambertBall', shape: { kind: 'sphere', center: [-2.25, 0.6, 0], radius: 0.6 }, material: { kind: 'lambert', albedo: [0.75, 0.75, 0.78] } },
    { name: 'mirrorBall', shape: { kind: 'sphere', center: [-0.75, 0.6, 0], radius: 0.6 }, material: { kind: 'mirror', f0: [0.95, 0.95, 0.95] } },
    { name: 'glassBall', shape: { kind: 'sphere', center: [0.75, 0.6, 0], radius: 0.6 }, material: { kind: 'dielectric', ior: 1.5 } },
    { name: 'goldBall', shape: { kind: 'sphere', center: [2.25, 0.6, 0], radius: 0.6 }, material: { kind: 'conductor', f0: [1.0, 0.77, 0.34], roughness: 0.25 } },
  ],
};

// The Metropolis showcase (Veach & Guibas 1997's door scene, in our box):
// a divider wall splits the Cornell interior at z = 0; the only light sits
// in the hidden back room, so EVERY complete path must thread the slit.
// PT must blunder through it and then hit the light; NEE's shadow rays are
// blocked from all but the wedge of floor with direct sight through the
// gap; BDPT's light subpaths stay trapped in the back room and its
// connections cross the divider — all strategies share one bottleneck, so
// MIS has nothing good to mix. MLT pays the search once (bootstrap) and
// keeps threaded paths threaded under small steps.
//
// The gap is the difficulty dial, tuned by probe (2026-07-30, 16², depth
// cap 8): at 0.2 / 0.35 / 0.5 the nonzero-sample fractions are PT 0.11 /
// 0.18 / 0.23 %, NEE 3.8 / 6.8 / 9.5 % (the wedge with direct sight
// through the slit), BDPT 30 / 42 / 51 % (flattering — nonzero says
// nothing about weight), while a 65536-sample bootstrap lands 1.5k / 2.6k
// / 3.5k hits — b good to ~2–3 % everywhere (an error in b is a global
// brightness bias on the MLT image). Default 0.25: maximal misery for the
// independent samplers with the bootstrap still comfortably healthy.
const DOOR_WHITE = { kind: 'lambert' as const, albedo: [0.73, 0.73, 0.73] as const };
export function doorAjarScene(gap = 0.25): SceneDescription {
  const frameEnd = -1.6; // fixed door-frame strip [-2, frameEnd], then the gap
  return {
    camera: CORNELL.camera,
    primitives: [
      // The shared shell (floor/ceiling/left/right span BOTH rooms; the
      // ghosted front wall stays the visualizer's window).
      ...CORNELL.primitives.filter((p) =>
        ['floor', 'ceiling', 'back', 'left', 'right', 'front'].includes(p.name!)),
      // Divider at z = 0, full-height slit between the two slabs. Quads are
      // zero-thickness and Lambert reflects from both faces, so one quad
      // per slab serves both rooms. e1 x e2 faces the camera room (+z).
      { name: 'doorFrame', shape: { kind: 'quad', q: [-2, 0, 0], e1: [2 + frameEnd, 0, 0], e2: [0, 4, 0] }, material: DOOR_WHITE },
      { name: 'doorSlab', shape: { kind: 'quad', q: [frameEnd + gap, 0, 0], e1: [2 - frameEnd - gap, 0, 0], e2: [0, 4, 0] }, material: DOOR_WHITE },
      // The only light: on the back room's far wall, off-axis from the slit
      // so most transport needs a back-room bounce before threading it.
      { name: 'light', shape: { kind: 'quad', q: [0.4, 1.2, -1.999], e1: [1.2, 0, 0], e2: [0, 1.6, 0] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [120, 120, 120] } },
      // Camera-room furniture (in FRONT of the divider, unlike cornell's).
      // The near ball is glass: it sits in the light wedge, so the slit
      // light refracts through it — caustics fed through a door gap.
      { name: 'glassBall', shape: { kind: 'sphere', center: [-0.9, 0.8, 1.2], radius: 0.8 }, material: { kind: 'dielectric', ior: 1.5 } },
      { name: 'ballBlue', shape: { kind: 'sphere', center: [0.9, 0.55, 2.4], radius: 0.55 }, material: { kind: 'lambert', albedo: [0.35, 0.45, 0.8] } },
    ],
  };
}

// The many-light showcase (V4/ReSTIR): an 8×8 grid of small colored ceiling
// emitters with a ~50× radiance spread. Uniform light selection wastes most
// draws on dim panels; power selection helps; per-pixel resampling + reuse
// is the point. Radiance and hue are deterministic functions of the grid
// index so the scene is stable across sessions.
const CHANDELIER_PALETTE: readonly ColorTuple3[] = [
  [1.0, 0.6, 0.3], // warm orange
  [0.4, 0.6, 1.0], // cool blue
  [1.0, 0.9, 0.6], // soft white
  [0.5, 1.0, 0.6], // green
  [1.0, 0.5, 0.8], // pink
  [0.7, 0.8, 1.0], // pale blue
];
type ColorTuple3 = readonly [number, number, number];
function chandelierEmitters(): SceneDescription['primitives'] {
  const out: SceneDescription['primitives'] = [];
  const cell = 0.18; // emitter half-extent... quad edge length
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const k = i * 8 + j;
      // Brightness cycles over ~1.7 decades: 0.4 .. 20 (50×), deterministic.
      const brightness = 0.4 * Math.pow(50, (k % 7) / 6);
      const [r, g, b] = CHANDELIER_PALETTE[k % CHANDELIER_PALETTE.length]!;
      const x = -1.6 + 0.2 + i * 0.4 - cell / 2;
      const z = -1.6 + 0.2 + j * 0.4 - cell / 2;
      out.push({
        name: `lamp-${i}-${j}`,
        shape: { kind: 'quad', q: [x, 3.998, z], e1: [cell, 0, 0], e2: [0, 0, cell] },
        material: { kind: 'lambert', albedo: [0, 0, 0] },
        emission: { radiance: [r * brightness, g * brightness, b * brightness] },
      });
    }
  }
  return out;
}
const CHANDELIER: SceneDescription = {
  camera: CORNELL.camera,
  primitives: [
    ...CORNELL.primitives.filter((p) => p.name !== 'light'),
    ...chandelierEmitters(),
  ],
};

// The SMS showcase (V5): a mirror ball on the floor lit by a small bright
// wall light — the reflective floor caustic is a single-bounce specular
// chain (light → mirror → floor), and every diffuse point connecting to
// the light VIA the mirror is a connection NEE structurally cannot make;
// pt-sms solves for it. The ceiling light is gone: all indirect transport
// routes through the small source, so the caustic reads against a dim
// floor.
const CAUSTIC_RING: SceneDescription = {
  camera: CORNELL.camera,
  primitives: [
    ...CORNELL.primitives.filter((p) => !['light', 'ball', 'ballBlue'].includes(p.name!)),
    // Small emitter on the left wall, facing into the room (e1 × e2 = +x).
    { name: 'light', shape: { kind: 'quad', q: [-1.999, 2.2, -0.4], e1: [0, 0.8, 0], e2: [0, 0, 0.8] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [90, 90, 90] } },
    { name: 'mirrorBall', shape: { kind: 'sphere', center: [0.35, 0.7, 0.3], radius: 0.7 }, material: { kind: 'mirror', f0: [0.95, 0.95, 0.95] } },
  ],
};

export const SCENES = {
  cornell: CORNELL,
  'cornell-glass': CORNELL_GLASS,
  'cornell-caustic': CORNELL_CAUSTIC,
  'cornell-delta': CORNELL_DELTA,
  'caustic-ring': CAUSTIC_RING,
  'cornell-lamp': CORNELL_LAMP,
  chandelier: CHANDELIER,
  'door-ajar': doorAjarScene(),
  'open-stage': OPEN_STAGE,
  'material-row': MATERIAL_ROW,
} satisfies Record<string, SceneDescription>;

export type SceneName = keyof typeof SCENES;

// Names of the emissive primitives, matching buildScene's naming exactly —
// the index of the fallback name must be the index in the FULL primitive
// list, so the map has to come before the filter.
export function emissiveNames(desc: SceneDescription): Set<string> {
  return new Set(
    desc.primitives
      .map((p, i) => ({ name: p.name ?? `primitive-${i}`, emissive: p.emission != null }))
      .filter((p) => p.emissive)
      .map((p) => p.name),
  );
}

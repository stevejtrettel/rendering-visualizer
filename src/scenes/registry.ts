// The scene registry: named scene descriptions a demo picks ONE of, as a
// constant. `cornell` stays the pedagogically clean Lambert default;
// `cornell-glass` swaps the spheres for a glass ball (the caustic-maker) and
// a gold GGX ball. New scenes are new entries here.
//
// Library content, not demo content: `tests/` reads this registry too, so it
// must stay importable from plain Node. Everything needing a bundler (the
// fetched OBJ models) lives in ./assets.ts, and the three.js vantage points
// live in src/viz/views.ts.
import type { MaterialDescription, SceneDescription } from '../core/scene/scene';
import { CORNELL, CORNELL_SHORT } from './cornell';
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
// NEE's shadow rays refract away at the glass, and BDPT's connections die
// on the delta chain. The caustic EXISTS only in the pt-sms pane;
// everywhere else that floor patch is black. THAT is the claim, and it is
// about the S(D)S caustic specifically.
//
// It is NOT that the other integrators break on the scene: BDPT and MMLT
// carry a point light perfectly well (V5c gave PointLight a real
// sampleLe/pdfLe; measured against NEE in tests/delta-light-mis.test.ts),
// they simply cannot find this particular transport. ReSTIR is the one
// that genuinely does not support delta lights at all — its reservoir
// target is zero at one (docs/design-cleanup.md §7).
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

// A bare stage for looking at ONE material: the Cornell shell with a single
// sphere in the middle and nothing else to distract from it. The material is
// a parameter because the point is to change it — demos/material-test drives
// this from the UI; the registry entry below is just a default so the scene
// shows up in every other page's scene menu too.
// Its own shell rather than CORNELL's: that one is deliberately ELONGATED
// (13 deep, camera inside at z = 9.5) to leave room in front of the pinhole
// for the image-plane figures. Here there is nothing to make room for, and
// the long tunnel toward the viewer just pushes the object away and fills
// the frame with empty floor. This box is 8.5 deep with the camera near the
// front wall.
// Sized to the object rather than to a room: the walls clear the sphere by
// well under its own radius, so the frame is the material and nothing else.
// Cornell's shell is the opposite on purpose — 13 deep, camera inside at
// z = 9.5, leaving space in front of the pinhole for the image-plane
// figures — and borrowing it here just filled the picture with empty floor.
//
// The one hard constraint is that the camera lives INSIDE the box (the
// front wall is real to the renderer, only ghosted for three.js), so it
// cannot back off to frame a large object. The sphere is sized against that
// rather than the other way round.
const MT_WHITE = { kind: 'lambert' as const, albedo: [0.73, 0.73, 0.73] as const };
const MT_X = 1.3; // side walls at +-X
const MT_TOP = 2.3;
const MT_BACK = -1.1;
const MT_FRONT = 2.8;
const MT_DEPTH = MT_FRONT - MT_BACK;
// RESTING on the floor: centre height == radius (Steve, 2026-08-04).
//
// It was floated at y = 1.15 before that, on the reasoning that a sphere in
// contact with a surface has a hard contact shadow right where it meets it,
// and that under a big soft light that shadow merges with everything near
// the floor into one dark mass reading as a plinth rather than as shadow.
// Kept here because it is the thing to check if the contact ever looks
// wrong — but the mass that actually prompted it turned out to be the
// phantom bead sphere the path tracer was baking at the world origin (see
// src/viz/path-tubes.ts), not the shadow, so the reason for floating it
// was largely a misdiagnosis.
//
// The light's radiance had been tuned partly around the floated sphere, on
// the belief that floating lifted the room by about a third — so resting it
// ought to darken things. MEASURED instead (48x48, pt-nee, 64 spp, this
// conductor): resting mean luminance 0.4293 vs floating 0.4011, i.e. 7%
// BRIGHTER, not darker. Radiance is therefore left at 3.6.
//
// The demo's default aim (pixelX 0.43, pixelY 0.58) still lands on
// testObject, as does the whole column pixelY 0.40-0.75, so nothing
// downstream needed re-aiming.
const MT_BALL = { center: [0, 0.7, 0] as const, radius: 0.7 };

export function materialTestScene(material: MaterialDescription): SceneDescription {
  return {
    camera: { eye: [0, 1.25, 2.4], lookAt: [0, 1.1, 0], up: [0, 1, 0], fovDegrees: 48 },
    primitives: [
      { name: 'floor', shape: { kind: 'quad', q: [-MT_X, 0, MT_BACK], e1: [0, 0, MT_DEPTH], e2: [2 * MT_X, 0, 0] }, material: MT_WHITE },
      { name: 'ceiling', shape: { kind: 'quad', q: [-MT_X, MT_TOP, MT_BACK], e1: [2 * MT_X, 0, 0], e2: [0, 0, MT_DEPTH] }, material: MT_WHITE },
      { name: 'back', shape: { kind: 'quad', q: [-MT_X, 0, MT_BACK], e1: [2 * MT_X, 0, 0], e2: [0, MT_TOP, 0] }, material: MT_WHITE },
      { name: 'left', shape: { kind: 'quad', q: [-MT_X, 0, MT_BACK], e1: [0, MT_TOP, 0], e2: [0, 0, MT_DEPTH] }, material: { kind: 'lambert', albedo: [0.65, 0.05, 0.05] } },
      { name: 'right', shape: { kind: 'quad', q: [MT_X, 0, MT_BACK], e1: [0, 0, MT_DEPTH], e2: [0, MT_TOP, 0] }, material: { kind: 'lambert', albedo: [0.12, 0.45, 0.15] } },
      // Ghosted for the three.js view, a real wall to the renderer.
      { name: 'front', shape: { kind: 'quad', q: [-MT_X, 0, MT_FRONT], e1: [0, MT_TOP, 0], e2: [2 * MT_X, 0, 0] }, material: MT_WHITE, display: { ghost: true } },
      // 1.6 square rather than 0.8: four times the area, so shadows soften,
      // both tracers converge faster, and the room is ~40% brighter (measured
      // mean 0.42 against 0.30). Radiance drops from 14 to 3.6 to pay for it —
      // and again for the floated sphere, which stopped shadowing the floor
      // directly beneath it and lifted the whole room by about a third.
      { name: 'light', shape: { kind: 'quad', q: [-0.8, MT_TOP - 0.002, -0.8], e1: [1.6, 0, 0], e2: [0, 0, 1.6] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [3.6, 3.6, 3.6] } },
      {
        name: 'testObject',
        shape: { kind: 'sphere', center: MT_BALL.center, radius: MT_BALL.radius },
        material,
      },
    ],
  };
}

// The light-field talk's room (~/Code/light-field, src/scene/scene.ts
// `unwrapRoom`), scaled x2 so it fills cornell-short's cube: interior
// [-2,2] x [0,4] x [-2,2], front OPEN, so cornell-short's camera and the
// lens-camera constants fit it unchanged (Steve, 2026-10-30). Red left wall,
// green right, a white box standing on the floor (five faces, no bottom), a
// glossy gold ball. Walls, wall names and lamp colour are cornell-short's,
// so styleShortBox and the spectral bake treat it the same way; the box is
// the walls' white, as in the source room.
//
// The ball: light-field's glossy is GGX with alpha = 0.15 given directly;
// here the exposed roughness maps to alpha = roughness^2, so the same lobe
// is roughness sqrt(0.15) = 0.387.
//
// The lamp is light-field's 0.9 x 0.9, so 1.8 x 1.8 here, at cornell-short's
// TOTAL POWER (Phi = pi L A): CORNELL's 0.5^2 radiance times (0.5/1.8)^2.
const LF = 2; // the scale from the light-field room
const LF_LAMP_SIDE = 0.9 * LF;
const lfScale = (v: readonly number[]): [number, number, number] => [v[0]! * LF, v[1]! * LF, v[2]! * LF];
const shortWall = (name: string) => CORNELL_SHORT.primitives.find((p) => p.name === name)!;
/**
 * light-field's boxQuads: five faces of a y-rotated box standing on the
 * floor (no bottom), outward normals (e1 x e2), in its unscaled units.
 */
function lfBoxFaces(cx: number, cz: number, halfX: number, halfZ: number, height: number, angle: number) {
  const X = [Math.cos(angle), 0, -Math.sin(angle)];
  const Z = [Math.sin(angle), 0, Math.cos(angle)];
  const corner = (sx: number, y: number, sz: number) =>
    [0, 1, 2].map((i) => [cx, y, cz][i]! + X[i]! * sx * halfX + Z[i]! * sz * halfZ);
  const uX = X.map((c) => c * 2 * halfX);
  const uZ = Z.map((c) => c * 2 * halfZ);
  const uY = [0, height, 0];
  return [
    { name: 'box-top', q: corner(-1, height, -1), e1: uZ, e2: uX },
    { name: 'box-px', q: corner(+1, 0, -1), e1: uY, e2: uZ },
    { name: 'box-nx', q: corner(-1, 0, -1), e1: uZ, e2: uY },
    { name: 'box-pz', q: corner(-1, 0, +1), e1: uX, e2: uY },
    { name: 'box-nz', q: corner(-1, 0, -1), e1: uY, e2: uX },
  ];
}
const CORNELL_LAMP_PRIM = CORNELL.primitives.find((p) => p.name === 'light')!;
const LF_ROOM: SceneDescription = {
  camera: CORNELL_SHORT.camera,
  primitives: [
    ...['floor', 'ceiling', 'back', 'left', 'right'].map(shortWall),
    {
      ...CORNELL_LAMP_PRIM,
      shape: { kind: 'quad', q: [-LF_LAMP_SIDE / 2, 3.998, -LF_LAMP_SIDE / 2], e1: [LF_LAMP_SIDE, 0, 0], e2: [0, 0, LF_LAMP_SIDE] },
      emission: {
        ...CORNELL_LAMP_PRIM.emission!,
        radiance: CORNELL_LAMP_PRIM.emission!.radiance.map((c) => c * (0.5 / LF_LAMP_SIDE) ** 2) as [number, number, number],
      },
    },
    ...lfBoxFaces(0.42, -0.1, 0.34, 0.34, 0.68, 0.35).map((f) => ({
      name: f.name,
      shape: { kind: 'quad' as const, q: lfScale(f.q), e1: lfScale(f.e1), e2: lfScale(f.e2) },
      material: shortWall('back').material,
    })),
    {
      name: 'goldBall',
      shape: { kind: 'sphere', center: lfScale([-0.42, 0.36, 0.15]), radius: 0.36 * LF },
      material: { kind: 'conductor', f0: [0.9, 0.78, 0.5], roughness: Math.sqrt(0.15) },
    },
  ],
};

// The talk's 1980s room (Steve, 2026-11-03: "a scene that has all the
// classic 1980s computer science components"; a box room, and we are in
// it): a closed room 6 wide, 4 high, 6 deep, with cornell-short's walls and
// lamp, a checkerboard floor (8 x 8 tiles of 0.75), and three balls: matte
// white at the back left, the blue mirror at the back right, clear glass at
// the front. The camera stands inside, near the front wall, at eye height.
// Rendered by Whitted's tracer (whitted-room), and the path tracer can
// render the same room. Two tile colourings to choose between: cream and
// charcoal, or Whitted's own red and yellow (`-classic`).
const ROOM_HALF = 3;
const ROOM_TOP = 4;
const TILES = 8;
type Tint = readonly [number, number, number];
function whittedRoom(tileA: Tint, tileB: Tint): SceneDescription {
  const wall = (name: string) => CORNELL_SHORT.primitives.find((p) => p.name === name)!.material;
  const H = ROOM_HALF;
  const s = (2 * H) / TILES;
  const tiles = Array.from({ length: TILES * TILES }, (_, k) => {
    const i = k % TILES;
    const j = Math.floor(k / TILES);
    return {
      name: `tile-${i}-${j}`,
      shape: { kind: 'quad' as const, q: [-H + i * s, 0, -H + j * s] as [number, number, number], e1: [0, 0, s] as [number, number, number], e2: [s, 0, 0] as [number, number, number] },
      material: { kind: 'lambert' as const, albedo: (i + j) % 2 ? tileB : tileA },
    };
  });
  return {
    camera: { eye: [0, 1.7, 2.7], lookAt: [0, 0.8, -1], up: [0, 1, 0], fovDegrees: 50 },
    primitives: [
      ...tiles,
      // Edge order sets each wall's normal (e1 x e2) into the room.
      { name: 'ceiling', shape: { kind: 'quad', q: [-H, ROOM_TOP, -H], e1: [2 * H, 0, 0], e2: [0, 0, 2 * H] }, material: wall('ceiling') },
      { name: 'back', shape: { kind: 'quad', q: [-H, 0, -H], e1: [2 * H, 0, 0], e2: [0, ROOM_TOP, 0] }, material: wall('back') },
      { name: 'front', shape: { kind: 'quad', q: [-H, 0, H], e1: [0, ROOM_TOP, 0], e2: [2 * H, 0, 0] }, material: wall('back') },
      { name: 'left', shape: { kind: 'quad', q: [-H, 0, -H], e1: [0, ROOM_TOP, 0], e2: [0, 0, 2 * H] }, material: wall('left') },
      { name: 'right', shape: { kind: 'quad', q: [H, 0, -H], e1: [0, 0, 2 * H], e2: [0, ROOM_TOP, 0] }, material: wall('right') },
      CORNELL_SHORT.primitives.find((p) => p.name === 'light')!,
      { name: 'ball', shape: { kind: 'sphere', center: [-1.4, 0.8, -1.4], radius: 0.8 }, material: wall('ball') },
      { name: 'mirrorBall', shape: { kind: 'sphere', center: [1.3, 0.7, -1.2], radius: 0.7 }, material: { kind: 'mirror', f0: [0.35, 0.45, 0.8] } },
      { name: 'glassBall', shape: { kind: 'sphere', center: [0.1, 0.6, 0.3], radius: 0.6 }, material: { kind: 'dielectric', ior: 1.5 } },
    ],
  };
}
const WHITTED_ROOM = whittedRoom([0.7592, 0.7257, 0.6863], [0.09, 0.09, 0.1]);
const WHITTED_ROOM_CLASSIC = whittedRoom([0.85, 0.72, 0.12], [0.7, 0.08, 0.05]);

export const SCENES = {
  cornell: CORNELL,
  'cornell-short': CORNELL_SHORT,
  'lf-room': LF_ROOM,
  'cornell-glass': CORNELL_GLASS,
  'cornell-caustic': CORNELL_CAUSTIC,
  'cornell-delta': CORNELL_DELTA,
  'caustic-ring': CAUSTIC_RING,
  'cornell-lamp': CORNELL_LAMP,
  chandelier: CHANDELIER,
  'door-ajar': doorAjarScene(),
  'open-stage': OPEN_STAGE,
  'material-row': MATERIAL_ROW,
  'whitted-room': WHITTED_ROOM,
  'whitted-room-classic': WHITTED_ROOM_CLASSIC,
  'material-test': materialTestScene({ kind: 'conductor', f0: [1.0, 0.77, 0.34], roughness: 0.25 }),
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

/**
 * The same scene with every emissive quad shrunk about its own centre, at
 * CONSTANT total emitted power.
 *
 * A Lambertian emitter radiates power proportional to L·A, so holding the
 * product fixed means radiance scales as 1/area — halve the side, quadruple
 * the radiance. Without that compensation shrinking the lamp just dims the
 * room, and a figure about the lamp's SIZE turns into a figure about
 * exposure.
 *
 * Measured on `cornell` (24², pt-nee, 256 spp, 2026-08-05): mean image
 * luminance 0.39668 / 0.40054 / 0.39916 / 0.39807 at shrink 1 / 2 / 4 / 8 —
 * flat to within 1% across a 64x change in area. Uncompensated, the same
 * series falls 0.39668 -> 0.00622, i.e. exactly the area ratio.
 *
 * What DOES change is how findable the lamp is. Plain PT's chance of
 * stumbling onto it falls with area: 9.20% / 2.53% / 0.73% / 0.15% over the
 * same series, a 60x collapse — which is the whole content of "most paths
 * report nothing".
 */
export function withLampShrunk(desc: SceneDescription, shrink: number): SceneDescription {
  if (shrink === 1) return desc;
  const k = shrink * shrink; // area fell by this, so radiance rises by it
  return {
    ...desc,
    primitives: desc.primitives.map((p) => {
      if (!p.emission || p.shape.kind !== 'quad') return p;
      const { q, e1, e2 } = p.shape;
      const centre = [
        q[0] + (e1[0] + e2[0]) / 2,
        q[1] + (e1[1] + e2[1]) / 2,
        q[2] + (e1[2] + e2[2]) / 2,
      ] as const;
      const s = 1 / shrink;
      const ne1 = [e1[0] * s, e1[1] * s, e1[2] * s] as [number, number, number];
      const ne2 = [e2[0] * s, e2[1] * s, e2[2] * s] as [number, number, number];
      return {
        ...p,
        shape: {
          kind: 'quad',
          q: [
            centre[0] - ne1[0] / 2 - ne2[0] / 2,
            centre[1] - ne1[1] / 2 - ne2[1] / 2,
            centre[2] - ne1[2] / 2 - ne2[2] / 2,
          ] as [number, number, number],
          e1: ne1,
          e2: ne2,
        },
        emission: {
          radiance: [
            p.emission.radiance[0] * k,
            p.emission.radiance[1] * k,
            p.emission.radiance[2] * k,
          ] as [number, number, number],
        },
      };
    }),
  };
}

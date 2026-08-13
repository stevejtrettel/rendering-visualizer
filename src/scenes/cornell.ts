// The shared Cornell box scene, ELONGATED: interior [-2,2] x [0,4] x [-2,11],
// fully closed, with the CPU camera INSIDE the box at z = 9.5 — floating in
// open space so the visualizer shows exactly where every path begins, with
// clear room in FRONT of the pinhole reserved for the virtual image-plane
// visualization (floating pixels that color as paths accumulate). The scene
// proper (spheres, light) lives in the front half; the space behind the
// camera is just closed white room. The front wall carries the `ghost`
// display hint: real Lambert wall to the renderer, see-through glass in
// three.js. Edge order fixes each quad's normal (e1 x e2) pointing INTO
// the room.
import type { SceneDescription } from '../core/scene/scene';

// A good exterior vantage for the three.js panes, looking in through the
// ghosted front wall — camera pinhole and scene both in frame.
// Mostly head-on: a deep box is only visible through its ghosted front
// wall, so the vantage keeps the view axis close to the box axis.
export const VIZ_VIEW = {
  eye: [2.4, 4.4, 17] as const,
  target: [0, 1.8, 1] as const,
};

// STANDARDISED for the talk's recordings (Steve, 2026-08-05), tuned live in
// demos/cornell-tune and baked here. Three changes from the neutral original:
//
//   walls   warmth 0.20 toward amber (1.0, 0.78, 0.52)
//   lamp    warmth 0.35 toward the same amber
//   ballBlue  lambert -> conductor, roughness 0.3
//
// Both warmth values are applied at CONSTANT LUMINANCE — the tint is a
// per-channel scale renormalised so the grey's luminance is unchanged — so
// the room is exactly as bright as it was and only its colour moved. That is
// why the wall albedo reads 0.7592 rather than 0.73: the red channel had to
// rise to hold luminance while the blue fell.
//
// LIGHT SIZE (Steve, 2026-08-05): the ceiling quad is 0.5 x 0.5, down from
// 1.6 x 1.6, at CONSTANT TOTAL POWER. A Lambertian emitter radiates
// Phi = pi * L * A, so area 2.56 -> 0.25 buys the radiance a factor of
// 10.24 and the room keeps the same overall brightness. What DOES change is
// the character: a source this small casts hard-edged shadows, and it is
// much harder for a naive path to hit by chance — which is the point, since
// it widens the naive-vs-NEE gap the convergence figures are about.
//
// The glossy ball is not only a look. cornell was all-Lambert, where uniform
// versus BSDF direction sampling costs about 1.06x; on a glossy surface it is
// nearer 1.9x. So the naive-vs-standard figures (lamp-grid, convergence with
// pt-naive) now bite on the STANDARD scene instead of needing material-test.
// Roughness 0.3 is deliberately well clear of a delta lobe: a near-mirror
// would be passed straight through by UniformSamplingBxDF and would start
// pulling SMS into figures that are not about it.
export const CORNELL: SceneDescription = {
  camera: { eye: [0, 2, 9.5], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor',   shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 0, 13], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.7592, 0.7257, 0.6863] } },
    { name: 'ceiling', shape: { kind: 'quad', q: [-2, 4, -2], e1: [4, 0, 0], e2: [0, 0, 13] }, material: { kind: 'lambert', albedo: [0.7592, 0.7257, 0.6863] } },
    { name: 'back',    shape: { kind: 'quad', q: [-2, 0, -2], e1: [4, 0, 0], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.7592, 0.7257, 0.6863] } },
    { name: 'left',    shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 4, 0], e2: [0, 0, 13] }, material: { kind: 'lambert', albedo: [0.65, 0.05, 0.05] } },
    { name: 'right',   shape: { kind: 'quad', q: [2, 0, -2],  e1: [0, 0, 13], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.12, 0.45, 0.15] } },
    { name: 'front',   shape: { kind: 'quad', q: [-2, 0, 11], e1: [0, 4, 0], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.7592, 0.7257, 0.6863] }, display: { ghost: true } },
    { name: 'light',   shape: { kind: 'quad', q: [-0.25, 3.998, -0.25], e1: [0.5, 0, 0], e2: [0, 0, 0.5] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [153.6881, 141.8537, 127.8679] } },
    { name: 'ball',    shape: { kind: 'sphere', center: [-0.9, 0.8, -0.6], radius: 0.8 }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ballBlue', shape: { kind: 'sphere', center: [0.9, 0.55, 0.6], radius: 0.55 }, material: { kind: 'conductor', f0: [0.35, 0.45, 0.8], roughness: 0.3 } },
  ],
};

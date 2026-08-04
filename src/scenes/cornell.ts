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

export const CORNELL: SceneDescription = {
  camera: { eye: [0, 2, 9.5], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor',   shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 0, 13], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ceiling', shape: { kind: 'quad', q: [-2, 4, -2], e1: [4, 0, 0], e2: [0, 0, 13] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'back',    shape: { kind: 'quad', q: [-2, 0, -2], e1: [4, 0, 0], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'left',    shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 4, 0], e2: [0, 0, 13] }, material: { kind: 'lambert', albedo: [0.65, 0.05, 0.05] } },
    { name: 'right',   shape: { kind: 'quad', q: [2, 0, -2],  e1: [0, 0, 13], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.12, 0.45, 0.15] } },
    { name: 'front',   shape: { kind: 'quad', q: [-2, 0, 11], e1: [0, 4, 0], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] }, display: { ghost: true } },
    { name: 'light',   shape: { kind: 'quad', q: [-0.8, 3.998, -0.8], e1: [1.6, 0, 0], e2: [0, 0, 1.6] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [14, 14, 14] } },
    { name: 'ball',    shape: { kind: 'sphere', center: [-0.9, 0.8, -0.6], radius: 0.8 }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ballBlue', shape: { kind: 'sphere', center: [0.9, 0.55, 0.6], radius: 0.55 }, material: { kind: 'lambert', albedo: [0.35, 0.45, 0.8] } },
  ],
};

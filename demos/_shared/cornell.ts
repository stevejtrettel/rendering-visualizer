// The shared Cornell box scene: interior [-2,2] x [0,4] x [-2,2], fully
// CLOSED — the CPU camera sits just inside the front wall (classic Cornell
// framing) so no path can escape. The front wall is a real Lambert wall to
// the renderer but carries the `ghost` display hint, so the three.js
// visualizer draws it as see-through glass. Edge order fixes each quad's
// normal (e1 x e2) pointing INTO the room.
import type { SceneDescription } from '../../src/core/scene/scene';

// A good exterior vantage for the three.js panes, looking in through the
// ghosted front wall.
export const VIZ_VIEW = {
  eye: [3.8, 3.6, 8.2] as const,
  target: [0, 2, 0] as const,
};

export const CORNELL: SceneDescription = {
  camera: { eye: [0, 2, 1.88], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 65 },
  primitives: [
    { name: 'floor',   shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 0, 4], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ceiling', shape: { kind: 'quad', q: [-2, 4, -2], e1: [4, 0, 0], e2: [0, 0, 4] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'back',    shape: { kind: 'quad', q: [-2, 0, -2], e1: [4, 0, 0], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'left',    shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 4, 0], e2: [0, 0, 4] }, material: { kind: 'lambert', albedo: [0.65, 0.05, 0.05] } },
    { name: 'right',   shape: { kind: 'quad', q: [2, 0, -2],  e1: [0, 0, 4], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.12, 0.45, 0.15] } },
    { name: 'front',   shape: { kind: 'quad', q: [-2, 0, 2],  e1: [0, 4, 0], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] }, display: { ghost: true } },
    { name: 'light',   shape: { kind: 'quad', q: [-0.8, 3.998, -0.8], e1: [1.6, 0, 0], e2: [0, 0, 1.6] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [14, 14, 14] } },
    { name: 'ball',    shape: { kind: 'sphere', center: [-0.9, 0.8, -0.6], radius: 0.8 }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ballBlue', shape: { kind: 'sphere', center: [0.9, 0.55, 0.6], radius: 0.55 }, material: { kind: 'lambert', albedo: [0.35, 0.45, 0.8] } },
  ],
};

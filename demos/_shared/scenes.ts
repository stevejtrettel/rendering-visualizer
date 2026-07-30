// The scene registry: named scene descriptions a demo picks ONE of, as a
// constant. `cornell` stays the pedagogically clean Lambert default;
// `cornell-glass` swaps the spheres for a glass ball (the caustic-maker) and
// a gold GGX ball. New scenes are new entries here.
//
// Each scene also needs a three.js vantage for the trajectory demos —
// `vizViewFor(name)` resolves it.
import type { SceneDescription } from '../../src/core/scene/scene';
import { CORNELL } from './cornell';
import { parseOBJ } from '../../src/io/obj';
import teapotUrl from './models/teapot.obj?url';

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
const OPEN_STAGE_VIEW = { eye: [7.5, 5.5, 13] as const, target: [0, 1.2, 0] as const };

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

export const SCENES = {
  cornell: CORNELL,
  'cornell-glass': CORNELL_GLASS,
  'cornell-lamp': CORNELL_LAMP,
  'open-stage': OPEN_STAGE,
  'material-row': MATERIAL_ROW,
} satisfies Record<string, SceneDescription>;

export type SceneName = keyof typeof SCENES;

// The three.js vantage for a scene. The Cornell box is deep and only visible
// through its ghosted front wall, so the view axis stays close to the box axis
// — a near-head-on eye with a small offset for depth cues. It sits close
// enough that the box's near walls fall outside the frame: these pages are
// about the PATHS, which have to be big enough to read, and `VIZ_VIEW` (tuned
// for the older wide panes) leaves them a few pixels long.
// Dead-centre in x so both side walls frame symmetrically, and low enough to
// look UP at the ceiling — the emitter is flush with the ceiling, so an eye at
// ceiling height hides the very thing a path ends on.
const CORNELL_VIEW = { eye: [0, 2.8, 15.5] as const, target: [0, 1.5, 1.0] as const };

export function vizViewFor(name: string): { eye: readonly [number, number, number]; target: readonly [number, number, number] } {
  if (name === 'open-stage') return OPEN_STAGE_VIEW;
  if (name === 'material-row') return { eye: [4.5, 3.2, 11] as const, target: [0, 0.8, 0] as const };
  return CORNELL_VIEW;
}

// Rescale so the largest extent is `size`, sit on the floor (min y = 0),
// and center x/z at (cx, cz). Mutates in place.
function fitMesh(positions: Float32Array, size: number, cx: number, cz: number): void {
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    mnx = Math.min(mnx, positions[i]!); mxx = Math.max(mxx, positions[i]!);
    mny = Math.min(mny, positions[i + 1]!); mxy = Math.max(mxy, positions[i + 1]!);
    mnz = Math.min(mnz, positions[i + 2]!); mxz = Math.max(mxz, positions[i + 2]!);
  }
  const s = size / Math.max(mxx - mnx, mxy - mny, mxz - mnz);
  const midX = (mnx + mxx) / 2, midZ = (mnz + mxz) / 2;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (positions[i]! - midX) * s + cx;
    positions[i + 1] = (positions[i + 1]! - mny) * s;
    positions[i + 2] = (positions[i + 2]! - midZ) * s + cz;
  }
}

// The full registry, including scenes that need fetched assets. Demos
// `await` this at startup (top-level await) and use the result everywhere.
export async function loadSceneRegistry(): Promise<Record<string, SceneDescription>> {
  const text = await (await fetch(teapotUrl)).text();
  const teapot = parseOBJ(text);
  fitMesh(teapot.positions, 1.8, 0.15, 0.1);

  const cornellTeapot: SceneDescription = {
    camera: CORNELL.camera,
    primitives: [
      ...CORNELL.primitives.filter((p) => p.name !== 'ball' && p.name !== 'ballBlue'),
      {
        name: 'teapot',
        shape: { kind: 'mesh', positions: teapot.positions, normals: teapot.normals, indices: teapot.indices },
        material: { kind: 'conductor', f0: [1.0, 0.77, 0.34], roughness: 0.2 },
      },
      {
        name: 'glassBall',
        shape: { kind: 'sphere', center: [-1.15, 0.55, 0.75], radius: 0.55 },
        material: { kind: 'dielectric', ior: 1.5 },
      },
    ],
  };

  return { ...SCENES, 'cornell-teapot': cornellTeapot };
}

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

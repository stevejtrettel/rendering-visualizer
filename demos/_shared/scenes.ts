// The scene registry: named scene descriptions selectable from every demo.
// `cornell` stays the pedagogically clean Lambert default; `cornell-glass`
// swaps the spheres for a glass ball (the caustic-maker) and a gold GGX
// ball. New scenes are new entries here — instantly available everywhere.
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

export const SCENES: Record<string, SceneDescription> = {
  cornell: CORNELL,
  'cornell-glass': CORNELL_GLASS,
};

export type SceneName = keyof typeof SCENES;

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

export function emissiveNames(desc: SceneDescription): Set<string> {
  return new Set(
    desc.primitives.filter((p) => p.emission).map((p, i) => p.name ?? `primitive-${i}`),
  );
}

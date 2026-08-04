// The scenes that need a fetched asset, split out from ./registry.ts so
// that the registry itself stays free of bundler-only syntax (the `?url`
// import below) and remains importable from plain Node — which is what
// `tests/` and any offline render need.
//
// Demos `await loadSceneRegistry()` at startup (top-level await) and use
// the result everywhere; a page that needs no mesh can import SCENES
// synchronously instead.
import type { SceneDescription } from '../core/scene/scene';
import { parseOBJ } from '../io/obj';
import { CORNELL } from './cornell';
import { SCENES } from './registry';
import teapotUrl from './models/teapot.obj?url';

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

// The full registry, including scenes that need fetched assets.
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

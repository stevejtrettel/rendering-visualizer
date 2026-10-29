// Dressing for figures that follow paths through cornell-short (one-path,
// one-sample): the lamp outlined so nobody has to guess where the light is,
// and the near side wall drawn translucent so paths behind it stay visible.
import * as THREE from 'three';
import type { SceneDescription } from '../core/scene/scene';
import { polyline } from './lines';
import { C } from './style';

/** The scene's quad lamp, outlined just below the ceiling. */
export function lampOutline(desc: SceneDescription, width = 4): ReturnType<typeof polyline> {
  const lamp = desc.primitives.find((p) => p.emission);
  if (!lamp || lamp.shape.kind !== 'quad') throw new Error('lampOutline expects a quad lamp');
  const { q, e1, e2 } = lamp.shape;
  const o = new THREE.Vector3(q[0], q[1] - 0.01, q[2]);
  const a = new THREE.Vector3(...e1);
  const b = new THREE.Vector3(...e2);
  return polyline([o, o.clone().add(a), o.clone().add(a).add(b), o.clone().add(b), o], { color: C.ochre, width });
}

/** The lamp's radiance, and that radiance relative to its brightest channel. */
export function lampColor(desc: SceneDescription): { Le: THREE.Color; relative: THREE.Color } {
  const lamp = desc.primitives.find((p) => p.emission)!;
  const Le = new THREE.Color(...lamp.emission!.radiance);
  const m = Math.max(Le.r, Le.g, Le.b);
  return { Le, relative: new THREE.Color(Le.r / m, Le.g / m, Le.b / m) };
}

/**
 * Draw one primitive's mesh translucent, keeping its colour. sceneToThree
 * adds one mesh per primitive, in order, which is how the mesh is found.
 */
export function translucent(sceneGroup: THREE.Group, desc: SceneDescription, name: string, opacity = 0.3): void {
  const i = desc.primitives.findIndex((p) => p.name === name);
  const mat = (sceneGroup.children[i] as THREE.Mesh).material as THREE.MeshStandardMaterial;
  mat.transparent = true;
  mat.opacity = opacity;
  mat.depthWrite = false;
}

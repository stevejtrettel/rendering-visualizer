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

/**
 * The look of the short box on every slide of the talk sequence
 * (scene-and-screen, rasterize, one-path, one-sample, many-samples), so the
 * 3D scene reads the same everywhere (Steve, 2026-10-29: one coherent,
 * nicely shaded scene, uniform across all):
 *
 *   - the lamp's light casts soft shadows, so the balls sit on the floor;
 *   - a low warm fill keeps walls in shadow in their own colour;
 *   - the blue ball, a rough metal to the path tracer, reflects the box
 *     itself: the box is captured once from the ball's centre (everything
 *     but the box hidden) and used as its environment, instead of the
 *     nothing it reflected before, which rendered it near black;
 *   - the near green wall is translucent, so paths behind it stay visible.
 *
 * A raster preview, not the light transport: the physically right image is
 * the CPU render. Call once the stage and the box group exist; it renders
 * the reflection capture straight away.
 */
export function styleShortBox(
  renderer: THREE.WebGLRenderer,
  world: THREE.Scene,
  sceneGroup: THREE.Group,
  desc: SceneDescription,
): void {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  for (const o of [...sceneGroup.children]) {
    if (o instanceof THREE.AmbientLight) {
      o.color.set(0xfff1e0);
      o.intensity = 0.45;
    }
    if (o instanceof THREE.PointLight) {
      o.intensity = 26;
      o.castShadow = true;
      o.shadow.mapSize.set(1024, 1024);
      o.shadow.radius = 6;
      o.shadow.bias = -0.002;
      o.shadow.camera.near = 0.05;
    }
  }
  desc.primitives.forEach((p, i) => {
    const mesh = sceneGroup.children[i] as THREE.Mesh;
    mesh.receiveShadow = !p.emission;
    mesh.castShadow = p.shape.kind === 'sphere';
  });
  translucent(sceneGroup, desc, 'right', 0.35);

  // The metal ball's reflection: the box seen from the ball's centre.
  desc.primitives.forEach((p, i) => {
    if (p.shape.kind !== 'sphere' || (p.material.kind !== 'conductor' && p.material.kind !== 'mirror')) return;
    const mesh = sceneGroup.children[i] as THREE.Mesh;
    const target = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const cube = new THREE.CubeCamera(0.05, 50, target);
    cube.position.set(...p.shape.center);
    const hidden = world.children.filter((o) => o !== sceneGroup && o.visible);
    for (const o of hidden) o.visible = false;
    mesh.visible = false;
    world.add(cube);
    cube.update(renderer, world);
    world.remove(cube);
    mesh.visible = true;
    for (const o of hidden) o.visible = true;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.envMap = target.texture;
    mat.envMapIntensity = 1.2;
    mat.needsUpdate = true;
  });
}

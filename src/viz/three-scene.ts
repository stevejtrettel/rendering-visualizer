// SceneDescription -> three.js objects. Built from the same declarative
// description the CPU renderer consumes, so the two views cannot drift.
import * as THREE from 'three';
import type { PrimitiveDescription, SceneDescription } from '../core/scene/scene';

// Approximate raster portrayal of each CPU material. The physically
// correct image is always the CPU render; this keeps the preview legible.
function materialFor(desc: PrimitiveDescription): THREE.Material {
  const m = desc.material;
  switch (m.kind) {
    case 'dielectric':
      return new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        transmission: 1,
        ior: m.ior,
        roughness: 0.02,
        side: THREE.DoubleSide,
      });
    case 'mirror':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(...m.f0),
        metalness: 1,
        roughness: 0.03,
      });
    case 'conductor':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(...m.f0),
        metalness: 1,
        roughness: m.roughness,
      });
    case 'lambert':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(...m.albedo),
        roughness: 1,
        side: THREE.DoubleSide,
        ...(desc.emission
          ? {
              emissive: new THREE.Color(...desc.emission.radiance).multiplyScalar(1 / Math.max(...desc.emission.radiance)),
              emissiveIntensity: 1.5,
            }
          : {}),
      });
  }
}

function primitiveMesh(desc: PrimitiveDescription): THREE.Mesh {
  // Ghost primitives (display hint): real geometry for the CPU renderer,
  // drawn here as barely-there glass so we can see into closed scenes.
  const material = desc.display?.ghost
    ? new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.08,
        roughness: 0.15,
        metalness: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    : materialFor(desc);
  return shapeMesh(desc, material);
}

function shapeMesh(desc: PrimitiveDescription, material: THREE.Material): THREE.Mesh {
  if (desc.shape.kind === 'sphere') {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(desc.shape.radius, 48, 24), material);
    mesh.position.set(...desc.shape.center);
    return mesh;
  }

  if (desc.shape.kind === 'mesh') {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(desc.shape.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(desc.shape.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(desc.shape.indices, 1));
    return new THREE.Mesh(geometry, material);
  }

  // Quad q + u*e1 + v*e2 as a two-triangle BufferGeometry.
  const [qx, qy, qz] = desc.shape.q;
  const [ax, ay, az] = desc.shape.e1;
  const [bx, by, bz] = desc.shape.e2;
  const corners = [
    [qx, qy, qz],
    [qx + ax, qy + ay, qz + az],
    [qx + ax + bx, qy + ay + by, qz + az + bz],
    [qx + bx, qy + by, qz + bz],
  ].flat();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

// Physically-lit variant for `three-gpu-pathtracer` beauty renders (tier 3
// of docs/design-viz.md): emitters carry their TRUE radiance, there are no
// helper lights, and ghost primitives are skipped entirely — a ghosted wall
// is a window for the raster preview but would seal the box against an
// exterior path-traced eye.
function beautyMaterialFor(desc: PrimitiveDescription, emitterScale = 1): THREE.Material {
  if (desc.emission) {
    const peak = Math.max(...desc.emission.radiance);
    return new THREE.MeshStandardMaterial({
      color: desc.material.kind === 'lambert' ? new THREE.Color(...desc.material.albedo) : new THREE.Color(0x000000),
      emissive: new THREE.Color(...desc.emission.radiance).multiplyScalar(1 / peak),
      emissiveIntensity: peak * emitterScale,
      side: THREE.DoubleSide,
    });
  }
  const m = desc.material;
  switch (m.kind) {
    case 'dielectric':
      return new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        transmission: 1,
        ior: m.ior,
        roughness: 0,
        side: THREE.DoubleSide,
      });
    case 'mirror':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(...m.f0),
        metalness: 1,
        roughness: 0.01,
      });
    case 'conductor':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(...m.f0),
        metalness: 1,
        roughness: m.roughness,
      });
    case 'lambert':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(...m.albedo),
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide,
      });
  }
}

export interface BeautyOptions {
  // Scale on every emitter's brightness: 1 reproduces the CPU renderer's
  // radiance. A demo lighting the scene some other way (light-path-beauty's
  // glowing path) turns the scene's own lamp down with this.
  emitterScale?: number;
  // Scale for the visible lamp FACE's emission (defaults to emitterScale).
  // The face exists only so camera rays see a lamp; its emission is
  // unsampled (no NEE for emissive meshes), so a page running the lamp at
  // full radiance should keep the face well below emitterScale or the
  // face alone re-creates the slow-convergence problem the RectAreaLight
  // solves.
  faceEmissiveScale?: number;
}

export function sceneToBeautyThree(desc: SceneDescription, opts: BeautyOptions = {}): THREE.Group {
  const emitterScale = opts.emitterScale ?? 1;
  const faceEmissiveScale = opts.faceEmissiveScale ?? emitterScale;
  const group = new THREE.Group();
  for (const p of desc.primitives) {
    if (p.display?.ghost) continue;
    if (p.emission && p.shape.kind === 'quad') {
      // three-gpu-pathtracer has NO next-event estimation for emissive
      // meshes — its direct-light sampling covers only registered THREE
      // lights and the environment map — so an emissive quad converges by
      // blind BSDF hits alone. A RectAreaLight IS sampled, and its forward
      // hits are MIS-weighted; its sampler reads emission = color *
      // intensity, i.e. intensity is radiance, so `peak * emitterScale`
      // reproduces the CPU emitter exactly at scale 1. Camera-primary rays
      // skip light surfaces (upstream TODO), so an EMISSIVE quad sits a hair
      // behind the light as the visible lamp face. (A diffuse face would
      // stay black: it is on the light's back side, where the sampler
      // rejects it.) The face re-emits energy the RectAreaLight already
      // provides to BSDF-found paths — a knowing ~2× on the lamp, dwarfed
      // at the dim scales this is used at; revisit before a faithful
      // emitterScale-1 beauty page relies on it.
      const e1 = new THREE.Vector3(...p.shape.e1);
      const e2 = new THREE.Vector3(...p.shape.e2);
      const n = new THREE.Vector3().crossVectors(e1, e2).normalize();
      const center = new THREE.Vector3(...p.shape.q).addScaledVector(e1, 0.5).addScaledVector(e2, 0.5);
      const peak = Math.max(...p.emission.radiance);
      const light = new THREE.RectAreaLight(
        new THREE.Color(...p.emission.radiance).multiplyScalar(1 / peak),
        peak * emitterScale,
        e1.length(),
        e2.length(),
      );
      // Basis (ê1, -ê2, -n̂): spans the same rectangle and points the
      // light's emitting local -z axis along n, into the room.
      light.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(e1.normalize(), e2.normalize().negate(), n.clone().negate()),
      );
      light.position.copy(center).addScaledVector(n, 0.002);
      group.add(light);
      group.add(shapeMesh(p, new THREE.MeshStandardMaterial({
        color: 0x111111,
        emissive: new THREE.Color(...p.emission.radiance).multiplyScalar(1 / peak),
        emissiveIntensity: peak * faceEmissiveScale,
        roughness: 1,
        side: THREE.DoubleSide,
      })));
      continue;
    }
    group.add(shapeMesh(p, beautyMaterialFor(p, emitterScale)));
  }
  return group;
}

export function sceneToThree(desc: SceneDescription): THREE.Group {
  const group = new THREE.Group();
  for (const p of desc.primitives) {
    group.add(primitiveMesh(p));
  }
  // Modest ambient + a point light near any emitter so the raster preview is
  // legible; the physically correct image is the CPU render on the left.
  group.add(new THREE.AmbientLight(0xffffff, 0.25));
  const emitter = desc.primitives.find((p) => p.emission);
  if (emitter && emitter.shape.kind === 'quad') {
    const [qx, qy, qz] = emitter.shape.q;
    const light = new THREE.PointLight(0xffffff, 30);
    light.position.set(
      qx + (emitter.shape.e1[0] + emitter.shape.e2[0]) / 2,
      qy + (emitter.shape.e1[1] + emitter.shape.e2[1]) / 2 - 0.2,
      qz + (emitter.shape.e1[2] + emitter.shape.e2[2]) / 2,
    );
    group.add(light);
  }
  return group;
}

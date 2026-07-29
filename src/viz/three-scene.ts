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

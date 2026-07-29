// PathRecord[] -> polylines. V0 keeps this deliberately plain (THREE.Line);
// tubes, throughput coloring, and animation come with the talk's figure work.
import * as THREE from 'three';
import type { PathRecord } from '../trace/records';

const HIT_COLOR = 0xffaa33; // path contributed light
const MISS_COLOR = 0x7788aa; // path found no emitter

export function pathsToThree(records: readonly PathRecord[]): THREE.Group {
  const group = new THREE.Group();
  for (const record of records) {
    if (record.vertices.length < 2) continue;
    const positions = record.vertices.flatMap((v) => v.p);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const contributed = record.contributions.some((c) => c.value.some((v) => v > 0));
    const material = new THREE.LineBasicMaterial({
      color: contributed ? HIT_COLOR : MISS_COLOR,
      transparent: true,
      opacity: contributed ? 0.95 : 0.45,
    });
    group.add(new THREE.Line(geometry, material));

    // Mark scattering vertices with small dots so bounce structure reads.
    const dotGeometry = new THREE.BufferGeometry();
    dotGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(record.vertices.slice(1).flatMap((v) => v.p), 3),
    );
    group.add(
      new THREE.Points(
        dotGeometry,
        new THREE.PointsMaterial({ color: contributed ? HIT_COLOR : MISS_COLOR, size: 0.05 }),
      ),
    );
  }
  return group;
}

export function disposeGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Line || obj instanceof THREE.Points || obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
  });
}

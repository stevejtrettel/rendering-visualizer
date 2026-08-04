// Paths drawn as tubes whose radius varies along their length.
//
// Thickness, unlike colour, is not available from the cheap line paths:
// WebGL's native lineWidth is 1 on essentially every platform, and Line2
// takes its width from the MATERIAL, so per-path thickness would mean one
// material per path anyway. Real geometry is the honest route, and it lets
// a single path taper as its throughput falls — you see where the energy
// went, not just how much came back.
//
// Built into ONE preallocated buffer that is rewritten in place, never
// reallocated: a swarm that swaps members every frame would otherwise spend
// its whole budget building and discarding CylinderGeometry objects. The
// ring topology is fixed, so only positions, normals and colours move, and
// the visible count is a draw range.
import * as THREE from 'three';
import type { Tuple3 } from '../trace/records';

export interface TubeSegment {
  from: Tuple3;
  to: Tuple3;
  /** Radii at each end, in world units — the taper. */
  radiusFrom: number;
  radiusTo: number;
  /** Linear RGB. A plain triple, not a THREE.Color: this is written for
   *  every segment of every frame, and allocating there is the one thing
   *  that stops a swarm swapping members at frame rate. */
  color: Tuple3;
}

/** A bead marking where a path stopped, so it does not simply end. */
export interface TubeEndpoint {
  p: Tuple3;
  radius: number;
  color: Tuple3;
}

export interface PathTubesOptions {
  /** Maximum segments ever drawn at once. Sizes the buffer. */
  capacity: number;
  /** Maximum terminal beads. Sizes the instanced sphere buffer. */
  endpointCapacity?: number;
  /** Sides per tube. 6 is plenty at these radii. */
  radialSegments?: number;
  opacity?: number;
}

export class PathTubes {
  readonly group = new THREE.Group();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly colors: Float32Array;
  private readonly capacity: number;
  private readonly ring: number;
  // Scratch, reused every segment — allocating here would defeat the point.
  private readonly dir = new THREE.Vector3();
  private readonly u = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private beads: THREE.InstancedMesh | null = null;
  private beadMaterial: THREE.MeshStandardMaterial | null = null;
  private readonly beadMatrix = new THREE.Matrix4();
  private readonly beadColor = new THREE.Color();

  constructor(
    private readonly parent: THREE.Object3D,
    options: PathTubesOptions,
  ) {
    this.capacity = Math.max(1, options.capacity);
    this.ring = options.radialSegments ?? 6;
    const opacity = options.opacity ?? 1;

    const verts = this.capacity * this.ring * 2; // two rings per segment
    this.positions = new Float32Array(verts * 3);
    this.normals = new Float32Array(verts * 3);
    this.colors = new Float32Array(verts * 3);

    // Topology never changes, so the index buffer is built once.
    const indices = new Uint32Array(this.capacity * this.ring * 6);
    for (let s = 0; s < this.capacity; s++) {
      const base = s * this.ring * 2;
      for (let j = 0; j < this.ring; j++) {
        const j2 = (j + 1) % this.ring;
        const a0 = base + j;
        const a1 = base + j2;
        const b0 = base + this.ring + j;
        const b1 = base + this.ring + j2;
        const o = (s * this.ring + j) * 6;
        indices[o] = a0; indices[o + 1] = b0; indices[o + 2] = a1;
        indices[o + 3] = a1; indices[o + 4] = b0; indices[o + 5] = b1;
      }
    }

    this.cos = new Float32Array(this.ring);
    this.sin = new Float32Array(this.ring);
    for (let j = 0; j < this.ring; j++) {
      const a = (2 * Math.PI * j) / this.ring;
      this.cos[j] = Math.cos(a);
      this.sin[j] = Math.sin(a);
    }

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      // Self-lit: these are light paths, and shading them by the scene's
      // rig would make a ray's brightness depend on where it happens to be.
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.55,
      roughness: 0.6,
      metalness: 0,
      transparent: opacity < 1,
      opacity,
    });

    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false; // the buffer is rewritten constantly
    this.group.add(mesh);

    // Terminal beads: one instanced sphere, so marking where every path
    // stopped costs a single draw call and a matrix write each.
    const beads = options.endpointCapacity ?? 0;
    if (beads > 0) {
      this.beadMaterial = new THREE.MeshStandardMaterial({
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0.5,
        roughness: 0.5,
        metalness: 0,
        transparent: opacity < 1,
        opacity,
      });
      this.beads = new THREE.InstancedMesh(
        new THREE.SphereGeometry(1, 8, 6),
        this.beadMaterial,
        beads,
      );
      this.beads.frustumCulled = false;
      this.beads.count = 0;
      this.beads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(this.beads);
    }

    parent.add(this.group);
  }

  /** Place the terminal beads. Pass an empty list to hide them. */
  setEndpoints(endpoints: readonly TubeEndpoint[]): void {
    if (!this.beads) return;
    const n = Math.min(endpoints.length, this.beads.instanceMatrix.count);
    for (let i = 0; i < n; i++) {
      const e = endpoints[i]!;
      this.beadMatrix.makeScale(e.radius, e.radius, e.radius);
      this.beadMatrix.setPosition(e.p[0], e.p[1], e.p[2]);
      this.beads.setMatrixAt(i, this.beadMatrix);
      this.beadColor.setRGB(e.color[0], e.color[1], e.color[2]);
      this.beads.setColorAt(i, this.beadColor);
    }
    this.beads.count = n;
    this.beads.instanceMatrix.needsUpdate = true;
    if (this.beads.instanceColor) this.beads.instanceColor.needsUpdate = true;
  }

  /** Replace the whole population. Cheap enough to call every frame. */
  set(segments: readonly TubeSegment[]): void {
    const R = this.ring;
    let used = 0;

    for (const s of segments) {
      if (used >= this.capacity) break;
      this.dir.set(s.to[0] - s.from[0], s.to[1] - s.from[1], s.to[2] - s.from[2]);
      const length = this.dir.length();
      if (length <= 1e-9) continue;
      this.dir.divideScalar(length);

      // Any basis perpendicular to the segment will do; pick a helper axis
      // that is not nearly parallel to it, or the cross product degenerates.
      if (Math.abs(this.dir.z) < 0.9) this.u.set(0, 0, 1);
      else this.u.set(1, 0, 0);
      this.u.crossVectors(this.dir, this.u).normalize();
      this.v.crossVectors(this.dir, this.u);

      const base = used * R * 2;
      for (let j = 0; j < R; j++) {
        const c = this.cos[j]!;
        const sn = this.sin[j]!;
        const nx = this.u.x * c + this.v.x * sn;
        const ny = this.u.y * c + this.v.y * sn;
        const nz = this.u.z * c + this.v.z * sn;

        for (const [ringIndex, radius, p] of [
          [0, s.radiusFrom, s.from],
          [1, s.radiusTo, s.to],
        ] as const) {
          const i = (base + ringIndex * R + j) * 3;
          this.positions[i] = p[0] + nx * radius;
          this.positions[i + 1] = p[1] + ny * radius;
          this.positions[i + 2] = p[2] + nz * radius;
          this.normals[i] = nx;
          this.normals[i + 1] = ny;
          this.normals[i + 2] = nz;
          this.colors[i] = s.color[0];
          this.colors[i + 1] = s.color[1];
          this.colors[i + 2] = s.color[2];
        }
      }
      used += 1;
    }

    this.geometry.setDrawRange(0, used * R * 6);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.parent.remove(this.group);
    this.geometry.dispose();
    this.material.dispose();
    this.beads?.geometry.dispose();
    this.beads?.dispose();
    this.beadMaterial?.dispose();
  }
}

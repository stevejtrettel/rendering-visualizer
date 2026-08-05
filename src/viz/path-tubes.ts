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

// Far enough outside any scene here that a stray triangle there cannot be
// seen, near enough that it costs the BVH nothing to bound.
const PARKED = 1e5;

// Vertex colours are RGBA, not RGB, and that is not cosmetic (2026-08-04).
//
// three-gpu-pathtracer SYNTHESISES an itemSize-4 white colour attribute for
// every geometry that lacks one (GeometryPreparationUtils), so in a merged
// scene everything else is 4. Its mergeGeometries has a branch meant to
// promote a 3-component attribute to 4, and that branch is broken upstream:
// it writes into the SOURCE attribute rather than the target and indexes it
// with the running merge offset, so the target rows for the mismatched
// geometry are never written at all and stay ZERO. Measured: at capacity
// 128 all 1536 tube vertices arrived in the traced scene with colour
// (0,0,0) — the whole ramp multiplied by black, leaving only the uniform
// emissive glow, while the raster preview (which reads this buffer
// directly) looked perfect. Matching itemSize 4 means that branch never
// runs. Alpha is always 1; three.js reads itemSize-4 vertex colours
// natively (`vertexAlphas`) and an alpha of 1 is a no-op there.
//
// It is also a latent coin-flip if left at 3: the generator sorts
// geometries by uuid, so on the runs where the tubes happen to sort FIRST
// the merged attribute becomes itemSize 3 and the SCENE breaks instead.
const COLOR_ITEMS = 4;

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
  /** Maximum terminal beads. Sizes the bead buffer. */
  endpointCapacity?: number;
  /** Sides per tube. 6 is plenty at these radii. */
  radialSegments?: number;
  opacity?: number;
  /** Surface roughness. Low keeps a crisp highlight down the tube. */
  roughness?: number;
  /** 0 is a dielectric like the walls, 1 is metal like the gold sphere. */
  metalness?: number;
  /**
   * A second specular layer. Reads as wet plastic, which is why it is off
   * by default — nothing else in these scenes has it, so tubes that do look
   * like they came from a different picture.
   */
  clearcoat?: number;
  /**
   * Colour of the self-illumination. WHITE desaturates whatever it lifts —
   * a white glow on a yellow tube reads as silver — so this defaults warm.
   */
  glowColor?: number;
  /**
   * Self-illumination, 0 to ~1. Matte tubes read correctly in a physical
   * render but can go dark in a dim room, and these are supposed to be
   * LIGHT paths. A little emission lifts them.
   *
   * Uniform, not per-tube: three.js has no per-vertex emissive, so this
   * raises every tube equally and throughput still reads through albedo.
   * Keep it low — besides flattening the shading, a path tracer does not
   * importance-sample emissive meshes, so bright tubes become many
   * unsampled lights and the render gets noisy (banked in design-viz,
   * 2026-08-02). Default 0: the highlight should be doing the work.
   */
  glow?: number;
}

export class PathTubes {
  readonly group = new THREE.Group();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.MeshPhysicalMaterial;
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
  private usedSegments = 0;
  // Beads live in their own preallocated buffer, built exactly like the
  // tubes: one unit sphere's vertices replicated `beadCapacity` times and
  // rewritten in place. See the comment on buildBeads for why this is not
  // an InstancedMesh.
  private beadMesh: THREE.Mesh | null = null;
  private beadGeometry: THREE.BufferGeometry | null = null;
  private beadMaterial: THREE.MeshPhysicalMaterial | null = null;
  private beadPositions: Float32Array | null = null;
  private beadNormals: Float32Array | null = null;
  private beadColors: Float32Array | null = null;
  /** Unit-sphere vertices; on a radius-1 sphere these are also the normals. */
  private beadUnit: Float32Array | null = null;
  private beadCapacity = 0;
  private beadVerts = 0; // vertices per bead
  private beadIndices = 0; // indices per bead
  private usedBeads = 0;

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
    this.colors = new Float32Array(verts * COLOR_ITEMS);

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
        // Wound so the face normal (a1-a0) x (b0-a0) comes out OUTWARD, i.e.
        // agreeing with the ring normals written in set(). This was reversed
        // until 2026-08-04, and it is the reason the tubes rendered flat in
        // the path tracer while looking perfect in the preview:
        //
        // the tracer takes `surfaceHit.side` from the winding and then does
        // `normal *= side` (get_surface_record_function), so an inverted
        // winding turns every exterior hit into a back-face hit and flips
        // the shading normal to point INTO the tube. Direct lighting is then
        // discarded on the side you can see (`isSampleBelowSurface`, and
        // `isDirectionValid` against the face normal), leaving no highlight
        // and no round shading at all. The rasteriser never notices because
        // DoubleSide flips back faces for it.
        //
        // The basis in set() is (u, v, dir) with u x v = dir, so the handedness
        // is fixed rather than per-segment: one consistent order is correct
        // for every segment, whichever helper axis was picked.
        const o = (s * this.ring + j) * 6;
        indices[o] = a0; indices[o + 1] = a1; indices[o + 2] = b0;
        indices[o + 3] = a1; indices[o + 4] = b1; indices[o + 5] = b0;
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
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, COLOR_ITEMS));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, 0);

    // A real shaded material, for two reasons.
    //
    // It looks like geometry: unlit tubes read as flat ribbons, because a
    // cylinder with no shading has nothing to tell you it is round.
    //
    // And it is a material a PATH TRACER understands. MeshBasicMaterial is
    // not physical, so a beauty pass would have to substitute something for
    // it and the preview would stop predicting the render.
    //
    // `emissive` stays BLACK, which is the subtlety that cost a round trip:
    // three.js does not apply vertexColors to emissive, so a self-lit
    // standard material adds ONE uniform glow to every tube and the
    // per-segment colour washes out — with ACES on top, all the way to
    // white. vertexColors multiplies `color`, so with no emissive the ramp
    // survives and the lights do the rest.
    //
    // DoubleSide is now belt-and-braces rather than load-bearing: the ring
    // winding was inverted and DoubleSide hid it in the preview for as long
    // as it took the path tracer to show it (see the index buffer above).
    // Kept because a tube seen end-on still exposes an open ring.
    // Physical rather than standard, and glossy rather than matte: a thin
    // tube only reads as ROUND if a highlight runs along it. Matte ones are
    // flat ribbons whatever colour they are, and adding emissive to
    // compensate makes it worse — emission is a constant, so it washes out
    // the very shading that conveys the shape.
    //
    // Clearcoat gives the highlight a tight, wet look that survives at one
    // or two pixels wide, and three-gpu-pathtracer evaluates it natively,
    // so the preview and the traced frame agree.
    this.material = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: options.roughness ?? 0.35,
      metalness: options.metalness ?? 0,
      clearcoat: options.clearcoat ?? 0,
      clearcoatRoughness: 0.25,
      side: THREE.DoubleSide,
      emissive: new THREE.Color(options.glowColor ?? 0xf7d778),
      emissiveIntensity: options.glow ?? 0,
      transparent: opacity < 1,
      opacity,
    });

    this.usedSegments = this.capacity;
    this.park(0); // nothing drawn yet, so no slot may sit at the origin

    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false; // the buffer is rewritten constantly
    this.group.add(mesh);

    this.buildBeads(options, opacity);

    parent.add(this.group);
  }

  /**
   * Terminal beads, as ONE plain mesh holding every bead's vertices — not an
   * InstancedMesh, which is what this used to be (2026-08-04).
   *
   * three-gpu-pathtracer has no instancing support at all: there is not one
   * reference to `isInstancedMesh` or `instanceMatrix` in its source, and
   * its scene walk matches on `o.isMesh`, which an InstancedMesh satisfies.
   * So it baked the BASE geometry once under the object's world matrix — a
   * radius-1 sphere sitting at the world origin, which in these scenes is on
   * the floor directly under the subject. That was the phantom mass wrapped
   * around the bottom of the test ball in every traced frame, and it was
   * immune to the `end markers` toggle because turning beads off only sets
   * `count = 0` and the generator never reads `count`.
   *
   * The instancing was buying one draw call and a matrix write per bead;
   * writing the vertices costs ~2.2k floats a frame at the sizes used here,
   * which is nothing beside the tube buffer next to it — and it means the
   * tracer sees the beads the preview actually draws.
   */
  private buildBeads(options: PathTubesOptions, opacity: number): void {
    const beads = options.endpointCapacity ?? 0;
    if (beads <= 0) return;

    // One low-poly sphere as the template. At radius 1 and centred on the
    // origin its positions ARE its normals, so placing a bead is a scale and
    // an add, with no matrix anywhere.
    const unit = new THREE.SphereGeometry(1, 6, 4);
    const unitPos = unit.getAttribute('position').array as Float32Array;
    const unitIdx = unit.getIndex()!.array;
    this.beadUnit = new Float32Array(unitPos);
    this.beadVerts = unit.getAttribute('position').count;
    this.beadIndices = unitIdx.length;
    unit.dispose();

    this.beadCapacity = beads;
    const verts = beads * this.beadVerts;
    this.beadPositions = new Float32Array(verts * 3);
    this.beadNormals = new Float32Array(verts * 3);
    this.beadColors = new Float32Array(verts * COLOR_ITEMS);

    // Topology is fixed, like the tubes': the template's indices repeated
    // with each bead's vertex offset added.
    const indices = new Uint32Array(beads * this.beadIndices);
    for (let b = 0; b < beads; b++) {
      const vertexBase = b * this.beadVerts;
      const indexBase = b * this.beadIndices;
      for (let i = 0; i < this.beadIndices; i++) {
        indices[indexBase + i] = unitIdx[i]! + vertexBase;
      }
    }

    this.beadGeometry = new THREE.BufferGeometry();
    this.beadGeometry.setAttribute('position', new THREE.BufferAttribute(this.beadPositions, 3));
    this.beadGeometry.setAttribute('normal', new THREE.BufferAttribute(this.beadNormals, 3));
    this.beadGeometry.setAttribute('color', new THREE.BufferAttribute(this.beadColors, COLOR_ITEMS));
    this.beadGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.beadGeometry.setDrawRange(0, 0);

    // vertexColors now, where instanceColor did the job before — same
    // reasoning as the tubes: it multiplies the base colour, and an emissive
    // term would drown it.
    this.beadMaterial = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: options.roughness ?? 0.35,
      metalness: options.metalness ?? 0,
      clearcoat: options.clearcoat ?? 0,
      clearcoatRoughness: 0.25,
      side: THREE.DoubleSide,
      emissive: new THREE.Color(options.glowColor ?? 0xf7d778),
      emissiveIntensity: options.glow ?? 0,
      transparent: opacity < 1,
      opacity,
    });

    this.usedBeads = beads;
    this.parkBeads(0); // nothing placed yet, so no bead may sit at the origin

    this.beadMesh = new THREE.Mesh(this.beadGeometry, this.beadMaterial);
    this.beadMesh.frustumCulled = false;
    this.group.add(this.beadMesh);
  }

  /** Self-illumination of tubes and beads; see PathTubesOptions.glow. */
  setGlow(glow: number): void {
    this.material.emissiveIntensity = glow;
    if (this.beadMaterial) this.beadMaterial.emissiveIntensity = glow;
  }

  /** Retune the surface without rebuilding the buffers. */
  setSurface(roughness: number, metalness: number): void {
    this.material.roughness = roughness;
    this.material.metalness = metalness;
    if (this.beadMaterial) {
      this.beadMaterial.roughness = roughness;
      this.beadMaterial.metalness = metalness;
    }
  }

  /** Place the terminal beads. Pass an empty list to hide them. */
  setEndpoints(endpoints: readonly TubeEndpoint[]): void {
    const geometry = this.beadGeometry;
    const positions = this.beadPositions;
    const normals = this.beadNormals;
    const colors = this.beadColors;
    const unit = this.beadUnit;
    if (!geometry || !positions || !normals || !colors || !unit) return;

    const V = this.beadVerts;
    const n = Math.min(endpoints.length, this.beadCapacity);
    for (let i = 0; i < n; i++) {
      const e = endpoints[i]!;
      const base = i * V;
      for (let j = 0; j < V; j++) {
        const nx = unit[j * 3]!;
        const ny = unit[j * 3 + 1]!;
        const nz = unit[j * 3 + 2]!;
        const p = (base + j) * 3;
        positions[p] = e.p[0] + nx * e.radius;
        positions[p + 1] = e.p[1] + ny * e.radius;
        positions[p + 2] = e.p[2] + nz * e.radius;
        normals[p] = nx;
        normals[p + 1] = ny;
        normals[p + 2] = nz;
        const c = (base + j) * COLOR_ITEMS;
        colors[c] = e.color[0];
        colors[c + 1] = e.color[1];
        colors[c + 2] = e.color[2];
        colors[c + 3] = 1;
      }
    }

    // Park the rest. drawRange holds the rasteriser, but the path tracer
    // merges the whole buffer regardless — the same reason park() exists for
    // the tubes — and an unwritten bead is a sphere collapsed onto the world
    // origin, which is exactly the mass this rewrite got rid of.
    this.parkBeads(n);
    geometry.setDrawRange(0, n * this.beadIndices);
    (geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Move beads [from, capacity) somewhere they can never be hit. */
  private parkBeads(from: number): void {
    const positions = this.beadPositions;
    const normals = this.beadNormals;
    const colors = this.beadColors;
    if (!positions || !normals || !colors) return;
    // Only what was in use last time needs clearing; the rest is parked.
    const until = Math.max(this.usedBeads, from);
    for (let i = from * this.beadVerts; i < until * this.beadVerts; i++) {
      const p = i * 3;
      positions[p] = PARKED;
      positions[p + 1] = PARKED;
      positions[p + 2] = PARKED;
      normals[p] = 0;
      normals[p + 1] = 1;
      normals[p + 2] = 0;
      const c = i * COLOR_ITEMS;
      colors[c] = 0;
      colors[c + 1] = 0;
      colors[c + 2] = 0;
      colors[c + 3] = 1;
    }
    this.usedBeads = from;
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
          const vertex = base + ringIndex * R + j;
          const i = vertex * 3;
          this.positions[i] = p[0] + nx * radius;
          this.positions[i + 1] = p[1] + ny * radius;
          this.positions[i + 2] = p[2] + nz * radius;
          this.normals[i] = nx;
          this.normals[i + 1] = ny;
          this.normals[i + 2] = nz;
          const c = vertex * COLOR_ITEMS;
          this.colors[c] = s.color[0];
          this.colors[c + 1] = s.color[1];
          this.colors[c + 2] = s.color[2];
          this.colors[c + 3] = 1;
        }
      }
      used += 1;
    }

    // Park every slot the population did not fill.
    //
    // drawRange is enough for the RASTERISER, but three-gpu-pathtracer
    // merges the scene through three-mesh-bvh's StaticGeometryGenerator,
    // which ignores drawRange entirely — so the path tracer sees the whole
    // buffer. Unwritten slots are all-zero, i.e. a pile of degenerate
    // triangles at the WORLD ORIGIN, which in these scenes sits on the
    // floor directly under the subject and renders as a blob propping it
    // up. Parking them far outside the scene, with valid normals rather
    // than zero-length ones, makes them unhittable instead.
    this.park(used);
    this.geometry.setDrawRange(0, used * R * 6);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Move slots [from, capacity) somewhere they can never be hit. */
  private park(from: number): void {
    const R = this.ring;
    // Only the slots that were in use last time need clearing; the rest
    // were parked already and nothing has touched them.
    const until = Math.max(this.usedSegments, from);
    for (let s = from; s < until; s++) {
      const base = s * R * 2;
      for (let j = 0; j < R * 2; j++) {
        const vertex = base + j;
        const i = vertex * 3;
        this.positions[i] = PARKED;
        this.positions[i + 1] = PARKED;
        this.positions[i + 2] = PARKED;
        this.normals[i] = 0;
        this.normals[i + 1] = 1;
        this.normals[i + 2] = 0;
        const c = vertex * COLOR_ITEMS;
        this.colors[c] = 0;
        this.colors[c + 1] = 0;
        this.colors[c + 2] = 0;
        this.colors[c + 3] = 1;
      }
    }
    this.usedSegments = from;
  }

  dispose(): void {
    this.parent.remove(this.group);
    this.geometry.dispose();
    this.material.dispose();
    this.beadGeometry?.dispose();
    this.beadMaterial?.dispose();
  }
}

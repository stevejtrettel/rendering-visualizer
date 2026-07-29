// Binned-SAH BVH over triangle bounds — a sealed fast module (allocation-
// free scalar code on flat arrays; correctness enforced by brute-force
// equivalence tests, not readability). Node layout follows Steve's
// PathTracerGLSL builder: 8 floats per node,
//   [minx, miny, minz, A,  maxx, maxy, maxz, B]
//   A >= 0 -> LEAF:     triangle count = A, first-triangle offset = B
//   A <  0 -> INTERNAL: split axis = -A-1, right child = B, left = node+1
// Triangles are re-emitted leaf-contiguous in `order`.

const BINS = 12;
const LEAF_SIZE = 4;

export interface BVH {
  nodes: Float32Array;
  nodeCount: number;
  order: Uint32Array; // triangle indices, leaf-contiguous
}

export function buildBVH(positions: Float32Array, indices: Uint32Array): BVH {
  const triCount = indices.length / 3;
  // Per-triangle bounds + centroids.
  const bounds = new Float32Array(triCount * 6);
  const centroids = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < 3; k++) {
      const p = indices[t * 3 + k]! * 3;
      const x = positions[p]!, y = positions[p + 1]!, z = positions[p + 2]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    bounds.set([minX, minY, minZ, maxX, maxY, maxZ], t * 6);
    centroids.set([(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2], t * 3);
  }

  const order = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) order[i] = i;
  const nodes = new Float32Array((2 * triCount + 1) * 8);
  let nodeCount = 0;

  const surface = (mnx: number, mny: number, mnz: number, mxx: number, mxy: number, mxz: number) => {
    const dx = Math.max(0, mxx - mnx), dy = Math.max(0, mxy - mny), dz = Math.max(0, mxz - mnz);
    return 2 * (dx * dy + dy * dz + dz * dx);
  };

  // Recursive build over order[start, end).
  const build = (start: number, end: number): number => {
    const node = nodeCount++;
    const o = node * 8;
    // Node bounds + centroid bounds.
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    let cnx = Infinity, cny = Infinity, cnz = Infinity, cxx = -Infinity, cxy = -Infinity, cxz = -Infinity;
    for (let i = start; i < end; i++) {
      const t = order[i]!;
      const b = t * 6;
      if (bounds[b]! < mnx) mnx = bounds[b]!;
      if (bounds[b + 1]! < mny) mny = bounds[b + 1]!;
      if (bounds[b + 2]! < mnz) mnz = bounds[b + 2]!;
      if (bounds[b + 3]! > mxx) mxx = bounds[b + 3]!;
      if (bounds[b + 4]! > mxy) mxy = bounds[b + 4]!;
      if (bounds[b + 5]! > mxz) mxz = bounds[b + 5]!;
      const c = t * 3;
      if (centroids[c]! < cnx) cnx = centroids[c]!;
      if (centroids[c]! > cxx) cxx = centroids[c]!;
      if (centroids[c + 1]! < cny) cny = centroids[c + 1]!;
      if (centroids[c + 1]! > cxy) cxy = centroids[c + 1]!;
      if (centroids[c + 2]! < cnz) cnz = centroids[c + 2]!;
      if (centroids[c + 2]! > cxz) cxz = centroids[c + 2]!;
    }
    nodes[o] = mnx; nodes[o + 1] = mny; nodes[o + 2] = mnz;
    nodes[o + 4] = mxx; nodes[o + 5] = mxy; nodes[o + 6] = mxz;

    const count = end - start;
    const extX = cxx - cnx, extY = cxy - cny, extZ = cxz - cnz;
    const axis = extX > extY ? (extX > extZ ? 0 : 2) : extY > extZ ? 1 : 2;
    const ext = axis === 0 ? extX : axis === 1 ? extY : extZ;
    const cmin = axis === 0 ? cnx : axis === 1 ? cny : cnz;

    if (count <= LEAF_SIZE || ext === 0) {
      nodes[o + 3] = count;
      nodes[o + 7] = start;
      return node;
    }

    // Binned SAH along the widest centroid axis.
    const binCount = new Int32Array(BINS);
    const binBounds = new Float32Array(BINS * 6).fill(Infinity);
    for (let b = 0; b < BINS; b++) binBounds.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], b * 6);
    const scale = BINS / ext;
    for (let i = start; i < end; i++) {
      const t = order[i]!;
      const bin = Math.min(BINS - 1, Math.floor((centroids[t * 3 + axis]! - cmin) * scale));
      binCount[bin]! += 1;
      const bb = bin * 6, tb = t * 6;
      for (let k = 0; k < 3; k++) {
        if (bounds[tb + k]! < binBounds[bb + k]!) binBounds[bb + k] = bounds[tb + k]!;
        if (bounds[tb + 3 + k]! > binBounds[bb + 3 + k]!) binBounds[bb + 3 + k] = bounds[tb + 3 + k]!;
      }
    }
    // Sweep to find the cheapest split plane.
    let bestCost = Infinity;
    let bestSplit = -1;
    for (let split = 1; split < BINS; split++) {
      let ln = 0, rn = 0;
      let l0 = Infinity, l1 = Infinity, l2 = Infinity, l3 = -Infinity, l4 = -Infinity, l5 = -Infinity;
      let r0 = Infinity, r1 = Infinity, r2 = Infinity, r3 = -Infinity, r4 = -Infinity, r5 = -Infinity;
      for (let b = 0; b < BINS; b++) {
        const bb = b * 6;
        if (binCount[b] === 0) continue;
        if (b < split) {
          ln += binCount[b]!;
          l0 = Math.min(l0, binBounds[bb]!); l1 = Math.min(l1, binBounds[bb + 1]!); l2 = Math.min(l2, binBounds[bb + 2]!);
          l3 = Math.max(l3, binBounds[bb + 3]!); l4 = Math.max(l4, binBounds[bb + 4]!); l5 = Math.max(l5, binBounds[bb + 5]!);
        } else {
          rn += binCount[b]!;
          r0 = Math.min(r0, binBounds[bb]!); r1 = Math.min(r1, binBounds[bb + 1]!); r2 = Math.min(r2, binBounds[bb + 2]!);
          r3 = Math.max(r3, binBounds[bb + 3]!); r4 = Math.max(r4, binBounds[bb + 4]!); r5 = Math.max(r5, binBounds[bb + 5]!);
        }
      }
      if (ln === 0 || rn === 0) continue;
      const cost = ln * surface(l0, l1, l2, l3, l4, l5) + rn * surface(r0, r1, r2, r3, r4, r5);
      if (cost < bestCost) {
        bestCost = cost;
        bestSplit = split;
      }
    }
    if (bestSplit < 0) {
      nodes[o + 3] = count;
      nodes[o + 7] = start;
      return node;
    }

    // Partition order[] in place around the chosen plane.
    let mid = start;
    for (let i = start; i < end; i++) {
      const t = order[i]!;
      const bin = Math.min(BINS - 1, Math.floor((centroids[t * 3 + axis]! - cmin) * scale));
      if (bin < bestSplit) {
        const tmp = order[mid]!;
        order[mid] = t;
        order[i] = tmp;
        mid++;
      }
    }
    if (mid === start || mid === end) mid = (start + end) >> 1; // degenerate: median fallback

    build(start, mid); // left child = node + 1 by construction
    const right = build(mid, end);
    nodes[o + 3] = -(axis + 1);
    nodes[o + 7] = right;
    return node;
  };

  if (triCount > 0) build(0, triCount);
  return { nodes: nodes.subarray(0, nodeCount * 8), nodeCount, order };
}

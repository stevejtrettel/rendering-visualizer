// Minimal OBJ parser: v / vn / f with every index form (a, a/b, a//c,
// a/b/c, negative = from-end), polygon faces triangulated as fans,
// per-corner (v, vn) pairs deduplicated into a shared vertex list.
// Missing normals are computed as area-weighted smooth normals.
// Materials and texture coordinates are ignored.

export interface ParsedMesh {
  positions: Float32Array; // 3 per vertex
  normals: Float32Array; // 3 per vertex
  indices: Uint32Array; // 3 per triangle
}

export function parseOBJ(text: string): ParsedMesh {
  const vs: number[] = [];
  const vns: number[] = [];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const corner = new Map<string, number>();
  let hasNormals = false;

  const resolve = (idx: number, count: number) => (idx > 0 ? idx - 1 : count + idx);

  const cornerIndex = (spec: string): number => {
    const cached = corner.get(spec);
    if (cached !== undefined) return cached;
    const parts = spec.split('/');
    const vi = resolve(parseInt(parts[0]!, 10), vs.length / 3);
    const ni = parts[2] ? resolve(parseInt(parts[2], 10), vns.length / 3) : -1;
    const index = positions.length / 3;
    positions.push(vs[vi * 3]!, vs[vi * 3 + 1]!, vs[vi * 3 + 2]!);
    if (ni >= 0) {
      hasNormals = true;
      normals.push(vns[ni * 3]!, vns[ni * 3 + 1]!, vns[ni * 3 + 2]!);
    } else {
      normals.push(0, 0, 0);
    }
    corner.set(spec, index);
    return index;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    switch (tokens[0]) {
      case 'v':
        vs.push(Number(tokens[1]), Number(tokens[2]), Number(tokens[3]));
        break;
      case 'vn':
        vns.push(Number(tokens[1]), Number(tokens[2]), Number(tokens[3]));
        break;
      case 'f': {
        const corners = tokens.slice(1).map(cornerIndex);
        for (let i = 1; i + 1 < corners.length; i++) {
          indices.push(corners[0]!, corners[i]!, corners[i + 1]!);
        }
        break;
      }
      default:
        break; // o, g, s, usemtl, mtllib, vt — ignored
    }
  }

  const pos = new Float32Array(positions);
  const idx = new Uint32Array(indices);
  const nrm = new Float32Array(normals);
  if (!hasNormals) computeSmoothNormals(pos, idx, nrm);
  else normalizeAll(nrm);
  return { positions: pos, normals: nrm, indices: idx };
}

// Area-weighted vertex normals: accumulate unnormalized face normals
// (cross product magnitude = 2x area), then normalize.
function computeSmoothNormals(pos: Float32Array, idx: Uint32Array, out: Float32Array): void {
  out.fill(0);
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t]! * 3, idx[t + 1]! * 3, idx[t + 2]! * 3];
    const e1x = pos[b]! - pos[a]!, e1y = pos[b + 1]! - pos[a + 1]!, e1z = pos[b + 2]! - pos[a + 2]!;
    const e2x = pos[c]! - pos[a]!, e2y = pos[c + 1]! - pos[a + 1]!, e2z = pos[c + 2]! - pos[a + 2]!;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      out[v]! += nx;
      out[v + 1]! += ny;
      out[v + 2]! += nz;
    }
  }
  normalizeAll(out);
}

function normalizeAll(normals: Float32Array): void {
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!);
    if (len > 0) {
      normals[i]! /= len;
      normals[i + 1]! /= len;
      normals[i + 2]! /= len;
    } else {
      normals[i + 2] = 1;
    }
  }
}

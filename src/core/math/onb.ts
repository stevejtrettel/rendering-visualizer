import { Vec3 } from './vec3';

// Orthonormal basis with w = z-axis, built branchlessly from a unit normal
// (Duff et al. 2017). Local coordinates follow the BSDF convention:
// shading normal = +z, cos(theta) = v.z.
export class OrthonormalBasis {
  private constructor(
    readonly u: Vec3,
    readonly v: Vec3,
    readonly w: Vec3,
  ) {}

  static fromZ(n: Vec3): OrthonormalBasis {
    const sign = n.z >= 0 ? 1 : -1;
    const a = -1 / (sign + n.z);
    const b = n.x * n.y * a;
    const u = new Vec3(1 + sign * n.x * n.x * a, sign * b, -sign * n.x);
    const v = new Vec3(b, sign + n.y * n.y * a, -n.y);
    return new OrthonormalBasis(u, v, n);
  }

  toWorld(local: Vec3): Vec3 {
    return this.u
      .scale(local.x)
      .add(this.v.scale(local.y))
      .add(this.w.scale(local.z));
  }

  toLocal(world: Vec3): Vec3 {
    return new Vec3(world.dot(this.u), world.dot(this.v), world.dot(this.w));
  }
}

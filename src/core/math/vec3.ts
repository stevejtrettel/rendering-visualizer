// Immutable by convention: methods return new vectors. The explicitly named
// *InPlace variants are the only mutators, reserved for hot loops.
export class Vec3 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}

  static readonly ZERO = new Vec3(0, 0, 0);

  add(v: Vec3): Vec3 {
    return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z);
  }

  sub(v: Vec3): Vec3 {
    return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  scale(s: number): Vec3 {
    return new Vec3(this.x * s, this.y * s, this.z * s);
  }

  neg(): Vec3 {
    return new Vec3(-this.x, -this.y, -this.z);
  }

  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v: Vec3): Vec3 {
    return new Vec3(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x,
    );
  }

  lengthSq(): number {
    return this.dot(this);
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  normalize(): Vec3 {
    return this.scale(1 / this.length());
  }

  distanceTo(v: Vec3): number {
    return this.sub(v).length();
  }

  distanceSqTo(v: Vec3): number {
    return this.sub(v).lengthSq();
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  addInPlace(v: Vec3): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  scaleInPlace(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }
}

export function absDot(a: Vec3, b: Vec3): number {
  return Math.abs(a.dot(b));
}

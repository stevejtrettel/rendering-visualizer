// 2×2 matrix, row-major: (m00 m01; m10 m11). The manifold walk's Newton
// step and the generalized geometry factor are 2×2 problems (two surface
// coordinates against two angular constraints) — this is the repo's only
// matrix type, deliberately minimal.
export class Mat2 {
  constructor(
    readonly m00: number,
    readonly m01: number,
    readonly m10: number,
    readonly m11: number,
  ) {}

  det(): number {
    return this.m00 * this.m11 - this.m01 * this.m10;
  }

  // Null (rather than Infinity-filled garbage) when |det| <= minDet — the
  // caller's singularity guard is part of the walk's failure taxonomy.
  inverse(minDet = 0): Mat2 | null {
    const d = this.det();
    if (Math.abs(d) <= minDet) return null;
    const inv = 1 / d;
    return new Mat2(this.m11 * inv, -this.m01 * inv, -this.m10 * inv, this.m00 * inv);
  }

  mul(o: Mat2): Mat2 {
    return new Mat2(
      this.m00 * o.m00 + this.m01 * o.m10,
      this.m00 * o.m01 + this.m01 * o.m11,
      this.m10 * o.m00 + this.m11 * o.m10,
      this.m10 * o.m01 + this.m11 * o.m11,
    );
  }

  mulVec(x: number, y: number): [number, number] {
    return [this.m00 * x + this.m01 * y, this.m10 * x + this.m11 * y];
  }
}

// RGB throughput/radiance triple, distinct from Vec3 for type safety.
// Immutable by convention, like Vec3.
export class Color {
  constructor(
    public r: number,
    public g: number,
    public b: number,
  ) {}

  static readonly BLACK = new Color(0, 0, 0);
  static readonly WHITE = new Color(1, 1, 1);

  add(c: Color): Color {
    return new Color(this.r + c.r, this.g + c.g, this.b + c.b);
  }

  mul(c: Color): Color {
    return new Color(this.r * c.r, this.g * c.g, this.b * c.b);
  }

  scale(s: number): Color {
    return new Color(this.r * s, this.g * s, this.b * s);
  }

  // Rec. 709 luma — the scalar target for MLT acceptance; the weights are
  // decided here once, for the whole system.
  luminance(): number {
    return 0.2126 * this.r + 0.7152 * this.g + 0.0722 * this.b;
  }

  maxComponent(): number {
    return Math.max(this.r, this.g, this.b);
  }

  isBlack(): boolean {
    return this.r === 0 && this.g === 0 && this.b === 0;
  }

  clone(): Color {
    return new Color(this.r, this.g, this.b);
  }
}

import { Vec3 } from './vec3';

// d is unit-length by convention (intersection t values are then distances).
export class Ray {
  constructor(
    public o: Vec3,
    public d: Vec3,
  ) {}

  at(t: number): Vec3 {
    return this.o.add(this.d.scale(t));
  }
}

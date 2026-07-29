// Declarative scene description (plain JSON-able data — it crosses worker
// boundaries and feeds both the core adapter here and the three.js adapter
// in src/viz) and the built runtime Scene.
import { Vec3 } from '../math/vec3';
import { Color } from '../math/color';
import { Sphere } from '../geometry/sphere';
import { Quad } from '../geometry/quad';
import type { Shape } from '../geometry/shape';
import { LinearAggregate, type Aggregate, type Primitive } from '../geometry/aggregate';
import type { BxDF } from '../materials/bsdf';
import { Lambert } from '../materials/lambert';
import { AreaLight } from '../lights/area';
import type { Light } from '../lights/light';
import { UniformLightDistribution, type LightDistribution } from '../lights/distribution';
import { PinholeCamera } from './camera';

export type Vec3Tuple = readonly [number, number, number];
export type ColorTuple = readonly [number, number, number];

export type ShapeDescription =
  | { kind: 'sphere'; center: Vec3Tuple; radius: number }
  | { kind: 'quad'; q: Vec3Tuple; e1: Vec3Tuple; e2: Vec3Tuple };

export type MaterialDescription = { kind: 'lambert'; albedo: ColorTuple };

export interface PrimitiveDescription {
  name?: string;
  shape: ShapeDescription;
  material: MaterialDescription;
  emission?: { radiance: ColorTuple; twoSided?: boolean };
}

export interface SceneDescription {
  camera: {
    eye: Vec3Tuple;
    lookAt: Vec3Tuple;
    up: Vec3Tuple;
    fovDegrees: number;
  };
  primitives: PrimitiveDescription[];
}

export interface ScenePrimitive extends Primitive {
  readonly name: string;
  readonly bxdf: BxDF;
  readonly light: AreaLight | null;
}

export interface Scene {
  camera: PinholeCamera;
  aggregate: Aggregate;
  primitives: readonly ScenePrimitive[];
  lights: readonly Light[];
  lightDistribution: LightDistribution;
}

const vec = (t: Vec3Tuple) => new Vec3(t[0], t[1], t[2]);
const color = (t: ColorTuple) => new Color(t[0], t[1], t[2]);

function buildShape(desc: ShapeDescription): Shape {
  switch (desc.kind) {
    case 'sphere':
      return new Sphere(vec(desc.center), desc.radius);
    case 'quad':
      return new Quad(vec(desc.q), vec(desc.e1), vec(desc.e2));
  }
}

function buildMaterial(desc: MaterialDescription): BxDF {
  return new Lambert(color(desc.albedo));
}

export function buildScene(desc: SceneDescription, width: number, height: number): Scene {
  const primitives: ScenePrimitive[] = desc.primitives.map((p, i) => {
    const shape = buildShape(p.shape);
    const light = p.emission
      ? new AreaLight(shape, color(p.emission.radiance), p.emission.twoSided ?? false)
      : null;
    return { name: p.name ?? `primitive-${i}`, shape, bxdf: buildMaterial(p.material), light };
  });

  const lights = primitives.flatMap((p) => (p.light ? [p.light] : []));

  return {
    camera: new PinholeCamera({
      eye: vec(desc.camera.eye),
      lookAt: vec(desc.camera.lookAt),
      up: vec(desc.camera.up),
      fovDegrees: desc.camera.fovDegrees,
      width,
      height,
    }),
    aggregate: new LinearAggregate(primitives),
    primitives,
    lights,
    lightDistribution: new UniformLightDistribution(lights),
  };
}

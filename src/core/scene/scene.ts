// Declarative scene description (plain JSON-able data — it crosses worker
// boundaries and feeds both the core adapter here and the three.js adapter
// in src/viz) and the built runtime Scene.
import { Vec3 } from '../math/vec3';
import { Color } from '../math/color';
import { Sphere } from '../geometry/sphere';
import { Quad } from '../geometry/quad';
import { TriangleMesh } from '../geometry/triangle-mesh';
import type { Shape } from '../geometry/shape';
import { LinearAggregate, type Aggregate, type Primitive } from '../geometry/aggregate';
import type { BxDF } from '../materials/bsdf';
import { Lambert } from '../materials/lambert';
import { Dielectric } from '../materials/dielectric';
import { GGXConductor, SmoothConductor } from '../materials/conductor';
import { AreaLight } from '../lights/area';
import { PointLight } from '../lights/point';
import type { Light } from '../lights/light';
import { UniformLightDistribution, type LightDistribution } from '../lights/distribution';
import { PinholeCamera } from './camera';

export type Vec3Tuple = readonly [number, number, number];
export type ColorTuple = readonly [number, number, number];

export type ShapeDescription =
  | { kind: 'sphere'; center: Vec3Tuple; radius: number }
  | { kind: 'quad'; q: Vec3Tuple; e1: Vec3Tuple; e2: Vec3Tuple }
  // Typed arrays: structured-clone safe, shipped to workers as-is.
  | { kind: 'mesh'; positions: Float32Array; normals: Float32Array; indices: Uint32Array };

export type MaterialDescription =
  | { kind: 'lambert'; albedo: ColorTuple }
  | { kind: 'dielectric'; ior: number }
  | { kind: 'mirror'; f0: ColorTuple }
  | { kind: 'conductor'; f0: ColorTuple; roughness: number };

export interface PrimitiveDescription {
  name?: string;
  shape: ShapeDescription;
  material: MaterialDescription;
  emission?: { radiance: ColorTuple; twoSided?: boolean };
  // Display-only hints, honored by the three.js adapter and IGNORED by the
  // CPU renderer. `ghost` draws the primitive as see-through glass so the
  // visualizer can look into closed scenes. This is a deliberate,
  // localized break of strict scene parity (agreed 2026-07-28): the two
  // renderers still consume the same geometry; only its portrayal differs.
  display?: { ghost?: boolean };
}

export interface SceneDescription {
  camera: {
    eye: Vec3Tuple;
    lookAt: Vec3Tuple;
    up: Vec3Tuple;
    fovDegrees: number;
  };
  primitives: PrimitiveDescription[];
  // Delta emitters (V5c): geometry-free, so they live beside the
  // primitive list. Supported by pt / pt-nee / pt-sms; BDPT/MMLT scenes
  // must not rely on them (PointLight.sampleLe returns null — the light
  // silently does not participate in bidirectional transport).
  pointLights?: { p: Vec3Tuple; intensity: ColorTuple }[];
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
    case 'mesh':
      return new TriangleMesh(desc.positions, desc.normals, desc.indices);
  }
}

function buildMaterial(desc: MaterialDescription): BxDF {
  switch (desc.kind) {
    case 'lambert':
      return new Lambert(color(desc.albedo));
    case 'dielectric':
      return new Dielectric(desc.ior);
    case 'mirror':
      return new SmoothConductor(color(desc.f0));
    case 'conductor':
      return new GGXConductor(color(desc.f0), desc.roughness);
  }
}

export function buildScene(desc: SceneDescription, width: number, height: number): Scene {
  const primitives: ScenePrimitive[] = desc.primitives.map((p, i) => {
    const shape = buildShape(p.shape);
    const light = p.emission
      ? new AreaLight(shape, color(p.emission.radiance), p.emission.twoSided ?? false)
      : null;
    return { name: p.name ?? `primitive-${i}`, shape, bxdf: buildMaterial(p.material), light };
  });

  const lights: Light[] = primitives.flatMap((p) => (p.light ? [p.light] : []));
  for (const pl of desc.pointLights ?? []) {
    lights.push(new PointLight(vec(pl.p), color(pl.intensity)));
  }

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

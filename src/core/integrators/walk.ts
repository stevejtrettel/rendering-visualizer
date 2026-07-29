// The shared random-walk engine (pbrt's RandomWalk, v3 §16.3.2). Every
// integrator builds its subpaths here; in V2 the light-subpath generator
// becomes a second caller with mode = Importance.
//
// Invariants: solid-angle pdfs live only in loop variables; everything
// stored on a vertex is area measure. Each bounce writes pdfFwd forward
// into the new vertex and pdfRev backward into the previous one.
import { Color } from '../math/color';
import { Ray } from '../math/ray';
import type { Vec3 } from '../math/vec3';
import { solidAngleToArea } from '../geometry/measure';
import { offsetRayOrigin } from '../geometry/offset';
import { SurfaceBSDF } from '../materials/surface';
import { TransportMode, isSpecular } from '../materials/bsdf';
import type { Scene, ScenePrimitive } from '../scene/scene';
import type { Sampler } from '../sampler/sampler';
import type { Recorder } from '../../trace/recorder';
import type { PathVertex } from './vertex';

export interface WalkOptions {
  maxBounces: number; // hard cap on surface vertices
  rrStartDepth: number; // first surface-vertex depth at which RR applies
  // Draw NEE dimensions per bounce (light-select 1D + light-point 2D) and
  // store them on the vertex. Part of the integrator's fixed dimension
  // layout — layouts are per-integrator; replay uses the same integrator.
  sampleNEE: boolean;
}

export const DEFAULT_WALK_OPTIONS: WalkOptions = { maxBounces: 32, rrStartDepth: 3, sampleNEE: false };

// Shading-normal adjoint correction (pbrt v3 §16.1.3): light subpaths
// (Importance mode) weight the BSDF with |ns·w| cosines where the physical
// transport wants |ng·w|; the asymmetry must be corrected per bounce or
// camera and light subpaths disagree wherever ns != ng. Identity (= 1) in
// Radiance mode and whenever ns = ng.
export function correctShadingNormal(
  isect: { ns: Vec3; ng: Vec3 },
  wo: Vec3,
  wi: Vec3,
  mode: TransportMode,
): number {
  if (mode === TransportMode.Radiance) return 1;
  const denom = Math.abs(isect.ng.dot(wo)) * Math.abs(isect.ns.dot(wi));
  if (denom === 0) return 0;
  return (Math.abs(isect.ns.dot(wo)) * Math.abs(isect.ng.dot(wi))) / denom;
}

// Extends `start` (an endpoint vertex) along `ray`. `beta` is the throughput
// arriving at the first surface hit; `pdfDirW` the solid-angle density of
// the initial direction. Returns [start, ...surface vertices].
export function randomWalk(
  scene: Scene,
  start: PathVertex,
  ray: Ray,
  beta: Color,
  pdfDirW: number,
  mode: TransportMode,
  sampler: Sampler,
  recorder: Recorder,
  options: WalkOptions = DEFAULT_WALK_OPTIONS,
): PathVertex[] {
  const vertices: PathVertex[] = [start];
  const role = mode === TransportMode.Importance ? ('light' as const) : ('camera' as const);
  let currentRay = ray;
  let currentBeta = beta;
  let pdfFwdW = pdfDirW;
  let etaScale = 1;

  for (let depth = 1; depth <= options.maxBounces; depth++) {
    const isect = scene.aggregate.intersect(currentRay);
    if (!isect) break; // V0: no environment light — escaped rays end the path

    const primitive = isect.primitive as ScenePrimitive; // scenes only contain ScenePrimitives
    const prev = vertices[vertices.length - 1]!;
    const bsdf = new SurfaceBSDF(primitive.bxdf, isect.ns, isect.ng);
    const wo = currentRay.d.neg();

    const vertex: PathVertex = {
      type: 'surface',
      p: isect.p,
      ng: isect.ng,
      ns: isect.ns,
      uv: isect.uv,
      beta: currentBeta,
      pdfFwd: solidAngleToArea(pdfFwdW, prev.p, isect.p, isect.ng),
      pdfRev: 0,
      delta: false,
      wo,
      wiSampled: null,
      neeSamples: null,
      bsdf,
      primitive,
      camera: null,
      light: null,
    };
    vertices.push(vertex);

    // Fixed dimension layout: every bounce draws lobe-select + direction,
    // whatever the material (principle 2 in the design doc), then the NEE
    // dimensions when the integrator uses them.
    const uc = sampler.next1D();
    const u2 = sampler.next2D();
    const bs = bsdf.sample(wo, uc, u2, mode);
    if (options.sampleNEE) {
      vertex.neeSamples = { select: sampler.next1D(), point: sampler.next2D() };
    }
    if (!bs) break;

    vertex.wiSampled = bs.wi;
    currentBeta = currentBeta.mul(bs.f).scale(Math.abs(bs.wi.dot(isect.ns)) / bs.pdf);
    currentBeta = currentBeta.scale(correctShadingNormal(isect, wo, bs.wi, mode));
    etaScale *= bs.eta * bs.eta;

    let pdfRevW = bsdf.pdf(bs.wi, wo, mode);
    if (isSpecular(bs.flags)) {
      vertex.delta = true;
      pdfFwdW = 0;
      pdfRevW = 0;
    } else {
      pdfFwdW = bs.pdf;
    }
    // Cosine for any on-surface target: surface vertices AND area-light
    // endpoints (pbrt's ConvertDensity); only the pinhole camera has none.
    prev.pdfRev = solidAngleToArea(pdfRevW, vertex.p, prev.p, prev.type === 'camera' ? null : prev.ng);

    if (depth >= options.rrStartDepth) {
      const q = Math.min(1, currentBeta.maxComponent() * etaScale);
      const u = sampler.next1D(); // drawn unconditionally — fixed layout
      const survived = u < q;
      recorder.rr({ depth, probability: q, survived, role });
      if (!survived) break;
      currentBeta = currentBeta.scale(1 / q);
    }

    currentRay = new Ray(offsetRayOrigin(vertex.p, vertex.ng, bs.wi), bs.wi);
  }

  recorder.walk(vertices, role);
  return vertices;
}

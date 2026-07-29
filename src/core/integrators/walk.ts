// The shared random-walk engine (pbrt's RandomWalk, v3 §16.3.2). Every
// integrator builds its subpaths here; in V2 the light-subpath generator
// becomes a second caller with mode = Importance.
//
// Invariants: solid-angle pdfs live only in loop variables; everything
// stored on a vertex is area measure. Each bounce writes pdfFwd forward
// into the new vertex and pdfRev backward into the previous one.
import { Color } from '../math/color';
import { Ray } from '../math/ray';
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
}

export const DEFAULT_WALK_OPTIONS: WalkOptions = { maxBounces: 32, rrStartDepth: 3 };

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
      bsdf,
      primitive,
      camera: null,
      light: null,
    };
    vertices.push(vertex);

    // Fixed dimension layout: every bounce draws lobe-select + direction,
    // whatever the material (principle 2 in the design doc).
    const uc = sampler.next1D();
    const u2 = sampler.next2D();
    const bs = bsdf.sample(wo, uc, u2, mode);
    if (!bs) break;

    vertex.wiSampled = bs.wi;
    currentBeta = currentBeta.mul(bs.f).scale(Math.abs(bs.wi.dot(isect.ns)) / bs.pdf);
    etaScale *= bs.eta * bs.eta;
    // V2 (Importance mode) multiplies correctShadingNormal here.

    let pdfRevW = bsdf.pdf(bs.wi, wo, mode);
    if (isSpecular(bs.flags)) {
      vertex.delta = true;
      pdfFwdW = 0;
      pdfRevW = 0;
    } else {
      pdfFwdW = bs.pdf;
    }
    prev.pdfRev = solidAngleToArea(pdfRevW, vertex.p, prev.p, prev.type === 'surface' ? prev.ng : null);

    if (depth >= options.rrStartDepth) {
      const q = Math.min(1, currentBeta.maxComponent() * etaScale);
      const u = sampler.next1D(); // drawn unconditionally — fixed layout
      const survived = u < q;
      recorder.rr({ depth, probability: q, survived });
      if (!survived) break;
      currentBeta = currentBeta.scale(1 / q);
    }

    currentRay = new Ray(offsetRayOrigin(vertex.p, vertex.ng, bs.wi), bs.wi);
  }

  recorder.walk(vertices);
  return vertices;
}

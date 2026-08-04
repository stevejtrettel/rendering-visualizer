// The manifold walk: Newton iteration on the specular constraint with
// ray-trace re-projection, plus the root-validation checklist. A returned
// root is only trusted after validation — intended primitive, intended
// reflect/refract branch, no TIR (surfaced as a step failure), and a
// visible vertex↔light edge; the receiver↔vertex edge is guaranteed by
// the final re-projection, which is a first-hit trace from the receiver.
// Failure to converge is a legitimate outcome, never proof the fiber is
// empty (sms-theory §12.3).
//
// Ported from manifold_ss.cpp (newton_solver:331–405). Constants from the
// SMS release (manifold.h SMSConfig): iteration cap 20, ‖C‖ < 1e-5,
// step-size halving on failed projection with doubling on success, root
// identity by direction dot within 1e-4.
import { Vec3 } from '../math/vec3';
import { Ray } from '../math/ray';
import type { Aggregate, Intersection, Primitive } from '../geometry/aggregate';
import { offsetRayOrigin, RAY_EPSILON, SHADOW_EPSILON } from '../geometry/offset';
import {
  computeStepAnglediff,
  computeStepHalfvector,
  type ConstraintType,
} from './constraints';
import { ManifoldVertex } from './vertex';

export const MAX_ITERATIONS = 20;
export const SOLVER_THRESHOLD = 1e-5;
export const UNIQUENESS_THRESHOLD = 1e-4;

export interface ManifoldWalkOptions {
  constraint: ConstraintType;
  maxIterations: number;
  solverThreshold: number;
  stepScale: number; // < 1 slows the walk down — mostly for visualizations
}

// Named for its module: `integrators/walk.ts` exports an unrelated
// DEFAULT_WALK_OPTIONS, and pt-sms imports from both.
export const DEFAULT_MANIFOLD_WALK_OPTIONS: ManifoldWalkOptions = {
  constraint: 'anglediff',
  maxIterations: MAX_ITERATIONS,
  solverThreshold: SOLVER_THRESHOLD,
  stepScale: 1,
};

// One recorded Newton iterate — the visualizer's candidate point sliding
// on the caster, with its residual for the color ramp.
export interface ManifoldIterate {
  p: Vec3;
  cNorm: number;
}

export type ManifoldWalkOutcome =
  | 'converged'
  | 'diverged' // iteration cap without meeting the threshold
  | 'singular' // constraint Jacobian below the det guard, or degenerate edges
  | 'left-surface' // re-projection kept missing the caster
  | 'invalid-branch' // converged to a reflection when refraction was prescribed (or vice versa)
  | 'occluded'; // valid root, but the vertex↔light edge is blocked

export interface ManifoldWalkResult {
  outcome: ManifoldWalkOutcome;
  vertex: ManifoldVertex | null; // non-null iff outcome is 'converged'
  iterates: ManifoldIterate[];
}

export function manifoldWalk(
  receiverP: Vec3,
  init: Intersection,
  eta: number,
  lightP: Vec3,
  caster: Primitive,
  aggregate: Aggregate,
  options: ManifoldWalkOptions = DEFAULT_MANIFOLD_WALK_OPTIONS,
): ManifoldWalkResult {
  let vtx = new ManifoldVertex(init, eta);
  const iterates: ManifoldIterate[] = [];

  let converged = false;
  let projectionFailed = false;
  let stepFailed = false;
  let beta = 1;
  let iterations = 0;

  while (iterations < options.maxIterations) {
    const step =
      options.constraint === 'halfvector'
        ? computeStepHalfvector(receiverP, vtx, lightP)
        : computeStepAnglediff(receiverP, vtx, lightP);
    if (!step) {
      stepFailed = true;
      break;
    }

    const cNorm = Math.hypot(step.C[0], step.C[1]);
    iterates.push({ p: vtx.p, cNorm });
    if (cNorm < options.solverThreshold) {
      converged = true;
      break;
    }

    // Tangent-plane proposal, then re-project onto the caster by tracing
    // from the receiver through the proposed point. The origin offset is
    // ALONG the ray, never sideways: a lateral offset biases every
    // re-projected point off the true receiver line by RAY_EPSILON, which
    // puts a ~1e-6 floor under the achievable residual (found the hard
    // way — the Newton tail is quadratic until exactly that floor).
    const pProp = vtx.p.sub(
      vtx.dpdu.scale(options.stepScale * beta * step.dX[0]).add(vtx.dpdv.scale(options.stepScale * beta * step.dX[1])),
    );
    const dProp = pProp.sub(receiverP).normalize();
    const ray = new Ray(receiverP.add(dProp.scale(RAY_EPSILON)), dProp);
    const hit = aggregate.intersect(ray);
    if (!hit || hit.primitive !== caster) {
      // Missed the scene or hit another shape: smaller step.
      projectionFailed = true;
      beta = 0.5 * beta;
      iterations += 1;
      continue;
    }
    projectionFailed = false;

    beta = Math.min(1, 2 * beta);
    vtx = new ManifoldVertex(hit, eta);
    iterations += 1;
  }

  if (!converged) {
    return {
      outcome: stepFailed ? 'singular' : projectionFailed ? 'left-surface' : 'diverged',
      vertex: null,
      iterates,
    };
  }

  // Branch validation: the half-vector formulation happily converges to
  // reflection-like roots when refraction was prescribed (SMS Fig. 7);
  // reject any root whose sides disagree with eta (manifold_ss.cpp:390–404).
  const wx = receiverP.sub(vtx.p).normalize();
  const wy = lightP.sub(vtx.p).normalize();
  const refraction = vtx.ng.dot(wx) * vtx.ng.dot(wy) < 0;
  if ((eta === 1 && refraction) || (eta !== 1 && !refraction)) {
    return { outcome: 'invalid-branch', vertex: null, iterates };
  }

  // The vertex↔light edge must be visible (the receiver↔vertex edge
  // already is, by construction of the final re-projection).
  const toLight = lightP.sub(vtx.p);
  const dist = toLight.length();
  const wLight = toLight.scale(1 / dist);
  const shadowRay = new Ray(offsetRayOrigin(vtx.p, vtx.ng, wLight), wLight);
  if (aggregate.intersectP(shadowRay, dist * (1 - SHADOW_EPSILON))) {
    return { outcome: 'occluded', vertex: null, iterates };
  }

  return { outcome: 'converged', vertex: vtx, iterates };
}

// Root identity for deduplication and Bernoulli-trial matching: two
// solutions are the same root when their directions from the receiver
// agree within the uniqueness threshold (manifold_ss.cpp:120).
export function sameSolution(d1: Vec3, d2: Vec3, threshold = UNIQUENESS_THRESHOLD): boolean {
  return Math.abs(d1.dot(d2) - 1) < threshold;
}

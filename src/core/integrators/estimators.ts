// The pieces every camera-driven integrator shares, so that they exist
// once. Before this module the camera-sample preamble was written out six
// times and the direct-lighting estimator three times (pt-nee, pt-sms and
// the ReSTIR driver's surrounding walk) — and the three copies had already
// drifted apart on the delta-light MIS guard.
//
// Nothing here draws a sampler dimension except `cameraSample` (the film
// sample) and `walkFromCamera` (the walk's own, inside randomWalk). The
// NEE dimensions were drawn by the walk and live on the vertex, so
// `directLighting` consumes none — it cannot shift any integrator's
// dimension layout, whatever policy it is handed.
import { Color } from '../math/color';
import type { Ray } from '../math/ray';
import { absDot } from '../math/vec3';
import type { Sample2D } from '../math/sampling';
import { TransportMode, hasNonSpecular } from '../materials/bsdf';
import { occlusionPoint } from '../geometry/visibility';
import type { Scene } from '../scene/scene';
import type { Sampler } from '../sampler/sampler';
import type { Recorder } from '../../trace/recorder';
import { cameraVertex, type PathVertex } from './vertex';
import { randomWalk, type WalkOptions } from './walk';
import { powerHeuristic } from './mis';
import type { Pixel } from './types';

// The film sample: jitter uniformly inside the pixel (box filter) and make
// the primary ray. Split from the walk because pt-term draws its lifetime
// dimension between the two.
export function cameraSample(
  scene: Scene,
  pixel: Pixel,
  sampler: Sampler,
): { raster: Sample2D; ray: Ray } {
  const u = sampler.nextPixel2D();
  const raster: Sample2D = [pixel[0] + u[0], pixel[1] + u[1]];
  return { raster, ray: scene.camera.generateRay(raster) };
}

// Materialize the camera subpath from an already-made primary ray. The
// pinhole carries unit importance, so beta starts WHITE and the endpoint
// vertex is the eye itself.
export function walkFromCamera(
  scene: Scene,
  ray: Ray,
  sampler: Sampler,
  recorder: Recorder,
  options: WalkOptions,
): PathVertex[] {
  const start = cameraVertex(scene.camera, Color.WHITE);
  const { pdfDir } = scene.camera.pdfWe(ray);
  return randomWalk(
    scene, start, ray, Color.WHITE, pdfDir, TransportMode.Radiance, sampler, recorder, options,
  );
}

// Which of the two strategies a caller has taken ownership of elsewhere.
// Both default to "estimate it here" — pt-nee passes nothing.
export interface DirectLightingPolicy {
  // Suppress the BSDF-sampled emitter hit at camera-walk depth k.
  // pt-sms owns the emitter hits of its specular families; ReSTIR owns
  // direct-at-the-primary-vertex, which arrives as the k = 2 hit.
  skipEmitterHit?: (k: number) => boolean;
  // Suppress the explicit light connection at depth k. ReSTIR's reservoir
  // owns the primary vertex's direct lighting.
  skipNEE?: (k: number) => boolean;
}

// Direct lighting at camera-walk vertex k, combining the two strategies
// for emission by the power heuristic over the solid-angle pdfs with which
// EITHER could have produced the same path:
//   (a) the walk's own BSDF-sampled hit on an emitter, and
//   (b) an explicit shadow-ray connection to a sampled light point,
// using the NEE dimensions the walk already drew and stored on the vertex.
// Returns the contribution; the caller has already folded beta in via
// v.beta, so nothing further is applied.
export function directLighting(
  scene: Scene,
  vertices: readonly PathVertex[],
  k: number,
  recorder: Recorder,
  policy: DirectLightingPolicy = {},
): Color {
  const v = vertices[k]!;
  const prev = vertices[k - 1]!;
  let L = Color.BLACK;

  // (a) Emission hit by BSDF sampling. Unweighted from the camera or after
  // a delta bounce (NEE cannot produce those); otherwise weighted against
  // the light strategy that could have connected prev -> v.
  const hitLight = v.primitive?.light;
  if (hitLight && v.wo && !policy.skipEmitterHit?.(k)) {
    const Le = hitLight.le(v.p, v.ng, v.uv, v.wo);
    if (!Le.isBlack()) {
      let weight = 1;
      if (prev.bsdf && prev.wo && prev.wiSampled && !prev.delta) {
        const pBsdf = prev.bsdf.pdf(prev.wo, prev.wiSampled, TransportMode.Radiance);
        const pLight =
          scene.lightDistribution.pmf(hitLight) *
          hitLight.pdfLi({ p: prev.p, ng: prev.ng, ns: prev.ns }, prev.wiSampled);
        weight = powerHeuristic(pBsdf, pLight);
      }
      L = L.add(v.beta.mul(Le).scale(weight));
    }
  }

  // (b) NEE connection from v, using the dimensions the walk drew.
  if (!v.bsdf || !v.wo || !v.neeSamples || !hasNonSpecular(v.bsdf.flags)) return L;
  if (policy.skipNEE?.(k)) return L;

  const selected = scene.lightDistribution.sample(v.neeSamples.select);
  if (!selected) return L;
  const li = selected.light.sampleLi({ p: v.p, ng: v.ng, ns: v.ns }, v.neeSamples.point);
  if (!li) return L;
  const f = v.bsdf.eval(v.wo, li.wi, TransportMode.Radiance);
  if (f.isBlack()) return L;

  const blockedAt = occlusionPoint(scene.aggregate, { p: v.p, ng: v.ng }, li.pLight);
  recorder.shadowRay({
    depth: k,
    from: v.p,
    to: li.pLight.p,
    occluded: blockedAt !== null,
    blockedAt,
  });
  if (blockedAt !== null) return L;

  const pLight = selected.pmf * li.pdf;
  const pBsdf = v.bsdf.pdf(v.wo, li.wi, TransportMode.Radiance);
  // Delta lights admit no competing BSDF strategy: weight 1. Getting this
  // wrong costs ~5% of wall brightness on delta scenes and is invisible
  // everywhere else — it is why this estimator is no longer copy-pasted.
  const weight = selected.light.type === 'area' ? powerHeuristic(pLight, pBsdf) : 1;
  return L.add(v.beta.mul(f).mul(li.L).scale((absDot(li.wi, v.ns) / pLight) * weight));
}

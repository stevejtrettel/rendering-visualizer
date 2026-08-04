// Path tracing with next-event estimation and MIS (power heuristic) — the
// second rung of the talk's ladder. UnidirectionalPT remains untouched
// beside it: integrators accumulate, never replace.
//
// Phase 1: the shared randomWalk (with NEE dimensions drawn per bounce).
// Phase 2: at every surface vertex, combine two strategies for emission —
//   (a) the walk's own BSDF-sampled hit on an emitter,
//   (b) an explicit shadow-ray connection to a sampled light point —
// each weighted by the power heuristic over the pdfs (solid angle at the
// scattering vertex) with which EITHER strategy could have produced it.
import { Color } from '../math/color';
import { absDot } from '../math/vec3';
import { TransportMode, hasNonSpecular } from '../materials/bsdf';
import { occlusionPoint } from '../geometry/visibility';
import type { Scene } from '../scene/scene';
import type { Sampler } from '../sampler/sampler';
import type { Recorder } from '../../trace/recorder';
import { cameraVertex } from './vertex';
import { DEFAULT_WALK_OPTIONS, randomWalk, type WalkOptions } from './walk';
import { powerHeuristic } from './mis';
import type { Contribution, Integrator, Pixel } from './types';

export class NEEPathTracer implements Integrator {
  private readonly options: WalkOptions;

  constructor(options: Partial<WalkOptions> = {}) {
    this.options = { ...DEFAULT_WALK_OPTIONS, ...options, sampleNEE: true };
  }

  sampleContributions(pixel: Pixel, sampler: Sampler, scene: Scene, recorder: Recorder): Contribution[] {
    const u = sampler.nextPixel2D();
    const raster = [pixel[0] + u[0], pixel[1] + u[1]] as const;
    const ray = scene.camera.generateRay(raster);

    const start = cameraVertex(scene.camera, Color.WHITE);
    const { pdfDir } = scene.camera.pdfWe(ray);
    const vertices = randomWalk(
      scene, start, ray, Color.WHITE, pdfDir, TransportMode.Radiance, sampler, recorder, this.options,
    );

    let L = Color.BLACK;
    for (let k = 1; k < vertices.length; k++) {
      const v = vertices[k]!;
      const prev = vertices[k - 1]!;

      // (a) Emission hit by BSDF sampling. Unweighted from the camera or
      // after a delta bounce (NEE cannot produce those); otherwise weighted
      // against the light strategy that could have connected prev -> v.
      const hitLight = v.primitive?.light;
      if (hitLight && v.wo) {
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
      if (v.bsdf && v.wo && v.neeSamples && hasNonSpecular(v.bsdf.flags)) {
        const selected = scene.lightDistribution.sample(v.neeSamples.select);
        if (!selected) continue;
        const li = selected.light.sampleLi({ p: v.p, ng: v.ng, ns: v.ns }, v.neeSamples.point);
        if (!li) continue;
        const f = v.bsdf.eval(v.wo, li.wi, TransportMode.Radiance);
        if (f.isBlack()) continue;

        const blockedAt = occlusionPoint(scene.aggregate, { p: v.p, ng: v.ng }, li.pLight);
        recorder.shadowRay({
          depth: k,
          from: v.p,
          to: li.pLight.p,
          occluded: blockedAt !== null,
          blockedAt,
        });
        if (blockedAt !== null) continue;

        const pLight = selected.pmf * li.pdf;
        const pBsdf = v.bsdf.pdf(v.wo, li.wi, TransportMode.Radiance);
        // Delta lights admit no competing BSDF strategy: weight 1.
        const weight = selected.light.type === 'area' ? powerHeuristic(pLight, pBsdf) : 1;
        L = L.add(
          v.beta.mul(f).mul(li.L).scale((absDot(li.wi, v.ns) / pLight) * weight),
        );
      }
    }

    const contribution: Contribution = { kind: 'sample', raster, value: L };
    recorder.contribution(contribution);
    return [contribution];
  }
}

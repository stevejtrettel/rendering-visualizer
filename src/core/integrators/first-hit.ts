// Level zero: the naive picture-maker before any path tracing. The camera ray
// stops at the first surface it hits and the pixel takes that surface's
// colour, with no lighting and no bounces. It estimates nothing physical;
// it is the starting point the path tracer improves on, and the figure it
// feeds says exactly that.
//
// "The surface's colour" is the same colour the three.js view draws the
// surface in (three-scene.ts), so a pixel visibly matches the object its
// ray landed on.
import { Color } from '../math/color';
import type { SceneDescription } from '../scene/scene';
import type { Scene } from '../scene/scene';
import type { Sampler } from '../sampler/sampler';
import type { Recorder } from '../../trace/recorder';
import { cameraSample, walkFromCamera } from './estimators';
import type { Contribution, Integrator, Pixel } from './types';

/** Glass has no colour of its own; draw it as a pale grey, like the preview. */
const GLASS = new Color(0.85, 0.85, 0.85);

/**
 * Each primitive's display colour, keyed by the name buildScene gives it
 * (`p.name ?? primitive-<i>`). An emitter shows as its emission, normalised
 * so the brightest channel is 1.
 */
export function surfaceColors(desc: SceneDescription): Map<string, Color> {
  const colors = new Map<string, Color>();
  desc.primitives.forEach((p, i) => {
    const name = p.name ?? `primitive-${i}`;
    if (p.emission) {
      const [r, g, b] = p.emission.radiance;
      const m = Math.max(r, g, b) || 1;
      colors.set(name, new Color(r / m, g / m, b / m));
      return;
    }
    const mat = p.material;
    switch (mat.kind) {
      case 'lambert':
        colors.set(name, new Color(...mat.albedo));
        break;
      case 'mirror':
      case 'conductor':
        colors.set(name, new Color(...mat.f0));
        break;
      case 'dielectric':
        colors.set(name, GLASS);
        break;
    }
  });
  return colors;
}

export class FirstHitColor implements Integrator {
  constructor(private readonly colors: ReadonlyMap<string, Color>) {}

  sampleContributions(pixel: Pixel, sampler: Sampler, scene: Scene, recorder: Recorder): Contribution[] {
    const { raster, ray } = cameraSample(scene, pixel, sampler);
    // One surface vertex: [eye, first hit]. The walk records it, so the
    // figure draws exactly this ray.
    const vertices = walkFromCamera(scene, ray, sampler, recorder, {
      maxBounces: 1,
      rrStartDepth: 2,
      sampleNEE: false,
    });
    const hit = vertices[1]?.primitive;
    const value = hit ? (this.colors.get(hit.name) ?? Color.BLACK) : Color.BLACK;
    const contribution: Contribution = { kind: 'sample', raster, value };
    recorder.contribution(contribution);
    return [contribution];
  }
}

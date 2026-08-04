// Regression test for the divergence that motivated the shared estimator
// (docs/design-cleanup.md §F1).
//
// The PT+NEE estimator used to be written out three times — pt-nee,
// pt-sms and the ReSTIR driver's surrounding walk. Each copy needs the
// guard "a delta light admits no competing BSDF strategy, so its NEE
// connection is weighted 1, not by the power heuristic". pt-sms's copy
// once lost it (5% of wall brightness, found by eye); the ReSTIR copy
// still lacked it when this test was written.
//
// The estimator now exists once, in core/integrators/estimators.ts, so
// these tests pin the guard where it lives and pin that the callers
// genuinely share it.
import { describe, expect, it } from 'vitest';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';
import { TransportMode } from '../src/core/materials/bsdf';
import { absDot } from '../src/core/math/vec3';
import { powerHeuristic } from '../src/core/integrators/mis';
import { cameraSample, directLighting, walkFromCamera } from '../src/core/integrators/estimators';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import { SMSPathTracer } from '../src/core/integrators/pt-sms';
import { renderPass } from '../src/render/driver';
import { Film } from '../src/render/film';
import { NULL_RECORDER } from '../src/trace/recorder';

// A closed white room lit ONLY by a point light: every NEE connection in
// the scene is a delta connection, so the guard is on the hot path.
const DELTA_ROOM: SceneDescription = {
  camera: { eye: [0, 2, 7.2], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 0, 4], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ceiling', shape: { kind: 'quad', q: [-2, 4, -2], e1: [4, 0, 0], e2: [0, 0, 4] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'back', shape: { kind: 'quad', q: [-2, 0, -2], e1: [4, 0, 0], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'left', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 4, 0], e2: [0, 0, 4] }, material: { kind: 'lambert', albedo: [0.65, 0.05, 0.05] } },
    { name: 'right', shape: { kind: 'quad', q: [2, 0, -2], e1: [0, 0, 4], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.12, 0.45, 0.15] } },
  ],
  pointLights: [{ p: [0, 3.5, 0], intensity: [30, 30, 30] }],
};

const WALK = { maxBounces: 5, rrStartDepth: 99, sampleNEE: true };

describe('delta-light NEE is weighted 1, not by the power heuristic', () => {
  it('directLighting matches the unweighted estimator and rejects the damped one', () => {
    const scene = buildScene(DELTA_ROOM, 16, 16);
    const sampler = new IndependentSampler(0);
    sampler.startPixelSample(pixelSeedKey(8, 9, 0));
    const { ray } = cameraSample(scene, [8, 9], sampler);
    const vertices = walkFromCamera(scene, ray, sampler, NULL_RECORDER, WALK);
    expect(vertices.length).toBeGreaterThan(1);

    const k = 1;
    const v = vertices[k]!;
    expect(v.neeSamples).not.toBeNull();

    // Rebuild the same connection by hand.
    const selected = scene.lightDistribution.sample(v.neeSamples!.select)!;
    expect(selected.light.type).toBe('deltaPosition');
    const li = selected.light.sampleLi({ p: v.p, ng: v.ng, ns: v.ns }, v.neeSamples!.point)!;
    const f = v.bsdf!.eval(v.wo!, li.wi, TransportMode.Radiance);
    const pLight = selected.pmf * li.pdf;
    const base = v.beta.mul(f).mul(li.L).scale(absDot(li.wi, v.ns) / pLight);

    // A delta light is never HIT, so branch (a) contributes nothing here
    // and directLighting's whole value is the NEE term.
    const got = directLighting(scene, vertices, k, NULL_RECORDER);
    expect(got.r).toBeCloseTo(base.r, 12);

    // The test only discriminates if the damped weight really differs.
    const pBsdf = v.bsdf!.pdf(v.wo!, li.wi, TransportMode.Radiance);
    const damped = powerHeuristic(pLight, pBsdf);
    expect(damped).toBeLessThan(0.99);
    expect(got.r).not.toBeCloseTo(base.scale(damped).r, 12);
  });

  it('pt-nee and pt-sms produce the identical image on a delta scene', () => {
    // pt-sms has no eligible caster here, so its extra strategy is empty
    // and it reduces to pt-nee exactly — which holds only while both go
    // through the one shared estimator. Bit-identical, not merely close.
    const size = 12;
    const spp = 24;
    const scene = buildScene(DELTA_ROOM, size, size);

    const neeFilm = new Film(size, size);
    const neeSampler = new IndependentSampler(0);
    const nee = new NEEPathTracer(WALK);
    for (let s = 0; s < spp; s++) renderPass(scene, nee, neeSampler, neeFilm, s);

    const smsFilm = new Film(size, size);
    const smsSampler = new IndependentSampler(0);
    const sms = new SMSPathTracer(WALK);
    for (let s = 0; s < spp; s++) renderPass(scene, sms, smsSampler, smsFilm, s);

    let checked = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const a = neeFilm.pixel(x, y);
        const b = smsFilm.pixel(x, y);
        expect(b[0]).toBe(a[0]);
        expect(b[1]).toBe(a[1]);
        expect(b[2]).toBe(a[2]);
        if (a[0] > 0) checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(size * size * 0.5); // the scene is actually lit
  });
});

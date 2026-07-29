import { describe, expect, it } from 'vitest';
import { Color } from '../src/core/math/color';
import { TransportMode } from '../src/core/materials/bsdf';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';
import { cameraVertex } from '../src/core/integrators/vertex';
import { randomWalk } from '../src/core/integrators/walk';
import { solidAngleToArea } from '../src/core/geometry/measure';
import { NULL_RECORDER } from '../src/trace/recorder';

// A closed white box so walks bounce many times deterministically.
const BOX: SceneDescription = {
  camera: { eye: [0, 2, 6], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 45 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-4, 0, -4], e1: [8, 0, 0], e2: [0, 0, 8] }, material: { kind: 'lambert', albedo: [0.8, 0.8, 0.8] } },
    { name: 'ceiling', shape: { kind: 'quad', q: [-4, 4, -4], e1: [0, 0, 8], e2: [8, 0, 0] }, material: { kind: 'lambert', albedo: [0.8, 0.8, 0.8] } },
    { name: 'back', shape: { kind: 'quad', q: [-4, 0, -4], e1: [0, 4, 0], e2: [8, 0, 0] }, material: { kind: 'lambert', albedo: [0.8, 0.8, 0.8] } },
    { name: 'sphere', shape: { kind: 'sphere', center: [0, 1, 0], radius: 1 }, material: { kind: 'lambert', albedo: [0.6, 0.6, 0.6] } },
  ],
};

function walkOnce(seed: number, sampleIndex = 0) {
  const scene = buildScene(BOX, 64, 64);
  const sampler = new IndependentSampler(seed);
  sampler.startPixelSample(pixelSeedKey(32, 40, sampleIndex));
  const ray = scene.camera.generateRay([32.5, 40.5]);
  const start = cameraVertex(scene.camera, Color.WHITE);
  const { pdfDir } = scene.camera.pdfWe(ray);
  return randomWalk(scene, start, ray, Color.WHITE, pdfDir, TransportMode.Radiance, sampler, NULL_RECORDER);
}

describe('randomWalk', () => {
  it('materializes camera endpoint plus surface vertices with area-measure pdfs', () => {
    const vertices = walkOnce(1);
    expect(vertices[0]!.type).toBe('camera');
    expect(vertices.length).toBeGreaterThan(1);
    for (const v of vertices.slice(1)) {
      expect(v.type).toBe('surface');
      expect(v.pdfFwd).toBeGreaterThan(0);
      expect(Number.isFinite(v.pdfFwd)).toBe(true);
    }
  });

  it('pdfRev matches the closed form recomputed from stored directions', () => {
    for (let seed = 0; seed < 20; seed++) {
      const vertices = walkOnce(seed);
      // prev.pdfRev was written when the NEXT vertex sampled its direction:
      // pdfRev_w = bsdf_k.pdf(wiSampled, wo) converted to area at v_{k-1}.
      for (let k = 1; k < vertices.length; k++) {
        const v = vertices[k]!;
        const prev = vertices[k - 1]!;
        if (!v.wiSampled || !v.wo || !v.bsdf) continue;
        const pdfRevW = v.bsdf.pdf(v.wiSampled, v.wo, TransportMode.Radiance);
        const expected = solidAngleToArea(pdfRevW, v.p, prev.p, prev.type === 'surface' ? prev.ng : null);
        expect(prev.pdfRev).toBeCloseTo(expected, 10);
      }
    }
  });

  it('is deterministic: same seed key reproduces the identical path', () => {
    const a = walkOnce(7, 3);
    const b = walkOnce(7, 3);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.p.x).toBe(b[i]!.p.x);
      expect(a[i]!.p.y).toBe(b[i]!.p.y);
      expect(a[i]!.p.z).toBe(b[i]!.p.z);
      expect(a[i]!.pdfFwd).toBe(b[i]!.pdfFwd);
      expect(a[i]!.pdfRev).toBe(b[i]!.pdfRev);
      expect(a[i]!.beta.r).toBe(b[i]!.beta.r);
    }
  });

  it('different sample indices give different paths', () => {
    const a = walkOnce(7, 0);
    const b = walkOnce(7, 1);
    const same =
      a.length === b.length &&
      a.every((v, i) => v.p.x === b[i]!.p.x && v.p.y === b[i]!.p.y && v.p.z === b[i]!.p.z);
    expect(same).toBe(false);
  });
});

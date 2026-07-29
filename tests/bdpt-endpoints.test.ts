import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/math/vec3';
import { Color } from '../src/core/math/color';
import { uniformSampleSphere } from '../src/core/math/sampling';
import { Quad } from '../src/core/geometry/quad';
import { solidAngleToArea } from '../src/core/geometry/measure';
import { AreaLight } from '../src/core/lights/area';
import { PinholeCamera } from '../src/core/scene/camera';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { TransportMode } from '../src/core/materials/bsdf';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';
import { lightVertex } from '../src/core/integrators/vertex';
import { randomWalk } from '../src/core/integrators/walk';
import { NULL_RECORDER, type Recorder } from '../src/trace/recorder';
import { ArrayRecorder } from '../src/trace/records';

// Same glass Cornell as tests/glass-scene.test.ts — test scenes stay inline
// and self-contained.
const GLASS_BOX: SceneDescription = {
  camera: { eye: [0, 2, 7.2], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 0, 10], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ceiling', shape: { kind: 'quad', q: [-2, 4, -2], e1: [4, 0, 0], e2: [0, 0, 10] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'back', shape: { kind: 'quad', q: [-2, 0, -2], e1: [4, 0, 0], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'left', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 4, 0], e2: [0, 0, 10] }, material: { kind: 'lambert', albedo: [0.65, 0.05, 0.05] } },
    { name: 'right', shape: { kind: 'quad', q: [2, 0, -2], e1: [0, 0, 10], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.12, 0.45, 0.15] } },
    { name: 'front', shape: { kind: 'quad', q: [-2, 0, 8], e1: [0, 4, 0], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'light', shape: { kind: 'quad', q: [-0.8, 3.998, -0.8], e1: [1.6, 0, 0], e2: [0, 0, 1.6] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [14, 14, 14] } },
    { name: 'glass', shape: { kind: 'sphere', center: [-0.3, 0.8, -0.3], radius: 0.8 }, material: { kind: 'dielectric', ior: 1.5 } },
  ],
};

// The same box with the sphere swapped for a GGX conductor: its pdf is
// asymmetric in (wo, wi) — the argument-order witness Lambert cannot provide.
const GGX_BOX: SceneDescription = {
  ...GLASS_BOX,
  primitives: GLASS_BOX.primitives.map((p) =>
    p.name === 'glass'
      ? { ...p, name: 'metal', material: { kind: 'conductor' as const, f0: [0.9, 0.7, 0.5] as const, roughness: 0.4 } }
      : p,
  ),
};

// Light subpath exactly as CP2's generateLightSubpath will build it: sampleLe,
// lightVertex endpoint, randomWalk in Importance mode.
function lightWalk(desc: SceneDescription, seed: number, sampleIndex: number, recorder: Recorder = NULL_RECORDER) {
  const scene = buildScene(desc, 32, 32);
  const light = scene.lights[0]!;
  const pmf = 1 / scene.lights.length;
  const s = new IndependentSampler(seed);
  s.startPixelSample(pixelSeedKey(0, 0, sampleIndex));
  const le = light.sampleLe(s.next2D(), s.next2D());
  if (!le) return null;
  const start = lightVertex(light, le.ray.o, le.nLight, le.L, le.pdfPos * pmf);
  const beta = le.L.scale(Math.abs(le.nLight.dot(le.ray.d)) / (pmf * le.pdfPos * le.pdfDir));
  return randomWalk(scene, start, le.ray, beta, le.pdfDir, TransportMode.Importance, s, recorder);
}

describe('AreaLight.sampleLe / pdfLe', () => {
  // Ceiling-style quad, normal -y, area 4.
  const quad = new Quad(new Vec3(-1, 3, -1), new Vec3(2, 0, 0), new Vec3(0, 0, 2));
  const light = new AreaLight(quad, new Color(5, 5, 5));

  it('samples the emissive side with exact pdfPos and consistent pdfDir', () => {
    const s = new IndependentSampler(11);
    s.startPixelSample(pixelSeedKey(0, 0, 0));
    for (let i = 0; i < 10_000; i++) {
      const le = light.sampleLe(s.next2D(), s.next2D());
      expect(le).not.toBeNull();
      expect(le!.pdfPos).toBe(1 / 4);
      expect(le!.ray.d.dot(le!.nLight)).toBeGreaterThan(0);
      expect(le!.L.r).toBe(5);
      const { pdfPos, pdfDir } = light.pdfLe(le!.ray.o, le!.nLight, le!.ray.d);
      expect(pdfPos).toBe(1 / 4);
      expect(le!.pdfDir).toBeCloseTo(pdfDir, 12);
    }
  });

  it('pdfDir integrates to 1 over the hemisphere', () => {
    const n = new Vec3(0, -1, 0);
    const p = new Vec3(0, 3, 0);
    const s = new IndependentSampler(13);
    s.startPixelSample(pixelSeedKey(0, 0, 0));
    const N = 200_000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      let w = uniformSampleSphere(s.next2D());
      if (w.dot(n) < 0) w = w.neg();
      // uniform hemisphere pdf = 1/(2 pi)
      sum += light.pdfLe(p, n, w).pdfDir * 2 * Math.PI;
    }
    expect(sum / N).toBeCloseTo(1, 2);
  });
});

describe('PinholeCamera importance (we / sampleWi)', () => {
  it('t=1 importance integral over a flat emissive plane is flat (the cos^4 chain)', () => {
    const W = 8;
    const H = 8;
    const cam = new PinholeCamera({
      eye: new Vec3(0, 0, 0),
      lookAt: new Vec3(0, 0, -1),
      up: new Vec3(0, 1, 0),
      fovDegrees: 60,
      width: W,
      height: H,
    });
    // Plane at z = -2 facing the camera, covering the whole 60-degree frustum.
    const plane = new Quad(new Vec3(-1.7, -1.7, -2), new Vec3(3.4, 0, 0), new Vec3(0, 3.4, 0));
    const L = 2;

    // Surface-form measurement: sample x uniformly on the plane, splat
    // We_surf * |wi . n_x| * L / pdf_A at the raster sampleWi reports. Each
    // pixel then estimates L / numPixels — flatness catches a wrong cosine
    // power, the absolute value catches a wrong film-area normalization.
    const s = new IndependentSampler(17);
    s.startPixelSample(pixelSeedKey(0, 0, 0));
    const N = 1_000_000;
    const bins = new Float64Array(W * H);
    for (let i = 0; i < N; i++) {
      const x = plane.sampleArea(s.next2D());
      const sw = cam.sampleWi(x.p);
      if (!sw) continue;
      const px = Math.floor(sw.raster[0]);
      const py = Math.floor(sw.raster[1]);
      bins[py * W + px]! += (sw.We * Math.abs(sw.wi.dot(x.ng)) * L) / (x.pdf * N);
    }
    let total = 0;
    for (let j = 0; j < W * H; j++) {
      const pixel = bins[j]! * W * H;
      total += pixel;
      expect(Math.abs(pixel - L) / L).toBeLessThan(0.05);
    }
    expect(total / (W * H)).toBeCloseTo(L, 1);
  });

  it('raster round-trips through generateRay and sampleWi', () => {
    const scene = buildScene(GLASS_BOX, 32, 32);
    const cam = scene.camera;
    const rasters: ReadonlyArray<readonly [number, number]> = [
      [0.5, 0.5], [31.5, 31.5], [16.2, 7.8], [3.3, 28.9],
    ];
    for (const r of rasters) {
      const ray = cam.generateRay(r);
      const sw = cam.sampleWi(ray.at(2.5));
      expect(sw).not.toBeNull();
      expect(Math.abs(sw!.raster[0] - r[0])).toBeLessThan(1e-6);
      expect(Math.abs(sw!.raster[1] - r[1])).toBeLessThan(1e-6);
      expect(sw!.dist).toBeCloseTo(2.5, 10);
      expect(sw!.pdf).toBe(1);
      expect(sw!.We).toBeGreaterThan(0);
      expect(sw!.wi.add(ray.d).length()).toBeLessThan(1e-9);
    }
    // Behind the camera and outside the film both reject.
    const forwardRay = cam.generateRay([16, 16]);
    expect(cam.sampleWi(cam.eye.sub(forwardRay.d.scale(3)))).toBeNull();
    expect(cam.sampleWi(new Vec3(50, 2, 7.2))).toBeNull();
  });
});

describe('light-subpath walk (Importance mode)', () => {
  it('materializes tagged light walks with finite area pdfs on the glass Cornell', () => {
    let reachedDepth3 = 0;
    for (let seed = 0; seed < 32; seed++) {
      const vertices = lightWalk(GLASS_BOX, seed, 0);
      expect(vertices).not.toBeNull();
      expect(vertices![0]!.type).toBe('light');
      expect(vertices![0]!.light).not.toBeNull();
      expect(vertices![0]!.pdfFwd).toBeGreaterThan(0);
      for (const v of vertices!.slice(1)) {
        expect(v.type).toBe('surface');
        expect(Number.isFinite(v.pdfFwd)).toBe(true);
        expect(v.pdfFwd).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(v.pdfRev)).toBe(true);
        expect(Number.isFinite(v.beta.r)).toBe(true);
      }
      if (vertices!.length >= 4) reachedDepth3 += 1;
    }
    expect(reachedDepth3).toBeGreaterThan(0);
  });

  it('records the walk under lightVertices, not vertices', () => {
    const recorder = new ArrayRecorder();
    recorder.beginPath(pixelSeedKey(0, 0, 0));
    const vertices = lightWalk(GLASS_BOX, 3, 0, recorder);
    recorder.endPath();
    const record = recorder.records[0]!;
    expect(record.lightVertices.length).toBe(vertices!.length);
    expect(record.vertices.length).toBe(0);
    expect(record.lightVertices[0]!.type).toBe('light');
  });

  it('is deterministic', () => {
    const a = lightWalk(GLASS_BOX, 7, 3)!;
    const b = lightWalk(GLASS_BOX, 7, 3)!;
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

  it('uses the light-side wo argument order at GGX vertices (order trap)', () => {
    // GGX's VNDF pdf is asymmetric in (wo, wi); Lambert scenes cannot
    // witness a swapped-argument bug (see design-v2). Verify the stored
    // pdfFwd/pdfRev match the correct orders at a vertex where the two
    // orders measurably differ.
    let witnessed = 0;
    for (let seed = 0; seed < 100 && witnessed === 0; seed++) {
      const vertices = lightWalk(GGX_BOX, seed, 0);
      if (!vertices) continue;
      for (let k = 1; k < vertices.length - 1; k++) {
        const v = vertices[k]!;
        if (v.primitive?.name !== 'metal' || !v.wo || !v.wiSampled || !v.bsdf) continue;
        const next = vertices[k + 1]!;
        const prev = vertices[k - 1]!;
        // wo points toward the previous (light-side) vertex: the walk's
        // forward density is pdf(wo, wiSampled), the reverse pdf(wiSampled, wo).
        const pdfFwdW = v.bsdf.pdf(v.wo, v.wiSampled, TransportMode.Importance);
        const pdfRevW = v.bsdf.pdf(v.wiSampled, v.wo, TransportMode.Importance);
        expect(next.pdfFwd).toBeCloseTo(solidAngleToArea(pdfFwdW, v.p, next.p, next.ng), 10);
        expect(prev.pdfRev).toBeCloseTo(
          solidAngleToArea(pdfRevW, v.p, prev.p, prev.type === 'camera' ? null : prev.ng),
          10,
        );
        if (Math.abs(pdfFwdW - pdfRevW) > 0.01 * Math.max(pdfFwdW, pdfRevW)) witnessed += 1;
      }
    }
    expect(witnessed).toBeGreaterThan(0);
  });
});

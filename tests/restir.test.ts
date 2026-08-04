import { describe, expect, it } from 'vitest';
import { SCENES } from '../src/scenes/registry';
import { buildScene, type Scene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';
import { PowerLightSampler } from '../src/core/lights/power';
import { SurfaceBSDF } from '../src/core/materials/surface';
import { TransportMode, hasNonSpecular } from '../src/core/materials/bsdf';
import { occlusionPoint } from '../src/core/geometry/visibility';
import { absDot } from '../src/core/math/vec3';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import { renderPass } from '../src/render/driver';
import { Film } from '../src/render/film';
import { RestirRunner, type RestirOptions } from '../src/render/restir-driver';
import { ArrayRecorder } from '../src/trace/records';
import type { ScenePrimitive } from '../src/core/scene/scene';

// The compact test Cornell (bdpt/mmlt test convention: self-contained).
const CORNELL: SceneDescription = {
  camera: { eye: [0, 2, 7.2], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 0, 4], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ceiling', shape: { kind: 'quad', q: [-2, 4, -2], e1: [4, 0, 0], e2: [0, 0, 4] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'back', shape: { kind: 'quad', q: [-2, 0, -2], e1: [4, 0, 0], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'left', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 4, 0], e2: [0, 0, 4] }, material: { kind: 'lambert', albedo: [0.65, 0.05, 0.05] } },
    { name: 'right', shape: { kind: 'quad', q: [2, 0, -2], e1: [0, 0, 4], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.12, 0.45, 0.15] } },
    { name: 'light', shape: { kind: 'quad', q: [-0.8, 3.998, -0.8], e1: [1.6, 0, 0], e2: [0, 0, 1.6] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [14, 14, 14] } },
    { name: 'ball', shape: { kind: 'sphere', center: [-0.9, 0.8, -0.6], radius: 0.8 }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
  ],
};

const SIZE = 16;

// Independent NEE-DI reference: reflected direct illumination only, power
// light selection, SOLID-ANGLE estimator form — a genuinely different code
// path from the driver's area-measure p̂ (cross-checks the measure math).
function neeDiReference(scene: Scene, size: number, spp: number, seed: number): Float64Array {
  const out = new Float64Array(size * size * 3);
  const sampler = new IndependentSampler(seed);
  const power = new PowerLightSampler(scene.lights);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let s = 0; s < spp; s++) {
        sampler.startPixelSample(pixelSeedKey(x, y, s));
        const u = sampler.nextPixel2D();
        const ray = scene.camera.generateRay([x + u[0], y + u[1]]);
        const isect = scene.aggregate.intersect(ray);
        if (!isect) continue;
        const primitive = isect.primitive as ScenePrimitive;
        if (!hasNonSpecular(primitive.bxdf.flags)) continue;
        const bsdf = new SurfaceBSDF(primitive.bxdf, isect.ns, isect.ng);
        const wo = ray.d.neg();
        const selected = power.sample(sampler.next1D());
        if (!selected) continue;
        const li = selected.light.sampleLi({ p: isect.p, ng: isect.ng, ns: isect.ns }, sampler.next2D());
        if (!li) continue;
        const f = bsdf.eval(wo, li.wi, TransportMode.Radiance);
        if (f.isBlack()) continue;
        if (occlusionPoint(scene.aggregate, { p: isect.p, ng: isect.ng }, li.pLight) !== null) continue;
        const scale = absDot(li.wi, isect.ns) / (selected.pmf * li.pdf * spp);
        const o = (y * size + x) * 3;
        out[o]! += f.r * li.L.r * scale;
        out[o + 1]! += f.g * li.L.g * scale;
        out[o + 2]! += f.b * li.L.b * scale;
      }
    }
  }
  return out;
}

function runRestir(scene: Scene, size: number, passes: number, options: Partial<RestirOptions>): Film {
  const film = new Film(size, size);
  const runner = new RestirRunner(scene, film, options);
  for (let p = 0; p < passes; p++) runner.pass();
  return film;
}

function filmRgb(film: Film, size: number): Float64Array {
  const out = new Float64Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = film.pixel(x, y);
      const o = (y * size + x) * 3;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
  }
  return out;
}

// 4×4-block mean brightness comparison; returns max relative block error.
function maxBlockError(a: Float64Array, b: Float64Array, size: number): number {
  let worst = 0;
  for (let by = 0; by < size; by += 4) {
    for (let bx = 0; bx < size; bx += 4) {
      let sa = 0;
      let sb = 0;
      for (let y = by; y < by + 4; y++) {
        for (let x = bx; x < bx + 4; x++) {
          const o = (y * size + x) * 3;
          sa += a[o]! + a[o + 1]! + a[o + 2]!;
          sb += b[o]! + b[o + 1]! + b[o + 2]!;
        }
      }
      if (sb > 1e-9) worst = Math.max(worst, Math.abs(sa - sb) / sb);
    }
  }
  return worst;
}

const mean = (a: Float64Array): number => a.reduce((s, v) => s + v, 0) / a.length;

// The staged validation ladder (course Tip 4.4; design-v4 checkpoints).
const DI_BASE: Partial<RestirOptions> = {
  candidates: 8,
  directOnly: true,
  temporal: false,
  spatialRounds: 0,
  spatialRadiusPx: 4,
  assertWeights: true,
  seed: 5,
};

describe('ReSTIR validation ladder (direct component)', () => {
  const scene = buildScene(CORNELL, SIZE, SIZE);
  const ref = neeDiReference(scene, SIZE, 600, 90);

  it('(a) candidates-only RIS matches the NEE-DI reference', { timeout: 60_000 }, () => {
    const img = filmRgb(runRestir(scene, SIZE, 250, DI_BASE), SIZE);
    expect(Math.abs(mean(img) - mean(ref)) / mean(ref)).toBeLessThan(0.02);
    expect(maxBlockError(img, ref, SIZE)).toBeLessThan(0.12);
  });

  it('(b) spatial reuse with pairwise MIS stays unbiased; 1/M weights do not', { timeout: 120_000 }, () => {
    const spatial: Partial<RestirOptions> = { ...DI_BASE, spatialRounds: 2, spatialNeighbors: 5 };
    const img = filmRgb(runRestir(scene, SIZE, 250, spatial), SIZE);
    const fair = maxBlockError(img, ref, SIZE);
    expect(Math.abs(mean(img) - mean(ref)) / mean(ref)).toBeLessThan(0.02);
    expect(fair).toBeLessThan(0.12);

    // Negative control, with the similarity gates DISABLED: the gates are
    // Bitterli 2020's bias-hiding heuristic (measured here: they shrink the
    // 1/M error from ~18% to ~1%), so the honest control removes them.
    // Pairwise MIS must stay unbiased even ungated; 1/M must darken hard.
    const noGates = { normalDotMin: -2, depthRelMax: 1e9 };
    const fairUngated = filmRgb(
      runRestir(scene, SIZE, 250, { ...spatial, ...noGates }),
      SIZE,
    );
    expect(Math.abs(mean(fairUngated) - mean(ref)) / mean(ref)).toBeLessThan(0.02);

    const biased = filmRgb(
      runRestir(scene, SIZE, 250, { ...spatial, ...noGates, mis: 'oneOverM', assertWeights: false }),
      SIZE,
    );
    const biasErr = (mean(ref) - mean(biased)) / mean(ref); // signed: darkening
    expect(biasErr).toBeGreaterThan(0.1);
  });

  it('(c) temporal reuse stays unbiased in the long run', { timeout: 120_000 }, () => {
    const img = filmRgb(
      runRestir(scene, SIZE, 300, { ...DI_BASE, temporal: true, spatialRounds: 2, spatialNeighbors: 5 }),
      SIZE,
    );
    expect(Math.abs(mean(img) - mean(ref)) / mean(ref)).toBeLessThan(0.02);
    expect(maxBlockError(img, ref, SIZE)).toBeLessThan(0.12);
  });
});

describe('ReSTIR full transport', () => {
  it('(d) converges to pt-nee on cornell at the shared depth cap', { timeout: 120_000 }, () => {
    const scene = buildScene(CORNELL, SIZE, SIZE);
    const film = runRestir(scene, SIZE, 300, {
      candidates: 8, spatialRounds: 2, spatialNeighbors: 5, spatialRadiusPx: 4,
      temporal: true, maxBounces: 8, assertWeights: true, seed: 7,
    });
    const refFilm = new Film(SIZE, SIZE);
    const sampler = new IndependentSampler(71);
    const nee = new NEEPathTracer({ maxBounces: 8 });
    for (let i = 0; i < 400; i++) renderPass(scene, nee, sampler, refFilm, i);
    const img = filmRgb(film, SIZE);
    const ref = filmRgb(refFilm, SIZE);
    expect(Math.abs(mean(img) - mean(ref)) / mean(ref)).toBeLessThan(0.03);
    expect(maxBlockError(img, ref, SIZE)).toBeLessThan(0.12);
  });

  it('(f) converges to pt-nee on the chandelier (64 lights)', { timeout: 180_000 }, () => {
    const scene = buildScene(SCENES.chandelier, SIZE, SIZE);
    const film = runRestir(scene, SIZE, 300, {
      candidates: 8, spatialRounds: 2, spatialNeighbors: 5, spatialRadiusPx: 4,
      temporal: true, maxBounces: 8, seed: 9,
    });
    const refFilm = new Film(SIZE, SIZE);
    const sampler = new IndependentSampler(91);
    const nee = new NEEPathTracer({ maxBounces: 8 });
    for (let i = 0; i < 800; i++) renderPass(scene, nee, sampler, refFilm, i);
    const img = filmRgb(film, SIZE);
    const ref = filmRgb(refFilm, SIZE);
    expect(Math.abs(mean(img) - mean(ref)) / mean(ref)).toBeLessThan(0.04);
    expect(maxBlockError(img, ref, SIZE)).toBeLessThan(0.15);
  });

  it('handles delta primaries (glass) without the reservoir', { timeout: 60_000 }, () => {
    const scene = buildScene(SCENES['cornell-glass'], 12, 12);
    const film = runRestir(scene, 12, 40, {
      candidates: 4, spatialRounds: 1, spatialNeighbors: 3, spatialRadiusPx: 3,
      temporal: true, maxBounces: 6, seed: 11,
    });
    const img = filmRgb(film, 12);
    expect(img.every((v) => Number.isFinite(v))).toBe(true);
    expect(mean(img)).toBeGreaterThan(0);
  });
});

describe('ReSTIR determinism and recording', () => {
  it('(e) same seed gives bit-identical film and reservoirs', () => {
    const opts: Partial<RestirOptions> = {
      candidates: 6, spatialRounds: 2, spatialNeighbors: 4, spatialRadiusPx: 3,
      temporal: true, maxBounces: 4, seed: 3,
    };
    const snapshot = (): { data: number[]; res: string } => {
      const scene = buildScene(CORNELL, 8, 8);
      const film = new Film(8, 8);
      const runner = new RestirRunner(scene, film, opts);
      for (let p = 0; p < 3; p++) runner.pass();
      const res = runner.reservoirs
        .map((r) => (r.y ? `${r.y.p.x.toFixed(12)},${r.y.p.z.toFixed(12)},${r.W.toExponential(10)},${r.confidence}` : 'null'))
        .join('|');
      return { data: Array.from(film.data), res };
    };
    const a = snapshot();
    const b = snapshot();
    expect(a.data).toEqual(b.data);
    expect(a.res).toBe(b.res);
  });

  it('emits one reuse-lineage event per pixel per pass', () => {
    const scene = buildScene(CORNELL, 8, 8);
    const film = new Film(8, 8);
    const runner = new RestirRunner(scene, film, {
      candidates: 6, spatialRounds: 1, spatialNeighbors: 4, spatialRadiusPx: 3, temporal: true, seed: 1,
    });
    runner.pass();
    const recorder = new ArrayRecorder();
    runner.pass(recorder);
    expect(recorder.records.length).toBe(64);
    const reuses = recorder.records.flatMap((r) => r.reuses);
    expect(reuses.length).toBe(64);
    const sources = new Set(reuses.map((r) => r.source));
    expect(reuses.every((r) => ['none', 'fresh', 'temporal', 'spatial'].includes(r.source))).toBe(true);
    // With temporal + spatial on, reuse should actually be happening.
    expect(sources.has('temporal') || sources.has('spatial')).toBe(true);
    for (const r of reuses.filter((r) => r.source === 'spatial')) {
      expect(r.from).not.toBeNull();
    }
  });
});

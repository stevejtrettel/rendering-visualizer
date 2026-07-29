import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/math/vec3';
import { Color } from '../src/core/math/color';
import type { Sample2D } from '../src/core/math/sampling';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { SurfaceBSDF } from '../src/core/materials/surface';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';
import { cameraVertex, lightVertex, type PathVertex } from '../src/core/integrators/vertex';
import { BDPT, DEFAULT_BDPT_OPTIONS, connectStrategy, type BDPTOptions } from '../src/core/integrators/bdpt';
import { UnidirectionalPT } from '../src/core/integrators/pt';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import type { Integrator } from '../src/core/integrators/types';
import { renderPass } from '../src/render/driver';
import { Film } from '../src/render/film';
import { NULL_RECORDER } from '../src/trace/recorder';
import { ArrayRecorder } from '../src/trace/records';

// NOTE on SDS paths (pbrt-v4 issue #326): on specular-diffuse-specular
// transport (the caustic seen THROUGH the glass sphere) every connection
// strategy except plain BSDF sampling is impossible — both junction sides
// are delta — so the MIS weight is legitimately 1 and BDPT degenerates to
// unidirectional PT there. That is CORRECT behavior, not a bug; it is V3's
// (MLT's) motivation.

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

// Full-frame render; returns the film. splatScale 1/spp at read time.
function render(desc: SceneDescription, integrator: Integrator, size: number, spp: number, seed: number): Film {
  const scene = buildScene(desc, size, size);
  const film = new Film(size, size);
  const sampler = new IndependentSampler(seed);
  for (let i = 0; i < spp; i++) renderPass(scene, integrator, sampler, film, i);
  return film;
}

function imageMean(film: Film, spp: number): number {
  let sum = 0;
  for (let y = 0; y < film.height; y++) {
    for (let x = 0; x < film.width; x++) {
      const [r, g, b] = film.pixel(x, y, { splatScale: 1 / spp });
      sum += r + g + b;
    }
  }
  return sum / (film.width * film.height);
}

describe('hand-built 3-vertex path: closed forms vs vertex bookkeeping', () => {
  // Geometry chosen for clean closed forms: a Lambert floor at y=0 (normal
  // +y), a unit-area light at y=2 (normal -y), camera on the +z axis.
  const ALBEDO = 0.6;
  const LE = 10;
  const SCENE_DESC: SceneDescription = {
    camera: { eye: [0, 1, 3], lookAt: [0, 1, 0], up: [0, 1, 0], fovDegrees: 45 },
    primitives: [
      { name: 'floor', shape: { kind: 'quad', q: [-5, 0, -5], e1: [0, 0, 10], e2: [10, 0, 0] }, material: { kind: 'lambert', albedo: [ALBEDO, ALBEDO, ALBEDO] } },
      { name: 'light', shape: { kind: 'quad', q: [-0.5, 2, -0.5], e1: [1, 0, 0], e2: [0, 0, 1] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [LE, LE, LE] } },
    ],
  };
  const scene = buildScene(SCENE_DESC, 64, 64);
  const floor = scene.primitives.find((p) => p.name === 'floor')!;
  const lightPrim = scene.primitives.find((p) => p.name === 'light')!;
  const light = lightPrim.light!;

  // The path: eye -> x1 (floor) -> y (light). y is where sampleArea maps
  // u = [0.75, 0.5]: q + 0.75 e1 + 0.5 e2.
  const eye = new Vec3(0, 1, 3);
  const x1 = new Vec3(0, 0, 0);
  const y = new Vec3(0.25, 2, 0);
  const nFloor = new Vec3(0, 1, 0);
  const nLight = new Vec3(0, -1, 0);
  const S1_POINT: Sample2D = [0.75, 0.5];

  // --- Closed-form area-product densities, written out independently ---
  const d0 = x1.sub(eye);
  const dist0Sq = d0.lengthSq();
  const w0 = d0.normalize(); // eye -> x1
  const d1 = y.sub(x1);
  const dist1Sq = d1.lengthSq();
  const w1 = d1.normalize(); // x1 -> y
  const tanHalf = Math.tan((45 * Math.PI) / 360);
  const filmA = 4 * tanHalf * tanHalf; // aspect 1
  const cosCam = w0.dot(new Vec3(0, 0, -1));
  // camera -> x1: film-area direction density to area at x1
  const pCam1 = (1 / (filmA * cosCam ** 3)) * (Math.abs(w0.dot(nFloor)) / dist0Sq);
  // x1 -> y: Lambert cosine pdf to area at y
  const cosAtX1 = w1.dot(nFloor);
  const cosAtLight = w1.neg().dot(nLight);
  const pCam2 = (cosAtX1 / Math.PI) * (cosAtLight / dist1Sq);
  // light origin (uniform area, single light) and emission toward x1
  const pL2 = 1; // pmf 1 x 1/area 1
  const pL1 = (cosAtLight / Math.PI) * (cosAtX1 / dist1Sq);

  const p03 = pCam1 * pCam2;
  const p12 = pCam1 * pL2;
  const p21 = pL2 * pL1;
  const wOf = (p: number, beta: number) =>
    p ** beta / (p03 ** beta + p12 ** beta + p21 ** beta);

  // --- The same path as walk-style vertex arrays with live refs ---
  const surfaceVertex = (
    p: Vec3, n: Vec3, prim: typeof floor, beta: number, pdfFwd: number, wo: Vec3,
  ): PathVertex => ({
    type: 'surface', p, ng: n, ns: n, uv: [0, 0],
    beta: new Color(beta, beta, beta), pdfFwd, pdfRev: 0, delta: false,
    wo, wiSampled: null, neeSamples: null,
    bsdf: new SurfaceBSDF(prim.bxdf, n, n), primitive: prim, camera: null, light: null,
  });

  const z0 = cameraVertex(scene.camera, Color.WHITE);
  const x1Cam = surfaceVertex(x1, nFloor, floor, 1, pCam1, w0.neg());
  // arriving beta after a cosine-sampled Lambert bounce is exactly the albedo
  const yCam = surfaceVertex(y, nLight, lightPrim, ALBEDO, pCam2, w1.neg());
  const y0 = lightVertex(light, y, nLight, new Color(LE, LE, LE), pL2);
  const x1Light = surfaceVertex(x1, nFloor, floor, LE * Math.PI, pL1, w1);

  const opts = (over: Partial<BDPTOptions>): BDPTOptions => ({
    ...DEFAULT_BDPT_OPTIONS, assertWeights: true, ...over,
  });

  it('matches closed-form MIS weights per strategy and sums to 1 (both heuristics)', () => {
    for (const heuristic of ['power', 'balance'] as const) {
      const beta = heuristic === 'power' ? 2 : 1;
      const o = opts({ heuristic });
      const r03 = connectStrategy(scene, [z0, x1Cam, yCam], [], 0, 3, o, null)!;
      const r12 = connectStrategy(scene, [z0, x1Cam], [], 1, 2, o, { select: 0.1, point: S1_POINT })!;
      const r21 = connectStrategy(scene, [z0], [y0, x1Light], 2, 1, o, null)!;
      expect(r03.weight).toBeCloseTo(wOf(p03, beta), 10);
      expect(r12.weight).toBeCloseTo(wOf(p12, beta), 10);
      expect(r21.weight).toBeCloseTo(wOf(p21, beta), 10);
      expect(r03.weight + r12.weight + r21.weight).toBeCloseTo(1, 10);
    }
  });

  it('matches closed-form unweighted contributions (s=1 substitution density included)', () => {
    const o = opts({});
    // s=0: throughput at the emitter times Le.
    const r03 = connectStrategy(scene, [z0, x1Cam, yCam], [], 0, 3, o, null)!;
    expect(r03.unweighted.r).toBeCloseTo(ALBEDO * LE, 10);
    // s=1: NEE form — beta f Le cos / (pmf pdf_solidangle), with
    // pdf_sa = (1/area) dist^2 / cos_light.
    const r12 = connectStrategy(scene, [z0, x1Cam], [], 1, 2, o, { select: 0.1, point: S1_POINT })!;
    const pdfSa = dist1Sq / cosAtLight; // area 1, pmf 1
    expect(r12.unweighted.r).toBeCloseTo((ALBEDO / Math.PI) * LE * (cosAtX1 / pdfSa), 10);
    expect(r12.connection!.to.x).toBeCloseTo(y.x, 12);
    expect(r12.connection!.to.z).toBeCloseTo(y.z, 12);
    // t=1: light-tracing form — beta f We_surf cos, with
    // We_surf = 1/(A cos^3 d^2).
    const r21 = connectStrategy(scene, [z0], [y0, x1Light], 2, 1, o, null)!;
    const weSurf = 1 / (filmA * cosCam ** 3 * dist0Sq);
    expect(r21.raster).not.toBeNull();
    expect(r21.unweighted.r).toBeCloseTo(
      LE * Math.PI * (ALBEDO / Math.PI) * weSurf * Math.abs(w0.neg().dot(nFloor)), 10,
    );
  });
});

describe('BDPT vs the other integrators', () => {
  it('unweighted light tracing (t=1 plus direct emission) matches PT on the diffuse Cornell', () => {
    const lightTracer = new BDPT({
      strategyFilter: (s, t) => t === 1 || (s === 0 && t === 2),
      unweighted: true,
      assertWeights: true,
    });
    const spp = 120;
    const lt = imageMean(render(CORNELL, lightTracer, 16, spp, 11), spp);
    const pt = imageMean(render(CORNELL, new UnidirectionalPT(), 16, 400, 12), 400);
    expect(Math.abs(lt - pt) / pt).toBeLessThan(0.05);
  });

  it('full BDPT matches NEE on the diffuse Cornell (tight)', () => {
    const spp = 100;
    const bdpt = imageMean(render(CORNELL, new BDPT({ assertWeights: true }), 16, spp, 21), spp);
    const nee = imageMean(render(CORNELL, new NEEPathTracer(), 16, 300, 22), 300);
    expect(Math.abs(bdpt - nee) / nee).toBeLessThan(0.04);
  });

  it('FLAGSHIP: BDPT matches NEE on the glass-box caustic', { timeout: 60_000 }, () => {
    // NEE reference at a handful of pixels (floor caustic region, glass,
    // walls) — the same pixels glass-scene.test.ts uses.
    const pixels = [[16, 26], [14, 19], [8, 16], [24, 16]] as const;
    const neeScene = buildScene(GLASS_BOX, 32, 32);
    const nee = new NEEPathTracer();
    const s = new IndependentSampler(31);
    let neeSum = 0;
    const neeSpp = 3000;
    for (const pixel of pixels) {
      for (let i = 0; i < neeSpp; i++) {
        s.startPixelSample(pixelSeedKey(pixel[0], pixel[1], i));
        const [c] = nee.sampleContributions(pixel, s, neeScene, NULL_RECORDER);
        neeSum += c!.value.r + c!.value.g + c!.value.b;
      }
    }
    const neeMean = neeSum / (pixels.length * neeSpp);

    // BDPT needs the full frame (splats land everywhere); far fewer spp
    // suffice — that is the point of the figure this test guards.
    const spp = 60;
    const film = render(GLASS_BOX, new BDPT({ assertWeights: true }), 32, spp, 32);
    let bdptSum = 0;
    for (const [x, py] of pixels) {
      const [r, g, b] = film.pixel(x, py, { splatScale: 1 / spp });
      bdptSum += r + g + b;
    }
    const bdptMean = bdptSum / pixels.length;
    expect(Math.abs(bdptMean - neeMean) / neeMean).toBeLessThan(0.1);
  });

  it('white furnace: closed emissive box converges to Le/(1-albedo), flat', () => {
    const rho = 0.5;
    const Le = 1;
    const wall = (name: string, q: readonly [number, number, number], e1: readonly [number, number, number], e2: readonly [number, number, number]) => ({
      name,
      shape: { kind: 'quad' as const, q, e1, e2 },
      material: { kind: 'lambert' as const, albedo: [rho, rho, rho] as const },
      emission: { radiance: [Le, Le, Le] as const },
    });
    const FURNACE: SceneDescription = {
      camera: { eye: [0, 0, 0.6], lookAt: [0, 0, -1], up: [0, 1, 0], fovDegrees: 60 },
      primitives: [
        wall('floor', [-1, -1, -1], [0, 0, 2], [2, 0, 0]),
        wall('ceiling', [-1, 1, -1], [2, 0, 0], [0, 0, 2]),
        wall('back', [-1, -1, -1], [2, 0, 0], [0, 2, 0]),
        wall('front', [-1, -1, 1], [0, 2, 0], [2, 0, 0]),
        wall('left', [-1, -1, -1], [0, 2, 0], [0, 0, 2]),
        wall('right', [1, -1, -1], [0, 0, 2], [0, 2, 0]),
      ],
    };
    const expected = Le / (1 - rho); // equilibrium radiance, every direction
    const spp = 100;
    const film = render(FURNACE, new BDPT({ assertWeights: true }), 6, spp, 41);
    let mean = 0;
    for (let py = 0; py < 6; py++) {
      for (let x = 0; x < 6; x++) {
        const [r] = film.pixel(x, py, { splatScale: 1 / spp });
        mean += r;
        expect(Math.abs(r - expected) / expected).toBeLessThan(0.08);
      }
    }
    expect(mean / 36).toBeCloseTo(expected, 1);
  });
});

describe('BDPT determinism and recording', () => {
  it('contributions and records replay exactly from seed keys (glass box)', () => {
    const run = () => {
      const scene = buildScene(GLASS_BOX, 32, 32);
      const bdpt = new BDPT({ assertWeights: true });
      const s = new IndependentSampler(7);
      const recorder = new ArrayRecorder();
      const values: number[] = [];
      for (let i = 0; i < 50; i++) {
        const key = pixelSeedKey(14, 19, i);
        s.startPixelSample(key);
        recorder.beginPath(key);
        for (const c of bdpt.sampleContributions([14, 19], s, scene, recorder)) {
          values.push(c.raster[0], c.raster[1], c.value.r, c.value.g, c.value.b);
        }
        recorder.endPath();
      }
      return { values, records: recorder.records };
    };
    const a = run();
    const b = run();
    expect(a.values).toEqual(b.values);
    expect(a.records).toEqual(b.records);
    // The recorder captured both subpaths and connection attempts.
    expect(a.records.some((r) => r.lightVertices.length > 0)).toBe(true);
    const connections = a.records.flatMap((r) => r.connections);
    expect(connections.length).toBeGreaterThan(0);
    expect(connections.some((c) => c.occluded)).toBe(true);
    expect(connections.some((c) => !c.occluded && c.weight > 0)).toBe(true);
  });
});

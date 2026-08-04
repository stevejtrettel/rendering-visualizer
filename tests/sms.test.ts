// The SMS integrator (V5): partition correctness on caster-free scenes,
// cross-integrator convergence on the glass-bulb scene (a light inside a
// solid glass sphere — plain NEE is ALWAYS occluded there, so pt-nee's
// shadow rays contribute zero and the caustic transport routes entirely
// through BSDF luck or the manifold solve), the estimator ladder's
// negative control (biased M = 1 must measurably undercount a multi-root
// fiber), determinism, and the recorder events.
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/math/vec3';
import { Color } from '../src/core/math/color';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';
import { UnidirectionalPT } from '../src/core/integrators/pt';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import {
  SMSPathTracer,
  smsConnect,
  DEFAULT_SMS_OPTIONS,
  type SMSPTOptions,
} from '../src/core/integrators/pt-sms';
import type { Integrator } from '../src/core/integrators/types';
import { SurfaceBSDF } from '../src/core/materials/surface';
import { Lambert } from '../src/core/materials/lambert';
import { NULL_RECORDER } from '../src/trace/recorder';
import { ArrayRecorder } from '../src/trace/records';

// ---------------------------------------------------------------- scenes

const WHITE = { kind: 'lambert' as const, albedo: [0.73, 0.73, 0.73] as const };

// A light bulb: small emitter INSIDE a solid glass sphere, over a floor.
// Every path from the room to the emitter crosses exactly one glass
// interface — the single-bounce SMS family in its purest form.
const GLASS_BULB: SceneDescription = {
  camera: { eye: [0, 1.6, 5], lookAt: [0, 0.6, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-4, 0, -4], e1: [0, 0, 9], e2: [8, 0, 0] }, material: WHITE },
    { name: 'back', shape: { kind: 'quad', q: [-4, 0, -4], e1: [8, 0, 0], e2: [0, 4, 0] }, material: WHITE },
    { name: 'glassShell', shape: { kind: 'sphere', center: [0, 1, 0], radius: 0.6 }, material: { kind: 'dielectric', ior: 1.5 } },
    // Faces DOWN (e1 × e2 = −y): the bulb throws its light at the floor.
    { name: 'bulb', shape: { kind: 'quad', q: [-0.15, 1.02, -0.15], e1: [0.3, 0, 0], e2: [0, 0, 0.3] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [60, 60, 60] } },
  ],
};

// Caster-free Cornell (nee.test.ts's box): SMS must change NOTHING here.
const CORNELL_TEST: SceneDescription = {
  camera: { eye: [0, 2, 7.2], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 0, 4], e2: [4, 0, 0] }, material: WHITE },
    { name: 'ceiling', shape: { kind: 'quad', q: [-2, 4, -2], e1: [4, 0, 0], e2: [0, 0, 4] }, material: WHITE },
    { name: 'back', shape: { kind: 'quad', q: [-2, 0, -2], e1: [4, 0, 0], e2: [0, 4, 0] }, material: WHITE },
    { name: 'left', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 4, 0], e2: [0, 0, 4] }, material: { kind: 'lambert', albedo: [0.65, 0.05, 0.05] } },
    { name: 'right', shape: { kind: 'quad', q: [2, 0, -2], e1: [0, 0, 4], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.12, 0.45, 0.15] } },
    { name: 'light', shape: { kind: 'quad', q: [-0.8, 3.998, -0.8], e1: [1.6, 0, 0], e2: [0, 0, 1.6] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [14, 14, 14] } },
    { name: 'ball', shape: { kind: 'sphere', center: [-0.9, 0.8, -0.6], radius: 0.8 }, material: WHITE },
  ],
};

// Alhazen control scene: a large INTERIOR mirror sphere enclosing a small
// two-sided light — the four-root fiber from the manifold tests, now with
// physical Le. Only the estimator-level tests use it; the receiver point
// is synthetic.
const ALHAZEN: SceneDescription = {
  camera: { eye: [0, 0, 1], lookAt: [0, 0, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'shell', shape: { kind: 'sphere', center: [0, 0, 0], radius: 1 }, material: { kind: 'mirror', f0: [0.95, 0.95, 0.95] } },
    { name: 'glow', shape: { kind: 'quad', q: [-0.5, 0.3, -0.15], e1: [0.2, 0, 0], e2: [0, 0, 0.2] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [40, 40, 40], twoSided: true } },
  ],
};

function meanRadiance(
  desc: SceneDescription,
  integrator: Integrator,
  seed: number,
  pixels: ReadonlyArray<readonly [number, number]>,
  spp: number,
): number {
  const scene = buildScene(desc, 32, 32);
  const s = new IndependentSampler(seed);
  let sum = 0;
  for (const pixel of pixels) {
    for (let i = 0; i < spp; i++) {
      s.startPixelSample(pixelSeedKey(pixel[0], pixel[1], i));
      const [c] = integrator.sampleContributions(pixel, s, scene, NULL_RECORDER);
      sum += c!.value.r + c!.value.g + c!.value.b;
    }
  }
  return sum / (pixels.length * spp);
}

// ------------------------------------------------------------ partition

describe('partition correctness (caster-free scene)', () => {
  it('pt-sms is BIT-IDENTICAL to pt-nee when no specular casters exist', () => {
    // With no casters the SMS phase draws nothing — same dimensions, same
    // walk, same contributions, exactly.
    const scene = buildScene(CORNELL_TEST, 32, 32);
    const sms = new SMSPathTracer();
    const nee = new NEEPathTracer();
    for (const pixel of [[16, 16], [8, 24], [25, 6]] as const) {
      for (let i = 0; i < 32; i++) {
        const s1 = new IndependentSampler(9);
        const s2 = new IndependentSampler(9);
        s1.startPixelSample(pixelSeedKey(pixel[0], pixel[1], i));
        s2.startPixelSample(pixelSeedKey(pixel[0], pixel[1], i));
        const [a] = sms.sampleContributions(pixel, s1, scene, NULL_RECORDER);
        const [b] = nee.sampleContributions(pixel, s2, scene, NULL_RECORDER);
        expect(a!.value.r).toBe(b!.value.r);
        expect(a!.value.g).toBe(b!.value.g);
        expect(a!.value.b).toBe(b!.value.b);
      }
    }
  });
});

// ----------------------------------------------------------- convergence

describe('cross-integrator convergence on the glass bulb', () => {
  // Floor pixels in the bulb's throw. The reference is plain PT: BSDF
  // sampling finds the bulb through the glass; NEE's shadow rays are
  // always blocked by the shell, making pt-nee ≈ pt here (both must agree
  // with pt-sms).
  const pixels = [[13, 22], [16, 23], [19, 22], [16, 26]] as const;

  it('pt-sms (unbiased) matches the PT reference on the caustic floor', () => {
    const pt = meanRadiance(GLASS_BULB, new UnidirectionalPT(), 1, pixels, 12000);
    const sms = meanRadiance(
      GLASS_BULB,
      new SMSPathTracer({ estimator: 'unbiased', maxTrials: 64 }),
      2,
      pixels,
      600,
    );
    expect(Math.abs(sms - pt) / pt).toBeLessThan(0.05);
  });

  it('pt-sms (biased M = 16) matches too — single-root region, bias invisible', () => {
    const pt = meanRadiance(GLASS_BULB, new UnidirectionalPT(), 1, pixels, 12000);
    const sms = meanRadiance(GLASS_BULB, new SMSPathTracer({ estimator: 'biasedM', M: 16 }), 3, pixels, 600);
    expect(Math.abs(sms - pt) / pt).toBeLessThan(0.05);
  });

  it('MNEE config agrees as well (deterministic seed, single-root regime)', () => {
    const pt = meanRadiance(GLASS_BULB, new UnidirectionalPT(), 1, pixels, 12000);
    const mnee = meanRadiance(
      GLASS_BULB,
      new SMSPathTracer({ mneeInit: true, constraint: 'halfvector' }),
      4,
      pixels,
      600,
    );
    expect(Math.abs(mnee - pt) / pt).toBeLessThan(0.05);
  });
});

// -------------------------------------------------- estimator control

describe('estimator negative control (multi-root fiber)', () => {
  // Estimator-level, no rendering: a synthetic diffuse receiver inside the
  // Alhazen shell, where the fiber has four roots. biased M = 1 finds one
  // root per estimate and applies no discovery correction — it must
  // undercount; the unbiased estimator and biased M = 16 must agree.
  const scene = buildScene(ALHAZEN, 8, 8);
  const receiverP = new Vec3(0.5, 0, 0.1);
  const ns = new Vec3(-1, 0, 0); // faces the far wall, where the roots live
  const receiver = {
    p: receiverP,
    ns,
    bsdf: new SurfaceBSDF(new Lambert(new Color(0.7, 0.7, 0.7)), ns, ns),
    wo: new Vec3(1, 0, 0),
    depth: 1,
  };

  const estimate = (options: Partial<SMSPTOptions>, seed: number, n: number): number => {
    const opts: SMSPTOptions = { ...DEFAULT_SMS_OPTIONS, ...options };
    const s = new IndependentSampler(seed);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      s.startPixelSample(pixelSeedKey(0, 0, i));
      const L = smsConnect(scene, receiver, s, NULL_RECORDER, opts);
      sum += L.r + L.g + L.b;
    }
    return sum / n;
  };

  it('biased M = 1 measurably undercounts; M = 16 agrees with unbiased', () => {
    const unbiased = estimate({ estimator: 'unbiased', maxTrials: 128 }, 11, 4000);
    const biased1 = estimate({ estimator: 'biasedM', M: 1 }, 12, 4000);
    const biased16 = estimate({ estimator: 'biasedM', M: 16 }, 13, 4000);
    expect(unbiased).toBeGreaterThan(0);
    // The M = 1 estimator sees one root per estimate with no 1/p
    // correction: the darkening must be well outside noise.
    expect(biased1).toBeLessThan(0.85 * unbiased);
    expect(Math.abs(biased16 - unbiased) / unbiased).toBeLessThan(0.05);
  });
});

// ------------------------------------------------------- V5b chains

// The classic caustic scene (bdpt.test.ts's GLASS_BOX): external ceiling
// light, glass ball, caustic on the floor — light→glass→glass→floor is
// the m = 2 family V5b owns.
const GLASS_BOX: SceneDescription = {
  camera: { eye: [0, 2, 7.2], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 0, 10], e2: [4, 0, 0] }, material: WHITE },
    { name: 'ceiling', shape: { kind: 'quad', q: [-2, 4, -2], e1: [4, 0, 0], e2: [0, 0, 10] }, material: WHITE },
    { name: 'back', shape: { kind: 'quad', q: [-2, 0, -2], e1: [4, 0, 0], e2: [0, 4, 0] }, material: WHITE },
    { name: 'left', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 4, 0], e2: [0, 0, 10] }, material: { kind: 'lambert', albedo: [0.65, 0.05, 0.05] } },
    { name: 'right', shape: { kind: 'quad', q: [2, 0, -2], e1: [0, 0, 10], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.12, 0.45, 0.15] } },
    { name: 'front', shape: { kind: 'quad', q: [-2, 0, 8], e1: [0, 4, 0], e2: [4, 0, 0] }, material: WHITE },
    { name: 'light', shape: { kind: 'quad', q: [-0.8, 3.998, -0.8], e1: [1.6, 0, 0], e2: [0, 0, 1.6] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [14, 14, 14] } },
    { name: 'glass', shape: { kind: 'sphere', center: [-0.3, 0.8, -0.3], radius: 0.8 }, material: { kind: 'dielectric', ior: 1.5 } },
  ],
};

describe('V5b: two-crossing chains', () => {
  it('m = 1 regression: chains change nothing where no m = 2 family exists', () => {
    // The bulb's light is INSIDE the glass: every m = 2 attempt fails
    // branch validation. In deterministic seed mode the chain draws no
    // sampler dimensions either — contributions must be BIT-identical.
    // (The random default draws seed dims, shifting later uniforms:
    // statistically identical, bitwise not — covered by the convergence
    // tests.)
    const scene = buildScene(GLASS_BULB, 32, 32);
    const on = new SMSPathTracer({ chains: true, chainSeedMode: 'deterministic' });
    const off = new SMSPathTracer({ chains: false });
    for (let i = 0; i < 24; i++) {
      const s1 = new IndependentSampler(9);
      const s2 = new IndependentSampler(9);
      s1.startPixelSample(pixelSeedKey(16, 23, i));
      s2.startPixelSample(pixelSeedKey(16, 23, i));
      const [a] = on.sampleContributions([16, 23], s1, scene, NULL_RECORDER);
      const [b] = off.sampleContributions([16, 23], s2, scene, NULL_RECORDER);
      expect(a!.value.r).toBe(b!.value.r);
      expect(a!.value.g).toBe(b!.value.g);
      expect(a!.value.b).toBe(b!.value.b);
    }
  });

  it('FLAGSHIP: pt-sms matches the NEE reference on the glass-box caustic', { timeout: 120_000 }, () => {
    // The V2 flagship's pixels and reference protocol (bdpt.test.ts:203)
    // — the same truncated integral, now solved by a fourth architecture.
    // The UNBIASED estimator config carries the assertion (the Bernoulli
    // correction covers every root with positive discovery probability);
    // the biased-M default's measured ~1.5% zone darkening is recorded in
    // design-v5 §V5b, the m = 2 analogue of the M = 1 negative control.
    const pixels = [[16, 26], [14, 19], [8, 16], [24, 16]] as const;
    const nee = meanRadiance(GLASS_BOX, new NEEPathTracer(), 31, pixels, 6000);
    const sms = meanRadiance(GLASS_BOX, new SMSPathTracer({ estimator: 'unbiased' }), 32, pixels, 1200);
    expect(Math.abs(sms - nee) / nee).toBeLessThan(0.05);
  });

  it('chain walks land in the records with two-vertex iterates', () => {
    const scene = buildScene(GLASS_BOX, 32, 32);
    const sms = new SMSPathTracer();
    const s = new IndependentSampler(5);
    const recorder = new ArrayRecorder();
    for (let i = 0; i < 32; i++) {
      recorder.beginPath(pixelSeedKey(16, 26, i));
      sms.sampleContributions([16, 26], s, scene, recorder);
      recorder.endPath();
    }
    const chainWalks = recorder.records
      .flatMap((r) => r.manifoldWalks)
      .filter((w) => w.iterates.some((it) => it.chain.length === 2));
    expect(chainWalks.length).toBeGreaterThan(0);
    expect(chainWalks.some((w) => w.outcome === 'converged')).toBe(true);
  });

  it('is deterministic with chains enabled', () => {
    const scene = buildScene(GLASS_BOX, 32, 32);
    const run = () => {
      const sms = new SMSPathTracer();
      const s = new IndependentSampler(21);
      const out: number[] = [];
      for (let i = 0; i < 16; i++) {
        s.startPixelSample(pixelSeedKey(16, 26, i));
        const [c] = sms.sampleContributions([16, 26], s, scene, NULL_RECORDER);
        out.push(c!.value.r, c!.value.g, c!.value.b);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

// ------------------------------------------------ determinism + records

describe('determinism and records', () => {
  it('same seed ⇒ bit-identical contributions (including Bernoulli trials)', () => {
    const scene = buildScene(GLASS_BULB, 32, 32);
    const run = () => {
      const sms = new SMSPathTracer({ estimator: 'unbiased' });
      const s = new IndependentSampler(21);
      const out: number[] = [];
      for (let i = 0; i < 24; i++) {
        s.startPixelSample(pixelSeedKey(16, 23, i));
        const [c] = sms.sampleContributions([16, 23], s, scene, NULL_RECORDER);
        out.push(c!.value.r, c!.value.g, c!.value.b);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('manifold walks land in the path record with iterates and outcomes', () => {
    const scene = buildScene(GLASS_BULB, 32, 32);
    const sms = new SMSPathTracer({ estimator: 'biasedM', M: 4 });
    const s = new IndependentSampler(5);
    const recorder = new ArrayRecorder();
    for (let i = 0; i < 8; i++) {
      recorder.beginPath(pixelSeedKey(16, 23, i));
      sms.sampleContributions([16, 23], s, scene, recorder);
      recorder.endPath();
    }
    const walks = recorder.records.flatMap((r) => r.manifoldWalks);
    expect(walks.length).toBeGreaterThan(0);
    const converged = walks.filter((w) => w.outcome === 'converged');
    expect(converged.length).toBeGreaterThan(0);
    for (const w of converged) {
      expect(w.solution).not.toBeNull();
      expect(w.iterates.length).toBeGreaterThan(0);
      expect(w.casterName).toBe('glassShell');
    }
  });
});

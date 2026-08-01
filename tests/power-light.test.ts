import { describe, expect, it } from 'vitest';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { PowerLightSampler } from '../src/core/lights/power';
import { PCG32 } from '../src/core/math/pcg32';
import { hashInts } from '../src/core/math/hash';
import { U64_ZERO, fromNumber } from '../src/core/math/u64';

// Three one-sided quad emitters with different areas and radiances:
// phi = π · area · L, so the power ratios below are exact by construction.
//   bright: area 4, L 10 → phi ∝ 40
//   medium: area 1, L 10 → phi ∝ 10
//   dim:    area 1, L 1  → phi ∝ 1
const DESC: SceneDescription = {
  camera: { eye: [0, 1, 5], lookAt: [0, 1, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-5, 0, -5], e1: [0, 0, 10], e2: [10, 0, 0] }, material: { kind: 'lambert', albedo: [0.7, 0.7, 0.7] } },
    { name: 'bright', shape: { kind: 'quad', q: [-3, 3, -1], e1: [2, 0, 0], e2: [0, 0, 2] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [10, 10, 10] } },
    { name: 'medium', shape: { kind: 'quad', q: [0, 3, -1], e1: [1, 0, 0], e2: [0, 0, 1] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [10, 10, 10] } },
    { name: 'dim', shape: { kind: 'quad', q: [2, 3, -1], e1: [1, 0, 0], e2: [0, 0, 1] }, material: { kind: 'lambert', albedo: [1, 1, 1] }, emission: { radiance: [1, 1, 1] } },
  ],
};

describe('PowerLightSampler', () => {
  const scene = buildScene(DESC, 8, 8);
  const lights = scene.primitives.filter((p) => p.light).map((p) => p.light!);
  const sampler = new PowerLightSampler(lights);
  const expected = [40 / 51, 10 / 51, 1 / 51];

  it('pmf is proportional to emitted power', () => {
    lights.forEach((light, i) => {
      expect(sampler.pmf(light)).toBeCloseTo(expected[i]!, 12);
    });
  });

  it('sample() agrees with pmf() and hits the expected frequencies', () => {
    const rng = new PCG32(U64_ZERO, U64_ZERO);
    rng.setSequence(hashInts([0x504c53, 1]), fromNumber(0));
    const N = 30000;
    const counts = new Map<unknown, number>();
    for (let i = 0; i < N; i++) {
      const s = sampler.sample(rng.nextFloat())!;
      expect(s.pmf).toBeCloseTo(sampler.pmf(s.light), 12);
      counts.set(s.light, (counts.get(s.light) ?? 0) + 1);
    }
    let chi2 = 0;
    lights.forEach((light, i) => {
      const e = N * expected[i]!;
      chi2 += ((counts.get(light) ?? 0) - e) ** 2 / e;
    });
    expect(chi2).toBeLessThan(14); // 2 dof; p < 0.001 would exceed this
  });

  it('unknown lights have pmf 0; empty list samples null', () => {
    const other = buildScene(DESC, 8, 8).primitives.find((p) => p.light)!.light!;
    expect(sampler.pmf(other)).toBe(0); // different instance, not in this list
    expect(new PowerLightSampler([]).sample(0.5)).toBeNull();
  });
});

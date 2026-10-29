import { describe, expect, it } from 'vitest';
import { SCENES } from '../src/scenes/registry';
import { buildScene } from '../src/core/scene/scene';
import { AimAtLightPT } from '../src/core/integrators/pt-aim';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import { UnidirectionalPT } from '../src/core/integrators/pt';
import type { Integrator } from '../src/core/integrators/types';
import { IndependentSampler } from '../src/core/sampler/independent';
import { pixelSeedKey } from '../src/core/sampler/sampler';
import { NullRecorder } from '../src/trace/recorder';

// pt-aim (bounce N times, then one unweighted shadow ray, / pmf(N)) must
// converge to the same image as pt-nee and plain pt: same depth cap, same
// scene, independent estimators. Compared on mean luminance per pixel of a
// small film, which is where a wrong pmf weight or a missed length shows.
const RES = 4;
const SPP = 3000;
const D = 8;

function meanImage(integrator: Integrator, seed: number): number[] {
  const scene = buildScene(SCENES['cornell-short'], RES, RES);
  const sampler = new IndependentSampler(seed);
  const rec = new NullRecorder();
  const out: number[] = [];
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      let sum = 0;
      for (let s = 0; s < SPP; s++) {
        sampler.startPixelSample(pixelSeedKey(x, y, s));
        for (const c of integrator.sampleContributions([x, y], sampler, scene, rec)) {
          sum += 0.2126 * c.value.r + 0.7152 * c.value.g + 0.0722 * c.value.b;
        }
      }
      out.push(sum / SPP);
    }
  }
  return out;
}

describe('pt-aim', () => {
  it('converges to the same image as pt-nee and plain pt on cornell-short', () => {
    // Plain PT is depth-capped by maxBounces surface vertices including the
    // lamp hit, so D + 1 matches pt-aim's lengths 1 .. D + 1.
    const aim = meanImage(new AimAtLightPT({ maxBounces: D }), 1);
    const nee = meanImage(new NEEPathTracer({ maxBounces: D + 1, rrStartDepth: 99 }), 2);
    const pt = meanImage(new UnidirectionalPT({ maxBounces: D + 1, rrStartDepth: 99, sampleNEE: false }), 3);
    const total = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    console.log('mean luminance  aim', total(aim).toFixed(4), ' nee', total(nee).toFixed(4), ' pt', total(pt).toFixed(4));
    expect(total(aim)).toBeCloseTo(total(nee), 1);
    expect(Math.abs(total(aim) - total(nee)) / total(nee)).toBeLessThan(0.05);
    for (let i = 0; i < aim.length; i++) {
      expect(Math.abs(aim[i]! - nee[i]!)).toBeLessThan(0.15 * nee[i]! + 0.02);
    }
  });
});

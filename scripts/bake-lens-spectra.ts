// The spectra the lens-camera demo's rays bring back: for each of its K rays
// (src/viz/lens-camera.ts), the spectrum of the light arriving along it, in
// the spectral cornell-short of spectral-scene.ts.
//
// One ray is rendered as the one pixel of a camera standing at the ray's lens
// point, looking along it, with a field of view so narrow that every sample in
// the pixel is the same ray.
//
// Run: node scripts/run-ts.mjs scripts/bake-lens-spectra.ts src/data/lens-spectra.json
import { buildScene } from '../src/core/scene/scene';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import { IndependentSampler } from '../src/core/sampler/independent';
import { Film } from '../src/render/film';
import { renderPass } from '../src/render/driver';
import { writeFileSync } from 'node:fs';
import { NM, RUNS, spectralRun } from './spectral-scene';
import { K, lensRay } from '../src/viz/lens-camera';

const SPP = 4096;

export async function main(out: string): Promise<void> {
  const spectra = Array.from({ length: K }, () => new Array<number>(NM.length).fill(0));
  for (let k = 0; k < K; k++) {
    const { origin, dir } = lensRay(k);
    const camera = { eye: origin, lookAt: [origin[0] + dir[0], origin[1] + dir[1], origin[2] + dir[2]] as [number, number, number], up: [0, 1, 0] as [number, number, number], fovDegrees: 0.001 };
    for (let run = 0; run < RUNS; run++) {
      const { desc } = spectralRun(run, camera);
      const scene = buildScene(desc, 1, 1);
      const film = new Film(1, 1);
      const integrator = new NEEPathTracer({ maxBounces: 8 });
      const sampler = new IndependentSampler(k);
      for (let s = 0; s < SPP; s++) renderPass(scene, integrator, sampler, film, s);
      const v = film.pixel(0, 0);
      for (let c = 0; c < 3 && 3 * run + c < NM.length; c++) spectra[k]![3 * run + c] = v[c]!;
    }
  }
  writeFileSync(out, JSON.stringify({ k: K, spp: SPP, nm: NM, spectra: spectra.map((s) => s.map((x) => +x.toPrecision(5))) }));
  console.log(`${K} rays done`);
}

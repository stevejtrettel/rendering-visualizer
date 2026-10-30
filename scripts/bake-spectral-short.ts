// A spectral render of cornell-short, for the spectrum-to-RGB slide
// (rendering-talk-visuals pixel-image ?scene=box): at every pixel the
// spectrum of the light arriving there, not a colour. How the RGB renderer
// renders spectra, and the spectra chosen: spectral-scene.ts.
//
// Run: node scripts/run-ts.mjs scripts/bake-spectral-short.ts <out.json> [res, default 16]
import { buildScene } from '../src/core/scene/scene';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import { IndependentSampler } from '../src/core/sampler/independent';
import { Film } from '../src/render/film';
import { renderPass } from '../src/render/driver';
import { writeFileSync } from 'node:fs';
import { NM, RUNS, spectralRun } from './spectral-scene';

const SPP = 1024;

export async function main(out: string, res = '16'): Promise<void> {
  const RES = Number(res);
  const spectra = Array.from({ length: RES * RES }, () => new Array<number>(NM.length).fill(0));
  for (let run = 0; run < RUNS; run++) {
    const { nms, desc } = spectralRun(run);
    const scene = buildScene(desc, RES, RES);
    const integrator = new NEEPathTracer({ maxBounces: 8 });
    const sampler = new IndependentSampler(0);
    const film = new Film(RES, RES);
    for (let s = 0; s < SPP; s++) renderPass(scene, integrator, sampler, film, s);
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        const v = film.pixel(x, y);
        for (let c = 0; c < 3 && 3 * run + c < NM.length; c++) spectra[y * RES + x]![3 * run + c] = v[c]!;
      }
    }
    console.log(`wavelengths ${nms.join(', ')} done`);
  }
  writeFileSync(out, JSON.stringify({ res: RES, spp: SPP, nm: NM, spectra: spectra.map((s) => s.map((x) => +x.toPrecision(5))) }));
}

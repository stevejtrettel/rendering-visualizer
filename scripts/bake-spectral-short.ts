// A spectral render of cornell-short, for the spectrum-to-RGB slide
// (rendering-talk-visuals pixel-image ?scene=box): at every pixel the
// spectrum of the light arriving there, not a colour.
//
// The renderer is RGB, but its three channels never mix: every material here
// (Lambert, the conductor's Schlick Fresnel) multiplies channel by channel. So
// a render whose three channels are three wavelengths, each with that
// wavelength's reflectances and lamp radiance, is three monochromatic renders
// at once. RUNS of them cover the wavelengths; the sampler is seeded the same
// for every run, so the noise is shared and a spectrum is smooth across them.
//
// The spectra are choices, written here: smooth reflectances matched by eye to
// the scene's RGB albedos, and a 5200 K blackbody lamp (the lamp of the room
// demos and pixel-image) at the scene lamp's brightness.
//
// Run: node scripts/bake-spectral-short.mjs <out.json>
import { SCENES } from '../src/scenes/registry';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import { IndependentSampler } from '../src/core/sampler/independent';
import { Film } from '../src/render/film';
import { renderPass } from '../src/render/driver';
import { writeFileSync } from 'node:fs';

const RES = 16;
const SPP = 1024;
/** The wavelengths: 400 to 700 nm in 33 steps (every third of pixel-image's 97). */
const NM = Array.from({ length: 33 }, (_, i) => 400 + (300 * i) / 32);

const planck = (nm: number, T: number) => {
  const l = nm * 1e-9;
  return 1 / (l ** 5 * (Math.exp(1.4388e-2 / (l * T)) - 1));
};
const REFLECT: Record<string, (nm: number) => number> = {
  floor: (nm) => 0.68 + (0.08 * (nm - 400)) / 300,
  ceiling: (nm) => 0.68 + (0.08 * (nm - 400)) / 300,
  back: (nm) => 0.68 + (0.08 * (nm - 400)) / 300,
  left: (nm) => 0.05 + 0.62 / (1 + Math.exp(-(nm - 605) / 14)),
  right: (nm) => 0.05 + 0.42 * Math.exp(-(((nm - 535) / 40) ** 2)),
  ball: () => 0.73,
  ballBlue: (nm) => 0.33 + 0.5 / (1 + Math.exp((nm - 520) / 30)), // the conductor's f0
};

export async function main(out: string): Promise<void> {
  const desc = SCENES['cornell-short'];
  const lamp = desc.primitives.find((p) => p.emission)!;
  const L = lamp.emission!.radiance[1]; // the lamp's brightness, from its green channel
  const spectra = Array.from({ length: RES * RES }, () => new Array<number>(NM.length).fill(0));
  for (let run = 0; run < NM.length; run += 3) {
    const nms = [0, 1, 2].map((c) => NM[Math.min(run + c, NM.length - 1)]!);
    const three = (f: (nm: number) => number) => nms.map(f) as [number, number, number];
    const d: SceneDescription = {
      ...desc,
      primitives: desc.primitives.map((p) => {
        if (p.emission) return { ...p, emission: { ...p.emission, radiance: three((nm) => (L * planck(nm, 5200)) / planck(560, 5200)) } };
        const r = REFLECT[p.name!];
        if (!r) return p;
        if (p.material.kind === 'lambert') return { ...p, material: { ...p.material, albedo: three(r) } };
        if (p.material.kind === 'conductor') return { ...p, material: { ...p.material, f0: three(r) } };
        return p;
      }),
    };
    const scene = buildScene(d, RES, RES);
    const integrator = new NEEPathTracer({ maxBounces: 8 });
    const sampler = new IndependentSampler(0);
    const film = new Film(RES, RES);
    for (let s = 0; s < SPP; s++) renderPass(scene, integrator, sampler, film, s);
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        const v = film.pixel(x, y);
        for (let c = 0; c < 3 && run + c < NM.length; c++) spectra[y * RES + x]![run + c] = v[c]!;
      }
    }
    console.log(`wavelengths ${nms.join(', ')} done`);
  }
  writeFileSync(out, JSON.stringify({ res: RES, spp: SPP, nm: NM, spectra: spectra.map((s) => s.map((x) => +x.toPrecision(5))) }));
}

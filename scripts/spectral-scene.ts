// The spectral version of cornell-short that the bakes for the Part II camera
// slides render (bake-spectral-short, bake-lens-spectra), and of lf-room (the
// light-field talk's room, same walls and lamp), which bake-lens-spectra can
// render instead.
//
// The renderer is RGB, but its three channels never mix: every material here
// (Lambert, the conductor's Schlick Fresnel) multiplies channel by channel. So
// a render whose three channels are three wavelengths, each with that
// wavelength's reflectances and lamp radiance, is three monochromatic renders
// at once; NM.length / 3 of them cover the wavelengths. Seed the sampler the
// same for every run and the noise is shared, so a spectrum is smooth across
// them.
//
// The spectra are choices, written here: smooth reflectances matched by eye to
// the scene's RGB albedos, and a 5200 K blackbody lamp (the lamp of the room
// demos and pixel-image) at the scene lamp's brightness.
import { SCENES } from '../src/scenes/registry';
import type { SceneDescription } from '../src/core/scene/scene';

/** The wavelengths: 400 to 700 nm in 33 steps (every third of pixel-image's 97). */
export const NM = Array.from({ length: 33 }, (_, i) => 400 + (300 * i) / 32);

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
  // lf-room: the box is the walls' white; the gold ball's f0, low in the blue,
  // matched by eye to its RGB [0.9, 0.78, 0.5].
  ...Object.fromEntries(['box-top', 'box-px', 'box-nx', 'box-pz', 'box-nz'].map((n) => [n, (nm: number) => 0.68 + (0.08 * (nm - 400)) / 300])),
  goldBall: (nm) => 0.5 + 0.4 / (1 + Math.exp(-(nm - 510) / 30)),
};

/** Run `run` (0, 1, …): its three wavelengths, and the scene (cornell-short unless named) at them, one per channel. */
export function spectralRun(
  run: number,
  camera?: SceneDescription['camera'],
  scene: 'cornell-short' | 'lf-room' = 'cornell-short',
): { nms: number[]; desc: SceneDescription } {
  const desc = SCENES[scene];
  const L = desc.primitives.find((p) => p.emission)!.emission!.radiance[1]; // the lamp's brightness, from its green channel
  const nms = [0, 1, 2].map((c) => NM[Math.min(3 * run + c, NM.length - 1)]!);
  const three = (f: (nm: number) => number) => nms.map(f) as [number, number, number];
  return {
    nms,
    desc: {
      ...desc,
      camera: camera ?? desc.camera,
      primitives: desc.primitives.map((p) => {
        if (p.emission) return { ...p, emission: { ...p.emission, radiance: three((nm) => (L * planck(nm, 5200)) / planck(560, 5200)) } };
        const r = REFLECT[p.name!];
        if (!r) return p;
        if (p.material.kind === 'lambert') return { ...p, material: { ...p.material, albedo: three(r) } };
        if (p.material.kind === 'conductor') return { ...p, material: { ...p.material, f0: three(r) } };
        return p;
      }),
    },
  };
}
export const RUNS = Math.ceil(NM.length / 3);

// Render Cornell variants to PPM so the choice is made by looking, not by
// arguing — plus the two numbers that actually change if a ball goes glossy.
import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { CORNELL } from '../src/scenes/cornell';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { uniformSampledScene } from '../src/core/materials/uniform-sampled';
import { IndependentSampler } from '../src/core/sampler/independent';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import { UnidirectionalPT } from '../src/core/integrators/pt';
import type { Integrator } from '../src/core/integrators/types';
import { renderPass } from '../src/render/driver';
import { Film } from '../src/render/film';
import { luminanceOf } from '../src/core/math/color';

const OUT = '/private/tmp/claude-1673034261/-Users-strettel-Code-rendering-visualizer/79c204a1-91d1-40d8-a415-4e72946b3cbf/scratchpad';
const SIZE = 200;
const SPP = 600;
const DEPTH = 8;

type Mat = SceneDescription['primitives'][number]['material'];
const GLOSSY: Mat = { kind: 'conductor', f0: [0.62, 0.68, 0.82], roughness: 0.18 };

function variant(opts: { glossy?: boolean; warmLight?: boolean; warmWalls?: boolean }): SceneDescription {
  return {
    ...CORNELL,
    primitives: CORNELL.primitives.map((p) => {
      if (opts.glossy && p.name === 'ballBlue') return { ...p, material: GLOSSY };
      if (opts.warmLight && p.emission) {
        // Warm the lamp but hold LUMINANCE fixed, so the room does not also
        // get dimmer — otherwise this compares exposure, not colour.
        const tint = [1.0, 0.83, 0.62] as const;
        const lum = luminanceOf(tint[0], tint[1], tint[2]);
        const L = p.emission.radiance[0];
        return {
          ...p,
          emission: {
            radiance: [
              (L * tint[0]) / lum,
              (L * tint[1]) / lum,
              (L * tint[2]) / lum,
            ] as [number, number, number],
          },
        };
      }
      if (opts.warmWalls && (p.name === 'floor' || p.name === 'ceiling' || p.name === 'back' || p.name === 'front')) {
        return { ...p, material: { kind: 'lambert', albedo: [0.76, 0.72, 0.65] } as Mat };
      }
      return p;
    }),
  };
}

function render(desc: SceneDescription, integrator: Integrator, spp = SPP, uniform = false): Film {
  const base = buildScene(desc, SIZE, SIZE);
  const scene = uniform ? uniformSampledScene(base) : base;
  const film = new Film(SIZE, SIZE);
  const sampler = new IndependentSampler(2);
  for (let i = 0; i < spp; i++) renderPass(scene, integrator, sampler, film, i);
  return film;
}

function writePPM(film: Film, path: string): void {
  const header = `P6\n${SIZE} ${SIZE}\n255\n`;
  const body = Buffer.alloc(SIZE * SIZE * 3);
  const rgba = film.develop();
  for (let i = 0; i < SIZE * SIZE; i++) {
    body[i * 3] = rgba[i * 4]!;
    body[i * 3 + 1] = rgba[i * 4 + 1]!;
    body[i * 3 + 2] = rgba[i * 4 + 2]!;
  }
  writeFileSync(path, Buffer.concat([Buffer.from(header, 'ascii'), body]));
}

/** Mean per-pixel relative standard error — how noisy it looks at fixed spp. */
function relErr(film: Film): number {
  let s = 0, n = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const [r, g, b] = film.pixel(x, y);
    const lum = luminanceOf(r, g, b);
    const se = film.standardError(x, y);
    if (lum > 1e-4 && Number.isFinite(se)) { s += se / lum; n++; }
  }
  return s / Math.max(1, n);
}

describe('cornell variants', () => {
  it('renders the options and measures what changes', { timeout: 1_800_000 }, () => {
    const nee = () => new NEEPathTracer({ maxBounces: DEPTH });
    const cases: [string, SceneDescription][] = [
      ['a-current', variant({})],
      ['b-glossy', variant({ glossy: true })],
      ['c-warmlight', variant({ warmLight: true })],
      ['d-glossy-warmlight', variant({ glossy: true, warmLight: true })],
      ['e-glossy-warmwalls', variant({ glossy: true, warmWalls: true })],
    ];
    for (const [name, desc] of cases) {
      const f = render(desc, nee());
      writePPM(f, `${OUT}/${name}.ppm`);
      console.log(`${name.padEnd(20)} rel err ${(relErr(f) * 100).toFixed(2)}%`);
    }

    // Does a glossy ball make the naive-vs-standard figure stronger? That
    // gap is ~1.06x on the all-Lambert cornell, which is why the naive
    // tracer looks feebler there than on material-test.
    console.log('\nuniform-vs-bsdf gap at 128 spp (plain pt, cap 8):');
    for (const [name, desc] of [['all lambert', variant({})], ['one glossy', variant({ glossy: true })]] as const) {
      const pt = () => new UnidirectionalPT({ maxBounces: DEPTH, rrStartDepth: 3, sampleNEE: false });
      const b = relErr(render(desc, pt(), 128, false));
      const u = relErr(render(desc, pt(), 128, true));
      console.log(`  ${name.padEnd(12)} bsdf ${(b * 100).toFixed(1)}%  uniform ${(u * 100).toFixed(1)}%  ->  ${(u / b).toFixed(2)}x  (equal-quality ${((u / b) ** 2).toFixed(1)}x)`);
    }
  });
});

/**
 * SHOWS: the photograph, one path length at a time.
 *
 * For the light-field deck (Steve, 2026-10-30): the terms of
 * C(Id - T)^-1 E = Σ C T^n E, each drawn as what it computes, the photo the
 * camera takes from paths of exactly that length. Three films in a row with
 * + between them: paths from film to light of length 2 (the camera sees the
 * lamp), 3 (direct light), 4 (one bounce of indirect light). The deck sets
 * the integrals over them and the words under them.
 *
 * Rendered with the BDPT of bdpt-pyramid, its per-strategy sink, and every
 * strategy of one depth summed: the MIS weights of one depth sum to one, so
 * a row's sum is all of that depth's transport, the same image a path tracer
 * would converge to restricted to that length, at far less noise. Depth d
 * (s + t - 2 = d) is a path of d + 1 segments from the lens, so d + 2 from
 * the film. One exposure across the three films, so the longer terms are
 * dimmer, as they are.
 *
 * ?sum (Steve: "combine the images we have into a single one summing them up,
 * to get the final image"): the three films smaller, then + ⋯ =, then the
 * whole photograph, every path length up to SUM_DEPTH, large. That last film
 * takes every contribution of the same render (paths up to SUM_DEPTH + 1
 * segments; longer ones carry a negligible share here).
 *
 * Main thread, chunked, as bdpt-pyramid (the per-strategy sink is local-only).
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { buildScene } from '@/core/scene/scene';
import { IndependentSampler } from '@/core/sampler/independent';
import { pixelSeedKey } from '@/core/sampler/sampler';
import { BDPT, type StrategyContribution, type StrategySink } from '@/core/integrators/bdpt';
import { Film } from '@/render/film';
import { NULL_RECORDER } from '@/trace/recorder';
import { FilmPanel } from '@/viz/film-panel';
import { label } from '@/viz/text';

const RES = 128;
const DEPTHS = [0, 1, 2];
const SUM = new URLSearchParams(location.search).has('sum');
const SUM_DEPTH = 7;
const CHUNK = 16;

const stage = createStage({ lights: false, controls: false });
stage.duration = 1;
const ui = createUI(stage);
stage.camera.position.set(0, 0, 5);

const params = { scene: 'cornell' as SceneName, spp: 24, exposure: 1 };
ui.params.add(params, 'scene', Object.keys(SCENES)).onChange(restart);
ui.params.add(params, 'spp', 1, 256, 1).onChange(restart);
ui.params.add(params, 'exposure', 0.1, 8, 0.05).onChange(show);

// Layout, HUD units (y in [-1, 1], x in [-16/9, 16/9]).
const H = SUM ? 0.5 : 0.78;
const XS = SUM ? [-1.45, -0.8, -0.15] : [-1.18, 0, 1.18];
const FINAL = { x: 1.12, h: 1.0 };
const panels = XS.map((x) => {
  const p = new FilmPanel({ width: RES, height: RES, center: [x, 0], drawnHeight: H });
  stage.hud.add(p.group);
  return p;
});
const plusSize = SUM ? 0.07 : 0.09;
for (const x of [(XS[0]! + XS[1]!) / 2, (XS[1]! + XS[2]!) / 2, XS[2]! + H / 2 + plusSize]) {
  stage.hud.add(label('+', { size: plusSize, color: C.bone, anchorX: 'center', anchorY: 'middle', position: [x, 0, 0] }));
}
stage.hud.add(label('⋯', { size: plusSize, color: C.bone, anchorX: 'left', anchorY: 'middle', position: [XS[2]! + H / 2 + plusSize * 1.8, 0, 0] }));
const finalPanel = SUM ? new FilmPanel({ width: RES, height: RES, center: [FINAL.x, 0], drawnHeight: FINAL.h }) : null;
if (finalPanel) {
  stage.hud.add(finalPanel.group);
  stage.hud.add(label('=', { size: 0.09, color: C.bone, anchorX: 'center', anchorY: 'middle', position: [FINAL.x - FINAL.h / 2 - 0.1, 0, 0] }));
}

let films: Film[] = [];
let finalFilm = new Film(RES, RES);
let spp = 0;
let generation = 0;

function show(): void {
  if (!spp) return;
  const opts = { exposure: params.exposure, splatScale: 1 / spp };
  films.forEach((f, i) => panels[i]!.update(f.develop(opts)));
  finalPanel?.update(finalFilm.develop(opts));
}

function restart(): void {
  const gen = ++generation;
  films = DEPTHS.map(() => new Film(RES, RES));
  finalFilm = new Film(RES, RES);
  spp = 0;
  for (const p of panels) p.clear();
  finalPanel?.clear();
  void render(gen);
}

async function render(gen: number): Promise<void> {
  const scene = buildScene(SCENES[params.scene], RES, RES);
  const sampler = new IndependentSampler(0);
  const maxDepth = SUM ? SUM_DEPTH : DEPTHS[DEPTHS.length - 1]!;
  const sink: StrategySink = {
    add(c: StrategyContribution): void {
      const d = c.s + c.t - 2;
      films[d]?.splat(c.raster, c.weighted);
    },
  };
  const bdpt = new BDPT({
    maxBounces: maxDepth + 1,
    rrStartDepth: 999,
    heuristic: 'power',
    strategyFilms: sink,
    strategyFilter: (s, t) => s + t - 2 <= maxDepth,
  });
  for (let i = 0; i < params.spp; i++) {
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        sampler.startPixelSample(pixelSeedKey(x, y, i));
        for (const c of bdpt.sampleContributions([x, y], sampler, scene, NULL_RECORDER)) {
          if (c.kind === 'sample') finalFilm.addSample(c.raster, c.value);
          else finalFilm.splat(c.raster, c.value);
        }
      }
      if (y % CHUNK === CHUNK - 1) {
        await new Promise((r) => setTimeout(r));
        if (gen !== generation) return;
      }
    }
    spp = i + 1;
    show();
  }
}

stage.onReady(async () => {
  while (spp < params.spp) await new Promise((r) => setTimeout(r, 100));
});
stage.start();
restart();

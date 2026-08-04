// SHOWS: the same scene at increasing maxBounces. Direct light only, then one
// bounce of indirect, and so on — the image filling in as transport is allowed
// to go deeper.
//
// Rendered on the main thread in chunks (like the pyramid demo): the worker
// protocol carries an integrator NAME, not walk options, and the point of this
// page is the walk option.
import { SCENES, type SceneName } from '../../src/scenes/registry';
import { buildScene } from '../../src/core/scene/scene';
import { IndependentSampler } from '../../src/core/sampler/independent';
import { NEEPathTracer } from '../../src/core/integrators/pt-nee';
import { Film } from '../../src/render/film';
import { renderPass } from '../../src/render/driver';

// --- Figure spec ---
const SCENE_NAME: SceneName = 'cornell';
// 1 is direct light only; 8 is where this scene is done to within 0.2%; 32 is
// the practical reference. Each pane also reports its share of the reference's
// mean luminance, which is the quantitative version of the picture: energy in a
// closed box decays like albedo^bounces (0.73 here), so the ladder is steep at
// the bottom and flat after ~6.
const DEPTHS = [1, 2, 3, 4, 8, 32];
const RES = 128;
const TARGET_SPP = 32;
const SEED = 0;
// Russian roulette would truncate transport stochastically, muddying the
// comparison — these images are exactly "at most N bounces".
const RR_START_DEPTH = 999;

const description = SCENES[SCENE_NAME];
const statusEl = document.getElementById('status')!;
const rowEl = document.getElementById('row')!;

interface Pane {
  depth: number;
  film: Film;
  integrator: NEEPathTracer;
  sampler: IndependentSampler;
  ctx: CanvasRenderingContext2D;
  cap: HTMLElement;
}

const DEEPEST = Math.max(...DEPTHS);

const panes: Pane[] = DEPTHS.map((depth) => {
  const tile = document.createElement('div');
  tile.className = 'tile';
  const canvas = document.createElement('canvas');
  canvas.width = RES;
  canvas.height = RES;
  const cap = document.createElement('span');
  cap.className = 'cap';
  cap.textContent = `≤ ${depth} bounce${depth > 1 ? 's' : ''}`;
  tile.append(canvas, cap);
  rowEl.appendChild(tile);
  return {
    depth,
    film: new Film(RES, RES),
    integrator: new NEEPathTracer({ maxBounces: depth, rrStartDepth: RR_START_DEPTH }),
    sampler: new IndependentSampler(SEED),
    ctx: canvas.getContext('2d')!,
    cap,
  };
});

// Mean image luminance — the scalar behind "how much of the light is here".
function meanLuminance(film: Film): number {
  let sum = 0;
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const [r, g, b] = film.pixel(x, y);
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  }
  return sum / (RES * RES);
}

function recaption(): void {
  const reference = meanLuminance(panes[panes.length - 1]!.film);
  for (const pane of panes) {
    const share = reference > 0 ? (meanLuminance(pane.film) / reference) * 100 : 0;
    const label = `≤ ${pane.depth} bounce${pane.depth > 1 ? 's' : ''}`;
    pane.cap.textContent =
      pane.depth === DEEPEST
        ? `${label} — reference`
        : `${label} — ${share.toFixed(1)}% of the light`;
  }
}

const scene = buildScene(description, RES, RES);

async function render(): Promise<void> {
  const t0 = performance.now();
  for (let spp = 0; spp < TARGET_SPP; spp++) {
    for (const pane of panes) {
      renderPass(scene, pane.integrator, pane.sampler, pane.film, spp);
      pane.ctx.putImageData(new ImageData(pane.film.develop(), RES, RES), 0, 0);
      await new Promise((r) => setTimeout(r)); // keep the page responsive
    }
    recaption();
    statusEl.textContent =
      `${SCENE_NAME} · pt-nee · ${RES}×${RES} · ${spp + 1}/${TARGET_SPP} spp · ` +
      `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }
  statusEl.textContent += ' · complete';
}

void render();

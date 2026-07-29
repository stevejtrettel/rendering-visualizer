// The Veach pyramid, live: every BDPT strategy (s, t) accumulates into its
// own cell — weighted (what MIS actually adds) or unweighted (what the
// strategy alone believes the image is). Debugger during development, talk
// figure after: the PATTERN of wrong cells localizes bugs, and the pixelwise
// sum of weighted cells must reproduce the final image exactly.
//
// Main-thread chunked render (like viz-image-forming's tracer): the pyramid
// is depth-capped and RR-free so the truncated-transport sum property is
// exact, and a worker pool would buy little at this resolution.
import { loadSceneRegistry } from '../_shared/scenes';

const SCENES = await loadSceneRegistry();
import { buildScene } from '../../src/core/scene/scene';
import { IndependentSampler } from '../../src/core/sampler/independent';
import { pixelSeedKey } from '../../src/core/sampler/sampler';
import {
  BDPT,
  type StrategyContribution,
  type StrategySink,
} from '../../src/core/integrators/bdpt';
import type { MisHeuristic } from '../../src/core/integrators/bdpt-mis';
import { Film } from '../../src/render/film';
import { NULL_RECORDER } from '../../src/trace/recorder';

const RES = 96;
const MAX_SPP = 512;
const DEPTH = 4; // pyramid rows 0..DEPTH; maxBounces caps transport to match
const SEED = 0;

let sceneName = 'cornell-glass';
const desc = () => SCENES[sceneName]!;
let view: 'weighted' | 'unweighted' = 'weighted';
let heuristic: MisHeuristic = 'power';
let assertWeights = false;
let spp = 0;
let token = 0;

const infoEl = document.getElementById('info')!;
const residualEl = document.getElementById('residual')!;

// --- Build the cell grid: row d holds (s, t) with s + t - 2 = d, t >= 1,
// (1,1) skipped. ---
interface Cell {
  s: number;
  t: number;
  weighted: Film;
  unweighted: Film;
  ctx: CanvasRenderingContext2D;
}

const cells = new Map<string, Cell>();
const pyramidEl = document.getElementById('pyramid')!;
for (let d = 0; d <= DEPTH; d++) {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('div');
  label.className = 'row-label';
  label.textContent = `depth ${d}`;
  row.appendChild(label);
  for (let s = 0; s <= d + 1; s++) {
    const t = d + 2 - s;
    if (t < 1 || (s === 1 && t === 1)) continue;
    const holder = document.createElement('div');
    holder.className = 'cell';
    const canvas = document.createElement('canvas');
    canvas.width = RES;
    canvas.height = RES;
    // Cross-demo jump: click a pixel inside a cell to open viz-single-path
    // isolating this strategy at (approximately) that pixel — coordinates
    // scale from our raster to single-path's 160^2 preview.
    canvas.style.cursor = 'crosshair';
    canvas.title = `open (s=${s}, t=${t}) as an animated path`;
    canvas.addEventListener('click', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const px = Math.floor((((ev.clientX - rect.left) / rect.width) * RES * 160) / RES);
      const py = Math.floor((((ev.clientY - rect.top) / rect.height) * RES * 160) / RES);
      const q = new URLSearchParams({
        scene: sceneName, integrator: 'bdpt', px: String(px), py: String(py), s: String(s), t: String(t),
      });
      window.open(`../viz-single-path/?${q}`);
    });
    const cap = document.createElement('span');
    cap.className = 'cap';
    cap.textContent = `s=${s} t=${t}`;
    holder.append(canvas, cap);
    row.appendChild(holder);
    cells.set(`${s},${t}`, {
      s,
      t,
      weighted: new Film(RES, RES),
      unweighted: new Film(RES, RES),
      ctx: canvas.getContext('2d')!,
    });
  }
  pyramidEl.appendChild(row);
}

const finalCanvas = document.getElementById('final') as HTMLCanvasElement;
finalCanvas.width = RES;
finalCanvas.height = RES;
const finalCtx = finalCanvas.getContext('2d')!;
let finalFilm = new Film(RES, RES);

// Everything accumulates in splat slots (raw sums / spp at develop), so a
// cell's normalization is independent of how often its strategy fired.
const sink: StrategySink = {
  add(c: StrategyContribution): void {
    const cell = cells.get(`${c.s},${c.t}`);
    if (!cell) return; // cannot happen: maxBounces caps enumeration at DEPTH
    cell.weighted.splat(c.raster, c.weighted);
    cell.unweighted.splat(c.raster, c.unweighted);
  },
};

function repaint(): void {
  if (spp === 0) return;
  const scale = { splatScale: 1 / spp };
  for (const cell of cells.values()) {
    const film = view === 'weighted' ? cell.weighted : cell.unweighted;
    cell.ctx.putImageData(new ImageData(film.develop(scale), RES, RES), 0, 0);
  }
  finalCtx.putImageData(new ImageData(finalFilm.develop(scale), RES, RES), 0, 0);

  // The in-browser statement of the sum property: max pixel deviation of
  // (sum of weighted cells) from the final image, relative to its peak.
  let maxDiff = 0;
  let peak = 1e-9;
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const f = finalFilm.pixel(x, y, scale);
      let sr = 0, sg = 0, sb = 0;
      for (const cell of cells.values()) {
        const [r, g, b] = cell.weighted.pixel(x, y, scale);
        sr += r; sg += g; sb += b;
      }
      maxDiff = Math.max(maxDiff, Math.abs(sr - f[0]), Math.abs(sg - f[1]), Math.abs(sb - f[2]));
      peak = Math.max(peak, f[0], f[1], f[2]);
    }
  }
  residualEl.textContent = `max |Σ cells − final| = ${(maxDiff / peak).toExponential(2)} of peak`;
}

async function renderLoop(myToken: number): Promise<void> {
  const scene = buildScene(desc(), RES, RES);
  const sampler = new IndependentSampler(SEED);
  const bdpt = new BDPT({
    maxBounces: DEPTH,
    rrStartDepth: 999, // no RR: cells show their strategy's true transport
    heuristic,
    assertWeights,
    strategyFilms: sink,
  });
  let renderMillis = 0;
  for (let i = 0; i < MAX_SPP; i++) {
    for (let y = 0; y < RES; y++) {
      const t0 = performance.now();
      for (let x = 0; x < RES; x++) {
        sampler.startPixelSample(pixelSeedKey(x, y, i));
        try {
          for (const c of bdpt.sampleContributions([x, y], sampler, scene, NULL_RECORDER)) {
            if (c.kind === 'sample') finalFilm.addSample(c.raster, c.value);
            else finalFilm.splat(c.raster, c.value);
          }
        } catch (err) {
          infoEl.className = 'error';
          infoEl.textContent = String(err);
          return;
        }
      }
      renderMillis += performance.now() - t0;
      if (y % 16 === 15) {
        await new Promise((r) => setTimeout(r));
        if (token !== myToken) return;
      }
    }
    spp = i + 1;
    repaint();
    infoEl.className = '';
    infoEl.textContent =
      `${sceneName} · ${spp} spp · ${(renderMillis / spp).toFixed(0)} ms/pass` +
      ` · ${heuristic}${assertWeights ? ' · asserting Σw=1 per path' : ''}`;
    await new Promise((r) => setTimeout(r));
    if (token !== myToken) return;
  }
}

function restart(): void {
  token += 1;
  spp = 0;
  finalFilm = new Film(RES, RES);
  for (const cell of cells.values()) {
    cell.weighted.data.fill(0);
    cell.unweighted.data.fill(0);
  }
  void renderLoop(token);
}

// --- Controls ---
const sceneSelect = document.getElementById('scene') as HTMLSelectElement;
for (const name of Object.keys(SCENES)) {
  sceneSelect.add(new Option(name, name, undefined, name === sceneName));
}
sceneSelect.addEventListener('change', () => {
  sceneName = sceneSelect.value;
  restart();
});
(document.getElementById('view') as HTMLSelectElement).addEventListener('change', (e) => {
  view = (e.target as HTMLSelectElement).value as typeof view;
  repaint(); // display-only: both accumulations are always kept
});
(document.getElementById('heuristic') as HTMLSelectElement).addEventListener('change', (e) => {
  heuristic = (e.target as HTMLSelectElement).value as MisHeuristic;
  restart();
});
(document.getElementById('assert') as HTMLInputElement).addEventListener('change', (e) => {
  assertWeights = (e.target as HTMLInputElement).checked;
  restart();
});

restart();

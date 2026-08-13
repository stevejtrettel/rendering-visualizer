/**
 * SHOWS: every way a bidirectional path tracer can build a path of a given
 * length — and that they add up to the picture.
 *
 * Veach's pyramid, live. Row d holds the strategies that make a path of
 * depth d: s vertices walked from the lamp, t walked from the camera,
 * s + t - 2 = d. Read across a row and the SAME transport is being sampled
 * every time, by a different split between the two walks; read down and the
 * paths get longer. (s, t) = (1, 1) is skipped — a camera vertex connected
 * straight to a light vertex is the camera looking at the lamp, which the
 * other strategies already cover.
 *
 * Two views, and the difference between them is the argument:
 *
 *   unweighted   what a strategy alone believes the image is. Each cell is
 *                a complete, unbiased, usually terrible estimate — s = 0
 *                is plain path tracing and finds the lamp by accident,
 *                large s is light tracing and smears, and the specular
 *                cells are black because that strategy cannot sample them.
 *   weighted     what MIS actually adds. Every cell keeps only what it is
 *                good at, and the panel on the right is their SUM.
 *
 * The residual line under the final image states that sum property as a
 * number: max |Σ weighted cells − final| over the frame, relative to peak.
 * It is ~1e-7 (float noise) when the weights are right and obviously not
 * when they are not — which is why this page was a debugger before it was
 * a figure, and why it stays honest as a figure.
 *
 * Roulette is OFF and the depth cap is the pyramid's own depth, so the
 * displayed cells are ALL the transport there is and the sum is exact
 * rather than approximate. That is also why the final image is dimmer than
 * a full render: paths longer than the pyramid simply do not exist here.
 *
 * Rendered on the main thread, chunked, rather than through the worker
 * pool: the per-(s, t) sink is local-only by design (see the note in
 * src/render/protocol.ts) — the films cannot cross to a worker.
 *
 * Rebuilt 2026-08-06 from legacy/viz-bdpt-pyramid, which drew its cells as
 * DOM canvases (invisible to the exporter) and had no scene selector.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { buildScene } from '@/core/scene/scene';
import { IndependentSampler } from '@/core/sampler/independent';
import { pixelSeedKey } from '@/core/sampler/sampler';
import { BDPT, type StrategyContribution, type StrategySink } from '@/core/integrators/bdpt';
import type { MisHeuristic } from '@/core/integrators/bdpt-mis';
import { Film } from '@/render/film';
import { NULL_RECORDER } from '@/trace/recorder';
import { sppSchedule, type Pacing } from '@/render/convergence';
import { FilmPanel } from '@/viz/film-panel';
import { ProgressBar } from '@/viz/progress-bar';
import { label, setText } from '@/viz/text';
import type { Text } from 'troika-three-text';

// --- Figure spec -----------------------------------------------------------
// Fourteen-odd films on screen at once, so each is small; the figure is
// about which cells are bright and which are black, not about detail.
const RES = 96;
const SEED = 0;
const FPS = 60;
const DURATION = 10;
const NO_RR = 999; // no roulette: a cell must show its strategy's true transport
// Depth 3 is 13 cells (row 0 loses (1,1)) in rows of 1/3/4/5 — big enough
// to read projected. Depth 4 is the legacy default and adds a row of 6.
const DEPTH = 3;
const MAX_SPP = 256;
const DEFAULT_SPP = 32;
// Scanlines between yields to the browser. The page has to stay responsive
// while a pass runs, and a pass is seconds, not milliseconds.
const CHUNK = 16;

// Layout, in HUD units (y from −1 to +1, x from ∓16/9).
const PY_CX = -0.5; // pyramid centre; the final image lives to the right
const PY_TOP = 0.66;
const PY_BOTTOM = -0.86;
const PY_MAX_W = 1.92;
const CELL_GAP = 0.035;
const CAP_GAP = 0.09; // room under each row for its s/t caption
const FINAL = { center: [1.15, 0.2] as [number, number], height: 0.8 };

type View = 'weighted' | 'unweighted';
const VIEWS: View[] = ['weighted', 'unweighted'];
const HEURISTICS: MisHeuristic[] = ['power', 'balance'];
const SCENE_NAMES = Object.keys(SCENES) as SceneName[];

// --- Which cells exist -----------------------------------------------------
interface Cell {
  s: number;
  t: number;
  d: number;
}

/** Row d holds every (s, t) with s + t − 2 = d and t ≥ 1, minus (1, 1). */
function cellsFor(depth: number): Cell[] {
  const out: Cell[] = [];
  for (let d = 0; d <= depth; d++) {
    for (let s = 0; s <= d + 1; s++) {
      const t = d + 2 - s;
      if (t < 1 || (s === 1 && t === 1)) continue;
      out.push({ s, t, d });
    }
  }
  return out;
}

// --- Stage -----------------------------------------------------------------
const stage = createStage({ lights: false, controls: false });
stage.duration = DURATION;
const ui = createUI(stage, { fps: FPS });
stage.camera.position.set(0, 0, 5);

const header = label('', {
  size: 0.052,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'top',
  position: [0, 0.97, 0],
});
const finalLabel = label('final image', {
  size: 0.044,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'bottom',
  position: [FINAL.center[0], FINAL.center[1] + FINAL.height / 2 + 0.04, 0],
});
const residual = label('', {
  size: 0.036,
  color: C.ash,
  anchorX: 'center',
  anchorY: 'top',
  lineHeight: 1.5,
  position: [FINAL.center[0], FINAL.center[1] - FINAL.height / 2 - 0.06, 0],
});
stage.hud.add(header, finalLabel, residual);

const progress = new ProgressBar({ center: [FINAL.center[0], -0.72], width: 0.8 });
stage.hud.add(progress.group);

const finalPanel = new FilmPanel({
  width: RES,
  height: RES,
  center: FINAL.center,
  drawnHeight: FINAL.height,
});
stage.hud.add(finalPanel.group);

// --- Cell panels -----------------------------------------------------------
// Rebuilt whenever the depth changes: the count, the size and the row
// offsets all follow from it.
let cells: Cell[] = [];
/** (s, t) → index into `cells` / `panels`, so the sink never searches. */
const cellIndex = new Map<string, number>();
let panels: FilmPanel[] = [];
let cellCaptions: Text[] = [];
let rowLabels: Text[] = [];

function buildPyramid(depth: number): void {
  for (const p of panels) p.dispose();
  for (const l of [...cellCaptions, ...rowLabels]) {
    l.removeFromParent();
    l.dispose();
  }
  panels = [];
  cellCaptions = [];
  rowLabels = [];
  cells = cellsFor(depth);

  const rows = depth + 1;
  const widest = depth + 2; // the bottom row, s = 0 … depth + 1
  const size = Math.min(
    (PY_MAX_W - CELL_GAP * (widest - 1)) / widest,
    (PY_TOP - PY_BOTTOM - CAP_GAP * (rows - 1)) / rows,
  );
  const pitch = size + CAP_GAP;
  const rowY = (d: number) => PY_TOP - size / 2 - d * pitch;

  for (let d = 0; d <= depth; d++) {
    const inRow = cells.filter((c) => c.d === d);
    const rowW = inRow.length * size + (inRow.length - 1) * CELL_GAP;
    const y = rowY(d);
    inRow.forEach((cell, i) => {
      const x = PY_CX - rowW / 2 + size / 2 + i * (size + CELL_GAP);
      const panel = new FilmPanel({ width: RES, height: RES, center: [x, y], drawnHeight: size });
      panels.push(panel);
      stage.hud.add(panel.group);
      cellCaptions.push(
        label(`s=${cell.s}  t=${cell.t}`, {
          size: 0.032,
          color: C.ash,
          anchorX: 'center',
          anchorY: 'top',
          position: [x, y - size / 2 - 0.018, 0],
        }),
      );
    });
    // Row labels hang off the left of the WIDEST row, so they form a column
    // rather than stepping in with the triangle.
    const widestW = widest * size + (widest - 1) * CELL_GAP;
    rowLabels.push(
      label(`depth ${d}`, {
        size: 0.034,
        color: C.slate,
        anchorX: 'right',
        anchorY: 'middle',
        position: [PY_CX - widestW / 2 - 0.05, y, 0],
      }),
    );
  }
  stage.hud.add(...cellCaptions, ...rowLabels);
  // `cells` is in row-major order and so is `panels`.
  cellIndex.clear();
  cells.forEach((c, i) => cellIndex.set(`${c.s},${c.t}`, i));
}

// --- Controls --------------------------------------------------------------
const params = {
  scene: 'cornell-glass' as SceneName,
  view: 'weighted' as View,
  heuristic: 'power' as MisHeuristic,
  depth: DEPTH,
  maxSpp: DEFAULT_SPP,
  pacing: 'log' as Pacing,
  holdStart: 0.5,
  holdEnd: 1.5,
};

ui.params.add(params, 'scene', SCENE_NAMES).onChange(restart);
// Display-only: both accumulations are always kept, so this never re-renders.
ui.params.add(params, 'view', VIEWS).name('cells show').onChange(() => {
  shownSpp = -1;
});
ui.params.add(params, 'heuristic', HEURISTICS).name('MIS weights').onChange(restart);
ui.params.add(params, 'depth', 1, 5, 1).name('pyramid depth').onChange(restart);
ui.params.add(params, 'maxSpp', 1, MAX_SPP, 1).name('up to (spp)').onChange(restart);
ui.params.add(params, 'pacing', ['log', 'linear', 'sqrt']).onChange(rebuildSchedule);
ui.params.add(params, 'holdStart', 0, 5, 0.1).name('hold first (s)').onChange(rebuildSchedule);
ui.params.add(params, 'holdEnd', 0, 5, 0.1).name('hold last (s)').onChange(rebuildSchedule);

let schedule: number[] = [];
let scheduledFor = -1;
function rebuildSchedule(): void {
  scheduledFor = stage.duration;
  schedule = sppSchedule({
    frames: Math.max(1, Math.round(stage.duration * FPS)),
    maxSpp: params.maxSpp,
    pacing: params.pacing,
    holdStart: Math.round(params.holdStart * FPS),
    holdEnd: Math.round(params.holdEnd * FPS),
  });
}

// --- Rendering -------------------------------------------------------------
// One snapshot per distinct spp on the schedule, so scrubbing the clock is a
// blit rather than a re-render. Both views are kept: toggling between them
// is a display change, and re-tracing for it would cost a minute.
interface Snapshot {
  spp: number;
  weighted: Uint8ClampedArray[];
  unweighted: Uint8ClampedArray[];
  final: Uint8ClampedArray;
  /** max |Σ weighted cells − final| across the frame, relative to peak. */
  residual: number;
}

let snapshots: Snapshot[] = [];
let shownSpp = -1;
let generation = 0;
let ready: Promise<unknown> = Promise.resolve();

function restart(): void {
  const gen = ++generation;
  snapshots = [];
  shownSpp = -1;
  stage.speed = 0;
  stage.t = 0;
  rebuildSchedule();
  buildPyramid(params.depth);
  finalPanel.clear();
  for (const p of panels) p.clear();
  setText(residual, '');
  progress.visible = true;
  progress.set(0);
  ready = render(gen).catch((err: Error) => {
    if (gen !== generation) return;
    progress.visible = false;
    setText(header, `render failed: ${err.message}`);
  });
}

async function render(gen: number): Promise<void> {
  const description = SCENES[params.scene];
  const scene = buildScene(description, RES, RES);
  const sampler = new IndependentSampler(SEED);

  const weighted = cells.map(() => new Film(RES, RES));
  const unweighted = cells.map(() => new Film(RES, RES));
  const finalFilm = new Film(RES, RES);

  // Everything a cell receives goes in through the splat slot, so a cell's
  // normalisation is 1/spp regardless of how often its strategy fired —
  // a strategy that contributes to one pixel in a thousand must not be
  // divided by its own hit count.
  const sink: StrategySink = {
    add(c: StrategyContribution): void {
      const i = cellIndex.get(`${c.s},${c.t}`);
      if (i === undefined) return; // cannot happen: maxBounces caps enumeration
      weighted[i]!.splat(c.raster, c.weighted);
      unweighted[i]!.splat(c.raster, c.unweighted);
    },
  };

  // The walk cap is one MORE than the pyramid depth, and the pyramid depth
  // is enforced by the strategy filter instead. `maxBounces` caps SURFACE
  // VERTICES (walk.ts), so a camera walk capped at d yields at most d + 1
  // vertices and the (s = 0, t = d + 2) cell — pure path tracing at the
  // bottom-left of every row — could never fire at all. The filter is
  // applied before BOTH the cell sink and the final image, so the two stay
  // in exact agreement and the residual still means what it says.
  const bdpt = new BDPT({
    maxBounces: params.depth + 1,
    rrStartDepth: NO_RR,
    heuristic: params.heuristic,
    strategyFilms: sink,
    strategyFilter: (s, t) => s + t - 2 <= params.depth,
  });

  const wanted = new Set(schedule);
  const target = params.maxSpp;

  for (let i = 0; i < target; i++) {
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

    const spp = i + 1;
    progress.set(spp / target);
    setText(header, `${params.scene} · rendering… ${spp} / ${target} spp`);

    if (!wanted.has(spp) && spp !== target) continue;

    const opts = { splatScale: 1 / spp };
    const snap: Snapshot = {
      spp,
      weighted: weighted.map((f) => f.develop(opts)),
      unweighted: unweighted.map((f) => f.develop(opts)),
      final: finalFilm.develop(opts),
      residual: residualOf(weighted, finalFilm, opts),
    };
    snapshots.push(snap);
    // Show the newest pass while the rest is still coming, so the page is
    // watchable rather than blank for a minute.
    if (gen === generation) {
      show(snap);
      shownSpp = -1; // the clock has not driven this; let it re-blit later
    }
  }

  if (gen !== generation) return;
  progress.visible = false;
  stage.speed = 1;
}

/**
 * The sum property, as a number: the weighted cells must reproduce the final
 * image pixel for pixel. Relative to the frame's peak, because an absolute
 * difference means nothing against radiance in the hundreds.
 */
function residualOf(
  weighted: Film[],
  finalFilm: Film,
  opts: { splatScale: number },
): number {
  let maxDiff = 0;
  let peak = 1e-9;
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const f = finalFilm.pixel(x, y, opts);
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (const film of weighted) {
        const [r, g, b] = film.pixel(x, y, opts);
        sr += r;
        sg += g;
        sb += b;
      }
      maxDiff = Math.max(maxDiff, Math.abs(sr - f[0]), Math.abs(sg - f[1]), Math.abs(sb - f[2]));
      peak = Math.max(peak, f[0], f[1], f[2]);
    }
  }
  return maxDiff / peak;
}

// --- Display ---------------------------------------------------------------
function show(snap: Snapshot): void {
  const images = params.view === 'weighted' ? snap.weighted : snap.unweighted;
  panels.forEach((p, i) => {
    const rgba = images[i];
    if (rgba) p.update(rgba);
  });
  finalPanel.update(snap.final);

  const cap =
    params.view === 'weighted'
      ? 'MIS-weighted cells — this image is their sum'
      : 'cells are UNWEIGHTED — each is its own estimate of this image';
  setText(residual, `${cap}\nmax |Σ cells − final| = ${snap.residual.toExponential(2)} of peak`);
  setText(
    header,
    `${params.scene} · ${snap.spp} spp · ${params.view} · ${params.heuristic} weights · ` +
      `depth ≤ ${params.depth}, no roulette`,
  );
}

/** The newest snapshot at or below `spp` — snapshots arrive in order. */
function snapshotAt(spp: number): Snapshot | null {
  let best: Snapshot | null = null;
  for (const s of snapshots) {
    if (s.spp > spp) break;
    best = s;
  }
  return best ?? snapshots[0] ?? null;
}

stage.onReady(async () => {
  await ready;
});

stage.frame((t) => {
  if (stage.duration !== scheduledFor) rebuildSchedule();
  if (snapshots.length === 0) return;
  const frame = Math.min(schedule.length - 1, Math.max(0, Math.floor(t * FPS)));
  const spp = schedule[frame] ?? 1;
  if (spp === shownSpp) return;
  const snap = snapshotAt(spp);
  if (!snap) return;
  shownSpp = spp;
  show(snap);
});

stage.start();
restart();

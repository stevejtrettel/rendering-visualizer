// SHOWS: ReSTIR's parallel reuse made visible — the mirror image of
// viz-mlt-chain. The chandelier renders progressively on the main thread;
// a source map colors every pixel by where its CURRENT reservoir sample
// came from (fresh candidates / the previous pass / a spatial neighbor),
// and clicking a pixel draws its reuse LINEAGE: the chain of adoptions,
// across neighbors and passes, that delivered the light sample it is
// shading with right now — ending at a ☀ marker on the emitter that some
// pixel, somewhere, once discovered fresh.
//
// The lineage walks the recorded end-of-pass provenance (a spatial parent's
// mid-round state is approximated by its end-of-pass record) — an honest
// simplification for display; the renderer itself is the tested driver.
import { SCENES } from '../../src/scenes/registry';
import type { Vec3 } from '../../src/core/math/vec3';
import { buildScene } from '../../src/core/scene/scene';
import { Film } from '../../src/render/film';
import { RestirRunner } from '../../src/render/restir-driver';

// --- Figure spec (constants per house rules) ---
const SCENE_NAME = 'chandelier';
const RES = 128;
const DISPLAY = 512;
const SEED = 0;
const MAX_DEPTH = 8;
const HISTORY = 64; // provenance ring buffer (passes)
const LINEAGE_MAX_HOPS = 12;

const SOURCE_COLORS: Record<string, string> = {
  fresh: '#ffb054',
  temporal: '#6fa8ff',
  spatial: '#55cc77',
  none: '#16161a',
};

const infoEl = document.getElementById('info')!;
const statsEl = document.getElementById('stats')!;
const pixelInfoEl = document.getElementById('pixel-info')!;

const scene = buildScene(SCENES[SCENE_NAME], RES, RES);
const film = new Film(RES, RES);
const runner = new RestirRunner(scene, film, { seed: SEED, maxBounces: MAX_DEPTH });

// Per-pass provenance snapshots (ring buffer): source, spatial parent, and
// the selected light-sample position per pixel.
interface Provenance {
  source: 'none' | 'fresh' | 'temporal' | 'spatial';
  from: readonly [number, number] | null;
  lightP: Vec3 | null;
}
const history: Provenance[][] = [];

const renderCanvas = document.getElementById('render') as HTMLCanvasElement;
const sourcesCanvas = document.getElementById('sources') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
renderCanvas.style.width = `${DISPLAY}px`;
renderCanvas.style.height = `${DISPLAY}px`;
sourcesCanvas.style.width = `${DISPLAY}px`;
sourcesCanvas.style.height = `${DISPLAY}px`;
const renderCtx = renderCanvas.getContext('2d')!;
const sourcesCtx = sourcesCanvas.getContext('2d')!;
const overlayCtx = overlay.getContext('2d')!;

let selected: readonly [number, number] | null = null;
let playing = true;

function snapshotProvenance(): void {
  const snap: Provenance[] = runner.reservoirs.map((r) => ({
    source: r.source,
    from: r.from,
    lightP: r.y ? r.y.p : null,
  }));
  history.push(snap);
  if (history.length > HISTORY) history.shift();
}

function drawFrames(): void {
  renderCtx.putImageData(new ImageData(film.develop(), RES, RES), 0, 0);
  const img = sourcesCtx.createImageData(RES, RES);
  const counts = { none: 0, fresh: 0, temporal: 0, spatial: 0 };
  runner.reservoirs.forEach((r, i) => {
    counts[r.source] += 1;
    const c = SOURCE_COLORS[r.source]!;
    img.data[i * 4] = parseInt(c.slice(1, 3), 16);
    img.data[i * 4 + 1] = parseInt(c.slice(3, 5), 16);
    img.data[i * 4 + 2] = parseInt(c.slice(5, 7), 16);
    img.data[i * 4 + 3] = 255;
  });
  sourcesCtx.putImageData(img, 0, 0);
  const n = RES * RES;
  statsEl.innerHTML =
    `this pass: <b class="fresh">${((counts.fresh / n) * 100).toFixed(0)}% fresh</b> · ` +
    `<b class="temporal">${((counts.temporal / n) * 100).toFixed(0)}% temporal</b> · ` +
    `<b class="spatial">${((counts.spatial / n) * 100).toFixed(0)}% spatial</b>`;
  infoEl.textContent =
    `${SCENE_NAME} · ${scene.lights.length} lights · pass ${runner.passesDone} · ` +
    `M=${runner.options.candidates}, ${runner.options.spatialRounds}×${runner.options.spatialNeighbors} spatial, ` +
    `${runner.options.pHatVisibility ? 'shadowed' : 'unshadowed'} p̂`;
}

// Reconstruct the clicked pixel's adoption chain from the provenance ring.
function lineage(px: number, py: number): Array<{ x: number; y: number; source: string }> {
  const chain: Array<{ x: number; y: number; source: string }> = [];
  let h = history.length - 1;
  let x = px;
  let y = py;
  const seen = new Set<string>();
  for (let hop = 0; hop < LINEAGE_MAX_HOPS && h >= 0; hop++) {
    const key = `${x},${y},${h}`;
    if (seen.has(key)) break;
    seen.add(key);
    const entry = history[h]![y * RES + x]!;
    chain.push({ x, y, source: entry.source });
    if (entry.source === 'spatial' && entry.from) {
      [x, y] = [entry.from[0], entry.from[1]];
    } else if (entry.source === 'temporal') {
      h -= 1;
    } else {
      break;
    }
  }
  return chain;
}

function drawOverlay(): void {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  if (!selected) {
    pixelInfoEl.textContent = 'no pixel selected';
    return;
  }
  const [px, py] = selected;
  const scale = overlay.width / RES;
  const cx = (x: number) => (x + 0.5) * scale;
  const chain = lineage(px, py);

  // Adoption arrows, brightest at the shaded pixel, fading toward origin.
  overlayCtx.lineWidth = 2;
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = chain[i + 1]!;
    const b = chain[i]!;
    const alpha = Math.max(0.25, 1 - i * 0.12);
    overlayCtx.strokeStyle = `rgba(85, 204, 119, ${alpha})`;
    overlayCtx.beginPath();
    overlayCtx.moveTo(cx(a.x), cx(a.y));
    overlayCtx.lineTo(cx(b.x), cx(b.y));
    overlayCtx.stroke();
    overlayCtx.fillStyle = SOURCE_COLORS[a.source] ?? '#888';
    overlayCtx.fillRect(cx(a.x) - 2.5, cx(a.y) - 2.5, 5, 5);
  }
  // Selected pixel marker.
  overlayCtx.strokeStyle = '#ffffff';
  overlayCtx.strokeRect(px * scale, py * scale, scale, scale);

  // The light sample itself: project to the image via the camera.
  const prov = history[history.length - 1]?.[py * RES + px];
  if (prov?.lightP) {
    const sw = scene.camera.sampleWi(prov.lightP);
    if (sw) {
      const lx = (sw.raster[0] / RES) * overlay.width;
      const ly = (sw.raster[1] / RES) * overlay.height;
      overlayCtx.strokeStyle = '#ffee88';
      overlayCtx.lineWidth = 1.5;
      for (const [dx, dy] of [[6, 0], [0, 6], [4.2, 4.2], [4.2, -4.2]] as const) {
        overlayCtx.beginPath();
        overlayCtx.moveTo(lx - dx, ly - dy);
        overlayCtx.lineTo(lx + dx, ly + dy);
        overlayCtx.stroke();
      }
    }
  }

  const origin = chain[chain.length - 1]!;
  const hops = chain.length - 1;
  pixelInfoEl.textContent =
    `pixel (${px}, ${py}): sample via ${hops} adoption${hops === 1 ? '' : 's'} — ` +
    `${chain.map((c) => c.source).join(' ← ')}` +
    (origin.source === 'fresh' ? ` (discovered at (${origin.x}, ${origin.y}))` : '');
}

renderCanvas.addEventListener('click', (e) => {
  const rect = renderCanvas.getBoundingClientRect();
  selected = [
    Math.min(RES - 1, Math.floor(((e.clientX - rect.left) / rect.width) * RES)),
    Math.min(RES - 1, Math.floor(((e.clientY - rect.top) / rect.height) * RES)),
  ];
  drawOverlay();
});

const playBtn = document.getElementById('play') as HTMLButtonElement;
playBtn.addEventListener('click', () => {
  playing = !playing;
  playBtn.textContent = playing ? '❚❚ pause' : '▶ play';
  if (playing) tick();
});
document.getElementById('step')!.addEventListener('click', () => {
  playing = false;
  playBtn.textContent = '▶ play';
  advance();
});

function advance(): void {
  runner.pass();
  snapshotProvenance();
  drawFrames();
  drawOverlay();
}

function tick(): void {
  if (!playing) return;
  advance();
  // A pass takes real time at this resolution; yield to the browser between
  // passes so clicking and pausing stay responsive.
  setTimeout(() => requestAnimationFrame(tick), 30);
}

tick();

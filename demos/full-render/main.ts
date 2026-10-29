/**
 * SHOWS: the short box rendered for real, full size, getting better as you
 * watch, and the converged image it is heading for. The talk's slide after
 * many-samples: there the average of 64 tiny noisy images settled; here a
 * RES x RES image does the same live, on every core, the count of paths per
 * pixel climbing beside it. Live means LiveRender: workers post their paths
 * in small chunks of pixels in a scattered order, so the picture fills in as
 * speckle from the first frame (Steve, 2026-10-29: the live view was
 * extremely slow to load; it should start at once, noisy, as move-camera).
 *
 * `image` switches between:
 *
 *   live       the render in progress, refining as passes land;
 *   converged  the same render taken to BAKED_SPP paths per pixel, saved in
 *              this folder as converged.png, so it shows at once.
 *
 * The converged image is made by this page, the same tracer and settings,
 * in bake mode: open demo.html?d=full-render&bake=SPP and wait for
 * window.__baked (a PNG data URL); converged.json records the settings it
 * was made with. If they no longer match the constants below, the page
 * says so instead of showing an image of a different render.
 *
 * The tracer is pt-nee (path tracing that also aims at the lamp at every
 * bounce): an unbiased estimator of the same image as the pt-aim of the
 * slides before, the standard choice for a still. The live render's
 * intermediate states depend on worker timing, so they do not replay
 * exactly; only the converged image is deterministic, and that is what is
 * saved. Bake mode uses a WorkerPool, which merges whole passes in worker
 * order, so the baked image is bit-deterministic.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import type { IntegratorDescription } from '@/render/protocol';
import { WorkerPool, type PoolUpdate } from '@/render/pool';
import { LiveRender } from '@/render/live';
import { FilmPanel } from '@/viz/film-panel';
import { label, setText } from '@/viz/text';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
const RES = 960;
const SEED = 0;
const INTEGRATOR: IntegratorDescription = { name: 'pt-nee', maxBounces: 8 };
const LIVE_SPP = 4096; // the live render stops here
const PANEL = { center: [-0.12, 0] as [number, number], height: 1.84 };
const POOL_SIZE = Math.max(1, (navigator.hardwareConcurrency || 4) - 2);

/** The settings a saved converged image must have been made with. */
const SETTINGS = { scene: SCENE, res: RES, seed: SEED, integrator: INTEGRATOR };

// The saved image and its settings, if they have been baked yet.
const bakedUrl = Object.values(import.meta.glob('./converged.png', { eager: true, query: '?url', import: 'default' }))[0] as
  | string
  | undefined;
const bakedMeta = Object.values(import.meta.glob('./converged.json', { eager: true, import: 'default' }))[0] as
  | (typeof SETTINGS & { spp: number })
  | undefined;
const bakedMatches = !!bakedUrl && !!bakedMeta && JSON.stringify({ ...bakedMeta, spp: undefined }) === JSON.stringify({ ...SETTINGS, spp: undefined });

// --- Stage -----------------------------------------------------------------
const stage = createStage({ lights: false, controls: false });
const ui = createUI(stage, { timeline: false });
stage.camera.position.set(0, 0, 5); // the figure is entirely the HUD
stage.speed = 0;

const panel = new FilmPanel({ width: RES, height: RES, center: PANEL.center, drawnHeight: PANEL.height, border: false });
stage.hud.add(panel.group);
const caption = label('', {
  size: 0.07,
  color: C.bone,
  anchorX: 'left',
  anchorY: 'bottom',
  position: [PANEL.center[0] + PANEL.height / 2 + 0.06, PANEL.center[1] - PANEL.height / 2, 0],
});
stage.hud.add(caption);

// --- Controls --------------------------------------------------------------
type Show = 'live' | 'converged';
const params = { image: 'live' as Show };
ui.params.add(params, 'image', ['live', 'converged']).onChange(show);

// --- The live render ---------------------------------------------------------
const bakeTo = Number(new URLSearchParams(location.search).get('bake')) || 0;
const liveRgba = new Uint8ClampedArray(RES * RES * 4);
const live = bakeTo ? null : new LiveRender({ description: SCENES[SCENE], res: RES, tracer: 'nee', maxBounces: 8, maxSpp: LIVE_SPP });
if (bakeTo) {
  // Bake mode: whole passes, merged in worker order, developed once at the
  // end (developing every pass at RES x RES piled up and crashed the page).
  new WorkerPool({
    size: POOL_SIZE,
    description: SCENES[SCENE],
    width: RES,
    height: RES,
    seed: SEED,
    integrator: INTEGRATOR,
    maxSpp: bakeTo,
    onUpdate: (u: PoolUpdate) => {
      if (u.totalSpp >= bakeTo) bake(u.frame().rgba, u.totalSpp);
    },
  });
}

const perPixel = (n: number) =>
  n < 10 ? `${n.toFixed(1)} paths per pixel` : `${Math.floor(n).toLocaleString('en-US')} paths per pixel`;

// --- The converged image -----------------------------------------------------
let converged: Uint8ClampedArray | null = null;
if (bakedMatches) {
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = RES;
    canvas.height = RES;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    converged = ctx.getImageData(0, 0, RES, RES).data;
    if (params.image === 'converged') show();
  };
  img.src = bakedUrl!;
}

function show(): void {
  if (params.image === 'converged') {
    if (!bakedMatches) {
      setText(caption, 'no converged image saved for these settings');
      return;
    }
    if (converged) panel.update(converged);
    setText(caption, converged ? perPixel(bakedMeta!.spp) : 'loading…');
    return;
  }
  if (!live) return;
  live.develop(liveRgba);
  panel.update(liveRgba);
  setText(caption, perPixel(live.perPixel));
}
show();

// The live view refreshes every few frames: developing RES x RES is not free.
let frameCount = 0;
stage.frame(() => {
  if (params.image === 'live' && ++frameCount % 3 === 0) show();
});

// --- Bake mode -------------------------------------------------------------------
let baked = false;
function bake(rgba: Uint8ClampedArray, spp: number): void {
  if (baked) return;
  baked = true;
  const canvas = document.createElement('canvas');
  canvas.width = RES;
  canvas.height = RES;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), RES, RES), 0, 0);
  (window as unknown as { __baked: { png: string; meta: unknown } }).__baked = {
    png: canvas.toDataURL('image/png'),
    meta: { ...SETTINGS, spp },
  };
  console.log(`[full-render] baked ${spp} spp`);
}

stage.start();

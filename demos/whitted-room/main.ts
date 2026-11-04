/**
 * SHOWS: the talk's 1980s room, rendered by Whitted's tracer with every pass
 * in: albedo, brightness, shadow, Phong, reflection, refraction (Steve,
 * 2026-11-03: "a scene that has all the classic 1980s computer science
 * components"; a box room, and we are in it; "just filled in is fine").
 *
 * The whole frame is the image, 16:9. It fills in top to bottom over FILL
 * seconds, then holds. The film resolution slider is its height in pixels
 * (the width follows); changing it shows the finished image at once.
 * Computing is spread over frames (a budget per frame), so the page never
 * freezes; the fill never runs ahead of what is computed.
 *
 * The scene is `whitted-room` (src/scenes/registry.ts): cream and charcoal
 * tiles; `&tiles=classic` for Whitted's own red and yellow. The tracer is
 * src/core/integrators/whitted.ts, the same code as the rasterize slides'
 * passes: the white ball and both shiny balls get a Phong highlight, the
 * mirror is tinted blue, the glass is clear, index 1.5.
 */

import { createStage, createUI } from '@';
import { SCENES } from '@/scenes/registry';
import { buildScene } from '@/core/scene/scene';
import { cameraSample } from '@/core/integrators/estimators';
import { IndependentSampler } from '@/core/sampler/independent';
import { pixelSeedKey } from '@/core/sampler/sampler';
import { srgbEncode } from '@/render/film';
import { whittedTracer, WHITTED_PASSES, type RGB } from '@/core/integrators/whitted';
import { FilmPanel } from '@/viz/film-panel';
import { ASPECT } from '@/viz/stage';

// --- Figure spec -----------------------------------------------------------
const CLASSIC = new URLSearchParams(location.search).get('tiles') === 'classic';
const desc = SCENES[CLASSIC ? 'whitted-room-classic' : 'whitted-room'];
/** `&greenMirror=0.25`: the green wall partly reflective, a trial (Steve, 2026-11-03). */
const GREEN_MIRROR = Number(new URLSearchParams(location.search).get('greenMirror')) || 0;
/** `&wallPhong=0.3`: the walls and floor get a Phong highlight too, a trial (Steve, 2026-11-03). */
const WALL_PHONG = Number(new URLSearchParams(location.search).get('wallPhong')) || 0;
/** `&wallPower=`: the walls' Phong power, lower than the balls' for a broad sheen (Steve: lower the Phong power on the walls). */
const WALL_POWER = Number(new URLSearchParams(location.search).get('wallPower')) || 5;
const SPP = 4; // antialiasing only (8 doubled the time for edges that look the same)
const ALL = new Set(WHITTED_PASSES);
const START = 0.5;
const FILL = 4; // seconds, top to bottom
const HOLD = 3;
const BLANK = 18;
const BUDGET_MS = 12; // computing per frame

// --- Stage -----------------------------------------------------------------
const stage = createStage({ lights: false, controls: false });
const ui = createUI(stage);
stage.camera.position.set(0, 0, 5); // the figure is entirely the HUD
stage.loop = false;
stage.duration = START + FILL + HOLD;

/**
 * Speed: the tracer tests every ray against every primitive, and 80 of the
 * room's 100 were floor tiles. So the tracer sees one floor quad instead,
 * and colours it by which tile the point falls in: the same checkerboard,
 * about 5x fewer tests per ray. (The scene keeps its tiles for the path
 * tracer.)
 */
const traced = (() => {
  const tiles = desc.primitives.filter((p) => p.name?.startsWith('tile-'));
  const quads = tiles.map((p) => (p.shape.kind === 'quad' ? p.shape : null)!);
  const size = quads[0]!.e1[2]; // tiles are square, e1 along z
  const x0 = Math.min(...quads.map((q) => q.q[0]));
  const z0 = Math.min(...quads.map((q) => q.q[2]));
  const x1 = Math.max(...quads.map((q) => q.q[0])) + size;
  const z1 = Math.max(...quads.map((q) => q.q[2])) + size;
  const albedo = (name: string): RGB => {
    const m = tiles.find((p) => p.name === name)!.material;
    return m.kind === 'lambert' ? [m.albedo[0], m.albedo[1], m.albedo[2]] : [0.5, 0.5, 0.5];
  };
  const [A, B] = [albedo('tile-0-0'), albedo('tile-1-0')];
  return {
    desc: {
      ...desc,
      primitives: [
        ...desc.primitives.filter((p) => !p.name?.startsWith('tile-')),
        { name: 'floor', shape: { kind: 'quad' as const, q: [x0, 0, z0] as RGB, e1: [0, 0, z1 - z0] as RGB, e2: [x1 - x0, 0, 0] as RGB }, material: tiles[0]!.material },
      ],
    },
    albedoAt: (name: string, p: { x: number; z: number }) =>
      name === 'floor' ? ((Math.floor((p.x - x0) / size) + Math.floor((p.z - z0) / size)) % 2 ? B : A) : undefined,
  };
})();
const scene = buildScene(traced.desc, 1, 1);
/** Every wall and the floor (the quads that are not the lamp). */
const WALLS = traced.desc.primitives.filter((p) => p.shape.kind === 'quad' && !p.emission && !p.name!.startsWith('cube') && p.name !== 'wallMirror').map((p) => p.name!);
const { trace } = whittedTracer(traced.desc, {
  agg: scene.aggregate,
  albedoAt: traced.albedoAt,
  mirror: 'mirrorBall', // the blue one, tinted
  // the clear mirrors, and the green wall if &greenMirror
  reflective: { wallMirror: 0.9, smallMirror: 0.9, ...(GREEN_MIRROR > 0 ? { right: GREEN_MIRROR } : {}) },
  glass: ['glassBall', 'smallGlass'],
  ks: {
    ball: 0.5,
    mirrorBall: 0.5,
    glassBall: 0.5,
    yellowBall: 0.6,
    smallMirror: 0.5,
    smallGlass: 0.5,
    ...Object.fromEntries(WALL_PHONG > 0 ? WALLS.map((w) => [w, WALL_PHONG]) : []),
  },
  power: Object.fromEntries(WALLS.map((w) => [w, WALL_POWER])),
});

// --- The image, computed a few rows at a time ---------------------------------
const params = { grid: 270 };
let width = 0;
let height = 0;
let panel: FilmPanel | null = null;
let image = new Uint8ClampedArray(0); // finished rows, RGBA
let rowsDone = 0;
let shownRows = -1;
let camScene: ReturnType<typeof buildScene> | null = null;
const sampler = new IndependentSampler(0);

function restart(jump: boolean): void {
  height = Math.round(params.grid);
  width = Math.round(height * ASPECT);
  camScene = buildScene(traced.desc, width, height);
  image = new Uint8ClampedArray(width * height * 4);
  rowsDone = 0;
  shownRows = -1;
  panel?.dispose();
  panel = new FilmPanel({ width, height, center: [0, 0], drawnHeight: 2, border: false });
  stage.hud.add(panel.group);
  stage.t = jump ? START + FILL : 0;
}

function computeRow(y: number): void {
  for (let x = 0; x < width; x++) {
    const sum = [0, 0, 0];
    for (let s = 0; s < SPP; s++) {
      sampler.startPixelSample(pixelSeedKey(x, y, s));
      const rgb = trace(cameraSample(camScene!, [x, y], sampler).ray, ALL, scene.aggregate);
      for (let ch = 0; ch < 3; ch++) sum[ch]! += srgbEncode(rgb[ch]!);
    }
    const o = (y * width + x) * 4;
    for (let ch = 0; ch < 3; ch++) image[o + ch] = sum[ch]! / SPP;
    image[o + 3] = 255;
  }
}

ui.params.add(params, 'grid', 18, 540, 1).name('film resolution').onChange(() => restart(true));

stage.frame((t) => {
  if (!panel) return;
  const start = performance.now();
  while (rowsDone < height && performance.now() - start < BUDGET_MS) computeRow(rowsDone++);
  // The fill, eased in, never ahead of the computing.
  const u = Math.min(1, Math.max(0, (t - START) / FILL));
  const rows = Math.min(rowsDone, Math.floor(height * u * (2 - u)));
  if (rows === shownRows) return;
  shownRows = rows;
  const pixels = new Uint8ClampedArray(width * height * 4);
  pixels.set(image.subarray(0, rows * width * 4));
  for (let i = rows * width; i < width * height; i++) {
    pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = BLANK;
    pixels[i * 4 + 3] = 255;
  }
  panel.update(pixels);
});

stage.start();
restart(false);

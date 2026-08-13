// Photons leaving the lamp, and the few that land on the film.
//
// The mirror image of pixel-grid.ts. There the walk starts at the pinhole
// and the question is whether it ever touches an emitter; here it starts on
// the emitter and the question is whether it ever touches the film. Same
// random walk in the other transport mode — this is `generateLightSubpath`,
// exactly the light subpath BDPT builds, with nothing connected to anything.
//
// ONE THING IS NOT A TRUE MIRROR, and it is worth being straight about it.
// The lamp is a real primitive: a camera walk hits it because the aggregate
// says so. The film is not in the scene at all, and a PINHOLE camera records
// only rays that pass through a point — probability zero, which is precisely
// why a light tracer connects each vertex to the camera instead of waiting
// for a hit. So "landed on the film" here means the segment CROSSES the
// film rectangle: the plane read as a bare finite sensor, an open shutter
// with no lens. That is the only version of the question with anything to
// watch, and at the series' standard 1.4-unit plane about 5% of paths
// answer yes — see the demo header for the census.
import type { Scene } from '../core/scene/scene';
import { IndependentSampler } from '../core/sampler/independent';
import { pixelSeedKey } from '../core/sampler/sampler';
import { luminanceOf } from '../core/math/color';
import { generateLightSubpath, type BDPTOptions } from '../core/integrators/bdpt';
import { ArrayRecorder, type Tuple3 } from './records';
import type { TracedPath } from './pixel-grid';

/**
 * The film as a rectangle in space: centre, in-plane axes, normal and half
 * width. Passed in rather than derived here so the rectangle the rays are
 * tested against and the one drawn on screen are the SAME rectangle —
 * `imagePlaneFrame` in viz/image-plane.ts owns that geometry, and a second
 * copy of the formula in this file is a drift waiting to happen.
 */
export interface FilmRect {
  center: Tuple3;
  right: Tuple3;
  up: Tuple3;
  /** Plane normal — the camera's forward axis. */
  forward: Tuple3;
  /** Half the film's width, world units. Square film, as everywhere here. */
  half: number;
}

/** Where one photon landed, in film coordinates. */
export interface FilmHit {
  /** Index into `paths`. */
  path: number;
  /** Cell it landed in, raster order (y downward). */
  cell: readonly [number, number];
  /** Which bounce carried it there — the segment index that crossed. */
  bounce: number;
}

export interface LightPathTrace {
  /**
   * One walk per emitted photon, TRUNCATED at the film where it hit one.
   * `litAt` is the index of the crossing point, so the shared drawing
   * elements need to know nothing about films: a path that hit stops on the
   * plane and flips there, exactly as a camera path stops on the lamp.
   */
  paths: TracedPath[];
  /** In landing order along each path; sorted by bounce for the film. */
  hits: FilmHit[];
  /** Resolution the hits were binned at. */
  res: number;
}

export interface LightPathOptions {
  scene: Scene;
  /** Photons emitted. */
  count: number;
  maxBounces: number;
  film: FilmRect;
  /** Film cells across, for binning hits. */
  res: number;
  seed?: number;
}

const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Where segment a->b crosses the film rectangle, or null.
 *
 * Strictly inside the segment (never at an endpoint), so a walk that merely
 * grazes the plane at a bounce point is not counted as landing on it.
 */
function crossing(film: FilmRect, a: Tuple3, b: Tuple3): { p: Tuple3; u: number; v: number } | null {
  const d: Tuple3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const denom = dot(d, film.forward);
  if (Math.abs(denom) < 1e-9) return null; // parallel to the film
  const rel: Tuple3 = [
    film.center[0] - a[0],
    film.center[1] - a[1],
    film.center[2] - a[2],
  ];
  const t = dot(rel, film.forward) / denom;
  if (t <= 1e-6 || t >= 1 - 1e-6) return null;
  const p: Tuple3 = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
  const q: Tuple3 = [p[0] - film.center[0], p[1] - film.center[1], p[2] - film.center[2]];
  const u = dot(q, film.right);
  const v = dot(q, film.up);
  if (Math.abs(u) > film.half || Math.abs(v) > film.half) return null;
  return { p, u, v };
}

// Only the walk fields matter: nothing here connects or weights anything,
// so the MIS machinery is inert. Spelled out rather than spread from
// DEFAULT_BDPT_OPTIONS so a change to the renderer's defaults cannot
// silently turn Russian roulette back on in a figure that must not have it.
const WALK: Omit<BDPTOptions, 'maxBounces' | 'rrStartDepth'> = {
  heuristic: 'power',
  strategyFilms: null,
  assertWeights: false,
  strategyFilter: null,
  unweighted: false,
};

export function traceLightPaths(options: LightPathOptions): LightPathTrace {
  const { scene, count, maxBounces, film, res, seed = 0 } = options;
  const sampler = new IndependentSampler(seed);
  const paths: TracedPath[] = [];
  const hits: FilmHit[] = [];

  for (let i = 0; i < count; i++) {
    // Photons are independent, so any distinct key per photon will do; the
    // pixel key is reused rather than invented so a photon's walk replays
    // the same way a pixel's does.
    const key = pixelSeedKey(i % 4096, Math.floor(i / 4096), seed);
    sampler.startPixelSample(key);
    const recorder = new ArrayRecorder();
    recorder.beginPath(key);
    const vertices = generateLightSubpath(scene, sampler, recorder, {
      ...WALK,
      maxBounces,
      rrStartDepth: 99,
    });
    recorder.endPath();

    const points: Tuple3[] = vertices.map((v) => [v.p.x, v.p.y, v.p.z]);
    const last = vertices[vertices.length - 1];
    const beta = last ? luminanceOf(last.beta.r, last.beta.g, last.beta.b) : 0;

    let litAt: number | null = null;
    for (let k = 1; k < points.length; k++) {
      const hit = crossing(film, points[k - 1]!, points[k]!);
      if (!hit) continue;
      // The walk ends ON the film: everything past the crossing is a
      // photon that was already recorded, and drawing it would say the
      // opposite of what the figure says.
      points.splice(k, points.length - k, hit.p);
      litAt = k;
      const half = film.half;
      const x = Math.min(res - 1, Math.max(0, Math.floor(((hit.u + half) / (2 * half)) * res)));
      // Film v grows upward; raster y grows downward.
      const y = Math.min(res - 1, Math.max(0, Math.floor(((half - hit.v) / (2 * half)) * res)));
      hits.push({ path: i, cell: [x, y], bounce: k });
      break;
    }

    paths.push({ points, beta, lit: litAt !== null, litAt });
  }

  hits.sort((a, b) => a.bounce - b.bounce);
  return { paths, hits, res };
}

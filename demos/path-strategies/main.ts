/**
 * SHOWS: what a strategy actually DOES for one pixel — every ray it casts,
 * in the order it casts them.
 *
 * Pick a scene, pick a strategy, and watch the estimator work. Not a summary
 * of the algorithm: the real walk, from the real tracer, replayed. A camera
 * ray grows to its first surface, the material picks a direction, it grows
 * again. NEE fires a shadow ray at every vertex — green if the light is
 * visible, red dying at whatever blocked it. BDPT grows a second walk from
 * the lamp in blue and flashes every connection between the two.
 *
 * Then it does it again. Successive samples of the SAME pixel run one after
 * another, each new attempt drawn over the dimmed remains of the last, so
 * the picture accumulates into the population the estimator is averaging
 * rather than a single tidy diagram. One sample is an anecdote; the fan of
 * them is the estimator.
 *
 * The contrast is the point, and it is sharpest at sample 0: plain PT
 * usually finds nothing at all and the sample is black, NEE carries light
 * home from its very first vertex, and BDPT has a whole second subpath to
 * connect to. The caption states each outcome rather than leaving you to
 * guess whether a black frame is a bug.
 *
 * Roulette is OFF and the depth cap is the only thing that ends a walk —
 * otherwise roulette kills one strategy's path earlier than another's and
 * wrecks the comparison. Roulette is its own figure.
 *
 * Rebuilt 2026-08-04 from legacy/path-strategies, which hard-coded the
 * scene, the pixel and a single sample.
 */

import { createStage, createUI, C } from '@';
import { SCENES, emissiveNames, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { IndependentSampler } from '@/core/sampler/independent';
import { pixelSeedKey } from '@/core/sampler/sampler';
import { UnidirectionalPT } from '@/core/integrators/pt';
import { NEEPathTracer } from '@/core/integrators/pt-nee';
import { BDPT } from '@/core/integrators/bdpt';
import type { Integrator } from '@/core/integrators/types';
import { ArrayRecorder, type PathRecord, type Tuple3 } from '@/trace/records';
import { luminanceOf } from '@/core/math/color';
import { sceneToThree } from '@/viz/three-scene';
import { buildSchedule, type PathSchedule, type ScheduleConfig } from '@/viz/path-schedule';
import {
  ConnectionFlash,
  pathElements,
  type PathStyle,
  type SegmentAppearance,
} from '@/viz/path-elements';
import type { TimelineElement } from '@/viz/timeline';
import { label, setText } from '@/viz/text';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const FILM = 160;
const SEED = 0;
// Why the paths stop where they do: this cap, and nothing else. Carried over
// from the legacy page with its measurement intact — with a hard cap and
// roulette off, paths of <=6 bounces carry 99.1% of `cornell`'s converged
// image energy (<=3 carries 93.5%, <=8 carries 99.8%), the walls being albedo
// 0.73 so energy decays like 0.73^k.
const MAX_BOUNCES = 6;
const NO_RR = 999;
// Seconds between one attempt finishing and the next starting.
const GAP = 0.55;
// Seconds between BDPT connection flashes, so a vertex with several
// connections does not fire them all on the same frame.
const CONNECTION_SPACING = 0.12;
// How far a finished attempt fades once the next one starts. Low enough to
// read as history, high enough that the fan is still visible.
const PAST_DIM = 0.3;
// Beat of black at the end of the loop, so a replay is legible as a replay.
const LOOP_HOLD = 1.0;
const ZOOM_OUT = 1.05;
// A path that delivered nothing is drawn as a cold hairline rather than as
// black: it has to read as PRESENT AND EMPTY, not as missing. Most paths
// report nothing, and that is the content, not a gap in the figure.
const EMPTY_COLOR = new THREE.Color(C.slateDeep);
const EMPTY_WEIGHT = 0.02;

type ColourMode = 'throughput' | 'contribution' | 'accumulate';
const COLOUR_MODES: ColourMode[] = ['throughput', 'contribution', 'accumulate'];

type Strategy = 'pt' | 'pt-nee' | 'bdpt';
const STRATEGIES: Strategy[] = ['pt', 'pt-nee', 'bdpt'];
const STRATEGY_LABEL: Record<Strategy, string> = {
  pt: 'PT — bounce and hope',
  'pt-nee': 'PT + NEE — connect at every vertex',
  bdpt: 'BDPT — two subpaths, connected',
};

// Where to aim in each scene, in normalised film coordinates. Chosen per
// scene because a pixel that lands beautifully in the Cornell box points at
// empty air in the open ones; measured against what each actually hits (see
// the caption, which names the surface).
const DEFAULT_PIXEL: Partial<Record<SceneName, [number, number]>> = {
  // Measured over the first 12 samples at this film size, plain PT, cap 6:
  // this pixel delivers 4 of 12, where the old (0.55, 0.74) delivered 1 —
  // which made the contribution/accumulate colour modes look broken on
  // first load rather than showing a mix of hits and misses. NEE and BDPT
  // deliver from essentially anywhere, so only PT cares.
  cornell: [0.35, 0.45],
  'cornell-glass': [0.5, 0.62],
  'cornell-caustic': [0.5, 0.72],
  'cornell-delta': [0.55, 0.74],
  'caustic-ring': [0.5, 0.7],
  'cornell-lamp': [0.5, 0.7],
  chandelier: [0.5, 0.66],
  'door-ajar': [0.5, 0.6],
  'open-stage': [0.5, 0.66],
  'material-row': [0.5, 0.6],
  'material-test': [0.43, 0.58],
};
const FALLBACK_PIXEL: [number, number] = [0.5, 0.65];

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.5, 9], target: [0, 1.5, 0], fov: 42 });
const ui = createUI(stage);

const caption = label('', {
  size: 0.046,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'top',
  lineHeight: 1.5,
  position: [0, -0.78, 0],
});
stage.hud.add(caption);

// --- Controls --------------------------------------------------------------
const params = {
  scene: 'cornell' as SceneName,
  strategy: 'pt' as Strategy,
  // How many successive samples of this pixel to run in one loop.
  samples: 5,
  // Leave finished attempts on screen, dimmed. Off gives the legacy page's
  // behaviour: one sample at a time, nothing accumulating.
  keepPrevious: true,
  pixelX: 0.55,
  pixelY: 0.74,
  // ~14 world units of segment growth per second: fast enough to watch
  // several times, slow enough to follow a single ray.
  speed: 14,
  // Pause at each scattering vertex, where the shadow ray and the sampled
  // direction play.
  dwell: 0.3,
  tubes: false,
  colour: 'throughput' as ColourMode,
};

const sceneC = ui.params.add(params, 'scene', Object.keys(SCENES)).onChange(() => {
  const p = DEFAULT_PIXEL[params.scene] ?? FALLBACK_PIXEL;
  params.pixelX = p[0];
  params.pixelY = p[1];
  pixelXC.updateDisplay();
  pixelYC.updateDisplay();
  rebuild();
});
ui.params.add(params, 'strategy', STRATEGIES).onChange(rebuild);
ui.params.add(params, 'samples', 1, 12, 1).name('samples of this pixel').onChange(rebuild);
ui.params.add(params, 'keepPrevious').name('keep previous, dimmed').onChange(rebuild);
const pixelXC = ui.params.add(params, 'pixelX', 0, 1, 0.005).name('pixel x').onChange(rebuild);
const pixelYC = ui.params.add(params, 'pixelY', 0, 1, 0.005).name('pixel y').onChange(rebuild);
ui.params.add(params, 'speed', 2, 40, 1).name('growth speed').onChange(rebuild);
ui.params.add(params, 'dwell', 0, 1.5, 0.05).name('dwell per vertex').onChange(rebuild);
ui.params.add(params, 'tubes').name('tubes (else lines)').onChange(rebuild);
ui.params.add(params, 'colour', COLOUR_MODES).name('colour by').onChange(rebuild);
void sceneC;

// --- Colour ----------------------------------------------------------------
// What a segment's colour and width mean. The default, `throughput`, is the
// path language's own mapping: beta arriving at the segment. It says how
// much the path still carries and NOTHING about whether it delivered any of
// it — which is why plain PT's failed sample looks identical to a
// successful one and the caption has to explain the difference.
//
//   contribution  the whole path, one colour: what it delivered to the
//                 pixel. Zero for a path that never found a light.
//   accumulate    graded ALONG the path. At vertex k the colour is
//                 contribution / beta_k — the light still to be carried
//                 home from there. Bright at the emitter, picking up each
//                 surface's tint and dimming as it walks back to the
//                 camera. That product IS the transport, drawn.
//
// Both are exact for plain PT, where one walk makes one contribution at its
// far end. NEE and BDPT deliver at every vertex / every (s, t) pairing, so
// there is no single contribution to divide by; they stay on throughput and
// the caption says so rather than showing a quietly wrong picture.
const lum = (c: Tuple3) => luminanceOf(c[0], c[1], c[2]);
const contributionOf = (r: PathRecord): Tuple3 => {
  const out: [number, number, number] = [0, 0, 0];
  for (const c of r.contributions) {
    if (c.kind !== 'sample') continue;
    out[0] += c.value[0];
    out[1] += c.value[1];
    out[2] += c.value[2];
  }
  return out;
};

/** Radiance carried along each segment, toward the camera. */
function carriedPerSegment(r: PathRecord, mode: ColourMode): Tuple3[] {
  const C0 = contributionOf(r);
  const n = Math.max(0, r.vertices.length - 1);
  const out: Tuple3[] = [];
  for (let j = 0; j < n; j++) {
    if (mode === 'contribution') {
      out.push(C0);
      continue;
    }
    // beta at the segment's NEAR vertex: what has already been applied
    // between the camera and here. Dividing it out leaves what is still to
    // come. Guarded — a beta component can legitimately reach zero.
    const b = r.vertices[j]?.beta ?? [1, 1, 1];
    out.push([
      C0[0] / Math.max(b[0], 1e-6),
      C0[1] / Math.max(b[1], 1e-6),
      C0[2] / Math.max(b[2], 1e-6),
    ]);
  }
  return out;
}

// --- Tracing ---------------------------------------------------------------
// One attempt is one sample of the pixel: its own group, its own elements,
// and its own slot on the demo clock. Keeping them separate is what lets a
// finished one be frozen and dimmed while the next one animates.
interface Attempt {
  index: number;
  record: PathRecord;
  group: THREE.Group;
  elements: TimelineElement[];
  duration: number;
  offset: number;
  /** Base opacity of every material in the group, for dim/undim. */
  base: { material: THREE.Material; opacity: number; transparent: boolean }[];
  state: 'unset' | 'future' | 'active' | 'past';
}

let sceneGroup: THREE.Group | null = null;
const pathsRoot = new THREE.Group();
stage.add(pathsRoot);

let attempts: Attempt[] = [];
// Shared with every LineMaterial at construction; kept in step with the
// drawing buffer below, because Line2 widths are in PIXELS and the exporter
// renders at 1920x1080 while the preview does not.
const resolution = new THREE.Vector2(1920, 1080);
let lineMaterials: { resolution: THREE.Vector2 }[] = [];

function integratorFor(strategy: Strategy): Integrator {
  switch (strategy) {
    case 'pt':
      return new UnidirectionalPT({ maxBounces: MAX_BOUNCES, rrStartDepth: NO_RR, sampleNEE: false });
    case 'pt-nee':
      return new NEEPathTracer({ maxBounces: MAX_BOUNCES, rrStartDepth: NO_RR, sampleNEE: true });
    case 'bdpt':
      return new BDPT({ maxBounces: MAX_BOUNCES, rrStartDepth: NO_RR });
  }
}

function clearAttempts(): void {
  for (const a of attempts) {
    for (const el of a.elements) el.dispose();
    pathsRoot.remove(a.group);
  }
  attempts = [];
  lineMaterials = [];
}

function rebuild(): void {
  clearAttempts();

  const name = params.scene;
  const description = SCENES[name];
  const emissive = emissiveNames(description);

  if (sceneGroup) stage.scene.remove(sceneGroup);
  sceneGroup = sceneToThree(description);
  stage.add(sceneGroup);

  const view = vizViewFor(name);
  const target = new THREE.Vector3(...view.target);
  stage.camera.position.copy(
    new THREE.Vector3(...view.eye).sub(target).multiplyScalar(ZOOM_OUT).add(target),
  );
  stage.controls?.target.copy(target);
  stage.controls?.update();

  const built = buildScene(description, FILM, FILM);
  const sampler = new IndependentSampler(SEED);
  const integrator = integratorFor(params.strategy);
  const pixel = [
    Math.min(FILM - 1, Math.round(params.pixelX * FILM)),
    Math.min(FILM - 1, Math.round(params.pixelY * FILM)),
  ] as const;

  const schedule: ScheduleConfig = {
    speed: params.speed,
    momentSeconds: params.dwell,
    startTime: 0,
    escapeLength: 3,
  };
  const style: PathStyle = {
    tier: params.tubes ? 'tubes' : 'lines',
    lineWidth: 4,
    tubeRadius: 0.02,
    resolution,
  };

  // Trace every attempt BEFORE drawing any: the colour modes normalise
  // against the brightest segment on screen, which is not known until the
  // whole population exists. (Cornell's emitter is radiance 400; without
  // this every delivering path clips to white and they all look alike.)
  const records: PathRecord[] = [];
  for (let i = 0; i < params.samples; i++) {
    // Re-seeding per sample is what makes successive attempts DIFFERENT
    // paths rather than the same one drawn again — and, because the sampler
    // is a pure function of (key, dimension), exactly the paths the renderer
    // would have drawn for samples 0..n-1 of this pixel.
    const key = pixelSeedKey(pixel[0], pixel[1], i);
    sampler.startPixelSample(key);
    const recorder = new ArrayRecorder();
    recorder.beginPath(key);
    integrator.sampleContributions(pixel, sampler, built, recorder);
    recorder.endPath();
    const record = recorder.records[0];
    if (record) records.push(record);
  }

  // Only plain PT has a single well-defined contribution per walk; see the
  // Colour section. Anything else stays on the throughput mapping.
  const mode: ColourMode = params.strategy === 'pt' ? params.colour : 'throughput';
  const carried = records.map((r) => carriedPerSegment(r, mode));
  let peak = 0;
  if (mode !== 'throughput') {
    for (const segs of carried) for (const c of segs) peak = Math.max(peak, lum(c));
  }
  const appearanceFor = (i: number): (SegmentAppearance | null)[] | undefined => {
    if (mode === 'throughput') return undefined;
    return (carried[i] ?? []).map((c) => {
      const l = lum(c);
      if (peak <= 0 || l <= 0) return { color: EMPTY_COLOR, weight: EMPTY_WEIGHT };
      // Normalise the brightest segment on screen to 1, then keep the hue:
      // dividing by the peak LUMINANCE rather than per channel preserves
      // the colour the path actually picked up off the walls.
      const k = 1 / peak;
      return {
        color: new THREE.Color(c[0] * k, c[1] * k, c[2] * k),
        weight: Math.pow(Math.min(1, l / peak), 0.4),
      };
    });
  };

  let offset = 0;
  for (const [i, record] of records.entries()) {
    const group = new THREE.Group();
    pathsRoot.add(group);
    const elements: TimelineElement[] = [];
    let duration = 0;

    const camSchedule = buildSchedule(record, emissive, schedule, {
      vertices: record.vertices,
      role: 'camera',
    });
    elements.push(
      ...pathElements(
        camSchedule,
        record.vertices.map((v) => v.delta),
        style,
        group,
        appearanceFor(i),
      ),
    );
    duration = Math.max(duration, camSchedule.duration);

    // BDPT only: the light subpath grows on the same clock, in blue, and
    // every connection attempt flashes once BOTH of its endpoints exist.
    let lightSchedule: PathSchedule | null = null;
    if (params.strategy === 'bdpt' && record.lightVertices.length > 0) {
      lightSchedule = buildSchedule(record, emissive, schedule, {
        vertices: record.lightVertices,
        role: 'light',
      });
      elements.push(
        ...pathElements(
          lightSchedule,
          record.lightVertices.map((v) => v.delta),
          { ...style, palette: 'light' },
          group,
        ),
      );
      duration = Math.max(duration, lightSchedule.duration);
    }
    if (params.strategy === 'bdpt') {
      const timed = record.connections
        .map((c) => ({
          c,
          time: Math.max(
            arrivalTime(camSchedule, record.vertices, c.from),
            lightSchedule ? arrivalTime(lightSchedule, record.lightVertices, c.to) : 0,
          ),
        }))
        .sort((a, b) => a.time - b.time);
      let prev = -Infinity;
      for (const entry of timed) {
        const at = Math.max(entry.time, prev + CONNECTION_SPACING);
        prev = at;
        elements.push(new ConnectionFlash(entry.c, at, style, group));
        duration = Math.max(duration, at + 1.2);
      }
    }

    attempts.push({
      index: i,
      record,
      group,
      elements,
      duration,
      offset,
      base: collectMaterials(group),
      state: 'unset',
    });
    offset += duration + GAP;
  }

  collectLineMaterials();
  stage.duration = Math.max(1, offset - GAP + LOOP_HOLD);
  lastCaption = '';
}

// A connection can only flash once both of its endpoints have been drawn;
// the eye and a resampled light point are there from the start.
function arrivalTime(
  schedule: PathSchedule,
  vertices: PathRecord['vertices'],
  p: readonly [number, number, number],
): number {
  const idx = vertices.findIndex(
    (v) =>
      Math.abs(v.p[0] - p[0]) < 1e-9 &&
      Math.abs(v.p[1] - p[1]) < 1e-9 &&
      Math.abs(v.p[2] - p[2]) < 1e-9,
  );
  if (idx <= 0) return 0;
  return schedule.moments.find((m) => m.vertexIndex === idx)?.start ?? 0;
}

// --- Dimming ---------------------------------------------------------------
// Every element builds its OWN materials (verified in path-elements.ts), so
// scaling a group's opacities cannot leak into another attempt.
function collectMaterials(root: THREE.Object3D): Attempt['base'] {
  const out: Attempt['base'] = [];
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      out.push({ material: mat, opacity: mat.opacity, transparent: mat.transparent });
    }
  });
  return out;
}

function collectLineMaterials(): void {
  const seen = new Set<object>();
  lineMaterials = [];
  pathsRoot.traverse((o) => {
    const m = (o as THREE.Mesh).material as unknown;
    for (const mat of (Array.isArray(m) ? m : m ? [m] : []) as { resolution?: THREE.Vector2 }[]) {
      if (!mat.resolution || seen.has(mat)) continue;
      seen.add(mat);
      lineMaterials.push(mat as { resolution: THREE.Vector2 });
    }
  });
}

function setDim(a: Attempt, k: number): void {
  for (const b of a.base) {
    b.material.transparent = k < 1 ? true : b.transparent;
    b.material.opacity = b.opacity * k;
  }
}

function restore(a: Attempt): void {
  for (const b of a.base) {
    b.material.transparent = b.transparent;
    b.material.opacity = b.opacity;
  }
}

// --- Caption ---------------------------------------------------------------
let lastCaption = '';

// Two lines on purpose: what you are looking at, then what this particular
// sample did. One line ran to ~120 characters on BDPT, which fits the canvas
// but reads as a ticker rather than a caption.
function describe(a: Attempt | null): string {
  // Say when the requested colouring is not what is on screen, rather than
  // showing throughput under a label claiming otherwise.
  const fellBack = params.colour !== 'throughput' && params.strategy !== 'pt';
  const colour =
    params.colour === 'throughput'
      ? ''
      : fellBack
        ? ` · colour: throughput (${params.colour} needs one contribution per walk — PT only)`
        : ` · colour: ${params.colour}`;
  const head = `${params.scene} · ${STRATEGY_LABEL[params.strategy]}${colour}`;
  if (!a) return head;
  const r = a.record;
  const bounces = r.vertices.length - 1;
  const carried = r.contributions.some((c) => c.value.some((v) => v > 0));
  const capped = bounces >= MAX_BOUNCES ? ` (cap)` : '';
  const walk = `sample ${a.index} · ${bounces} bounce${bounces === 1 ? '' : 's'}${capped}`;

  if (params.strategy === 'pt') {
    return `${head}\n${walk} · ${
      carried ? 'happened to hit the light' : 'never found the light — this sample is black'
    }`;
  }
  if (params.strategy === 'pt-nee') {
    const n = r.shadowRays.length;
    const blocked = r.shadowRays.filter((sr) => sr.occluded).length;
    return (
      `${head}\n${walk} · ${n} light connection${n === 1 ? '' : 's'}, ${blocked} blocked · ` +
      `${carried ? 'carried light' : 'found nothing'}`
    );
  }
  const lightBounces = Math.max(0, r.lightVertices.length - 1);
  const blocked = r.connections.filter((c) => c.occluded).length;
  return (
    `${head}\n${walk} camera, ${lightBounces} light · ` +
    `${r.connections.length} connection${r.connections.length === 1 ? '' : 's'}, ${blocked} blocked · ` +
    `${carried ? 'carried light' : 'found nothing'}`
  );
}

// --- Frame -----------------------------------------------------------------
const bufferSize = new THREE.Vector2();

stage.frame((t) => {
  // Line2 widths are in pixels, so every LineMaterial needs the CURRENT
  // drawing buffer — which changes when the exporter switches to 1920x1080.
  stage.renderer.getDrawingBufferSize(bufferSize);
  if (bufferSize.x !== resolution.x || bufferSize.y !== resolution.y) {
    resolution.copy(bufferSize);
    for (const m of lineMaterials) m.resolution.copy(bufferSize);
  }

  let current: Attempt | null = null;
  for (const a of attempts) {
    const local = t - a.offset;
    const want: Attempt['state'] =
      local < 0 ? 'future' : local <= a.duration ? 'active' : 'past';

    if (want === 'active') current = a;

    if (want !== a.state) {
      a.state = want;
      if (want === 'future') {
        a.group.visible = false;
        restore(a);
      } else if (want === 'active') {
        a.group.visible = true;
        restore(a);
      } else {
        // Freeze at its final frame, then fade once. Nothing draws it again
        // while it stays past, so the fade cannot compound.
        a.group.visible = params.keepPrevious;
        for (const el of a.elements) el.drawAt(a.duration);
        setDim(a, params.keepPrevious ? PAST_DIM : 0);
      }
    }

    if (a.state === 'active') {
      for (const el of a.elements) el.drawAt(local);
    }
  }

  const text = describe(current ?? attempts[attempts.length - 1] ?? null);
  if (text !== lastCaption) {
    lastCaption = text;
    setText(caption, text);
  }
});

stage.start();
rebuild();

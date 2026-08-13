/**
 * SHOWS: nothing. This is a TUNER, not a figure.
 *
 * The standard Cornell box, with every choice that is currently baked into
 * src/scenes/cornell.ts exposed as a control, rendering live as you drag.
 * Settle on a look, press "log scene", and paste the printed primitives back
 * into cornell.ts — after which this page has done its job.
 *
 * Warmth is applied at CONSTANT LUMINANCE: tinting the lamp toward amber
 * would otherwise also dim it, and you would be judging exposure rather than
 * colour. Same for the walls.
 */

import { createStage, createUI, C } from '@';
import { CORNELL } from '@/scenes/cornell';
import type { MaterialDescription, SceneDescription } from '@/core/scene/scene';
import { FilmPanel } from '@/viz/film-panel';
import { RenderSession } from '@/render/session';
import { label, setText } from '@/viz/text';
import { luminanceOf } from '@/core/math/color';

const RES = 240;
const TARGET_SPP = 1024;
const MAX_DEPTH = 8;
const PANEL = { center: [0, 0.05] as [number, number], height: 1.55 };

const stage = createStage({ lights: false, controls: false });
stage.duration = 8;
const ui = createUI(stage);
stage.camera.position.set(0, 0, 5);

const caption = label('', {
  size: 0.06,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'top',
  position: [0, -0.8, 0],
});
stage.hud.add(caption);

const panel = new FilmPanel({
  width: RES,
  height: RES,
  center: PANEL.center,
  drawnHeight: PANEL.height,
});
stage.hud.add(panel.group);

// --- Controls --------------------------------------------------------------
const params = {
  // 0 = neutral white, 1 = fully amber. Luminance held fixed either way.
  lightWarmth: 0.0,
  lightRadiance: 14,
  // Warms floor/ceiling/back/front off neutral grey, again at fixed luminance.
  wallWarmth: 0.0,
  wallAlbedo: 0.73,
  redWall: [0.65, 0.05, 0.05] as [number, number, number],
  greenWall: [0.12, 0.45, 0.15] as [number, number, number],
  // The blue ball. Lambert is what ships today.
  ballBKind: 'lambert' as 'lambert' | 'conductor',
  ballBColor: [0.35, 0.45, 0.8] as [number, number, number],
  ballBRoughness: 0.18,
  ballAAlbedo: [0.73, 0.73, 0.73] as [number, number, number],
  spp: TARGET_SPP,
};

/** Tint a colour toward `to` by t, preserving its luminance. */
function tint(c: readonly [number, number, number], to: readonly [number, number, number], t: number): [number, number, number] {
  const mixed: [number, number, number] = [
    c[0] * (1 - t) + c[0] * to[0] * t,
    c[1] * (1 - t) + c[1] * to[1] * t,
    c[2] * (1 - t) + c[2] * to[2] * t,
  ];
  const before = luminanceOf(c[0], c[1], c[2]);
  const after = luminanceOf(mixed[0], mixed[1], mixed[2]);
  const k = after > 1e-9 ? before / after : 1;
  return [mixed[0] * k, mixed[1] * k, mixed[2] * k];
}

const AMBER = [1.0, 0.78, 0.52] as const;

function describe(): SceneDescription {
  const wall = tint([params.wallAlbedo, params.wallAlbedo, params.wallAlbedo], AMBER, params.wallWarmth);
  const lampRadiance = tint(
    [params.lightRadiance, params.lightRadiance, params.lightRadiance],
    AMBER,
    params.lightWarmth,
  );
  const ballB: MaterialDescription =
    params.ballBKind === 'conductor'
      ? { kind: 'conductor', f0: params.ballBColor, roughness: params.ballBRoughness }
      : { kind: 'lambert', albedo: params.ballBColor };

  return {
    ...CORNELL,
    primitives: CORNELL.primitives.map((p) => {
      switch (p.name) {
        case 'floor':
        case 'ceiling':
        case 'back':
        case 'front':
          return { ...p, material: { kind: 'lambert', albedo: wall } };
        case 'left':
          return { ...p, material: { kind: 'lambert', albedo: params.redWall } };
        case 'right':
          return { ...p, material: { kind: 'lambert', albedo: params.greenWall } };
        case 'light':
          return { ...p, emission: { radiance: lampRadiance } };
        case 'ball':
          return { ...p, material: { kind: 'lambert', albedo: params.ballAAlbedo } };
        case 'ballBlue':
          return { ...p, material: ballB };
        default:
          return p;
      }
    }),
  };
}

const f = ui.params;
f.add(params, 'lightWarmth', 0, 1, 0.02).name('light warmth').onChange(restart);
f.add(params, 'lightRadiance', 2, 40, 0.5).name('light radiance').onChange(restart);
f.add(params, 'wallWarmth', 0, 1, 0.02).name('wall warmth').onChange(restart);
f.add(params, 'wallAlbedo', 0.3, 0.95, 0.01).name('wall albedo').onChange(restart);
f.addColor(params, 'redWall').name('left wall').onChange(restart);
f.addColor(params, 'greenWall').name('right wall').onChange(restart);
f.add(params, 'ballBKind', ['lambert', 'conductor']).name('blue ball').onChange(restart);
f.addColor(params, 'ballBColor').name('blue ball colour').onChange(restart);
f.add(params, 'ballBRoughness', 0.02, 1, 0.01).name('blue ball roughness').onChange(restart);
f.addColor(params, 'ballAAlbedo').name('white ball').onChange(restart);
f.add(params, 'spp', 32, 4096, 32).name('samples').onChange(restart);

// Print what you have settled on, ready to paste into src/scenes/cornell.ts.
f.add(
  {
    log: () => {
      const d = describe();
      const fmt = (c: readonly number[]) => `[${c.map((v) => Number(v.toFixed(4))).join(', ')}]`;
      const lines = d.primitives.map((p) => {
        const m = p.material;
        const mat =
          m.kind === 'lambert'
            ? `{ kind: 'lambert', albedo: ${fmt(m.albedo)} }`
            : m.kind === 'conductor'
              ? `{ kind: 'conductor', f0: ${fmt(m.f0)}, roughness: ${m.roughness} }`
              : JSON.stringify(m);
        const em = p.emission ? `, emission: { radiance: ${fmt(p.emission.radiance)} }` : '';
        return `  ${p.name}: material: ${mat}${em}`;
      });
      console.log('--- paste into src/scenes/cornell.ts ---\n' + lines.join('\n'));
    },
  },
  'log',
).name('log scene → console');

// --- Rendering -------------------------------------------------------------
let session: RenderSession | null = null;
let generation = 0;

function restart(): void {
  const gen = ++generation;
  session?.stop();
  session = new RenderSession({
    description: describe(),
    integrator: { name: 'pt-nee', maxBounces: MAX_DEPTH },
    width: RES,
    height: RES,
    targetSpp: params.spp,
    seed: 0,
    onUpdate: (s) => {
      if (gen !== generation) return;
      panel.update(s.rgba);
      setText(
        caption,
        `${s.spp} / ${params.spp} spp · ` +
          `light warmth ${params.lightWarmth.toFixed(2)} · wall warmth ${params.wallWarmth.toFixed(2)} · ` +
          `blue ball ${params.ballBKind}${params.ballBKind === 'conductor' ? ` r=${params.ballBRoughness.toFixed(2)}` : ''}`,
      );
    },
  });
}

stage.start();
restart();

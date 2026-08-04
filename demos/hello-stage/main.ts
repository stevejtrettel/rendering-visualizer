/**
 * Scaffolding check for the rebuilt demo system. Not a talk figure — it
 * exists so every piece of the new machinery is exercised by something.
 *
 * On screen: the Cornell box in the mineral palette, one camera path
 * animated across it on the stage clock, and beside it the CPU renderer's
 * own image of the same scene converging inside the canvas.
 *
 * The three things worth copying into a real figure:
 *
 *  1. Animation reads the `t` the stage hands it — never performance.now() —
 *     which is what lets `V` step frames as slowly as it likes and still
 *     produce an even video.
 *  2. The render pane is a FilmPanel (a textured quad in HUD space), not a
 *     DOM canvas. DOM does not appear in exported PNGs or video.
 *  3. Everything visual comes from the palette in src/viz/style.ts.
 */

import * as THREE from 'three';
import { createStage, createUI, C } from '@';
import { SCENES, emissiveNames } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { NEEPathTracer } from '@/core/integrators/pt-nee';
import { tracePath } from '@/trace/replay';
import { sceneToThree } from '@/viz/three-scene';
import { Timeline } from '@/viz/timeline';
import { buildSchedule, type ScheduleConfig } from '@/viz/path-schedule';
import { pathElements, type PathStyle } from '@/viz/path-elements';
import { FilmPanel } from '@/viz/film-panel';
import { RenderSession } from '@/render/session';
import { label } from '@/viz/text';

// --- Figure spec -----------------------------------------------------------
const SCENE_NAME = 'cornell';
const FILM = 160; // film resolution the traced path is sampled against
const PIXEL = [88, 118] as const;
const SAMPLE = 0;
const MAX_BOUNCES = 6;
const NO_RR = 999; // roulette off: the cap is the only reason a path stops
const RENDER_RES = 200;
const TARGET_SPP = 512;
const SCHEDULE: ScheduleConfig = { speed: 14, momentSeconds: 0.3, startTime: 0, escapeLength: 3 };
// Two-up layout: the box slides left via an off-axis frustum (a share of the
// frame width), the pane sits right in HUD units (the frame is 2 tall, ±16/9).
const VIEW_SHIFT = 0.17;
const PANEL = { center: [1.12, 0.06] as [number, number], height: 0.92 };

const description = SCENES[SCENE_NAME];
const view = vizViewFor(SCENE_NAME);

// --- Stage -----------------------------------------------------------------
const stage = createStage({
  position: [...view.eye] as [number, number, number],
  target: [...view.target] as [number, number, number],
  fov: 42,
});
stage.duration = 9;
createUI(stage);

// Free the right third for the render pane by shifting the VIEW, not the
// scene: the geometry stays where the traced path expects to find it.
stage.shiftView(VIEW_SHIFT);
stage.add(sceneToThree(description));
const paths = new THREE.Group();
stage.add(paths);

// --- The traced path -------------------------------------------------------
const scene = buildScene(description, FILM, FILM);
const integrator = new NEEPathTracer({ maxBounces: MAX_BOUNCES, rrStartDepth: NO_RR });
const record = tracePath(scene, integrator, PIXEL, SAMPLE);

const style: PathStyle = {
  tier: 'lines',
  lineWidth: 4,
  tubeRadius: 0.02,
  // Line widths are authored against the 1080p frame; the stage pins the
  // resolution once, so this matches preview and export alike.
  resolution: new THREE.Vector2(1920, 1080),
};

const timeline = new Timeline();
const schedule = buildSchedule(record, emissiveNames(description), SCHEDULE);
for (const el of pathElements(schedule, record.vertices.map((v) => v.delta), style, paths)) {
  timeline.add(el, schedule.duration);
}

// The stage owns the clock; the timeline owns per-element choreography.
stage.frame((t) => timeline.setTime(t % Math.max(schedule.duration, 0.001)));

// --- The CPU render, inside the canvas -------------------------------------
const panel = new FilmPanel({
  width: RENDER_RES,
  height: RENDER_RES,
  center: PANEL.center,
  drawnHeight: PANEL.height,
});
stage.hud.add(panel.group);

const caption = label('pt-nee · 0 spp', {
  size: 0.05,
  color: C.ash,
  anchorX: 'center',
  anchorY: 'top',
  position: [PANEL.center[0], PANEL.center[1] - PANEL.height / 2 - 0.07, 0],
});
stage.hud.add(caption);

new RenderSession({
  description,
  integrator: 'pt-nee',
  width: RENDER_RES,
  height: RENDER_RES,
  targetSpp: TARGET_SPP,
  maxDepth: MAX_BOUNCES,
  onUpdate: (s) => {
    panel.update(s.rgba);
    caption.text = `pt-nee · ${s.spp} spp · ${s.msPerPass.toFixed(0)} ms/pass`;
    caption.sync();
  },
});

stage.start();

/**
 * SHOWS: the two things a picture is made from. A scene, the 3D model (the
 * short open box of level-zero, one-path and one-sample), and a screen, the
 * grid of pixels the image will be, floating where level-zero's film is.
 * Nothing is traced yet: every pixel is blank.
 *
 * Same box, camera and grid as level-zero, the slide after, so the screen
 * here is exactly the film the first rays go through there.
 *
 * The scene is there from the start and is named; then the screen fades in
 * and is named. Labels follow the objects if the view is orbited. The figure
 * ramps to both named and holds.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { sceneToThree } from '@/viz/three-scene';
import { ImagePlaneElement, imagePlaneFrame } from '@/viz/image-plane';
import { segments, setSegments } from '@/viz/lines';
import { label } from '@/viz/text';
import { ASPECT } from '@/viz/stage';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
const PLANE_DISTANCE = 1.4; // as level-zero
// Timing, seconds.
const SCENE_LABEL = [0.6, 1.4];
const SCREEN = [2.0, 3.0]; // the screen fades in
const SCREEN_LABEL = [2.6, 3.4];
const HOLD = 3;

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });
const ui = createUI(stage);

const desc = SCENES[SCENE];
stage.add(sceneToThree(desc));
const view = vizViewFor(SCENE);
stage.camera.position.set(...view.eye);
stage.controls?.target.set(...view.target);
stage.controls?.update();

const sceneLabel = label('scene', { size: 0.08, color: C.bone, anchorX: 'center', anchorY: 'bottom', opacity: 0.999 });
const screenLabel = label('screen', { size: 0.08, color: C.bone, anchorX: 'center', anchorY: 'bottom', opacity: 0.999 });
stage.hud.add(sceneLabel, screenLabel);

// Where each label sits: just above the top of the thing it names.
const frame = imagePlaneFrame(desc.camera, PLANE_DISTANCE);
const screenTop = frame.center.clone().addScaledVector(frame.up, frame.halfH * 1.15);
const box = new THREE.Box3();
for (const p of desc.primitives) {
  if (p.shape.kind !== 'quad') continue;
  const { q, e1, e2 } = p.shape;
  const o = new THREE.Vector3(...q);
  const a = new THREE.Vector3(...e1);
  const b = new THREE.Vector3(...e2);
  for (const v of [o, o.clone().add(a), o.clone().add(b), o.clone().add(a).add(b)]) box.expandByPoint(v);
}
const sceneTop = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y + 0.35, (box.min.z + box.max.z) / 2);

/** A world point's place on the HUD, which spans x in [-ASPECT, ASPECT], y in [-1, 1]. */
function toHud(p: THREE.Vector3): [number, number] {
  const ndc = p.clone().project(stage.camera);
  return [ndc.x * ASPECT, ndc.y];
}

// --- The screen ------------------------------------------------------------
const planeGroup = new THREE.Group();
const gridLines = segments({ width: 1.5, opacity: 0.999 });
stage.add(planeGroup, gridLines);
let plane: ImagePlaneElement | null = null;

const params = { grid: 8 };
ui.params.add(params, 'grid', 2, 32, 1).name('film resolution').onChange(build);

function build(): void {
  const res = params.grid;
  plane?.dispose();
  // Blank film: every cell unrevealed.
  plane = new ImagePlaneElement(
    {
      camera: desc.camera,
      distance: PLANE_DISTANCE,
      res,
      samples: 1,
      dwell: Infinity,
      cumulative: new Float32Array(res * res * 3),
      highlight: null,
      revealAt: new Float32Array(res * res).fill(Infinity),
    },
    planeGroup,
  );

  // The pixel boundaries, just proud of the plane on the eye's side.
  const { center, right, up, forward, halfW, halfH } = frame;
  const at = (x: number, y: number) =>
    center.clone().addScaledVector(right, x).addScaledVector(up, y).addScaledVector(forward, -0.01);
  const pos: number[] = [];
  for (let i = 0; i <= res; i++) {
    const x = -halfW + (2 * halfW * i) / res;
    const y = -halfH + (2 * halfH * i) / res;
    for (const [a, b] of [[at(x, -halfH), at(x, halfH)], [at(-halfW, y), at(halfW, y)]] as const) {
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  const grey = new THREE.Color(C.slate);
  const col = new Float32Array(pos.length);
  for (let i = 0; i < col.length; i += 3) grey.toArray(col, i);
  setSegments(gridLines, new Float32Array(pos), col);
}

// --- Playback --------------------------------------------------------------
const ramp = (t: number, [a, b]: number[]) => Math.min(1, Math.max(0, (t - a!) / (b! - a!)));

stage.frame((t) => {
  const screen = ramp(t, SCREEN);
  planeGroup.visible = gridLines.visible = screen > 0;
  planeGroup.traverse((o) => {
    if (o instanceof THREE.Mesh) (o.material as THREE.MeshBasicMaterial).opacity = 0.94 * screen;
  });
  gridLines.material.opacity = 0.999 * screen;

  sceneLabel.position.set(...toHud(sceneTop), 0);
  screenLabel.position.set(...toHud(screenTop), 0);
  sceneLabel.material.opacity = 0.999 * ramp(t, SCENE_LABEL);
  screenLabel.material.opacity = 0.999 * ramp(t, SCREEN_LABEL);
});

stage.duration = SCREEN_LABEL[1]! + HOLD;
stage.start();
build();

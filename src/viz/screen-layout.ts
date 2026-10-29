// The layout the talk's scene-to-screen slides share (rasterize, one-path,
// one-sample, many-samples): the screen square-on at the left of the frame,
// the 3D view slid right, and in the scene the camera's eye, its image
// plane at SCREEN_PLANE_DISTANCE and the frustum's edges, with "screen" and
// "scene" named. One place, so the slides stay identical as it is tuned.
import * as THREE from 'three';
import type { SceneDescription } from '../core/scene/scene';
import { imagePlaneFrame, type PlaneFrame } from './image-plane';
import { polyline, segments, setSegments } from './lines';
import { ASPECT, type Stage } from './stage';
import { C } from './style';
import { label } from './text';

/** The screen, in HUD units (x in [-ASPECT, ASPECT], y in [-1, 1]). */
export const SCREEN = { center: [-0.85, -0.13] as [number, number], height: 1.15 };
/** Share of the frame width the 3D view slides right (stage.shiftView). */
export const SCREEN_SHIFT = -0.25;
/** Pinhole to image plane, world units: far enough out for the plane to read. */
export const SCREEN_PLANE_DISTANCE = 3;
/** What an unrendered pixel shows. */
export const BLANK = 18;
const FAR = 9.5; // how far the frustum edges are drawn, from the eye

const solid = (n: number, hex: number) => {
  const c = new THREE.Color(hex);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 3) c.toArray(out, i);
  return out;
};

export interface ScreenLayout {
  frame: PlaneFrame;
  /** The screen's pixel grid; redraw it when the resolution changes. */
  drawGrid(res: number): void;
  gridLines: ReturnType<typeof segments>;
  /** Call every frame: keeps the scene's label above the box as the view orbits. */
  update(): void;
}

export function screenLayout(stage: Stage, camera: SceneDescription['camera'], sceneTop: THREE.Vector3): ScreenLayout {
  stage.shiftView(SCREEN_SHIFT);
  const frame = imagePlaneFrame(camera, SCREEN_PLANE_DISTANCE);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) =>
    frame.center.clone().addScaledVector(frame.right, x! * frame.halfW).addScaledVector(frame.up, y! * frame.halfH),
  );

  const eyeDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 20, 12),
    new THREE.MeshBasicMaterial({ color: C.bone, toneMapped: false }),
  );
  eyeDot.position.copy(frame.eye);
  const planeOutline = polyline([...corners, corners[0]!], { color: C.bone, width: 3 });
  const toPlane = segments({ width: 2, opacity: 0.9 });
  const beyond = segments({ width: 1.5, opacity: 0.3 });
  const near: number[] = [];
  const far: number[] = [];
  for (const c of corners) {
    const f = frame.eye.clone().add(c.clone().sub(frame.eye).multiplyScalar(FAR / SCREEN_PLANE_DISTANCE));
    near.push(frame.eye.x, frame.eye.y, frame.eye.z, c.x, c.y, c.z);
    far.push(c.x, c.y, c.z, f.x, f.y, f.z);
  }
  setSegments(toPlane, new Float32Array(near), solid(near.length, C.bone));
  setSegments(beyond, new Float32Array(far), solid(far.length, C.bone));
  stage.add(eyeDot, planeOutline, toPlane, beyond);

  const screenLabel = label('screen', {
    size: 0.08,
    color: C.bone,
    anchorX: 'center',
    anchorY: 'bottom',
    position: [SCREEN.center[0], SCREEN.center[1] + SCREEN.height / 2 + 0.05, 0],
  });
  const sceneLabel = label('scene', { size: 0.08, color: C.bone, anchorX: 'center', anchorY: 'bottom' });
  stage.hud.add(screenLabel, sceneLabel);

  const gridLines = segments({ width: 1.5 });
  stage.hud.add(gridLines);
  function drawGrid(res: number): void {
    const h = SCREEN.height;
    const [cx, cy] = SCREEN.center;
    const pos: number[] = [];
    for (let i = 0; i <= res; i++) {
      const f = -h / 2 + (h * i) / res;
      pos.push(cx + f, cy - h / 2, 0.02, cx + f, cy + h / 2, 0.02);
      pos.push(cx - h / 2, cy + f, 0.02, cx + h / 2, cy + f, 0.02);
    }
    setSegments(gridLines, new Float32Array(pos), solid(pos.length, C.slate));
    gridLines.material.linewidth = res > 32 ? 1 : 1.5;
  }

  return {
    frame,
    drawGrid,
    gridLines,
    update() {
      const ndc = sceneTop.clone().project(stage.camera);
      sceneLabel.position.set(ndc.x * ASPECT, ndc.y, 0);
    },
  };
}

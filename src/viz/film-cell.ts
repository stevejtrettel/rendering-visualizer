// Where one pixel of the film is, in the two places a figure shows the film:
// on the image plane in the scene (exactly where ImagePlaneElement draws the
// cell) and in a square-on FilmPanel inset on the HUD. Both return a closed
// loop of five corners, ready for polyline / setPolyline.
import * as THREE from 'three';
import { imagePlaneFrame, type ImagePlaneConfig } from './image-plane';

type Corner = [number, number, number];

/** The cell's outline on the image plane, nudged toward the eye so it sits proud. */
export function cellOnPlane(
  camera: ImagePlaneConfig['camera'],
  distance: number,
  res: number,
  x: number,
  y: number,
): THREE.Vector3[] {
  const { center, right, up, forward, halfW, halfH } = imagePlaneFrame(camera, distance);
  const cell = (2 * halfW) / res;
  const x0 = -halfW + x * cell;
  const y0 = halfH - (y + 1) * cell; // raster y grows downward
  const corner = (px: number, py: number) =>
    center.clone().addScaledVector(right, px).addScaledVector(up, py).addScaledVector(forward, -0.01);
  return [corner(x0, y0), corner(x0 + cell, y0), corner(x0 + cell, y0 + cell), corner(x0, y0 + cell), corner(x0, y0)];
}

/** The cell's outline in a square FilmPanel at `center` of drawn `height`, row 0 at the top. */
export function cellInPanel(center: readonly [number, number], height: number, res: number, x: number, y: number): Corner[] {
  const cs = height / res;
  const left = center[0] - height / 2 + x * cs;
  const top = center[1] + height / 2 - y * cs;
  return [
    [left, top, 0.01], [left + cs, top, 0.01], [left + cs, top - cs, 0.01], [left, top - cs, 0.01], [left, top, 0.01],
  ];
}

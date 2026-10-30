// The lens camera of the lens-camera demo, as plain numbers, so the demo
// and the bake of its rays' spectra (scripts/bake-lens-spectra.ts) agree on
// every ray. Pure: no three.js.
//
// The camera sits where cornell-short's camera does, a lens where the pinhole
// camera has its pinhole. One pixel on the sensor; K points on the lens;
// through each, one ray from the pixel. A thin lens sends all the rays from
// one sensor point to one point in front of it (FOCUS along the axis), so
// each ray leaves its lens point aimed at that point. FOCUS is set short of
// what the pixel looks at, so the rays spread over a patch of the scene
// (the top of the white ball, lit from above, and the red wall behind it)
// and come back with different spectra: the point of the slide.

type V = [number, number, number];
const add = (a: V, b: V, s = 1): V => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V): V => {
  const m = Math.hypot(...a);
  return [a[0] / m, a[1] / m, a[2] / m];
};

/** cornell-short's camera: eye [0, 2, 7] looking down -z. */
export const LENS_CENTRE: V = [0, 2, 7];
export const FORWARD: V = [0, 0, -1];
export const UP: V = [0, 1, 0];
export const RIGHT: V = [1, 0, 0];
export const FOV_DEGREES = 40;
/** Lens to sensor, world units (the pinhole camera's box). */
export const SENSOR_DISTANCE = 1.1;
/** The lens's radius: large, so the fan of rays is wide enough to see. */
export const LENS_RADIUS = 0.36;
/** Along the axis, where the rays from the pixel meet. */
export const FOCUS = 3.8;
/** What the pixel looks at, through the lens's centre: the white ball's upper-left edge, the red wall behind. */
const LOOK_AT: V = [-1.5, 1.38, -0.6];
/** Rays through the lens. */
export const K = 40;

const chief = unit(sub(LOOK_AT, LENS_CENTRE));
/** The pixel, on the sensor behind the lens. */
export const PIXEL: V = add(LENS_CENTRE, chief, -SENSOR_DISTANCE / dot(chief, FORWARD));
/** Where every ray from the pixel crosses, in front of the lens. */
export const MEET: V = add(LENS_CENTRE, chief, FOCUS / dot(chief, FORWARD));

/** Lens point k: a sunflower spiral, centre outward, so the rays fill the lens evenly as they come. */
export function lensPoint(k: number): V {
  const r = LENS_RADIUS * Math.sqrt((k + 0.5) / K);
  const a = k * Math.PI * (3 - Math.sqrt(5));
  return add(add(LENS_CENTRE, RIGHT, r * Math.cos(a)), UP, r * Math.sin(a));
}
/** Ray k: from its lens point toward MEET. */
export function lensRay(k: number): { origin: V; dir: V } {
  const origin = lensPoint(k);
  return { origin, dir: unit(sub(MEET, origin)) };
}

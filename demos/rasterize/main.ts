/**
 * SHOWS: rasterization, the map from scene to screen, and then shading. Same
 * layout as scene-and-screen: the screen square-on at the left, the scene at
 * the right. Two slides (`?shade=` in the URL):
 *
 * flat (the default): the camera's eye and its image plane appear in front
 * of the box; then the scene is projected piece by piece, back to front
 * (back wall, side walls, floor, ceiling, lamp, the two balls): each piece
 * slides as a whole along the lines to the eye until it lies flat on the
 * plane, and as it lands its pixels appear on the screen, painted over what
 * is already there. One piece at a time, so the map from scene to screen can
 * be followed (Steve, 2026-10-29). What is drawn is what a rasterizer
 * computes:
 *
 *   - the projection: a point p moves along the ray from the eye through p,
 *     never off it, so it lands exactly where the ray crosses the plane;
 *   - the depth test: the flattened scene is not squashed to zero thickness
 *     but to a slab of relative thickness DEPTH_KEEP, depth order intact,
 *     so nearer surfaces still cover farther ones on the plane, as a
 *     z-buffer resolves them (drawing it at zero thickness would leave the
 *     overlap to the order the meshes happen to be drawn in);
 *   - clipping: only what the camera sees is projected; the rest of the
 *     scene is cut away at the frustum when the plane appears;
 *   - colour: flat surface colour, no lighting; a piece's shading fades to
 *     it as it flies. On the screen each piece is painted where it covers:
 *     the piece is rendered alone at SPP jittered samples a pixel (the same
 *     rays for every piece), and each SAMPLE takes the colour of the last
 *     landed piece covering it, the pixel the mean of its samples. (Blending
 *     whole-pixel coverages instead left dark seams where two pieces share a
 *     pixel.) Back to front here is a true depth order, so the finished
 *     screen is exactly FirstHitColor's image, the colour of the nearest
 *     surface along each pixel's ray, which level-zero builds ray by ray
 *     later. The colours are the ones three-scene draws (first-hit shares
 *     them).
 *
 * light: starts where flat ends, the flat image on the screen and the camera
 * in front of the box, and shades it pixel by pixel (Steve, 2026-10-29: show
 * the angle at each point and brighten or darken each pixel). Diffuse
 * shading, which does not depend on where the camera is: the light is a
 * point at the centre of the lamp (drawn as one), and
 *
 *     pixel = surface colour x (AMBIENT + (1 - AMBIENT) max(0, cos theta)),
 *
 * Lambert's diffuse rule. Every point facing away from the light gets no
 * direct light and sits at the flat AMBIENT floor, so the balls' lower halves
 * are one flat grey: honest for this model (the light that really reaches
 * them bounces off the floor and walls, which is what path tracing adds), so
 * kept. A wrapped cosine, (1 + cos theta) / 2, was tried to smooth it and
 * dropped: cosmetic, and it lifted surfaces edge-on to the light (the
 * ceiling) to mid grey.
 *
 * theta the angle between the surface normal and the direction to the
 * light. (The normal is taken on the side the camera sees, since the walls
 * are seen from inside.) At each point an elbow shows it: the normal (dark,
 * so it reads on the pale walls) and the line to the light, the angle
 * between them filled in as a wedge (Steve, 2026-10-29: no theta drawn, and
 * it must be clear there is an ANGLE). The brightness factor is made into
 * a scene of its own, rasterized, and multiplied with the colour image
 * (Steve, 2026-10-29: colour the scene itself in greyscale by this angle,
 * rasterize that, then multiply the two images):
 *
 *   1. the flat colour image lifts off the screen and parks small below it;
 *   2. the scene itself is coloured grey by the angle, object by object,
 *      independent of the screen (Steve, 2026-10-29: scan over objects and
 *      colour them uniformly): on each, a front sweeps across the surface
 *      (across a wall, top to bottom on a ball) and leaves the brightness
 *      factor behind it, white where the surface faces the light, while the
 *      elbow zigzags along the front like a brush;
 *   3. that grey scene is rasterized, piece by piece as on the flat slide,
 *      and the screen fills with the grey image;
 *   4. the colour image flies back onto the screen and the two multiply
 *      into the shaded image.
 *
 * Every image here is per-sample exact (SPP jittered samples a pixel): the
 * grey is the mean of the factor, the result the mean of colour x factor,
 * which is why the result is shown as computed rather than as the product
 * of the two displayed images.
 * It is a rasterizer's fake, easy to say: no shadows, no light bouncing
 * between surfaces, no falloff with distance, and the ambient floor stands
 * in for all the light that does not come straight from the lamp. The lamp
 * keeps its own colour. Screen and 3D scene use the same formula (CPU and
 * shader). The point and its lines are drawn over the scene, not
 * hidden by it.
 *
 * trace: the same shaded image again, made the other way round: by tracing
 * out into the world instead of projecting the world in (Steve, 2026-10-29:
 * the first path trace does this shading at its first step). From a blank
 * screen, a ray leaves the eye through a pixel's centre, crosses the plane
 * at that pixel and stops at the first surface; the elbow there measures
 * the angle to the light; the pixel takes the shaded colour directly. The
 * first TRACE_SLOW rays are slow, along a short wander from the top of the
 * white ball (as light's); then every other pixel in raster order, faster
 * and faster. The finished screen is light's image exactly (the same
 * per-sample computation). The 3D scene keeps its own lit look throughout.
 *
 * albedo, brightness, shadow, phong, reflection, refraction: Whitted's fake 1980 tracer, built
 * as passes (Steve, 2026-11-03: "each time we scan the image and produce our
 * data ... each time we take the existing images and we combine them to see
 * how it improved; at the end we have like 4 images that we stack together").
 * One slide per pass. Each starts where the last ended (the passes so far in
 * a row under the screen, their combination on the screen); the screen
 * clears; a scan traces every pixel and fills it with this pass's number,
 * TRACE_SLOW slow rays first, picked to show what the pass measures, then
 * the rest in raster order; the finished pass shrinks into its place in the
 * row; then every pass so far flies onto the screen and they combine.
 *
 *   albedo      the surface colour where the pixel's ray lands      c
 *   brightness  cos theta, the angle to the light (the elbow)       b
 *   shadow      does a ray from there reach the light: 1 or 0       v
 *   reflection  what the reflected ray sees; black off the mirror   r
 *   phong       the highlight: (R . V)^SHININESS on the shiny balls  h
 *               (R the light's direction mirrored about the normal, V
 *               toward the eye; 0 on matte surfaces), added in the
 *               lamp's colour: + ks h v. A trial in place of reflection
 *               (Steve, 2026-11-03), or with it: the run of slides is
 *               `&passes=` (default albedo,brightness,shadow,reflection).
 *
 *   refraction  what the ray bent through the glass sees; black      t
 *               off the glass (`&glass`, below)
 *
 * combined, after each:  c;  c (A + (1 - A) b);  c (A + (1 - A) b v);  and on
 * the mirror c r instead, on the glass t, A = AMBIENT (Steve: we do want an
 * ambient term). The blue ball is a perfect mirror tinted its own colour
 * (Steve), in this tracer only; until the reflection pass it is shaded like
 * any other surface. `&glass` swaps it for a clear glass ball, index 1.5
 * (Steve, 2026-11-03: after we see how a mirror works, we see how glass
 * works), shaded as a plain light grey ball until the refraction pass.
 *
 * Whitted's recursion: what the reflected or bent ray sees is the whole
 * recipe again where it lands, and if that is the mirror or the glass, again
 * (up to MAX_DEPTH, then black): the tracer calling itself. The glass bends
 * the ray by Snell's law going in and coming out; past the critical angle
 * it reflects inside instead. With both passes in a run, the glass mixes in
 * Fresnel's share of the reflected ray. Shadow rays stop at the glass as at
 * anything else (Whitted's, and its known fault: real glass focuses light,
 * a caustic). Bounced rays see the box with its front wall put back (a white
 * wall, as in the full Cornell box), so the mirror and the glass show the
 * room all round, not black out the open front; the camera's own rays still
 * come in through the open front, and the wall is not drawn in 3D. The
 * bounced path is drawn in blue. The light is a point at the lamp's centre, so
 * shadows are hard; the lamp itself is not shaded. Everything per sample
 * (SPP), as the other slides. Film resolution goes to 256 on these slides;
 * changing it recomputes every pass and jumps to the finished slide, which
 * holds (no loop).
 *
 * The plane sits at PLANE_DISTANCE, further out than level-zero's film, so
 * the flattened scene is big enough to read. Both ramp to the finished
 * image and hold.
 */

import { createStage, createUI, C } from '@';
import { SCENES, type SceneName } from '@/scenes/registry';
import { vizViewFor } from '@/viz/views';
import { buildScene } from '@/core/scene/scene';
import { surfaceColors } from '@/core/integrators/first-hit';
import { cameraSample } from '@/core/integrators/estimators';
import { IndependentSampler } from '@/core/sampler/independent';
import { srgbEncode } from '@/render/film';
import { occlusionPoint } from '@/core/geometry/visibility';
import { whittedTracer, BLACK, WHITTED_PASSES, type RGB } from '@/core/integrators/whitted';
import { Vec3 } from '@/core/math/vec3';
import { pixelSeedKey } from '@/core/sampler/sampler';
import { sceneToThree } from '@/viz/three-scene';
import { styleShortBox } from '@/viz/short-box';
import { imagePlaneFrame } from '@/viz/image-plane';
import { cellOnPlane, cellInPanel } from '@/viz/film-cell';
import { FilmPanel } from '@/viz/film-panel';
import { polyline, segments, setPolyline, setSegments } from '@/viz/lines';
import { label } from '@/viz/text';
import { ASPECT } from '@/viz/stage';
import * as THREE from 'three';

// --- Figure spec -----------------------------------------------------------
const SCENE: SceneName = 'cornell-short';
const SPP = 8; // antialiasing only
const ALL_PASSES = WHITTED_PASSES;
type Pass = (typeof ALL_PASSES)[number];
/**
 * The passes in this run of slides, in order: `&passes=` in the URL, comma
 * separated; by default albedo, brightness, shadow, reflection. Phong is a
 * trial in place of reflection (Steve, 2026-11-03), or with it.
 */
const PASSES: readonly Pass[] = (() => {
  const list = new URLSearchParams(location.search).get('passes')?.split(',') ?? ['albedo', 'brightness', 'shadow', 'reflection'];
  return list.filter((q): q is Pass => (ALL_PASSES as readonly string[]).includes(q));
})();
type Shade = 'flat' | 'light' | 'trace' | Pass;
const SHADE: Shade = (() => {
  const s = new URLSearchParams(location.search).get('shade');
  return s === 'light' || s === 'trace' || (ALL_PASSES as readonly string[]).includes(s ?? '') ? (s as Shade) : 'flat';
})();
/** Which pass this slide builds (0..3), or -1 on the other slides. */
const PASS_INDEX = (PASSES as readonly string[]).indexOf(SHADE);
const IS_PASS = PASS_INDEX >= 0;
/**
 * `&glass`: the blue ball swapped out for a glass one (Steve, 2026-11-03:
 * after we see how a mirror works, we see how glass works). It keeps the
 * name ballBlue, so every slide's list of pieces still finds it.
 */
const GLASS_SWAP = new URLSearchParams(location.search).has('glass');
const MIRROR: string | null = GLASS_SWAP ? null : 'ballBlue'; // the passes' perfect mirror, tinted its own colour
const GLASS: string | null = GLASS_SWAP ? 'ballBlue' : null;
/**
 * `&greenMirror=0.25`: a trial (Steve, 2026-11-03: what if we make the green
 * wall slightly reflective too?). The green wall's colour becomes (1 - k) its
 * own shading + k what its mirror ray sees, once the reflection pass is in.
 */
const GREEN_MIRROR = Number(new URLSearchParams(location.search).get('greenMirror')) || 0;
/** `&wallPhong=0.3`: a trial (Steve, 2026-11-03): the walls and floor get a Phong highlight too, this strong. */
const WALL_PHONG = Number(new URLSearchParams(location.search).get('wallPhong')) || 0;
const IOR = 1.5;
/** How many times a ray may bounce off the mirror or pass through the glass before it gives up (black). */
const MAX_DEPTH = 8;
const AMBIENT = 0.2;
/** Projected one at a time, in this order: back to front, a true depth order for this scene. */
const PIECES = ['back', 'left', 'right', 'floor', 'ceiling', 'light', 'ball', 'ballBlue'];
/** The screen, on the HUD, and the 3D view's sideways slide: as scene-and-screen. On the pass slides a little smaller and higher, to leave room for the row of passes under it. */
const SCREEN = IS_PASS
  ? { center: [-0.85, 0.06] as [number, number], height: 1.0 }
  : { center: [-0.85, -0.13] as [number, number], height: 1.15 };
/** The pass slides' row of passes under the screen: centres' height, each one's size, the gap between. */
const THUMB = { y: -0.66, height: 0.27, gap: 0.06 };
const thumbCenter = (j: number): [number, number] => [SCREEN.center[0] + (j - (PASSES.length - 1) / 2) * (THUMB.height + THUMB.gap), THUMB.y];
const SHIFT = -0.25;
const PLANE_DISTANCE = 3;
const DEPTH_KEEP = 0.03; // the flattened slab's thickness, relative to the scene's depth
const FAR = 9.5; // how far the frustum edges are drawn, from the eye
const BLANK = 18;
// Timing, seconds. flat:
const PLANE_IN = [0.6, 1.4]; // eye, plane and frustum appear; the unseen scene is cut away
const FIRST_PIECE = 2.0;
const PIECE = 0.9; // one piece's flight
const STAGGER = 0.7; // between one piece leaving and the next
const LAND = 0.3; // a landed piece's pixels fade in over this
const lastLands = FIRST_PIECE + (PIECES.length - 1) * STAGGER + PIECE + LAND;
// light:
const ASIDE = [0.8, 2.0]; // the colour image lifts off the screen and parks below it
const WANDER_REACH = 4 / 24; // trace: how far one step of the slow rays' wander may go, as a share of the screen
// light: each object is scanned grey in turn, PIECES order, this long each.
const SCAN_START = 2.5;
const SCAN_SECONDS: Record<string, number> = {
  back: 3.2, left: 2.2, right: 2.0, floor: 2.0, ceiling: 1.8, light: 0.8, ball: 2.6, ballBlue: 2.2,
};
const ZIGZAGS = 3; // passes of the elbow across the front, per object
const scanStarts = PIECES.reduce<number[]>((acc, name, k) => [...acc, k ? acc[k - 1]! + SCAN_SECONDS[PIECES[k - 1]!]! : SCAN_START], []);
const scanEnd = scanStarts[PIECES.length - 1]! + SCAN_SECONDS[PIECES[PIECES.length - 1]!]!;
// trace:
const TRACE_START = 1.0;
const TRACE_SLOW = 5; // slow rays, along the wander
const RAY_STEP = 2.2; // each slow ray: out to the scene, the elbow, the pixel
const RAY_OUT = 0.8; // into a step, when the ray reaches the surface
const RAY_FILL = 1.4; // and when its pixel is filled
const traceSlowEnd = TRACE_START + TRACE_SLOW * RAY_STEP;
const TRACE_FAST = [traceSlowEnd, traceSlowEnd + 10]; // every other pixel, raster order, eased in
const TRACE_LIT_3D = [TRACE_FAST[1]! + 0.6, TRACE_FAST[1]! + 2.0]; // a beat on the result before the hold
const GREY_PIECES = scanEnd + 0.8; // then the grey scene is rasterized, piece by piece
const greyLands = GREY_PIECES + (PIECES.length - 1) * STAGGER + PIECE + LAND;
const BACK = [greyLands + 0.5, greyLands + 2.0]; // the colour image flies back onto the screen
const MULTIPLY = [BACK[1]!, BACK[1]! + 0.8]; // and the two become the shaded image
const LIT_3D = [MULTIPLY[1]! + 0.3, MULTIPLY[1]! + 1.7]; // a beat on the result before the hold
/** Where the colour image waits while the grey is built: HUD centre, and its size relative to the screen. */
const PARKED = { center: [-1.22, -0.8] as [number, number], scale: 0.3 };
const HOLD = 3;
// The pass slides. Each slow ray: out to the scene (P_OUT), then what this
// pass measures there (P_PROBE: the elbow, the shadow ray, the reflected
// ray), then its pixel is filled (P_FILL).
const P_STEP: Record<Pass, number> = { albedo: 2.0, brightness: 2.4, shadow: 3.0, phong: 2.8, reflection: 3.0, refraction: 3.2 };
const P_FILL: Record<Pass, number> = { albedo: 1.2, brightness: 1.6, shadow: 2.2, phong: 2.0, reflection: 2.2, refraction: 2.4 };
const P_OUT = 0.8;
const P_PROBE = [1.0, 1.7];
const P_CLEAR = [0.3, 0.9]; // the last slide's combined image leaves the screen
const P_SCAN = 1.2; // the first slow ray
const pPass: Pass = IS_PASS ? PASSES[PASS_INDEX]! : 'albedo';
const pSlowEnd = P_SCAN + TRACE_SLOW * P_STEP[pPass];
const P_FAST = [pSlowEnd, pSlowEnd + 8]; // the rest of the pixels, raster order, eased in
const P_PARK = [P_FAST[1]! + 0.5, P_FAST[1]! + 1.7]; // the finished pass shrinks into its place in the row
const P_STACK = P_PARK[1]! + 0.5; // then every pass so far flies onto the screen, one after another,
const P_STACK_EACH = 0.9;
const P_STACK_STAGGER = 0.3;
const pStackEnd = P_STACK + Math.max(0, PASS_INDEX) * P_STACK_STAGGER + P_STACK_EACH;
const P_RESULT = [pStackEnd + 0.2, pStackEnd + 0.9]; // and they become the combined image
const P_HOME = [P_RESULT[1]! + 0.4, P_RESULT[1]! + 1.2]; // the passes back in the row
const P_END = P_HOME[1]!;

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });
const ui = createUI(stage);
stage.renderer.localClippingEnabled = true;

const desc: typeof SCENES[SceneName] = GLASS_SWAP
  ? {
      ...SCENES[SCENE],
      primitives: SCENES[SCENE].primitives.map((p) => (p.name === 'ballBlue' ? { ...p, material: { kind: 'dielectric' as const, ior: IOR } } : p)),
    }
  : SCENES[SCENE];
/**
 * The box with its front wall put back, for the rays that bounce: a reflected
 * or refracted ray that heads out the open front sees a white wall there, as
 * in the full Cornell box, instead of black. The camera's own rays use the
 * open box (they come in through the front). Not drawn in 3D.
 */
const descClosed: typeof SCENES[SceneName] = {
  ...desc,
  primitives: [
    ...desc.primitives,
    { name: 'front', shape: { kind: 'quad', q: [-2, 0, 2], e1: [0, 4, 0], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.7592, 0.7257, 0.6863] } },
  ],
};
const LAMP = (() => {
  const lamp = desc.primitives.find((p) => p.name === 'light')!;
  if (lamp.shape.kind !== 'quad') throw new Error('expected a quad lamp');
  const { q, e1, e2 } = lamp.shape;
  return new THREE.Vector3(...q).addScaledVector(new THREE.Vector3(...e1), 0.5).addScaledVector(new THREE.Vector3(...e2), 0.5);
})();
const COLORS = surfaceColors(descClosed);

const sceneGroup = sceneToThree(desc);
stage.add(sceneGroup);
styleShortBox(stage.renderer, stage.scene, sceneGroup, desc);
const view = vizViewFor(SCENE);
stage.camera.position.set(...view.eye);
stage.controls?.target.set(...view.target);
stage.controls?.update();
stage.shiftView(SHIFT);

// --- The camera: eye, plane, frustum ---------------------------------------
const frame = imagePlaneFrame(desc.camera, PLANE_DISTANCE);
const { eye, center, right, up, forward, halfW, halfH } = frame;
const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) =>
  center.clone().addScaledVector(right, x! * halfW).addScaledVector(up, y! * halfH),
);

/**
 * The normal the shading uses. A wall is two-sided, so its normal is turned
 * to the side the camera sees, into the room; a ball's is always outward.
 * (Turning the balls' normals too flipped them on the part of each ball the
 * scene's camera does not face, which the 3D view does see: a wrongly shaded
 * cap on the front of each ball.)
 */
const isTwoSided = (name: string) => descClosed.primitives.find((p) => p.name === name)?.shape.kind === 'quad';
const shadingNormal = (p: THREE.Vector3, n: THREE.Vector3, twoSided: boolean) =>
  twoSided && n.dot(eye.clone().sub(p)) < 0 ? n.clone().negate() : n.clone();

/** The brightness factor at a surface point (see header); the lamp is not shaded. */
function brightnessAt(name: string, p: THREE.Vector3, n: THREE.Vector3): number {
  if (name === 'light') return 1;
  return AMBIENT + (1 - AMBIENT) * Math.max(0, shadingNormal(p, n, isTwoSided(name)).dot(LAMP.clone().sub(p).normalize()));
}

// --- The passes' numbers at a surface point: Whitted's tracer ---------------
// (src/core/integrators/whitted.ts; shared with whitted-room.)
type Aggregate = ReturnType<typeof buildScene>['aggregate'];
const LAMP_V = new Vec3(LAMP.x, LAMP.y, LAMP.z);
/** The lamp's centre as a surface point, facing down into the room: where shadow rays aim. */
const LAMP_POINT = { p: LAMP_V, ng: new Vec3(0, -1, 0) };
/** The closed box, where shadow rays and every bounced ray go. */
const aggClosed = buildScene(descClosed, 1, 1).aggregate;
const { nameOf, isGlass, reflects, lookAt, colourWith, passedOn, bouncePath } = whittedTracer(descClosed, {
  agg: aggClosed,
  mirror: MIRROR,
  reflective: GREEN_MIRROR > 0 ? { right: GREEN_MIRROR } : {},
  glass: GLASS,
  ior: IOR,
  ambient: AMBIENT,
  shininess: 30, // Phong's exponent
  // the two balls shiny, the walls matte (unless &wallPhong)
  ks: {
    ball: 0.5,
    ballBlue: 0.5,
    ...Object.fromEntries(WALL_PHONG > 0 ? ['left', 'right', 'back', 'floor', 'ceiling', 'front'].map((w) => [w, WALL_PHONG]) : []),
  },
  maxDepth: MAX_DEPTH,
});

const eyeDot = new THREE.Mesh(
  new THREE.SphereGeometry(0.08, 20, 12),
  new THREE.MeshBasicMaterial({ color: C.bone, transparent: true, toneMapped: false }),
);
eyeDot.position.copy(eye);
const planeOutline = polyline([...corners, corners[0]!], { color: C.bone, width: 3, opacity: 0.999 });
const toPlane = segments({ width: 2, opacity: 0.999 });
const beyond = segments({ width: 1.5, opacity: 0.999 });
const solid = (n: number, hex: number) => {
  const c = new THREE.Color(hex);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 3) c.toArray(out, i);
  return out;
};
{
  const near: number[] = [];
  const far: number[] = [];
  for (const c of corners) {
    const f = eye.clone().add(c.clone().sub(eye).multiplyScalar(FAR / PLANE_DISTANCE));
    near.push(eye.x, eye.y, eye.z, c.x, c.y, c.z);
    far.push(c.x, c.y, c.z, f.x, f.y, f.z);
  }
  setSegments(toPlane, new Float32Array(near), solid(near.length, C.bone));
  setSegments(beyond, new Float32Array(far), solid(far.length, C.bone));
}
const cameraParts = [eyeDot, planeOutline, toPlane, beyond];
stage.add(...cameraParts);

// The frustum's four sides, normals inward: three clips the negative side.
// While the camera is not yet shown they are pushed far out, cutting nothing.
const frustum = corners.map((c, i) => {
  const plane = new THREE.Plane().setFromCoplanarPoints(eye, c, corners[(i + 1) % 4]!);
  if (plane.distanceToPoint(center) < 0) plane.negate();
  return plane;
});
const frustumConstants = frustum.map((p) => p.constant);
const OFF = 1000;

// --- Flattening and colour, in the shaders ---------------------------------
const shared = {
  uLitAll: { value: 0 }, // how far the 3D scene has taken the angle shading (light)
  uGreyOn: { value: 0 }, // light: surfaces turned grey show the brightness factor, in white light
  uLamp: { value: LAMP.clone() },
  uAmb: { value: AMBIENT },
  uEye: { value: eye.clone() },
  uFwd: { value: forward.clone() },
  uD: { value: PLANE_DISTANCE },
  uK: { value: DEPTH_KEEP },
};
interface Piece {
  flat: { value: number }; // how far it has flown onto the plane
  shade: { value: number }; // how far its colour has gone from three's lighting to the slide's
  /** light: the grey front, a distance along sweepDir from sweepFrom; grey behind it. */
  front: { value: number };
  sweep: Sweep;
}

/**
 * How an object is scanned grey (light): the front's start and direction,
 * how far it travels, and where the elbow is with the front at s and the
 * zigzag at w in [0, 1] across it.
 */
interface Sweep {
  from: THREE.Vector3;
  dir: THREE.Vector3;
  length: number;
  at(s: number, w: number): { p: THREE.Vector3; n: THREE.Vector3 };
}
function sweepOf(name: string): Sweep {
  const shape = desc.primitives.find((p) => p.name === name)!.shape;
  if (shape.kind === 'quad') {
    // Across e1, the elbow zigzagging along e2.
    const q = new THREE.Vector3(...shape.q);
    const e1 = new THREE.Vector3(...shape.e1);
    const e2 = new THREE.Vector3(...shape.e2);
    const n = e1.clone().cross(e2).normalize();
    const dir = e1.clone().normalize();
    return {
      from: q,
      dir,
      length: e1.length(),
      at: (s, w) => ({ p: q.clone().addScaledVector(dir, s).addScaledVector(e2, 0.1 + 0.8 * w), n }),
    };
  }
  if (shape.kind !== 'sphere') throw new Error('expected quads and spheres');
  // Top to bottom, the elbow zigzagging round the side the viewer sees.
  const c = new THREE.Vector3(...shape.center);
  const r = shape.radius;
  const v = new THREE.Vector3(...view.eye).sub(c);
  const facing = Math.atan2(v.z, v.x);
  return {
    from: c.clone().add(new THREE.Vector3(0, r, 0)),
    dir: new THREE.Vector3(0, -1, 0),
    length: 2 * r,
    at: (s, w) => {
      const y = r - Math.min(2 * r * 0.97, Math.max(2 * r * 0.03, s));
      const ring = Math.sqrt(Math.max(0, r * r - y * y));
      const phi = facing + (w - 0.5) * 2.4;
      const n = new THREE.Vector3(ring * Math.cos(phi), y, ring * Math.sin(phi)).normalize();
      return { p: c.clone().addScaledVector(n, r), n };
    },
  };
}
// sceneToThree adds one mesh per primitive, in order.
const pieces: Piece[] = PIECES.map((name) => {
  const i = desc.primitives.findIndex((p) => p.name === name);
  if (i < 0) throw new Error(`no primitive ${name}`);
  const mat = (sceneGroup.children[i] as THREE.Mesh).material as THREE.MeshStandardMaterial;
  const flat = { value: 0 };
  const shade = { value: 0 };
  const front = { value: -1 };
  const sweep = sweepOf(name);
  const c = COLORS.get(name)!;
  const own = {
    uFlat: flat,
    uShade: shade,
    uFront: front,
    uSweepFrom: { value: sweep.from },
    uSweepDir: { value: sweep.dir },
    uAlbedo: { value: new THREE.Vector3(c.r, c.g, c.b) },
    uLit: { value: name !== 'light' ? 1 : 0 },
    uTwoSided: { value: isTwoSided(name) ? 1 : 0 },
  };
  mat.clippingPlanes = frustum;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, own);
    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        `uniform float uFlat; uniform vec3 uEye; uniform vec3 uFwd; uniform float uD; uniform float uK;
        varying vec3 vWorldP; varying vec3 vWorldN;
        void main() {`,
      )
      .replace(
        '#include <project_vertex>',
        `vec4 wp = modelMatrix * vec4( transformed, 1.0 );
        vWorldP = wp.xyz;
        vWorldN = normalize( mat3( modelMatrix ) * objectNormal );
        vec3 rel = wp.xyz - uEye;
        float ze = dot( rel, uFwd );
        float zFlat = uD + uK * ( ze - uD );
        wp.xyz = uEye + rel * ( mix( ze, zFlat, uFlat ) / ze );
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;`,
      );
    // three's lighting gives way to the slide's colour (shadeAt, in GLSL),
    // written after tone mapping so it is shown as is.
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `uniform float uShade; uniform vec3 uAlbedo; uniform float uLit; uniform float uLitAll; uniform float uTwoSided;
        uniform vec3 uLamp; uniform float uAmb; uniform vec3 uEye; varying vec3 vWorldP; varying vec3 vWorldN;
        uniform float uGreyOn; uniform float uFront; uniform vec3 uSweepFrom; uniform vec3 uSweepDir;
        void main() {`,
      )
      .replace(
        '#include <tonemapping_fragment>',
        `#include <tonemapping_fragment>
        vec3 nW = normalize( vWorldN );
        if ( uTwoSided > 0.5 && dot( nW, uEye - vWorldP ) < 0.0 ) nW = -nW;
        float lit = uAmb + ( 1.0 - uAmb ) * max( 0.0, dot( nW, normalize( uLamp - vWorldP ) ) );
        // light: grey behind the scan's front.
        float grey = uGreyOn * ( 1.0 - smoothstep( uFront - 0.06, uFront, dot( vWorldP - uSweepFrom, uSweepDir ) ) );
        vec3 surface = mix( uAlbedo, vec3( 1.0 ), uGreyOn );
        float k = mix( 1.0, lit, max( uLit * uLitAll, uLit * uGreyOn ) );
        gl_FragColor.rgb = mix( gl_FragColor.rgb, surface * k, max( uShade, grey ) );`,
      );
  };
  mat.needsUpdate = true;
  return { flat, shade, front, sweep };
});

// --- The point being shaded (light) ----------------------------------------
// Where a pixel's centre sees the scene: the point, and the elbow there, its
// normal (dark, with an arrowhead) and the line to the light (ochre), the
// angle between them a filled wedge (rust); and the pixel, outlined on the
// plane and the screen. The light itself, a point.
const INK = 0x1d2227;
const WEDGE_R = 0.55;
const WEDGE_STEPS = 24;
const probeGroup = new THREE.Group();
const probeDot = new THREE.Mesh(
  new THREE.SphereGeometry(0.07, 16, 10),
  new THREE.MeshBasicMaterial({ color: INK, toneMapped: false }),
);
const probeNormal = polyline([[0, 0, 0], [0, 0, 1]], { color: INK, width: 7 });
const probeArrow = polyline([[0, 0, 0], [0, 0, 0], [0, 0, 0]], { color: INK, width: 7 });
const probeToLamp = polyline([[0, 0, 0], [0, 0, 1]], { color: C.ochre, width: 6 });
const wedgeGeometry = new THREE.BufferGeometry();
wedgeGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WEDGE_STEPS * 9), 3));
const wedge = new THREE.Mesh(
  wedgeGeometry,
  new THREE.MeshBasicMaterial({ color: C.rust, transparent: true, opacity: 0.75, side: THREE.DoubleSide, toneMapped: false }),
);
wedge.frustumCulled = false;
const zeros = (n: number) => Array.from({ length: n }, () => [0, 0, 0] as [number, number, number]);
const planeCell = polyline(zeros(5), { color: C.ochre, width: 3 });
probeGroup.add(wedge, probeDot, probeNormal, probeArrow, probeToLamp, planeCell);
// Drawn over the scene: from the viewer's side a wall or the ball would
// otherwise hide half of what is being pointed at.
probeGroup.traverse((o) => {
  if (!(o instanceof THREE.Mesh)) return;
  (o.material as THREE.Material).depthTest = false;
  o.renderOrder = 5;
});
stage.add(probeGroup);
const screenCell = polyline(zeros(5), { color: C.ochre, width: 3 });
stage.hud.add(screenCell);
const lightPoint = new THREE.Mesh(
  new THREE.SphereGeometry(0.12, 20, 12),
  new THREE.MeshBasicMaterial({ color: C.ochreLight, toneMapped: false }),
);
lightPoint.position.copy(LAMP).add(new THREE.Vector3(0, -0.12, 0));
lightPoint.visible = SHADE !== 'flat';
stage.add(lightPoint);

/** The wedge: the angle at q between unit directions a and b, filled. `fallback` is any direction off a, for when a and b are parallel. */
function setWedge(q: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, fallback: THREE.Vector3): void {
  const angle = a.angleTo(b);
  const axis = a.clone().cross(b);
  if (axis.lengthSq() < 1e-9) axis.copy(fallback).cross(a);
  axis.normalize();
  const pos = wedgeGeometry.getAttribute('position') as THREE.BufferAttribute;
  const rim = (k: number) => q.clone().addScaledVector(a.clone().applyAxisAngle(axis, (angle * k) / WEDGE_STEPS), WEDGE_R);
  for (let k = 0; k < WEDGE_STEPS; k++) {
    const r0 = rim(k);
    const r1 = rim(k + 1);
    pos.setXYZ(3 * k, q.x, q.y, q.z);
    pos.setXYZ(3 * k + 1, r0.x, r0.y, r0.z);
    pos.setXYZ(3 * k + 2, r1.x, r1.y, r1.z);
  }
  pos.needsUpdate = true;
}

function placeProbe(p: THREE.Vector3, normal: THREE.Vector3, twoSided: boolean, x: number, y: number): void {
  const n = shadingNormal(p, normal, twoSided);
  const q = p.clone().addScaledVector(n, 0.01);
  const l = lightPoint.position.clone().sub(q).normalize();
  probeDot.position.copy(q);
  // The normal, with an arrowhead in the plane of the angle.
  const tip = q.clone().addScaledVector(n, 1.1);
  const across = l.clone().addScaledVector(n, -l.dot(n));
  if (across.lengthSq() < 1e-6) across.set(1, 0, 0).addScaledVector(n, -n.x);
  across.normalize();
  setPolyline(probeNormal, [q, tip]);
  setPolyline(probeArrow, [
    tip.clone().addScaledVector(n, -0.18).addScaledVector(across, 0.11),
    tip,
    tip.clone().addScaledVector(n, -0.18).addScaledVector(across, -0.11),
  ]);
  setPolyline(probeToLamp, [q, lightPoint.position]);
  // The angle between them, filled: a fan of triangles from the point.
  setWedge(q, n, l, across);
  const res = params.grid;
  setPolyline(planeCell, cellOnPlane(desc.camera, PLANE_DISTANCE, res, x, y));
  setPolyline(screenCell, cellInPanel(SCREEN.center, SCREEN.height, res, x, y));
}

// --- Labels ----------------------------------------------------------------
const sceneLabel = label('scene', { size: 0.08, color: C.bone, anchorX: 'center', anchorY: 'bottom', opacity: 0.999 });
const screenLabel = label('screen', {
  size: 0.08,
  color: C.bone,
  anchorX: 'center',
  anchorY: 'bottom',
  opacity: 0.999,
  position: [SCREEN.center[0], SCREEN.center[1] + SCREEN.height / 2 + 0.05, 0],
});
stage.hud.add(sceneLabel, screenLabel);
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
function toHud(p: THREE.Vector3): [number, number] {
  const ndc = p.clone().project(stage.camera);
  return [ndc.x * ASPECT, ndc.y];
}

// --- The screen ------------------------------------------------------------
let screen: FilmPanel | null = null;
let pixels: Uint8ClampedArray | null = null;
const gridLines = segments({ width: 1.5, opacity: 0.999 });
stage.hud.add(gridLines);

const params = { grid: 64 };
// On the pass slides it goes to 256, and a change jumps to the finished slide (see header).
ui.params.add(params, 'grid', 2, IS_PASS ? 256 : 64, 1).name('film resolution').onChange(() => restart(true));

/**
 * Per piece, per pixel: which of the SPP samples it covers (a bitmask), and
 * each sample's colour there, flat and lit (sRGB bytes, at
 * (pixel * SPP + sample) * 3).
 */
let layers: { covers: Uint8Array; flat: Uint8Array; lit: Uint8Array; grey: Uint8Array }[] = [];
/** light: the finished flat and lit images (sRGB bytes per pixel), and each pixel centre's surface point. */
let flatImage = new Uint8Array(0);
let litImage = new Uint8Array(0);
let greyImage = new Uint8Array(0);
/** light: the colour image, which lifts off the screen and comes back. */
let colourPanel: FilmPanel | null = null;
let centres: ({ p: THREE.Vector3; n: THREE.Vector3; twoSided: boolean } | null)[] = [];
/** light: the pixels in the order they are shaded. */
let order: number[] = [];
let shownFill = '';

function buildScreen(res: number): void {
  screen?.dispose();
  screen = new FilmPanel({ width: res, height: res, center: SCREEN.center, drawnHeight: SCREEN.height, border: false });
  pixels = new Uint8ClampedArray(res * res * 4);
  stage.hud.add(screen.group);

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

/** The screen with the first landed[k] of each piece painted, back to front, per sample. */
function composite(landed: number[], which: 'flat' | 'lit' | 'grey', out: Uint8Array | Uint8ClampedArray, stride: number): void {
  const n = params.grid * params.grid;
  for (let i = 0; i < n; i++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let s = 0; s < SPP; s++) {
      let sr = BLANK;
      let sg = BLANK;
      let sb = BLANK;
      const o = (i * SPP + s) * 3;
      layers.forEach((layer, k) => {
        const a = layer.covers[i]! & (1 << s) ? landed[k]! : 0;
        if (a <= 0) return;
        const rgb = layer[which];
        sr += (rgb[o]! - sr) * a;
        sg += (rgb[o + 1]! - sg) * a;
        sb += (rgb[o + 2]! - sb) * a;
      });
      r += sr;
      g += sg;
      b += sb;
    }
    out[i * stride] = r / SPP;
    out[i * stride + 1] = g / SPP;
    out[i * stride + 2] = b / SPP;
    if (stride === 4) out[i * stride + 3] = 255;
  }
}

function restart(jump = false): void {
  const res = params.grid;
  buildScreen(res);
  shownFill = '';
  if (IS_PASS) {
    restartPasses(jump);
    return;
  }
  const sampler = new IndependentSampler(0);
  const v3 = (u: { x: number; y: number; z: number }) => new THREE.Vector3(u.x, u.y, u.z);
  // Each piece rendered alone, the same rays for every piece: which samples
  // of each pixel it covers, and its colour at each, flat and lit.
  layers = PIECES.map((name) => {
    const alone = { ...desc, primitives: desc.primitives.filter((p) => p.name === name) };
    const scene = buildScene(alone, res, res);
    const covers = new Uint8Array(res * res);
    const flat = new Uint8Array(res * res * SPP * 3);
    const lit = new Uint8Array(res * res * SPP * 3);
    const grey = new Uint8Array(res * res * SPP * 3);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        for (let s = 0; s < SPP; s++) {
          sampler.startPixelSample(pixelSeedKey(x, y, s));
          const hit = scene.aggregate.intersect(cameraSample(scene, [x, y], sampler).ray);
          if (!hit) continue;
          const i = y * res + x;
          covers[i]! |= 1 << s;
          const o = (i * SPP + s) * 3;
          const c = COLORS.get(name)!;
          const k = brightnessAt(name, v3(hit.p), v3(hit.ns));
          const put = (out: Uint8Array, r: number, g: number, b: number) => {
            out[o] = srgbEncode(r);
            out[o + 1] = srgbEncode(g);
            out[o + 2] = srgbEncode(b);
          };
          put(flat, c.r, c.g, c.b);
          put(lit, c.r * k, c.g * k, c.b * k);
          put(grey, k, k, k);
        }
      }
    }
    return { covers, flat, lit, grey };
  });

  if (SHADE !== 'flat') {
    const all = PIECES.map(() => 1);
    flatImage = new Uint8Array(res * res * 3);
    litImage = new Uint8Array(res * res * 3);
    composite(all, 'flat', flatImage, 3);
    composite(all, 'lit', litImage, 3);
    greyImage = new Uint8Array(res * res * 3);
    composite(all, 'grey', greyImage, 3);
    colourPanel?.dispose();
    colourPanel = null;
    if (SHADE === 'light') colourPanel = new FilmPanel({ width: res, height: res, drawnHeight: SCREEN.height, border: true, opacity: 0.999 });
    const rgba = new Uint8ClampedArray(res * res * 4);
    for (let i = 0; i < res * res; i++) {
      rgba.set(flatImage.subarray(i * 3, i * 3 + 3), i * 4);
      rgba[i * 4 + 3] = 255;
    }
    colourPanel?.update(rgba);
    if (colourPanel) stage.hud.add(colourPanel.group);

    // Where each pixel's centre sees the scene.
    const scene = buildScene(desc, res, res);
    const names: (string | null)[] = [];
    centres = [];
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const hit = scene.aggregate.intersect(scene.camera.generateRay([x + 0.5, y + 0.5]));
        const name = hit ? (hit.primitive as unknown as { name: string }).name : '';
        centres.push(hit ? { p: v3(hit.p), n: v3(hit.ns).normalize(), twoSided: isTwoSided(name) } : null);
        names.push(hit ? (hit.primitive as unknown as { name: string }).name : null);
      }
    }
    // The wander: from the pixel nearest the top of the white ball, each step
    // to a random unvisited pixel within WANDER_REACH that sees the scene;
    // then every other pixel in random order. Seeded, so every run is the same.
    let seed = 12345;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    const ball = desc.primitives.find((q) => q.name === 'ball')!.shape;
    if (ball.kind !== 'sphere') throw new Error('expected a sphere');
    const top = new THREE.Vector3(...ball.center).add(new THREE.Vector3(0.1, 0.9, 0.5).normalize().multiplyScalar(ball.radius));
    let at = 0;
    centres.forEach((c, i) => {
      if (c && names[i] === 'ball' && c.p.distanceTo(top) < (centres[at]?.p.distanceTo(top) ?? Infinity)) at = i;
    });
    const reach = Math.max(1, Math.round(WANDER_REACH * res));
    const walk = [at];
    while (walk.length < Math.min(TRACE_SLOW, res * res)) {
      const [x0, y0] = [at % res, Math.floor(at / res)];
      const near: number[] = [];
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const [x, y] = [x0 + dx, y0 + dy];
          const i = y * res + x;
          if ((dx || dy) && x >= 0 && y >= 0 && x < res && y < res && centres[i] && !walk.includes(i)) near.push(i);
        }
      }
      if (!near.length) break;
      at = near[Math.floor(random() * near.length)]!;
      walk.push(at);
    }
    const rest = Array.from({ length: res * res }, (_, i) => i).filter((i) => !walk.includes(i));
    // trace keeps the rest in raster order, a render's scan; light shuffles it.
    if (SHADE === 'light') for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [rest[i], rest[j]] = [rest[j]!, rest[i]!];
    }
    order = [...walk, ...rest];
  }
  stage.duration = (SHADE === 'light' ? LIT_3D[1]! : SHADE === 'trace' ? TRACE_LIT_3D[1]! : lastLands) + HOLD;
  stage.t = 0;
}

// --- Playback --------------------------------------------------------------
const ramp = (t: number, [a, b]: number[]) => Math.min(1, Math.max(0, (t - a!) / (b! - a!)));
const smooth = (u: number) => u * u * (3 - 2 * u);

stage.frame((t) => {
  sceneLabel.position.set(...toHud(sceneTop), 0);
  if (SHADE === 'light') frameLight(t);
  else if (SHADE === 'trace') frameTrace(t);
  else if (IS_PASS) framePass(t);
  else frameFlat(t);
});

function showCamera(shown: number): void {
  for (const part of cameraParts) part.visible = shown > 0;
  (eyeDot.material as THREE.MeshBasicMaterial).opacity = shown;
  planeOutline.material.opacity = 0.999 * shown;
  toPlane.material.opacity = 0.9 * shown;
  beyond.material.opacity = 0.3 * shown;
  frustum.forEach((p, i) => (p.constant = frustumConstants[i]! + (shown > 0 ? 0 : OFF)));
}

function frameFlat(t: number): void {
  showCamera(ramp(t, PLANE_IN));
  probeGroup.visible = screenCell.visible = false;

  // The pieces fly one at a time, each flattening onto the plane, and
  // each appears on the screen as it lands, over the ones before.
  const landed = pieces.map((piece, k) => {
    const start = FIRST_PIECE + k * STAGGER;
    piece.flat.value = smooth(ramp(t, [start, start + PIECE]));
    piece.shade.value = piece.flat.value;
    return ramp(t, [start + PIECE, start + PIECE + LAND]);
  });

  if (!screen || !pixels || !layers.length) return;
  const under = Math.min(1, 24 / params.grid);
  gridLines.material.opacity = 0.999 * (1 + (under - 1) * ramp(t, [FIRST_PIECE + PIECE, lastLands]));
  const key = landed.map((a) => Math.round(a * 32)).join();
  if (key === shownFill) return;
  shownFill = key;
  composite(landed, 'flat', pixels, 4);
  screen.update(pixels);
}

function frameLight(t: number): void {
  // Where the flat slide ended: the camera up, the flat image on the screen.
  showCamera(1);
  shared.uGreyOn.value = 1;
  if (!screen || !pixels || !order.length) return;

  // The scan: each object in turn, its front sweeping across and the elbow
  // zigzagging along it; grey behind the front.
  let scanning = -1;
  pieces.forEach((piece, k) => {
    const u = ramp(t, [scanStarts[k]!, scanStarts[k]! + SCAN_SECONDS[PIECES[k]!]!]);
    piece.front.value = u <= 0 ? -1 : u >= 1 ? piece.sweep.length + 1 : u * piece.sweep.length;
    if (u > 0 && u < 1) scanning = k;
  });
  probeGroup.visible = scanning >= 0;
  screenCell.visible = false; // the grey goes onto the scene here, not a pixel
  if (scanning >= 0) {
    const piece = pieces[scanning]!;
    const u = ramp(t, [scanStarts[scanning]!, scanStarts[scanning]! + SCAN_SECONDS[PIECES[scanning]!]!]);
    const zig = (u * ZIGZAGS) % 1;
    const w = Math.floor(u * ZIGZAGS) % 2 ? 1 - zig : zig;
    const { p, n } = piece.sweep.at(u * piece.sweep.length, w);
    placeProbe(p, n, isTwoSided(PIECES[scanning]!), 0, 0);
    planeCell.visible = false;
  }

  // Then the grey scene is rasterized, piece by piece, onto the screen.
  const landed = pieces.map((piece, k) => {
    const start = GREY_PIECES + k * STAGGER;
    piece.flat.value = smooth(ramp(t, [start, start + PIECE]));
    piece.shade.value = 0;
    return ramp(t, [start + PIECE, start + PIECE + LAND]);
  });
  const under = Math.min(1, 24 / params.grid);
  gridLines.material.opacity = 0.999 * (1 + (under - 1) * ramp(t, [GREY_PIECES + PIECE, greyLands]));

  // The colour image: on the screen, lifted off to its parking spot, then
  // back onto the screen, where it is replaced by the product.
  if (colourPanel) {
    const away = smooth(ramp(t, ASIDE)) * (1 - smooth(ramp(t, BACK)));
    const [sx, sy] = SCREEN.center;
    const [px, py] = PARKED.center;
    colourPanel.group.position.set(sx + (px - sx) * away, sy + (py - sy) * away, 0.05);
    colourPanel.group.scale.setScalar(1 + (PARKED.scale - 1) * away);
    colourPanel.group.visible = t < MULTIPLY[0]!;
  }

  // The screen: blank under the colour image, the grey image as its pieces
  // land, then the product.
  const product = ramp(t, MULTIPLY);
  const key = `${landed.map((a) => Math.round(a * 32)).join()}/${Math.round(product * 32)}`;
  if (key === shownFill) return;
  shownFill = key;
  composite(landed, 'grey', pixels, 4);
  if (product > 0) {
    for (let i = 0; i < params.grid * params.grid; i++) {
      for (let c = 0; c < 3; c++) {
        const under = pixels[i * 4 + c]!;
        pixels[i * 4 + c] = under + (litImage[i * 3 + c]! - under) * product;
      }
    }
  }
  screen.update(pixels);
}

// The ray of trace: from the eye to where a pixel's centre sees the scene.
const ray = polyline([[0, 0, 0], [0, 0, 1]], { color: C.bone, width: 5 });
(ray.material as THREE.Material).depthTest = false;
ray.renderOrder = 5;
ray.visible = false;
stage.add(ray);

function frameTrace(t: number): void {
  showCamera(1);
  for (const piece of pieces) piece.shade.value = 0; // the 3D scene keeps its own shading (styleShortBox)
  if (!screen || !pixels || !order.length) return;

  // Which ray is out, how far it has got, and how many pixels are filled.
  let current: number;
  let reach = 1;
  let elbow = true;
  let done: number;
  if (t < traceSlowEnd) {
    current = Math.floor((t - TRACE_START) / RAY_STEP);
    const local = t - TRACE_START - current * RAY_STEP;
    reach = smooth(Math.min(1, local / RAY_OUT));
    elbow = local >= RAY_OUT;
    done = current < 0 ? 0 : current + (local >= RAY_FILL ? 1 : 0);
  } else {
    const u = ramp(t, TRACE_FAST);
    done = TRACE_SLOW + Math.floor((order.length - TRACE_SLOW) * u * u);
    current = Math.min(order.length - 1, done);
  }
  const live = current >= 0 && t < TRACE_FAST[1]!;
  const centre = live ? centres[order[current]!] : null;
  ray.visible = !!centre;
  probeGroup.visible = screenCell.visible = !!centre && elbow;
  if (centre) {
    const i = order[current]!;
    setPolyline(ray, [eye, eye.clone().lerp(centre.p, reach)]);
    placeProbe(centre.p, centre.n, centre.twoSided, i % params.grid, Math.floor(i / params.grid));
    probeGroup.visible = elbow;
    planeCell.visible = true;
    screenCell.visible = true;
    probeDot.visible = probeNormal.visible = probeArrow.visible = probeToLamp.visible = wedge.visible = elbow;
    probeGroup.visible = true;
  }

  // The grid lines give way as the image comes in.
  const under = Math.min(1, 24 / params.grid);
  gridLines.material.opacity = 0.999 * (1 + (under - 1) * ramp(t, TRACE_FAST));

  const key = `${done}`;
  if (key === shownFill) return;
  shownFill = key;
  const filled = new Uint8Array(params.grid * params.grid);
  for (let k = 0; k < done; k++) filled[order[k]!] = 1;
  for (let i = 0; i < filled.length; i++) {
    for (let c = 0; c < 3; c++) pixels[i * 4 + c] = filled[i] ? litImage[i * 3 + c]! : BLANK;
    pixels[i * 4 + 3] = 255;
  }
  screen.update(pixels);
}

// --- The pass slides ---------------------------------------------------------

/** Where a pixel's centre sees the scene, and what each pass draws there. */
interface PassCentre {
  p: THREE.Vector3;
  n: THREE.Vector3;
  twoSided: boolean;
  name: string;
  /** shadow: where the shadow ray stops, or null if it reaches the light. */
  block: THREE.Vector3 | null;
  /** reflection (mirror pixels), refraction (glass pixels): the ray's path on from here, off the mirror and through the glass, to where it lands. */
  path: THREE.Vector3[] | null;
  landName: string | null;
  /** phong (shiny, lit points): the direction to the light reflected about the normal, and the highlight there. */
  R: THREE.Vector3 | null;
  h: number;
}
let passCentres: (PassCentre | null)[] = [];
/** Per pass, its image; per pass, the combination of it and every pass before (sRGB bytes per pixel). */
let passImages: Uint8Array[] = [];
let combined: Uint8Array[] = [];
let thumbs: FilmPanel[] = [];
const thumbLabels = PASSES.map((name, j) =>
  label(name, {
    size: 0.055,
    color: C.bone,
    anchorX: 'center',
    anchorY: 'top',
    opacity: 0.999,
    position: [thumbCenter(j)[0], THUMB.y - THUMB.height / 2 - 0.025, 0],
  }),
);
if (IS_PASS) stage.hud.add(...thumbLabels);
for (const l of thumbLabels) l.visible = false;

const toV = (u: { x: number; y: number; z: number }) => new THREE.Vector3(u.x, u.y, u.z);
const rgba = (img: Uint8Array) => {
  const out = new Uint8ClampedArray((img.length / 3) * 4);
  for (let i = 0; i < img.length / 3; i++) {
    out.set(img.subarray(i * 3, i * 3 + 3), i * 4);
    out[i * 4 + 3] = 255;
  }
  return out;
};

function restartPasses(jump: boolean): void {
  const res = params.grid;
  const n = res * res;
  const scene = buildScene(desc, res, res);
  const agg = scene.aggregate;
  const sampler = new IndependentSampler(0);
  const eyeV = new Vec3(eye.x, eye.y, eye.z);

  // Every pass and every combination, per sample (the same rays for all),
  // averaged in sRGB bytes as the other slides do.
  passImages = PASSES.map(() => new Uint8Array(n * 3));
  combined = PASSES.map(() => new Uint8Array(n * 3));
  const m = PASSES.length;
  const uses = PASSES.map((_, k) => new Set(PASSES.slice(0, k + 1)));
  const ALL_USE = uses[m - 1]!;
  const sums = new Float64Array(2 * m * 3);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      sums.fill(0);
      for (let s = 0; s < SPP; s++) {
        sampler.startPixelSample(pixelSeedKey(x, y, s));
        const ray = cameraSample(scene, [x, y], sampler).ray;
        const hit = agg.intersect(ray);
        if (!hit) {
          for (let k = 0; k < sums.length; k++) sums[k]! += BLANK;
          continue;
        }
        const look = lookAt(hit, eyeV);
        // What the mirror or the glass passes on, with every pass of the run.
        const r = passedOn(ray.d, hit, ALL_USE, 0);
        const own: Pass | null = reflects(hit) ? 'reflection' : isGlass(hit) ? 'refraction' : null;
        const add = (slot: number, rgb: readonly number[]) => {
          for (let ch = 0; ch < 3; ch++) sums[slot * 3 + ch]! += srgbEncode(rgb[ch]!);
        };
        const grey = (x: number) => [x, x, x];
        const value: Record<Pass, readonly number[]> = {
          albedo: look.c,
          brightness: grey(look.b),
          shadow: grey(look.v),
          phong: grey(look.h), // 0 on matte surfaces
          reflection: own === 'reflection' && r ? r : BLACK, // black off the mirror
          refraction: own === 'refraction' && r ? r : BLACK, // black off the glass
        };
        PASSES.forEach((q, k) => {
          add(k, value[q]);
          add(m + k, colourWith(look, uses[k]!, own && uses[k]!.has(own) ? r : null));
        });
      }
      const o = (y * res + x) * 3;
      for (let k = 0; k < m; k++) {
        for (let ch = 0; ch < 3; ch++) {
          passImages[k]![o + ch] = sums[k * 3 + ch]! / SPP;
          combined[k]![o + ch] = sums[(m + k) * 3 + ch]! / SPP;
        }
      }
    }
  }

  // Where each pixel's centre sees the scene, for drawing its rays.
  passCentres = [];
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const ray = scene.camera.generateRay([x + 0.5, y + 0.5]);
      const hit = agg.intersect(ray);
      if (!hit) {
        passCentres.push(null);
        continue;
      }
      const name = nameOf(hit);
      let block: THREE.Vector3 | null = null;
      let path: THREE.Vector3[] | null = null;
      let landName: string | null = null;
      if (pPass === 'shadow' && name !== 'light') {
        const q = occlusionPoint(agg, { p: hit.p, ng: hit.ng }, LAMP_POINT);
        block = q ? toV(q) : null;
      }
      let R: THREE.Vector3 | null = null;
      let h = 0;
      if (pPass === 'phong') {
        const look = lookAt(hit, eyeV);
        h = look.h;
        if (look.ks > 0 && look.b > 0) {
          const nn = shadingNormal(toV(hit.p), toV(hit.ns).normalize(), isTwoSided(name));
          const l = LAMP.clone().sub(toV(hit.p)).normalize();
          R = nn.clone().multiplyScalar(2 * nn.dot(l)).sub(l);
        }
      }
      if ((pPass === 'reflection' && reflects(hit)) || (pPass === 'refraction' && isGlass(hit))) {
        const b = bouncePath(ray.d, hit);
        path = b.pts.map(toV);
        landName = b.landName;
      }
      passCentres.push({ p: toV(hit.p), n: toV(hit.ns).normalize(), twoSided: isTwoSided(name), name, block, path, landName, R, h });
    }
  }

  // The slow rays, picked to show what this pass measures: from each group of
  // pixels, the one nearest the group's middle. Then the rest, raster order
  // (the reflection pass scans everything too, and is black off the mirror).
  const pick = (keep: (c: PassCentre) => boolean): number | null => {
    const group = passCentres.flatMap((c, i) => (c && keep(c) ? [i] : []));
    if (!group.length) return null;
    const mid = group.reduce((m, i) => m.add(passCentres[i]!.p), new THREE.Vector3()).multiplyScalar(1 / group.length);
    return group.reduce((best, i) => (passCentres[i]!.p.distanceTo(mid) < passCentres[best]!.p.distanceTo(mid) ? i : best));
  };
  const ballShape = desc.primitives.find((q) => q.name === 'ball')!.shape;
  if (ballShape.kind !== 'sphere') throw new Error('expected a sphere');
  const top = new THREE.Vector3(...ballShape.center).add(new THREE.Vector3(0.1, 0.9, 0.5).normalize().multiplyScalar(ballShape.radius));
  const ballTop = passCentres.reduce<number | null>(
    (best, c, i) => (c?.name === 'ball' && (best === null || c.p.distanceTo(top) < passCentres[best]!.p.distanceTo(top)) ? i : best),
    null,
  );
  const blockedBy = (c: PassCentre, ball: string) => {
    if (!c.block) return false;
    const s = desc.primitives.find((q) => q.name === ball)!.shape;
    return s.kind === 'sphere' && Math.abs(c.block.distanceTo(new THREE.Vector3(...s.center)) - s.radius) < 1e-3;
  };
  // A pixel in a ball's shadow with a long shadow ray, so it is seen to stop
  // at the ball (near the ball's foot the ray is a stub): the 80th
  // percentile of shadow-ray length among the floor pixels it shadows.
  const longBlocked = (ball: string): number | null => {
    const group = passCentres.flatMap((c, i) => (c && c.name === 'floor' && blockedBy(c, ball) ? [i] : []));
    if (!group.length) return null;
    const len = (i: number) => passCentres[i]!.p.distanceTo(passCentres[i]!.block!);
    group.sort((a, b) => len(a) - len(b));
    return group[Math.floor(0.8 * (group.length - 1))]!;
  };
  const peak = (ball: string) =>
    passCentres.reduce<number | null>((best, c, i) => (c?.name === ball && (best === null || c.h > passCentres[best]!.h) ? i : best), null);
  const slow: (number | null)[] =
    pPass === 'albedo'
      ? [ballTop, pick((c) => c.name === 'left'), pick((c) => c.name === 'floor'), pick((c) => c.name === 'right'), pick((c) => c.name === 'ballBlue')]
      : pPass === 'brightness'
        ? [ballTop, pick((c) => c.name === 'floor'), pick((c) => c.name === 'back'), pick((c) => c.name === 'left'), pick((c) => c.name === 'ballBlue')]
        : pPass === 'shadow'
          ? [ballTop, longBlocked('ball'), pick((c) => c.name === 'floor' && !c.block), longBlocked('ballBlue'), pick((c) => c.name === 'back' && !c.block)]
          : pPass === 'phong'
            ? // the brightest highlight on each ball, the middle of the white ball, and two matte surfaces (no highlight)
              [peak('ball'), pick((c) => c.name === 'ball'), pick((c) => c.name === 'floor'), peak('ballBlue'), pick((c) => c.name === 'back')]
            : pPass === 'reflection'
              ? // mirror pixels, with two that are not the mirror and come back black
                [
                  pick((c) => c.name === MIRROR && c.landName === 'left'),
                  pick((c) => c.name === 'floor'),
                  pick((c) => c.name === MIRROR && c.landName === 'ball'),
                  pick((c) => c.name === 'back'),
                  GREEN_MIRROR > 0 ? pick((c) => c.name === 'right' && c.landName === 'ball') ?? pick((c) => c.name === 'right') : pick((c) => c.name === MIRROR && c.landName === 'floor'),
                ]
              : // refraction: glass pixels that see three different things through it, and two that are not the glass and come back black
                (() => {
                  const through = ['back', 'right', 'floor', 'left', 'ball', 'ceiling']
                    .map((w) => pick((c) => c.name === GLASS && c.landName === w))
                    .filter((i) => i !== null)
                    .slice(0, 3);
                  return [through[0] ?? null, pick((c) => c.name === 'floor'), through[1] ?? null, pick((c) => c.name === 'back'), through[2] ?? null];
                })();
  const walk = [...new Set(slow.filter((i): i is number => i !== null))];
  const scanned = (i: number) => passCentres[i] !== null;
  order = [...walk, ...Array.from({ length: n }, (_, i) => i).filter((i) => scanned(i) && !walk.includes(i))];

  // The row: every pass so far, this one included (it appears when it parks).
  for (const t of thumbs) t.dispose();
  thumbs = PASSES.slice(0, PASS_INDEX + 1).map((_, j) => {
    const panel = new FilmPanel({ width: res, height: res, center: thumbCenter(j), drawnHeight: THUMB.height, border: true, opacity: 0.999 });
    panel.update(rgba(passImages[j]!));
    stage.hud.add(panel.group);
    return panel;
  });

  stage.loop = false; // the finished slide holds
  stage.duration = P_END + HOLD;
  stage.t = jump ? P_END + 0.01 : 0;
}

/** A film panel's opacity, mesh and border together. */
function panelOpacity(panel: FilmPanel, a: number): void {
  panel.group.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (!m) return;
    m.transparent = true;
    m.opacity = 0.999 * a;
  });
  panel.group.visible = a > 0;
}

// The pass slides' extra rays: the shadow ray's stop, the reflected ray and where it lands.
const blockDot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 10), new THREE.MeshBasicMaterial({ color: C.rust, toneMapped: false }));
/** Room for the longest path: three.js keeps a line's segment count from its first draw, so it is made full length and shorter paths are padded. */
const BOUNCE_POINTS = MAX_DEPTH + 2;
const bounce = polyline(Array.from({ length: BOUNCE_POINTS }, (_, i) => [0, 0, i] as [number, number, number]), { color: C.blue, width: 6 }); // blue: the palette's colour for glass and refraction; cream vanished on the walls
const mirrored = polyline([[0, 0, 0], [0, 0, 1]], { color: C.ochreLight, width: 6 }); // phong: the light's direction, reflected
const landDot = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 10), new THREE.MeshBasicMaterial({ color: C.blue, toneMapped: false }));
for (const o of [blockDot, bounce, landDot, mirrored]) {
  (o.material as THREE.Material).depthTest = false;
  // Drawn with the transparent objects, which come after the glass ball's
  // transmission: as opaque lines the glass painted over the path inside it.
  (o.material as THREE.Material).transparent = true;
  o.renderOrder = 6;
  o.visible = false;
  stage.add(o);
}

/** The first share u of a path, by length. */
function partOf(pts: THREE.Vector3[], u: number): THREE.Vector3[] {
  const lens = pts.slice(1).map((q, i) => q.distanceTo(pts[i]!));
  let left = u * lens.reduce((a, b) => a + b, 0);
  const out = [pts[0]!];
  for (let i = 0; i < lens.length; i++) {
    if (left >= lens[i]!) {
      out.push(pts[i + 1]!);
      left -= lens[i]!;
    } else {
      out.push(pts[i]!.clone().lerp(pts[i + 1]!, left / lens[i]!));
      break;
    }
  }
  while (out.length < BOUNCE_POINTS) out.push(out[out.length - 1]!.clone());
  return out;
}

function framePass(t: number): void {
  showCamera(1);
  for (const piece of pieces) piece.shade.value = 0; // the 3D scene keeps its own shading (styleShortBox)
  if (!screen || !pixels || !order.length || !combined.length) return;
  const k = PASS_INDEX;
  const res = params.grid;

  // --- the scan: which ray is out, how far it and this pass's ray have got, how many pixels are filled
  const step = P_STEP[pPass];
  let current: number;
  let reach = 1;
  let probe = 1;
  let arrived = true;
  let done: number;
  if (t < pSlowEnd) {
    current = Math.floor((t - P_SCAN) / step);
    const local = t - P_SCAN - current * step;
    reach = smooth(Math.min(1, local / P_OUT));
    arrived = local >= P_OUT;
    probe = smooth(ramp(local, P_PROBE));
    done = current < 0 ? 0 : current + (local >= P_FILL[pPass] ? 1 : 0);
  } else {
    const u = ramp(t, P_FAST);
    done = TRACE_SLOW + Math.floor((order.length - TRACE_SLOW) * u * u);
    current = Math.min(order.length - 1, done);
  }
  done = Math.min(done, order.length);
  const live = current >= 0 && t >= P_SCAN && t < P_FAST[1]!;
  const centre = live ? passCentres[order[current]!] : null;
  ray.visible = !!centre;
  probeGroup.visible = screenCell.visible = !!centre;
  blockDot.visible = bounce.visible = landDot.visible = mirrored.visible = false;
  if (centre) {
    const i = order[current]!;
    setPolyline(ray, [eye, eye.clone().lerp(centre.p, reach)]);
    placeProbe(centre.p, centre.n, centre.twoSided, i % res, Math.floor(i / res));
    planeCell.visible = true;
    const lamp = centre.name === 'light';
    probeDot.visible = arrived;
    // brightness: the elbow, as trace draws it. The others show their own ray instead.
    const elbow = pPass === 'brightness' && arrived && !lamp;
    probeNormal.visible = probeArrow.visible = wedge.visible = probeToLamp.visible = elbow;
    if (pPass === 'shadow' && !lamp) {
      const from = centre.p.clone().addScaledVector(shadingNormal(centre.p, centre.n, centre.twoSided), 0.01);
      setPolyline(probeToLamp, [from, from.clone().lerp(centre.block ?? lightPoint.position, Math.max(1e-3, probe))]);
      probeToLamp.visible = arrived && probe > 0;
      blockDot.visible = arrived && !!centre.block && probe >= 1;
      if (centre.block) blockDot.position.copy(centre.block);
    }
    if (pPass === 'phong' && centre.R && arrived) {
      // The normal and the line to the light, as brightness draws them; then
      // the light's direction mirrored about the normal, and the angle
      // between it and the way back to the eye. A matte point shows nothing.
      const q = centre.p.clone().addScaledVector(shadingNormal(centre.p, centre.n, centre.twoSided), 0.01);
      const toEye = eye.clone().sub(q).normalize();
      probeNormal.visible = probeArrow.visible = probeToLamp.visible = true;
      setPolyline(mirrored, [q, q.clone().addScaledVector(centre.R, 1.3 * Math.max(1e-3, probe))]);
      mirrored.visible = probe > 0;
      setWedge(q, centre.R, toEye, centre.n);
      wedge.visible = probe >= 1;
    }
    if (centre.path) {
      // The ray on, off the mirror or through the glass, drawn out along its whole path.
      setPolyline(bounce, partOf(centre.path, Math.max(1e-3, probe)));
      bounce.visible = arrived && probe > 0;
      landDot.visible = arrived && probe >= 1 && centre.landName !== null;
      landDot.position.copy(centre.path[centre.path.length - 1]!);
    }
  }

  // --- the row: the passes before this one at home; this one parks; all fly onto the screen and combine
  const screenScale = SCREEN.height / THUMB.height;
  const [sx, sy] = SCREEN.center;
  thumbs.forEach((panel, j) => {
    const [hx, hy] = thumbCenter(j);
    let x = hx;
    let y = hy;
    let scale = 1;
    let opacity = 1;
    if (j === k && t < P_PARK[1]!) {
      // This pass: not there until the scan is done, then shrinks from the screen into its place.
      const u = smooth(ramp(t, P_PARK));
      opacity = t >= P_PARK[0]! ? 1 : 0;
      x = sx + (hx - sx) * u;
      y = sy + (hy - sy) * u;
      scale = screenScale + (1 - screenScale) * u;
    } else if (t >= P_STACK && t < P_HOME[1]!) {
      const start = P_STACK + j * P_STACK_STAGGER;
      const u = smooth(ramp(t, [start, start + P_STACK_EACH]));
      x = hx + (sx - hx) * u;
      y = hy + (sy - hy) * u;
      scale = 1 + (screenScale - 1) * u;
      // Merged into the combined image, then back in the row.
      opacity = t < P_RESULT[1]! ? 1 - ramp(t, P_RESULT) : ramp(t, P_HOME);
      if (t >= P_RESULT[1]!) {
        x = hx;
        y = hy;
        scale = 1;
      }
    }
    panel.group.position.set(x, y, 0.05 + 0.01 * j);
    panel.group.scale.setScalar(scale);
    panelOpacity(panel, opacity);
  });
  thumbLabels.forEach((l, j) => (l.visible = j < k || (j === k && t >= P_PARK[1]!)));

  // --- the screen
  gridLines.material.opacity = res <= 64 ? 0.999 * Math.min(1, 24 / res) : 0;
  const prev = k > 0 ? combined[k - 1]! : null;
  let key: string;
  let fill: (i: number, ch: number) => number;
  if (t < P_CLEAR[1]!) {
    const a = ramp(t, P_CLEAR);
    key = `clear ${Math.round(a * 24)}`;
    fill = (i, ch) => (prev ? prev[i * 3 + ch]! + (BLANK - prev[i * 3 + ch]!) * a : BLANK);
  } else if (t < P_PARK[0]!) {
    const filled = new Uint8Array(res * res);
    for (let m = 0; m < done; m++) filled[order[m]!] = 1;
    key = `scan ${done}`;
    fill = (i, ch) => (filled[i] ? passImages[k]![i * 3 + ch]! : BLANK);
  } else {
    const a = ramp(t, P_RESULT);
    key = `result ${Math.round(a * 24)}`;
    fill = (i, ch) => BLANK + (combined[k]![i * 3 + ch]! - BLANK) * a;
  }
  if (key === shownFill) return;
  shownFill = key;
  for (let i = 0; i < res * res; i++) {
    for (let ch = 0; ch < 3; ch++) pixels[i * 4 + ch] = fill(i, ch);
    pixels[i * 4 + 3] = 255;
  }
  screen.update(pixels);
}

stage.start();
restart();

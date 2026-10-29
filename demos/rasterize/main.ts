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
 * the angle at each point and brighten or darken each pixel). For each pixel
 * a point sits where that pixel's centre sees the scene, with the line back
 * to the eye through the pixel, its normal, the line to the lamp and the
 * angle theta between them; then the pixel takes its shaded colour,
 *
 *     surface colour x (AMBIENT + (1 - AMBIENT) cos theta),
 *
 * theta the angle between the normal (turned toward the eye) and the
 * direction to the centre of the lamp. The first few pixels are hand-picked
 * and slow (top and side of the white ball, back wall, floor); then the rest
 * run in raster order. At the end the 3D scene takes on the same shading.
 * It is a rasterizer's fake, easy to say: no shadows, no light bouncing
 * between surfaces, no falloff with distance, and the ambient floor stands
 * in for all the light that does not come straight from the lamp. The lamp
 * keeps its own colour. Screen and 3D scene use the same formula (CPU and
 * shader). It starts at 24 x 24, not flat's 64, so that one pixel changing
 * can be seen. The point and its lines are drawn over the scene, not
 * hidden by it.
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
import { pixelSeedKey } from '@/core/sampler/sampler';
import { sceneToThree } from '@/viz/three-scene';
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
type Shade = 'flat' | 'light';
const SHADE: Shade = new URLSearchParams(location.search).get('shade') === 'light' ? 'light' : 'flat';
const AMBIENT = 0.2;
/** Projected one at a time, in this order: back to front, a true depth order for this scene. */
const PIECES = ['back', 'left', 'right', 'floor', 'ceiling', 'light', 'ball', 'ballBlue'];
/** The screen, on the HUD, and the 3D view's sideways slide: as scene-and-screen. */
const SCREEN = { center: [-0.85, -0.02] as [number, number], height: 1.15 };
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
const SLOW_START = 1.0;
const SLOW_STEP = 3.2; // each hand-picked pixel: the point and its angle, then the pixel changes
const RECOLOUR = 2.0; // into a slow step, when its pixel changes
const FAST = 10; // the rest of the pixels, raster order
const HOLD = 3;

// --- Stage -----------------------------------------------------------------
const stage = createStage({ position: [0, 2.8, 15.5], target: [0, 1.5, 1.0], fov: 42 });
const ui = createUI(stage);
stage.renderer.localClippingEnabled = true;

const desc = SCENES[SCENE];
const LAMP = (() => {
  const lamp = desc.primitives.find((p) => p.name === 'light')!;
  if (lamp.shape.kind !== 'quad') throw new Error('expected a quad lamp');
  const { q, e1, e2 } = lamp.shape;
  return new THREE.Vector3(...q).addScaledVector(new THREE.Vector3(...e1), 0.5).addScaledVector(new THREE.Vector3(...e2), 0.5);
})();
const COLORS = surfaceColors(desc);

const sceneGroup = sceneToThree(desc);
stage.add(sceneGroup);
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

/** The normal turned toward the eye, as the shading turns it. */
const facingEye = (p: THREE.Vector3, n: THREE.Vector3) => (n.dot(eye.clone().sub(p)) < 0 ? n.clone().negate() : n.clone());

/** A surface point's colour, linear: flat, or lit by its angle to the lamp (see header). */
function shadeAt(name: string, p: THREE.Vector3, n: THREE.Vector3, lit: boolean): [number, number, number] {
  const c = COLORS.get(name)!;
  if (!lit || name === 'light') return [c.r, c.g, c.b];
  const k = AMBIENT + (1 - AMBIENT) * Math.max(0, facingEye(p, n).dot(LAMP.clone().sub(p).normalize()));
  return [c.r * k, c.g * k, c.b * k];
}

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
}
// sceneToThree adds one mesh per primitive, in order.
const pieces: Piece[] = PIECES.map((name) => {
  const i = desc.primitives.findIndex((p) => p.name === name);
  if (i < 0) throw new Error(`no primitive ${name}`);
  const mat = (sceneGroup.children[i] as THREE.Mesh).material as THREE.MeshStandardMaterial;
  const flat = { value: 0 };
  const shade = { value: 0 };
  const c = COLORS.get(name)!;
  const own = {
    uFlat: flat,
    uShade: shade,
    uAlbedo: { value: new THREE.Vector3(c.r, c.g, c.b) },
    uLit: { value: name !== 'light' ? 1 : 0 },
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
        `uniform float uShade; uniform vec3 uAlbedo; uniform float uLit; uniform float uLitAll;
        uniform vec3 uLamp; uniform float uAmb; uniform vec3 uEye; varying vec3 vWorldP; varying vec3 vWorldN;
        void main() {`,
      )
      .replace(
        '#include <tonemapping_fragment>',
        `#include <tonemapping_fragment>
        vec3 nW = normalize( vWorldN );
        if ( dot( nW, uEye - vWorldP ) < 0.0 ) nW = -nW;
        float lit = uAmb + ( 1.0 - uAmb ) * max( 0.0, dot( nW, normalize( uLamp - vWorldP ) ) );
        gl_FragColor.rgb = mix( gl_FragColor.rgb, uAlbedo * mix( 1.0, lit, uLit * uLitAll ), uShade );`,
      );
  };
  mat.needsUpdate = true;
  return { flat, shade };
});

// --- The point being shaded (light) ----------------------------------------
// Where a pixel's centre sees the scene: the point, the line back to the eye
// through the pixel, the normal (bone), the line to the lamp (ochre) and the
// angle between them; and the pixel, outlined on the plane and the screen.
const probeGroup = new THREE.Group();
const probeDot = new THREE.Mesh(
  new THREE.SphereGeometry(0.07, 16, 10),
  new THREE.MeshBasicMaterial({ color: C.bone, toneMapped: false }),
);
const probeToEye = polyline([[0, 0, 0], [0, 0, 1]], { color: C.bone, width: 1.5, opacity: 0.6 });
const probeNormal = polyline([[0, 0, 0], [0, 0, 1]], { color: C.bone, width: 6 });
const probeToLamp = polyline([[0, 0, 0], [0, 0, 1]], { color: C.ochre, width: 4 });
const ARC_STEPS = 24;
const zeros = (n: number) => Array.from({ length: n }, () => [0, 0, 0] as [number, number, number]);
const probeArc = polyline(zeros(ARC_STEPS + 1), { color: C.bone, width: 3 });
const planeCell = polyline(zeros(5), { color: C.ochre, width: 3 });
probeGroup.add(probeDot, probeToEye, probeNormal, probeToLamp, probeArc, planeCell);
// Drawn over the scene: from the viewer's side a wall or the ball would
// otherwise hide half of what is being pointed at.
probeGroup.traverse((o) => {
  if (!(o instanceof THREE.Mesh)) return;
  (o.material as THREE.Material).depthTest = false;
  o.renderOrder = 5;
});
stage.add(probeGroup);
const screenCell = polyline(zeros(5), { color: C.ochre, width: 3 });
const theta = label('θ', { size: 0.1, color: C.bone, anchorX: 'center', anchorY: 'middle' });
stage.hud.add(screenCell, theta);

function placeProbe(p: THREE.Vector3, normal: THREE.Vector3, x: number, y: number): void {
  const n = facingEye(p, normal);
  const q = p.clone().addScaledVector(n, 0.01);
  const l = LAMP.clone().sub(q).normalize();
  probeDot.position.copy(q);
  setPolyline(probeToEye, [q, eye]);
  setPolyline(probeNormal, [q, q.clone().addScaledVector(n, 1.0)]);
  setPolyline(probeToLamp, [q, LAMP]);
  const ARC_R = 0.45;
  const angle = n.angleTo(l);
  const axis = n.clone().cross(l).normalize();
  setPolyline(
    probeArc,
    Array.from({ length: ARC_STEPS + 1 }, (_, i) =>
      q.clone().addScaledVector(n.clone().applyAxisAngle(axis, (angle * i) / ARC_STEPS), ARC_R),
    ),
  );
  const mid = q.clone().addScaledVector(n.clone().applyAxisAngle(axis, angle / 2), ARC_R + 0.2);
  theta.position.set(...toHud(mid), 0);
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

// light starts coarser, so that one pixel changing can be seen.
const params = { grid: SHADE === 'light' ? 24 : 64 };
ui.params.add(params, 'grid', 2, 64, 1).name('film resolution').onChange(restart);

/**
 * Per piece, per pixel: which of the SPP samples it covers (a bitmask), and
 * each sample's colour there, flat and lit (sRGB bytes, at
 * (pixel * SPP + sample) * 3).
 */
let layers: { covers: Uint8Array; flat: Uint8Array; lit: Uint8Array }[] = [];
/** light: the finished flat and lit images (sRGB bytes per pixel), and each pixel centre's surface point. */
let flatImage = new Uint8Array(0);
let litImage = new Uint8Array(0);
let centres: ({ p: THREE.Vector3; n: THREE.Vector3 } | null)[] = [];
/** light: the pixels in the order they are shaded. */
let order: number[] = [];
let slowCount = 0;
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
function composite(landed: number[], which: 'flat' | 'lit', out: Uint8Array | Uint8ClampedArray, stride: number): void {
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

function restart(): void {
  const res = params.grid;
  buildScreen(res);
  shownFill = '';
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
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        for (let s = 0; s < SPP; s++) {
          sampler.startPixelSample(pixelSeedKey(x, y, s));
          const hit = scene.aggregate.intersect(cameraSample(scene, [x, y], sampler).ray);
          if (!hit) continue;
          const i = y * res + x;
          covers[i]! |= 1 << s;
          const o = (i * SPP + s) * 3;
          for (const [out, on] of [[flat, false], [lit, true]] as const) {
            const c = shadeAt(name, v3(hit.p), v3(hit.ns), on);
            out[o] = srgbEncode(c[0]);
            out[o + 1] = srgbEncode(c[1]);
            out[o + 2] = srgbEncode(c[2]);
          }
        }
      }
    }
    return { covers, flat, lit };
  });

  if (SHADE === 'light') {
    const all = PIECES.map(() => 1);
    flatImage = new Uint8Array(res * res * 3);
    litImage = new Uint8Array(res * res * 3);
    composite(all, 'flat', flatImage, 3);
    composite(all, 'lit', litImage, 3);

    // Where each pixel's centre sees the scene.
    const scene = buildScene(desc, res, res);
    const names: (string | null)[] = [];
    centres = [];
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const hit = scene.aggregate.intersect(scene.camera.generateRay([x + 0.5, y + 0.5]));
        centres.push(hit ? { p: v3(hit.p), n: v3(hit.ns).normalize() } : null);
        names.push(hit ? (hit.primitive as unknown as { name: string }).name : null);
      }
    }
    // The slow pixels: the ones whose centres land nearest a few chosen
    // spots, then every other pixel in raster order.
    const ball = desc.primitives.find((q) => q.name === 'ball')!.shape;
    if (ball.kind !== 'sphere') throw new Error('expected a sphere');
    const onBall = (d: [number, number, number]) =>
      new THREE.Vector3(...ball.center).addScaledVector(new THREE.Vector3(...d).normalize(), ball.radius);
    const spots: [string, THREE.Vector3][] = [
      ['ball', onBall([0.1, 0.9, 0.5])], // top of the ball, facing the lamp
      ['ball', onBall([-0.8, -0.2, 0.6])], // its side, facing away
      ['back', new THREE.Vector3(0.4, 2.6, -2)],
      ['floor', new THREE.Vector3(0.0, 0, 0.9)],
    ];
    const slow: number[] = [];
    for (const [name, at] of spots) {
      let best = -1;
      let bestD = Infinity;
      centres.forEach((c, i) => {
        if (!c || names[i] !== name || slow.includes(i)) return;
        const d = c.p.distanceTo(at);
        if (d < bestD) [best, bestD] = [i, d];
      });
      if (best >= 0) slow.push(best);
    }
    slowCount = slow.length;
    order = [...slow, ...Array.from({ length: res * res }, (_, i) => i).filter((i) => !slow.includes(i))];
  }
  stage.duration = SHADE === 'light' ? fastEnd() + 2.3 + HOLD : lastLands + HOLD;
  stage.t = 0;
}

// --- Playback --------------------------------------------------------------
const ramp = (t: number, [a, b]: number[]) => Math.min(1, Math.max(0, (t - a!) / (b! - a!)));
const smooth = (u: number) => u * u * (3 - 2 * u);
const fastStart = () => SLOW_START + slowCount * SLOW_STEP;
const fastEnd = () => fastStart() + FAST;

stage.frame((t) => {
  sceneLabel.position.set(...toHud(sceneTop), 0);
  if (SHADE === 'light') frameLight(t);
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
  probeGroup.visible = screenCell.visible = theta.visible = false;

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
  // Where the flat slide ended: the camera up, the scene in flat colour, the
  // flat image on the screen, which grid lines no longer cover.
  showCamera(1);
  gridLines.material.opacity = 0.999 * Math.min(1, 24 / params.grid);
  for (const piece of pieces) piece.shade.value = 1;
  if (!screen || !pixels || !order.length) return;

  // How many pixels are shaded by t, and which one the point is at.
  let done: number;
  let current: number;
  if (t < fastStart()) {
    const k = Math.floor((t - SLOW_START) / SLOW_STEP);
    current = k;
    done = k < 0 ? 0 : k + (t - SLOW_START - k * SLOW_STEP >= RECOLOUR ? 1 : 0);
  } else {
    const u = ramp(t, [fastStart(), fastEnd()]);
    done = slowCount + Math.floor((order.length - slowCount) * u * u); // eased in, so it picks up speed
    current = Math.min(order.length - 1, Math.max(done - 1, slowCount));
  }
  const pointShown = t >= SLOW_START && t < fastEnd() + 0.3;
  const centre = current >= 0 ? centres[order[current]!] : null;
  probeGroup.visible = screenCell.visible = theta.visible = pointShown && !!centre;
  if (pointShown && centre) {
    const i = order[current]!;
    placeProbe(centre.p, centre.n, i % params.grid, Math.floor(i / params.grid));
  }

  // Once every pixel is done, the 3D scene takes the same shading.
  shared.uLitAll.value = smooth(ramp(t, [fastEnd() + 0.5, fastEnd() + 2.0]));

  const key = `${done}`;
  if (key === shownFill) return;
  shownFill = key;
  const shaded = new Uint8Array(params.grid * params.grid);
  for (let k = 0; k < done; k++) shaded[order[k]!] = 1;
  for (let i = 0; i < shaded.length; i++) {
    const src = shaded[i] ? litImage : flatImage;
    pixels[i * 4] = src[i * 3]!;
    pixels[i * 4 + 1] = src[i * 3 + 1]!;
    pixels[i * 4 + 2] = src[i * 3 + 2]!;
    pixels[i * 4 + 3] = 255;
  }
  screen.update(pixels);
}

stage.start();
restart();

/**
 * The visual identity for the whole talk. Every demo reads its colours and
 * materials from here, so retuning this file restyles the entire deck.
 *
 * The look: black void, natural mineral colours. Slate, moss, ochre, rust,
 * weathered bone — pigments you could dig out of a hillside. They sit at
 * medium saturation and medium value so they stay distinct against black
 * without glowing like neon, and so a projector in a bright room still
 * separates them.
 */

import * as THREE from 'three';

/** Scene background. Black by default — it is a talk about light. */
export const BACKGROUND = 0x000000;

/**
 * The palette.
 *
 * Each hue comes in a base and a `-Deep` variant. Base is the readable
 * "object" colour; Deep is for shadowed faces, fills under a curve, and
 * anything that should recede without disappearing into the background.
 */
export const C = {
  // Cool structural greys — axes, grids, scaffolding, the things that hold
  // the picture together without asking for attention.
  slate: 0x7c8b96,
  slateDeep: 0x3d4750,

  // The cold accent. Water, glass, refraction, incoming rays.
  blue: 0x4c82ad,
  blueDeep: 0x27455f,

  // The organic mid-tone. Surfaces, ground planes, "the object".
  moss: 0x6f8f5c,
  mossDeep: 0x40563a,

  // Warm ochre. Light itself, emission, the sun, highlighted quantities.
  ochre: 0xd4a63f,
  ochreDeep: 0x8a6a22,
  // The bright end, kept SATURATED rather than mixed toward bone: a ray
  // that brightens toward white stops reading as light and starts reading
  // as metal.
  ochreLight: 0xf7d778,

  // The hot accent. Errors, variance, the thing you want the eye to land on.
  rust: 0xb2543a,
  rustDeep: 0x6f3123,

  // Weathered neutrals. Text, labels, key outlines, the "ink" of the diagram.
  bone: 0xd9d1c2,
  ash: 0x9a9287,
} as const;

export type ColorName = keyof typeof C;

/**
 * Cycle order for "N of these, all different" situations — Riemann bars,
 * sample batches, bounce indices. Ordered so neighbours contrast.
 */
export const CYCLE = [C.blue, C.ochre, C.moss, C.rust, C.slate] as const;

/** Pick from the cycle by index, wrapping. */
export function cycle(i: number): number {
  return CYCLE[((i % CYCLE.length) + CYCLE.length) % CYCLE.length]!;
}

/** Blend two hex colours (t = 0 → a, t = 1 → b). */
export function mix(a: number, b: number, t: number): number {
  return new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();
}

/** A hex colour as a CSS string, for DOM overlays and labels. */
export function css(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/**
 * A continuous ramp through the palette, cold → hot. Useful for encoding a
 * scalar (error, density, sample count) as colour.
 */
export function ramp(t: number): number {
  const stops = [C.blueDeep, C.blue, C.moss, C.ochre, C.rust];
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  return mix(stops[i]!, stops[i + 1]!, x - i);
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/** Matte lit surface. The default for solid geometry. */
export function matte(
  color: number,
  extra: THREE.MeshStandardMaterialParameters = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.0, ...extra });
}

/** Slightly glossy — for spheres and anything that should read as a solid body. */
export function glossy(
  color: number,
  extra: THREE.MeshPhysicalMaterialParameters = {},
): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.35,
    metalness: 0.0,
    clearcoat: 0.6,
    clearcoatRoughness: 0.3,
    ...extra,
  });
}

/**
 * Unlit flat colour. Use for anything that must hold an exact palette value
 * regardless of lighting — graphs, axes, bars, 2D diagram elements.
 */
export function flat(
  color: number,
  extra: THREE.MeshBasicMaterialParameters = {},
): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, ...extra });
}

/** Self-luminous. Light sources, emitters, the "hot" object in a scene. */
export function glow(color: number, intensity = 1.6): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 1,
  });
}

/**
 * Translucent surface — for the 2D-function case where bars accumulate
 * visibly underneath the graph.
 */
export function glass(color: number, opacity = 0.32): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.2,
    metalness: 0,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

/**
 * A dark-room three-point rig: key, cool fill, warm rim. Tuned for coloured
 * objects floating in black — enough fill that shadowed sides keep their hue
 * instead of crushing to pure black, and a rim that separates silhouettes
 * from the background.
 */
export function darkRig(scene: THREE.Scene, intensity = 1): THREE.Group {
  const g = new THREE.Group();

  const key = new THREE.DirectionalLight(0xfff4e2, 2.1 * intensity);
  key.position.set(4, 6, 5);
  g.add(key);

  const fill = new THREE.DirectionalLight(0x9fc0dd, 0.55 * intensity);
  fill.position.set(-5, 1, 2);
  g.add(fill);

  const rim = new THREE.DirectionalLight(0xffd9a0, 0.8 * intensity);
  rim.position.set(-2, 3, -6);
  g.add(rim);

  // Keeps unlit faces sitting in their own colour family rather than going flat black.
  g.add(new THREE.AmbientLight(0x40484f, 0.9 * intensity));

  scene.add(g);
  return g;
}

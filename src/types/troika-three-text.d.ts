/**
 * troika-three-text ships .d.ts files but never points `types` at them in its
 * package.json, and the generated ones are wrong anyway — `Text` is declared
 * without extending Mesh, so `.position` and `scene.add()` would not typecheck.
 *
 * This declares the surface we actually use, correctly.
 */
declare module 'troika-three-text' {
  import * as THREE from 'three';

  export class Text extends THREE.Mesh {
    text: string;
    /** URL of a .ttf/.otf/.woff font. Note: .woff2 is not supported. */
    font: string | null;
    fontSize: number;
    fontWeight: number | 'normal' | 'bold';
    color: number | string;
    anchorX: number | 'left' | 'center' | 'right' | string;
    anchorY:
      | number
      | 'top'
      | 'top-baseline'
      | 'top-cap'
      | 'top-ex'
      | 'middle'
      | 'bottom-baseline'
      | 'bottom'
      | string;
    lineHeight: number | 'normal';
    letterSpacing: number;
    maxWidth: number;
    textAlign: 'left' | 'right' | 'center' | 'justify';
    outlineWidth: number | string;
    outlineColor: number | string;
    outlineOpacity: number;
    strokeWidth: number | string;
    strokeColor: number | string;
    fillOpacity: number;
    material: THREE.Material & {
      opacity: number;
      transparent: boolean;
      depthTest: boolean;
      depthWrite: boolean;
    };
    /** Re-lays out the glyphs. Required after changing any text property. */
    sync(callback?: () => void): void;
    dispose(): void;
  }

  export function preloadFont(
    options: { font?: string; characters?: string | string[]; sdfGlyphSize?: number },
    callback: () => void,
  ): void;
}

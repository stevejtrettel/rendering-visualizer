// Two renders of the same scene in ONE frame, revealed by a wipe.
//
// The pair occupies the same rectangle at full size, so the two images are
// pixel-registered: the eye compares the same wall, the same shadow, the
// same caustic, instead of scanning between two smaller panels. Dragging
// the divider is the interaction, and because the divider is just a number
// it animates on the stage clock and exports like anything else.
//
// A shader rather than two clipped quads: clipping planes need
// renderer.localClippingEnabled and interact awkwardly with the HUD's
// separate scene, whereas a `split` uniform is exact, self-contained and
// costs one draw call.
import * as THREE from 'three';
import { C } from './style';
import { createFilmTexture, type FilmTexture } from './film-panel';

export interface WipePanelOptions {
  width: number;
  height: number;
  center?: [number, number];
  drawnHeight?: number;
  /** Divider colour and half-width, in HUD units. */
  dividerColor?: number;
  dividerWidth?: number;
}

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// `split` is in [0,1] across the quad. The divider is drawn in the same
// pass so it cannot drift from the actual seam by a pixel.
const FRAG = /* glsl */ `
  uniform sampler2D mapA;
  uniform sampler2D mapB;
  uniform float split;
  uniform vec3 dividerColor;
  uniform float dividerWidth;
  varying vec2 vUv;
  void main() {
    vec4 a = texture2D(mapA, vUv);
    vec4 b = texture2D(mapB, vUv);
    vec4 c = vUv.x < split ? a : b;
    float d = abs(vUv.x - split);
    float edge = 1.0 - smoothstep(0.0, dividerWidth, d);
    gl_FragColor = vec4(mix(c.rgb, dividerColor, edge), 1.0);
  }
`;

export class WipePanel {
  readonly group = new THREE.Group();
  readonly width: number;
  readonly height: number;
  readonly drawnWidth: number;
  readonly drawnHeight: number;
  private readonly a: FilmTexture;
  private readonly b: FilmTexture;
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;

  constructor(options: WipePanelOptions) {
    const {
      width,
      height,
      center = [0, 0],
      drawnHeight = 1.6,
      dividerColor = C.bone,
      dividerWidth = 0.0016,
    } = options;
    this.width = width;
    this.height = height;
    this.drawnHeight = drawnHeight;
    this.drawnWidth = (drawnHeight * width) / height;

    this.a = createFilmTexture(width, height);
    this.b = createFilmTexture(width, height);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        mapA: { value: this.a.texture },
        mapB: { value: this.b.texture },
        split: { value: 0.5 },
        dividerColor: { value: new THREE.Color(dividerColor) },
        dividerWidth: { value: dividerWidth },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(this.drawnWidth, this.drawnHeight),
      this.material,
    );
    this.group.add(this.mesh);
    this.group.position.set(center[0], center[1], 0);
  }

  /** Left-hand image. */
  updateA(rgba: Uint8ClampedArray): void {
    this.a.upload(rgba);
  }

  /** Right-hand image. */
  updateB(rgba: Uint8ClampedArray): void {
    this.b.upload(rgba);
  }

  /** Divider position across the quad, 0 (all B) to 1 (all A). */
  get split(): number {
    return this.material.uniforms.split!.value as number;
  }

  set split(v: number) {
    this.material.uniforms.split!.value = Math.min(1, Math.max(0, v));
  }

  /**
   * Where the divider sits in HUD x, so a caption can be parked beside it.
   */
  get dividerX(): number {
    return this.group.position.x + (this.split - 0.5) * this.drawnWidth;
  }

  /**
   * Convert a HUD x coordinate to a split value — for dragging. Returns
   * null when the point is outside the panel, so a stray drag elsewhere on
   * the canvas does not yank the divider.
   */
  splitAtHudX(x: number): number | null {
    const local = (x - this.group.position.x) / this.drawnWidth + 0.5;
    return local < -0.05 || local > 1.05 ? null : Math.min(1, Math.max(0, local));
  }

  dispose(): void {
    this.group.removeFromParent();
    this.a.texture.dispose();
    this.b.texture.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

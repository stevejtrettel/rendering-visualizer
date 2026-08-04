// A CPU render, living INSIDE the stage canvas.
//
// This is the piece the talk-visuals stage had no need for: half the figures
// here are images the CPU renderer made, and a DOM <canvas> sitting beside
// the stage would be invisible in every exported PNG and mp4 — the same
// reason labels are canvas geometry rather than DOM text. So a render pane
// is a textured quad, placed in HUD coordinates (y from −1 to +1, x from
// ∓16/9), and it exports with everything else.
//
// Feed it from a RenderSession (one worker, one canvas-shaped image) or a
// WorkerPool (the machine's cores on one image) — both hand back sRGB RGBA8,
// which is exactly what a DataTexture wants.
import * as THREE from 'three';
import { C } from './style';
import { ASPECT } from './stage';

export interface FilmPanelOptions {
  /** Film resolution in pixels — the RGBA arrays must match this. */
  width: number;
  height: number;
  // Placement in HUD coordinates. `height` is the drawn height in HUD units
  // (the full frame is 2 tall); the drawn width follows the film's aspect,
  // so a square film stays square.
  center?: [number, number];
  drawnHeight?: number;
  /** Hairline border, so a dark render still reads as a panel. Default true. */
  border?: boolean;
  borderColor?: number;
  opacity?: number;
}

export class FilmPanel {
  readonly group = new THREE.Group();
  private readonly texture: THREE.DataTexture;
  private readonly pixels: Uint8ClampedArray;
  private readonly mesh: THREE.Mesh;

  constructor(private readonly options: FilmPanelOptions) {
    const {
      width,
      height,
      center = [0, 0],
      drawnHeight = 1.4,
      border = true,
      borderColor = C.slateDeep,
      opacity = 1,
    } = options;

    this.pixels = new Uint8ClampedArray(width * height * 4);
    this.texture = new THREE.DataTexture(this.pixels, width, height, THREE.RGBAFormat);
    // The film arrives already sRGB-encoded from Film.develop(), so the
    // texture must NOT be colour-converted a second time on sampling.
    this.texture.colorSpace = THREE.NoColorSpace;
    // Crisp pixels: at low sample counts the noise IS the subject, and
    // bilinear smoothing quietly denoises the very thing being shown.
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    const drawnWidth = (drawnHeight * width) / height;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(drawnWidth, drawnHeight),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: opacity < 1,
        opacity,
        toneMapped: false, // the film is already developed; ACES would re-grade it
        depthWrite: false,
      }),
    );
    this.group.add(this.mesh);

    if (border) {
      const hw = drawnWidth / 2;
      const hh = drawnHeight / 2;
      const outline = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-hw, -hh, 0), new THREE.Vector3(hw, -hh, 0),
        new THREE.Vector3(hw, hh, 0), new THREE.Vector3(-hw, hh, 0),
        new THREE.Vector3(-hw, -hh, 0),
      ]);
      this.group.add(new THREE.Line(outline, new THREE.LineBasicMaterial({ color: borderColor })));
    }

    this.group.position.set(center[0], center[1], 0);
  }

  /** Widest x a panel may sit at before it leaves the 16:9 frame. */
  static get halfFrameWidth(): number {
    return ASPECT;
  }

  /**
   * Blit a developed frame. Accepts what Film.develop() / the worker
   * protocol / PoolUpdate.frame() all produce: sRGB RGBA8, row 0 at the TOP
   * (raster order), which is flipped here because texture row 0 is the
   * bottom of the quad.
   */
  update(rgba: Uint8ClampedArray): void {
    const { width, height } = this.options;
    const stride = width * 4;
    if (rgba.length !== stride * height) {
      throw new Error(
        `FilmPanel.update: expected ${stride * height} bytes for ${width}x${height}, got ${rgba.length}`,
      );
    }
    for (let y = 0; y < height; y++) {
      const src = y * stride;
      const dst = (height - 1 - y) * stride;
      this.pixels.set(rgba.subarray(src, src + stride), dst);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.texture.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}

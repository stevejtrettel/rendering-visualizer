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

/**
 * A texture that a developed film blits into, with the conventions every
 * render pane needs. Shared with WipePanel, which needs two of them.
 *
 * `upload` takes what Film.develop() / the worker protocol / the pool all
 * produce: sRGB RGBA8 with row 0 at the TOP (raster order), flipped here
 * because texture row 0 is the bottom of a quad.
 */
export interface FilmTexture {
  texture: THREE.DataTexture;
  upload(rgba: Uint8ClampedArray): void;
  /**
   * Blank the film. A panel holds its last upload forever, so a page that
   * re-renders on a control change would keep showing the OLD image until
   * the new one's first pass lands — and where renders run one after the
   * other, the waiting panel would sit there contradicting its own caption.
   */
  clear(): void;
}

export function createFilmTexture(width: number, height: number): FilmTexture {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
  // The film arrives already sRGB-encoded from Film.develop(). Mark it so:
  // three decodes it on sampling and the renderer's sRGB output encodes it
  // once. NoColorSpace (what this was) skips the decode but not the output
  // encode, so every film was gamma-encoded twice and came out washed out.
  texture.colorSpace = THREE.SRGBColorSpace;
  // Crisp pixels: at low sample counts the noise IS the subject, and
  // bilinear smoothing quietly denoises the very thing being shown.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const stride = width * 4;
  return {
    texture,
    upload(rgba) {
      if (rgba.length !== stride * height) {
        throw new Error(
          `film texture: expected ${stride * height} bytes for ${width}x${height}, got ${rgba.length}`,
        );
      }
      for (let y = 0; y < height; y++) {
        const src = y * stride;
        pixels.set(rgba.subarray(src, src + stride), (height - 1 - y) * stride);
      }
      texture.needsUpdate = true;
    },
    clear() {
      pixels.fill(0);
      texture.needsUpdate = true;
    },
  };
}

export class FilmPanel {
  readonly group = new THREE.Group();
  readonly width: number;
  readonly height: number;
  private readonly film: FilmTexture;
  private readonly mesh: THREE.Mesh;

  constructor(private readonly options: FilmPanelOptions) {
    this.width = options.width;
    this.height = options.height;
    const {
      width,
      height,
      center = [0, 0],
      drawnHeight = 1.4,
      border = true,
      borderColor = C.slateDeep,
      opacity = 1,
    } = options;

    this.film = createFilmTexture(width, height);

    const drawnWidth = (drawnHeight * width) / height;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(drawnWidth, drawnHeight),
      new THREE.MeshBasicMaterial({
        map: this.film.texture,
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

  /** Blit a developed frame (sRGB RGBA8, raster order). */
  update(rgba: Uint8ClampedArray): void {
    this.film.upload(rgba);
  }

  /** Blank the panel — nothing rendered here yet. */
  clear(): void {
    this.film.clear();
  }

  dispose(): void {
    this.group.removeFromParent();
    this.film.texture.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}

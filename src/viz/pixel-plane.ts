// A pixelated screen hanging on the camera frustum, whose contents the
// caller owns.
//
// ImagePlaneElement next door does the same placement but drives its texture
// off a GLOBAL sample clock: at time t every cell shows its running mean over
// samples 0..floor(t/dwell). That is exactly right for an image forming all
// at once, and no use to a figure where the cells are in DIFFERENT states —
// some finished, one mid-average, most still empty — with a highlight that
// moves from one to the next.
//
// So this owns no clock at all. `update` takes a developed RGBA buffer, the
// same one a FilmPanel beside it can show, which is what keeps the plane in
// the scene and the big picture at the side from ever disagreeing.
//
// It also draws the cell grid, and that is not decoration: a figure that has
// visited eight cells of sixty-four is otherwise a black square with a few
// coloured dots on it, and nothing on screen says "these are pixels".
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { C } from './style';
import { polyline, setPolyline } from './lines';
import { imagePlaneFrame, type ImagePlaneConfig, type PlaneFrame } from './image-plane';

export interface PixelPlaneOptions {
  camera: ImagePlaneConfig['camera'];
  /** Pinhole -> plane, world units. */
  distance: number;
  res: number;
  opacity?: number;
  /** Draw the cell grid. Default true. */
  grid?: boolean;
  gridColor?: number;
  gridWidth?: number;
  highlightColor?: number;
  highlightWidth?: number;
}

// Grid lines and the highlight sit this far in FRONT of the plane, toward
// the pinhole, so they are never in a z-fight with it.
const PROUD = 0.012;

export class PixelPlane {
  readonly group = new THREE.Group();
  readonly res: number;
  private readonly texture: THREE.DataTexture;
  private readonly pixels: Uint8Array;
  private readonly frame: PlaneFrame;
  private readonly outline: Line2;
  private readonly cell: number;

  constructor(options: PixelPlaneOptions, parent: THREE.Object3D) {
    const {
      camera,
      distance,
      res,
      opacity = 0.94,
      grid = true,
      gridColor = C.slateDeep,
      gridWidth = 1.4,
      highlightColor = C.ochre,
      highlightWidth = 3,
    } = options;
    this.res = res;

    this.pixels = new Uint8Array(res * res * 4);
    this.texture = new THREE.DataTexture(this.pixels, res, res, THREE.RGBAFormat);
    this.texture.magFilter = THREE.NearestFilter; // crisp cells
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;

    const frame = imagePlaneFrame(camera, distance);
    this.frame = frame;
    const { eye, up, center, halfW, halfH } = frame;
    this.cell = (2 * halfW) / res;

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * halfW, 2 * halfH),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false, // rays stay visible passing through
        toneMapped: false,
      }),
    );
    plane.position.copy(center);
    plane.up.copy(up);
    plane.lookAt(eye); // plane normal faces the pinhole
    this.group.add(plane);

    if (grid) {
      for (let i = 0; i <= res; i++) {
        const d = -halfW + i * this.cell;
        this.group.add(
          polyline([this.at(d, -halfH), this.at(d, halfH)], {
            color: gridColor,
            width: gridWidth,
          }),
        );
        this.group.add(
          polyline([this.at(-halfW, d), this.at(halfW, d)], {
            color: gridColor,
            width: gridWidth,
          }),
        );
      }
    }

    // Built once at five points and moved by rewriting them — setPolyline
    // can only replace points in place while the count holds.
    this.outline = polyline(
      new Array(5).fill(null).map(() => this.at(0, 0)),
      { color: highlightColor, width: highlightWidth },
    );
    this.outline.visible = false;
    this.group.add(this.outline);

    parent.add(this.group);
  }

  /** A point in plane coordinates, proud of the plane, in world space. */
  private at(x: number, y: number): [number, number, number] {
    const { center, right, up, forward } = this.frame;
    const p = center
      .clone()
      .addScaledVector(right, x)
      .addScaledVector(up, y)
      .addScaledVector(forward, -PROUD);
    return [p.x, p.y, p.z];
  }

  /** Blit a developed image: sRGB RGBA8, raster order, row 0 at the TOP. */
  update(rgba: Uint8ClampedArray): void {
    const { res } = this;
    if (rgba.length !== res * res * 4) {
      throw new Error(`pixel plane: expected ${res * res * 4} bytes, got ${rgba.length}`);
    }
    // Texture row 0 is the BOTTOM of the plane; raster y grows downward.
    const stride = res * 4;
    for (let y = 0; y < res; y++) {
      this.pixels.set(rgba.subarray(y * stride, y * stride + stride), (res - 1 - y) * stride);
    }
    this.texture.needsUpdate = true;
  }

  /** Outline one cell in raster coordinates, or nothing. */
  highlight(cell: readonly [number, number] | null): void {
    if (!cell) {
      this.outline.visible = false;
      return;
    }
    const { halfW, halfH } = this.frame;
    const x0 = -halfW + cell[0] * this.cell;
    const y0 = halfH - (cell[1] + 1) * this.cell; // raster y grows downward
    const c = this.cell;
    setPolyline(this.outline, [
      this.at(x0, y0),
      this.at(x0 + c, y0),
      this.at(x0 + c, y0 + c),
      this.at(x0, y0 + c),
      this.at(x0, y0),
    ]);
    this.outline.visible = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.texture.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof Line2) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}

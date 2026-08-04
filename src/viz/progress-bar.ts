// A progress bar drawn IN the canvas.
//
// Figures whose content has to be computed before it can be shown — a
// convergence sequence, a pair of them for a comparison — sit there looking
// broken otherwise. DOM would do for a preview, but keeping it in the
// canvas means it obeys the same layout as everything else and shows up if
// you screenshot the waiting state to explain what the page is doing.
import * as THREE from 'three';
import { C } from './style';

export interface ProgressBarOptions {
  center?: [number, number];
  /** Full width and height in HUD units (the frame is 2 tall, ±16/9 wide). */
  width?: number;
  height?: number;
  color?: number;
  trackColor?: number;
}

export class ProgressBar {
  readonly group = new THREE.Group();
  private readonly fill: THREE.Mesh;
  private readonly width: number;

  constructor(options: ProgressBarOptions = {}) {
    const {
      center = [0, 0],
      width = 1.2,
      height = 0.016,
      color = C.ochre,
      trackColor = C.slateDeep,
    } = options;
    this.width = width;

    const track = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ color: trackColor }),
    );
    this.group.add(track);

    // Unit-width quad anchored at the left edge, scaled in x — so setting
    // progress is one number and never rebuilds geometry.
    const geo = new THREE.PlaneGeometry(1, height);
    geo.translate(0.5, 0, 0);
    this.fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
    this.fill.position.set(-width / 2, 0, 0.001);
    this.fill.scale.x = 0;
    this.group.add(this.fill);

    this.group.position.set(center[0], center[1], 0);
  }

  /** Progress in [0, 1]. */
  set(fraction: number): void {
    this.fill.scale.x = Math.min(1, Math.max(0, fraction)) * this.width;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}

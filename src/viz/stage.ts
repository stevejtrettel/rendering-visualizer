/**
 * The stage: renderer, camera, controls, and the animation clock.
 *
 * Two decisions here matter, and everything else is convenience.
 *
 * 1. The canvas holds a locked 16:9 box, letterboxed in the window. What you
 *    frame while fiddling is exactly what lands in Keynote — the export never
 *    reframes on you.
 *
 * 2. Demos animate off an explicit `t` handed to them, never `performance.now()`.
 *    That is what makes frame-stepped export exact: the exporter can set t to
 *    any value, take as long as it likes to render, and still get a perfectly
 *    even sequence. Reach for wallclock inside a demo and video export silently
 *    starts stuttering.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BACKGROUND, darkRig } from './style';
import { setLineResolution } from './lines';

export interface StageOptions {
  /** 'persp' for 3D scenes, 'ortho' for flat 2D diagrams. Default 'persp'. */
  camera?: 'persp' | 'ortho';
  /** Camera position (perspective). Default [0, 2.5, 7]. */
  position?: [number, number, number];
  /** Orbit target. Default [0, 0, 0]. */
  target?: [number, number, number];
  /** Half-height of the view in world units (orthographic). Default 3. */
  orthoHeight?: number;
  /** Vertical field of view in degrees (perspective). Default 40. */
  fov?: number;
  /** Add the standard dark three-point rig. Default true. */
  lights?: boolean;
  /** Allow mouse orbiting. Default true; set false for locked 2D diagrams. */
  controls?: boolean;
  /** Scene background. Default black. */
  background?: number;
}

/** Fixed export resolution. 16:9 throughout, so preview and export agree. */
export const EXPORT_W = 1920;
export const EXPORT_H = 1080;
export const ASPECT = EXPORT_W / EXPORT_H;

export type FrameFn = (t: number, dt: number) => void;

export class Stage {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls?: OrbitControls;
  readonly canvas: HTMLCanvasElement;

  /** Current animation time in seconds. Demos should read this, not the clock. */
  t = 0;
  /** Playback speed multiplier; 0 pauses. */
  speed = 1;
  /** Loop period in seconds. Set this so exported video loops seamlessly. */
  duration = 8;
  /** When true, t wraps at `duration` instead of running forever. */
  loop = true;

  private frameFns: FrameFn[] = [];
  private readyFns: Array<() => Promise<void> | void> = [];
  private captureFns: Array<() => Promise<void> | void> = [];
  private renderFn: (() => void) | null = null;
  private _hud?: THREE.Scene;
  private _hudCamera?: THREE.OrthographicCamera;
  private orthoHeight: number;
  private running = false;
  private lastWall = 0;
  private resizeObs?: ResizeObserver;

  constructor(opts: StageOptions = {}) {
    const {
      camera = 'persp',
      position = [0, 2.5, 7],
      target = [0, 0, 0],
      orthoHeight = 3,
      fov = 40,
      lights = true,
      controls = true,
      background = BACKGROUND,
    } = opts;

    this.orthoHeight = orthoHeight;
    this.scene.background = new THREE.Color(background);

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'stage';
    document.body.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      // NOT preserveDrawingBuffer. It is a severe frame-rate hit on macOS
      // ANGLE/Metal (banked in design-viz, 2026-08-02) and it taxes every
      // frame of every page to serve export alone. Capture instead reads
      // the canvas back in the SAME task as the render, before the browser
      // composites and clears it — see viz/capture.ts.
      preserveDrawingBuffer: false,
    });
    this.renderer.setClearColor(background, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    if (camera === 'ortho') {
      const h = orthoHeight;
      this.camera = new THREE.OrthographicCamera(-h * ASPECT, h * ASPECT, h, -h, -1000, 1000);
      this.camera.position.set(...(opts.position ?? [0, 0, 10]));
    } else {
      this.camera = new THREE.PerspectiveCamera(fov, ASPECT, 0.01, 2000);
      this.camera.position.set(...position);
    }
    this.camera.lookAt(...target);

    if (controls) {
      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.target.set(...target);
      this.controls.update();
    }

    if (lights) darkRig(this.scene);

    // Line2 converts pixel widths to clip space through this resolution. Since
    // the stage is always 16:9, pinning it to the export size means a width of
    // 4 always covers the same fraction of the frame — the same weight in a
    // small preview window, a maximised one, and the rendered movie.
    setLineResolution(EXPORT_W, EXPORT_H);

    this.resize();
    // Handy from the devtools console: __stage.t = 3, __stage.camera.position, …
    (window as any).__stage = this;
    window.addEventListener('resize', () => this.resize());
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(document.body);
  }

  /** Register a per-frame callback. Called with (t, dt) in seconds. */
  frame(fn: FrameFn): this {
    this.frameFns.push(fn);
    return this;
  }

  /**
   * Register asynchronous preparation the EXPORTER must wait for.
   *
   * Setting `speed = 0` holds the live preview, but it does NOT hold an
   * export: the exporter drives `setTime` directly and never consults
   * speed. So a demo whose frames depend on work that is still running —
   * a convergence sequence being traced, an asset being fetched — must say
   * so here, or pressing V mid-preparation captures whatever happened to
   * be on screen at the time.
   */
  onReady(fn: () => Promise<void> | void): this {
    this.readyFns.push(fn);
    return this;
  }

  /** Resolves once every onReady() registration has finished. */
  async settled(): Promise<void> {
    for (const fn of this.readyFns) await fn();
  }

  /**
   * Register work the exporter must await BEFORE EVERY FRAME, once the
   * clock has been set but before the pixels are read.
   *
   * onReady is once, for preparation. This is per frame, for a figure whose
   * frame cannot be drawn in one call — a path tracer accumulating samples
   * being the case it was added for. Live playback ignores these: nothing
   * that takes seconds per frame belongs in a preview.
   */
  beforeCapture(fn: () => Promise<void> | void): this {
    this.captureFns.push(fn);
    return this;
  }

  /** Awaited by the exporter before reading each frame. */
  async captureReady(): Promise<void> {
    for (const fn of this.captureFns) await fn();
  }

  /**
   * Replace what draws the main scene — a path tracer presenting its
   * accumulated buffer, say. The HUD is still drawn on top afterwards, so
   * captions and panels survive whatever the override does.
   */
  renderWith(fn: (() => void) | null): this {
    this.renderFn = fn;
    return this;
  }

  /** Shorthand for scene.add. */
  add(...objs: THREE.Object3D[]): this {
    this.scene.add(...objs);
    return this;
  }

  /**
   * Fit the 16:9 stage inside the window, letterboxed. The drawing buffer
   * matches the CSS box times devicePixelRatio, so the preview is crisp.
   */
  private resize(): void {
    const pad = 0;
    const availW = window.innerWidth - pad;
    const availH = window.innerHeight - pad;
    let w = availW;
    let h = w / ASPECT;
    if (h > availH) {
      h = availH;
      w = h * ASPECT;
    }
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.style.left = `${(window.innerWidth - w) / 2}px`;
    this.canvas.style.top = `${(window.innerHeight - h) / 2}px`;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    // Aspect is locked at 16:9, so the camera never needs adjusting on resize.
  }

  /**
   * Slide the rendered image sideways inside the frame without moving the
   * camera — an off-axis frustum, so nothing skews and orbiting still works.
   *
   * `fraction` is a share of the frame width; positive moves the subject
   * LEFT, which is how a two-up figure frees the right third for a
   * FilmPanel. Translating the scene instead looks right only from head-on:
   * move a Cornell box sideways and you end up viewing it through its own
   * side wall.
   */
  shiftView(fraction: number): this {
    if (fraction === 0) this.camera.clearViewOffset();
    else this.camera.setViewOffset(EXPORT_W, EXPORT_H, fraction * EXPORT_W, 0, EXPORT_W, EXPORT_H);
    return this;
  }

  /** Advance the demo to an exact time and redraw. Used by the exporter. */
  setTime(t: number): void {
    const dt = t - this.t;
    this.t = t;
    for (const fn of this.frameFns) fn(t, dt);
    this.render();
  }

  /**
   * A flat overlay drawn on top of the 3D scene, in fixed screen coordinates:
   * y runs −1 (bottom) to +1 (top), x runs ∓16/9. Put readouts and titles here
   * — in a 3D scene, world-space text swings around with the camera and
   * changes size with distance, which is unreadable in a talk.
   *
   * Created on first access, so demos that never use it pay nothing.
   */
  get hud(): THREE.Scene {
    if (!this._hud) {
      this._hud = new THREE.Scene();
      this._hudCamera = new THREE.OrthographicCamera(-ASPECT, ASPECT, 1, -1, -100, 100);
      this._hudCamera.position.z = 10;
    }
    return this._hud;
  }

  render(): void {
    if (this.renderFn) this.renderFn();
    else this.renderer.render(this.scene, this.camera);
    if (this._hud && this._hudCamera) {
      // Draw the overlay without wiping the 3D image underneath it.
      const prevAutoClear = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this._hud, this._hudCamera);
      this.renderer.autoClear = prevAutoClear;
    }
  }

  /** Start the live preview loop. */
  start(): this {
    if (this.running) return this;
    this.running = true;
    this.lastWall = performance.now();
    const tick = () => {
      if (!this.running) return;
      requestAnimationFrame(tick);
      const now = performance.now();
      // Clamp so a stall (tab switch, shader compile) does not jump the demo.
      const wallDt = Math.min((now - this.lastWall) / 1000, 1 / 15);
      this.lastWall = now;

      const dt = wallDt * this.speed;
      this.t += dt;
      if (this.loop && this.duration > 0 && this.t > this.duration) this.t %= this.duration;

      this.controls?.update();
      for (const fn of this.frameFns) fn(this.t, dt);
      this.render();
    };
    requestAnimationFrame(tick);
    return this;
  }

  stop(): void {
    this.running = false;
  }

  /**
   * Temporarily render at full export resolution, run `fn`, then restore.
   * Used by the capture code so exports are 1920×1080 regardless of window size.
   */
  async atExportSize<T>(fn: () => Promise<T>): Promise<T> {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const pr = this.renderer.getPixelRatio();
    const { width, height } = { width: this.canvas.style.width, height: this.canvas.style.height };

    this.renderer.setPixelRatio(1);
    this.renderer.setSize(EXPORT_W, EXPORT_H, false);
    try {
      return await fn();
    } finally {
      this.renderer.setPixelRatio(pr);
      this.renderer.setSize(size.x, size.y, false);
      this.canvas.style.width = width;
      this.canvas.style.height = height;
      this.render();
    }
  }

  dispose(): void {
    this.stop();
    this.resizeObs?.disconnect();
    this.controls?.dispose();
    this.renderer.dispose();
  }
}

/** Create and start a stage in one call. */
export function createStage(opts: StageOptions = {}): Stage {
  return new Stage(opts);
}

// One canvas, one integrator, rendering until it reaches a sample target.
//
// Eight pages hand-rolled this: spawn a worker, post init, post the first
// pass, and in onmessage blit the frame, update a caption, and post the
// next pass. It is the single-worker counterpart to WorkerPool — reach for
// the pool when a figure wants the machine's cores on one image, and for
// this when a figure wants several images side by side (which is most of
// them: comparison panes are the house style).
import type { SceneDescription } from '../core/scene/scene';
import type { IntegratorName, MainToWorker, PassDoneMessage } from './protocol';

export interface RenderStatus {
  spp: number; // MMLT: mutations per pixel
  msPerPass: number; // running average
  totalMillis: number;
  done: boolean;
  // The developed frame, sRGB RGBA8. Hand it straight to a FilmPanel so the
  // render lands inside the exportable canvas rather than in a DOM element
  // beside it.
  rgba: Uint8ClampedArray;
  errorRgba: Uint8ClampedArray;
}

export interface RenderSessionOptions {
  // Optional: blit into this canvas as passes land. Omit it for the usual
  // talk case, where a FilmPanel fed from onUpdate puts the image inside the
  // stage (DOM canvases do not appear in exported PNGs or video).
  canvas?: HTMLCanvasElement;
  description: SceneDescription;
  integrator: IntegratorName;
  width: number;
  height: number;
  targetSpp: number;
  seed?: number;
  maxDepth?: number;
  // Which frame to blit: the image, or the false-color relative-standard-
  // error view. Switchable at any time; takes effect on the next pass.
  view?: 'image' | 'error';
  onUpdate?: (status: RenderStatus) => void;
}

export class RenderSession {
  private readonly worker: Worker;
  private readonly ctx: CanvasRenderingContext2D | null = null;
  private opts: RenderSessionOptions;
  private totalMillis = 0;
  private spp = 0;
  private stopped = false;
  view: 'image' | 'error';

  constructor(options: RenderSessionOptions) {
    this.opts = options;
    this.view = options.view ?? 'image';
    if (options.canvas) {
      options.canvas.width = options.width;
      options.canvas.height = options.height;
      this.ctx = options.canvas.getContext('2d');
    }
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<PassDoneMessage>) => this.onPass(e.data);
    this.start(options.description);
  }

  private post(m: MainToWorker): void {
    this.worker.postMessage(m);
  }

  private start(description: SceneDescription): void {
    const { width, height, integrator, seed, maxDepth } = this.opts;
    this.post({
      type: 'init',
      description,
      width,
      height,
      seed: seed ?? 0,
      integrator,
      ...(maxDepth !== undefined ? { maxDepth } : {}),
    });
    this.post({ type: 'pass', sampleIndex: 0 });
  }

  private onPass(msg: PassDoneMessage): void {
    if (this.stopped) return;
    const rgba = this.view === 'error' ? msg.errorRgba : msg.rgba;
    this.ctx?.putImageData(new ImageData(rgba, this.opts.width, this.opts.height), 0, 0);

    this.totalMillis += msg.passMillis;
    this.spp = msg.samplesPerPixel;
    const done = this.spp >= this.opts.targetSpp;
    this.opts.onUpdate?.({
      spp: this.spp,
      msPerPass: this.totalMillis / this.spp,
      totalMillis: this.totalMillis,
      done,
      rgba: msg.rgba,
      errorRgba: msg.errorRgba,
    });
    if (!done) this.post({ type: 'pass', sampleIndex: this.spp });
  }

  // Re-render from scratch, optionally with a different scene or
  // integrator. Any in-flight pass is discarded by the counter reset.
  restart(
    description: SceneDescription = this.opts.description,
    overrides: Partial<Pick<RenderSessionOptions, 'integrator' | 'targetSpp' | 'maxDepth'>> = {},
  ): void {
    this.opts = { ...this.opts, description, ...overrides };
    this.totalMillis = 0;
    this.spp = 0;
    this.stopped = false;
    this.start(description);
  }

  // Stop scheduling passes; the worker stays alive for a later restart().
  stop(): void {
    this.stopped = true;
  }

  dispose(): void {
    this.stopped = true;
    this.worker.terminate();
  }
}

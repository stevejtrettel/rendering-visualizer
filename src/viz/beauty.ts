// Path-traced frames, for export.
//
// The exporter already steps `t` and waits arbitrarily long per frame — that
// was the point of frame-stepping rather than screen-recording — so a frame
// that takes thirty seconds to converge is no harder than one that takes a
// millisecond. This is what fills that time: three-gpu-pathtracer
// accumulating samples on the same scene the preview shows.
//
// Two findings from the 2026-08-02 beauty test shape it (design-viz):
//
//   - The package has NO next-event estimation for emissive meshes. Its
//     direct sampling covers registered lights only, so an emissive quad
//     converges by blind BSDF hits alone. sceneToBeautyThree already swaps
//     quad emitters for RectAreaLights, which ARE sampled — that is why
//     this scene converges fast and a glowing-tube scene would not.
//   - Path COUNT is nearly free (geometry goes into a BVH); unsampled light
//     is what does not scale. Tubes are matte MeshStandardMaterial, lit by
//     the lamp, rather than emitters in their own right.
import * as THREE from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import type { SceneDescription } from '../core/scene/scene';
import { sceneToBeautyThree } from './three-scene';

export interface BeautyOptions {
  /** Bounces the tracer follows. */
  bounces?: number;
  /**
   * Samples accumulated before a frame is considered done. The whole cost
   * of an export is this times the frame count.
   */
  samplesPerFrame?: number;
  /**
   * Fraction of the canvas resolution to trace at, 1 = full. Halving this
   * quarters the work, and 1080p is a lot of pixels to path trace.
   */
  renderScale?: number;
  /** Softens fireflies off glossy lobes; 0 disables. */
  filterGlossyFactor?: number;
}

/**
 * A path-traced view of one scene description plus whatever extra geometry
 * the figure draws into it (the ray tubes).
 *
 * The extra geometry is expected to CHANGE between frames, so `setScene` is
 * re-run each time — the BVH rebuild is milliseconds at these triangle
 * counts, and sample accumulation dominates by orders of magnitude.
 */
export class BeautyPass {
  readonly scene = new THREE.Scene();
  private readonly tracer: WebGLPathTracer;
  private readonly options: { bounces: number; samplesPerFrame: number; renderScale: number; filterGlossyFactor: number };
  private extras: THREE.Object3D | null = null;
  private content: THREE.Group | null = null;
  private description: SceneDescription | null = null;
  private synced = false;

  // `isCompiling` is a real getter on WebGLPathTracer but is missing from
  // the package's .d.ts, so it has to be reached for explicitly.
  private get internals(): { isCompiling: boolean } {
    return this.tracer as unknown as { isCompiling: boolean };
  }

  constructor(
    renderer: THREE.WebGLRenderer,
    private readonly camera: THREE.Camera,
    options: BeautyOptions = {},
  ) {
    this.options = {
      bounces: options.bounces ?? 8,
      samplesPerFrame: options.samplesPerFrame ?? 256,
      renderScale: options.renderScale ?? 1,
      filterGlossyFactor: options.filterGlossyFactor ?? 0.5,
    };
    this.scene.background = new THREE.Color(0x000000);
    this.tracer = new WebGLPathTracer(renderer);
    this.tracer.bounces = this.options.bounces;
    this.tracer.filterGlossyFactor = this.options.filterGlossyFactor;
    this.tracer.renderScale = this.options.renderScale;

    // The defaults are tuned for an interactive viewer and are wrong for a
    // frame-stepped export: it waits `renderDelay` ms before tracing at
    // all, rasterises until `minSamples`, and CROSS-FADES from the raster
    // image to the traced one over `fadeDuration`. Any of those would put a
    // part-rasterised frame on disk. Off, all three.
    this.tracer.renderDelay = 0;
    this.tracer.minSamples = 0;
    this.tracer.fadeDuration = 0;

    // On by default (FEATURE_MIS: 1), set anyway so the figure does not
    // depend silently on a package default. Without it, light sampling and
    // BSDF sampling stop being combined and the RectAreaLight stops paying
    // for itself on glossy surfaces.
    this.tracer.multipleImportanceSampling = true;
  }

  /** Change the sample target without rebuilding the tracer. */
  setSampleTarget(n: number): void {
    this.options.samplesPerFrame = n;
  }

  /** Samples accumulated into the current frame. */
  get samples(): number {
    return this.tracer.samples;
  }

  get target(): number {
    return this.options.samplesPerFrame;
  }

  /**
   * Point the tracer at a scene. MUST be called before anything is drawn:
   * WebGLPathTracer's constructor seeds itself with an EMPTY scene, so a
   * tracer that has never been synced renders solid black.
   *
   * `extras` (the ray tubes) is reparented rather than copied, so the trace
   * shows the same object the preview draws and the two cannot drift.
   * Re-running this rebuilds the BVH and resets accumulation, which is
   * exactly right when the geometry has changed.
   */
  sync(description: SceneDescription, extras: THREE.Object3D | null): void {
    if (description !== this.description) {
      this.description = description;
      if (this.content) {
        this.scene.remove(this.content);
        disposeTree(this.content);
      }
      this.content = sceneToBeautyThree(description);
      this.scene.add(this.content);
    }
    if (this.extras && this.extras !== extras) this.scene.remove(this.extras);
    this.extras = extras;
    if (extras) this.scene.add(extras);
    this.tracer.setScene(this.scene, this.camera);
    this.synced = true;
  }

  /** True once sync() has run — before that, drawing gives black. */
  get ready(): boolean {
    return this.synced;
  }

  /** Still building shaders. The tracer rasterises until this clears. */
  get compiling(): boolean {
    return this.internals.isCompiling;
  }

  /** Accumulate one sample and present. The live-preview step. */
  renderSample(): void {
    if (!this.synced) return;
    this.tracer.renderSample();
  }

  /** Re-aim after the camera moved. */
  updateCamera(): void {
    if (this.synced) this.tracer.updateCamera();
  }

  /**
   * Accumulate a whole frame, yielding between samples so the page stays
   * alive and progress can be reported. Resolves when the sample target is
   * reached — this is the call that takes seconds.
   */
  async renderFrame(onProgress?: (samples: number, target: number) => void): Promise<void> {
    if (!this.synced) throw new Error('BeautyPass.renderFrame before sync()');
    const target = this.options.samplesPerFrame;
    // Shader compilation takes tens of seconds on first run and the tracer
    // rasterises meanwhile; counting those as samples would write a
    // half-raster frame.
    while (this.internals.isCompiling) {
      this.tracer.renderSample();
      await new Promise((r) => requestAnimationFrame(r));
    }
    while (this.tracer.samples < target) {
      this.tracer.renderSample();
      onProgress?.(this.tracer.samples, target);
      // Yield: without this the whole export is one unbroken task and the
      // tab is unresponsive until it finishes.
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  /**
   * Present the accumulated result. Cheap — one more sample and a blit —
   * and needed because without preserveDrawingBuffer the canvas is cleared
   * whenever the loop above yields.
   */
  present(): void {
    if (this.synced) this.tracer.renderSample();
  }

  dispose(): void {
    if (this.content) disposeTree(this.content);
    this.tracer.dispose?.();
  }
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const m = mesh.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose());
    else m?.dispose();
  });
}

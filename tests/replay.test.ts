// Stage 4 of docs/design-cleanup.md: the demo-facing conveniences.
//
// Only the DOM-free half is testable here — the stage, the UI and the render
// session are exercised by demos/hello-stage. What IS testable is the property
// the whole replay story rests on: re-tracing a seed key reproduces the path
// exactly, so a figure and its animation can show literally the same path.
import { describe, expect, it } from 'vitest';
import { buildScene, type SceneDescription } from '../src/core/scene/scene';
import { IndependentSampler } from '../src/core/sampler/independent';
import { NEEPathTracer } from '../src/core/integrators/pt-nee';
import { tracePath, tracePaths } from '../src/trace/replay';

const BOX: SceneDescription = {
  camera: { eye: [0, 2, 7.2], lookAt: [0, 2, 0], up: [0, 1, 0], fovDegrees: 40 },
  primitives: [
    { name: 'floor', shape: { kind: 'quad', q: [-2, 0, -2], e1: [0, 0, 4], e2: [4, 0, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'ceiling', shape: { kind: 'quad', q: [-2, 4, -2], e1: [4, 0, 0], e2: [0, 0, 4] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'back', shape: { kind: 'quad', q: [-2, 0, -2], e1: [4, 0, 0], e2: [0, 4, 0] }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
    { name: 'light', shape: { kind: 'quad', q: [-0.8, 3.998, -0.8], e1: [1.6, 0, 0], e2: [0, 0, 1.6] }, material: { kind: 'lambert', albedo: [0, 0, 0] }, emission: { radiance: [14, 14, 14] } },
    { name: 'ball', shape: { kind: 'sphere', center: [-0.9, 0.8, -0.6], radius: 0.8 }, material: { kind: 'lambert', albedo: [0.73, 0.73, 0.73] } },
  ],
};

const scene = buildScene(BOX, 64, 64);
const integrator = () => new NEEPathTracer({ maxBounces: 5 });
const PIXEL = [30, 40] as const;

describe('tracePath', () => {
  it('replays the identical path from the same key', () => {
    const a = tracePath(scene, integrator(), PIXEL, 7);
    const b = tracePath(scene, integrator(), PIXEL, 7);
    expect(a.vertices.length).toBeGreaterThan(1);
    expect(b.vertices).toEqual(a.vertices);
    expect(b.contributions).toEqual(a.contributions);
    expect(b.shadowRays).toEqual(a.shadowRays);
  });

  it('is independent of the sampler instance and of what it traced before', () => {
    const shared = new IndependentSampler(0);
    const warmup = tracePath(scene, integrator(), [1, 1], 3, { sampler: shared });
    expect(warmup.vertices.length).toBeGreaterThan(0);
    // Same key, but this sampler has already been driven through another
    // pixel — startPixelSample must wipe that out completely.
    const after = tracePath(scene, integrator(), PIXEL, 7, { sampler: shared });
    expect(after.vertices).toEqual(tracePath(scene, integrator(), PIXEL, 7).vertices);
  });

  it('different sample indices give different paths', () => {
    const a = tracePath(scene, integrator(), PIXEL, 0);
    const b = tracePath(scene, integrator(), PIXEL, 1);
    expect(b.vertices).not.toEqual(a.vertices);
  });

  it('tracePaths returns one record per index, matching tracePath', () => {
    const many = tracePaths(scene, integrator(), PIXEL, [0, 1, 2, 3]);
    expect(many).toHaveLength(4);
    many.forEach((record, i) => {
      expect(record.vertices).toEqual(tracePath(scene, integrator(), PIXEL, i).vertices);
    });
  });
});

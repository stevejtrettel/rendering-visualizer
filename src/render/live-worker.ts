// The worker half of LiveRender (live.ts): render whole passes of one path
// per pixel, but post the result back in small chunks of pixels, in a fixed
// scattered order, so the picture fills in as speckle from the first frame
// instead of waiting for a whole pass. A new epoch (a restart) is picked up
// between chunks.
import { buildScene, type SceneDescription } from '../core/scene/scene';
import { NEEPathTracer } from '../core/integrators/pt-nee';
import { UnidirectionalPT } from '../core/integrators/pt';
import { IndependentSampler } from '../core/sampler/independent';
import { pixelSeedKey } from '../core/sampler/sampler';
import { NULL_RECORDER } from '../trace/recorder';
import type { Integrator } from '../core/integrators/types';
import { scatteredOrder, type LiveStart, type LiveChunk } from './live-protocol';

let job: LiveStart | null = null;
let running = false;

self.onmessage = (e: MessageEvent<LiveStart>) => {
  job = e.data;
  if (!running) void loop();
};

const tracerFor = (name: LiveStart['tracer'], maxBounces: number): Integrator =>
  name === 'nee'
    ? new NEEPathTracer({ maxBounces, rrStartDepth: 99 })
    : new UnidirectionalPT({ maxBounces, rrStartDepth: 99, sampleNEE: false });

async function loop(): Promise<void> {
  running = true;
  while (job) {
    const current = job;
    const { epoch, res, worker, workers, chunk, maxSpp } = current;
    const scene = buildScene(current.description as SceneDescription, res, res);
    const integrator = tracerFor(current.tracer, current.maxBounces);
    const sampler = new IndependentSampler(0);
    const order = scatteredOrder(res);
    let stale = false;
    for (let pass = worker; pass < maxSpp && !stale; pass += workers) {
      for (let start = 0; start < order.length; start += chunk) {
        const end = Math.min(order.length, start + chunk);
        const sums = new Float32Array((end - start) * 3);
        for (let t = start; t < end; t++) {
          const i = order[t]!;
          const x = i % res;
          const y = (i - x) / res;
          sampler.startPixelSample(pixelSeedKey(x, y, pass));
          for (const c of integrator.sampleContributions([x, y], sampler, scene, NULL_RECORDER)) {
            if (c.kind !== 'sample') continue;
            sums[(t - start) * 3]! += c.value.r;
            sums[(t - start) * 3 + 1]! += c.value.g;
            sums[(t - start) * 3 + 2]! += c.value.b;
          }
        }
        const message: LiveChunk = { epoch, pass, start, end, sums };
        (self as unknown as Worker).postMessage(message, [sums.buffer]);
        // Let a restart in.
        await new Promise((r) => setTimeout(r, 0));
        if (job !== current) {
          stale = true;
          break;
        }
      }
    }
    if (job === current) job = null; // finished: wait for the next start
  }
  running = false;
}

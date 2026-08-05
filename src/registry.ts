/**
 * Demo discovery for the gallery.
 *
 * Folders under demos/ are found automatically — drop in a new
 * demos/<name>/main.ts and it appears on the index page with no bookkeeping.
 * There is no per-demo index.html and no build-config entry; that is the
 * point (the pre-rebuild set in legacy/ carried 21 hand-written HTML files
 * and a hand-maintained gallery between them).
 *
 * The INFO table below is optional polish: a nicer title, a one-line blurb,
 * and the act of the talk it belongs to. Anything missing falls back to a
 * prettified folder name.
 */

export interface DemoInfo {
  title?: string;
  blurb?: string;
  /** Gallery grouping — the act of the talk this figure belongs to. */
  section?: string;
}

/** Optional metadata, keyed by folder name. */
export const INFO: Record<string, DemoInfo> = {
  convergence: {
    title: 'Convergence',
    blurb:
      'Noise falling away as samples accumulate, 1 spp to 256. Paced by doublings, so it dwells where the picture is still changing.',
    section: 'Act 0 — the renderer',
  },
  'convergence-split': {
    title: 'Convergence — side by side',
    blurb:
      'Two tracers on one scene, converging in step. Held level by sample count, or by wall-clock time.',
    section: 'Act 0 — the renderer',
  },
  'convergence-wipe': {
    title: 'Convergence — wipe',
    blurb:
      'The same pair in one frame, pixel-registered under a divider you drag. For when the difference is too subtle to catch across two panels.',
    section: 'Act 0 — the renderer',
  },
  'material-test': {
    title: 'What a material looks like',
    blurb:
      'The same lone sphere, rendered. Set its material, record it converging, change it, record again — the takes cut together. The companion to material-properties, which shows how it SCATTERS rather than how it looks.',
    section: 'Act 0 — the renderer',
  },
  'material-properties': {
    title: 'What a material does',
    blurb:
      'Rays scattering off one sphere, N at a time, thickness and colour by throughput. Change the material and the spray changes shape — and the uniform/importance toggle moves the lobe between the weights and the ray density.',
    section: 'Act 1 — one path',
  },
  'lamp-shrink': {
    title: 'Most paths report nothing',
    blurb:
      'One tracer, three lamps, equal total light in every room — the lamp shrinks and the picture falls apart anyway. Radiance rises as the area falls, so the figure is about findability, not exposure: PT stumbles onto the emitter 9.20% of the time at 1.6 square and 0.15% at 0.20.',
    section: 'Act 1 — one path',
  },
  'lamp-grid': {
    title: 'Why next-event estimation exists',
    blurb:
      'The same three shrinking lamps, run by two methods at equal samples. The top row collapses across the columns and the bottom row barely moves — nothing about the scene changed between them, only the sampling strategy. The companion to lamp-shrink, which watches one method fail alone.',
    section: 'Act 1 — one path',
  },
  'path-strategies': {
    title: 'What a strategy does',
    blurb:
      'One pixel, one strategy, every ray it casts — shadow rays and BDPT connections included. Successive samples run in turn over the dimmed remains of the last, so the fan of attempts builds up. Sharpest at sample 0: PT finds nothing, NEE carries light home immediately.',
    section: 'Act 1 — one path',
  },
  'pixel-grid': {
    title: 'An image being computed',
    blurb:
      'A small grid of pixels on the camera frustum. Every sample fires one ray per pixel, they bounce around the room, and the mini-image fills in as their contributions accumulate.',
    section: 'Act 0 — the renderer',
  },
  'pixel-grid-still': {
    title: 'An image, already computed',
    blurb:
      'The same grid on the frustum, at the end instead of during: every ray of every sample drawn at once, and the converged image large beside it. Its cousin pixel-grid shows the loop; this shows the work — 33,000 paths for a 32x32 picture, most of them reporting nothing.',
    section: 'Act 0 — the renderer',
  },
  'hello-stage': {
    title: 'Hello Stage',
    blurb: 'Palette, lighting and export check — a Cornell box with one traced path drawn across it.',
    section: 'Scaffolding',
  },
};

export interface DemoEntry extends DemoInfo {
  name: string;
  load: () => Promise<unknown>;
}

/** Turn "path-strategies" into "Path Strategies". */
function prettify(slug: string): string {
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Every demo in the repo. Vite resolves this glob at build time, so it works
 * identically in `npm run dev` and in a production build.
 */
export function allDemos(): DemoEntry[] {
  const mods = import.meta.glob('../demos/*/main.ts');
  return Object.entries(mods)
    .map(([path, load]) => {
      const name = path.split('/')[2]!;
      const info = INFO[name] ?? {};
      return {
        name,
        load,
        title: info.title ?? prettify(name),
        blurb: info.blurb,
        section: info.section ?? 'Unsorted',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

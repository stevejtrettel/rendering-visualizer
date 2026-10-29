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
  'bdpt-pyramid': {
    title: 'Every way to build a path',
    blurb:
      "Veach's pyramid, live: row d is every split (s, t) of a depth-d path between the light walk and the camera walk. Unweighted, each cell is its own bad estimate of the whole image; weighted, each keeps only what it is good at and the panel beside them is their exact sum — stated as a residual that reads ~1e-7 when the MIS weights are right.",
    section: 'Act 2 — many paths',
  },
  'level-zero': {
    title: 'Level zero',
    blurb:
      'Before path tracing: one ray leaves through each pixel of the film grid, stops at the first thing it hits, and the pixel takes that thing\'s colour. No light, no bounces. The same scene, camera and grid as pixel-grid, which is this figure with everything added.',
    section: 'Act 0 — the renderer',
  },
  'one-path': {
    title: 'One path, all the way',
    blurb:
      "Level zero's set-up, but one pixel's ray keeps bouncing until it lands on the lamp; then light comes back down the same path, multiplied at each bounce by exactly the factor the path tracer applied there, and the pixel takes what arrives. A real plain-PT sample, chosen to touch a coloured wall.",
    section: 'Act 1 — one path',
  },
  'one-sample': {
    title: 'One path per pixel',
    blurb:
      "one-path for the whole film at once: every pixel's ray goes out in lockstep, the ones that land on the lamp fill with colour from the lamp end, and the rest stay dark. One real plain-PT sample per pixel: a noisy image, and a count of how few paths found the light.",
    section: 'Act 1 — one path',
  },
  rasterize: {
    title: 'Rasterization',
    blurb:
      "The map from scene to screen: the camera's eye and image plane appear in front of the box, every point of the scene slides along its line to the eye until the scene lies flat on the plane (depth order kept, as a z-buffer keeps it), and the screen fills with the image. ?shade=light lights each surface by its angle to the lamp.",
    section: 'Act 1 — one path',
  },
  'scene-and-screen': {
    title: 'Scene and screen',
    blurb:
      'The two things a picture is made from: the scene, a 3D model, and the screen, a blank grid of pixels on the camera frustum. The set-up of level-zero, before any ray is traced.',
    section: 'Act 1 — one path',
  },
  'pixel-samples': {
    title: 'One pixel, up close',
    blurb:
      "One pixel's paths arriving as dots on a number line, the running average through them, and two brackets: the spread s, which settles, and the standard error s / sqrt N, which keeps shrinking. The slide before variance.",
    section: 'Act 1 — one path',
  },
  variance: {
    title: 'How fast the noise goes',
    blurb:
      "The image tilted back like a floor with a bar on every pixel, as tall as its standard error, shrinking as paths come in; beside it the image's mean standard error against paths per pixel, with c / sqrt(N) dashed.",
    section: 'Act 1 — one path',
  },
  'full-render': {
    title: 'The full render',
    blurb:
      'The short box rendered full size on every core, refining as you watch, and the converged image it is heading for, saved so it shows at once.',
    section: 'Act 1 — one path',
  },
  'many-samples': {
    title: 'Many paths per pixel',
    blurb:
      "one-sample again and again: each pass traces fresh paths for every pixel, its noisy partial image hovers above the running image and drops into it. The first passes are slow, then they speed up and the average settles.",
    section: 'Act 1 — one path',
  },
  'pixel-grid': {
    title: 'An image being computed',
    blurb:
      'A small grid of pixels on the camera frustum. Every sample fires one ray per pixel, they bounce around the room, and the mini-image fills in as their contributions accumulate.',
    section: 'Act 0 — the renderer',
  },
  'one-ray': {
    title: 'One ray, bouncing',
    blurb:
      'A single camera ray growing bounce by bounce to depth 10, and nothing else — then the same walk replaced thirty times a second, same pixel every time. One ray is a tidy diagram; thirty a second is what the estimator actually does.',
    section: 'Act 1 — one path',
  },
  'material-trio': {
    title: 'Three materials at once',
    blurb:
      'Fully rough, glossy and near-mirror in three Cornell shells, the same ray arriving at the same point on each — a cosine hemisphere, a lobe, and a 0.4-degree cone. Three scissored panes off one camera, head-on and centred, so nothing on screen differs but the surface.',
    section: 'Act 1 — one path',
  },
  'pixel-sweep': {
    title: 'One pixel at a time',
    blurb:
      'The unit of work under the other two: one cell of the film, a few rays through it, and the average they settle on — then the next cell. The colour only changes when a ray gets home, so what you watch is an estimate improving rather than a picture appearing.',
    section: 'Act 0 — the renderer',
  },
  'pixel-grid-still': {
    title: 'An image, already computed',
    blurb:
      'The same grid on the frustum, at the end instead of during: every ray of every sample drawn at once, and the converged image large beside it. Its cousin pixel-grid shows the loop; this shows the work — 33,000 paths for a 32x32 picture, most of them reporting nothing.',
    section: 'Act 0 — the renderer',
  },
  'pixel-bounce': {
    title: 'Rays looking for the light',
    blurb:
      'One ray per pixel leaves the grid and the whole population walks out in lockstep, a bounce per beat, dark — and a path that lands on the lamp flips to ochre and stops. No image, no panel, just the search: at 24x24 with brute-force PT capped at ten bounces, 11 of 576 rays ever touch the light.',
    section: 'Act 1 — one path',
  },
  'light-bounce': {
    title: 'Photons looking for the film',
    blurb:
      'pixel-bounce run backwards: photons leave the lamp, walk out a bounce per beat, and one that crosses the film flips to ochre and stops — lighting the cell it landed in, so the film fills in photon by photon. 27 of 576 land in ten bounces, in 25 scattered cells of 256. The argument for connecting light vertices to the camera rather than waiting for a hit.',
    section: 'Act 1 — one path',
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

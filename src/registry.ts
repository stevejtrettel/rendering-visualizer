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

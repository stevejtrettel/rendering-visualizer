/**
 * The index page: every demo in the repo, grouped by section.
 */

import { allDemos } from './registry';

const list = document.getElementById('list')!;
const demos = allDemos();

if (demos.length === 0) {
  list.innerHTML = `<p class="empty">No demos yet. Create <code>demos/my-demo/main.ts</code> and it shows up here.</p>`;
} else {
  const sections = new Map<string, typeof demos>();
  for (const d of demos) {
    const key = d.section ?? 'Unsorted';
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key)!.push(d);
  }

  for (const [section, entries] of sections) {
    const h = document.createElement('h2');
    h.textContent = `${section} · ${entries.length}`;
    list.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const d of entries) {
      const a = document.createElement('a');
      a.className = 'card';
      a.href = `./demo.html?d=${encodeURIComponent(d.name)}`;
      a.innerHTML = `
        <div class="name"></div>
        <div class="slug"></div>
        <div class="blurb"></div>`;
      // Set as text, never HTML — titles and blurbs are authored data, but this
      // keeps a stray angle bracket in a blurb from breaking the page.
      a.querySelector('.name')!.textContent = d.title ?? d.name;
      a.querySelector('.slug')!.textContent = d.name;
      a.querySelector('.blurb')!.textContent = d.blurb ?? '';
      grid.appendChild(a);
    }
    list.appendChild(grid);
  }
}

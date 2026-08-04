/**
 * Host page for a single demo. Reads ?d=<folder> and imports that demo.
 *
 * One host page for every demo means adding a demo never involves touching
 * HTML or build config — just create demos/<name>/main.ts.
 */

import { allDemos } from './registry';

const name = new URLSearchParams(location.search).get('d');
const errEl = document.getElementById('err') as HTMLPreElement;

function fail(msg: string) {
  errEl.style.display = 'grid';
  errEl.textContent = msg;
  console.error(msg);
}

const demos = allDemos();
const entry = demos.find((d) => d.name === name);

if (!name) {
  fail(`No demo specified.\n\nUse demo.html?d=<name>, or pick one from the index.`);
} else if (!entry) {
  fail(`Unknown demo: "${name}"\n\nAvailable:\n${demos.map((d) => '  ' + d.name).join('\n')}`);
} else {
  document.title = entry.title ?? entry.name;
  // Lets createUI() name exported files after the folder automatically.
  (window as any).__DEMO__ = entry.name;
  entry.load().catch((e) => fail(`Failed to load "${entry.name}":\n\n${e?.stack ?? e}`));
}

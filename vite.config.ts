import { defineConfig } from 'vite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

// `npm run build/preview <name>` sets DEMO; then vite's root becomes that
// demo's folder so its index.html is THE entry and the output flattens
// straight into dist/<name>/. With no DEMO (dev), root is the project and
// vite serves everything — / is the gallery, /demos/<name>/ is a demo.
const demo = process.env.DEMO;
if (demo && !existsSync(path.join(projectRoot, 'demos', demo, 'main.ts'))) {
  throw new Error(`Demo not found: demos/${demo}/main.ts`);
}

export default defineConfig({
  assetsInclude: ['**/*.obj'],
  root: demo ? path.join(projectRoot, 'demos', demo) : projectRoot,
  build: demo ? { outDir: path.join(projectRoot, 'dist', demo), emptyOutDir: true } : {},
  server: { fs: { allow: [projectRoot] } }, // demo pages import ../../src
  optimizeDeps: demo ? undefined : { entries: ['index.html', 'demos/*/index.html'] },
});

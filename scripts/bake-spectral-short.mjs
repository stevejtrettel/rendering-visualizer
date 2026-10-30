// Runs bake-spectral-short.ts through Vite (for the TypeScript and the module
// resolution). Usage: node scripts/bake-spectral-short.mjs <out.json> [res]
import { createServer } from 'vite';

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/bake-spectral-short.mjs <out.json> [res]');
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const mod = await server.ssrLoadModule('/scripts/bake-spectral-short.ts');
  await mod.main(out, Number(process.argv[3] ?? 16));
} finally {
  await server.close();
}

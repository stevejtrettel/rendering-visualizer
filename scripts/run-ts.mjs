// Runs a TypeScript script's exported main(...args) through Vite (for the
// TypeScript and the module resolution).
// Usage: node scripts/run-ts.mjs <script.ts> [args...]
import { createServer } from 'vite';

const [script, ...args] = process.argv.slice(2);
if (!script) throw new Error('usage: node scripts/run-ts.mjs <script.ts> [args...]');
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const mod = await server.ssrLoadModule('/' + script.replace(/^\.?\//, ''));
  await mod.main(...args);
} finally {
  await server.close();
}

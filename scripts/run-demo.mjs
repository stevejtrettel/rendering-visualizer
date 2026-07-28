import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Thin vite wrapper. Each demo is its own Vite page (demos/<name>/index.html).
//   npm run dev            serve everything (/ is the gallery)
//   npm run dev <name>     serve everything and open that demo's page
//   npm run build <name>   build just that demo into dist/<name>/  (DEMO env -> vite.config)
//   npm run preview <name> preview dist/<name>/
const [, , mode, demo] = process.argv;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const demoExists = (name) => existsSync(path.join(root, 'demos', name, 'main.ts'));

const demosList = () =>
  existsSync(path.join(root, 'demos'))
    ? readdirSync(path.join(root, 'demos'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && demoExists(d.name))
        .map((d) => `  ${d.name}`)
        .join('\n')
    : '';

if ((mode === 'build' || mode === 'preview') && !demo) {
  console.error(`Usage: npm run ${mode} <demo>\n\nDemos:\n${demosList()}`);
  process.exit(1);
}
if (demo && !demoExists(demo)) {
  console.error(`Demo not found: ${demo} (looked in demos/)\n\nDemos:\n${demosList()}`);
  process.exit(1);
}

const env = { ...process.env };
let viteArgs;
if (mode === 'build') { viteArgs = ['build']; env.DEMO = demo; }
else if (mode === 'preview') { viteArgs = ['preview']; env.DEMO = demo; }
else { // dev: serve everything; open the demo if one was named
  viteArgs = ['--host', '127.0.0.1'];
  if (demo) viteArgs.push('--open', `/demos/${demo}/`);
}

const child = spawn('npx', ['vite', ...viteArgs], { stdio: 'inherit', cwd: root, env });
child.on('exit', (code) => process.exit(code ?? 0));

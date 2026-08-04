/**
 * Re-encode an already-captured frame sequence from the command line.
 *
 *   npm run video <demo-name> [fps] [mp4|prores]
 *
 * The in-browser "render video" button already encodes automatically, so this
 * is only for re-encoding frames you have — switching a take to ProRes for
 * Keynote, say, without re-rendering it.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [, , name, fpsArg = '60', formatArg = 'mp4'] = process.argv;

if (!name) {
  const dir = path.join(root, 'out', 'frames');
  const have = existsSync(dir) ? readdirSync(dir) : [];
  console.error('Usage: npm run video <demo-name> [fps] [mp4|prores]');
  console.error(have.length ? `\nCaptured sequences:\n${have.map((d) => '  ' + d).join('\n')}` : '\nNo captured frames yet.');
  process.exit(1);
}

const frames = path.join(root, 'out', 'frames', name);
if (!existsSync(frames)) {
  console.error(`No frames at out/frames/${name} — capture the sequence in the browser first (press V).`);
  process.exit(1);
}

const fps = Number(fpsArg);
const prores = formatArg === 'prores';
const outFile = path.join(root, 'out', `${name}.${prores ? 'mov' : 'mp4'}`);
mkdirSync(path.join(root, 'out'), { recursive: true });

const codec = prores
  ? ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']
  : ['-c:v', 'libx264', '-crf', '16', '-preset', 'slow', '-pix_fmt', 'yuv420p'];

const args = ['-y', '-framerate', String(fps), '-i', path.join(frames, '%05d.png'), ...codec, '-r', String(fps), outFile];

console.log(`ffmpeg: ${readdirSync(frames).length} frames -> ${path.relative(root, outFile)}`);
const child = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
child.on('exit', (code) => {
  if (code === 0) console.log(`\ndone: out/${path.basename(outFile)}`);
  process.exit(code ?? 0);
});

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageBuild = process.argv.slice(2).includes('--package');
if (process.argv.slice(2).some(argument => argument !== '--package')) throw new Error('Unknown runtime build argument');
const outputName = packageBuild ? 'runtime' : 'dist';
const dist = join(root, outputName);
const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');

rmSync(dist, { recursive: true, force: true });
const compilerArgs = [tsc, '--project', join(root, 'tsconfig.build.json')];
if (packageBuild) compilerArgs.push('--outDir', dist, '--sourceMap', 'false', '--inlineSources', 'false');
const result = spawnSync(process.execPath, compilerArgs, {
  cwd: root,
  encoding: 'utf8',
  env: process.env,
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || 'runtime TypeScript build failed\n');
  process.exit(result.status ?? 1);
}

// Execution-only vendor JavaScript is intentionally not part of the TypeScript emission.
await mkdir(join(dist, 'src/core/subagent/vendor'), { recursive: true });
for (const name of ['executor.js', 'agents.js', 'transcript-store.js']) {
  await copyFile(join(root, 'src/core/subagent/vendor', name), join(dist, 'src/core/subagent/vendor', name));
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
await mkdir(join(dist, 'src/core/delegate'), { recursive: true });
await copyFile(
  join(root, 'src/core/delegate/hook-contract-evidence.json'),
  join(dist, 'src/core/delegate/hook-contract-evidence.json'),
);
writeFileSync(
  join(dist, 'package.json'),
  `${JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module' }, null, 2)}\n`,
);

for (const relativePath of [
  'extensions/anthropic-attribution.js',
  'extensions/anthropic-attribution-child.js',
  'extensions/background-tasks.js',
  'extensions/delegate-child.js',
  'extensions/fusion-child.js',
]) {
  const target = join(dist, relativePath);
  if (!existsSync(target)) {
    throw new Error(`runtime build did not emit ${relativePath}`);
  }
}

console.log(
  `runtime-build: compiled JavaScript entrypoints and deferred runtime closure into ${outputName}/ (${packageBuild ? 'without source maps' : 'with source maps'}).`,
);

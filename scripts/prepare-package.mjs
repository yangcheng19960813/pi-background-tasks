#!/usr/bin/env node
// npm install --omit=dev (Pi's git-package flow) has no devDependencies, so prepare
// must stay buildable without TypeScript: use the committed runtime/ payload then.
// Local development and CI have TypeScript and always rebuild from source.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Only trust TypeScript installed inside this package; resolution walking out of the
// package root (user-level installs) must not turn the fallback path into a broken build.
const hasTypeScript = existsSync(join(root, 'node_modules', 'typescript', 'bin', 'tsc'));

if (hasTypeScript) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'build-runtime.mjs'), '--package'], { cwd: root, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
for (const entry of ['runtime/extensions/anthropic-attribution.js', 'runtime/extensions/background-tasks.js', 'runtime/src/core/subagent/vendor/executor.js']) {
  if (!existsSync(join(root, entry))) {
    console.error(`prepare: 缺少已提交的运行产物 ${entry}，且当前环境没有 TypeScript；安装 devDependencies 后重试`);
    process.exit(1);
  }
}
console.log('prepare: TypeScript 不可用，使用仓库内已提交的 runtime/ 运行产物。');

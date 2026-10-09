#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
assert.ok(existsSync(npmCli), '需要可用的 npm CLI');
const result = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr || result.stdout);
const files = JSON.parse(result.stdout)[0].files.map(file => file.path);
const allowed = new Set(['package.json', 'README.md', 'LOCAL-DEVELOPMENT.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'BACKGROUND-TASKS-INSTRUCTIONS.md']);
assert.equal(manifest.private, true, '个人包禁止 npm registry 发布');
for (const file of files) {
  assert.ok(file.startsWith('runtime/') || allowed.has(file), `意外打包内容：${file}`);
  assert.ok(!file.endsWith('.map'), `不得打包源码映射：${file}`);
  if (file.startsWith('runtime/') && file.endsWith('.js')) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /sourceMappingURL=.*\.map/);
  }
}
for (const file of [...manifest.pi.extensions,
  './runtime/extensions/anthropic-attribution-child.js', './runtime/extensions/delegate-child.js', './runtime/extensions/fusion-child.js',
  './runtime/src/core/subagent/vendor/executor.js', './runtime/src/core/subagent/vendor/agents.js', './runtime/src/core/subagent/vendor/transcript-store.js',
  './runtime/src/core/delegate/hook-contract-evidence.json']) {
  assert.ok(files.includes(file.replace(/^\.\//, '')), `缺少运行入口或资产：${file}`);
}
for (const name of Object.keys(manifest.peerDependencies)) {
  assert.equal(manifest.peerDependencies[name], '*');
  assert.equal(manifest.peerDependenciesMeta[name].optional, true, `宿主依赖不得由普通 npm Git 安装自动复制：${name}`);
  assert.equal(manifest.dependencies[name], undefined);
}
assert.deepEqual(manifest.dependencies, { turndown: '7.2.4' });
console.log(`personal-package: ${files.length} files; runtime closure present; no maps/source/tests/SDK; registry publish disabled.`);

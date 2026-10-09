#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, readdir, lstat, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCHEMA = 'pi-background-tasks.extension-deployment.v1';
const HOST_PACKAGES = new Set(['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']);
const ENTRY = `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import attribution from './dist/extensions/anthropic-attribution.js';
import backgroundTasks from './dist/extensions/background-tasks.js';

export default async function (pi: ExtensionAPI): Promise<void> {
  await attribution(pi);
  await backgroundTasks(pi);
}
`;

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function plainFiles(directory) {
  const result = [];
  async function visit(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`拒绝复制或覆盖符号链接：${path}`);
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
    } else if (stat.isFile()) result.push(path);
    else throw new Error(`不是普通文件：${path}`);
  }
  await visit(directory);
  return result;
}
async function fingerprints(directory) {
  const result = {};
  for (const file of await plainFiles(directory)) {
    const name = relative(directory, file).replaceAll('\\', '/');
    if (name === 'deployment.json') continue;
    result[name] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return result;
}
async function copyPlain(source, target) {
  await plainFiles(source);
  await cp(source, target, { recursive: true, force: false, errorOnExist: true, dereference: false, filter: path => !path.endsWith('.map') });
}
async function removeSourceMapReferences(directory) {
  for (const file of await plainFiles(directory)) {
    if (!/\.(?:[cm]?js|[cm]?ts)$/.test(file)) continue;
    const contents = await readFile(file, 'utf8');
    const cleaned = contents.replace(/(^|\r?\n)[\t ]*\/\/[#@][\t ]*sourceMappingURL=[^\r\n]*\.map[\t ]*(?:\r?\n)?$/, '$1');
    if (cleaned !== contents) await writeFile(file, cleaned);
  }
}

async function moveDirectory(source, target) {
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(source, target); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 6) throw error;
      // Bounded Windows filesystem contention retry, not background-task polling.
      await new Promise(resolve => setTimeout(resolve, 40 * 2 ** attempt));
    }
  }
}


/** Deploy only a built runtime and its production dependency closure; never edit settings or original extensions. */
export async function deployExtension(destination, { source = sourceRoot } = {}) {
  const target = resolve(destination);
  if (basename(target) !== 'pi-background-tasks' || basename(dirname(target)) !== 'extensions') {
    throw new Error('部署目标必须是 extensions/pi-background-tasks 独立目录');
  }
  if (await exists(target) && (await lstat(target)).isSymbolicLink()) throw new Error('部署目标不能是符号链接');
  if (await exists(dirname(target)) && (await lstat(dirname(target))).isSymbolicLink()) throw new Error('部署父目录不能是符号链接');
  await mkdir(dirname(target), { recursive: true });
  const workBase = resolve(dirname(dirname(target)), '..', '.pi', 'tasks', 'extension-deployment');
  await mkdir(workBase, { recursive: true });
  const stagingRoot = await mkdtemp(join(workBase, 'stage-'));
  const staged = join(stagingRoot, 'runtime');
  let backup;
  try {
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    await mkdir(staged);
    await copyPlain(join(source, 'dist'), join(staged, 'dist'));
    for (const entry of ['extensions/anthropic-attribution.js', 'extensions/background-tasks.js', 'src/core/subagent/vendor/executor.js']) {
      if (!await exists(join(staged, 'dist', entry))) throw new Error(`缺少构建产物 ${entry}；先执行 npm run build:runtime`);
    }
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyPlain(join(source, file), join(staged, file));
    await writeFile(join(staged, 'index.ts'), ENTRY, { flag: 'wx' });
    const dependencies = {};
    const copied = new Map();
    async function copyDependency(name, from) {
      if (HOST_PACKAGES.has(name)) throw new Error(`禁止在运行依赖中复制宿主包：${name}`);
      if (!/^(?:@[a-z0-9_][a-z0-9._-]*\/)?[a-z0-9_][a-z0-9._-]*$/i.test(name)) throw new Error(`无效依赖名称：${name}`);
      const dependencyFile = createRequire(join(from, 'package.json')).resolve(`${name}/package.json`);
      const data = JSON.parse(await readFile(dependencyFile, 'utf8'));
      if (data.name !== name) throw new Error(`依赖身份不匹配：${name}`);
      const previous = copied.get(name);
      if (previous) {
        if (previous !== data.version) throw new Error(`运行依赖版本冲突：${name}`);
        return;
      }
      copied.set(name, data.version);
      const directory = dirname(dependencyFile);
      await copyPlain(directory, join(staged, 'node_modules', ...name.split('/')));
      for (const child of Object.keys(data.dependencies ?? {})) await copyDependency(child, directory);
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      await copyDependency(name, source);
      dependencies[name] = copied.get(name);
    }
    const runtimeManifest = { name: manifest.name, version: manifest.version, type: 'module', license: manifest.license,
      description: manifest.description, dependencies, peerDependencies: manifest.peerDependencies };
    await writeFile(join(staged, 'package.json'), JSON.stringify(runtimeManifest, null, 2) + '\n', { flag: 'wx' });
    await removeSourceMapReferences(staged);
    const hashes = await fingerprints(staged);
    await writeFile(join(staged, 'deployment.json'), JSON.stringify({ schema: SCHEMA, version: manifest.version,
      createdAt: new Date().toISOString(), source, dependencies: Object.fromEntries(copied), hashes }, null, 2) + '\n', { flag: 'wx' });
    if (await exists(target)) {
      const old = JSON.parse(await readFile(join(target, 'deployment.json'), 'utf8'));
      if (old.schema !== SCHEMA || !old.hashes || JSON.stringify(old.hashes) !== JSON.stringify(await fingerprints(target))) {
        throw new Error('目标不是受管理的部署，或含本地改动；保留现场，拒绝覆盖');
      }
      backup = join(workBase, `backup-${randomUUID()}`);
      await moveDirectory(target, backup);
    }
    try { await moveDirectory(staged, target); }
    catch (error) {
      if (backup && !await exists(target)) await moveDirectory(backup, target);
      throw error;
    }
    return { destination: target, backup, files: Object.keys(hashes).length, dependencies: Object.fromEntries(copied) };
  } finally { await rm(stagingRoot, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2] || process.argv.length !== 3) throw new Error('用法：node scripts/deploy-extension.mjs <agent-dir>/extensions/pi-background-tasks');
  console.log(JSON.stringify(await deployExtension(process.argv[2]), null, 2));
}

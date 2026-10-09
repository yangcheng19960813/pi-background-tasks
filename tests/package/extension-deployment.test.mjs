import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { deployExtension } from '../../scripts/deploy-extension.mjs';

const absent = async file => readFile(file).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });

test('extensions 部署：运行快照、依赖闭包、备份及防覆盖', {timeout:30000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(),'pi-extension-deploy-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const target = path.join(root,'agent','extensions','pi-background-tasks');
  const first = await deployExtension(target);
  await t.test('独立快照只用相对 dist 入口，运行依赖齐全且无开发 SDK', async () => {
    assert.ok(first.files > 50);
    assert.deepEqual(first.dependencies,{'turndown':'7.2.4','@mixmark-io/domino':'2.2.0'});
    const entry = await readFile(path.join(target,'index.ts'),'utf8');
    assert.match(entry,/\.\/dist\/extensions\/background-tasks\.js/);
    assert.doesNotMatch(entry,/project\/|\.\.\//);
    const manifest = JSON.parse(await readFile(path.join(target,'package.json'),'utf8'));
    assert.equal(manifest.devDependencies,undefined);
    assert.equal(manifest.pi,undefined,'目录自动发现只加载 index，不再注册 package manifest 入口');
    for (const name of ['@earendil-works/pi-ai','@earendil-works/pi-coding-agent','@earendil-works/pi-tui','typebox']) {
      assert.ok(await absent(path.join(target,'node_modules',...name.split('/'),'package.json')));
    }
    const Turndown = createRequire(path.join(target,'package.json'))('turndown');
    assert.equal(new Turndown().turndown('<h1>runtime only</h1>'),'runtime only\n============');
  });
  await t.test('部署产物不含 map 或失效的 sourceMappingURL，开发映射保留', async () => {
    const hashes = JSON.parse(await readFile(path.join(target,'deployment.json'),'utf8')).hashes;
    assert.equal(Object.keys(hashes).some(file => file.endsWith('.map')),false);
    const original = new URL('../../dist/extensions/background-tasks.js.map',import.meta.url);
    assert.ok((await readFile(original)).length > 0);
    assert.doesNotMatch(await readFile(path.join(target,'dist','extensions','background-tasks.js'),'utf8'),/sourceMappingURL=/);
  });
  await t.test('重复部署保留旧运行版备份，不改源代码或 settings', async () => {
    const old = await readFile(path.join(target,'deployment.json'),'utf8');
    const second = await deployExtension(target);
    assert.ok(second.backup);assert.equal(await readFile(path.join(second.backup,'deployment.json'),'utf8'),old);
    assert.ok(await absent(path.join(root,'agent','settings.json')));
  });
  await t.test('已有部署含本地改动时拒绝覆盖', async () => {
    const file = path.join(target,'index.ts');const modified = (await readFile(file,'utf8'))+'\n// local edit\n';
    await writeFile(file,modified);await assert.rejects(deployExtension(target),/本地改动/);
    assert.equal(await readFile(file,'utf8'),modified);
  });
  await t.test('不覆盖无管理标记的目录', async () => {
    const other = path.join(root,'other','extensions','pi-background-tasks');await mkdir(other,{recursive:true});
    await writeFile(path.join(other,'keep.txt'),'keep');
    await assert.rejects(deployExtension(other));assert.equal(await readFile(path.join(other,'keep.txt'),'utf8'),'keep');
  });
  await t.test('拒绝符号链接目标和错误目录名', async () => {
    const link = path.join(root,'linked','extensions','pi-background-tasks');await mkdir(path.dirname(link),{recursive:true});
    await symlink(target,link,process.platform==='win32'?'junction':'dir');
    await assert.rejects(deployExtension(link),/符号链接/);await assert.rejects(deployExtension(root),/部署目标必须/);
  });
});

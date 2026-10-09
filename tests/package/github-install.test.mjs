import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, readFile, writeFile, readdir, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../../', import.meta.url));
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');

async function run(command, args, cwd, extraEnv = {}, timeout = 180000) {
  const env = { ...process.env, ...extraEnv };
  // Test modes must not leak in from a caller's deployed-runtime regression.
  delete env.PI_NATIVE_DEPLOYMENT_DIR;
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  let cleanup;
  const timer = setTimeout(() => {
    cleanup = new Promise((resolveCleanup, rejectCleanup) => {
      if (process.platform === 'win32') {
        const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows','System32','taskkill.exe'), ['/PID',String(child.pid),'/T','/F'], { shell:false, windowsHide:true, stdio:'ignore' });
        killer.once('error',rejectCleanup);killer.once('close',code => code === 0 || code === 128 ? resolveCleanup() : rejectCleanup(new Error(`taskkill ${code}`)));
      } else {
        try { process.kill(-child.pid,'SIGKILL');resolveCleanup(); } catch(error) { if(error.code==='ESRCH')resolveCleanup();else rejectCleanup(error); }
      }
    });
    cleanup.catch(() => {});
  },timeout);
  try {
    const code = await new Promise((resolveCode,rejectCode) => { child.once('error',rejectCode);child.once('close',resolveCode); });
    if (cleanup) { await cleanup;throw new Error(`命令超时：${command}\n${output}`); }
    assert.equal(code,0,`${command} ${args.join(' ')}\n${output}`);
    return output;
  } finally { clearTimeout(timer); }
}

test('npm Git 安装：真实 prepare、纯运行打包、无自动宿主 SDK、完整原生角色 SDK 验证', async t => {
  const root = await mkdtemp(join(tmpdir(),'pi-npm-git-'));
  const version=JSON.parse(await readFile(join(source,'package.json'),'utf8')).version;
  t.after(() => rm(root,{recursive:true,force:true}));
  const repository=join(root,'repository'),consumer=join(root,'consumer');
  await mkdir(repository);await mkdir(consumer);
  const tracked=spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:source,encoding:'utf8'});
  assert.equal(tracked.status,0,tracked.stderr);
  for(const name of new Set(tracked.stdout.split('\0').filter(Boolean))) {
    const from=join(source,name);if((await lstat(from)).isSymbolicLink())throw new Error(`测试快照拒绝符号链接：${name}`);
    await mkdir(dirname(join(repository,name)),{recursive:true});await cp(from,join(repository,name));
  }
  // The fixture commits only to a new disposable repository, never the development repository.
  await run('git',['init','--quiet'],repository);
  await run('git',['add','--','.'],repository);
  await run('git',['-c','core.hooksPath='+join(root,'no-hooks'),'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','isolated npm Git fixture'],repository);
  await run('git',['tag','v'+version],repository);
  await writeFile(join(consumer,'package.json'),JSON.stringify({name:'personal-git-consumer',private:true}));
  const output=await run(process.execPath,[npmCli,'install','git+'+pathToFileURL(repository).href,'--omit=dev','--no-audit','--no-fund','--foreground-scripts'],consumer);
  // Pi installs git packages with npm install --omit=dev: no devDependencies, no build.
  // The committed runtime/ payload plus prepare fallback must satisfy that flow too.
  await run(process.execPath,[npmCli,'install','git+'+pathToFileURL(repository).href+'#v'+version,'--omit=dev','--no-audit','--no-fund','--foreground-scripts'],consumer);
  t.diagnostic(output.slice(-3000));
  const installed=join(consumer,'node_modules','pi-background-tasks');
  const manifest=JSON.parse(await readFile(join(installed,'package.json'),'utf8'));
  assert.equal(manifest.private,true);assert.ok(manifest.pi.extensions.every(entry=>entry.startsWith('./runtime/')));
  const files=await readdir(installed,{recursive:true});
  assert.equal(files.some(file=>file.endsWith('.map')),false);
  for(const directory of ['src','tests','maintenance','dist','scripts','node_modules']) {
    await assert.rejects(lstat(join(installed,directory)),error=>error.code==='ENOENT',directory);
  }
  for(const name of ['@earendil-works','typebox','typescript']) {
    await assert.rejects(lstat(join(consumer,'node_modules',name)),error=>error.code==='ENOENT',name);
  }
  const lock=JSON.parse(await readFile(join(consumer,'package-lock.json'),'utf8'));
  assert.ok(lock.packages['node_modules/pi-background-tasks'].resolved.startsWith('git+file:'));
  assert.ok(lock.packages['node_modules/turndown']);assert.ok(lock.packages['node_modules/@mixmark-io/domino']);
  const sdkOutput=await run(process.execPath,['--test',join(source,'tests/sdk/subagent-native-sdk.test.mjs')],source,{PI_NATIVE_PACKAGE_DIR:resolve(installed)},90000);
  t.diagnostic(sdkOutput);assert.match(sdkOutput,/\bpass 19\b/);assert.match(sdkOutput,/fail 0/);
});

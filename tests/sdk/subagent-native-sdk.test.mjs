import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as sdk from '@earendil-works/pi-coding-agent';

const deployment = process.env.PI_NATIVE_DEPLOYMENT_DIR;
const installedPackage = process.env.PI_NATIVE_PACKAGE_DIR;
if (deployment && installedPackage) throw new Error('部署目录与安装包测试模式不能同时启用');
const extension = fileURLToPath(new URL('../../dist/extensions/background-tasks.js', import.meta.url));
const providerSource = `import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getDeclaredTools } from '@earendil-works/pi-ai';
export default function(pi) {
  pi.registerProvider('native-fixture', { baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture', api: 'openai-responses',
    models: ['reader','writer'].map(id => ({ id, name:id, reasoning:true, input:['text'], contextWindow:128000, maxTokens:2048,
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0} })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const user = context.messages.filter(m => m.role==='user').at(-1);
      const task = typeof user?.content==='string' ? user.content : (user?.content ?? []).filter(c => c.type==='text').map(c=>c.text).join(' ');
      const system = getCurrentSystemPrompt(context.messages);
      const tools = getDeclaredTools(context.messages);
      const text = JSON.stringify({model:model.id, thinking:options?.reasoning, task,
        tools:tools.map(t=>t.name).sort(), rolePrompt:system.includes('ROLE_SENTINEL'), childPolicy:system.includes('child: true'), pid:process.pid});
      if(process.env.PI_SUBAGENT_CONTEXT==='1') appendFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'pids.jsonl'),JSON.stringify({pid:process.pid, descendant:task.includes('DESCENDANT')?spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).pid:undefined})+'\\n');
      const message={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,stopReason:'stop',timestamp:Date.now(),
        usage:{input:100,output:20,cacheRead:0,cacheWrite:0,totalTokens:120,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      const done=()=>{ message.content=[{type:'text',text}]; stream.push({type:'start',partial:message});
        stream.push({type:'text_start',contentIndex:0,partial:message}); stream.push({type:'text_delta',contentIndex:0,delta:text,partial:message});
        stream.push({type:'text_end',contentIndex:0,content:text,partial:message}); stream.push({type:'done',reason:'stop',message});
        stream.end(); options?.signal?.removeEventListener('abort',abort); };
      const timer=setTimeout(done,task.includes('HANG')?10000:task.includes('SLOW')?1800:30);
      const abort=()=>{clearTimeout(timer);message.stopReason='aborted';message.errorMessage='fixture aborted';stream.push({type:'error',reason:'aborted',error:message});stream.end();};
      options?.signal?.addEventListener('abort',abort,{once:true});
      return stream;
    }
  });
}`;
async function fixture(t, { fullPackage = false } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(),'pi-native-role-'));
  const agentDir = path.join(cwd,'agent');
  await mkdir(path.join(agentDir,'agents'),{recursive:true});
  const provider = path.join(cwd,'provider.ts');
  await writeFile(provider,providerSource);
  if (deployment) await cp(deployment,path.join(agentDir,'extensions','pi-background-tasks'),{recursive:true});
  const extensionPaths = (fullPackage || deployment || installedPackage) ? [provider] : [provider, extension];
  await writeFile(path.join(agentDir,'settings.json'),JSON.stringify({packages:installedPackage?[installedPackage]:fullPackage&&!deployment?[fileURLToPath(new URL('../../',import.meta.url))]:[],extensions:extensionPaths,
    defaultProvider:'native-fixture',defaultModel:'reader',compaction:{enabled:false,reserveTokens:1024,keepRecentTokens:64}}));
  await writeFile(path.join(agentDir,'auth.json'),JSON.stringify({'native-fixture':{type:'api_key',key:'fixture'}}));
  await writeFile(path.join(agentDir,'models.json'),JSON.stringify({providers:{'native-fixture':{baseUrl:'http://127.0.0.1:1',apiKey:'fixture',api:'openai-responses',models:['reader','writer'].map(id=>({id,name:id,reasoning:true,input:['text'],contextWindow:128000,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}))}}}));
  await writeFile(path.join(agentDir,'agents','scout.md'),'---\nname: scout\ndescription: readonly fixture\nmodel: native-fixture/reader:high\ntools: read\n---\nROLE_SENTINEL readonly');
  await writeFile(path.join(agentDir,'agents','worker.md'),'---\nname: worker\ndescription: writer fixture\nmodel: native-fixture/writer:medium\ntools: read, write\n---\nROLE_SENTINEL writer');
  const old = {agent:process.env.PI_CODING_AGENT_DIR,features:process.env.PI_BG_FEATURES};
  process.env.PI_CODING_AGENT_DIR=agentDir; if (fullPackage || deployment || installedPackage) delete process.env.PI_BG_FEATURES; else process.env.PI_BG_FEATURES='process';
  const events = sdk.createEventBus();
  const terminals=new Map(), waiting=new Map();
  const off=events.on('pi-background-tasks:terminal:v1',frame=>{terminals.set(frame.task.id,frame.task);waiting.get(frame.task.id)?.(frame.task);waiting.delete(frame.task.id);});
  const pids=[];let ready;
  const watcher=watch(agentDir,(_kind,name)=>{
    if(String(name)!=='pids.jsonl')return;
    readFile(path.join(agentDir,'pids.jsonl'),'utf8').then(text=>{
      for(const line of text.slice(0,text.lastIndexOf('\n')+1).split('\n').filter(Boolean)){const pid=JSON.parse(line).pid;if(!pids.includes(pid))pids.push(pid);}
      if(pids.length)ready?.(pids[0]);
    }).catch(error=>{if(error.code!=='ENOENT')console.error(error);});
  });
  let session;
  t.after(async()=>{
    if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'exit'});session.dispose();}
    watcher.close();off();events.clear();
    if(old.agent===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old.agent;
    if(old.features===undefined)delete process.env.PI_BG_FEATURES;else process.env.PI_BG_FEATURES=old.features;
    await rm(cwd,{recursive:true,force:true});
  });
  const settingsManager=sdk.SettingsManager.create(cwd,agentDir);
  const resourceLoader=new sdk.DefaultResourceLoader({cwd,agentDir,settingsManager,eventBus:events,noExtensions:!(fullPackage || deployment || installedPackage),noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:extensionPaths});
  await resourceLoader.reload();assert.deepEqual(resourceLoader.getExtensions().errors,[]);
  ({session}=await sdk.createAgentSession({cwd,agentDir,settingsManager,resourceLoader,sessionManager:sdk.SessionManager.inMemory(cwd),tools:[]}));
  const errors=[];await session.bindExtensions({onError:error=>errors.push(error)});assert.deepEqual(errors,[]);
  session.setActiveToolsByName(['bg_subagent','bg_subagent_result','bg_run','bg_status','bg_logs','bg_kill']);
  const call=async(name,args)=>{
    const registered=session.extensionRunner.getAllRegisteredTools().find(item=>item.definition.name===name);assert.ok(registered,`缺少实际注册的 ${name}`);
    const id=randomUUID();const blocked=await session.extensionRunner.emitToolCall({type:'tool_call',toolCallId:id,toolName:name,input:args});
    if(blocked?.block)return{content:[{type:'text',text:blocked.reason}],isError:true};
    return sdk.wrapRegisteredTool(registered,session.extensionRunner).execute(id,args);
  };
  return{cwd,agentDir,session,call,wait:id=>terminals.has(id)?Promise.resolve(terminals.get(id)):new Promise(resolve=>waiting.set(id,resolve)),
    waitRole:()=>pids.length?Promise.resolve(pids[0]):new Promise(resolve=>{ready=resolve;}),
    launch:args=>call('bg_subagent',{notifyOnCompletion:false,triggerOnCompletion:false,...args})};
}

test('原生单任务：立即返回，真实子 Pi 的角色模型/工具/提示/子模式完整保留',{timeout:25000},async t=>{
  const h=await fixture(t);const task='SLOW 中文 & whoami > %TEMP% ! 不能进 shell';const start=Date.now();
  const receipt=await h.launch({agent:'scout',task});assert.notEqual(receipt.isError,true,receipt.content[0]?.text);
  assert.ok(Date.now()-start<1500,'启动确认不能等待角色完成');assert.equal(receipt.details.task.status,'running');
  const terminal=await h.wait(receipt.details.task.id);assert.equal(terminal.status,'completed',terminal.error);
  const result=await h.call('bg_subagent_result',{taskId:terminal.id});assert.notEqual(result.isError,true,result.content[0]?.text);
  const observed=JSON.parse(result.details.results[0].finalOutput);
  assert.equal(observed.model,'reader');assert.equal(observed.thinking,'high');assert.deepEqual(observed.tools,['read']);
  assert.equal(observed.rolePrompt,true);assert.equal(observed.childPolicy,true);assert.ok(observed.task.includes(task));
  assert.ok(result.details.results[0].transcript);assert.ok(await readFile(result.details.background.resultPath,'utf8'));
});
test('并行/chain previous 使用原执行工作流',{timeout:25000},async t=>{
  const h=await fixture(t);
  const a=await h.launch({tasks:[{agent:'scout',task:'first'},{agent:'worker',task:'second'}]});assert.notEqual(a.isError,true,a.content[0]?.text);
  assert.equal((await h.wait(a.details.task.id)).status,'completed');const r=await h.call('bg_subagent_result',{taskId:a.details.task.id});
  assert.equal(r.details.mode,'parallel');assert.deepEqual(r.details.results.map(x=>JSON.parse(x.finalOutput).model),['reader','writer']);
  const b=await h.launch({chain:[{agent:'scout',task:'SEED'},{agent:'worker',task:'PREVIOUS={previous}'}]});
  assert.notEqual(b.isError,true,b.content[0]?.text);assert.equal((await h.wait(b.details.task.id)).status,'completed');
  const c=await h.call('bg_subagent_result',{taskId:b.details.task.id});assert.equal(c.details.mode,'chain');
  assert.ok(JSON.parse(c.details.results[1].finalOutput).task.includes('SEED'));
});
test('未知角色终态 failed 且原生错误持久化',{timeout:15000},async t=>{
  const h=await fixture(t);const r=await h.launch({agent:'missing',task:'x'});assert.notEqual(r.isError,true,r.content[0]?.text);
  assert.equal((await h.wait(r.details.task.id)).status,'failed');const result=await h.call('bg_subagent_result',{taskId:r.details.task.id});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/Unknown agent|not found/i);
});
test('真实取消已开始的子 Pi，任务终止时角色进程已清理',{timeout:25000},async t=>{
  const h=await fixture(t);const r=await h.launch({agent:'scout',task:'HANG CANCEL DESCENDANT'});assert.notEqual(r.isError,true,r.content[0]?.text);
  const pid=await h.waitRole();const killed=await h.call('bg_kill',{taskId:r.details.task.id});assert.notEqual(killed.isError,true,killed.content[0]?.text);
  assert.equal((await h.wait(r.details.task.id)).status,'killed');assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
  const rows=(await readFile(path.join(h.agentDir,'pids.jsonl'),'utf8')).trim().split('\n').map(row=>JSON.parse(row));
  assert.ok(rows[0].descendant,'fixture 必须启动真实孙进程');
  assert.throws(()=>process.kill(rows[0].descendant,0),error=>error.code==='ESRCH');
});
test('外层超时由 registry 管理，不能误报 completed',{timeout:15000},async t=>{
  const h=await fixture(t);const r=await h.launch({agent:'scout',task:'HANG TIMEOUT',timeoutSeconds:1});assert.notEqual(r.isError,true,r.content[0]?.text);
  const terminal=await h.wait(r.details.task.id);assert.equal(terminal.status,'failed');assert.match(terminal.error,/Timed out|aborted|failed/i);
});
test('真实上下文压缩时，后台原生工作流持续并可读取结果',{timeout:25000},async t=>{
  const h=await fixture(t);const r=await h.launch({agent:'scout',task:'SLOW COMPACT'});assert.notEqual(r.isError,true,r.content[0]?.text);
  await h.waitRole();
  await h.session.prompt('准备一些真实前台上下文消息');await h.session.prompt('补充第二段真实上下文消息');
  const compacted=await h.session.compact();assert.ok(compacted.summary);
  assert.equal((await h.wait(r.details.task.id)).status,'completed');assert.notEqual((await h.call('bg_subagent_result',{taskId:r.details.task.id})).isError,true);
});
test('项目角色 headless 不得绕过授权，子环境不能后台派发',{timeout:15000},async t=>{
  const h=await fixture(t);const r=await h.launch({agent:'scout',task:'x',agentScope:'both'});assert.equal(r.isError,true);assert.match(r.content[0].text,/显式授权/);
  const old=process.env.PI_SUBAGENT_CONTEXT;process.env.PI_SUBAGENT_CONTEXT='1';
  try {const denied=await h.launch({agent:'scout',task:'x'});assert.equal(denied.isError,true);assert.match(denied.content[0].text,/阻塞|后台/);}
  finally{if(old===undefined)delete process.env.PI_SUBAGENT_CONTEXT;else process.env.PI_SUBAGENT_CONTEXT=old;}
});


test('实际 SDK reload 取消原生角色并等待进程清理；不承诺托管任务跨 reload 存活',{timeout:25000},async t=>{
  const h=await fixture(t);const r=await h.launch({agent:'scout',task:'HANG RELOAD DESCENDANT'});assert.notEqual(r.isError,true,r.content[0]?.text);
  const pid=await h.waitRole();const rows=(await readFile(path.join(h.agentDir,'pids.jsonl'),'utf8')).trim().split('\n').map(row=>JSON.parse(row));
  await h.session.reload();
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');assert.throws(()=>process.kill(rows[0].descendant,0),error=>error.code==='ESRCH');
  const metadata=JSON.parse(await readFile(path.join(path.dirname(r.details.task.subagent.resultPath),`${r.details.task.id}.json`),'utf8'));
  assert.equal(metadata.status,'killed');assert.match(metadata.error,/shutdown|reload/i);
});

test('实际 SDK session_shutdown 的返回包含清理与通知元数据收尾',{timeout:25000},async t=>{
  const h=await fixture(t);const r=await h.launch({agent:'scout',task:'HANG SHUTDOWN DESCENDANT'});assert.notEqual(r.isError,true,r.content[0]?.text);
  const pid=await h.waitRole();const rows=(await readFile(path.join(h.agentDir,'pids.jsonl'),'utf8')).trim().split('\n').map(row=>JSON.parse(row));
  await h.session.extensionRunner.emit({type:'session_shutdown',reason:'exit'});
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');assert.throws(()=>process.kill(rows[0].descendant,0),error=>error.code==='ESRCH');
  const metadata=JSON.parse(await readFile(path.join(path.dirname(r.details.task.subagent.resultPath),`${r.details.task.id}.json`),'utf8'));
  assert.equal(metadata.status,'killed');assert.equal(metadata.notified,false);
});

test('真实后台角色结果不能跨 SDK 会话读取',{timeout:20000},async t=>{
  const h=await fixture(t);const r=await h.launch({agent:'scout',task:'SESSION OWNER'});assert.notEqual(r.isError,true,r.content[0]?.text);
  assert.equal((await h.wait(r.details.task.id)).status,'completed');
  const another=await fixture(t);assert.notEqual(another.session.sessionManager.getSessionId(),h.session.sessionManager.getSessionId());
  const denied=await another.call('bg_subagent_result',{taskId:r.details.task.id});assert.equal(denied.isError,true);assert.match(denied.content[0].text,/Unknown|not found|拥有|不存在/i);
});


test('完整包默认功能加载：两个入口可绑定，原生后台工具可执行',{timeout:25000},async t=>{
  const h=await fixture(t,{fullPackage:true});
  const names=h.session.extensionRunner.getAllRegisteredTools().map(item=>item.definition.name);
  for(const name of ['bg_subagent','bg_subagent_result','bg_run','bg_status','bg_logs','bg_kill'])assert.ok(names.includes(name),`默认加载缺少 ${name}`);
  const r=await h.launch({agent:'scout',task:'DEFAULT PACKAGE STARTUP'});assert.notEqual(r.isError,true,r.content[0]?.text);
  assert.equal((await h.wait(r.details.task.id)).status,'completed');
  assert.notEqual((await h.call('bg_subagent_result',{taskId:r.details.task.id})).isError,true);
});

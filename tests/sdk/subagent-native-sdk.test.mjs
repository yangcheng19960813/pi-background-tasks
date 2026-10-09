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
      const toolResults = context.messages.filter(m => m.role === 'toolResult');
      const planIndex = task.indexOf('TOOL_SMOKE=');
      const plan = planIndex < 0 ? [] : JSON.parse(task.slice(planIndex + 'TOOL_SMOKE='.length));
      const next = plan[toolResults.length];
      const text = JSON.stringify({model:model.id, thinking:options?.reasoning, task,
        tools:tools.map(t=>t.name).sort(), rolePrompt:system.includes('ROLE_SENTINEL'), childPolicy:system.includes('child: true'), pid:process.pid,
        toolResults:toolResults.map(m=>({name:m.toolName,id:m.toolCallId,isError:m.isError,content:m.content,nestedCalls:m.nestedCalls}))});
      if(planIndex >= 0) appendFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'provider-turns.jsonl'),JSON.stringify({pid:process.pid,step:toolResults.length,tools:tools.map(t=>t.name).sort()})+'\\n');
      if(process.env.PI_SUBAGENT_CONTEXT==='1') appendFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'pids.jsonl'),JSON.stringify({pid:process.pid, descendant:task.includes('DESCENDANT')?spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).pid:undefined})+'\\n');
      const message={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,stopReason:next?'toolUse':'stop',timestamp:Date.now(),
        usage:{input:100,output:20,cacheRead:0,cacheWrite:0,totalTokens:120,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      const done=()=>{
        if(next) {
          const args=JSON.parse(JSON.stringify(next.arguments).replaceAll('"__CHILD_PID__"',String(process.pid)).replaceAll('__CHILD_PID__',String(process.pid)));
          const toolCall={type:'toolCall',id:'smoke-'+toolResults.length,name:next.name,arguments:args};
          message.content=[toolCall];stream.push({type:'start',partial:message});
          stream.push({type:'toolcall_start',contentIndex:0,partial:message});
          stream.push({type:'toolcall_delta',contentIndex:0,delta:JSON.stringify(args),partial:message});
          stream.push({type:'toolcall_end',contentIndex:0,toolCall,partial:message});
        } else {
          message.content=[{type:'text',text}];stream.push({type:'start',partial:message});
          stream.push({type:'text_start',contentIndex:0,partial:message});stream.push({type:'text_delta',contentIndex:0,delta:text,partial:message});
          stream.push({type:'text_end',contentIndex:0,content:text,partial:message});
        }
        stream.push({type:'done',reason:message.stopReason,message});
        stream.end(message);options?.signal?.removeEventListener('abort',abort); };
      const timer=setTimeout(done,task.includes('HANG')?10000:task.includes('SLOW')?1800:30);
      const abort=()=>{clearTimeout(timer);message.stopReason='aborted';message.errorMessage='fixture aborted';stream.push({type:'error',reason:'aborted',error:message});stream.end();};
      options?.signal?.addEventListener('abort',abort,{once:true});
      return stream;
    }
  });
}`;
async function fixture(t, { fullPackage = false, toolSmoke } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(),'pi-native-role-'));
  const agentDir = path.join(cwd,'agent');
  await mkdir(path.join(agentDir,'agents'),{recursive:true});
  const provider = path.join(cwd,'provider.ts');
  await writeFile(provider,providerSource);
  if (deployment) await cp(deployment,path.join(agentDir,'extensions','pi-background-tasks'),{recursive:true});
  const extensionPaths = (fullPackage || deployment || installedPackage) ? [provider] : [provider, extension];
  if (toolSmoke) {
    extensionPaths.push(fileURLToPath(new URL('../fixtures/subagent-tool-smoke-extension.ts', import.meta.url)));
    for (const file of ['mcp-audit.jsonl', 'tool-events.jsonl', 'extension-executions.jsonl', 'provider-turns.jsonl']) await writeFile(path.join(agentDir, file), '');
    await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { smoke: {
      command: process.execPath,
      args: [fileURLToPath(new URL('../fixtures/subagent-tool-smoke-mcp.mjs', import.meta.url)), path.join(agentDir, 'mcp-audit.jsonl')],
      exposure: toolSmoke.exposure, timeout: 5,
    } } }));
  }
  await writeFile(path.join(agentDir,'settings.json'),JSON.stringify({packages:installedPackage?[installedPackage]:fullPackage&&!deployment?[fileURLToPath(new URL('../../',import.meta.url))]:[],extensions:extensionPaths,
    defaultProvider:'native-fixture',defaultModel:'reader',compaction:{enabled:false,reserveTokens:1024,keepRecentTokens:64}}));
  await writeFile(path.join(agentDir,'auth.json'),JSON.stringify({'native-fixture':{type:'api_key',key:'fixture'}}));
  await writeFile(path.join(agentDir,'models.json'),JSON.stringify({providers:{'native-fixture':{baseUrl:'http://127.0.0.1:1',apiKey:'fixture',api:'openai-responses',models:['reader','writer'].map(id=>({id,name:id,reasoning:true,input:['text'],contextWindow:128000,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}))}}}));
  await writeFile(path.join(agentDir,'agents','scout.md'),'---\nname: scout\ndescription: readonly fixture\nmodel: native-fixture/reader:high\ntools: read\n---\nROLE_SENTINEL readonly');
  await writeFile(path.join(agentDir,'agents','worker.md'),'---\nname: worker\ndescription: writer fixture\nmodel: native-fixture/writer:medium\ntools: read, write\n---\nROLE_SENTINEL writer');
  if (toolSmoke) {
    const name = toolSmoke.agent || 'tool-smoke';
    await writeFile(path.join(agentDir, 'agents', name + '.md'), `---\nname: ${name}\ndescription: MCP and extension invocation fixture\nmodel: native-fixture/reader:high\ntools: ${toolSmoke.tools.join(', ')}\n---\nROLE_SENTINEL tool smoke`);
  }
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


// Script only the model's tool choices; child Pi, tool execution, MCP transport,
// extension permission events, and persisted transcripts all run for real.
async function readJsonl(file) {
  return (await readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
async function runToolSmoke(h, plan, { agent = 'tool-smoke', taskPrefix = '' } = {}) {
  const receipt = await h.launch({ agent, task: taskPrefix + 'TOOL_SMOKE=' + JSON.stringify(plan) });
  assert.notEqual(receipt.isError, true, receipt.content[0]?.text);
  const terminal = await h.wait(receipt.details.task.id);
  assert.equal(terminal.status, 'completed', terminal.error);
  const result = await h.call('bg_subagent_result', { taskId: terminal.id });
  assert.notEqual(result.isError, true, result.content[0]?.text);
  const role = result.details.results[0];
  assert.ok(role.transcript, '必须保留真实子代理 transcript');
  const transcriptRoot = process.env.PI_SUBAGENT_RUNS_DIR || path.join(h.agentDir, 'subagent-runs');
  const transcript = await readJsonl(path.join(transcriptRoot, role.transcript.runId + '.jsonl'));
  const observed = JSON.parse(role.finalOutput);
  assert.notEqual(observed.pid, process.pid, '工具必须由真实子 Pi 发起，不能由父测试代执行');
  assert.equal(observed.childPolicy, true);
  assert.equal(observed.toolResults.length, plan.length);
  // The executor also persists nested tool_execution_end records. Compare the
  // model's top-level result IDs separately, without discarding nested evidence.
  const resultIds = new Set(observed.toolResults.map(result => result.id));
  const allResults = transcript.filter(message => message.role === 'toolResult');
  const records = allResults.filter(message => resultIds.has(message.toolCallId));
  const nestedRecords = allResults.filter(message => !resultIds.has(message.toolCallId));
  if (!plan.some(step => step.name === 'codemode')) assert.deepEqual(nestedRecords, []);
  assert.equal(records.length, plan.length);
  for (const [index, record] of records.entries()) {
    assert.equal(record.toolName, plan[index].name);
    assert.ok(transcript.some(message => message.role === 'assistant' && message.content?.some(block => block.type === 'toolCall' && block.id === record.toolCallId && block.name === record.toolName)), '实际 toolCall/toolResult 必须在 transcript 内对应');
  }
  return { observed, records, nestedRecords, audit: await readJsonl(path.join(h.agentDir, 'mcp-audit.jsonl')),
    events: await readJsonl(path.join(h.agentDir, 'tool-events.jsonl')),
    executions: await readJsonl(path.join(h.agentDir, 'extension-executions.jsonl')),
    turns: await readJsonl(path.join(h.agentDir, 'provider-turns.jsonl')) };
}
function assertMcpExecution(smoke, token) {
  for (const method of ['initialize', 'notifications/initialized', 'tools/list']) assert.ok(smoke.audit.some(row => row.method === method), `缺少真实 MCP ${method}`);
  const calls = smoke.audit.filter(row => row.method === 'tools/call');
  assert.equal(calls.length, 1, 'MCP 服务端必须收到一次实际调用');
  assert.equal(calls[0].params.name, 'probe');
  assert.deepEqual(calls[0].params.arguments, { token, callerPid: smoke.observed.pid });
  assert.equal(calls[0].parentPid, smoke.observed.pid, 'MCP 服务必须是子 Pi 建立的连接');
  assert.notEqual(calls[0].serverPid, smoke.observed.pid);
  const callEvent = smoke.events.find(row => row.phase === 'call' && row.name === 'mcp__smoke__probe');
  assert.ok(callEvent, 'MCP 调用必须通过扩展 tool_call 权限管道');
  assert.equal(callEvent.pid, smoke.observed.pid);
  assert.ok(smoke.events.some(row => row.phase === 'result' && row.name === callEvent.name && row.id === callEvent.id && row.isError === false));
  for (const result of smoke.observed.toolResults) assert.equal(result.isError, false, JSON.stringify(result));
  assert.ok(JSON.stringify(smoke.records).includes('MCP_TOOL_EXECUTED'), '服务端真实结果必须进入子 transcript');
  assert.ok(JSON.stringify(smoke.records).includes(token));
  return calls[0];
}

test('工具冒烟：真实子 Pi 调用扩展工具与 direct MCP，服务端和 transcript 双重取证', { timeout: 25000 }, async t => {
  const token = randomUUID();
  const h = await fixture(t, { toolSmoke: { exposure: 'direct', tools: ['read', 'fixture_extension_probe', 'mcp__smoke__probe'] } });
  const args = { token, callerPid: '__CHILD_PID__' };
  const smoke = await runToolSmoke(h, [{ name: 'fixture_extension_probe', arguments: args }, { name: 'mcp__smoke__probe', arguments: args }]);
  const call = assertMcpExecution(smoke, token);
  assert.deepEqual(smoke.turns[0].tools, ['fixture_extension_probe', 'mcp__smoke__probe', 'read']);
  assert.deepEqual(smoke.executions, [{ marker: 'EXTENSION_TOOL_EXECUTED', token, callerPid: smoke.observed.pid, pid: smoke.observed.pid }]);
  assert.ok(JSON.stringify(smoke.records[0]).includes('EXTENSION_TOOL_EXECUTED'));
  assert.ok(smoke.events.some(row => row.phase === 'result' && row.name === 'fixture_extension_probe' && row.pid === smoke.observed.pid && row.isError === false));
  t.diagnostic(`真实工具取证：child=${smoke.observed.pid}，MCP server=${call.serverPid}，扩展执行=1，MCP tools/call=1，transcript 对应=2`);
});

test('工具冒烟：deferred MCP 经真实 tool_search 加载后再调用', { timeout: 25000 }, async t => {
  const token = randomUUID();
  const h = await fixture(t, { toolSmoke: { exposure: 'deferred', tools: ['read', 'tool_search'] } });
  const smoke = await runToolSmoke(h, [{ name: 'tool_search', arguments: { query: 'mcp__smoke__probe', limit: 1 } },
    { name: 'mcp__smoke__probe', arguments: { token, callerPid: '__CHILD_PID__' } }]);
  assertMcpExecution(smoke, token);
  assert.deepEqual(smoke.turns[0].tools, ['read', 'tool_search']);
  assert.ok(smoke.turns[1].tools.includes('mcp__smoke__probe'), 'tool_search 后下一轮才声明 MCP 工具');
  assert.ok(JSON.stringify(smoke.records[0].content).includes('mcp__smoke__probe'));
  assert.deepEqual(smoke.executions, []);
});

test('工具冒烟：默认 codemode MCP 由真实脚本嵌套调用，不需要直接声明 MCP', { timeout: 25000 }, async t => {
  const token = randomUUID();
  const h = await fixture(t, { toolSmoke: { exposure: 'codemode', tools: ['read', 'codemode'] } });
  const smoke = await runToolSmoke(h, [{ name: 'codemode', arguments: { code: `return await tools.mcp__smoke__probe({token:${JSON.stringify(token)},callerPid:__CHILD_PID__});` } }]);
  assertMcpExecution(smoke, token);
  assert.deepEqual(smoke.turns[0].tools, ['codemode', 'read']);
  const nestedCall = smoke.events.find(row => row.phase === 'call' && row.name === 'mcp__smoke__probe');
  assert.equal(nestedCall.parentId, smoke.records[0].toolCallId);
  assert.ok(smoke.observed.toolResults[0].nestedCalls.calls.some(call => call.name === 'mcp__smoke__probe'), 'codemode 结果必须记录嵌套 MCP 调用');
  assert.deepEqual(smoke.nestedRecords.map(record => ({ name: record.toolName, id: record.toolCallId, isError: record.isError })),
    [{ name: 'mcp__smoke__probe', id: nestedCall.id, isError: false }], '外部 transcript 必须保留实际嵌套 MCP 结果');
  assert.deepEqual(smoke.executions, []);
});

test('工具冒烟：角色未选中的扩展与被 mcp__ 白名单过滤的 MCP 均不能执行', { timeout: 25000 }, async t => {
  const token = randomUUID();
  const h = await fixture(t, { toolSmoke: { exposure: 'direct', tools: ['read', 'mcp__smoke__probe'] } });
  const args = { token, callerPid: '__CHILD_PID__' };
  // Even a deliberately invalid provider tool call must not bypass the child tool set.
  const smoke = await runToolSmoke(h, [{ name: 'fixture_extension_probe', arguments: args }, { name: 'mcp__smoke__forbidden_probe', arguments: args }]);
  assert.deepEqual(smoke.turns[0].tools, ['mcp__smoke__probe', 'read']);
  for (const result of smoke.observed.toolResults) assert.equal(result.isError, true);
  assert.deepEqual(smoke.executions, []);
  assert.equal(smoke.audit.filter(row => row.method === 'tools/call').length, 0);
});


// Quick and normal scout tasks share 50 calls; time budgets and cleanup remain independent.
test('scout 回归：普通和快速均为 50 次，3/8 分钟限时与环境覆盖不变', async () => {
  const { internals } = await import('../../dist/src/core/subagent/vendor/executor.js');
  const key = 'PI_SUBAGENT_SCOUT_TIMEOUT_MS';
  const old = process.env[key];
  try {
    delete process.env[key];
    for (const task of ['quick query', 'fast query', '快速查询', '快查']) {
      assert.deepEqual(internals.scoutBudgetForTask('scout', task), { timeoutMs: 3 * 60 * 1000, maxToolCalls: 50 });
    }
    assert.deepEqual(internals.agentBudgetForTask('scout', '普通查询'), { timeoutMs: 8 * 60 * 1000, maxToolCalls: 50 });
    assert.equal(internals.scoutBudgetForTask('worker', 'query'), undefined);
    for (const [configured, expected] of [['50', 50], ['1200', 1200], ['1800000', 1800000], ['49', 8 * 60 * 1000], ['1800001', 8 * 60 * 1000], ['invalid', 8 * 60 * 1000]]) {
      process.env[key] = configured;
      assert.deepEqual(internals.agentBudgetForTask('scout', '普通查询'), { timeoutMs: expected, maxToolCalls: 50 });
    }
  } finally {
    if (old === undefined) delete process.env[key]; else process.env[key] = old;
  }
});

for (const { name, prefix } of [
  { name: '普通任务', prefix: '' },
  { name: '快速任务', prefix: 'quick ' },
]) {
  test(`scout 回归：${name}完成 50 次真实 MCP 调用，第 51 次触发上限`, { timeout: 30000 }, async t => {
    const h = await fixture(t, { toolSmoke: { agent: 'scout', exposure: 'direct', tools: ['read', 'mcp__smoke__probe'] } });
    const seed = randomUUID();
    const count = 50;
    const plan = Array.from({ length: count }, (_, index) => ({ name: 'mcp__smoke__probe', arguments: { token: seed + '-' + index, callerPid: '__CHILD_PID__' } }));
    const smoke = await runToolSmoke(h, plan, { agent: 'scout', taskPrefix: prefix });
    const calls = smoke.audit.filter(row => row.method === 'tools/call');
    assert.equal(calls.length, count, '恰好 50 次调用必须全部完成，不能提前在旧的 10/20 次上限停止');
    for (const [index, call] of calls.entries()) {
      assert.equal(call.parentPid, smoke.observed.pid);
      assert.equal(call.params.name, 'probe');
      assert.deepEqual(call.params.arguments, { token: plan[index].arguments.token, callerPid: smoke.observed.pid });
      assert.equal(smoke.records[index].isError, false);
      assert.ok(JSON.stringify(smoke.records[index]).includes('MCP_TOOL_EXECUTED'));
      assert.ok(JSON.stringify(smoke.records[index]).includes(plan[index].arguments.token));
    }
    assert.equal(smoke.events.filter(row => row.phase === 'result' && row.name === 'mcp__smoke__probe' && row.pid === smoke.observed.pid && row.isError === false).length, count);

    const overPlan = Array.from({ length: 51 }, (_, index) => ({ name: 'mcp__smoke__probe', arguments: { token: seed + '-over-' + index, callerPid: '__CHILD_PID__' } }));
    const receipt = await h.launch({ agent: 'scout', task: prefix + 'TOOL_SMOKE=' + JSON.stringify(overPlan) });
    assert.notEqual(receipt.isError, true, receipt.content[0]?.text);
    const terminal = await h.wait(receipt.details.task.id);
    assert.equal(terminal.status, 'failed');
    assert.match(terminal.error, /Scout exceeded 50 tool calls/);
    const result = await h.call('bg_subagent_result', { taskId: terminal.id });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Scout exceeded 50 tool calls/);
    assert.ok(await readFile(result.details.background.resultPath, 'utf8'));
    const role = result.details.results[0];
    assert.ok(role.transcript);
    const root = process.env.PI_SUBAGENT_RUNS_DIR || path.join(h.agentDir, 'subagent-runs');
    const transcript = await readJsonl(path.join(root, role.transcript.runId + '.jsonl'));
    const attempted = transcript.filter(message => message.role === 'assistant').flatMap(message => message.content.filter(block => block.type === 'toolCall'));
    assert.equal(attempted.length, 51, '必须在第 51 次模型工具调用触发配额，而非超时或其他提前失败');
    const failedPid = (await readJsonl(path.join(h.agentDir, 'pids.jsonl'))).at(-1).pid;
    assert.notEqual(failedPid, smoke.observed.pid);
    assert.throws(() => process.kill(failedPid, 0), error => error.code === 'ESRCH');
    t.diagnostic(`scout ${name}：真实 MCP 完成=50，配额失败阈值=51，失败子进程已退出`);
  });
}

test('scout 回归：执行器内层超时仍终止真实子孙进程并持久化失败', { timeout: 25000 }, async t => {
  const h = await fixture(t);
  const key = 'PI_SUBAGENT_SCOUT_TIMEOUT_MS';
  const old = process.env[key];
  process.env[key] = '5000';
  try {
    // Outer registry timeout is deliberately longer, so this proves the inner budget.
    const receipt = await h.launch({ agent: 'scout', task: 'HANG SCOUT DEADLINE DESCENDANT', timeoutSeconds: 20 });
    assert.notEqual(receipt.isError, true, receipt.content[0]?.text);
    const pid = await h.waitRole();
    const terminal = await h.wait(receipt.details.task.id);
    assert.equal(terminal.status, 'failed');
    assert.match(terminal.error, /Scout exceeded 5s;/);
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    const rows = await readJsonl(path.join(h.agentDir, 'pids.jsonl'));
    assert.ok(rows[0].descendant, '必须实际启动孙进程');
    assert.throws(() => process.kill(rows[0].descendant, 0), error => error.code === 'ESRCH');
    const result = await h.call('bg_subagent_result', { taskId: terminal.id });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Scout exceeded 5s;/);
    assert.ok(await readFile(result.details.background.resultPath, 'utf8'));
  } finally {
    if (old === undefined) delete process.env[key]; else process.env[key] = old;
  }
});

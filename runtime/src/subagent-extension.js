import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { writeFileFsynced } from './core/task-durable.js';
import { executeSubagent, SubagentParams } from './core/subagent/vendor/executor.js';
const Params = Type.Object({
    ...SubagentParams.properties,
    name: Type.Optional(Type.String({ description: '后台角色任务的简短显示名称。' })),
    timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    notifyOnCompletion: Type.Optional(Type.Boolean({ default: true })),
    triggerOnCompletion: Type.Optional(Type.Boolean({ default: true })),
});
const ResultParams = Type.Object({ taskId: Type.String({ minLength: 1 }) });
const RESULT_SCHEMA = 'pi-background-tasks.subagent-result.v1';
const MAX_RESULT_BYTES = 20 * 1024 * 1024;
function text(message) { return [{ type: 'text', text: message }]; }
function message(error) { return error instanceof Error ? error.message : String(error); }
function failed(error) { return { content: text(message(error)), details: {}, isError: true }; }
function isChild() {
    if (process.env['PI_SUBAGENT_CONTEXT'] === '1')
        return true;
    const argv = process.argv;
    return argv.includes('--no-session') && (argv.includes('-p') || argv.includes('--print')) &&
        (argv.includes('--mode=json') || argv.some((value, index) => value === '--mode' && argv[index + 1] === 'json')) &&
        argv.some((value) => value.startsWith('Task: '));
}
function parseRequest(value) {
    if (!Check(SubagentParams, value))
        throw new Error('subagent 参数未通过原生 schema 校验');
    const request = value;
    const modes = Number(Boolean(request.agent && request.task)) + Number(Boolean(request.tasks?.length)) + Number(Boolean(request.chain?.length));
    if (modes !== 1)
        throw new Error('agent/task、tasks、chain 必须且只能提供一种');
    if ((request.tasks?.length ?? 0) > 8)
        throw new Error('并行任务最多 8 项');
    return request;
}
function roles(request) {
    return request.agent ? [request.agent] : (request.tasks ?? request.chain ?? []).map((item) => item.agent);
}
function nativeFailed(result) {
    return result.isError === true || result.details.results.length === 0 || result.details.results.some((item) => item.exitCode !== 0);
}
function validateResult(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const schema = Reflect.get(value, 'schema');
    const owner = Reflect.get(value, 'ownerSessionId');
    const id = Reflect.get(value, 'taskId');
    const result = Reflect.get(value, 'result');
    if (schema !== RESULT_SCHEMA || typeof owner !== 'string' || typeof id !== 'string' || typeof result !== 'object' || result === null)
        return false;
    const content = Reflect.get(result, 'content');
    const details = Reflect.get(result, 'details');
    return Array.isArray(content) && content.every((item) => typeof item === 'object' && item !== null && Reflect.get(item, 'type') === 'text' && typeof Reflect.get(item, 'text') === 'string') &&
        typeof details === 'object' && details !== null && Array.isArray(Reflect.get(details, 'results'));
}
async function readResult(file) {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
        throw new Error('拒绝读取链接或非普通角色结果');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const actual = await handle.stat();
        if (actual.dev !== before.dev || actual.ino !== before.ino || !actual.isFile() || actual.nlink !== 1 || actual.size > MAX_RESULT_BYTES)
            throw new Error('角色结果文件被替换或超过读取上限');
        const bytes = await handle.readFile();
        if (bytes.length > MAX_RESULT_BYTES)
            throw new Error('角色结果超过读取上限');
        return JSON.parse(bytes.toString('utf8'));
    }
    finally {
        await handle.close();
    }
}
export function registerSubagentExtension(pi, services) {
    pi.on('tool_call', (event) => {
        if (!isChild())
            return;
        const input = event.input;
        const forbidden = event.toolName === 'bg_subagent' || event.toolName === 'bg_delegate' || event.toolName === 'bg_run_pi_attested' ||
            event.toolName.startsWith('fusion_') || (event.toolName === 'bg_run' && Reflect.get(input, 'isAgent') === true);
        if (forbidden)
            return { block: true, reason: '子 agent 只允许阻塞式 subagent，禁止后台派发' };
        return;
    });
    pi.on('before_agent_start', (event) => {
        if (!isChild())
            return;
        return { systemPrompt: `${event.systemPrompt}\n\n<subagent_auto_policy>\nenabled: true\nmode: blocking\nchild: true\n子 agent 只允许阻塞式 subagent；没有该工具时自行完成，禁止后台委派。\n</subagent_auto_policy>` };
    });
    pi.registerTool({
        name: 'bg_subagent', label: '后台角色任务',
        description: '原生后台 subagent：只传角色名与任务，包内执行器读取角色配置并执行单任务/并行/chain。立即返回任务 ID，完成通知到达后用 bg_subagent_result 读取；不要轮询。任务不会自动继承当前对话，必须明确提供上下文。',
        parameters: Params,
        async execute(_id, params, signal, _onUpdate, ctx) {
            let cancel;
            try {
                if (isChild())
                    throw new Error('子 agent 只能使用阻塞式 subagent，禁止后台委派');
                const { name, timeoutSeconds, notifyOnCompletion, triggerOnCompletion, ...payload } = params;
                const request = parseRequest(payload);
                const requestedRoles = roles(request);
                // Consent is resolved in the live parent tool context, not after returning the receipt.
                if ((request.agentScope === 'project' || request.agentScope === 'both') && request.confirmProjectAgents !== false) {
                    if (!ctx.hasUI)
                        throw new Error('无 UI 的项目角色必须显式授权 confirmProjectAgents:false');
                    if (!await ctx.ui.confirm('运行项目角色？', `角色：${requestedRoles.join(', ')}\n项目目录：${ctx.cwd}\n仅对可信仓库授权。`))
                        throw new Error('用户未批准项目角色');
                    request.confirmProjectAgents = false;
                }
                if (signal?.aborted)
                    throw new Error('角色任务启动已取消');
                const ownerSessionId = ctx.sessionManager.getSessionId();
                const cwd = ctx.cwd;
                const id = `sa-${randomUUID()}`;
                const controller = new AbortController();
                let release;
                const admitted = new Promise((resolve) => { release = resolve; });
                let task;
                let progress = Promise.resolve();
                let progressFailure;
                let resultPath;
                const run = async () => {
                    await admitted;
                    if (controller.signal.aborted || !task || !resultPath)
                        throw new Error('角色启动已取消');
                    const owned = task;
                    // This is an explicit execution-only snapshot, not a fabricated SDK ExtensionContext.
                    const executionContext = { cwd, sessionManager: { getSessionId: () => ownerSessionId }, hasUI: false,
                        ui: { confirm: async () => false } };
                    let result;
                    try {
                        result = await executeSubagent(id, request, controller.signal, (update) => {
                            const line = update.content.map((item) => item.text).join('\n').slice(0, 8192);
                            progress = progress.then(() => services.updateManagedTask(owned, 'running', line)).catch((error) => {
                                progressFailure = error;
                                controller.abort(error);
                            });
                        }, executionContext);
                    }
                    catch (error) {
                        result = { content: text(message(error)), details: { mode: request.chain ? 'chain' : request.tasks ? 'parallel' : 'single',
                                agentScope: request.agentScope ?? 'user', results: [] }, isError: true };
                    }
                    await progress;
                    if (progressFailure !== undefined)
                        throw new Error(`角色进度持久化失败：${message(progressFailure)}`);
                    const envelope = { schema: RESULT_SCHEMA, taskId: id, ownerSessionId, result };
                    const json = JSON.stringify(envelope);
                    if (Buffer.byteLength(json) > MAX_RESULT_BYTES)
                        throw new Error('角色结果超过持久化上限');
                    await writeFileFsynced(resultPath, json);
                    await services.updateManagedTask(owned, nativeFailed(result) ? 'failed' : 'completed', result.content.map((item) => item.text).join('\n').slice(0, 32768));
                    if (nativeFailed(result))
                        throw new Error(result.content.map((item) => item.text).join('\n').slice(0, 1200));
                };
                const completion = run();
                completion.catch(() => { }); // The registry owns and reports the real failure; prevent a pre-admission unhandled rejection.
                cancel = () => { controller.abort(); release(); };
                const onAbort = () => cancel?.();
                signal?.addEventListener('abort', onAbort, { once: true });
                try {
                    task = await services.startManagedTask(ctx, { id, name: name?.trim() || `角色 ${requestedRoles.join(', ')}`,
                        command: `subagent:${requestedRoles.join(',')}`, isAgent: true, completion, cancel,
                        notifyOnCompletion: notifyOnCompletion ?? true, triggerOnCompletion: triggerOnCompletion ?? true,
                        subagent: { ownerSessionId, roles: requestedRoles, state: 'starting' }, timeoutSeconds, stopWaitMs: 15000 });
                    resultPath = `${task.outputAbsPath}.subagent.json`;
                    if (task.subagent)
                        task.subagent.resultPath = resultPath;
                    await services.updateManagedTask(task, 'admitted');
                    if (signal?.aborted) {
                        cancel();
                        throw new Error('角色启动确认已取消');
                    }
                    const snapshot = services.snapshot(task);
                    release();
                    return { content: text(`已启动后台角色任务 ${id}。等待完成通知，再用 bg_subagent_result 读取原生结果；不要轮询。`), details: { task: snapshot } };
                }
                finally {
                    signal?.removeEventListener('abort', onAbort);
                }
            }
            catch (error) {
                cancel?.();
                return failed(error);
            }
        },
    });
    pi.registerTool({
        name: 'bg_subagent_result', label: '读取后台角色结果',
        description: '读取已完成后台角色任务的原生结果与 transcript 引用。运行中只返回状态，不等待；仅限当前拥有者会话。',
        parameters: ResultParams,
        async execute(_id, params, _signal, _onUpdate, ctx) {
            try {
                const task = services.resolveTask(params.taskId);
                const facts = task.subagent;
                if (!facts || facts.ownerSessionId !== ctx.sessionManager.getSessionId())
                    throw new Error('当前会话不拥有此后台角色任务');
                const snapshot = services.snapshot(task);
                if (task.status === 'running')
                    return { content: text(`任务 ${task.id} 仍在运行；等待完成通知，不要轮询。`), details: { task: snapshot } };
                if (!facts.resultPath)
                    throw new Error('任务终止前未生成完整的角色结果；可用 bg_logs 检查日志');
                const envelope = await readResult(facts.resultPath);
                if (!validateResult(envelope) || envelope.ownerSessionId !== facts.ownerSessionId || envelope.taskId !== task.id)
                    throw new Error('角色结果格式或拥有者不匹配');
                const result = envelope.result;
                return { content: result.content.map((item) => ({ type: 'text', text: item.text.length > 32768 ? `${item.text.slice(0, 32768)}\n[完整结果：${facts.resultPath}]` : item.text })),
                    details: { ...result.details, background: { task: snapshot, resultPath: facts.resultPath } },
                    isError: nativeFailed(result) || task.status !== 'completed' };
            }
            catch (error) {
                return failed(error);
            }
        },
    });
}

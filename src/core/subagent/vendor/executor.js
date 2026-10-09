// Derived from the user-provided local subagent source; see maintenance/subagent-source.
/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { withFileMutationQueue, getPackageDir, } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents } from "./agents.js";
import { createTranscriptRunId, persistTranscript, } from "./transcript-store.js";
import { runWindowsTaskkill } from '../../windows-taskkill.js';
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
// Budgets apply per child process. Only scout has a tool-call limit.
const SCOUT_QUICK_TIMEOUT_MS = 3 * 60 * 1000;
const SCOUT_TIMEOUT_MS = 8 * 60 * 1000;
const SCOUT_QUICK_MAX_TOOL_CALLS = 10;
const SCOUT_MAX_TOOL_CALLS = 20;
const AGENT_TIMEOUT_MS = {
    reviewer: 5 * 60 * 1000,
    planner: 5 * 60 * 1000,
    worker: 10 * 60 * 1000,
};
const PROGRESS_INTERVAL_MS = 5000;
const STREAM_PROGRESS_INTERVAL_MS = 250;
function agentBudgetForTask(agentName, task) {
    const scout = agentName === "scout";
    const quick = scout && /快速|快查|\bquick\b|\bfast\b/i.test(task);
    const defaultTimeout = scout ? (quick ? SCOUT_QUICK_TIMEOUT_MS : SCOUT_TIMEOUT_MS) : AGENT_TIMEOUT_MS[agentName];
    if (typeof defaultTimeout !== "number")
        return undefined;
    const configuredTimeout = Number(process.env[`PI_SUBAGENT_${agentName.toUpperCase()}_TIMEOUT_MS`]);
    return {
        timeoutMs: Number.isInteger(configuredTimeout) && configuredTimeout >= 50 && configuredTimeout <= 30 * 60 * 1000
            ? configuredTimeout : defaultTimeout,
        ...(scout ? { maxToolCalls: quick ? SCOUT_QUICK_MAX_TOOL_CALLS : SCOUT_MAX_TOOL_CALLS } : {}),
    };
}
// Keep the existing scout-only helper for compatibility with callers/tests.
function scoutBudgetForTask(agentName, task) {
    return agentName === "scout" ? agentBudgetForTask(agentName, task) : undefined;
}
function formatTokens(count) {
    if (count < 1000)
        return count.toString();
    if (count < 10000)
        return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000)
        return `${Math.round(count / 1000)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
}
function formatUsageStats(usage, model) {
    const parts = [];
    if (usage.turns)
        parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
    if (usage.input)
        parts.push(`↑${formatTokens(usage.input)}`);
    if (usage.output)
        parts.push(`↓${formatTokens(usage.output)}`);
    if (usage.cacheRead)
        parts.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite)
        parts.push(`W${formatTokens(usage.cacheWrite)}`);
    if (usage.cost)
        parts.push(`$${usage.cost.toFixed(4)}`);
    if (usage.contextTokens && usage.contextTokens > 0) {
        parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
    }
    if (model)
        parts.push(model);
    return parts.join(" ");
}
function formatToolCall(toolName, args, themeFg) {
    const shortenPath = (p) => {
        const home = os.homedir();
        return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
    };
    switch (toolName) {
        case "bash": {
            const command = args.command || "...";
            const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
            return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
        }
        case "read": {
            const rawPath = (args.file_path || args.path || "...");
            const filePath = shortenPath(rawPath);
            const offset = args.offset;
            const limit = args.limit;
            let text = themeFg("accent", filePath);
            if (offset !== undefined || limit !== undefined) {
                const startLine = offset ?? 1;
                const endLine = limit !== undefined ? startLine + limit - 1 : "";
                text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
            }
            return themeFg("muted", "read ") + text;
        }
        case "write": {
            const rawPath = (args.file_path || args.path || "...");
            const filePath = shortenPath(rawPath);
            const content = (args.content || "");
            const lines = content.split("\n").length;
            let text = themeFg("muted", "write ") + themeFg("accent", filePath);
            if (lines > 1)
                text += themeFg("dim", ` (${lines} lines)`);
            return text;
        }
        case "edit": {
            const rawPath = (args.file_path || args.path || "...");
            return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
        }
        case "ls": {
            const rawPath = (args.path || ".");
            return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
        }
        case "find": {
            const pattern = (args.pattern || "*");
            const rawPath = (args.path || ".");
            return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
        }
        case "grep": {
            const pattern = (args.pattern || "");
            const rawPath = (args.path || ".");
            return (themeFg("muted", "grep ") +
                themeFg("accent", `/${pattern}/`) +
                themeFg("dim", ` in ${shortenPath(rawPath)}`));
        }
        default: {
            const argsStr = JSON.stringify(args);
            const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
            return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
        }
    }
}
function getFinalOutput(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
            const text = msg.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
            if (text)
                return text;
        }
    }
    return "";
}
function isFailedResult(result) {
    return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}
function getResultOutput(result) {
    if (isFailedResult(result)) {
        return result.errorMessage || result.stderr || result.finalOutput || getFinalOutput(result.messages) || "(no output)";
    }
    return result.finalOutput || getFinalOutput(result.messages) || "(no output)";
}
function truncateParallelOutput(output) {
    const byteLength = Buffer.byteLength(output, "utf8");
    if (byteLength <= PER_TASK_OUTPUT_CAP)
        return output;
    let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
    while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
        truncated = truncated.slice(0, -1);
    }
    return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output is preserved in the external subagent transcript.]`;
}
function getDisplayItems(messages) {
    const items = [];
    for (const msg of messages) {
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text")
                    items.push({ type: "text", text: part.text });
                else if (part.type === "toolCall")
                    items.push({ type: "toolCall", name: part.name, args: part.arguments });
            }
        }
    }
    return items;
}
function appendActivity(result, value) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized)
        return;
    result.activity.push(normalized.length > 240 ? `${normalized.slice(0, 240)}…` : normalized);
    if (result.activity.length > 20)
        result.activity.splice(0, result.activity.length - 20);
}
function captureMessage(result, message) {
    result.messageCount = result.messages.length;
    if (message.role === "assistant") {
        const textParts = [];
        for (const part of message.content) {
            if (part.type === "text") {
                textParts.push(part.text);
                result.previewItems.push({ type: "text", text: part.text });
                const lines = part.text.split(/\r?\n/).filter((line) => line.trim());
                for (const line of lines.slice(-2))
                    appendActivity(result, line);
            }
            else if (part.type === "toolCall") {
                result.previewItems.push({ type: "toolCall", name: part.name, args: part.arguments });
                appendActivity(result, `→ ${part.name}`);
            }
        }
        if (textParts.length > 0)
            result.finalOutput = textParts.join("\n");
    }
    else if (message.role === "toolResult") {
        appendActivity(result, `→ ${message.toolName || "tool"} ✓`);
    }
    if (result.previewItems.length > 20)
        result.previewItems.splice(0, result.previewItems.length - 20);
}
function boundedDetailText(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    const tailChars = Math.min(2048, Math.floor(maxChars / 4));
    const headChars = maxChars - tailChars;
    return `${text.slice(0, headChars)}\n\n[${text.length - maxChars} characters omitted from session details; use subagent_inspect for the raw record.]\n\n${text.slice(-tailChars)}`;
}
function compactToolValue(value, depth = 0) {
    if (typeof value === "string")
        return boundedDetailText(value, 1000);
    if (value === null || typeof value === "number" || typeof value === "boolean")
        return value;
    if (typeof value !== "object")
        return String(value);
    if (depth >= 2)
        return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
    if (Array.isArray(value)) {
        const compact = value.slice(0, 20).map((item) => compactToolValue(item, depth + 1));
        if (value.length > 20)
            compact.push(`[${value.length - 20} more items]`);
        return compact;
    }
    const entries = Object.entries(value);
    const compact = {};
    for (const [key, item] of entries.slice(0, 20))
        compact[key] = compactToolValue(item, depth + 1);
    if (entries.length > 20)
        compact.__omittedKeys = entries.length - 20;
    return compact;
}
function compactToolArgs(args) {
    return compactToolValue(args);
}
function compactResult(result) {
    return {
        agent: result.agent,
        agentSource: result.agentSource,
        task: boundedDetailText(result.task, 8000),
        exitCode: result.exitCode,
        messageCount: result.messageCount,
        finalOutput: boundedDetailText(result.finalOutput, 32 * 1024),
        previewItems: result.previewItems.map((item) => item.type === "text"
            ? { type: "text", text: boundedDetailText(item.text, 4000) }
            : { type: "toolCall", name: item.name, args: compactToolArgs(item.args) }),
        activity: [...result.activity],
        progress: result.progress,
        runId: result.runId,
        transcript: result.transcript,
        transcriptError: result.transcriptError,
        stderr: result.stderr.slice(-4000),
        usage: { ...result.usage },
        model: result.model,
        stopReason: result.stopReason,
        errorMessage: result.errorMessage ? boundedDetailText(result.errorMessage, 4000) : undefined,
        step: result.step,
    };
}
function detailsDisplayItems(result) {
    if (Array.isArray(result.previewItems))
        return result.previewItems;
    return Array.isArray(result.messages) ? getDisplayItems(result.messages) : [];
}
function detailsFinalOutput(result) {
    if (typeof result.finalOutput === "string" && result.finalOutput)
        return result.finalOutput;
    return Array.isArray(result.messages) ? getFinalOutput(result.messages) : "";
}
function transcriptHint(result) {
    return result.transcript
        ? `\n\n[Raw subagent transcript: ${result.transcript.runId}. Use subagent_inspect to search or read records.]`
        : result.transcriptError
            ? `\n\n[Raw transcript could not be stored: ${result.transcriptError}]`
            : "";
}
function transcriptRefsHint(results) {
    const refs = results.filter((result) => result.transcript).map((result) => `${result.agent}: ${result.transcript.runId}`);
    return refs.length > 0 ? `\n\nRaw subagent transcripts:\n${refs.map((ref) => `- ${ref}`).join("\n")}\nUse subagent_inspect to search or read records.` : "";
}
async function persistResultTranscript(result, sessionId) {
    if (!result.runId)
        return;
    try {
        result.transcript = await persistTranscript({
            runId: result.runId,
            sessionId,
            agent: result.agent,
            task: result.task,
            model: result.model,
            exitCode: result.exitCode,
            stopReason: result.stopReason,
            errorMessage: result.errorMessage,
            stderr: result.stderr || undefined,
            progress: result.progress,
        }, result.messages);
        result.messages = [];
    }
    catch (error) {
        result.transcriptError = error instanceof Error ? error.message : String(error);
    }
}
async function mapWithConcurrencyLimit(items, concurrency, fn) {
    if (items.length === 0)
        return [];
    const limit = Math.max(1, Math.min(concurrency, items.length));
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = new Array(limit).fill(null).map(async () => {
        while (true) {
            const current = nextIndex++;
            if (current >= items.length)
                return;
            results[current] = await fn(items[current], current);
        }
    });
    await Promise.all(workers);
    return results;
}
async function writePromptToTempFile(agentName, prompt) {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
    const safeName = agentName.replace(/[^\w.-]+/g, "_");
    const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
    await withFileMutationQueue(filePath, async () => {
        await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
    });
    return { dir: tmpDir, filePath };
}
function getPiInvocation(args) {
    const hostDir = getPackageDir();
    const manifest = JSON.parse(fs.readFileSync(path.join(hostDir, 'package.json'), 'utf8'));
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[manifest.piConfig?.name ?? 'pi'];
    if (typeof bin === 'string') {
        const cli = path.resolve(hostDir, bin);
        if (fs.existsSync(cli)) return { command: process.execPath, args: [cli, ...args] };
    }
    const execName = path.basename(process.execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (!isGenericRuntime) {
        return { command: process.execPath, args };
    }
    return { command: "pi", args };
}
async function runSingleAgent(defaultCwd, agents, agentName, task, cwd, step, runId, signal, onProgress) {
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) {
        const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
        return {
            agent: agentName,
            agentSource: "unknown",
            task,
            exitCode: 1,
            messages: [],
            messageCount: 0,
            finalOutput: "",
            previewItems: [],
            activity: [],
            runId,
            stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            step,
        };
    }
    const budget = agentBudgetForTask(agentName, task);
    const args = ["--mode", "json", "-p", "--no-session"];
    if (agent.model)
        args.push("--model", agent.model);
    if (agent.tools && agent.tools.length > 0)
        args.push("--tools", agent.tools.join(","));
    let tmpPromptDir = null;
    let tmpPromptPath = null;
    const startedAt = Date.now();
    let phase = "启动子代理";
    let lastActivePhase = phase;
    let stopping = false;
    let lastProgressAt = 0;
    let pendingAssistant;
    const currentResult = {
        agent: agentName,
        agentSource: agent.source,
        task,
        exitCode: -1,
        messages: [],
        messageCount: 0,
        finalOutput: "",
        previewItems: [],
        activity: [],
        runId,
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        model: agent.model,
        step,
    };
    const emitUpdate = (force = false) => {
        const now = Date.now();
        const limit = budget ? ` / 上限 ${budget.timeoutMs / 1000} 秒` : "";
        if (!stopping)
            lastActivePhase = phase;
        currentResult.progress = `${phase} · 已运行 ${Math.floor((now - startedAt) / 1000)} 秒${limit}${stopping ? ` · 最后阶段：${lastActivePhase}` : ""}`;
        if (!force && now - lastProgressAt < STREAM_PROGRESS_INTERVAL_MS)
            return;
        lastProgressAt = now;
        onProgress?.(currentResult);
    };
    const recordMessage = (message) => {
        // Native message_end and legacy tool_result_end can describe the same tool result.
        if (message.role === "toolResult" && message.toolCallId && currentResult.messages.some((item) => item.role === "toolResult" && item.toolCallId === message.toolCallId))
            return;
        currentResult.messages.push(message);
        captureMessage(currentResult, message);
    };
    const markAborted = () => {
        stopping = true;
        currentResult.exitCode = 1;
        currentResult.stopReason = "aborted";
        currentResult.errorMessage = "Subagent was aborted";
        phase = "已中断";
        appendActivity(currentResult, currentResult.errorMessage);
    };
    if (signal?.aborted) {
        markAborted();
        emitUpdate(true);
        return currentResult;
    }
    try {
        if (agent.systemPrompt.trim()) {
            const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
            tmpPromptDir = tmp.dir;
            tmpPromptPath = tmp.filePath;
            args.push("--append-system-prompt", tmpPromptPath);
        }
        args.push(`Task: ${task}`);
        let wasAborted = false;
        let budgetExceeded;
        const exitCode = await new Promise((resolve) => {
            if (signal?.aborted) { wasAborted = true; resolve(-1); return; }
            const invocation = getPiInvocation(args);
            const proc = spawn(invocation.command, invocation.args, {
                cwd: cwd ?? defaultCwd,
                shell: false,
                detached: process.platform !== 'win32',
                env: { ...process.env, PI_SUBAGENT_CONTEXT: '1' },
                stdio: ["ignore", "pipe", "pipe"],
            });
            // Preserve UTF-8 characters split across stdout/stderr chunks.
            proc.stdout.setEncoding("utf8");
            proc.stderr.setEncoding("utf8");
            let buffer = "";
            let toolCallCount = 0;
            let finished = false;
            let timeout;
            let heartbeat;
            let forceTimeout;
            let abortHandler;
            let killRequested = false;
            let killCleanup = Promise.resolve();
            const stopChild = () => {
                if (finished || killRequested) return;
                stopping = true;
                killRequested = true;
                if (process.platform === 'win32' && proc.pid) {
                    killCleanup = runWindowsTaskkill(proc.pid, 'force').then((outcome) => {
                        if (outcome.exitCode !== 0) {
                            try { process.kill(proc.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; }
                            budgetExceeded ??= `Role process-tree cleanup unconfirmed: ${outcome.stderr}`;
                        }
                    }).catch((error) => { budgetExceeded ??= `Role process-tree cleanup failed: ${error.message}`; proc.kill('SIGKILL'); });
                } else if (proc.pid) {
                    try { process.kill(-proc.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') proc.kill('SIGTERM'); }
                    forceTimeout ??= setTimeout(() => {
                        try { process.kill(-proc.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH' && !finished) proc.kill('SIGKILL'); }
                    }, 1000);
                }
            };
            const finish = (code) => {
                if (finished)
                    return;
                finished = true;
                if (killRequested && process.platform !== 'win32' && proc.pid) {
                    try { process.kill(-proc.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') budgetExceeded ??= `Role process-group cleanup failed: ${error.message}`; }
                }
                if (timeout)
                    clearTimeout(timeout);
                if (heartbeat)
                    clearInterval(heartbeat);
                if (forceTimeout)
                    clearTimeout(forceTimeout);
                if (signal && abortHandler)
                    signal.removeEventListener("abort", abortHandler);
                killCleanup.then(() => resolve(budgetExceeded && code === 0 ? -1 : code));
            };
            const processLine = (line) => {
                if (!line.trim())
                    return;
                let event;
                try {
                    event = JSON.parse(line);
                }
                catch {
                    return;
                }
                if (!event || typeof event !== "object")
                    return;
                if (event.type === "message_start" && event.message?.role === "assistant") {
                    pendingAssistant = structuredClone(event.message);
                    phase = "等待模型响应";
                    emitUpdate();
                }
                if (event.type === "message_update") {
                    // Pi JSON mode emits deltas, not cumulative partial snapshots.
                    const delta = event.assistantMessageEvent;
                    const cumulative = event.message?.role === "assistant";
                    if (cumulative)
                        pendingAssistant = structuredClone(event.message);
                    pendingAssistant ??= { role: "assistant", content: [], timestamp: Date.now() };
                    if (event.usage)
                        pendingAssistant.usage = event.usage;
                    const index = delta?.contentIndex;
                    if (!cumulative && Number.isInteger(index) && index >= 0 && index <= pendingAssistant.content.length) {
                        if (delta.type === "text_start" || delta.type === "thinking_start") {
                            pendingAssistant.content[index] = delta.type === "text_start"
                                ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
                        }
                        else if (delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "text_end" || delta.type === "thinking_end") {
                            const thinking = delta.type.startsWith("thinking");
                            const field = thinking ? "thinking" : "text";
                            const block = pendingAssistant.content[index] ??= { type: thinking ? "thinking" : "text", [field]: "" };
                            if (delta.type.endsWith("_end"))
                                block[field] = delta.content ?? block[field];
                            else
                                block[field] += delta.delta ?? "";
                        }
                        else if (delta.type === "toolcall_start") {
                            pendingAssistant.content[index] = { type: "toolCall", id: delta.id, name: delta.toolName, arguments: {}, partialArguments: "" };
                        }
                        else if (delta.type === "toolcall_delta" && pendingAssistant.content[index]) {
                            pendingAssistant.content[index].partialArguments = (pendingAssistant.content[index].partialArguments ?? "") + (delta.delta ?? "");
                        }
                        else if (delta.type === "toolcall_end" && delta.toolCall) {
                            pendingAssistant.content[index] = delta.toolCall;
                        }
                    }
                    phase = delta?.type?.startsWith("thinking") ? "模型推理中"
                        : delta?.type?.startsWith("toolcall") ? "生成工具调用" : "模型输出中";
                    emitUpdate();
                }
                if (event.type === "message_end" && event.message) {
                    const msg = event.message;
                    recordMessage(msg);
                    if (msg.role === "assistant") {
                        pendingAssistant = undefined;
                        if (budget?.maxToolCalls !== undefined) {
                            toolCallCount += msg.content.filter((part) => part.type === "toolCall").length;
                            if (toolCallCount > budget.maxToolCalls && !budgetExceeded) {
                                budgetExceeded = `Scout exceeded ${budget.maxToolCalls} tool calls; narrow or split the task.`;
                                stopChild();
                            }
                        }
                        currentResult.usage.turns++;
                        const usage = msg.usage;
                        if (usage) {
                            currentResult.usage.input += usage.input || 0;
                            currentResult.usage.output += usage.output || 0;
                            currentResult.usage.cacheRead += usage.cacheRead || 0;
                            currentResult.usage.cacheWrite += usage.cacheWrite || 0;
                            currentResult.usage.cost += usage.cost?.total || 0;
                            currentResult.usage.contextTokens = usage.totalTokens || 0;
                        }
                        if (!currentResult.model && msg.model)
                            currentResult.model = msg.model;
                        if (msg.stopReason)
                            currentResult.stopReason = msg.stopReason;
                        if (msg.errorMessage)
                            currentResult.errorMessage = msg.errorMessage;
                    }
                    phase = "等待下一步";
                    emitUpdate(true);
                }
                if (event.type === "tool_result_end" && event.message) {
                    recordMessage(event.message);
                    phase = "工具完成，等待模型";
                    emitUpdate(true);
                }
                if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
                    phase = `工具 ${event.toolName || "tool"} 执行中`;
                    emitUpdate();
                }
                if (event.type === "tool_execution_end") {
                    if (event.result)
                        recordMessage({
                            role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName,
                            ...event.result, isError: event.isError === true, timestamp: Date.now(),
                        });
                    phase = "工具完成，等待模型";
                    emitUpdate(true);
                }
                if (event.type === "auto_retry_start") {
                    phase = `模型请求重试（第 ${event.attempt} 次）`;
                    emitUpdate(true);
                }
            };
            proc.stdout.on("data", (data) => {
                buffer += data;
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines)
                    processLine(line);
            });
            proc.stderr.on("data", (data) => { currentResult.stderr += data; });
            proc.on("close", (code) => {
                if (buffer.trim())
                    processLine(buffer);
                finish(code ?? 1);
            });
            proc.on("error", (error) => {
                currentResult.errorMessage = error.message;
                currentResult.stderr += `${error.message}\n`;
                finish(1);
            });
            if (signal) {
                abortHandler = () => {
                    if (finished || budgetExceeded)
                        return;
                    wasAborted = true;
                    stopping = true;
                    phase = "中断停止中";
                    emitUpdate(true);
                    stopChild();
                };
                if (signal.aborted)
                    abortHandler();
                else
                    signal.addEventListener("abort", abortHandler, { once: true });
            }
            if (budget && !finished && !wasAborted) {
                timeout = setTimeout(() => {
                    const label = agentName === "scout" ? "Scout" : agentName;
                    budgetExceeded = `${label} exceeded ${budget.timeoutMs / 1000}s; narrow or split the task.`;
                    stopping = true;
                    phase = "超时停止中";
                    emitUpdate(true);
                    stopChild();
                }, budget.timeoutMs);
            }
            phase = wasAborted ? "中断停止中" : "等待模型响应";
            emitUpdate(true);
            if (onProgress && !finished)
                heartbeat = setInterval(() => emitUpdate(true), PROGRESS_INTERVAL_MS);
        });
        currentResult.exitCode = exitCode;
        if (wasAborted) {
            // Return a failed result instead of throwing so runAndPersist can save it.
            markAborted();
        }
        else if (budgetExceeded) {
            currentResult.exitCode = 1;
            currentResult.stopReason = "error";
            currentResult.errorMessage = budgetExceeded;
            phase = "已超出限制";
            appendActivity(currentResult, budgetExceeded);
        }
        else if (pendingAssistant) {
            currentResult.exitCode = 1;
            currentResult.stopReason = "error";
            currentResult.errorMessage ||= "Subagent exited before the assistant message completed";
            phase = "异常结束";
        }
        else {
            phase = isFailedResult(currentResult) ? "异常结束" : "已完成";
        }
        if (pendingAssistant) {
            pendingAssistant.stopReason = currentResult.stopReason;
            pendingAssistant.errorMessage = currentResult.errorMessage;
            recordMessage(pendingAssistant);
        }
        emitUpdate(true);
        return currentResult;
    }
    finally {
        if (tmpPromptPath)
            try {
                fs.unlinkSync(tmpPromptPath);
            }
            catch {
                /* ignore */
            }
        if (tmpPromptDir)
            try {
                fs.rmdirSync(tmpPromptDir);
            }
            catch {
                /* ignore */
            }
    }
}
const TaskItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task to delegate to the agent" }),
    cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});
const ChainItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
    cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});
const AgentScopeSchema = StringEnum(["user", "project", "both"], {
    description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
    default: "user",
});
const SubagentParams = Type.Object({
    agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
    task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
    tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
    chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
    agentScope: Type.Optional(AgentScopeSchema),
    confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true })),
    cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});
const InspectActionSchema = StringEnum(["list", "search", "read"], {
    description: "List records, search raw records, or read one raw record with character pagination.",
    default: "list",
});
const SubagentInspectParams = Type.Object({
    action: Type.Optional(InspectActionSchema),
    runId: Type.String({ description: "Transcript run ID returned by the subagent tool" }),
    query: Type.Optional(Type.String({ description: "Case-insensitive raw JSON search query for search mode" })),
    recordOffset: Type.Optional(Type.Integer({ minimum: 0, description: "Matched-record offset for list/search mode" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum records for list/search mode" })),
    record: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based record index for read mode" })),
    charOffset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset within the selected raw record" })),
    maxChars: Type.Optional(Type.Integer({ minimum: 100, maximum: 50 * 1024, description: "Maximum raw characters returned by read mode" })),
});
export const internals = {
    scoutBudgetForTask,
    agentBudgetForTask,
    PROGRESS_INTERVAL_MS,
    compactResult,
    detailsDisplayItems,
    detailsFinalOutput,
};
export { SubagentParams };
export async function executeSubagent(_toolCallId, params, signal, onUpdate, ctx) {
    const agentScope = params.agentScope ?? "user";
    const discovery = discoverAgents(ctx.cwd, agentScope);
    const agents = discovery.agents;
    const confirmProjectAgents = params.confirmProjectAgents ?? true;
    const hasChain = (params.chain?.length ?? 0) > 0;
    const hasTasks = (params.tasks?.length ?? 0) > 0;
    const hasSingle = Boolean(params.agent && params.task);
    const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
    const sessionId = ctx.sessionManager.getSessionId();
    const makeDetails = (mode) => (results) => ({
        mode,
        agentScope,
        projectAgentsDir: discovery.projectAgentsDir,
        results: results.map(compactResult),
    });
    const runAndPersist = async (agentName, task, cwd, step, onProgress) => {
        const result = await runSingleAgent(ctx.cwd, agents, agentName, task, cwd, step, createTranscriptRunId(sessionId), signal, onProgress);
        await persistResultTranscript(result, sessionId);
        return result;
    };
    if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
            content: [
                {
                    type: "text",
                    text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
                },
            ],
            details: makeDetails("single")([]),
        };
    }
    if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
        const requestedAgentNames = new Set();
        if (params.chain)
            for (const step of params.chain)
                requestedAgentNames.add(step.agent);
        if (params.tasks)
            for (const t of params.tasks)
                requestedAgentNames.add(t.agent);
        if (params.agent)
            requestedAgentNames.add(params.agent);
        const projectAgentsRequested = Array.from(requestedAgentNames)
            .map((name) => agents.find((a) => a.name === name))
            .filter((a) => a?.source === "project");
        if (projectAgentsRequested.length > 0) {
            const names = projectAgentsRequested.map((a) => a.name).join(", ");
            const dir = discovery.projectAgentsDir ?? "(unknown)";
            const ok = await ctx.ui.confirm("Run project-local agents?", `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`);
            if (!ok)
                return {
                    content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
                    details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
                };
        }
    }
    if (params.chain && params.chain.length > 0) {
        const results = [];
        let previousOutput = "";
        for (let i = 0; i < params.chain.length; i++) {
            const step = params.chain[i];
            const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
            const chainProgress = onUpdate
                ? (currentResult) => {
                    onUpdate({
                        content: [{ type: "text", text: currentResult.progress || currentResult.finalOutput || "(running...)" }],
                        details: makeDetails("chain")([...results, currentResult]),
                    });
                }
                : undefined;
            const result = await runAndPersist(step.agent, taskWithContext, step.cwd, i + 1, chainProgress);
            results.push(result);
            const isError = isFailedResult(result);
            if (isError) {
                const errorMsg = getResultOutput(result);
                return {
                    content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}${transcriptHint(result)}` }],
                    details: makeDetails("chain")(results),
                    isError: true,
                };
            }
            previousOutput = result.finalOutput;
        }
        const finalOutput = results[results.length - 1]?.finalOutput || "(no output)";
        return {
            content: [{ type: "text", text: `${finalOutput}${transcriptRefsHint(results)}` }],
            details: makeDetails("chain")(results),
        };
    }
    if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS)
            return {
                content: [
                    {
                        type: "text",
                        text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                    },
                ],
                details: makeDetails("parallel")([]),
            };
        // Track all results for streaming updates
        const allResults = new Array(params.tasks.length);
        // Initialize placeholder results
        for (let i = 0; i < params.tasks.length; i++) {
            allResults[i] = {
                agent: params.tasks[i].agent,
                agentSource: "unknown",
                task: params.tasks[i].task,
                exitCode: -1, // -1 = still running
                messages: [],
                messageCount: 0,
                finalOutput: "",
                previewItems: [],
                activity: [],
                stderr: "",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            };
        }
        const emitParallelUpdate = () => {
            if (onUpdate) {
                const running = allResults.filter((r) => r.exitCode === -1).length;
                const done = allResults.filter((r) => r.exitCode !== -1).length;
                onUpdate({
                    content: [
                        { type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...${allResults.filter((r) => r.progress).map((r) => `\n${r.agent}: ${r.progress}`).join("")}` },
                    ],
                    details: makeDetails("parallel")([...allResults]),
                });
            }
        };
        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
            const result = await runAndPersist(t.agent, t.task, t.cwd, undefined, (currentResult) => {
                allResults[index] = currentResult;
                emitParallelUpdate();
            });
            allResults[index] = result;
            emitParallelUpdate();
            return result;
        });
        const successCount = results.filter((r) => !isFailedResult(r)).length;
        const summaries = results.map((r) => {
            const output = truncateParallelOutput(getResultOutput(r));
            const status = isFailedResult(r)
                ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
                : "completed";
            return `### [${r.agent}] ${status}\n\n${output}${transcriptHint(r)}`;
        });
        return {
            content: [
                {
                    type: "text",
                    text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
                },
            ],
            details: makeDetails("parallel")(results),
        };
    }
    if (params.agent && params.task) {
        const singleProgress = onUpdate
            ? (currentResult) => {
                onUpdate({
                    content: [{ type: "text", text: currentResult.progress || currentResult.finalOutput || "(running...)" }],
                    details: makeDetails("single")([currentResult]),
                });
            }
            : undefined;
        const result = await runAndPersist(params.agent, params.task, params.cwd, undefined, singleProgress);
        const isError = isFailedResult(result);
        if (isError) {
            const errorMsg = getResultOutput(result);
            return {
                content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}${transcriptHint(result)}` }],
                details: makeDetails("single")([result]),
                isError: true,
            };
        }
        return {
            content: [{ type: "text", text: `${result.finalOutput || "(no output)"}${transcriptHint(result)}` }],
            details: makeDetails("single")([result]),
        };
    }
    const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
    return {
        content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
        details: makeDetails("single")([]),
    };
}

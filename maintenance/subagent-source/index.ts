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
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
createTranscriptRunId,
listTranscript,
persistTranscript,
readTranscriptRecord,
type TranscriptRef,
} from "./transcript-store.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

// Budgets apply per child process. Only scout has a tool-call limit.
const SCOUT_QUICK_TIMEOUT_MS = 3 * 60 * 1000;
const SCOUT_TIMEOUT_MS = 8 * 60 * 1000;
const SCOUT_QUICK_MAX_TOOL_CALLS = 10;
const SCOUT_MAX_TOOL_CALLS = 20;
const AGENT_TIMEOUT_MS: Record<string, number> = {
	reviewer: 5 * 60 * 1000,
	planner: 5 * 60 * 1000,
	worker: 10 * 60 * 1000,
};
const PROGRESS_INTERVAL_MS = 5000;
const STREAM_PROGRESS_INTERVAL_MS = 250;

type AgentBudget = { timeoutMs: number; maxToolCalls?: number };

function agentBudgetForTask(agentName: string, task: string): AgentBudget | undefined {
	const scout = agentName === "scout";
	const quick = scout && /快速|快查|\bquick\b|\bfast\b/i.test(task);
	const defaultTimeout = scout ? (quick ? SCOUT_QUICK_TIMEOUT_MS : SCOUT_TIMEOUT_MS) : AGENT_TIMEOUT_MS[agentName];
	if (typeof defaultTimeout !== "number") return undefined;
	const configuredTimeout = Number(process.env[`PI_SUBAGENT_${agentName.toUpperCase()}_TIMEOUT_MS`]);
	return {
		timeoutMs: Number.isInteger(configuredTimeout) && configuredTimeout >= 50 && configuredTimeout <= 30 * 60 * 1000
			? configuredTimeout : defaultTimeout,
		...(scout ? { maxToolCalls: quick ? SCOUT_QUICK_MAX_TOOL_CALLS : SCOUT_MAX_TOOL_CALLS } : {}),
	};
}

// Keep the existing scout-only helper for compatibility with callers/tests.
function scoutBudgetForTask(agentName: string, task: string): AgentBudget | undefined {
	return agentName === "scout" ? agentBudgetForTask(agentName, task) : undefined;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	messageCount: number;
	finalOutput: string;
	previewItems: DisplayItem[];
	activity: string[];
	progress?: string;
	runId?: string;
	transcript?: TranscriptRef;
	transcriptError?: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SingleResultDetails {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messageCount: number;
	finalOutput: string;
	previewItems: DisplayItem[];
	activity: string[];
	progress?: string;
	runId?: string;
	transcript?: TranscriptRef;
	transcriptError?: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Backward compatibility for tool results saved before external transcript storage. */
	messages?: Message[];
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResultDetails[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const text = msg.content
				.filter((part): part is Extract<(typeof msg.content)[number], { type: "text" }> => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (text) return text;
		}
	}
	return "";
}

function isFailedResult(result: { exitCode: number; stopReason?: string }): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || result.finalOutput || getFinalOutput(result.messages) || "(no output)";
	}
	return result.finalOutput || getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output is preserved in the external subagent transcript.]`;
}


function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function appendActivity(result: SingleResult, value: string): void {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return;
	result.activity.push(normalized.length > 240 ? `${normalized.slice(0, 240)}…` : normalized);
	if (result.activity.length > 20) result.activity.splice(0, result.activity.length - 20);
}

function captureMessage(result: SingleResult, message: Message): void {
	result.messageCount = result.messages.length;
	if (message.role === "assistant") {
		const textParts: string[] = [];
		for (const part of message.content) {
			if (part.type === "text") {
				textParts.push(part.text);
				result.previewItems.push({ type: "text", text: part.text });
				const lines = part.text.split(/\r?\n/).filter((line) => line.trim());
				for (const line of lines.slice(-2)) appendActivity(result, line);
			} else if (part.type === "toolCall") {
				result.previewItems.push({ type: "toolCall", name: part.name, args: part.arguments });
				appendActivity(result, `→ ${part.name}`);
			}
		}
		if (textParts.length > 0) result.finalOutput = textParts.join("\n");
	} else if (message.role === "toolResult") {
		appendActivity(result, `→ ${message.toolName || "tool"} ✓`);
	}
	if (result.previewItems.length > 20) result.previewItems.splice(0, result.previewItems.length - 20);
}

function boundedDetailText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const tailChars = Math.min(2048, Math.floor(maxChars / 4));
	const headChars = maxChars - tailChars;
	return `${text.slice(0, headChars)}\n\n[${text.length - maxChars} characters omitted from session details; use subagent_inspect for the raw record.]\n\n${text.slice(-tailChars)}`;
}

function compactToolValue(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return boundedDetailText(value, 1000);
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value !== "object") return String(value);
	if (depth >= 2) return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
	if (Array.isArray(value)) {
		const compact = value.slice(0, 20).map((item) => compactToolValue(item, depth + 1));
		if (value.length > 20) compact.push(`[${value.length - 20} more items]`);
		return compact;
	}
	const entries = Object.entries(value as Record<string, unknown>);
	const compact: Record<string, unknown> = {};
	for (const [key, item] of entries.slice(0, 20)) compact[key] = compactToolValue(item, depth + 1);
	if (entries.length > 20) compact.__omittedKeys = entries.length - 20;
	return compact;
}

function compactToolArgs(args: Record<string, any>): Record<string, any> {
	return compactToolValue(args) as Record<string, any>;
}

function compactResult(result: SingleResult): SingleResultDetails {
	return {
		agent: result.agent,
		agentSource: result.agentSource,
		task: boundedDetailText(result.task, 8000),
		exitCode: result.exitCode,
		messageCount: result.messageCount,
		finalOutput: boundedDetailText(result.finalOutput, 32 * 1024),
		previewItems: result.previewItems.map((item) =>
			item.type === "text"
				? { type: "text" as const, text: boundedDetailText(item.text, 4000) }
				: { type: "toolCall" as const, name: item.name, args: compactToolArgs(item.args) },
		),
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

function detailsDisplayItems(result: SingleResultDetails): DisplayItem[] {
	if (Array.isArray(result.previewItems)) return result.previewItems;
	return Array.isArray(result.messages) ? getDisplayItems(result.messages) : [];
}

function detailsFinalOutput(result: SingleResultDetails): string {
	if (typeof result.finalOutput === "string" && result.finalOutput) return result.finalOutput;
	return Array.isArray(result.messages) ? getFinalOutput(result.messages) : "";
}

function transcriptHint(result: SingleResult): string {
	return result.transcript
		? `\n\n[Raw subagent transcript: ${result.transcript.runId}. Use subagent_inspect to search or read records.]`
		: result.transcriptError
			? `\n\n[Raw transcript could not be stored: ${result.transcriptError}]`
			: "";
}

function transcriptRefsHint(results: SingleResult[]): string {
	const refs = results.filter((result) => result.transcript).map((result) => `${result.agent}: ${result.transcript!.runId}`);
	return refs.length > 0 ? `\n\nRaw subagent transcripts:\n${refs.map((ref) => `- ${ref}`).join("\n")}\nUse subagent_inspect to search or read records.` : "";
}

async function persistResultTranscript(result: SingleResult, sessionId?: string): Promise<void> {
	if (!result.runId) return;
	try {
		result.transcript = await persistTranscript(
			{
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
			},
			result.messages,
		);
		result.messages = [];
	} catch (error) {
		result.transcriptError = error instanceof Error ? error.message : String(error);
	}
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type RunProgressCallback = (result: SingleResult) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	runId: string,
	signal: AbortSignal | undefined,
	onProgress: RunProgressCallback | undefined,
): Promise<SingleResult> {
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
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	const startedAt = Date.now();
	let phase = "启动子代理";
	let lastActivePhase = phase;
	let stopping = false;
	let lastProgressAt = 0;
	let pendingAssistant: any;
	const currentResult: SingleResult = {
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
		if (!stopping) lastActivePhase = phase;
		currentResult.progress = `${phase} · 已运行 ${Math.floor((now - startedAt) / 1000)} 秒${limit}${stopping ? ` · 最后阶段：${lastActivePhase}` : ""}`;
		if (!force && now - lastProgressAt < STREAM_PROGRESS_INTERVAL_MS) return;
		lastProgressAt = now;
		onProgress?.(currentResult);
	};
	const recordMessage = (message: Message) => {
		// Native message_end and legacy tool_result_end can describe the same tool result.
		if (message.role === "toolResult" && message.toolCallId && currentResult.messages.some(
			(item) => item.role === "toolResult" && item.toolCallId === message.toolCallId,
		)) return;
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
		let budgetExceeded: string | undefined;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			// Preserve UTF-8 characters split across stdout/stderr chunks.
			proc.stdout.setEncoding("utf8");
			proc.stderr.setEncoding("utf8");
			let buffer = "";
			let toolCallCount = 0;
			let finished = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			let forceTimeout: ReturnType<typeof setTimeout> | undefined;
			let abortHandler: (() => void) | undefined;
			const stopChild = () => {
				if (finished) return;
				stopping = true;
				proc.kill("SIGTERM");
				forceTimeout ??= setTimeout(() => {
					if (!finished) proc.kill("SIGKILL");
				}, 5000);
			};
			const finish = (code: number) => {
				if (finished) return;
				finished = true;
				if (timeout) clearTimeout(timeout);
				if (heartbeat) clearInterval(heartbeat);
				if (forceTimeout) clearTimeout(forceTimeout);
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
				resolve(code);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try { event = JSON.parse(line); } catch { return; }
				if (!event || typeof event !== "object") return;
				if (event.type === "message_start" && event.message?.role === "assistant") {
					pendingAssistant = structuredClone(event.message);
					phase = "等待模型响应";
					emitUpdate();
				}
				if (event.type === "message_update") {
					// Pi JSON mode emits deltas, not cumulative partial snapshots.
					const delta = event.assistantMessageEvent;
					const cumulative = event.message?.role === "assistant";
					if (cumulative) pendingAssistant = structuredClone(event.message);
					pendingAssistant ??= { role: "assistant", content: [], timestamp: Date.now() };
					if (event.usage) pendingAssistant.usage = event.usage;
					const index = delta?.contentIndex;
					if (!cumulative && Number.isInteger(index) && index >= 0 && index <= pendingAssistant.content.length) {
						if (delta.type === "text_start" || delta.type === "thinking_start") {
							pendingAssistant.content[index] = delta.type === "text_start"
								? { type: "text", text: "" } : { type: "thinking", thinking: "" };
						} else if (delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "text_end" || delta.type === "thinking_end") {
							const thinking = delta.type.startsWith("thinking");
							const field = thinking ? "thinking" : "text";
							const block = pendingAssistant.content[index] ??= { type: thinking ? "thinking" : "text", [field]: "" };
							if (delta.type.endsWith("_end")) block[field] = delta.content ?? block[field];
							else block[field] += delta.delta ?? "";
						} else if (delta.type === "toolcall_start") {
							pendingAssistant.content[index] = { type: "toolCall", id: delta.id, name: delta.toolName, arguments: {}, partialArguments: "" };
						} else if (delta.type === "toolcall_delta" && pendingAssistant.content[index]) {
							pendingAssistant.content[index].partialArguments = (pendingAssistant.content[index].partialArguments ?? "") + (delta.delta ?? "");
						} else if (delta.type === "toolcall_end" && delta.toolCall) {
							pendingAssistant.content[index] = delta.toolCall;
						}
					}
					phase = delta?.type?.startsWith("thinking") ? "模型推理中"
						: delta?.type?.startsWith("toolcall") ? "生成工具调用" : "模型输出中";
					emitUpdate();
				}
				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
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
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					phase = "等待下一步";
					emitUpdate(true);
				}
				if (event.type === "tool_result_end" && event.message) {
					recordMessage(event.message as Message);
					phase = "工具完成，等待模型";
					emitUpdate(true);
				}
				if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
					phase = `工具 ${event.toolName || "tool"} 执行中`;
					emitUpdate();
				}
				if (event.type === "tool_execution_end") {
					if (event.result) recordMessage({
						role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName,
						...event.result, isError: event.isError === true, timestamp: Date.now(),
					} as Message);
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
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => { currentResult.stderr += data; });
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				finish(code ?? 1);
			});
			proc.on("error", (error) => {
				currentResult.errorMessage = error.message;
				currentResult.stderr += `${error.message}\n`;
				finish(1);
			});
			if (signal) {
				abortHandler = () => {
					if (finished || budgetExceeded) return;
					wasAborted = true;
					stopping = true;
					phase = "中断停止中";
					emitUpdate(true);
					stopChild();
				};
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
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
			if (onProgress && !finished) heartbeat = setInterval(() => emitUpdate(true), PROGRESS_INTERVAL_MS);
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) {
			// Return a failed result instead of throwing so runAndPersist can save it.
			markAborted();
		} else if (budgetExceeded) {
			currentResult.exitCode = 1;
			currentResult.stopReason = "error";
			currentResult.errorMessage = budgetExceeded;
			phase = "已超出限制";
			appendActivity(currentResult, budgetExceeded);
		} else if (pendingAssistant) {
			currentResult.exitCode = 1;
			currentResult.stopReason = "error";
			currentResult.errorMessage ||= "Subagent exited before the assistant message completed";
			phase = "异常结束";
		} else {
			phase = isFailedResult(currentResult) ? "异常结束" : "已完成";
		}
		if (pendingAssistant) {
			pendingAssistant.stopReason = currentResult.stopReason;
			pendingAssistant.errorMessage = currentResult.errorMessage;
			recordMessage(pendingAssistant as Message);
		}
		emitUpdate(true);
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
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

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

const InspectActionSchema = StringEnum(["list", "search", "read"] as const, {
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
	maxChars: Type.Optional(
		Type.Integer({ minimum: 100, maximum: 50 * 1024, description: "Maximum raw characters returned by read mode" }),
	),
});

export const internals = {
	scoutBudgetForTask,
	agentBudgetForTask,
	PROGRESS_INTERVAL_MS,
	compactResult,
	detailsDisplayItems,
	detailsFinalOutput,
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const sessionId = ctx.sessionManager.getSessionId();
			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results: results.map(compactResult),
				});
			const runAndPersist = async (
				agentName: string,
				task: string,
				cwd: string | undefined,
				step: number | undefined,
				onProgress: RunProgressCallback | undefined,
			): Promise<SingleResult> => {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					agentName,
					task,
					cwd,
					step,
					createTranscriptRunId(sessionId),
					signal,
					onProgress,
				);
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
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainProgress: RunProgressCallback | undefined = onUpdate
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
				const allResults: SingleResult[] = new Array(params.tasks.length);

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
				const singleProgress: RunProgressCallback | undefined = onUpdate
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
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isRunning = r.exitCode === -1;
				const isError = !isRunning && isFailedResult(r);
				const icon = isRunning ? theme.fg("warning", "…") : isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = detailsDisplayItems(r);
				const finalOutput = detailsFinalOutput(r);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (r.progress) container.addChild(new Text(theme.fg("muted", r.progress), 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					if (r.transcript?.runId) {
						container.addChild(new Text(theme.fg("dim", `Raw transcript: ${r.transcript.runId} (subagent_inspect)`), 0, 0));
					} else if (r.transcriptError) {
						container.addChild(new Text(theme.fg("warning", `Transcript unavailable: ${r.transcriptError}`), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (r.progress) text += `\n${theme.fg("muted", r.progress)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResultDetails[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = details.results.some((r) => r.exitCode === -1) ? theme.fg("warning", "…")
					: successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === -1 ? theme.fg("warning", "…") : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = detailsDisplayItems(r);
						const finalOutput = detailsFinalOutput(r);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (r.progress) container.addChild(new Text(theme.fg("muted", r.progress), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
						if (r.transcript?.runId)
							container.addChild(new Text(theme.fg("dim", `Raw transcript: ${r.transcript.runId} (subagent_inspect)`), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === -1 ? theme.fg("warning", "…") : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = detailsDisplayItems(r);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (r.progress) text += `\n${theme.fg("muted", r.progress)}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = detailsDisplayItems(r);
						const finalOutput = detailsFinalOutput(r);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (r.progress) container.addChild(new Text(theme.fg("muted", r.progress), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
						if (r.transcript?.runId)
							container.addChild(new Text(theme.fg("dim", `Raw transcript: ${r.transcript.runId} (subagent_inspect)`), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = detailsDisplayItems(r);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (r.progress) text += `\n${theme.fg("muted", r.progress)}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_inspect",
		label: "Subagent Transcript",
		description: [
			"Inspect a raw transcript stored by a completed subagent run.",
			"Use list/search to find record indexes, then read to page through one exact raw JSON message.",
			"Prefer the summary returned by subagent and inspect only when specific evidence is needed.",
		].join(" "),
		parameters: SubagentInspectParams,
		promptSnippet: "Inspect raw records from a completed subagent run by the runId returned by the subagent tool.",
		promptGuidelines: [
			"Use subagent_inspect only when the compact subagent summary lacks a specific fact, code excerpt, or tool result.",
			"Start with search when you know a symbol, file path, or phrase; use read only for matching record indexes.",
		],

		async execute(_toolCallId, params) {
			const action = params.action ?? "list";
			try {
				if (action === "read") {
					if (params.record === undefined) {
						return {
							content: [{ type: "text", text: "read mode requires a zero-based record index." }],
							details: { runId: params.runId, action },
							isError: true,
						};
					}
					const result = await readTranscriptRecord(params.runId, params.record, {
						charOffset: params.charOffset,
						maxChars: params.maxChars,
					});
					const rangeEnd = result.charOffset + result.text.length;
					const continuation =
						result.nextCharOffset === null
							? "End of record."
							: `Continue with record=${result.record}, charOffset=${result.nextCharOffset}.`;
					return {
						content: [
							{
								type: "text",
								text: [
									`Transcript ${params.runId}, record ${result.record}/${Math.max(0, result.totalRecords - 1)}`,
									`Characters ${result.charOffset}-${rangeEnd} of ${result.totalChars}. ${continuation}`,
									"",
									result.text,
								].join("\n"),
							},
						],
						details: { runId: params.runId, action, record: result.record, nextCharOffset: result.nextCharOffset },
					};
				}

				if (action === "search" && !params.query?.trim()) {
					return {
						content: [{ type: "text", text: "search mode requires a non-empty query." }],
						details: { runId: params.runId, action },
						isError: true,
					};
				}
				const result = await listTranscript(params.runId, {
					query: action === "search" ? params.query : undefined,
					recordOffset: params.recordOffset,
					limit: params.limit,
				});
				const lines = [
					`Transcript ${params.runId}`,
					`Agent: ${result.metadata.agent}; records: ${result.totalRecords}; matches: ${result.matchedRecords}`,
				];
				for (const entry of result.entries) {
					lines.push(`#${entry.index} [${entry.role}] ${entry.chars} chars — ${entry.excerpt}`);
				}
				const nextOffset = result.recordOffset + result.entries.length;
				if (nextOffset < result.matchedRecords) lines.push(`More matches: recordOffset=${nextOffset}`);
				if (result.entries.length === 0) lines.push("(no matching records)");
				lines.push("Use action=read with a record index to retrieve exact raw JSON, with charOffset pagination when needed.");
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { runId: params.runId, action, matchedRecords: result.matchedRecords, nextRecordOffset: nextOffset },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Unable to inspect subagent transcript ${params.runId}: ${message}` }],
					details: { runId: params.runId, action },
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			const action = args.action ?? "list";
			let text = `${theme.fg("toolTitle", theme.bold("subagent_inspect "))}${theme.fg("accent", action)}`;
			text += `\n  ${theme.fg("dim", args.runId)}`;
			if (args.query) text += `\n  ${theme.fg("muted", `query: ${args.query}`)}`;
			if (args.record !== undefined) text += `\n  ${theme.fg("muted", `record: ${args.record}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? theme.fg("toolOutput", text.text) : "(no output)", 0, 0);
		},
	});
}

// Derived from the user-provided local subagent source; see maintenance/subagent-source.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
const TRANSCRIPT_VERSION = 1;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FILES = 200;
const RUN_ID_PATTERN = /^sa_[A-Za-z0-9_-]+$/;
export function getTranscriptStoreRoot() {
    return process.env.PI_SUBAGENT_RUNS_DIR || path.join(getAgentDir(), "subagent-runs");
}
export function createTranscriptRunId(sessionId) {
    const sessionPart = (sessionId || "session")
        .replace(/[^A-Za-z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(-16) || "session";
    return `sa_${sessionPart}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}
function transcriptPath(runId, root) {
    if (!RUN_ID_PATTERN.test(runId))
        throw new Error(`Invalid subagent transcript runId: ${runId}`);
    return path.join(root, `${runId}.jsonl`);
}
function normalizeExcerpt(text, maxChars = 240) {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized;
}
function describeRecord(raw) {
    try {
        const message = JSON.parse(raw);
        const role = typeof message.role === "string" ? message.role : "unknown";
        const parts = [];
        if (role === "toolResult" && typeof message.toolName === "string")
            parts.push(`tool ${message.toolName}`);
        if (Array.isArray(message.content)) {
            for (const block of message.content) {
                if (block?.type === "text" && typeof block.text === "string")
                    parts.push(block.text);
                else if (block?.type === "toolCall" && typeof block.name === "string")
                    parts.push(`call ${block.name}`);
            }
        }
        else if (typeof message.content === "string") {
            parts.push(message.content);
        }
        return { role, excerpt: normalizeExcerpt(parts.join(" | ") || raw) };
    }
    catch {
        return { role: "unknown", excerpt: normalizeExcerpt(raw) };
    }
}
async function cleanupTranscriptStore(root, retentionMs, maxFiles, keepRunId) {
    try {
        const names = await fs.promises.readdir(root);
        const files = await Promise.all(names
            .filter((name) => /^sa_[A-Za-z0-9_-]+\.jsonl$/.test(name))
            .map(async (name) => {
            const filePath = path.join(root, name);
            const stat = await fs.promises.stat(filePath);
            return { name, filePath, mtimeMs: stat.mtimeMs };
        }));
        const now = Date.now();
        const expired = files.filter((file) => file.name !== `${keepRunId}.jsonl` && now - file.mtimeMs > retentionMs);
        await Promise.all(expired.map((file) => fs.promises.unlink(file.filePath).catch(() => undefined)));
        const remaining = files
            .filter((file) => !expired.some((expiredFile) => expiredFile.filePath === file.filePath))
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const file of remaining.slice(Math.max(1, maxFiles))) {
            if (file.name !== `${keepRunId}.jsonl`)
                await fs.promises.unlink(file.filePath).catch(() => undefined);
        }
    }
    catch {
        // Retention cleanup is best-effort and must never fail the subagent run.
    }
}
export async function persistTranscript(metadata, messages, options = {}) {
    const root = options.root ?? getTranscriptStoreRoot();
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    const header = {
        type: "pi-subagent-transcript",
        version: TRANSCRIPT_VERSION,
        ...metadata,
        createdAt: metadata.createdAt ?? new Date().toISOString(),
        recordCount: messages.length,
    };
    const lines = [JSON.stringify(header), ...messages.map((message) => JSON.stringify(message))];
    const content = `${lines.join("\n")}\n`;
    const filePath = transcriptPath(metadata.runId, root);
    const tempPath = path.join(root, `.${metadata.runId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    await withFileMutationQueue(filePath, async () => {
        try {
            await fs.promises.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
            await fs.promises.rename(tempPath, filePath);
        }
        finally {
            await fs.promises.unlink(tempPath).catch(() => undefined);
        }
    });
    await cleanupTranscriptStore(root, options.retentionMs ?? DEFAULT_RETENTION_MS, options.maxFiles ?? DEFAULT_MAX_FILES, metadata.runId);
    return { runId: metadata.runId, recordCount: messages.length, bytes: Buffer.byteLength(content, "utf8") };
}
async function loadTranscript(runId, options = {}) {
    const root = options.root ?? getTranscriptStoreRoot();
    const content = await fs.promises.readFile(transcriptPath(runId, root), "utf8");
    const lines = content.split(/\r?\n/);
    if (lines[lines.length - 1] === "")
        lines.pop();
    if (lines.length === 0)
        throw new Error(`Subagent transcript is empty: ${runId}`);
    const header = JSON.parse(lines[0]);
    if (header.type !== "pi-subagent-transcript" || header.version !== TRANSCRIPT_VERSION || header.runId !== runId) {
        throw new Error(`Unsupported or corrupt subagent transcript: ${runId}`);
    }
    return { metadata: header, records: lines.slice(1) };
}
export async function listTranscript(runId, options = {}) {
    const loaded = await loadTranscript(runId, options);
    const query = options.query?.trim().toLocaleLowerCase();
    const matches = loaded.records
        .map((raw, index) => ({ raw, index }))
        .filter(({ raw }) => !query || raw.toLocaleLowerCase().includes(query));
    const recordOffset = Math.max(0, Math.floor(options.recordOffset ?? 0));
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 20)));
    const entries = matches.slice(recordOffset, recordOffset + limit).map(({ raw, index }) => {
        const description = describeRecord(raw);
        return { index, role: description.role, chars: raw.length, excerpt: description.excerpt };
    });
    return {
        metadata: loaded.metadata,
        totalRecords: loaded.records.length,
        matchedRecords: matches.length,
        recordOffset,
        limit,
        entries,
    };
}
export async function readTranscriptRecord(runId, record, options = {}) {
    const loaded = await loadTranscript(runId, options);
    const recordIndex = Math.floor(record);
    if (!Number.isInteger(recordIndex) || recordIndex < 0 || recordIndex >= loaded.records.length) {
        throw new Error(`Transcript record out of range: ${record}; expected 0-${Math.max(0, loaded.records.length - 1)}`);
    }
    const raw = loaded.records[recordIndex];
    const charOffset = Math.max(0, Math.min(raw.length, Math.floor(options.charOffset ?? 0)));
    const maxChars = Math.max(100, Math.min(50 * 1024, Math.floor(options.maxChars ?? 12 * 1024)));
    const text = raw.slice(charOffset, charOffset + maxChars);
    const nextCharOffset = charOffset + text.length < raw.length ? charOffset + text.length : null;
    return {
        metadata: loaded.metadata,
        record: recordIndex,
        totalRecords: loaded.records.length,
        totalChars: raw.length,
        charOffset,
        text,
        nextCharOffset,
    };
}

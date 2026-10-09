// Loaded by the real child Pi through the isolated settings.json, not called by
// the parent test. Audits prove both execution and the normal permission pipeline.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  const audit = (file: string, value: unknown) => appendFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, file), JSON.stringify(value) + '\n');
  pi.on('tool_call', event => {
    audit('tool-events.jsonl', { phase: 'call', pid: process.pid, name: event.toolName, id: event.toolCallId, parentId: event.parentToolCallId, input: event.input });
  });
  pi.on('tool_result', event => {
    audit('tool-events.jsonl', { phase: 'result', pid: process.pid, name: event.toolName, id: event.toolCallId, parentId: event.parentToolCallId, isError: event.isError });
  });
  pi.registerTool({
    name: 'fixture_extension_probe', label: 'Native extension smoke probe',
    description: 'Echo a verification token from a real child extension execution.',
    parameters: Type.Object({ token: Type.String(), callerPid: Type.Integer() }),
    async execute(_id, args) {
      const result = { marker: 'EXTENSION_TOOL_EXECUTED', token: args.token, callerPid: args.callerPid, pid: process.pid };
      audit('extension-executions.jsonl', result);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}

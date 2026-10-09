// A real, local stdio MCP server. Only the model response is scripted in these tests;
// Pi must perform the handshake, discovery, and tools/call over its MCP transport.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const auditPath = process.argv[2];
if (!auditPath) throw new Error('Missing MCP audit path');
const tools = ['probe', 'forbidden_probe'].map(name => ({
  name,
  description: `Native subagent smoke ${name}: echo a verification token`,
  inputSchema: { type: 'object', properties: { token: { type: 'string' }, callerPid: { type: 'integer' } }, required: ['token', 'callerPid'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}));
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(auditPath, JSON.stringify({ serverPid: process.pid, parentPid: process.ppid, ...request }) + '\n');
  if (request.id === undefined) return; // MCP notifications do not get responses.
  let result;
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'native-subagent-smoke', version: '1.0.0' } };
      break;
    case 'ping': result = {}; break;
    case 'tools/list': result = { tools }; break;
    case 'tools/call': {
      const { name, arguments: args } = request.params;
      if (!tools.some(tool => tool.name === name) || typeof args?.token !== 'string' || !Number.isInteger(args?.callerPid)) {
        result = { isError: true, content: [{ type: 'text', text: 'Invalid smoke tool call' }] };
      } else {
        result = { content: [{ type: 'text', text: JSON.stringify({ marker: 'MCP_TOOL_EXECUTED', token: args.token, callerPid: args.callerPid, serverPid: process.pid }) }] };
      }
      break;
    }
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
      return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});

import type { TObject } from 'typebox';
export interface SubagentRequest {
  agent?: string;
  task?: string;
  tasks?: Array<{ agent: string; task: string; cwd?: string }>;
  chain?: Array<{ agent: string; task: string; cwd?: string }>;
  agentScope?: 'user' | 'project' | 'both';
  confirmProjectAgents?: boolean;
  cwd?: string;
}
export interface SubagentExecutionContext {
  readonly cwd: string;
  readonly sessionManager: { getSessionId(): string };
  readonly hasUI: boolean;
  readonly ui: { confirm(title: string, message: string): Promise<boolean> };
}
export interface SubagentResult {
  content: Array<{ type: 'text'; text: string }>;
  details: {
    mode: 'single' | 'parallel' | 'chain';
    agentScope: 'user' | 'project' | 'both';
    projectAgentsDir?: string | null;
    results: Array<{ agent: string; exitCode: number; finalOutput?: string; progress?: string; model?: string; [key: string]: unknown }>;
  };
  isError?: boolean;
}
export const SubagentParams: TObject;
export function executeSubagent(id: string, params: SubagentRequest, signal: AbortSignal | undefined,
  onUpdate: ((value: SubagentResult) => void) | undefined, context: SubagentExecutionContext): Promise<SubagentResult>;

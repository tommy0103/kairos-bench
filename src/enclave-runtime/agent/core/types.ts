export interface AgentToolResult<TDetails = unknown> {
  content: Array<{ type: string; text: string }>;
  details?: TDetails;
}

export interface AgentTool<TParams = any, TDetails = any> {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: TParams,
    signal?: AbortSignal
  ) => Promise<AgentToolResult<TDetails>>;
}

export interface LogosCompleteParams {
  summary: string;
  reply?: string;
  anchor?: boolean;
  task_log?: string;
  sleep?: {
    reason: "recoverable_error" | "awaiting_user";
    retry: boolean;
  };
  resume?: string;
  plan?: string[];
  /** Alternative approaches to try in parallel with workspace isolation. */
  explore?: string[];
}

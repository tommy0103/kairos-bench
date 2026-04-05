import type OpenAI from "openai";

export interface ToolCallRecord {
  toolName: string;
  toolCallId: string;
  params: unknown;
  result: unknown;
  durationMs: number;
}

export interface TurnContext {
  taskId: string;
  turnIndex: number;
  startedAt: number;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  toolCalls: ToolCallRecord[];
}

export function createTurnContext(
  taskId: string,
  turnIndex: number,
  initialMessages: OpenAI.Chat.ChatCompletionMessageParam[]
): TurnContext {
  return {
    taskId,
    turnIndex,
    startedAt: Date.now(),
    messages: [...initialMessages],
    toolCalls: [],
  };
}

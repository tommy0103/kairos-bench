import type OpenAI from "openai";
import type { ChatClient } from "./chatClient";
import type { AgentTool, LogosCompleteParams } from "./types";

const LOGOS_COMPLETE = "logos_complete";
const MAX_TURNS_DEFAULT = 200;
const CONTEXT_PRESSURE_RATIO = 0.8;

export type ReactLoopEvent =
  | { type: "message_update"; role: "assistant"; delta: string }
  | { type: "tool_execution_start"; toolName: string; toolCallId: string }
  | {
      type: "tool_execution_end";
      toolName: string;
      toolCallId: string;
      result?: unknown;
    }
  | { type: "logos_complete"; params: LogosCompleteParams }
  | { type: "context_pressure"; estimatedTokens: number; limit: number }
  | { type: "max_turns_reached" };

export interface ReactLoopOptions {
  client: ChatClient;
  model: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools: AgentTool[];
  signal?: AbortSignal;
  maxTurns?: number;
  temperature?: number;
  /** Max context tokens. When ~80% is consumed a warning is injected. */
  contextLimit?: number;
}

function stripTypebox(schema: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.parse(JSON.stringify(schema));
  delete json["$id"];
  return json;
}

function toolToOpenAIFunction(
  tool: AgentTool
): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: stripTypebox(tool.parameters),
    },
  };
}

function toolResultToText(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

/**
 * Rough token estimate: ~3.5 chars per token for mixed English/code.
 * Includes message content, tool calls, and tool schema overhead.
 */
function estimateTokens(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  toolSchemas?: OpenAI.Chat.ChatCompletionTool[],
): number {
  let chars = 0;
  for (const msg of messages) {
    chars += 15; // per-message framing overhead
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ("text" in part && typeof (part as any).text === "string") {
          chars += (part as any).text.length;
        }
      }
    }
    if ("tool_calls" in msg && msg.tool_calls) {
      for (const tc of msg.tool_calls as any[]) {
        chars +=
          (tc.function?.name?.length ?? 0) +
          (tc.function?.arguments?.length ?? 0);
      }
    }
  }
  if (toolSchemas) {
    chars += JSON.stringify(toolSchemas).length;
  }
  return Math.ceil(chars / 3.5);
}

const CONTEXT_PRESSURE_MSG =
  "CONTEXT WINDOW WARNING: You have used approximately 80% of your available context. " +
  "To preserve coherence you should immediately:\n" +
  "1. Call logos_complete with a detailed `task_log` recording everything you have done so far.\n" +
  "2. Set the `plan` field to list the remaining steps as subtasks.\n" +
  "Each subtask will be executed by a fresh agent with a clean context window.\n" +
  "Do this NOW — do not attempt further tool calls before entering plan mode.";

export async function* reactLoop(
  options: ReactLoopOptions
): AsyncGenerator<ReactLoopEvent, void, unknown> {
  const {
    client,
    model,
    tools,
    signal,
    maxTurns = MAX_TURNS_DEFAULT,
    temperature,
    contextLimit,
  } = options;
  const messages = [...options.messages];
  const openaiTools = tools.map(toolToOpenAIFunction);
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  let contextWarned = false;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) return;

    if (contextLimit && !contextWarned) {
      const est = estimateTokens(messages, openaiTools);
      if (est > contextLimit * CONTEXT_PRESSURE_RATIO) {
        contextWarned = true;
        yield {
          type: "context_pressure",
          estimatedTokens: est,
          limit: contextLimit,
        };
        messages.push({
          role: "user" as const,
          content: CONTEXT_PRESSURE_MSG,
        });
      }
    }

    let response: OpenAI.Chat.ChatCompletion | undefined;
    for await (const se of client.streamChatCompletion({
      model,
      messages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      temperature,
    })) {
      if (se.type === "text") {
        yield { type: "message_update", role: "assistant", delta: se.text };
      } else {
        response = se.response;
      }
    }

    if (!response) return;
    const choice = response.choices[0];
    if (!choice) return;

    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    if (assistantMsg.tool_calls?.length) {
      let completed = false;
      let completeParams: LogosCompleteParams | undefined;

      for (const toolCall of assistantMsg.tool_calls) {
        if (!("function" in toolCall)) continue;
        const toolName = toolCall.function.name;
        const toolCallId = toolCall.id;

        yield { type: "tool_execution_start", toolName, toolCallId };

        let resultText: string;
        let result: unknown;

        try {
          const params = JSON.parse(toolCall.function.arguments || "{}");

          if (toolName === LOGOS_COMPLETE) {
            completeParams = params as LogosCompleteParams;
            resultText = "Turn completed.";
            result = { ok: true };
            completed = true;
          } else {
            const tool = toolMap.get(toolName);
            if (!tool) {
              throw new Error(`unknown tool "${toolName}"`);
            }
            const toolResult = await tool.execute(toolCallId, params, signal);
            resultText = toolResultToText(toolResult);
            result = toolResult;
          }
        } catch (err) {
          const errMsg =
            err instanceof Error ? err.message : String(err);
          resultText = `Error: ${errMsg}`;
          result = { error: errMsg };
        }

        yield { type: "tool_execution_end", toolName, toolCallId, result };

        messages.push({
          role: "tool" as const,
          tool_call_id: toolCallId,
          content: resultText,
        });
      }

      if (completed && completeParams) {
        yield { type: "logos_complete", params: completeParams };
        return;
      }

      continue;
    }

    if (choice.finish_reason === "stop") {
      messages.push({
        role: "user" as const,
        content:
          "You must call logos_complete to finish this turn. " +
          "Decide whether the task is done, then call logos_complete with a summary.",
      });
    }
  }

  yield { type: "max_turns_reached" };
}

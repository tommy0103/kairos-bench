import type OpenAI from "openai";
import type { ChatClient } from "./chatClient";
import type { AgentTool, LogosCompleteParams } from "./types";

const LOGOS_COMPLETE = "logos_complete";
const MAX_TURNS_DEFAULT = 1000;
const CONTEXT_PRESSURE_RATIO = 0.8;

export type ReactLoopEvent =
  | { type: "message_update"; role: "assistant"; delta: string }
  | {
      type: "tool_execution_start";
      toolName: string;
      toolCallId: string;
      params: Record<string, unknown>;
    }
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
  let turnsWarned = false;
  let streamRetries = 0;
  const MAX_STREAM_RETRIES = 3;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) return;

    const turnsLeft = maxTurns - turn;
    if (!turnsWarned && turnsLeft <= 3) {
      turnsWarned = true;
      messages.push({
        role: "user" as const,
        content:
          `TURN LIMIT WARNING: You have ${turnsLeft} turn(s) remaining. ` +
          "You MUST call logos_complete on your next response. " +
          "Summarize your progress so far and call logos_complete immediately.",
      });
    }

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

    // Detect stream disconnect: nearly zero output + "length" finish + no real
    // content or tool calls → the connection dropped, not a token limit issue.
    const completionTokens = response.usage?.completion_tokens ?? 0;
    const hasContent = !!choice.message.content?.trim();
    const hasToolCalls = !!choice.message.tool_calls?.length;
    if (
      completionTokens < 20 &&
      choice.finish_reason === "length" &&
      !hasContent &&
      !hasToolCalls
    ) {
      streamRetries++;
      if (streamRetries <= MAX_STREAM_RETRIES) {
        console.warn(
          `[reactLoop] stream disconnected with ~0 output tokens — ` +
            `retrying (${streamRetries}/${MAX_STREAM_RETRIES})`,
        );
        const backoffMs = Math.min(1000 * 2 ** (streamRetries - 1), 15000);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      console.warn(
        `[reactLoop] stream disconnect retries exhausted (${MAX_STREAM_RETRIES})`,
      );
    } else {
      streamRetries = 0;
    }

    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    if (assistantMsg.tool_calls?.length) {
      let completed = false;
      let completeParams: LogosCompleteParams | undefined;
      let emptyCallStreak = 0;

      for (const toolCall of assistantMsg.tool_calls) {
        if (!("function" in toolCall)) continue;
        const toolName = toolCall.function.name;
        const toolCallId = toolCall.id;
        let parsedParams: Record<string, unknown> = {};
        try {
          parsedParams = JSON.parse(toolCall.function.arguments || "{}");
        } catch (e) {
          const raw = toolCall.function.arguments ?? "";
          const preview = raw.length > 2000 ? raw.slice(0, 2000) + `… (${raw.length} bytes total)` : raw;
          console.warn(
            `[reactLoop] failed to parse tool arguments for ${toolName}: ${e} (${raw.length} chars)\n` +
              `  [raw-args] ${preview}`,
          );
        }

        const isEmpty =
          Object.keys(parsedParams).length === 0 && toolName !== LOGOS_COMPLETE;

        if (isEmpty) {
          emptyCallStreak++;
        } else {
          emptyCallStreak = 0;
        }

        yield {
          type: "tool_execution_start",
          toolName,
          toolCallId,
          params: parsedParams,
        };

        let resultText: string;
        let result: unknown;

        if (isEmpty) {
          resultText =
            "Error: tool call had empty arguments (likely a streaming truncation). " +
            "Do NOT retry with empty arguments. Re-generate the full arguments.";
          result = { error: "empty arguments" };
          console.warn(
            `[reactLoop] skipping ${toolName} — empty params (streak: ${emptyCallStreak})`,
          );
        } else {
          try {
            if (toolName === LOGOS_COMPLETE) {
              completeParams = parsedParams as unknown as LogosCompleteParams;
              resultText = "Turn completed.";
              result = { ok: true };
              completed = true;
            } else {
              const tool = toolMap.get(toolName);
              if (!tool) {
                throw new Error(`unknown tool "${toolName}"`);
              }
              const toolResult = await tool.execute(toolCallId, parsedParams, signal);
              resultText = toolResultToText(toolResult);
              result = toolResult;
            }
          } catch (err) {
            const errMsg =
              err instanceof Error ? err.message : String(err);
            resultText = `Error: ${errMsg}`;
            result = { error: errMsg };
          }
        }

        if (emptyCallStreak >= 3) {
          console.warn(
            `[reactLoop] ${emptyCallStreak} consecutive empty tool calls — ` +
              `injecting warning to model`,
          );
          messages.push({
            role: "tool" as const,
            tool_call_id: toolCallId,
            content: resultText,
          });
          messages.push({
            role: "user" as const,
            content:
              "WARNING: Your last several tool calls had empty/missing arguments. " +
              "This usually means your response was too long and got truncated. " +
              "Break your work into smaller steps — write shorter code blocks, " +
              "or use logos_exec to write files in pieces with heredocs.",
          });
          yield { type: "tool_execution_end", toolName, toolCallId, result };
          break;
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

    if (choice.finish_reason === "length") {
      messages.push({
        role: "user" as const,
        content:
          "WARNING: Your response was truncated because it exceeded the output token limit. " +
          "Your tool call arguments were lost. " +
          "Please retry with a SHORTER response — break large code into smaller pieces, " +
          "write files in sections using multiple logos_exec calls with heredocs, " +
          "or use logos_exec to echo code line-by-line. Do NOT try to write an entire " +
          "large program in a single tool call.",
      });
    } else if (choice.finish_reason === "stop") {
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

import OpenAI from "openai";
import type { AgentTool, LogosCompleteParams } from "./types";

const LOGOS_COMPLETE = "logos_complete";
const MAX_TURNS_DEFAULT = 200;

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
  | { type: "max_turns_reached" };

export interface ReactLoopOptions {
  client: OpenAI;
  model: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools: AgentTool[];
  signal?: AbortSignal;
  maxTurns?: number;
  temperature?: number;
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
  } = options;
  const messages = [...options.messages];
  const openaiTools = tools.map(toolToOpenAIFunction);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) return;

    const response = await client.chat.completions.create({
      model,
      messages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      temperature,
    });

    const choice = response.choices[0];
    if (!choice) return;

    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    if (assistantMsg.content) {
      yield {
        type: "message_update",
        role: "assistant",
        delta: assistantMsg.content,
      };
    }

    if (assistantMsg.tool_calls?.length) {
      let completed = false;
      let completeParams: LogosCompleteParams | undefined;

      for (const toolCall of assistantMsg.tool_calls) {
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

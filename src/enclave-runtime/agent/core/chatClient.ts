/**
 * Unified chat completion interface — OpenAI and Anthropic backends.
 *
 * Internally everything flows as OpenAI-compatible types. The Anthropic
 * adapter converts on the fly so the rest of the stack (reactLoop,
 * planExecutor, …) never needs to care which provider is in use.
 *
 * Both streaming and non-streaming modes are supported. reactLoop uses
 * streaming by default for better timeout resilience and incremental output.
 *
 * Anthropic SDK is dynamically imported — it only needs to be installed
 * when `createAnthropicChatClient` is actually called.
 */
import type OpenAI from "openai";

// ── Public types ──────────────────────────────────────────────

export interface ChatCompletionParams {
  model: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools?: OpenAI.Chat.ChatCompletionTool[];
  temperature?: number;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "completion"; response: OpenAI.Chat.ChatCompletion };

export interface ChatClient {
  createChatCompletion(
    params: ChatCompletionParams,
  ): Promise<OpenAI.Chat.ChatCompletion>;

  streamChatCompletion(
    params: ChatCompletionParams,
  ): AsyncIterable<StreamEvent>;
}

// ── OpenAI implementation ─────────────────────────────────────

export function createOpenAIChatClient(openai: OpenAI): ChatClient {
  return {
    createChatCompletion: (params) =>
      openai.chat.completions.create({
        model: params.model,
        messages: params.messages,
        tools: params.tools?.length ? params.tools : undefined,
        temperature: params.temperature,
      }) as Promise<OpenAI.Chat.ChatCompletion>,

    async *streamChatCompletion(params) {
      const stream = await openai.chat.completions.create({
        model: params.model,
        messages: params.messages,
        tools: params.tools?.length ? params.tools : undefined,
        temperature: params.temperature,
        stream: true,
      });

      let content = "";
      const tcMap = new Map<
        number,
        { id: string; name: string; args: string }
      >();
      let finishReason: string | null = null;
      let respId = "";
      let respModel = "";

      let streamError: unknown = null;

      try {
        for await (const chunk of stream as any) {
          const c = chunk.choices?.[0];
          if (!c) continue;
          if (chunk.id) respId = chunk.id;
          if (chunk.model) respModel = chunk.model;

          if (c.delta?.content) {
            content += c.delta.content;
            yield { type: "text" as const, text: c.delta.content };
          }

          if (c.delta?.tool_calls) {
            for (const tc of c.delta.tool_calls) {
              let entry = tcMap.get(tc.index);
              if (!entry) {
                entry = { id: "", name: "", args: "" };
                tcMap.set(tc.index, entry);
              }
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
            }
          }

          if (c.finish_reason) finishReason = c.finish_reason;
        }
      } catch (err) {
        streamError = err;
      }

      const streamIncomplete = !finishReason;
      if (streamIncomplete) {
        const errDetail = streamError
          ? ` error=${streamError instanceof Error ? `${streamError.name}: ${streamError.message}` : String(streamError)}`
          : "";
        const statusDetail = streamError && typeof (streamError as any).status === "number"
          ? ` httpStatus=${(streamError as any).status}`
          : "";
        console.warn(
          `[chatClient] OpenAI stream ended without finish_reason — response may be truncated${errDetail}${statusDetail}`,
        );
      }

      const toolCalls: ToolCallEntry[] = [];
      for (const [, tc] of [...tcMap.entries()].sort(([a], [b]) => a - b)) {
        const isTruncated = !tc.args && streamIncomplete;
        if (isTruncated) {
          console.warn(
            `[chatClient] dropping truncated tool call "${tc.name}" — stream ended before args were received`,
          );
          continue;
        }
        if (!tc.args) {
          console.warn(
            `[chatClient] tool call "${tc.name}" has empty arguments — likely stream truncation`,
          );
        }
        toolCalls.push({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.args || "{}" },
        });
      }

      const hadTruncatedTools =
        tcMap.size > 0 && toolCalls.length === 0 && streamIncomplete;

      const effectiveFinishReason = hadTruncatedTools
        ? "length"
        : finishReason ?? (streamIncomplete ? "length" : "stop");

      yield {
        type: "completion" as const,
        response: buildOpenAICompletion({
          id: respId || `stream-${Date.now()}`,
          model: respModel || params.model,
          content: content || null,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finishReason: effectiveFinishReason,
        }),
      };
    },
  };
}

// ── Anthropic implementation ──────────────────────────────────

export interface AnthropicClientOptions {
  apiKey: string;
  baseURL?: string;
  maxTokens?: number;
}

export async function createAnthropicChatClient(
  opts: AnthropicClientOptions,
): Promise<ChatClient> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
  const maxTokens = opts.maxTokens ?? 16384;

  function buildRequest(params: ChatCompletionParams): Record<string, unknown> {
    const { systemText, messages } = convertMessagesToAnthropic(
      params.messages,
    );
    const tools = convertToolsToAnthropic(params.tools);
    const req: Record<string, unknown> = {
      model: params.model,
      max_tokens: maxTokens,
      messages,
    };
    if (systemText) req.system = systemText;
    if (tools.length > 0) req.tools = tools;
    if (params.temperature != null) req.temperature = params.temperature;
    return req;
  }

  return {
    async createChatCompletion(params) {
      const req = buildRequest(params);
      const response = await (client.messages.create as Function)(req);
      return anthropicResponseToOpenAI(response);
    },

    async *streamChatCompletion(params) {
      const req = buildRequest(params);
      req.stream = true;
      const stream = await (client.messages.create as Function)(req);

      let content = "";
      const blocks: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        inputJson?: string;
      }> = [];
      let stopReason: string | null = null;
      let messageComplete = false;
      let msgId = "";
      let msgModel = "";
      let inputTokens = 0;
      let outputTokens = 0;

      let streamError: unknown = null;

      try {
        for await (const event of stream) {
          switch (event.type) {
            case "message_start":
              msgId = event.message?.id ?? "";
              msgModel = event.message?.model ?? "";
              inputTokens = event.message?.usage?.input_tokens ?? 0;
              break;

            case "content_block_start": {
              const cb = event.content_block;
              if (cb?.type === "text") {
                blocks[event.index] = { type: "text", text: "" };
              } else if (cb?.type === "tool_use") {
                blocks[event.index] = {
                  type: "tool_use",
                  id: cb.id,
                  name: cb.name,
                  inputJson: "",
                };
              }
              break;
            }

            case "content_block_delta": {
              const blk = blocks[event.index];
              if (!blk) break;
              if (event.delta?.type === "text_delta") {
                const text = event.delta.text ?? "";
                blk.text = (blk.text ?? "") + text;
                content += text;
              if (text) yield { type: "text" as const, text };
            } else if (event.delta?.type === "input_json_delta") {
              blk.inputJson =
                (blk.inputJson ?? "") + (event.delta.partial_json ?? "");
            }
            break;
          }

          case "message_delta":
            stopReason = event.delta?.stop_reason ?? stopReason;
            outputTokens = event.usage?.output_tokens ?? outputTokens;
            break;

          case "message_stop":
            messageComplete = true;
            break;
        }
      }
      } catch (err) {
        streamError = err;
      }

      if (!messageComplete) {
        const errDetail = streamError
          ? ` error=${streamError instanceof Error ? `${streamError.name}: ${streamError.message}` : String(streamError)}`
          : "";
        const statusDetail = streamError && typeof (streamError as any).status === "number"
          ? ` httpStatus=${(streamError as any).status}`
          : "";
        console.warn(
          `[chatClient] Anthropic stream ended without message_stop — response may be truncated` +
            ` (outputTokens=${outputTokens}, maxTokens=${maxTokens}, stopReason=${stopReason}, contentBytes=${content.length}, toolBlocks=${blocks.filter(b => b.type === "tool_use").length}${errDetail}${statusDetail})`,
        );
      }

      const allToolBlocks = blocks.filter((b) => b.type === "tool_use");
      const toolCalls: ToolCallEntry[] = [];

      for (const b of allToolBlocks) {
        const rawArgs = b.inputJson ?? "";
        const isTruncated = !rawArgs && !messageComplete;
        if (isTruncated) {
          console.warn(
            `[chatClient] dropping truncated tool_use "${b.name}" — stream ended before input was received`,
          );
          continue;
        }
        if (!messageComplete && rawArgs) {
          console.warn(
            `[chatClient] tool_use "${b.name}" may be truncated — received ${rawArgs.length} bytes of input JSON`,
          );
        }
        if (!rawArgs) {
          console.warn(
            `[chatClient] tool_use block "${b.name}" has empty inputJson — likely stream truncation`,
          );
        }
        toolCalls.push({
          id: b.id!,
          type: "function" as const,
          function: {
            name: b.name!,
            arguments: rawArgs || "{}",
          },
        });
      }

      // If tool calls were present but all got dropped due to truncation,
      // treat as "length" so the reactLoop can prompt for a shorter retry.
      const hadTruncatedTools =
        allToolBlocks.length > 0 && toolCalls.length === 0 && !messageComplete;

      const finishReason = hadTruncatedTools
        ? "length"
        : stopReason === "tool_use"
          ? "tool_calls"
          : stopReason === "max_tokens"
            ? "length"
            : !messageComplete
              ? "length"
              : "stop";

      yield {
        type: "completion" as const,
        response: buildOpenAICompletion({
          id: msgId || `ant-${Date.now()}`,
          model: msgModel || params.model,
          content: content || null,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finishReason,
          promptTokens: inputTokens,
          completionTokens: outputTokens,
        }),
      };
    },
  };
}

// ── OpenAI Responses API implementation ───────────────────────
//
// Some models (e.g. gpt-5.3-codex) are only available via the
// /v1/responses endpoint. This adapter converts between our
// ChatClient interface (OpenAI Chat Completion types) and the
// Responses API wire format, including reasoning item round-trips.

export interface OpenAIResponsesClientOptions {
  /** If false, `temperature` is omitted from requests (e.g. codex models). */
  supportsTemperature?: boolean;
}

export function createOpenAIResponsesChatClient(
  openai: OpenAI,
  opts?: OpenAIResponsesClientOptions,
): ChatClient {
  const sendTemp = opts?.supportsTemperature ?? false;

  return {
    async createChatCompletion(params) {
      const { instructions, input } = convertMsgsToResponsesInput(
        params.messages,
      );
      const tools = convertToolsToResponses(params.tools);

      const response = await (openai.responses as any).create({
        model: params.model,
        ...(instructions ? { instructions } : {}),
        input,
        ...(tools?.length ? { tools } : {}),
        ...(sendTemp && params.temperature != null
          ? { temperature: params.temperature }
          : {}),
      });

      return responsesToCompletion(response, params.model);
    },

    async *streamChatCompletion(params) {
      const { instructions, input } = convertMsgsToResponsesInput(
        params.messages,
      );
      const tools = convertToolsToResponses(params.tools);

      const stream = await (openai.responses as any).create({
        model: params.model,
        ...(instructions ? { instructions } : {}),
        input,
        ...(tools?.length ? { tools } : {}),
        ...(sendTemp && params.temperature != null
          ? { temperature: params.temperature }
          : {}),
        stream: true,
      });

      let content = "";
      const fcMap = new Map<
        number,
        { id: string; callId: string; name: string; args: string }
      >();
      let respId = "";
      let respModel = "";
      let completed = false;
      let inputTokens = 0;
      let outputTokens = 0;
      let respStatus = "";
      const rawOutputItems: any[] = [];

      for await (const event of stream) {
        switch ((event as any).type) {
          case "response.created":
            respId = (event as any).response?.id ?? "";
            respModel = (event as any).response?.model ?? "";
            break;

          case "response.output_item.added": {
            const item = (event as any).item;
            if (item?.type === "function_call") {
              fcMap.set((event as any).output_index, {
                id: item.id ?? "",
                callId: item.call_id ?? "",
                name: item.name ?? "",
                args: "",
              });
            }
            break;
          }

          case "response.output_text.delta":
            if ((event as any).delta) {
              content += (event as any).delta;
              yield { type: "text" as const, text: (event as any).delta };
            }
            break;

          case "response.function_call_arguments.delta": {
            const fc = fcMap.get((event as any).output_index);
            if (fc) fc.args += (event as any).delta ?? "";
            break;
          }

          case "response.function_call_arguments.done": {
            const fc = fcMap.get((event as any).output_index);
            if (fc && (event as any).arguments)
              fc.args = (event as any).arguments;
            break;
          }

          case "response.output_item.done":
            if ((event as any).item) {
              rawOutputItems.push((event as any).item);
              const doneItem = (event as any).item;
              if (doneItem.type === "function_call") {
                const idx = (event as any).output_index;
                if (!fcMap.has(idx)) {
                  fcMap.set(idx, {
                    id: doneItem.id ?? "",
                    callId: doneItem.call_id ?? "",
                    name: doneItem.name ?? "",
                    args: doneItem.arguments ?? "{}",
                  });
                }
              }
            }
            break;

          case "response.completed":
            completed = true;
            respStatus = (event as any).response?.status ?? "";
            inputTokens =
              (event as any).response?.usage?.input_tokens ?? 0;
            outputTokens =
              (event as any).response?.usage?.output_tokens ?? 0;
            if ((event as any).response?.id)
              respId = (event as any).response.id;
            if ((event as any).response?.model)
              respModel = (event as any).response.model;
            break;

          case "response.failed":
            console.warn(
              `[chatClient] Responses API stream failed: ${JSON.stringify((event as any).response?.error)}`,
            );
            break;
        }
      }

      if (!completed) {
        console.warn(
          `[chatClient] OpenAI Responses stream ended without response.completed`,
        );
      }

      const toolCalls: ToolCallEntry[] = [];
      for (const [, fc] of [...fcMap.entries()].sort(([a], [b]) => a - b)) {
        const isTruncated = !fc.args && !completed;
        if (isTruncated) {
          console.warn(
            `[chatClient] dropping truncated function_call "${fc.name}" — stream ended before args were received`,
          );
          continue;
        }
        toolCalls.push({
          id: fc.callId || fc.id,
          type: "function" as const,
          function: { name: fc.name, arguments: fc.args || "{}" },
        });
      }

      const hadTruncatedTools =
        fcMap.size > 0 && toolCalls.length === 0 && !completed;

      const finishReason = hadTruncatedTools
        ? "length"
        : toolCalls.length > 0
          ? "tool_calls"
          : respStatus === "incomplete"
            ? "length"
            : !completed
              ? "length"
              : "stop";

      const completion = buildOpenAICompletion({
        id: respId || `resp-${Date.now()}`,
        model: respModel || params.model,
        content: content || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
        promptTokens: inputTokens,
        completionTokens: outputTokens,
      });

      // Preserve raw output items so reasoning items survive round-trips
      if (rawOutputItems.length > 0) {
        (completion.choices[0].message as any)._responsesOutput =
          rawOutputItems;
      }

      yield { type: "completion" as const, response: completion };
    },
  };
}

// ── Responses API helpers ──────────────────────────────────────

/**
 * Convert Chat Completions message array → Responses API input + instructions.
 * Reasoning items attached via `_responsesOutput` are round-tripped verbatim.
 */
function convertMsgsToResponsesInput(
  msgs: OpenAI.Chat.ChatCompletionMessageParam[],
): { instructions: string; input: any[] } {
  const systemParts: string[] = [];
  const input: any[] = [];

  for (const msg of msgs) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : "";
      if (text) systemParts.push(text);
      continue;
    }

    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : "";
      input.push({ role: "user", content: text });
      continue;
    }

    if (msg.role === "assistant") {
      const rawOutput = (msg as any)._responsesOutput;
      if (rawOutput) {
        input.push(...rawOutput);
        continue;
      }

      const content = (msg as any).content;
      const toolCalls = (msg as any).tool_calls;

      if (content && typeof content === "string") {
        input.push({ role: "assistant", content });
      }

      if (toolCalls) {
        for (const tc of toolCalls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments || "{}",
          });
        }
      }
      continue;
    }

    if (msg.role === "tool") {
      const toolMsg = msg as any;
      input.push({
        type: "function_call_output",
        call_id: toolMsg.tool_call_id,
        output: typeof toolMsg.content === "string" ? toolMsg.content : "",
      });
      continue;
    }
  }

  return { instructions: systemParts.join("\n\n"), input };
}

/** Convert Chat Completions tool defs → Responses API tool format. */
function convertToolsToResponses(
  tools?: OpenAI.Chat.ChatCompletionTool[],
): any[] | undefined {
  if (!tools?.length) return undefined;
  return tools
    .filter((t): t is Extract<typeof t, { type: "function" }> => t.type === "function")
    .map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description ?? "",
      parameters: t.function.parameters ?? { type: "object", properties: {} },
      strict: false,
    }));
}

/** Convert non-streaming Responses API output → Chat Completion. */
function responsesToCompletion(
  response: any,
  requestModel: string,
): OpenAI.Chat.ChatCompletion {
  let textContent: string | null = null;
  const toolCalls: ToolCallEntry[] = [];
  const rawOutputItems: any[] = [];

  for (const item of response.output ?? []) {
    rawOutputItems.push(item);
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") {
          textContent = (textContent ?? "") + part.text;
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id,
        type: "function",
        function: {
          name: item.name,
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments),
        },
      });
    }
  }

  const finishReason =
    toolCalls.length > 0
      ? "tool_calls"
      : response.status === "incomplete"
        ? "length"
        : "stop";

  const completion = buildOpenAICompletion({
    id: response.id ?? `resp-${Date.now()}`,
    model: response.model ?? requestModel,
    content: textContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    promptTokens: response.usage?.input_tokens,
    completionTokens: response.usage?.output_tokens,
  });

  if (rawOutputItems.length > 0) {
    (completion.choices[0].message as any)._responsesOutput = rawOutputItems;
  }

  return completion;
}

// ── Shared helpers ────────────────────────────────────────────

type ToolCallEntry = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

function buildOpenAICompletion(opts: {
  id: string;
  model: string;
  content: string | null;
  toolCalls?: ToolCallEntry[];
  finishReason: string;
  promptTokens?: number;
  completionTokens?: number;
}): OpenAI.Chat.ChatCompletion {
  return {
    id: opts.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: opts.content,
          ...(opts.toolCalls ? { tool_calls: opts.toolCalls } : {}),
          refusal: null,
        },
        finish_reason: opts.finishReason,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: opts.promptTokens ?? 0,
      completion_tokens: opts.completionTokens ?? 0,
      total_tokens: (opts.promptTokens ?? 0) + (opts.completionTokens ?? 0),
    },
  } as unknown as OpenAI.Chat.ChatCompletion;
}

// ── Message conversion (OpenAI → Anthropic) ───────────────────

interface AntMsg {
  role: "user" | "assistant";
  content: string | AntBlock[];
}

type AntBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

function convertMessagesToAnthropic(
  openaiMsgs: OpenAI.Chat.ChatCompletionMessageParam[],
): { systemText: string; messages: AntMsg[] } {
  const systemParts: string[] = [];
  const messages: AntMsg[] = [];

  for (const msg of openaiMsgs) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : "";
      if (text) systemParts.push(text);
      continue;
    }

    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : "";
      appendBlocks(messages, "user", [{ type: "text", text }]);
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: AntBlock[] = [];
      const content = (msg as any).content;
      if (content && typeof content === "string") {
        blocks.push({ type: "text", text: content });
      }
      const toolCalls = (msg as any).tool_calls;
      if (toolCalls) {
        for (const tc of toolCalls) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.function.arguments || "{}");
          } catch {}
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }
      if (blocks.length > 0) {
        messages.push({ role: "assistant", content: blocks });
      }
      continue;
    }

    if (msg.role === "tool") {
      const toolMsg = msg as any;
      appendBlocks(messages, "user", [
        {
          type: "tool_result",
          tool_use_id: toolMsg.tool_call_id,
          content: typeof toolMsg.content === "string" ? toolMsg.content : "",
        },
      ]);
      continue;
    }
  }

  return { systemText: systemParts.join("\n\n"), messages };
}

/** Merge blocks into the last message if roles match, else push new. */
function appendBlocks(
  messages: AntMsg[],
  role: "user" | "assistant",
  blocks: AntBlock[],
): void {
  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    const existing = Array.isArray(last.content)
      ? last.content
      : [{ type: "text" as const, text: last.content }];
    last.content = [...existing, ...blocks];
  } else {
    messages.push({ role, content: blocks });
  }
}

// ── Tool conversion (OpenAI → Anthropic) ──────────────────────

function convertToolsToAnthropic(
  tools?: OpenAI.Chat.ChatCompletionTool[],
): Array<{ name: string; description: string; input_schema: unknown }> {
  if (!tools) return [];
  return tools
    .filter((t): t is Extract<typeof t, { type: "function" }> => t.type === "function")
    .map((t) => ({
      name: t.function.name,
      description: t.function.description ?? "",
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    }));
}

// ── Response conversion (Anthropic → OpenAI, non-streaming) ───

function anthropicResponseToOpenAI(response: any): OpenAI.Chat.ChatCompletion {
  let textContent: string | null = null;
  const toolCalls: ToolCallEntry[] = [];

  for (const block of response.content ?? []) {
    if (block.type === "text") {
      textContent = (textContent ?? "") + block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const stopReason: string = response.stop_reason ?? "end_turn";
  const finishReason =
    stopReason === "tool_use"
      ? "tool_calls"
      : stopReason === "max_tokens"
        ? "length"
        : "stop";

  return buildOpenAICompletion({
    id: response.id ?? `ant-${Date.now()}`,
    model: response.model ?? "",
    content: textContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    promptTokens: response.usage?.input_tokens,
    completionTokens: response.usage?.output_tokens,
  });
}

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

      if (!finishReason) {
        console.warn(
          `[chatClient] OpenAI stream ended without finish_reason — response may be truncated`,
        );
      }

      const toolCalls = [...tcMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => {
          if (!tc.args) {
            console.warn(
              `[chatClient] tool call "${tc.name}" has empty arguments — likely stream truncation`,
            );
          }
          return {
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.args || "{}" },
          };
        });

      yield {
        type: "completion" as const,
        response: buildOpenAICompletion({
          id: respId || `stream-${Date.now()}`,
          model: respModel || params.model,
          content: content || null,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finishReason: finishReason ?? "stop",
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

      if (!messageComplete) {
        console.warn(
          `[chatClient] Anthropic stream ended without message_stop — response may be truncated`,
        );
      }

      const toolCalls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          const rawArgs = b.inputJson ?? "";
          if (b.type === "tool_use" && !rawArgs) {
            console.warn(
              `[chatClient] tool_use block "${b.name}" has empty inputJson — likely stream truncation`,
            );
          }
          return {
            id: b.id!,
            type: "function" as const,
            function: {
              name: b.name!,
              arguments: rawArgs || "{}",
            },
          };
        });

      const finishReason =
        stopReason === "tool_use"
          ? "tool_calls"
          : stopReason === "max_tokens"
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
  return tools.map((t) => ({
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

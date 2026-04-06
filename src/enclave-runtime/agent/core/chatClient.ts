/**
 * Unified chat completion interface — OpenAI and Anthropic backends.
 *
 * Internally everything flows as OpenAI-compatible types. The Anthropic
 * adapter converts on the fly so the rest of the stack (reactLoop,
 * planExecutor, …) never needs to care which provider is in use.
 *
 * Anthropic SDK is dynamically imported — it only needs to be installed
 * when `createAnthropicChatClient` is actually called.
 */
import type OpenAI from "openai";

// ── Public interface ──────────────────────────────────────────

export interface ChatClient {
  createChatCompletion(params: {
    model: string;
    messages: OpenAI.Chat.ChatCompletionMessageParam[];
    tools?: OpenAI.Chat.ChatCompletionTool[];
    temperature?: number;
  }): Promise<OpenAI.Chat.ChatCompletion>;
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

  return {
    async createChatCompletion(params) {
      const { systemText, messages } = convertMessagesToAnthropic(
        params.messages,
      );
      const tools = convertToolsToAnthropic(params.tools);

      const request: Record<string, unknown> = {
        model: params.model,
        max_tokens: maxTokens,
        messages,
      };
      if (systemText) request.system = systemText;
      if (tools.length > 0) request.tools = tools;
      if (params.temperature != null) request.temperature = params.temperature;

      const response = await (client.messages.create as Function)(request);
      return anthropicResponseToOpenAI(response);
    },
  };
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

// ── Response conversion (Anthropic → OpenAI) ──────────────────

function anthropicResponseToOpenAI(response: any): OpenAI.Chat.ChatCompletion {
  let textContent: string | null = null;
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

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
    // skip thinking / other block types
  }

  const stopReason: string = response.stop_reason ?? "end_turn";
  const finishReason =
    stopReason === "tool_use"
      ? "tool_calls"
      : stopReason === "max_tokens"
        ? "length"
        : "stop";

  return {
    id: response.id ?? `ant-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model ?? "",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: textContent,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          refusal: null,
        },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: response.usage?.input_tokens ?? 0,
      completion_tokens: response.usage?.output_tokens ?? 0,
      total_tokens:
        (response.usage?.input_tokens ?? 0) +
        (response.usage?.output_tokens ?? 0),
    },
  } as unknown as OpenAI.Chat.ChatCompletion;
}

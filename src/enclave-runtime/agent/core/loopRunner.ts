import OpenAI from "openai";
import type { AgentTool } from "./types";
import { reactLoop, type ReactLoopEvent } from "./reactLoop";
import { createLlmFetcher, customLlmFetch, getLLMHeaders } from "../../../utils/llm-adapter";
import { consumePendingEvolutedTool } from "../tools/evolute";

export interface AgentLoopMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentLoopGenerateOptions {
  model?: string;
  temperature?: number;
  imageUrls?: string[];
}

export interface AgentLoopRunner {
  streamEvents: (
    messages: AgentLoopMessage[],
    options?: AgentLoopGenerateOptions
  ) => AsyncGenerator<AgentLoopStreamEvent, void, unknown>;
  streamText: (
    messages: AgentLoopMessage[],
    options?: AgentLoopGenerateOptions
  ) => AsyncGenerator<string, void, unknown>;
  applyToolsToActiveLoops: () => void;
}

export type AgentLoopStreamEvent =
  | {
      type: "message_update";
      role: "assistant";
      delta: string;
    }
  | {
      type: "tool_execution_start";
      toolName: string;
      toolCallId?: string;
    }
  | {
      type: "tool_execution_end";
      toolName: string;
      toolCallId?: string;
      result?: unknown;
    }
  | {
      type: "turn_outcome";
      outcome: "finished" | "sleep" | "resume" | "plan" | "timeout";
      params?: import("./types").LogosCompleteParams;
    }
  | {
      type: "completed";
    }
  | {
      type: "failed";
      error: string;
    };

export interface CreateAgentLoopRunnerOptions {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  getCurrentTools: () => AgentTool[];
  registerDynamicTool: (tool: AgentTool) => Promise<void>;
  unregisterTool: (name: string) => Promise<boolean>;
}

function extractSystemPrompt(messages: AgentLoopMessage[]): string {
  return messages
    .filter((item) => item.role === "system")
    .map((item) => item.content)
    .join("\n")
    .trim();
}

function toOpenAIMessages(
  messages: AgentLoopMessage[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const systemPrompt = extractSystemPrompt(messages);
  const nonSystem = messages.filter((m) => m.role !== "system");

  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemPrompt) {
    result.push({ role: "system" as const, content: systemPrompt });
  }
  for (const m of nonSystem) {
    result.push({ role: m.role as "user" | "assistant", content: m.content });
  }
  return result;
}

interface ApoptosisToolResult {
  details?: {
    targetToolName?: string;
  };
}

function extractApoptosisTargetToolName(result: unknown): string | null {
  const targetToolName = (result as ApoptosisToolResult | undefined)?.details
    ?.targetToolName;
  if (typeof targetToolName !== "string") return null;
  const normalized = targetToolName.trim();
  return normalized.length > 0 ? normalized : null;
}

async function downloadImageAsBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const base64 = buf.toString("base64");
    const contentType = detectImageMime(
      buf,
      res.headers.get("content-type"),
      url
    );
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
}

function detectImageMime(
  buf: Buffer,
  headerType: string | null,
  url: string
): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";

  if (headerType && headerType.startsWith("image/")) return headerType;

  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";

  return "image/jpeg";
}

function injectVisionDescription(
  messages: AgentLoopMessage[],
  description: string
): AgentLoopMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages.map((m, idx) =>
        idx === i
          ? {
              ...m,
              content: m.content.replace(
                /\[photo(?:\s*x\d+)?\]/g,
                `[图片内容: ${description}]`
              ),
            }
          : m
      );
    }
  }
  return messages;
}

async function preprocessVisionContent(
  imageUrls: string[],
  apiKey: string,
  baseURL: string,
  modelId: string
): Promise<string | null> {
  try {
    const base64Urls = await Promise.all(imageUrls.map(downloadImageAsBase64));
    const valid = base64Urls.filter((u): u is string => u !== null);
    if (!valid.length) {
      console.warn("[vision] failed to download images for base64 encoding");
      return null;
    }

    const fetcher = createLlmFetcher({ apiKey, baseURL });
    const json: any = await fetcher("/chat/completions", {
      model: modelId,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Describe this image concisely. Include visible text, objects, and notable details. Use Chinese if appropriate.",
            },
            ...valid.map((u) => ({
              type: "image_url",
              image_url: { url: u },
            })),
          ],
        },
      ],
      max_tokens: 800,
    });
    return json?.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.warn("[vision] preprocessing failed:", err);
    return null;
  }
}

export function createAgentLoopRunner(
  options: CreateAgentLoopRunnerOptions
): AgentLoopRunner {
  const openaiClient = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    defaultHeaders: getLLMHeaders(),
    fetch: customLlmFetch,
  });

  const applyToolsToActiveLoops = () => {
    // In the new architecture, tools are fetched fresh each reactLoop iteration
    // via getCurrentTools(). No need to sync in-place.
  };

  const streamEvents: AgentLoopRunner["streamEvents"] = async function* (
    messages,
    generateOptions = {}
  ) {
    const { imageUrls, ...genOpts } = generateOptions;
    const modelId = genOpts.model ?? options.defaultModel;

    if (imageUrls?.length) {
      const description = await preprocessVisionContent(
        imageUrls,
        options.apiKey,
        options.baseURL,
        modelId
      );
      if (description) {
        messages = injectVisionDescription(messages, description);
      }
    }

    const openaiMessages = toOpenAIMessages(messages);
    const abortController = new AbortController();

    try {
      console.log(
        "[loopRunner] starting reactLoop, messages:",
        openaiMessages.length
      );

      const loop = reactLoop({
        client: openaiClient,
        model: modelId,
        messages: openaiMessages,
        tools: options.getCurrentTools(),
        signal: abortController.signal,
        temperature: genOpts.temperature,
      });

      let hasReply = false;

      for await (const event of loop) {
        switch (event.type) {
          case "tool_execution_start":
            yield {
              type: "tool_execution_start",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
            };
            break;

          case "tool_execution_end": {
            let toolsChanged = false;
            if (event.toolName === "evolute") {
              const pendingTool = consumePendingEvolutedTool(event.toolCallId);
              if (pendingTool) {
                await options.registerDynamicTool(pendingTool);
                toolsChanged = true;
              } else {
                console.warn(
                  `[evolute] pending tool not found for toolCallId=${event.toolCallId}`
                );
              }
            } else if (event.toolName === "apoptosis") {
              const targetToolName = extractApoptosisTargetToolName(
                event.result
              );
              if (targetToolName) {
                await options.unregisterTool(targetToolName);
                toolsChanged = true;
              }
            }
            if (toolsChanged) {
              // Tools changed but loop already has them via reference
            }
            yield {
              type: "tool_execution_end",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              result: event.result,
            };
            break;
          }

          case "message_update":
            // Internal reasoning text from LLM — skip for now.
            // Only the reply from logos_complete is delivered.
            break;

          case "logos_complete": {
            const { reply, sleep, resume, plan } = event.params;
            if (reply) {
              hasReply = true;
              yield {
                type: "message_update",
                role: "assistant",
                delta: reply,
              };
            }
            const outcome = plan?.length
              ? "plan"
              : resume
                ? "resume"
                : sleep
                  ? "sleep"
                  : "finished";
            yield {
              type: "turn_outcome",
              outcome,
              params: event.params,
            };
            break;
          }

          case "max_turns_reached":
            if (!hasReply) {
              yield {
                type: "message_update",
                role: "assistant",
                delta: "(max turns reached without logos_complete)",
              };
            }
            yield { type: "turn_outcome", outcome: "timeout" };
            break;
        }
      }

      yield { type: "completed" };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      console.error("[loopRunner] error:", errorMsg);
      yield { type: "failed", error: errorMsg };
    } finally {
      abortController.abort();
    }
  };

  const streamText: AgentLoopRunner["streamText"] = async function* (
    messages,
    generateOptions = {}
  ) {
    for await (const event of streamEvents(messages, generateOptions)) {
      if (event.type === "message_update" && event.delta) {
        yield event.delta;
        continue;
      }
      if (event.type === "failed") {
        throw new Error(event.error);
      }
    }
  };

  return {
    streamEvents,
    streamText,
    applyToolsToActiveLoops,
  };
}

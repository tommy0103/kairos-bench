import {
  agentLoop,
  type AgentContext,
  type AgentMessage,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import { consumePendingEvolutedTool } from "./tools/evolute";

export interface AgentLoopMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentLoopGenerateOptions {
  model?: string;
  temperature?: number;
}

export interface AgentLoopRunner {
  streamText: (
    messages: AgentLoopMessage[],
    options?: AgentLoopGenerateOptions
  ) => AsyncGenerator<string, void, unknown>;
  applyToolsToActiveLoops: () => void;
}

export interface CreateAgentLoopRunnerOptions {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  getCurrentTools: () => AgentTool<any>[];
  registerDynamicTool: (tool: AgentTool<any>) => Promise<void>;
  unregisterTool: (name: string) => Promise<boolean>;
}

const DEFAULT_PROVIDER = "openai";

function createCompatibleModel(modelId: string, baseURL: string): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: DEFAULT_PROVIDER,
    baseUrl: baseURL,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function extractSystemPrompt(messages: AgentLoopMessage[]): string {
  return messages
    .filter((item) => item.role === "system")
    .map((item) => item.content)
    .join("\n")
    .trim();
}

function extractLatestUserPrompt(messages: AgentLoopMessage[]): string {
  const latestUserMessage = [...messages]
    .reverse()
    .filter((item): item is AgentLoopMessage & { role: "user" } => item.role === "user")
    .find((item) => item.content.trim().length > 0);
  return latestUserMessage?.content ?? "";
}

function createTextStreamQueue() {
  const chunks: string[] = [];
  let isDone = false;
  let error: unknown;
  let wakeConsumer: (() => void) | null = null;

  const wake = () => {
    if (!wakeConsumer) {
      return;
    }
    const resolve = wakeConsumer;
    wakeConsumer = null;
    resolve();
  };

  return {
    push(chunk: string) {
      chunks.push(chunk);
      wake();
    },
    finish() {
      isDone = true;
      wake();
    },
    fail(err: unknown) {
      error = err;
      isDone = true;
      wake();
    },
    async *consume(): AsyncGenerator<string, void, unknown> {
      while (!isDone || chunks.length > 0) {
        if (chunks.length > 0) {
          const chunk = chunks.shift();
          if (chunk) {
            yield chunk;
          }
          continue;
        }
        await new Promise<void>((resolve) => {
          wakeConsumer = resolve;
        });
      }
      if (error) {
        throw error;
      }
    },
  };
}

function extractAssistantTextFromMessages(messages: AgentMessage[]): string {
  for (const message of [...messages].reverse()) {
    if ((message as any)?.role !== "assistant") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string" && content) {
      return content;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    const text = (content as Array<{ type?: string; text?: string }>)
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    if (text) {
      return text;
    }
  }
  return "";
}

function syncToolsInPlace(context: AgentContext, tools: AgentTool<any>[]) {
  if (!Array.isArray(context.tools)) {
    context.tools = [...tools];
    return;
  }
  context.tools.splice(0, context.tools.length, ...tools);
}

function isLlmMessage(message: AgentMessage): message is Message {
  const role = (message as any)?.role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

interface ApoptosisToolResult {
  details?: {
    targetToolName?: string;
  };
}

function extractApoptosisTargetToolName(result: unknown): string | null {
  const targetToolName = (result as ApoptosisToolResult | undefined)?.details?.targetToolName;
  if (typeof targetToolName !== "string") {
    return null;
  }
  const normalized = targetToolName.trim();
  return normalized.length > 0 ? normalized : null;
}

export function createAgentLoopRunner(options: CreateAgentLoopRunnerOptions): AgentLoopRunner {
  const activeAgentLoops = new Set<AgentContext>();

  const applyToolsToActiveLoops = () => {
    const tools = options.getCurrentTools();
    for (const activeAgentLoop of activeAgentLoops) {
      syncToolsInPlace(activeAgentLoop, tools);
    }
  };

  const streamText: AgentLoopRunner["streamText"] = async function* (
    messages,
    generateOptions = {}
  ) {
    const model = createCompatibleModel(generateOptions.model ?? options.defaultModel, options.baseURL);
    const prompt = extractLatestUserPrompt(messages);
    const systemPrompt = extractSystemPrompt(messages);
    if (!prompt.trim()) {
      return;
    }

    const queue = createTextStreamQueue();
    let promptFinished = false;
    let promptPromise: Promise<void> | null = null;
    const loopContext: AgentContext = {
      systemPrompt,
      messages: [],
      tools: options.getCurrentTools(),
    };
    const abortController = new AbortController();
    activeAgentLoops.add(loopContext);

    let currentMessageHasToolCall = false;
    let currentMessageTextBuffer = "";
    let globalMessageHasEmitted = false;
    try {
      const userPrompt = { role: "user", content: prompt, timestamp: Date.now() } as AgentMessage;
      const stream = agentLoop(
        [userPrompt],
        loopContext,
        {
          model,
          apiKey: options.apiKey,
          temperature: generateOptions.temperature,
          convertToLlm: async (agentMessages) => agentMessages.filter(isLlmMessage),
        },
        abortController.signal
      );

      promptPromise = (async () => {
        for await (const event of stream) {
          // console.log("[Raw Event] type:", event.type, " keys:", Object.keys(event));
          if (event.type === "message_update") {
            const assistantEvent = event.assistantMessageEvent;
            if (assistantEvent.type === "text_delta" && assistantEvent.delta) {
              currentMessageTextBuffer += assistantEvent.delta;
              continue;
            }
            if (
              assistantEvent.type === "text_end" &&
              assistantEvent.content
            ) {
              if (!currentMessageTextBuffer) {
                currentMessageTextBuffer = assistantEvent.content;
              }
              continue;
            }
            if (
              assistantEvent.type === "toolcall_start" ||
              assistantEvent.type === "toolcall_delta" ||
              assistantEvent.type === "toolcall_end"
            ) {
              currentMessageHasToolCall = true;
            }
            continue;
          }

          if (event.type === "message_end") {
            const message = event.message as {
              role?: string;
              content?: Array<{ type?: string; text?: string }>;
            };
            console.log(message.role, message.content);
            if (message.role !== "assistant") {
              currentMessageHasToolCall = false;
              currentMessageTextBuffer = "";
              continue;
            }
            if (!currentMessageHasToolCall) {
              let output = currentMessageTextBuffer;
              if (!output && Array.isArray(message.content)) {
                output = message.content
                  .filter((block) => block.type === "text" && typeof block.text === "string")
                  .map((block) => block.text as string)
                  .join("");
              }
              if (output) {
                globalMessageHasEmitted = true;
                queue.push(output);
              }
            }
            currentMessageHasToolCall = false;
            currentMessageTextBuffer = "";
            continue;
          }

          if (event.type === "tool_execution_end") {
            if(event.toolName === "evolute") {
              const pendingTool = consumePendingEvolutedTool(event.toolCallId);
              if (pendingTool) {
                await options.registerDynamicTool(pendingTool);
              }
              // options.toolsRegistry.registerDynamicTool(event.result.details);
              const latestTools = options.getCurrentTools();
              syncToolsInPlace(loopContext, latestTools);
            }
            else if (event.toolName === "apoptosis") {
              const targetToolName = extractApoptosisTargetToolName(event.result);
              if (targetToolName) {
                await options.unregisterTool(targetToolName);
                const latestTools = options.getCurrentTools();
                syncToolsInPlace(loopContext, latestTools);
              }
            }
            else {
              console.log("[Event: tool_execution_end] Tool:", event.toolName, 
                "Result:", event.result,
                "ToolCallId:", event.toolCallId);
            }
          }

          if(event.type === "tool_execution_start") {
            console.log("[Event: tool_execution_start] Tool:", event.toolName, 
              "Params:", event.args,
              "ToolCallId:", event.toolCallId);
          }
        }

        if (!globalMessageHasEmitted) {
          const newMessages = await stream.result();
          const fallbackText = extractAssistantTextFromMessages(newMessages);
          console.log(
            `[loopRunner] fallback extraction: found=${Boolean(fallbackText)} length=${fallbackText.length}`
          );
          if (fallbackText) {
            globalMessageHasEmitted = true;
            queue.push(fallbackText);
          }
        }

        promptFinished = true;
        queue.finish();
      })().catch((error) => {
        promptFinished = true;
        queue.fail(error);
      });

      for await (const chunk of queue.consume()) {
        yield chunk;
      }
      await promptPromise;
    } finally {
      if (!promptFinished && promptPromise) {
        abortController.abort();
        await promptPromise.catch(() => undefined);
      }
      activeAgentLoops.delete(loopContext);
      loopContext.messages.splice(0, loopContext.messages.length);
    }
  };

  return {
    streamText,
    applyToolsToActiveLoops,
  };
}

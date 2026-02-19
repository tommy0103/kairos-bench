import OpenAI from "openai";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CreateOpenAIAgentOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

export interface GenerateTextOptions {
  model?: string;
  temperature?: number;
}

export interface OpenAIAgent {
  generateText: (messages: LLMMessage[], options?: GenerateTextOptions) => Promise<string>;
  streamText: (
    messages: LLMMessage[],
    options?: GenerateTextOptions
  ) => AsyncGenerator<string, void, unknown>;
}

const DEFAULT_MODEL = "gpt-4o-mini";

export function createOpenAIAgent(
  options: CreateOpenAIAgentOptions = {}
): OpenAIAgent {
  const apiKey = options.apiKey ?? process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY is required for OpenAI agent.");
  }

  const defaultModel = options.model ?? DEFAULT_MODEL;
  const client = new OpenAI({ baseURL: options.baseURL ?? "https://api.deepseek.com/v1", apiKey });

  const generateText: OpenAIAgent["generateText"] = async (
    messages,
    generateOptions = {}
  ) => {
    const completion = await client.chat.completions.create({
      model: generateOptions.model ?? defaultModel,
      messages,
      temperature: generateOptions.temperature,
    });

    return completion.choices[0]?.message?.content ?? "";
  };

  const streamText: OpenAIAgent["streamText"] = async function* (
    messages,
    generateOptions = {}
  ) {
    const stream = await client.chat.completions.create({
      model: generateOptions.model ?? defaultModel,
      messages,
      temperature: generateOptions.temperature,
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content ?? "";
      if (!token) {
        continue;
      }
      yield token;
    }
  };

  return {
    generateText,
    streamText,
  };
}

import type { LocalModel, LocalModelCompleteInput, LocalModelCompleteOutput } from "./types";

export interface CreateOllamaLocalModelOptions {
  baseUrl?: string;
  model?: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen3.5:0.8b";

interface OllamaGenerateResponse {
  response?: string;
  done?: boolean;
}

export function createOllamaLocalModel(
  options: CreateOllamaLocalModelOptions = {}
): LocalModel {
  const baseUrl = (options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    ""
  );
  const model =
    options.model ?? process.env.OLLAMA_SESSION_MODEL ?? DEFAULT_MODEL;

  return {
    async complete(input: LocalModelCompleteInput): Promise<LocalModelCompleteOutput> {
      const { prompt } = input;
      if (input.attachments?.length) {
        throw new Error("Ollama local model does not support attachments yet.");
      }

      const response = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
        }),
      });

      if (!response.ok) {
        const reason = await response.text().catch(() => "");
        throw new Error(`Ollama generate failed (${response.status}): ${reason}`);
      }

      const data = (await response.json()) as OllamaGenerateResponse;
      const text = typeof data.response === "string" ? data.response : "";
      return { text };
    },
  };
}

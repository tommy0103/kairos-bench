import type { DenseEmbedder } from "../types";

export interface CreateOllamaDenseEmbedderOptions {
  baseUrl?: string;
  model?: string;
}

interface OllamaEmbedResponse {
  embedding?: number[];  
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "bge-m3";

const normalizeVector = (vector: number[]): number[] => {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
};

export const createOllamaDenseEmbedder = (
  options: CreateOllamaDenseEmbedderOptions = {},
): DenseEmbedder => {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_MODEL;

  return {
    async embedDense(text: string): Promise<number[]> {
      const input = text.trim() || "(empty)";
      const response = await fetch(`${baseUrl}/api/embeddings`, {
        method: "POST",
        // headers: {
        //   "content-type": "application/json",
        // },
        // headers: {
        //   "content-type": "application/x-www-form-urlencoded"
        // },
        body: JSON.stringify({
          model,
          prompt: input,
        }),
      });

      if (!response.ok) {
        const reason = await response.text().catch((error) => console.error(error));
        console.log("input", input);
        console.log("body", JSON.stringify({
          model,
          prompt: input,
        }));
        throw new Error(
          `Ollama embed request failed (${response.status}): ${reason}`,
        );
      }

      const data = (await response.json()) as OllamaEmbedResponse;
      const embedding = data?.embedding;
      // if (!Array.isArray(embeddings) || embeddings.length !== 1) {
      //   throw new Error("Invalid Ollama response: embeddings is missing.");
      // // }
      // return normalizeVector(embeddings[0]); 
      if(!Array.isArray(embedding)) {
        throw new Error("Invalid Ollama response: embedding is missing.");
      }
      return embedding;
      // return normalizeVector(embedding);
    },
  };
};

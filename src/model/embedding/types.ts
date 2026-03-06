export interface DenseEmbedder {
  embedDense(text: string): Promise<number[]>;
  dimension?: number;
}

export interface CreateDenseEmbedderOptions {
  provider?: "ollama" | "native";
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

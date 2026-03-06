import { totalmem } from "node:os";
import { createNativeDenseEmbedder } from "./providers/native";
import { createOllamaDenseEmbedder } from "./providers/ollama";
import type { CreateDenseEmbedderOptions, DenseEmbedder } from "./types";

const FULL_MODEL = "bge-m3";
const Q8_MODEL = "qllama/bge-m3:q8_0";
const Q4_MODEL = "qllama/bge-m3:q4_k_m";
const BYTES_PER_GB = 1024 ** 3;
const FULL_MODEL_THRESHOLD_GB = 8;
const Q8_MODEL_THRESHOLD_GB = 4;

const pickAutoModelByMemory = (): string => {
  const totalMemoryGB = totalmem() / BYTES_PER_GB;
  if (totalMemoryGB >= FULL_MODEL_THRESHOLD_GB) {
    return FULL_MODEL;
  }
  if (totalMemoryGB >= Q8_MODEL_THRESHOLD_GB) {
    return Q8_MODEL;
  }
  return Q4_MODEL;
};

const resolveOllamaModel = (options: CreateDenseEmbedderOptions): string => {
  if (options.ollamaModel) return options.ollamaModel;
  if (process.env.OLLAMA_EMBED_MODEL) return process.env.OLLAMA_EMBED_MODEL;
  return pickAutoModelByMemory();
};

export const createDenseEmbedder = (
  options: CreateDenseEmbedderOptions = {},
): DenseEmbedder => {
  const provider =
    options.provider ??
    (process.env.EMBED_PROVIDER as "ollama" | "native" | undefined) ??
    "ollama";

  if (provider === "native") {
    return createNativeDenseEmbedder();
  }

  return createOllamaDenseEmbedder({
    baseUrl: options.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL,
    model: resolveOllamaModel(options),
  });
};

export * from "./types";
export * from "./providers/ollama";
export * from "./providers/native";

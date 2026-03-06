import type { DenseEmbedder } from "../types";

export interface CreateNativeDenseEmbedderOptions {
  moduleName?: string;
}

export const createNativeDenseEmbedder = (
  options: CreateNativeDenseEmbedderOptions = {},
): DenseEmbedder => {
  const moduleName = options.moduleName ?? "@memoh-lite/embedder-native";

  return {
    async embedDense(_text: string): Promise<number[]> {
      throw new Error(
        `Native embedder is not implemented yet. Expected module: ${moduleName}`,
      );
    },
  };
};

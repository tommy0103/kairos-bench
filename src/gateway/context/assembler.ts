import type { LLMMessage } from "../../agent/core/openai";
import type { ContextAssembler } from "./types";

export function createContextAssembler(): ContextAssembler {
  return {
    build: ({ history, triggerMessage, prompt, systemPrompt }) => {
      const userHistory: LLMMessage[] = history
        .map((item) => ({
          role: "user" as const,
          content: item.messageId === triggerMessage.messageId ? prompt : item.context,
        }))
        .filter((item) => item.content.trim().length > 0);

      return [{ role: "system", content: systemPrompt }, ...userHistory];
    },
  };
}

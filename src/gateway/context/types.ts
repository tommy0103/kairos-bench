import type { LLMMessage } from "../../agent/core/openai";
import type { TelegramMessage } from "../../telegram/types";

export interface ContextStore {
  append: (message: TelegramMessage) => void;
  getByChat: (chatId: number) => TelegramMessage[];
}

export interface ContextAssembler {
  build: (input: {
    history: TelegramMessage[];
    triggerMessage: TelegramMessage;
    prompt: string;
    systemPrompt: string;
  }) => LLMMessage[];
}

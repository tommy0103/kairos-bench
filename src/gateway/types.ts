import type { OpenAIAgent } from "../agent";
import type { TelegramAdapter, TelegramMessage } from "../telegram/types";

export interface GatewayContext {
  telegram: TelegramAdapter;
  agent: OpenAIAgent;
}

export interface GatewayTriggerStrategy {
  name: string;
  priority: number;
  tryTrigger: (
    message: TelegramMessage,
    context: GatewayContext
  ) => Promise<string | null> | string | null;
}

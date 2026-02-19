import type { GatewayTriggerStrategy } from "../types";

export function createMentionMeTriggerStrategy(): GatewayTriggerStrategy {
  return {
    name: "MentionMe",
    priority: 20,
    tryTrigger: (message) => {
      if (!message.metadata.isMentionMe) {
        return null;
      }
      return message.context.trim() || null;
    },
  };
}

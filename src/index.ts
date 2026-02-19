import { createOpenAIAgent } from "./agent";
import {
  createMentionMeTriggerStrategy,
  createMessageGateway,
} from "./gateway";
import { createTelegramAdapter } from "./telegram/adapter";

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = process.env.DEEPSEEK_API_KEY;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required to start telegram bot.");
}
if (!API_KEY) {
  throw new Error("API_KEY is required to start AI orchestrator.");
}

const telegram = createTelegramAdapter(BOT_TOKEN);
const agent = createOpenAIAgent({ model: "deepseek-chat", baseURL: "https://api.deepseek.com/v1", apiKey: API_KEY });
const gateway = createMessageGateway({
  telegram,
  agent,
  strategies: [
    createMentionMeTriggerStrategy(),
  ],
});

process.on("SIGINT", () => {
  gateway.stop();
  telegram.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  gateway.stop();
  telegram.stop();
  process.exit(0);
});

telegram.start().then(
  () => {
    console.log("Telegram bot stopped.");
  },
  (error) => {
    console.error("Failed to start telegram bot:", error);
    process.exit(1);
  }
);

console.log("Telegram bot and message gateway are running.");

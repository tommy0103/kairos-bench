import {
  createClientRuntime,
  createMentionMeTriggerPolicy,
  createMessageGateway,
  createReplyToMeTriggerPolicy,
} from "./gateway";
import { createTelegramAdapter } from "./telegram/adapter";
import { createUserRolesStore } from "./storage";
import { createGrpcEnclaveClient } from "./enclave/client";
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = process.env.API_KEY ?? process.env.QWEN_API_KEY;
const AGENT_ENCLAVE_TARGET = process.env.AGENT_ENCLAVE_TARGET;
const OWNER_USER_ID = process.env.OWNER_USER_ID;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required to start telegram bot.");
}
if (!AGENT_ENCLAVE_TARGET && !API_KEY) {
  throw new Error("API_KEY (or DEEPSEEK_API_KEY) is required to start AI orchestrator.");
}

const telegram = createTelegramAdapter(BOT_TOKEN);
const enclaveClient = createGrpcEnclaveClient({
    target: AGENT_ENCLAVE_TARGET ?? "",
});

process.on("SIGHUP", () => {

});

const userRoles = createUserRolesStore();
if (OWNER_USER_ID) {
  userRoles.setRole(OWNER_USER_ID, "owner");
  console.log(`Owner registered: ${OWNER_USER_ID}`);
}

const runtime = createClientRuntime({
  enclaveClient,
});

const gateway = createMessageGateway({
  telegram,
  runtime,
  policies: [
    createReplyToMeTriggerPolicy(),
    createMentionMeTriggerPolicy(),
  ],
  userRoles,
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

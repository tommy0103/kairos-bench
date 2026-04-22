#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import OpenAI from "openai";
import {
  createOpenAIChatClient,
  createAnthropicChatClient,
} from "../agent/core/chatClient";
import { createTuiSession } from "./runtime/tuiRuntime";
import { App } from "./components/App";

const apiKey = process.env.API_KEY ?? "";
const model = process.env.MODEL ?? "deepseek-chat";
const task = process.argv[2] ?? "";
const logosSocket = process.env.LOGOS_SOCKET ?? "";

if (!apiKey) {
  console.error("Error: API_KEY is required.");
  process.exit(1);
}
if (!logosSocket) {
  console.error("Error: LOGOS_SOCKET is required. Start the kernel first.");
  process.exit(1);
}

type Provider = "openai" | "anthropic";
function detectProvider(m: string): Provider {
  return m.toLowerCase().startsWith("claude") ? "anthropic" : "openai";
}
const provider: Provider =
  (process.env.API_PROVIDER as Provider) || detectProvider(model);

function guessContextLimit(m: string): number {
  const s = m.toLowerCase();
  if (s.includes("deepseek")) return 64_000;
  if (s.includes("gpt-4o")) return 128_000;
  if (s.includes("claude")) return 200_000;
  return 64_000;
}

async function main() {
  console.log(`[tui] model: ${model} | provider: ${provider}`);

  let chatClient;
  if (provider === "anthropic") {
    chatClient = await createAnthropicChatClient({
      apiKey,
      maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? "65536", 10),
    });
  } else {
    const openai = new OpenAI({
      apiKey,
      baseURL: process.env.BASE_URL ?? "https://api.deepseek.com/v1",
    });
    chatClient = createOpenAIChatClient(openai);
  }

  const projectPath = process.cwd();
  console.log(`[tui] creating session for ${projectPath}...`);
  const session = await createTuiSession({
    socketPath: logosSocket,
    projectPath,
  });
  console.log(`[tui] session ${session.sessionId} ready`);

  const { waitUntilExit } = render(
    React.createElement(App, {
      client: chatClient,
      model,
      tools: session.tools,
      contextLimit: guessContextLimit(model),
      initialTask: task,
      onNodeComplete: session.onNodeComplete,
      logosClient: session.logosClient,
      sessionId: session.sessionId,
      initialCheckpointId: session.initialCheckpointId,
    })
  );

  await waitUntilExit();
  session.cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error(`[tui] fatal: ${err}`);
  process.exit(1);
});

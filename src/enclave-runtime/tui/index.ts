#!/usr/bin/env bun
import OpenAI from "openai";
import {
  createOpenAIChatClient,
  createAnthropicChatClient,
} from "../agent/core/chatClient";
import { createStandaloneSession } from "../agent/runtime/benchRuntime";
import { TaskTree } from "./runtime/taskTree";
import type { TaskTreeEvent } from "./runtime/taskTree";

const apiKey = process.env.API_KEY ?? "";
const model = process.env.MODEL ?? "deepseek-chat";
const task = process.argv[2];

if (!task) {
  console.error("Usage: bun run src/tui/index.ts <task-description>");
  process.exit(1);
}
if (!apiKey) {
  console.error("Error: API_KEY is required.");
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
  console.log(`[tui] task: ${task}`);
  console.log(`[tui] model: ${model} | provider: ${provider}`);

  const session = createStandaloneSession();

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

  const tree = new TaskTree({
    client: chatClient,
    model,
    tools: [...session.tools],
    originalTask: task,
    maxTurnsPerAgent: parseInt(process.env.MAX_TURNS ?? "100", 10),
    temperature: 0.2,
    contextLimit: guessContextLimit(model),
    kernelMode: false,
  });

  tree.on("event", (ev: TaskTreeEvent) => {
    switch (ev.type) {
      case "node_created":
        console.log(`[tree] + node "${ev.node.description}"`);
        break;
      case "node_updated":
        console.log(`[tree] ~ ${ev.node.status}: "${ev.node.description}" — ${ev.node.summary ?? ""}`);
        break;
      case "depth_changed":
        console.log(`[tree] depth: ${ev.breadcrumb.map((n) => n.description).join(" > ")}`);
        break;
      case "execution_started":
        console.log(`[tree] ▶ ${ev.role}: "${ev.node.description}"`);
        break;
      case "execution_finished":
        console.log(`[tree] ■ execution finished`);
        break;
      case "react_loop_event": {
        const re = ev.event;
        if (re.type === "tool_execution_start") {
          const args = JSON.stringify(re.params);
          const preview = args.length > 200 ? args.slice(0, 200) + "…" : args;
          console.log(`  [tool] ${re.toolName}(${preview})`);
        } else if (re.type === "tool_execution_end" && re.toolName !== "logos_complete") {
          const text =
            typeof re.result === "object" && re.result !== null
              ? ((re.result as any)?.content?.[0]?.text ?? "")
              : String(re.result ?? "");
          const preview = text.length > 300 ? text.slice(0, 300) + "…" : text;
          console.log(`  [result] ${preview}`);
        } else if (re.type === "logos_complete") {
          console.log(`  [complete] ${re.params.summary}`);
          if (re.params.plan) console.log(`  [plan] ${re.params.plan.join(", ")}`);
        } else if (re.type === "context_pressure") {
          console.log(`  [context] ~${re.estimatedTokens}/${re.limit} tokens`);
        }
        break;
      }
    }
  });

  await tree.run();

  function printTree(node: typeof tree.root, indent = "") {
    const icon = node.status === "completed" ? "✓" : node.status === "aborted" ? "⚠" : "✗";
    console.log(`${indent}[${icon}] ${node.description} — ${node.summary ?? ""}`);
    for (const child of node.children) {
      printTree(child, indent + "  ");
    }
    for (const p of node.pendingPlan) {
      console.log(`${indent}  [_] ${p}`);
    }
  }

  console.log("\n=== Task Tree ===");
  printTree(tree.root);

  session.cleanup();
  const success = tree.root.status === "completed";
  console.log(`\n[tui] done. success=${success}`);
  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  console.error(`[tui] fatal: ${err}`);
  process.exit(1);
});

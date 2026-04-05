#!/usr/bin/env bun
/**
 * Terminal adapter for the Logos runtime — fully integrated with Logos kernel.
 *
 * Architecture:
 *   terminal-adapter (this file)
 *     → reactLoop (LLM + tool calls)
 *       → logos_read/write/patch/exec/call → Logos kernel via gRPC
 *       → logos_complete → intercepted → CompleteHandler → Call("system.complete")
 *
 * Usage:
 *   API_KEY=sk-xxx LOGOS_SOCKET=/path/to/logos.sock bun run src/enclave-runtime/terminal-adapter.ts
 *
 * Env vars:
 *   API_KEY       — LLM API key (required)
 *   BASE_URL      — API endpoint (default: https://api.deepseek.com/v1)
 *   MODEL         — Model name (default: deepseek-chat)
 *   LOGOS_SOCKET   — Path to logos-kernel Unix socket (required)
 *   AGENT_CONFIG   — Agent config ID for sandbox (default: terminal-adapter)
 */
import OpenAI from "openai";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { reactLoop } from "./agent/core/reactLoop";
import type { AgentTool, LogosCompleteParams } from "./agent/core/types";
import { createLogosCompleteTool } from "./agent/tools/logosComplete";
import { createLogosClient, type LogosClient } from "./agent/runtime/logosClient";
import { createAllLogosTools } from "./agent/runtime/logosTools";
import {
  createCompleteHandler,
  type TurnOutcome,
} from "./agent/runtime/completeHandler";

// ── ANSI colors ──────────────────────────────────────────────
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// ── Config ───────────────────────────────────────────────────
const apiKey = process.env.API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const baseURL = process.env.BASE_URL ?? "https://api.deepseek.com/v1";
const model = process.env.MODEL ?? "deepseek-chat";
const logosSocket = process.env.LOGOS_SOCKET ?? "";
const agentConfigId = process.env.AGENT_CONFIG ?? "terminal-adapter";

if (!apiKey) {
  console.error(`${RED}Error: API_KEY is required.${RESET}`);
  process.exit(1);
}
if (!logosSocket) {
  console.error(`${RED}Error: LOGOS_SOCKET is required. Point it to the logos-kernel Unix socket.${RESET}`);
  process.exit(1);
}

// ── Initialize ───────────────────────────────────────────────

const openaiClient = new OpenAI({ apiKey, baseURL });

const logosClient = createLogosClient({ socketPath: logosSocket });
const completeHandler = createCompleteHandler({ logosClient });

async function initSession(taskId: string): Promise<void> {
  const token = `tok-${randomUUID()}`;
  await logosClient.registerToken(token, taskId, "agent", agentConfigId);
  await logosClient.handshake(token);
  console.log(`${DIM}[session] bound to task ${taskId}${RESET}`);
}

async function createTask(description: string): Promise<string> {
  const taskId = `task-${randomUUID().slice(0, 8)}`;
  // Write task to the kernel's task table
  const taskRecord = JSON.stringify({
    task_id: taskId,
    description,
    status: "active",
    workspace: `logos://sandbox/${taskId}`,
    created_at: new Date().toISOString(),
  });
  try {
    // Read existing tasks, append, write back
    let existing: { tasks: any[] } = { tasks: [] };
    try {
      const raw = await logosClient.read("logos://system/tasks");
      existing = JSON.parse(raw);
    } catch {
      // Task table may not exist yet
    }
    existing.tasks.push(JSON.parse(taskRecord));
    await logosClient.write(
      "logos://system/tasks",
      JSON.stringify(existing, null, 2)
    );
  } catch (err) {
    console.warn(
      `${YELLOW}[task] could not write to kernel task table: ${err instanceof Error ? err.message : err}${RESET}`
    );
  }
  return taskId;
}

// ── Tools ────────────────────────────────────────────────────

const logosTools = createAllLogosTools(logosClient);
const tools: AgentTool[] = [...logosTools, createLogosCompleteTool()];

// ── System prompt ────────────────────────────────────────────

function buildSystemPrompt(taskId: string, description: string): string {
  return `You are a Logos agent. Your current task: ${taskId} — "${description}"

Available tools:
- logos_read(uri)   — Read from any Logos URI
- logos_write(uri, content) — Write to a Logos URI
- logos_patch(uri, partial) — Patch a Logos URI
- logos_exec(command)  — Execute shell command in sandbox
- logos_call(tool, params) — Call a proc tool
- logos_complete(...)  — MANDATORY: call this to end every turn

Rules:
- You MUST call logos_complete to end every turn.
- Put your user-facing answer in the "reply" field of logos_complete.
- Put a brief summary of what you did in the "summary" field.
- Use logos_exec for shell commands — it runs in a sandboxed environment.
- Use logos_read("logos://system/tasks") to see active/sleeping tasks.
- If you hit an error you cannot fix, call logos_complete with sleep.
- Be concise.`;
}

// ── Turn execution ───────────────────────────────────────────

async function executeTurn(
  taskId: string,
  description: string,
  userMessage: string,
  history: OpenAI.Chat.ChatCompletionMessageParam[]
): Promise<TurnOutcome> {
  const systemPrompt = buildSystemPrompt(taskId, description);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];

  console.log(`\n${DIM}--- turn started [${taskId}] ---${RESET}`);

  const loop = reactLoop({
    client: openaiClient,
    model,
    messages,
    tools,
    temperature: 0.3,
  });

  let completeParams: LogosCompleteParams | undefined;

  for await (const event of loop) {
    switch (event.type) {
      case "message_update":
        console.log(
          `${DIM}[thinking] ${truncate(event.delta, 120)}${RESET}`
        );
        break;

      case "tool_execution_start":
        if (event.toolName === "logos_complete") {
          console.log(`${GREEN}[logos_complete]${RESET}`);
        } else {
          console.log(`${YELLOW}[tool] ${event.toolName}${RESET}`);
        }
        break;

      case "tool_execution_end":
        if (event.toolName !== "logos_complete") {
          const preview = extractPreview(event.result);
          console.log(`${DIM}${truncate(preview, 500)}${RESET}`);
        }
        break;

      case "logos_complete":
        completeParams = event.params;
        console.log(
          `${GREEN}[logos_complete params] ${JSON.stringify(event.params, null, 2)}${RESET}`
        );
        break;

      case "max_turns_reached":
        console.log(
          `${RED}[max turns reached without logos_complete]${RESET}`
        );
        break;
    }
  }

  console.log(`${DIM}--- turn ended ---${RESET}`);

  if (completeParams) {
    return completeHandler.handle(taskId, completeParams);
  }
  return completeHandler.handleTimeout(taskId);
}

// ── Main loop ────────────────────────────────────────────────

const conversationHistory: OpenAI.Chat.ChatCompletionMessageParam[] = [];

async function handleUserInput(userText: string): Promise<void> {
  const taskId = await createTask(userText);
  console.log(
    `${DIM}[task] created ${taskId}: "${truncate(userText, 60)}"${RESET}`
  );

  // Establish a kernel session for this task
  await initSession(taskId);

  let outcome = await executeTurn(
    taskId,
    userText,
    userText,
    conversationHistory
  );

  while (true) {
    switch (outcome.type) {
      case "finished": {
        if (outcome.reply) {
          console.log(`\n${BOLD}${CYAN}Agent:${RESET} ${outcome.reply}`);
          conversationHistory.push({
            role: "assistant",
            content: outcome.reply,
          });
        } else {
          console.log(`${DIM}(no reply)${RESET}`);
        }
        if (outcome.anchorId) {
          console.log(
            `${MAGENTA}[anchor] ${outcome.anchorId}${RESET}`
          );
        }
        console.log(`${DIM}[task] ${outcome.taskId} → finished${RESET}`);
        return;
      }

      case "sleep": {
        if (outcome.reply) {
          console.log(`\n${BOLD}${CYAN}Agent:${RESET} ${outcome.reply}`);
          conversationHistory.push({
            role: "assistant",
            content: outcome.reply,
          });
        }
        console.log(
          `${YELLOW}[task] ${outcome.taskId} → sleep (${outcome.reason}, retry=${outcome.retry})${RESET}`
        );

        if (outcome.retry) {
          console.log(`${DIM}[adapter] auto-retrying...${RESET}`);
          // Re-establish session for the resumed task
          await initSession(outcome.taskId);
          outcome = await executeTurn(
            outcome.taskId,
            userText,
            userText,
            conversationHistory
          );
          continue;
        }
        return;
      }

      case "resume": {
        console.log(
          `${MAGENTA}[task] discarded ${outcome.discardedTaskId}, resuming ${outcome.resumeTaskId}${RESET}`
        );
        await initSession(outcome.resumeTaskId);
        outcome = await executeTurn(
          outcome.resumeTaskId,
          userText,
          userText,
          conversationHistory
        );
        continue;
      }

      case "plan": {
        console.log(
          `${MAGENTA}[plan] ${outcome.subtasks.length} subtasks (Phase 3):${RESET}`
        );
        for (const [i, sub] of outcome.subtasks.entries()) {
          console.log(`${DIM}  ${i + 1}. ${sub}${RESET}`);
        }
        return;
      }

      case "timeout": {
        console.log(
          `${RED}[task] ${outcome.taskId} → sleep (timeout)${RESET}`
        );
        console.log(`${DIM}[adapter] auto-retrying after timeout...${RESET}`);
        await initSession(outcome.taskId);
        outcome = await executeTurn(
          outcome.taskId,
          userText,
          userText,
          conversationHistory
        );
        continue;
      }
    }
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...[truncated]";
}

function extractPreview(result: unknown): string {
  if (typeof result === "object" && result !== null) {
    return (
      (result as any)?.content?.[0]?.text ??
      JSON.stringify(result).slice(0, 500)
    );
  }
  return String(result ?? "");
}

async function main(): Promise<void> {
  console.log(`${BOLD}Kairos Terminal Adapter (Logos Kernel)${RESET}`);
  console.log(`${DIM}model:  ${model} | base: ${baseURL}${RESET}`);
  console.log(`${DIM}kernel: ${logosSocket}${RESET}`);
  console.log(
    `${DIM}tools:  ${tools.map((t) => t.name).join(", ")}${RESET}`
  );

  // Verify kernel connectivity
  try {
    const tasks = await logosClient.read("logos://system/tasks");
    const parsed = JSON.parse(tasks);
    const sleeping = (parsed.tasks ?? []).filter(
      (t: any) => t.status === "sleep"
    );
    if (sleeping.length > 0) {
      console.log(`${YELLOW}Sleeping tasks:${RESET}`);
      for (const t of sleeping) {
        console.log(`${DIM}  ${t.task_id}: ${t.description}${RESET}`);
      }
    }
    console.log(`${GREEN}[kernel] connected${RESET}`);
  } catch (err) {
    console.error(
      `${RED}[kernel] connection failed: ${err instanceof Error ? err.message : err}${RESET}`
    );
    console.error(
      `${RED}Make sure logos-kernel is running and LOGOS_SOCKET points to the correct Unix socket.${RESET}`
    );
    process.exit(1);
  }

  console.log(
    `${DIM}Type your message, press Enter. Ctrl+C to exit.${RESET}\n`
  );

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question(`${BOLD}You:${RESET} `, async (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        prompt();
        return;
      }
      conversationHistory.push({ role: "user", content: trimmed });
      try {
        await handleUserInput(trimmed);
      } catch (err) {
        console.error(
          `${RED}Error: ${err instanceof Error ? err.message : String(err)}${RESET}`
        );
      }
      prompt();
    });
  };

  prompt();
}

main();

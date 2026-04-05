#!/usr/bin/env bun
/**
 * Non-interactive task runner for Terminal-Bench.
 *
 * Called by the Python AbstractInstalledAgent harness.
 * Accepts a task description, runs the reactLoop until logos_complete,
 * then exits with code 0 (success) or 1 (failure).
 *
 * Two modes:
 *   1. Full Logos kernel (LOGOS_SOCKET set): all tools go through gRPC
 *   2. Standalone (no LOGOS_SOCKET): local shell exec, no kernel needed
 *
 * Usage:
 *   API_KEY=sk-xxx bun run bench-runner.ts "Install nginx and verify it's running"
 *   API_KEY=sk-xxx LOGOS_SOCKET=/tmp/logos.sock bun run bench-runner.ts "..."
 *
 * Env vars:
 *   API_KEY        — LLM API key (required)
 *   BASE_URL       — API endpoint (default: https://api.deepseek.com/v1)
 *   MODEL          — Model name (default: deepseek-chat)
 *   LOGOS_SOCKET   — Path to logos-kernel Unix socket (optional; enables kernel mode)
 *   AGENT_CONFIG   — Agent config ID (default: bench-runner)
 *   MAX_TURNS      — Maximum ReAct loop turns (default: 100)
 */
import OpenAI from "openai";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { reactLoop } from "./agent/core/reactLoop";
import type { AgentTool, LogosCompleteParams } from "./agent/core/types";
import { createLogosCompleteTool } from "./agent/tools/logosComplete";
import { createLogosClient } from "./agent/runtime/logosClient";
import { createAllLogosTools } from "./agent/runtime/logosTools";
import { createCompleteHandler } from "./agent/runtime/completeHandler";

// ── Config ───────────────────────────────────────────────────
const apiKey = process.env.API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const baseURL = process.env.BASE_URL ?? "https://api.deepseek.com/v1";
const model = process.env.MODEL ?? "deepseek-chat";
const logosSocket = process.env.LOGOS_SOCKET ?? "";
const agentConfigId = process.env.AGENT_CONFIG ?? "bench-runner";
const maxTurns = parseInt(process.env.MAX_TURNS ?? "100", 10);

const taskDescription = process.argv[2];
if (!taskDescription) {
  console.error("Usage: bench-runner.ts <task-description>");
  process.exit(1);
}
if (!apiKey) {
  console.error("Error: API_KEY is required.");
  process.exit(1);
}

const useKernel = !!logosSocket;

// ── Standalone exec tool (no kernel) ─────────────────────────

function createLocalExecTool(): AgentTool {
  return {
    name: "logos_exec",
    label: "Execute",
    description:
      "Execute a shell command. Use this for all terminal operations.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute." }),
    }),
    execute: async (_id, params, signal) => {
      const text = await runLocal(params.command, 120_000, signal);
      return { content: [{ type: "text", text }] };
    },
  };
}

function runLocal(
  command: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: process.env.HOME ?? "/",
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;

    const onAbort = () => { child.kill("SIGTERM"); reject(new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);

    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", (err) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, sig) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      if (timedOut) { resolve(`[timed out]\nstdout:\n${stdout}\nstderr:\n${stderr}`); return; }
      const lines = [`exit_code: ${code ?? "null"}`, `signal: ${sig ?? "null"}`];
      if (stdout) lines.push(`\nstdout:\n${stdout}`);
      if (stderr) lines.push(`\nstderr:\n${stderr}`);
      resolve(lines.join("\n"));
    });
  });
}

// ── System prompt ────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an autonomous terminal agent. Your task:

${taskDescription}

Available tools:
- logos_exec(command) — Execute a shell command
- logos_complete(...) — MANDATORY: call this when the task is done or you need to stop

Rules:
- You MUST call logos_complete to end the task.
- Execute commands one at a time, observe output, then decide next steps.
- If the task is complete, call logos_complete with a summary.
- If you encounter an unrecoverable error, call logos_complete with sleep.
- Do NOT ask the user for input. Solve the task autonomously.
- Be efficient — minimize unnecessary commands.`;

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[bench-runner] task: ${taskDescription}`);
  console.log(`[bench-runner] model: ${model} | kernel: ${useKernel ? logosSocket : "standalone"}`);

  let tools: AgentTool[];
  let handleComplete: (taskId: string, params: LogosCompleteParams) => Promise<any>;
  let cleanup: () => void = () => {};

  if (useKernel) {
    const logosClient = createLogosClient({ socketPath: logosSocket });
    const logosTools = createAllLogosTools(logosClient);
    tools = [...logosTools, createLogosCompleteTool()];

    const taskId = `bench-${randomUUID().slice(0, 8)}`;

    await logosClient.write(
      "logos://system/tasks",
      JSON.stringify({
        task_id: taskId,
        description: taskDescription,
        workspace: `logos://sandbox/${taskId}`,
      })
    );

    const token = `tok-${randomUUID()}`;
    await logosClient.registerToken(token, taskId, "agent", agentConfigId);
    await logosClient.handshake(token);
    console.log(`[bench-runner] kernel session: ${taskId}`);

    const handler = createCompleteHandler({ logosClient });
    handleComplete = (_, params) => handler.handle(taskId, params);
    cleanup = () => logosClient.close();
  } else {
    tools = [createLocalExecTool(), createLogosCompleteTool()];
    handleComplete = async (_, params) => {
      if (params.sleep) {
        return {
          type: "sleep" as const,
          taskId: "local",
          reply: params.reply,
          reason: params.sleep.reason,
          retry: params.sleep.retry,
        };
      }
      return {
        type: "finished" as const,
        taskId: "local",
        reply: params.reply,
      };
    };
  }

  const openai = new OpenAI({ apiKey, baseURL });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: taskDescription },
  ];

  let totalTurns = 0;
  let success = false;

  // Outer retry loop for sleep+retry
  for (let attempt = 0; attempt < 3; attempt++) {
    console.log(`[bench-runner] attempt ${attempt + 1}`);

    const loop = reactLoop({
      client: openai,
      model,
      messages: [...messages],
      tools,
      maxTurns,
      temperature: 0.2,
    });

    let completeParams: LogosCompleteParams | undefined;

    for await (const event of loop) {
      totalTurns++;
      switch (event.type) {
        case "tool_execution_start":
          console.log(`[tool] ${event.toolName}`);
          break;
        case "tool_execution_end":
          if (event.toolName !== "logos_complete") {
            const text = typeof event.result === "object" && event.result !== null
              ? (event.result as any)?.content?.[0]?.text ?? ""
              : String(event.result ?? "");
            const preview = text.length > 300 ? text.slice(0, 300) + "..." : text;
            console.log(`[result] ${preview}`);
          }
          break;
        case "logos_complete":
          completeParams = event.params;
          console.log(`[logos_complete] summary: ${event.params.summary}`);
          if (event.params.reply) console.log(`[reply] ${event.params.reply}`);
          break;
        case "max_turns_reached":
          console.log(`[bench-runner] max turns (${maxTurns}) reached`);
          break;
      }
    }

    if (completeParams) {
      const outcome = await handleComplete("bench", completeParams);

      if (outcome.type === "sleep") {
        if (outcome.retry) {
          console.log(`[bench-runner] sleep with retry, retrying...`);
          continue;
        }
        console.log(`[bench-runner] sleep without retry, stopping.`);
        break;
      }

      if (outcome.type === "finished") {
        success = true;
        break;
      }

      break;
    } else {
      // logos_complete never called — treat as failure, retry
      console.log(`[bench-runner] logos_complete not called, retrying...`);
      continue;
    }
  }

  cleanup();
  console.log(`[bench-runner] done. success=${success} turns=${totalTurns}`);
  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  console.error(`[bench-runner] fatal: ${err}`);
  process.exit(1);
});

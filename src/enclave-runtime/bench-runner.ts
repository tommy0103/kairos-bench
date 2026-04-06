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
import { reactLoop } from "./agent/core/reactLoop";
import type { LogosCompleteParams } from "./agent/core/types";
import {
  createKernelSession,
  createStandaloneSession,
} from "./agent/runtime/benchRuntime";

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

// ── System prompt ────────────────────────────────────────────

function buildSystemPrompt(kernelMode: boolean): string {
  const toolDocs = kernelMode
    ? `## Tools

You have four Logos kernel primitives:

1. **logos_exec(command)** — Execute a shell command in the sandbox.
   Output is truncated to the last ~200 lines. Full output is saved to a
   terminal log; the truncation notice includes the exact URI you can pass
   to logos_read to retrieve it.

2. **logos_read(uri)** — Read from any Logos URI.
   Examples: \`logos://sandbox/...\`, \`logos://system/tasks\`, \`logos://proc/\`

3. **logos_write(uri, content)** — Write to a Logos URI. Pure data, no side effects.

4. **logos_complete(...)** — MANDATORY final call. You MUST call this to finish.`
    : `## Tools

- **logos_exec(command)** — Execute a shell command. Output is truncated to the last ~200 lines.
- **logos_complete(...)** — MANDATORY: call this when the task is done or you need to stop.`;

  return `You are an autonomous terminal agent solving a benchmark task inside a sandbox.

## Task

${taskDescription}

${toolDocs}

## Rules

- Your default working directory is /app. Always \`cd /app\` before executing commands unless the task explicitly requires another directory.
- Always use the exact paths, filenames, formats, versions, ordering, and numeric thresholds required by the task.
- You MUST call logos_complete to end the task.
- Execute commands one at a time, observe output, then decide next steps.
- Treat the task description as a strict specification. A program merely running is not enough if any explicit requirement is unmet.
- Before calling logos_complete(success), verify that all required outputs exist at the exact required paths and satisfy the task's explicit constraints.
- If the task description, local files, or tests provide a sanity check, verifier, or example command, run it before finishing whenever feasible.
- If a provided test or sanity check fails, the task is not complete.
- Do not leave outputs in a nearby or convenient directory if the task specifies an exact path.
- If the task asks for extracted sources, preserved assets, or generated files, make sure they remain at the required location after your work is done.
- If your current result is partial, approximate, provisional, or unverified, do not claim success.
- If you encounter an unrecoverable error or cannot complete the task in this run, call logos_complete with sleep and clearly explain the blocker.
- Do NOT ask the user for input. Solve the task autonomously.
- Be efficient — minimize unnecessary commands, but never skip validation of hard requirements.${kernelMode ? "\n- When logos_exec output is truncated, use logos_read to retrieve the full terminal log if you need to inspect earlier output." : ""}`;
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[bench-runner] task: ${taskDescription}`);
  console.log(
    `[bench-runner] model: ${model} | kernel: ${useKernel ? logosSocket : "standalone"}`,
  );

  const session = useKernel
    ? await createKernelSession({
        socketPath: logosSocket,
        taskDescription,
        agentConfigId,
      })
    : createStandaloneSession();

  const openai = new OpenAI({ apiKey, baseURL });
  const systemPrompt = buildSystemPrompt(session.useKernel);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: taskDescription },
  ];

  let totalTurns = 0;
  let success = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    console.log(`[bench-runner] attempt ${attempt + 1}`);

    const loop = reactLoop({
      client: openai,
      model,
      messages: [...messages],
      tools: session.tools,
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
            const text =
              typeof event.result === "object" && event.result !== null
                ? ((event.result as any)?.content?.[0]?.text ?? "")
                : String(event.result ?? "");
            const preview =
              text.length > 300 ? text.slice(0, 300) + "..." : text;
            console.log(`[result] ${preview}`);
          }
          break;
        case "logos_complete":
          completeParams = event.params;
          console.log(`[logos_complete] summary: ${event.params.summary}`);
          if (event.params.reply)
            console.log(`[reply] ${event.params.reply}`);
          break;
        case "max_turns_reached":
          console.log(`[bench-runner] max turns (${maxTurns}) reached`);
          break;
      }
    }

    if (completeParams) {
      const outcome = await session.handleComplete(
        session.taskId,
        completeParams,
      );

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
      console.log(`[bench-runner] logos_complete not called, retrying...`);
      continue;
    }
  }

  session.cleanup();
  console.log(`[bench-runner] done. success=${success} turns=${totalTurns}`);
  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  console.error(`[bench-runner] fatal: ${err}`);
  process.exit(1);
});

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
 *   API_KEY              — LLM API key (required)
 *   API_PROVIDER         — "openai" | "anthropic" (auto-detected from MODEL)
 *   BASE_URL             — API endpoint (OpenAI default: https://api.deepseek.com/v1)
 *   MODEL                — Model name (default: deepseek-chat)
 *   LOGOS_SOCKET         — Path to logos-kernel Unix socket (optional; enables kernel mode)
 *   AGENT_CONFIG         — Agent config ID (default: bench-runner)
 *   MAX_TURNS            — Maximum ReAct loop turns (default: 500)
 *   ANTHROPIC_MAX_TOKENS — Max output tokens for Anthropic (default: 65536)
 *   CONTEXT_LIMIT        — Override auto-detected context window size
 *   EVAL_RETRIES         — Evaluator fix attempts after main agent (default: 2, 0 to disable)
 *   OPENAI_API_MODE      — "chat" | "responses" (auto-detected; codex models default to responses)
 *
 *   Cross-validation (optional — evaluator uses a different model):
 *   EVALUATOR_MODEL      — Model for the evaluator agent (default: same as MODEL)
 *   EVALUATOR_API_KEY    — API key for the evaluator model (default: same as API_KEY)
 *   EVALUATOR_API_PROVIDER — "openai"|"anthropic" for evaluator (auto-detected)
 *   EVALUATOR_BASE_URL   — API endpoint for evaluator model (default: same as BASE_URL)
 */

import OpenAI from "openai";
import { reactLoop } from "./agent/core/reactLoop";
import type { ChatClient } from "./agent/core/chatClient";
import {
  createOpenAIChatClient,
  createOpenAIResponsesChatClient,
  createAnthropicChatClient,
} from "./agent/core/chatClient";
import type { LogosCompleteParams } from "./agent/core/types";
import {
  createKernelSession,
  createStandaloneSession,
} from "./agent/runtime/benchRuntime";
import { executePlan } from "./agent/runtime/planExecutor";
import { executeExplore } from "./agent/runtime/exploreExecutor";
import { evaluateAndRetry } from "./agent/runtime/evaluator";
import { buildAgentSkillsSection } from "./agent/runtime/agentSkills";

// ── Config ───────────────────────────────────────────────────
const apiKey = process.env.API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const model = process.env.MODEL ?? "deepseek-chat";
const logosSocket = process.env.LOGOS_SOCKET ?? "";
const agentConfigId = process.env.AGENT_CONFIG ?? "bench-runner";
const maxTurns = parseInt(process.env.MAX_TURNS ?? "500", 10);
const evalRetries = parseInt(process.env.EVAL_RETRIES ?? "3", 10);

type Provider = "openai" | "anthropic";
function detectProvider(m: string): Provider {
  return m.toLowerCase().startsWith("claude") ? "anthropic" : "openai";
}
const provider: Provider =
  (process.env.API_PROVIDER as Provider) || detectProvider(model);

type ApiMode = "chat" | "responses";
function detectApiMode(m: string): ApiMode {
  const explicit = process.env.OPENAI_API_MODE?.toLowerCase() as
    | ApiMode
    | undefined;
  if (explicit === "chat" || explicit === "responses") return explicit;
  return m.toLowerCase().includes("codex") ? "responses" : "chat";
}
function modelSupportsTemperature(m: string): boolean {
  return !m.toLowerCase().includes("codex");
}

const explicitBaseURL = process.env.BASE_URL;
const defaultBaseURL =
  provider === "anthropic"
    ? undefined // Anthropic SDK uses its own default
    : "https://api.deepseek.com/v1";

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

/**
 * Some tasks involve long-running training or compilation that benefit from
 * a longer per-command timeout. Returns undefined to use the default (590s).
 */
function inferExecTimeout(task: string): number | undefined {
  const t = task.toLowerCase();
  if (
    t.includes("fasttext") ||
    t.includes("train a") ||
    t.includes("train model")
  )
    return 1_800_000; // 30 min — fasttext needs time for train-large-then-quantize
  return undefined;
}

function guessContextLimit(m: string): number {
  const s = m.toLowerCase();
  if (s.includes("deepseek")) return 64_000;
  if (s.includes("gpt-4o") || s.includes("gpt-4-turbo")) return 128_000;
  if (s.includes("gpt-5")) return 400_000;
  if (s.includes("claude")) {
    if (s.includes("1m")) return 1_000_000;
    return 200_000;
  }
  return 64_000;
}
const contextLimit =
  parseInt(process.env.CONTEXT_LIMIT ?? "0", 10) || guessContextLimit(model);

// ── Evaluator model (cross-validation) ──────────────────────
const evalModel = process.env.EVALUATOR_MODEL || undefined;
const evalApiKey = process.env.EVALUATOR_API_KEY || undefined;
const evalProviderRaw = process.env.EVALUATOR_API_PROVIDER as
  | Provider
  | undefined;
const evalBaseURL = process.env.EVALUATOR_BASE_URL || undefined;

function resolveEvalProvider(): Provider | undefined {
  if (!evalModel) return undefined;
  return evalProviderRaw || detectProvider(evalModel);
}
const evalProvider = resolveEvalProvider();

// ── System prompt ────────────────────────────────────────────

function buildSystemPrompt(kernelMode: boolean): string {
  const toolDocs = kernelMode
    ? `## Tools

You have Logos kernel primitives:

1. **logos_exec(command)** — Execute a shell command in the sandbox.
   Output is truncated to the last ~200 lines. Full output is saved to a
   terminal log; the truncation notice includes the exact URI you can pass
   to logos_read to retrieve it.

2. **logos_read(uri, offset?, limit?)** — Read from any Logos URI.
   Examples: \`logos://sandbox/...\`, \`logos://system/tasks\`, \`logos://proc/\`
   For large content, use \`offset\` (byte offset) and \`limit\` (max bytes) to paginate. Output is capped at ~400K chars.

3. **logos_write(uri, content)** — Write to a Logos URI (e.g. \`logos://sandbox/...\`). Pure data, no side effects.
   **WARNING**: logos_write writes to the Logos VFS, NOT to the container filesystem. Writing to an absolute path like \`/app/foo.py\` will silently land in the sandbox workspace, not at \`/app/foo.py\`. To create files at absolute container paths, use \`logos_exec\` with a shell heredoc: \`cat > /app/foo.py << 'EOF'\`.

4. **logos_call(tool, params)** — Invoke a proc tool by name.
   Discover available tools with \`logos_read("logos://proc/")\`. Built-in tools include:
   - \`web_search\`: search the web (DuckDuckGo + Wikipedia + StackOverflow). Params: \`{"query": "...", "max_results": 3}\`
   - \`fetch_url\`: fetch a URL and return its content as plain text (HTML stripped). Params: \`{"url": "https://..."}\`. Use this to read documentation, API references, or any web page found via web_search.
   - \`browse\`: browser control (navigate, click, type). Params: \`{"url": "...", "action": "snap"}\` (requires pinchtab)
   Note: \`memory.search\` and \`memory.range_fetch\` exist but are not useful for this task (they search chat history, not task data).

5. **logos_complete(...)** — MANDATORY final call. You MUST call this to finish.
   - Normal: call with \`summary\` describing what you did.
   - Plan mode: for complex multi-step tasks, call with \`plan: ["step 1", "step 2", ...]\`.
     Each step will be executed by a fresh agent, and the plan is reviewed after every step.
   - **Explore mode**: when a problem can be solved in multiple independent ways and you are unsure which will work,
     call with \`explore: ["approach A description", "approach B description", ...]\` (max 3).
     Each approach will be executed by a **separate agent in an isolated copy of /app**, running in parallel.
     The first approach to succeed wins — its workspace replaces /app. Use explore when:
       • You have tried one strategy that failed and want to try alternatives from a clean state.
       • The problem has fundamentally different solution paths (e.g. reverse-engineer vs brute-force).
       • You want to hedge between a complex correct approach and a simple heuristic.
     Do NOT use explore for sequential steps — use plan for that.
   - Blocked: call with \`sleep: { reason, retry }\` to pause.
   - \`task_log\`: detailed execution record (what you did, key outputs, errors). Required when using \`plan\` or \`explore\`.
     Previous steps' logs are at \`logos://sandbox/plan-step-N.log\` (read with logos_read).`
    : `## Tools`;

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
- **Clean up build artifacts**: if the task asks you to create a specific file in a directory, make sure that directory contains ONLY the required file(s). Remove any compiled binaries, object files, temporary scripts, or other artifacts you created during testing. The verifier may check that the output directory contains exactly the specified files.
- If your current result is partial, approximate, provisional, or unverified, do not claim success.
- If you encounter an unrecoverable error or cannot complete the task in this run, call logos_complete with sleep and clearly explain the blocker.
- Do NOT ask the user for input. Solve the task autonomously.
- Be efficient — minimize unnecessary commands, but never skip validation of hard requirements.${
    kernelMode
      ? "\n- When logos_exec output is truncated, use logos_read to retrieve the full terminal log if you need to inspect earlier output."
      : ""
  }
- **Research before coding**: if the task mentions unfamiliar concepts, libraries, file formats, protocols, or domain-specific terms, use \`logos_call("web_search", {"query": "..."})\` to look them up BEFORE writing code. Do not guess or make assumptions about things you are unsure of — incorrect assumptions waste time and lead to wrong solutions.
- **Container environment**: You are running inside a Docker container with no init system. When starting services (nginx, postgres, redis, apache, etc.), NEVER run them in the foreground — logos_exec will block forever. Always start services in background mode, e.g. \`nginx -g "daemon on;"\`, \`postgres &\`, \`redis-server --daemonize yes\`, or append \`&\` to the command. Verify the service started with a follow-up check (e.g. \`curl -s localhost\` or \`pgrep nginx\`).
- **Context continuity**: before starting work, check \`logos_read("logos://sandbox/plan-initial.log")\`. If it returns empty, fall back to \`logos_exec("cat /tmp/logos-sandbox/plan-initial.log")\`. If a log exists, a previous agent already made partial progress — review it so you do not duplicate work.
- **Context pressure**: if the system warns that your context window is nearly full, immediately enter plan mode by calling logos_complete with \`task_log\` (detailed record of everything done so far) and \`plan\` (remaining steps). Do not ignore context pressure warnings.
- **Never give up directly**: if you feel stuck or believe the task is too complex to complete in one pass, do NOT call logos_complete with just a summary to end the task. Instead, use plan mode — decompose the remaining work into smaller subtasks via \`plan: [...]\` so that fresh agents can tackle each piece independently. Only use \`sleep\` if there is a genuine external blocker (e.g. missing credentials, unavailable service).${buildAgentSkillsSection(
    taskDescription
  )}`;
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[bench-runner] task: ${taskDescription}`);
  console.log(
    `[bench-runner] model: ${model} | provider: ${provider} | kernel: ${
      useKernel ? logosSocket : "standalone"
    }`
  );

  const execTimeoutMs = inferExecTimeout(taskDescription);
  if (execTimeoutMs !== undefined) {
    console.log(
      `[bench-runner] custom logos_exec timeout: ${execTimeoutMs / 1000}s`
    );
  }

  const session = useKernel
    ? await createKernelSession({
        socketPath: logosSocket,
        taskDescription,
        agentConfigId,
        execTimeoutMs,
      })
    : createStandaloneSession();

  let chatClient: ChatClient;
  if (provider === "anthropic") {
    chatClient = await createAnthropicChatClient({
      apiKey,
      baseURL: explicitBaseURL,
      maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? "65536", 10),
    });
  } else {
    const openai = new OpenAI({
      apiKey,
      baseURL: explicitBaseURL ?? defaultBaseURL,
    });
    const mode = detectApiMode(model);
    chatClient =
      mode === "responses"
        ? createOpenAIResponsesChatClient(openai, {
            supportsTemperature: modelSupportsTemperature(model),
          })
        : createOpenAIChatClient(openai);
    if (mode === "responses") {
      console.log(`[bench-runner] using Responses API for model=${model}`);
    }
  }

  // Build evaluator client if cross-validation is configured
  let evalChatClient: ChatClient | undefined;
  if (evalModel) {
    const eKey = evalApiKey ?? apiKey;
    const eProv = evalProvider ?? provider;
    const eBase =
      evalBaseURL ?? (eProv === provider ? explicitBaseURL : undefined);
    const eDefaultBase =
      eProv === "anthropic" ? undefined : "https://api.deepseek.com/v1";

    if (eProv === "anthropic") {
      evalChatClient = await createAnthropicChatClient({
        apiKey: eKey,
        baseURL: eBase,
        maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? "65536", 10),
      });
    } else {
      const eOpenai = new OpenAI({
        apiKey: eKey,
        baseURL: eBase ?? eDefaultBase,
      });
      const eMode = detectApiMode(evalModel);
      evalChatClient =
        eMode === "responses"
          ? createOpenAIResponsesChatClient(eOpenai, {
              supportsTemperature: modelSupportsTemperature(evalModel),
            })
          : createOpenAIChatClient(eOpenai);
    }
    console.log(
      `[bench-runner] cross-validation: generator=${model} (${provider}), evaluator=${evalModel} (${eProv})`
    );
  }

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
      client: chatClient,
      model,
      messages: [...messages],
      tools: session.tools,
      maxTurns,
      temperature: 0.2,
      contextLimit,
    });

    let completeParams: LogosCompleteParams | undefined;

    for await (const event of loop) {
      totalTurns++;
      switch (event.type) {
        case "tool_execution_start": {
          const raw = JSON.stringify(event.params);
          const args = raw.length > 200 ? raw.slice(0, 200) + `… (${raw.length} bytes total)` : raw;
          console.log(`[tool] ${event.toolName}(${args})`);
          break;
        }
        case "tool_execution_end":
          if (event.toolName !== "logos_complete") {
            const text =
              typeof event.result === "object" && event.result !== null
                ? (event.result as any)?.content?.[0]?.text ?? ""
                : String(event.result ?? "");
            const preview =
              text.length > 300 ? text.slice(0, 300) + "..." : text;
            console.log(`[result] ${preview}`);
          }
          break;
        case "logos_complete":
          completeParams = event.params;
          console.log(`[logos_complete] summary: ${event.params.summary}`);
          if (event.params.reply) console.log(`[reply] ${event.params.reply}`);
          break;
        case "context_pressure":
          console.log(
            `[bench-runner] context pressure: ~${event.estimatedTokens}/${
              event.limit
            } tokens (${Math.round(
              (event.estimatedTokens / event.limit) * 100
            )}%)`
          );
          break;
        case "max_turns_reached":
          console.log(`[bench-runner] max turns (${maxTurns}) reached`);
          break;
      }
    }

    if (completeParams) {
      const outcome = await session.handleComplete(
        session.taskId,
        completeParams
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

      if (outcome.type === "plan") {
        console.log(
          `[bench-runner] entering plan mode ` +
            `(${outcome.subtasks.length} subtasks)`
        );

        if (completeParams.task_log) {
          await persistLog(
            session.tools,
            "logos://sandbox/plan-initial.log",
            completeParams.task_log,
            "initial task_log",
            true // append
          );
        }

        success = await executePlan({
          tools: session.tools,
          client: chatClient,
          model,
          originalTask: taskDescription,
          subtasks: outcome.subtasks,
          maxTurnsPerAgent: maxTurns,
          temperature: 0.2,
          kernelMode: session.useKernel,
          contextLimit,
          execTimeoutSec: execTimeoutMs ? execTimeoutMs / 1000 : undefined,
        });
        break;
      }

      if (outcome.type === "explore") {
        console.log(
          `[bench-runner] entering explore mode ` +
            `(${outcome.approaches.length} approaches)`
        );

        if (completeParams.task_log) {
          await persistLog(
            session.tools,
            "logos://sandbox/plan-initial.log",
            completeParams.task_log,
            "initial task_log (explore)",
            true // append
          );
        }

        success = await executeExplore({
          tools: session.tools,
          client: chatClient,
          model,
          originalTask: taskDescription,
          approaches: outcome.approaches,
          taskLog: completeParams.task_log,
          maxTurnsPerApproach: maxTurns,
          temperature: 0.2,
          kernelMode: session.useKernel,
          contextLimit,
          execTimeoutSec: execTimeoutMs ? execTimeoutMs / 1000 : undefined,
        });
        break;
      }

      break;
    } else {
      console.log(`[bench-runner] logos_complete not called, retrying...`);
      continue;
    }
  }

  if (success && evalRetries > 0) {
    console.log(
      `[bench-runner] running evaluator (up to ${evalRetries} fix attempts)`
    );
    success = await evaluateAndRetry({
      client: chatClient,
      model,
      tools: session.tools,
      originalTask: taskDescription,
      maxRetries: evalRetries,
      maxTurnsPerAgent: maxTurns,
      temperature: 0.2,
      contextLimit,
      kernelMode: session.useKernel,
      evalClient: evalChatClient,
      evalModel,
      evalContextLimit: evalModel ? guessContextLimit(evalModel) : undefined,
    });
  }

  session.cleanup();
  console.log(`[bench-runner] done. success=${success} turns=${totalTurns}`);
  process.exit(success ? 0 : 1);
}

function logosUriToFsPath(uri: string): string {
  return uri.replace(/^logos:\/\/sandbox\//, "/tmp/logos-sandbox/");
}

async function persistLog(
  tools: import("./agent/core/types").AgentTool[],
  uri: string,
  content: string,
  label: string,
  append = false
): Promise<void> {
  const timestamp = new Date().toISOString();
  const block = `\n--- ${label} [${timestamp}] ---\n${content}\n`;
  const payload = append ? block : content;

  if (append) {
    // For append mode, read existing content first, then write combined
    const readTool = tools.find((t) => t.name === "logos_read");
    const writeTool = tools.find((t) => t.name === "logos_write");
    if (readTool && writeTool) {
      try {
        let existing = "";
        try {
          const res = await readTool.execute("persist-log-read", { uri });
          existing =
            typeof res === "object" && res !== null
              ? (res as any)?.content?.[0]?.text ?? ""
              : String(res ?? "");
        } catch {
          // file doesn't exist yet — that's fine
        }
        await writeTool.execute("persist-log", {
          uri,
          content: existing + block,
        });
        console.log(`[bench-runner] appended ${label} → ${uri}`);
        return;
      } catch {
        // fall through to exec append
      }
    }
    const execTool = tools.find((t) => t.name === "logos_exec");
    if (execTool) {
      try {
        const fsPath = logosUriToFsPath(uri);
        const escaped = block.replace(/'/g, "'\\''");
        await execTool.execute("persist-log", {
          command: `mkdir -p "$(dirname '${fsPath}')" && cat >> '${fsPath}' << 'LOGOS_EOF'\n${escaped}\nLOGOS_EOF`,
        });
        console.log(
          `[bench-runner] appended ${label} → ${fsPath} (via exec fallback)`
        );
      } catch (e) {
        console.warn(`[bench-runner] failed to append ${label}:`, e);
      }
    }
    return;
  }

  // Overwrite mode (original behavior)
  const writeTool = tools.find((t) => t.name === "logos_write");
  if (writeTool) {
    try {
      await writeTool.execute("persist-log", { uri, content: payload });
      console.log(`[bench-runner] persisted ${label} → ${uri}`);
      return;
    } catch {
      // logos_write denied — fall through to exec
    }
  }
  const execTool = tools.find((t) => t.name === "logos_exec");
  if (execTool) {
    try {
      const fsPath = logosUriToFsPath(uri);
      const escaped = payload.replace(/'/g, "'\\''");
      await execTool.execute("persist-log", {
        command: `mkdir -p "$(dirname '${fsPath}')" && cat > '${fsPath}' << 'LOGOS_EOF'\n${escaped}\nLOGOS_EOF`,
      });
      console.log(
        `[bench-runner] persisted ${label} → ${fsPath} (via exec fallback)`
      );
    } catch (e) {
      console.warn(`[bench-runner] failed to persist ${label}:`, e);
    }
  }
}

main().catch((err) => {
  console.error(`[bench-runner] fatal: ${err}`);
  process.exit(1);
});

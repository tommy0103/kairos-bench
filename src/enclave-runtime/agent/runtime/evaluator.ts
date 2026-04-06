/**
 * Evaluator + fixer feedback loop.
 *
 * After the main agent (or plan mode) finishes, the evaluator runs tests
 * from /tests (if present) and checks whether the task was truly completed.
 * On failure, a fixer agent receives the test output as feedback, fixes
 * the issues, and the evaluator re-runs. This repeats up to maxRetries.
 */
import type OpenAI from "openai";
import type { ChatClient } from "../core/chatClient";
import { reactLoop } from "../core/reactLoop";
import type { AgentTool, LogosCompleteParams } from "../core/types";
import { executePlan } from "./planExecutor";

// ── Public types ──────────────────────────────────────────────

export interface EvalLoopOptions {
  client: ChatClient;
  model: string;
  tools: AgentTool[];
  originalTask: string;
  maxRetries: number;
  maxTurnsPerAgent: number;
  temperature?: number;
  contextLimit?: number;
  kernelMode: boolean;
}

// ── Main entry point ──────────────────────────────────────────

/**
 * Run evaluate → fix loop. Returns true if evaluation passes (or no
 * tests exist). Returns false if all retry attempts are exhausted.
 */
export async function evaluateAndRetry(
  opts: EvalLoopOptions,
): Promise<boolean> {
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    console.log(`[evaluator] round ${attempt + 1}/${opts.maxRetries + 1}`);

    const evalResult = await runEvaluator(opts);

    if (evalResult.passed) {
      console.log(`[evaluator] PASSED: ${evalResult.summary}`);
      return true;
    }

    console.log(`[evaluator] FAILED: ${evalResult.summary}`);

    if (attempt >= opts.maxRetries) {
      console.log(`[evaluator] retries exhausted`);
      return false;
    }

    console.log(
      `[evaluator] running fixer (attempt ${attempt + 1}/${opts.maxRetries})`,
    );
    await runFixer({
      ...opts,
      feedback: evalResult.summary,
      detailedLog: evalResult.taskLog,
    });
  }

  return false;
}

// ── Evaluator agent ───────────────────────────────────────────

interface EvalResult {
  passed: boolean;
  summary: string;
  taskLog?: string;
}

async function runEvaluator(opts: EvalLoopOptions): Promise<EvalResult> {
  const prompt = buildEvaluatorPrompt(opts.originalTask, opts.kernelMode);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: prompt },
    {
      role: "user",
      content:
        "Run the /tests/test_output.py and evaluate whether the task has been completed correctly.",
    },
  ];

  const loop = reactLoop({
    client: opts.client,
    model: opts.model,
    messages,
    tools: opts.tools,
    maxTurns: Math.min(opts.maxTurnsPerAgent, 20),
    temperature: opts.temperature ?? 0.2,
    contextLimit: opts.contextLimit,
  });

  let completeParams: LogosCompleteParams | undefined;

  for await (const event of loop) {
    switch (event.type) {
      case "tool_execution_start": {
        const raw = JSON.stringify(event.params);
        const args = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
        console.log(`  [eval] ${event.toolName}(${args})`);
        break;
      }
      case "tool_execution_end":
        if (event.toolName !== "logos_complete") {
          const text =
            typeof event.result === "object" && event.result !== null
              ? ((event.result as any)?.content?.[0]?.text ?? "")
              : String(event.result ?? "");
          const preview =
            text.length > 300 ? text.slice(0, 300) + "..." : text;
          console.log(`  [eval-result] ${preview}`);
        }
        break;
      case "logos_complete":
        completeParams = event.params;
        console.log(`  [eval-complete] ${event.params.summary}`);
        break;
    }
  }

  if (!completeParams) {
    return { passed: false, summary: "Evaluator did not call logos_complete" };
  }

  const summary = completeParams.summary ?? "";
  const passed = summary.toUpperCase().startsWith("PASS");

  return { passed, summary, taskLog: completeParams.task_log };
}

// ── Fixer agent ───────────────────────────────────────────────

async function runFixer(
  opts: EvalLoopOptions & { feedback: string; detailedLog?: string },
): Promise<void> {
  const logSnippet = opts.detailedLog
    ? opts.detailedLog.length > 6000
      ? opts.detailedLog.slice(-6000)
      : opts.detailedLog
    : undefined;

  const prompt = buildFixerPrompt(
    opts.originalTask,
    opts.feedback,
    logSnippet,
    opts.kernelMode,
  );

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: prompt },
    { role: "user", content: "Fix the issues identified by the evaluator." },
  ];

  const loop = reactLoop({
    client: opts.client,
    model: opts.model,
    messages,
    tools: opts.tools,
    maxTurns: opts.maxTurnsPerAgent,
    temperature: opts.temperature ?? 0.2,
    contextLimit: opts.contextLimit,
  });

  let completeParams: LogosCompleteParams | undefined;

  for await (const event of loop) {
    switch (event.type) {
      case "tool_execution_start": {
        const raw = JSON.stringify(event.params);
        const args = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
        console.log(`  [fix] ${event.toolName}(${args})`);
        break;
      }
      case "tool_execution_end":
        if (event.toolName !== "logos_complete") {
          const text =
            typeof event.result === "object" && event.result !== null
              ? ((event.result as any)?.content?.[0]?.text ?? "")
              : String(event.result ?? "");
          const preview =
            text.length > 300 ? text.slice(0, 300) + "..." : text;
          console.log(`  [fix-result] ${preview}`);
        }
        break;
      case "logos_complete":
        completeParams = event.params;
        console.log(`  [fix-complete] ${event.params.summary}`);
        break;
      case "context_pressure":
        console.log(
          `  [fix-ctx] ~${event.estimatedTokens}/${event.limit} tokens`,
        );
        break;
    }
  }

  if (completeParams?.plan?.length) {
    console.log(
      `[evaluator] fixer decomposed into ${completeParams.plan.length} subtasks`,
    );
    await executePlan({
      tools: opts.tools,
      client: opts.client,
      model: opts.model,
      originalTask: opts.originalTask,
      subtasks: completeParams.plan,
      maxTurnsPerAgent: opts.maxTurnsPerAgent,
      temperature: opts.temperature ?? 0.2,
      kernelMode: opts.kernelMode,
      contextLimit: opts.contextLimit,
    });
  }
}

// ── Prompts ───────────────────────────────────────────────────

function toolDocsBlock(kernelMode: boolean): string {
  if (kernelMode) {
    return `## Tools

You have Logos kernel primitives:

1. **logos_exec(command)** — Execute a shell command. Output truncated to ~200 lines;
   full output saved to terminal log (read via logos_read when truncated).
2. **logos_read(uri)** — Read from any Logos URI.
3. **logos_write(uri, content)** — Write to a Logos URI.
4. **logos_complete(...)** — MANDATORY final call.`;
  }
  return `## Tools

- **logos_exec(command)** — Execute a shell command. Output truncated to ~200 lines.
- **logos_complete(...)** — MANDATORY: call this when done.`;
}

function buildEvaluatorPrompt(
  originalTask: string,
  kernelMode: boolean,
): string {
  return `You are an evaluator agent. Your job is to verify that a task has been completed correctly by running any available tests.

## Original task

${originalTask}

${toolDocsBlock(kernelMode)}

## Instructions

1. Check if \`/tests\` directory exists and list its contents.
2. If tests exist, determine the test framework (pytest, jest, cargo test, go test, etc.) and install any required test dependencies.
3. Run ALL available tests.
4. Analyze the test output carefully — pay attention to individual test case results.
5. Call logos_complete with:
   - \`summary\`: Start with **"PASS:"** if ALL tests pass, or **"FAIL:"** followed by a concise description of what failed and why.
   - \`task_log\`: The full test command, complete test output, and your analysis.

## Rules

- Do NOT modify any source code or solution files. You are only allowed to run tests and inspect files.
- If no tests are found at all, call logos_complete with \`summary: "PASS: no test suite found"\`.
- Be thorough: run ALL available tests, not just a subset.
- Your default working directory is /app.
- You MUST call logos_complete exactly once.`;
}

function buildFixerPrompt(
  originalTask: string,
  feedback: string,
  detailedLog: string | undefined,
  kernelMode: boolean,
): string {
  return `You are a fixer agent. A previous agent attempted a task, but the evaluator found test failures.

## Original task

${originalTask}

## Evaluator feedback

${feedback}
${detailedLog ? `\n## Detailed test output\n\n\`\`\`\n${detailedLog}\n\`\`\`` : ""}

${toolDocsBlock(kernelMode)}

## Rules

- Focus on fixing the specific test failures described above. Do not redo work that is already correct.
- Read the relevant source files to understand what went wrong, then make targeted fixes.
- After fixing, re-run the failing tests yourself to verify your fix before calling logos_complete.
- When done, call logos_complete with:
  - \`summary\`: what you fixed and whether re-run tests pass now.
  - \`task_log\`: detailed record of changes and verification results.
- If the fix requires multiple steps, use \`plan: [...]\` to decompose it.
- Your default working directory is /app.
- You MUST call logos_complete exactly once.
- **Context pressure**: if warned, enter plan mode immediately.`;
}

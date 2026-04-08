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
import { detectSkills } from "./evaluatorSkills";
import { buildAgentSkillsSection } from "./agentSkills";
import { executePlan } from "./planExecutor";
import { executeExplore } from "./exploreExecutor";

const DEFAULT_EVAL_EXEC_TIMEOUT_MS = 120_000; // 2 min per command

/**
 * Wrap logos_exec with a shorter per-command timeout so hung tests fail
 * fast instead of consuming the entire trial budget.
 */
function wrapToolsWithExecTimeout(
  tools: AgentTool[],
  timeoutMs: number,
): AgentTool[] {
  return tools.map((tool) => {
    if (tool.name !== "logos_exec") return tool;
    return {
      ...tool,
      description:
        tool.description.replace(/\d+s/g, `${Math.round(timeoutMs / 1000)}s`) +
        ` (evaluator: ${Math.round(timeoutMs / 1000)}s limit)`,
      execute: async (callId, params, signal) => {
        const timer = setTimeout(() => signal?.dispatchEvent?.(new Event("abort")), timeoutMs);
        try {
          return await Promise.race([
            tool.execute(callId, params, signal),
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `logos_exec timed out after ${Math.round(timeoutMs / 1000)}s (evaluator limit)`,
                    ),
                  ),
                timeoutMs,
              ),
            ),
          ]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("timed out")) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `exit_code: -1 (TIMEOUT after ${Math.round(timeoutMs / 1000)}s — evaluator limit)\n\n` +
                    "The test command did not complete in time. " +
                    "This likely means the program under test is hanging or not responding. " +
                    "Mark this as FAIL with a clear explanation.",
                },
              ],
            };
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  });
}

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
  /** Separate model for the evaluator (cross-validation). Falls back to `model`. */
  evalClient?: ChatClient;
  evalModel?: string;
  evalContextLimit?: number;
  /** Per-command timeout for evaluator's logos_exec (default: 120s). */
  evalExecTimeoutMs?: number;
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
  const evalClient = opts.evalClient ?? opts.client;
  const evalModel = opts.evalModel ?? opts.model;
  const evalTools = wrapToolsWithExecTimeout(
    opts.tools,
    opts.evalExecTimeoutMs ?? DEFAULT_EVAL_EXEC_TIMEOUT_MS,
  );

  const prompt = buildEvaluatorPrompt(opts.originalTask, opts.kernelMode);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: prompt },
    {
      role: "user",
      content:
        "Run the tests and evaluate whether the task has been completed correctly.",
    },
  ];

  const loop = reactLoop({
    client: evalClient,
    model: evalModel,
    messages,
    tools: evalTools,
    maxTurns: Math.min(opts.maxTurnsPerAgent, 100),
    temperature: opts.temperature ?? 0.2,
    contextLimit: opts.evalContextLimit ?? opts.contextLimit,
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

  if (completeParams?.explore?.length) {
    console.log(
      `[evaluator] fixer entering explore mode ` +
        `(${completeParams.explore.length} approaches)`,
    );
    await executeExplore({
      tools: opts.tools,
      client: opts.client,
      model: opts.model,
      originalTask: opts.originalTask,
      approaches: completeParams.explore,
      taskLog: completeParams.task_log,
      maxTurnsPerApproach: opts.maxTurnsPerAgent,
      temperature: opts.temperature ?? 0.2,
      kernelMode: opts.kernelMode,
      contextLimit: opts.contextLimit,
    });
  } else if (completeParams?.plan?.length) {
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
  const skills = detectSkills(originalTask);
  const skillsBlock =
    skills.length > 0
      ? `\n## Testing skills (MANDATORY)\n\nThe following skills matched this task. You MUST execute every skill recipe below. Copy each test template, adapt the marked constants to match the actual solution, and run it. If ANY skill test fails, report FAIL.\n\n**CRITICAL — skill restrictions override general guidelines**: When a skill explicitly says "DO NOT test X", "DO NOT fail on Y", or "DO NOT write Z tests", those restrictions are ABSOLUTE. Your additional adversarial tests MUST NOT contradict or circumvent skill-level DO NOT instructions. Skill authors have domain knowledge about the real verifier's behavior — if a skill says a certain type of test produces false negatives, trust it.\n\n${skills.map((s) => s.recipe).join("\n\n---\n\n")}\n`
      : "";

  return `You are an adversarial evaluator agent. Your job is to rigorously verify that a task has been completed correctly by designing and running your own tests.

## Original task

${originalTask}

${toolDocsBlock(kernelMode)}

## Instructions

1. Read the task description carefully. Extract every explicit requirement, constraint, edge case, and acceptance criterion.
2. Inspect the agent's output: check that files exist at the required paths, code compiles/runs, outputs match expected formats, etc.
3. **If any testing skills are provided below**, follow each skill's recipe EXACTLY — copy the test template, adapt file paths / function names to match the actual solution, and run it. Do NOT skip or simplify skill tests. Run skill tests FIRST, before your own tests.
4. **Design additional adversarial test cases** that cover:
   - All explicit requirements from the task description.
   - Edge cases and boundary conditions (empty inputs, large inputs, error paths, concurrency, signals, etc.).
   - Common mistakes an agent might make (wrong path, wrong format, off-by-one, missing error handling).
5. Run your tests. Be specific and deterministic — use concrete assertions, not vague checks.
6. Call logos_complete with:
   - \`summary\`: Start with **"PASS:"** if ALL your tests pass (including skill tests), or **"FAIL:"** followed by a concise description of what failed and why.
   - \`task_log\`: Your test code, full test output, and analysis.
${skillsBlock}
## Adversarial testing guidelines

**Respect skill restrictions**: If a testing skill above says "DO NOT write byte-for-byte comparison tests" or "DO NOT fail on formatting differences", you MUST NOT design additional tests that do exactly that. Skill-level "DO NOT" instructions take precedence over general adversarial instincts. Violating them causes false negatives that derail the fixer.

**Combinatorial parameter coverage**: When the task involves parameters (e.g. \`max_concurrent\`, \`timeout\`, \`limit\`), always test multiple combinations — especially where parameters interact to create different code paths.

**External process testing**: When behavior involves signals (SIGINT, SIGTERM), cancellation, or timeouts, always test from an **external process** using \`subprocess.Popen\` + \`proc.send_signal()\`.

## Rules

- Do NOT modify the agent's source code or solution files. You may only create temporary test scripts and run commands.
- Think like a strict code reviewer: find bugs, not excuses.
- If the task asks for a function/module, import it and test it directly — don't just check that the file exists.
- If the task involves runtime behavior (signals, concurrency, network), test the actual behavior, not just static properties.
- Clean up any temporary test files you create when done.
- Your default working directory is /app.
- **Container environment**: You are inside a Docker container with no init system. Never start services in foreground (logos_exec will block forever). Use background mode: \`nginx -g "daemon on;"\`, \`cmd &\`, etc.
- You MUST call logos_complete exactly once.`;
}

function buildFixerPrompt(
  originalTask: string,
  feedback: string,
  detailedLog: string | undefined,
  kernelMode: boolean,
): string {
  const agentSkills = buildAgentSkillsSection(originalTask);

  return `You are a fixer agent. A previous agent attempted a task, but an adversarial evaluator found issues.

## Original task

${originalTask}

## Evaluator feedback

${feedback}
${detailedLog ? `\n## Detailed test output\n\n\`\`\`\n${detailedLog}\n\`\`\`` : ""}

${toolDocsBlock(kernelMode)}
${agentSkills ? `\n${agentSkills}\n\n**IMPORTANT**: The guidance above reflects domain expertise about the real verifier's behavior. If the evaluator feedback contradicts it (e.g., tells you to "preserve formatting exactly" but the skill says to use a specific library), follow the skill guidance — the evaluator may have produced a false negative.\n` : ""}
## Rules

- Focus on fixing the specific test failures described above. Do not redo work that is already correct.
- Read the relevant source files to understand what went wrong, then make targeted fixes.
- After fixing, re-run the failing tests yourself to verify your fix before calling logos_complete.
- When done, call logos_complete with:
  - \`summary\`: what you fixed and whether re-run tests pass now.
  - \`task_log\`: detailed record of changes and verification results.
- If the fix requires multiple steps, use \`plan: [...]\` to decompose it.
- If you see multiple possible fix strategies and are unsure which will work, use \`explore: ["fix A", "fix B"]\` to try them in parallel (each runs in an isolated workspace copy).
- Your default working directory is /app.
- **Container environment**: You are inside a Docker container with no init system. Never start services in foreground (logos_exec will block forever). Use background mode: \`nginx -g "daemon on;"\`, \`cmd &\`, etc.
- You MUST call logos_complete exactly once.
- **Context pressure**: if warned, enter plan mode immediately.`;
}

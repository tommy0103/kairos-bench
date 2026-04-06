/**
 * Plan mode executor — RFC §9.2.
 *
 * When an agent calls logos_complete({ plan: [...] }), the runtime enters
 * plan mode: subtasks are executed serially by fresh executor instances,
 * and after each step a planner instance reviews progress and may replan.
 *
 * Key properties (from RFC):
 *   - One agent instance at a time — planner and executor never coexist.
 *   - Subtasks are information compressors — each executor returns a
 *     summary, not raw output.
 *   - Replanning is natural — the planner simply emits an updated plan.
 *   - Nested planning is supported (executor can emit plan too).
 */
import OpenAI from "openai";
import { reactLoop } from "../core/reactLoop";
import type { AgentTool, LogosCompleteParams } from "../core/types";

const MAX_PLAN_DEPTH = 3;
const MAX_REPLAN_CYCLES = 10;

// ── Public types ─────────────────────────────────────────────

interface CompletedSubtask {
  description: string;
  summary: string;
}

export interface PlanExecutorOptions {
  tools: AgentTool[];
  openai: OpenAI;
  model: string;
  originalTask: string;
  subtasks: string[];
  maxTurnsPerAgent: number;
  temperature?: number;
  kernelMode: boolean;
  depth?: number;
}

// ── Main entry point ─────────────────────────────────────────

export async function executePlan(
  opts: PlanExecutorOptions,
): Promise<boolean> {
  const {
    tools,
    openai,
    model,
    originalTask,
    maxTurnsPerAgent,
    temperature = 0.2,
    kernelMode,
    depth = 0,
  } = opts;

  if (depth >= MAX_PLAN_DEPTH) {
    console.log(
      `[plan d=${depth}] max nesting depth reached; ` +
        `executing remaining subtasks without further decomposition`,
    );
  }

  let remaining = [...opts.subtasks];
  const completed: CompletedSubtask[] = [];

  for (
    let cycle = 0;
    remaining.length > 0 && cycle < MAX_REPLAN_CYCLES;
    cycle++
  ) {
    const subtask = remaining[0];
    const step = completed.length + 1;
    console.log(`[plan d=${depth}] step ${step}: "${subtask}"`);

    // ── Run executor ────────────────────────────────────────
    const execResult = await runSubAgent({
      openai,
      model,
      tools,
      systemPrompt: buildExecutorPrompt(originalTask, subtask, kernelMode),
      userMessage: subtask,
      maxTurns: maxTurnsPerAgent,
      temperature,
    });

    if (!execResult.params) {
      console.log(`[plan d=${depth}] executor did not call logos_complete`);
      if (cycle < MAX_REPLAN_CYCLES - 1) {
        console.log(`[plan d=${depth}] retrying subtask...`);
        continue;
      }
      return false;
    }

    const params = execResult.params;

    if (params.plan && params.plan.length > 0 && depth < MAX_PLAN_DEPTH) {
      console.log(
        `[plan d=${depth}] executor decomposed into ` +
          `${params.plan.length} sub-subtasks`,
      );
      const nestedOk = await executePlan({
        ...opts,
        subtasks: params.plan,
        depth: depth + 1,
      });
      if (!nestedOk) return false;
      completed.push({ description: subtask, summary: params.summary });
      remaining = remaining.slice(1);
    } else if (params.sleep) {
      console.log(
        `[plan d=${depth}] executor sleep: ${params.sleep.reason}`,
      );
      if (params.sleep.retry && cycle < MAX_REPLAN_CYCLES - 1) {
        console.log(`[plan d=${depth}] retrying subtask...`);
        continue;
      }
      return false;
    } else {
      completed.push({ description: subtask, summary: params.summary });
      remaining = remaining.slice(1);
      console.log(`[plan d=${depth}] step ${step} done: ${params.summary}`);
    }

    if (remaining.length === 0) break;

    // ── Run planner to review ───────────────────────────────
    console.log(
      `[plan d=${depth}] replanning ` +
        `(${completed.length} done, ${remaining.length} remaining)`,
    );
    const planResult = await runSubAgent({
      openai,
      model,
      tools,
      systemPrompt: buildPlannerPrompt(
        originalTask,
        completed,
        remaining,
        kernelMode,
      ),
      userMessage: "Review progress and decide how to proceed.",
      maxTurns: Math.min(maxTurnsPerAgent, 10),
      temperature,
    });

    if (!planResult.params) {
      console.log(
        `[plan d=${depth}] planner did not call logos_complete; ` +
          `continuing current plan`,
      );
      continue;
    }

    if (planResult.params.plan && planResult.params.plan.length > 0) {
      remaining = planResult.params.plan;
      console.log(
        `[plan d=${depth}] planner updated plan ` +
          `(${remaining.length} subtasks): ` +
          remaining.map((s) => `"${s}"`).join(", "),
      );
    } else {
      console.log(
        `[plan d=${depth}] planner says complete: ` +
          planResult.params.summary,
      );
      break;
    }
  }

  console.log(
    `[plan d=${depth}] finished: ${completed.length} subtask(s) completed`,
  );
  return completed.length > 0;
}

// ── Sub-agent runner ─────────────────────────────────────────
//
// Runs a fresh reactLoop with its own message history. The
// logos_complete params are captured locally — NOT routed to
// the kernel (subtask completion is a runtime-internal event).

interface SubAgentResult {
  params?: LogosCompleteParams;
  turns: number;
}

async function runSubAgent(opts: {
  openai: OpenAI;
  model: string;
  tools: AgentTool[];
  systemPrompt: string;
  userMessage: string;
  maxTurns: number;
  temperature: number;
}): Promise<SubAgentResult> {
  const {
    openai,
    model,
    tools,
    systemPrompt,
    userMessage,
    maxTurns,
    temperature,
  } = opts;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const loop = reactLoop({
    client: openai,
    model,
    messages,
    tools,
    maxTurns,
    temperature,
  });

  let turns = 0;
  let completeParams: LogosCompleteParams | undefined;

  for await (const event of loop) {
    turns++;
    switch (event.type) {
      case "tool_execution_start":
        console.log(`  [tool] ${event.toolName}`);
        break;
      case "tool_execution_end":
        if (event.toolName !== "logos_complete") {
          const text =
            typeof event.result === "object" && event.result !== null
              ? ((event.result as any)?.content?.[0]?.text ?? "")
              : String(event.result ?? "");
          const preview =
            text.length > 300 ? text.slice(0, 300) + "..." : text;
          console.log(`  [result] ${preview}`);
        }
        break;
      case "logos_complete":
        completeParams = event.params;
        console.log(`  [complete] ${event.params.summary}`);
        break;
      case "max_turns_reached":
        console.log(`  [max_turns] reached`);
        break;
    }
  }

  return { params: completeParams, turns };
}

// ── Prompt fragments ─────────────────────────────────────────

function toolDocsBlock(kernelMode: boolean): string {
  if (kernelMode) {
    return `## Tools

You have Logos kernel primitives:

1. **logos_exec(command)** — Execute a shell command. Output truncated to ~200 lines;
   full output saved to terminal log (read via logos_read when truncated).
2. **logos_read(uri)** — Read from any Logos URI.
3. **logos_write(uri, content)** — Write to a Logos URI.
4. **logos_complete(...)** — MANDATORY final call to finish your turn.`;
  }
  return `## Tools

- **logos_exec(command)** — Execute a shell command. Output truncated to ~200 lines.
- **logos_complete(...)** — MANDATORY: call this when done or blocked.`;
}

const OPERATIONAL_RULES = `\
- Your default working directory is /app. Always \`cd /app\` first unless the task requires another directory.
- Always use the exact paths, filenames, formats, versions, ordering, and numeric thresholds required by the task.
- You MUST call logos_complete to finish your turn.
- Execute commands one at a time, observe output, then decide next steps.
- If you encounter an unrecoverable error, call logos_complete with sleep.
- Do NOT ask the user for input. Work autonomously.
- Be efficient — minimize unnecessary commands.`;

// ── Executor prompt ──────────────────────────────────────────

function buildExecutorPrompt(
  originalTask: string,
  subtask: string,
  kernelMode: boolean,
): string {
  return `You are an executor agent working on one specific subtask of a larger plan.

## Original task (context only — do NOT attempt the full task)

${originalTask}

## Your assigned subtask

${subtask}

${toolDocsBlock(kernelMode)}

## Rules

- Focus exclusively on your assigned subtask. Do not attempt unrelated parts of the original task.
- When done, call logos_complete with a clear summary of what you accomplished and any relevant findings for subsequent steps.
- Before calling logos_complete, verify your work: check outputs exist, tests pass, etc.
- If the subtask is too complex, you may call logos_complete with a \`plan\` field to decompose it further.
${OPERATIONAL_RULES}`;
}

// ── Planner prompt ───────────────────────────────────────────

function buildPlannerPrompt(
  originalTask: string,
  completed: CompletedSubtask[],
  remaining: string[],
  kernelMode: boolean,
): string {
  const completedBlock =
    completed.length > 0
      ? completed
          .map((c, i) => `${i + 1}. "${c.description}" — ${c.summary}`)
          .join("\n")
      : "(none)";

  const remainingBlock = remaining
    .map((r, i) => `${i + 1}. "${r}"`)
    .join("\n");

  return `You are a planner reviewing progress on a multi-step task.

## Original task

${originalTask}

## Completed subtasks

${completedBlock}

## Remaining subtasks

${remainingBlock}

${toolDocsBlock(kernelMode)}

## Your decision

Review the completed work and remaining plan. You may use tools to inspect current state if needed (e.g., check files created by previous steps). Then choose one action:

1. **Continue**: remaining plan is still correct → call logos_complete with \`plan\` set to the remaining subtask list.
2. **Replan**: adjustments needed → call logos_complete with a revised \`plan\`.
3. **Done**: original task is already fully achieved → call logos_complete with just a \`summary\` (no plan field).

${OPERATIONAL_RULES}`;
}

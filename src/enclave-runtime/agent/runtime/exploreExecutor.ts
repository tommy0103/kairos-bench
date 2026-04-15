/**
 * Explore mode executor — parallel workspace-isolated strategy execution.
 *
 * When the main agent calls logos_complete({ explore: [...] }), the runtime
 * enters explore mode: each approach is executed in parallel by a separate
 * agent, each with its own copy of /app. The first approach to succeed
 * "wins" — its workspace is copied back to /app.
 *
 * Key differences from plan mode:
 *   - Approaches are alternative strategies, not sequential steps.
 *   - Each approach gets a full copy of /app (workspace isolation).
 *   - Execution is parallel (bounded by MAX_PARALLEL).
 *   - First success wins; remaining approaches are abandoned.
 */
import type OpenAI from "openai";
import type { ChatClient } from "../core/chatClient";
import type { AgentTool, LogosCompleteParams } from "../core/types";
import { reactLoop } from "../core/reactLoop";
import { executePlan } from "./planExecutor";
import { buildAgentSkillsSection } from "./agentSkills";

const MAX_PARALLEL = 3;

// ── Public types ─────────────────────────────────────────────

export interface ExploreExecutorOptions {
  tools: AgentTool[];
  client: ChatClient;
  model: string;
  originalTask: string;
  approaches: string[];
  taskLog?: string;
  maxTurnsPerApproach: number;
  temperature?: number;
  kernelMode: boolean;
  contextLimit?: number;
  /** Actual per-command timeout in seconds (shown in tool docs). */
  execTimeoutSec?: number;
}

// ── Main entry point ─────────────────────────────────────────

export async function executeExplore(
  opts: ExploreExecutorOptions,
): Promise<boolean> {
  const {
    tools,
    client,
    model,
    originalTask,
    approaches,
    taskLog,
    maxTurnsPerApproach,
    temperature = 0.2,
    kernelMode,
    contextLimit,
    execTimeoutSec,
  } = opts;

  const bounded = approaches.slice(0, MAX_PARALLEL);
  console.log(
    `[explore] starting ${bounded.length} parallel approaches ` +
      `(${maxTurnsPerApproach} turns each)`,
  );

  const execTool = tools.find((t) => t.name === "logos_exec");
  if (!execTool) throw new Error("[explore] logos_exec tool not found");

  // 1. Create isolated workspaces
  for (let i = 0; i < bounded.length; i++) {
    await execTool.execute(`explore-setup-${i}`, {
      command: `rm -rf /tmp/explore-${i} && cp -r /app /tmp/explore-${i}`,
    });
    console.log(`[explore] workspace ${i} ready: /tmp/explore-${i}`);
  }

  // 2. Run approaches in parallel
  const results = await Promise.allSettled(
    bounded.map((approach, idx) =>
      runApproach({
        client,
        model,
        tools,
        originalTask,
        approach,
        taskLog,
        workDir: `/tmp/explore-${idx}`,
        idx,
        maxTurns: maxTurnsPerApproach,
        temperature,
        execTimeoutSec,
        kernelMode,
        contextLimit,
      }),
    ),
  );

  // 3. Find first successful approach
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && r.value) {
      console.log(
        `[explore] approach ${i} succeeded: "${bounded[i].slice(0, 80)}"`,
      );
      await execTool.execute("explore-copy-back", {
        command:
          `rm -rf /app.explore-bak && mv /app /app.explore-bak && ` +
          `mv /tmp/explore-${i} /app`,
      });
      console.log(`[explore] workspace ${i} → /app`);
      // Cleanup other workspaces
      for (let j = 0; j < bounded.length; j++) {
        if (j !== i)
          execTool
            .execute(`explore-cleanup-${j}`, {
              command: `rm -rf /tmp/explore-${j}`,
            })
            .catch(() => {});
      }
      return true;
    }
    if (r.status === "rejected") {
      console.log(`[explore] approach ${i} error: ${r.reason}`);
    } else {
      console.log(`[explore] approach ${i} did not succeed`);
    }
  }

  console.log(`[explore] all ${bounded.length} approaches failed`);
  return false;
}

// ── Single approach runner ───────────────────────────────────

async function runApproach(opts: {
  client: ChatClient;
  model: string;
  tools: AgentTool[];
  originalTask: string;
  approach: string;
  taskLog?: string;
  workDir: string;
  idx: number;
  maxTurns: number;
  temperature: number;
  kernelMode: boolean;
  contextLimit?: number;
  execTimeoutSec?: number;
}): Promise<boolean> {
  const tag = `explore-${opts.idx}`;
  console.log(`[${tag}] starting: "${opts.approach.slice(0, 100)}"`);

  const systemPrompt = buildExplorePrompt(
    opts.originalTask,
    opts.approach,
    opts.workDir,
    opts.taskLog,
    opts.kernelMode,
    opts.execTimeoutSec,
  );

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: opts.approach },
  ];

  const loop = reactLoop({
    client: opts.client,
    model: opts.model,
    messages,
    tools: opts.tools,
    maxTurns: opts.maxTurns,
    temperature: opts.temperature,
    contextLimit: opts.contextLimit,
  });

  let completeParams: LogosCompleteParams | undefined;
  let turns = 0;

  for await (const event of loop) {
    turns++;
    switch (event.type) {
      case "tool_execution_start": {
        const raw = JSON.stringify(event.params);
        const args = raw.length > 150 ? raw.slice(0, 150) + "…" : raw;
        console.log(`  [${tag}] ${event.toolName}(${args})`);
        break;
      }
      case "tool_execution_end":
        if (event.toolName !== "logos_complete") {
          const text =
            typeof event.result === "object" && event.result !== null
              ? ((event.result as any)?.content?.[0]?.text ?? "")
              : String(event.result ?? "");
          const preview =
            text.length > 200 ? text.slice(0, 200) + "..." : text;
          console.log(`  [${tag}-result] ${preview}`);
        }
        break;
      case "logos_complete":
        completeParams = event.params;
        console.log(`  [${tag}] complete: ${event.params.summary}`);
        break;
      case "context_pressure":
        console.log(
          `  [${tag}] context_pressure: ~${event.estimatedTokens}/${event.limit}`,
        );
        break;
      case "max_turns_reached":
        console.log(`  [${tag}] max_turns reached`);
        break;
    }
  }

  if (!completeParams || completeParams.sleep) {
    console.log(`[${tag}] finished (${turns} turns, FAIL — no complete or sleep)`);
    return false;
  }

  // Explore executor used plan mode → run nested plan in its workspace
  if (completeParams.plan && completeParams.plan.length > 0) {
    console.log(
      `[${tag}] entering nested plan (${completeParams.plan.length} subtasks)`,
    );
    const planOk = await executePlan({
      tools: opts.tools,
      client: opts.client,
      model: opts.model,
      originalTask: buildWorkspaceRemappedTask(opts.originalTask, opts.workDir),
      subtasks: completeParams.plan,
      maxTurnsPerAgent: opts.maxTurns,
      temperature: opts.temperature,
      kernelMode: opts.kernelMode,
      contextLimit: opts.contextLimit,
    });
    console.log(`[${tag}] nested plan ${planOk ? "SUCCESS" : "FAIL"}`);
    return planOk;
  }

  console.log(`[${tag}] finished (${turns} turns, SUCCESS)`);
  return true;
}

/**
 * Rewrite /app references in the task description to point at the
 * explore workspace so that nested plan executors work in the right directory.
 */
function buildWorkspaceRemappedTask(
  originalTask: string,
  workDir: string,
): string {
  return (
    originalTask.replace(/\/app\b/g, workDir) +
    `\n\n[WORKSPACE NOTE: Your working directory is ${workDir}, NOT /app. ` +
    `All /app paths in the task above have been remapped to ${workDir}.]`
  );
}

// ── Prompt ───────────────────────────────────────────────────

function buildExplorePrompt(
  originalTask: string,
  approach: string,
  workDir: string,
  taskLog: string | undefined,
  kernelMode: boolean,
  execTimeoutSec = 590,
): string {
  const toolDocs = kernelMode
    ? `## Tools

You have Logos kernel primitives:

1. **logos_exec(command)** — Execute a shell command. Output truncated to ~200 lines;
   full output saved to terminal log (read via logos_read when truncated).
   **Time limit: each logos_exec call has a ~${execTimeoutSec} second timeout.** If a command exceeds this, it is killed and returns exit_code -1. For long-running tasks (training, compilation), design commands to complete within this limit. Use the shell \`timeout\` utility for additional safety (e.g. \`timeout ${Math.round(execTimeoutSec * 0.5)} ./my_program\`).
2. **logos_read(uri)** — Read from any Logos URI.
3. **logos_write(uri, content, append?)** — Write to a Logos URI. Set append=true to append instead of overwrite. For large files, split into multiple logos_write calls with append=true to avoid stream truncation.
4. **logos_complete(...)** — MANDATORY final call to finish your turn.`
    : `## Tools

- **logos_exec(command)** — Execute a shell command. Output truncated to ~200 lines. Each call has a ~${execTimeoutSec} second timeout.
- **logos_complete(...)** — MANDATORY: call this when done or blocked.`;

  const taskLogSection = taskLog
    ? `\n## Previous analysis\n\n${taskLog}\n`
    : "";

  return `You are an explore agent trying ONE specific approach to solve a task.
Your workspace is an isolated copy of /app at \`${workDir}\`.

## CRITICAL — Workspace isolation

**ALL paths in the task that reference \`/app\` must use \`${workDir}\` instead.**
For example:
  - \`/app/data.txt\` → \`${workDir}/data.txt\`
  - \`/app/output.json\` → \`${workDir}/output.json\`
  - \`cd /app\` → \`cd ${workDir}\`

NEVER read from or write to \`/app\` directly. Always use \`${workDir}\`.
If you need to install system packages (apt-get, pip install), that is fine — those are shared.

## Original task

${originalTask}

## Your assigned approach

${approach}
${taskLogSection}
${toolDocs}

## Rules

- Focus on the specific approach assigned to you. Do not try other strategies.
- Always \`cd ${workDir}\` before executing commands.
- When done, call logos_complete with \`summary\` describing what you accomplished.
- Before calling logos_complete, verify your work: check outputs exist at \`${workDir}/...\`, run tests, etc.
- If this approach requires multiple steps, you may call logos_complete with \`plan: ["step 1", "step 2", ...]\` to decompose it. Each step will run in your isolated workspace.
- If the approach is not working, call logos_complete with \`summary\` explaining why it failed. Do NOT use sleep.
- **Container environment**: Inside a Docker container with no init system. Start services in background mode.
- Be efficient — this is one of multiple parallel approaches. Move quickly.${buildAgentSkillsSection(originalTask)}`;
}

import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { ChatClient } from "../../agent/core/chatClient";
import { reactLoop } from "../../agent/core/reactLoop";
import type { ReactLoopEvent } from "../../agent/core/reactLoop";
import type { AgentTool, LogosCompleteParams } from "../../agent/core/types";
import type { LogosClient } from "../../agent/runtime/logosClient";
import { EventEmitter } from "node:events";

export type TaskStatus = "running" | "completed" | "aborted" | "failed";

export interface TaskNode {
  id: string;
  parentId: string | null;
  description: string;
  status: TaskStatus;
  summary?: string;
  taskLog?: string;
  checkpointPath?: string;
  children: TaskNode[];
  pendingPlan: string[];
  createdAt: number;
  completedAt?: number;
}

export type TaskTreeEvent =
  | { type: "node_created"; node: TaskNode }
  | { type: "node_updated"; node: TaskNode }
  | { type: "depth_changed"; breadcrumb: TaskNode[] }
  | { type: "execution_started"; node: TaskNode; role: "executor" | "planner" }
  | { type: "execution_finished" }
  | { type: "react_loop_event"; event: ReactLoopEvent };

export interface ConversationTurn {
  role: "user" | "agent";
  content: string;
}

export interface TaskTreeOptions {
  client: ChatClient;
  model: string;
  tools: AgentTool[];
  originalTask: string;
  displayTask?: string;
  maxTurnsPerAgent: number;
  temperature?: number;
  contextLimit?: number;
  kernelMode: boolean;
  sessionId?: string;
  projectState?: string;
  recentCheckpoints?: Array<{ description: string; summary: string }>;
  checkpointIndexUri?: string;
  logosClient?: LogosClient;
  conversationHistory?: ConversationTurn[];
  onNodeComplete?: (node: TaskNode, params: LogosCompleteParams) => Promise<void>;
}

interface RunSubAgentResult {
  params?: LogosCompleteParams;
  turns: number;
  wasAborted: boolean;
}

function createNode(description: string, parentId: string | null): TaskNode {
  return {
    id: `task-${randomUUID().slice(0, 8)}`,
    parentId,
    description,
    status: "running",
    children: [],
    pendingPlan: [],
    createdAt: Date.now(),
  };
}

export class TaskTree extends EventEmitter<{ event: [TaskTreeEvent] }> {
  root: TaskNode;
  current: TaskNode | null = null;
  private opts: TaskTreeOptions;
  private nodeMap = new Map<string, TaskNode>();
  private abortController: AbortController | null = null;
  private userInstruction: string | null = null;
  private pendingUserMessages: string[] = [];
  private abortGate: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(opts: TaskTreeOptions) {
    super();
    this.opts = opts;
    this.root = createNode(opts.displayTask ?? opts.originalTask, null);
    this.root.status = "running";
    this.nodeMap.set(this.root.id, this.root);
    this.current = this.root;
  }

  private emit_(ev: TaskTreeEvent) {
    this.emit("event", ev);
  }

  private findParent(node: TaskNode): TaskNode | null {
    if (!node.parentId) return null;
    return this.nodeMap.get(node.parentId) ?? null;
  }

  getNode(id: string): TaskNode | null {
    return this.nodeMap.get(id) ?? null;
  }

  getAncestorChain(node: TaskNode): TaskNode[] {
    const chain: TaskNode[] = [];
    let cur: TaskNode | null = node;
    while (cur) {
      chain.unshift(cur);
      cur = this.findParent(cur);
    }
    return chain;
  }

  getBreadcrumb(): TaskNode[] {
    if (!this.current) return [this.root];
    return this.getAncestorChain(this.current);
  }

  getCurrentChildren(): Array<{ type: "node"; node: TaskNode } | { type: "pending"; description: string }> {
    if (!this.current) return [];
    const result: Array<{ type: "node"; node: TaskNode } | { type: "pending"; description: string }> = [];
    for (const child of this.current.children) {
      result.push({ type: "node", node: child });
    }
    for (const desc of this.current.pendingPlan) {
      result.push({ type: "pending", description: desc });
    }
    return result;
  }

  injectUserMessage(message: string) {
    this.pendingUserMessages.push(message);
  }

  abort(instruction?: string) {
    if (instruction !== undefined) {
      this.userInstruction = instruction;
    }
    let resolveGate: () => void;
    this.abortGate = {
      promise: new Promise<void>((r) => { resolveGate = r; }),
      resolve: () => resolveGate(),
    };
    this.abortController?.abort();
  }

  setInstruction(instruction: string) {
    this.userInstruction = instruction;
  }

  resumeAfterAbort() {
    this.abortGate?.resolve();
    this.abortGate = null;
  }

  async run(): Promise<void> {
    const result = await this.runSubAgent(this.current!, "executor");

    if (!result.params) {
      this.current!.status = result.wasAborted ? "aborted" : "failed";
      this.current!.summary = result.wasAborted ? "Aborted by user" : "logos_complete was not called";
      this.emit_({ type: "node_updated", node: this.current! });
      return;
    }

    await this.handleComplete(this.current!, result.params);

    while (this.current) {
      const next = this.pickNext();
      if (!next) break;
      await next();
    }

    this.emit_({ type: "execution_finished" });
  }

  private pickNext(): (() => Promise<void>) | null {
    if (!this.current) return null;

    if (this.current.pendingPlan.length > 0) {
      return async () => {
        const desc = this.current!.pendingPlan[0];
        const child = createNode(desc, this.current!.id);
        this.nodeMap.set(child.id, child);
        this.current!.children.push(child);
        this.current = child;
        this.emit_({ type: "node_created", node: child });
        this.emit_({ type: "depth_changed", breadcrumb: this.getBreadcrumb() });

        const result = await this.runSubAgent(child, "executor");

        if (!result.params) {
          child.status = result.wasAborted ? "aborted" : "failed";
          child.summary = child.status === "aborted"
            ? "Aborted by user"
            : "logos_complete was not called";
          child.completedAt = Date.now();
          this.emit_({ type: "node_updated", node: child });
          await this.bubbleUp(child);
          return;
        }

        await this.handleComplete(child, result.params);
      };
    }

    return null;
  }

  private async handleComplete(node: TaskNode, params: LogosCompleteParams): Promise<void> {
    node.summary = params.summary;
    node.taskLog = params.task_log;

    if (this.opts.onNodeComplete) {
      try {
        await this.opts.onNodeComplete(node, params);
      } catch (e) {
        console.warn(`[taskTree] onNodeComplete failed: ${e}`);
      }
    }

    if (params.plan && params.plan.length > 0) {
      node.pendingPlan = params.plan;
      node.status = "running";
      this.emit_({ type: "node_updated", node });
      return;
    }

    if (params.sleep) {
      node.status = "failed";
      node.completedAt = Date.now();
      this.emit_({ type: "node_updated", node });
      await this.bubbleUp(node);
      return;
    }

    node.status = "completed";
    node.completedAt = Date.now();
    this.emit_({ type: "node_updated", node });

    await this.bubbleUp(node);
  }

  private async bubbleUp(node: TaskNode): Promise<void> {
    const parent = this.findParent(node);
    if (!parent) {
      this.current = null;
      return;
    }

    const desc = parent.pendingPlan[0];
    if (desc) {
      parent.pendingPlan.shift();
    }

    const childFailed = node.status === "aborted" || node.status === "failed";

    if (childFailed || parent.pendingPlan.length > 0) {
      this.current = parent;
      this.emit_({ type: "depth_changed", breadcrumb: this.getBreadcrumb() });
      if (this.abortGate) {
        await this.abortGate.promise;
      }
      const plannerResult = await this.runSubAgent(parent, "planner");
      if (plannerResult.wasAborted) {
        if (this.abortGate) {
          await this.abortGate.promise;
        }
        const retryResult = await this.runSubAgent(parent, "planner");
        if (retryResult.params) {
          await this.handlePlannerResult(parent, retryResult.params);
        } else {
          parent.status = "failed";
          parent.summary = "Planner aborted twice";
          parent.completedAt = Date.now();
          this.emit_({ type: "node_updated", node: parent });
          this.current = null;
        }
      } else if (plannerResult.params) {
        await this.handlePlannerResult(parent, plannerResult.params);
      } else if (childFailed) {
        parent.status = "failed";
        parent.summary = `Child "${node.description}" ${node.status}`;
        parent.completedAt = Date.now();
        this.emit_({ type: "node_updated", node: parent });
        await this.bubbleUp(parent);
      }
      return;
    }

    const needsEval = parent.children.length > 1
      && parent.children.every((c) => c.status === "completed")
      && !parent.children.some((c) => c.description.startsWith("[eval]"));

    if (needsEval) {
      parent.pendingPlan = ["[eval] Cross-module integration review: verify all subtask outputs are consistent, check imports/types/API contracts across changed files, run tests, and report issues or confirm integration is correct."];
      this.current = parent;
      this.emit_({ type: "node_updated", node: parent });
      this.emit_({ type: "depth_changed", breadcrumb: this.getBreadcrumb() });
      return;
    }

    parent.status = "completed";
    parent.completedAt = Date.now();
    this.current = parent;
    this.emit_({ type: "node_updated", node: parent });
    this.emit_({ type: "depth_changed", breadcrumb: this.getBreadcrumb() });
    await this.bubbleUp(parent);
  }

  private async handlePlannerResult(node: TaskNode, params: LogosCompleteParams): Promise<void> {
    if (params.plan && params.plan.length > 0) {
      node.pendingPlan = params.plan;
      node.status = "running";
      this.emit_({ type: "node_updated", node });
    } else {
      node.status = "completed";
      node.summary = params.summary;
      node.completedAt = Date.now();
      this.emit_({ type: "node_updated", node });
      await this.bubbleUp(node);
    }
  }

  private async runSubAgent(
    node: TaskNode,
    role: "executor" | "planner",
  ): Promise<RunSubAgentResult> {
    this.emit_({ type: "execution_started", node, role });
    this.abortController = new AbortController();

    const [crystalNotes, toolRanking] = await Promise.all([
      this.queryCrystals(node.description),
      this.queryToolRanking(node.description),
    ]);

    const allNotes = [crystalNotes, toolRanking.notes].filter(Boolean).join("\n\n");
    const behavioralNotes = allNotes
      ? (crystalNotes.startsWith("\n\n## Behavioral Notes")
        ? crystalNotes + (toolRanking.notes ? "\n\n" + toolRanking.notes : "")
        : (allNotes ? `\n\n## Behavioral Notes\n\n${allNotes}` : ""))
      : "";

    const systemPrompt = (role === "executor"
      ? this.buildExecutorPrompt(node)
      : this.buildPlannerPrompt(node))
      + behavioralNotes;

    const userMessage = role === "executor"
      ? node.description
      : "Review progress and decide how to proceed.";

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    if (node.parentId === null && role === "executor") {
      const history = this.opts.conversationHistory ?? [];
      const recent = history.slice(-6);
      if (recent.length > 0) {
        const historyText = recent.map((turn) =>
          turn.role === "user" ? `[User]: ${turn.content}` : `[Agent]: ${turn.content}`
        ).join("\n\n");
        messages.push({
          role: "user",
          content: `## Recent conversation history\n\n${historyText}\n\n---\n\nNow proceed with the current task below.`,
        });
      }
    }

    messages.push({ role: "user", content: userMessage });

    const sessionId = this.opts.sessionId;
    const contextPressureMessage = sessionId
      ? "CONTEXT WINDOW WARNING: You have used approximately 80% of your available context. " +
        "To preserve coherence you should immediately:\n" +
        `1. Call logos_complete with a detailed \`task_log\` recording everything you have done so far. ` +
        `Your log will be saved to logos://session/${sessionId}/checkpoints/{checkpoint_id}/log.md for the next agent.\n` +
        "2. Set the `plan` field to list the remaining steps as subtasks.\n" +
        "Each subtask will be executed by a fresh agent with a clean context window and access to the same session.\n" +
        "Do this NOW — do not attempt further tool calls before entering plan mode."
      : undefined;

    const loop = reactLoop({
      client: this.opts.client,
      model: this.opts.model,
      messages,
      tools: toolRanking.tools,
      maxTurns: this.opts.maxTurnsPerAgent,
      temperature: this.opts.temperature ?? 0.2,
      contextLimit: this.opts.contextLimit,
      contextPressureMessage,
      signal: this.abortController.signal,
      onToolChunk: (ev) => {
        this.emit_({ type: "react_loop_event", event: { type: "tool_output_chunk", ...ev } });
      },
    });

    let turns = 0;
    let completeParams: LogosCompleteParams | undefined;

    for await (const event of loop) {
      turns++;
      this.emit_({ type: "react_loop_event", event });

      if (this.pendingUserMessages.length > 0) {
        for (const msg of this.pendingUserMessages) {
          messages.push({ role: "user", content: `[User Instruction]: ${msg}` });
        }
        this.pendingUserMessages = [];
      }

      if (event.type === "tool_execution_end") {
        const isError = event.result && typeof event.result === "object" && "error" in (event.result as any);
        if (isError) {
          const errorMsg = (event.result as any)?.error ?? "";
          const freshCrystals = await this.queryCrystals(
            `${node.description}\nFailed tool: ${event.toolName}\nError: ${errorMsg}`
          );
          if (freshCrystals) {
            messages.push({ role: "user", content: freshCrystals.trim() });
          }
        }
      }

      if (event.type === "logos_complete") {
        completeParams = event.params;
      }
    }

    const wasAborted = this.abortController?.signal.aborted ?? false;
    this.abortController = null;
    return { params: completeParams, turns, wasAborted };
  }

  buildExecutorPrompt(node: TaskNode): string {
    if (node.description.startsWith("[eval]")) {
      return this.buildEvaluatorPrompt(node);
    }
    const { originalTask, kernelMode } = this.opts;
    const ancestors = this.getAncestorChain(node);
    const parent = this.findParent(node);

    let ancestorBlock = "";
    if (ancestors.length > 2) {
      const completed = ancestors.slice(1, -1).filter((n) => n.status === "completed");
      if (completed.length > 0) {
        ancestorBlock = "\n\n## Ancestor progress\n\n" +
          completed.map((n) => `- "${n.description}" — ${n.summary ?? "(no summary)"}`).join("\n");
      }
    }

    let siblingsBlock = "";
    if (parent) {
      const siblings = parent.children.filter((c) => c.id !== node.id);
      if (siblings.length > 0) {
        const lines = siblings.map((s) => {
          const icon = s.status === "completed" ? "✓" : s.status === "aborted" ? "⚠ aborted" : "✗ failed";
          return `- [${icon}] "${s.description}" — ${s.summary ?? "(no summary)"}`;
        });
        siblingsBlock = "\n\n## Prior subtasks in this group\n\n" + lines.join("\n");
      }
    }

    return `You are an autonomous coding agent working on a specific task.

## Original task (context only — do NOT attempt the full task)

${originalTask}

## Your assigned task

${node.description}
${ancestorBlock}${siblingsBlock}${this.memoryBlock()}

${this.toolDocsBlock()}

## Rules

${this.operationalRules()}

When done, call logos_complete with:
- \`summary\`: concise description of what you accomplished.
- \`reply\`: message to the user explaining what was done or asking for clarification.
- \`task_log\`: detailed execution record (required).
- If the task has multiple distinct steps, call logos_complete with \`plan: ["step 1", "step 2", ...]\` to decompose it. Each step will be executed by a fresh agent with its own context. Prefer plan mode for multi-step tasks over doing everything in one pass.
- If blocked, call logos_complete with \`sleep\`.
- Before calling logos_complete, update \`PROJECT_STATE.md\` in the project root with a brief summary of the current project state, what has been done, and what remains. This file serves as persistent memory across agent turns.`;
  }

  private buildEvaluatorPrompt(node: TaskNode): string {
    const { originalTask } = this.opts;
    const parent = this.findParent(node);
    const siblings = parent ? parent.children.filter((c) => c.id !== node.id) : [];

    const siblingDetails = siblings.map((s, i) => {
      return `${i + 1}. **${s.description}** — ${s.summary ?? "(no summary)"}`;
    }).join("\n");

    return `You are an evaluator agent. Your job is to find real bugs in the work done by other agents.

## Original task

${originalTask}

## Scope being evaluated

${parent?.description ?? node.description}

## What was done

${siblingDetails}
${this.memoryBlock()}

${this.toolDocsBlock()}

## Your method

Follow these three steps strictly:

### Step 1: Run existing tests, find environment contradictions

Run the project's existing test suite and type checker. Do NOT skip this. Look for:
- Tests that were passing before but now fail (regressions)
- Type errors introduced by the changes
- Build failures

Record every failure. Do not try to fix anything yet.

### Step 2: Write adversarial edge-case tests targeting seams

The most likely bugs live at the boundaries between subtasks — where one agent's output meets another's input. Write small, targeted test cases that specifically probe:
- Cross-module integration points (does module A actually call module B's new API correctly?)
- Edge cases the individual agents likely didn't consider (empty inputs, concurrent access, error propagation across boundaries)
- Contract mismatches (does the type signature match the runtime behavior?)

Run these tests. Record failures.

### Step 3: Triage — distinguish real bugs from wrong test assumptions

For each failure found in steps 1 and 2, determine:
- **Real bug**: the implementation is wrong → needs a fix task
- **Wrong test premise**: the test itself has incorrect assumptions about the new architecture → the test needs updating, not the code
- **Environment issue**: missing dependency, wrong config → needs a setup fix

## Your decision

After your review, call logos_complete:

- If no real bugs found: \`{ summary: "Evaluation passed: ...", reply: "...", task_log: "detailed findings" }\`
- If real bugs found: \`{ summary: "Found N issues: ...", reply: "...", task_log: "detailed findings", plan: ["fix: ...", "fix: ..."] }\` — prefix each fix task with "fix:" so the next agent knows the context.

${this.operationalRules()}`;
  }

  buildPlannerPrompt(node: TaskNode): string {
    const { originalTask } = this.opts;

    const completedBlock = node.children.length > 0
      ? node.children.map((c, i) => {
          const icon = c.status === "completed" ? "✓" : c.status === "aborted" ? "⚠ aborted" : "✗ failed";
          return `${i + 1}. [${icon}] "${c.description}" — ${c.summary ?? "(no summary)"}`;
        }).join("\n\n")
      : "(none)";

    const lastChild = node.children[node.children.length - 1];
    let lastChildBlock = "";
    if (lastChild) {
      const logPreview = lastChild.taskLog
        ? lastChild.taskLog.length > 4000
          ? lastChild.taskLog.slice(0, 4000) + "\n[... truncated ...]"
          : lastChild.taskLog
        : "(no task_log)";
      lastChildBlock = `\n\n## Last completed subtask detail\n\n**${lastChild.description}** (${lastChild.status})\n\nSummary: ${lastChild.summary ?? "(none)"}\n\n<details>\n<summary>Task log</summary>\n\n${logPreview}\n</details>`;
    }

    const remainingBlock = node.pendingPlan.length > 0
      ? node.pendingPlan.map((r, i) => `${i + 1}. "${r}"`).join("\n")
      : "(none — all subtasks completed)";

    let userInstructionBlock = "";
    if (this.userInstruction) {
      userInstructionBlock = `\n\n## User instruction\n\n${this.userInstruction}`;
      this.userInstruction = null;
    }

    return `You are a planner reviewing progress on a multi-step task.

## Original task

${originalTask}

## Your assigned scope

${node.description}
${this.memoryBlock()}
## Completed subtasks

${completedBlock}
${lastChildBlock}

## Remaining subtasks

${remainingBlock}
${userInstructionBlock}

${this.toolDocsBlock()}

## Your decision

Review the completed work and remaining plan. You may inspect current state using tools.

Then choose one action:

1. **Continue**: remaining plan is still correct → call logos_complete with \`plan\` set to the remaining subtask list.
2. **Replan**: adjustments needed → call logos_complete with a revised \`plan\`.
3. **Done**: task is fully achieved → call logos_complete with just a \`summary\` (no plan field).

Always include \`task_log\` with your reasoning and \`reply\` to communicate your decision to the user.
Before calling logos_complete, update \`PROJECT_STATE.md\` in the project root with the current project state summary.

${this.operationalRules()}`;
  }

  private memoryBlock(): string {
    const parts: string[] = [];
    if (this.opts.projectState) {
      parts.push(`## Project State (from PROJECT_STATE.md)\n\n${this.opts.projectState}`);
    }
    if (this.opts.recentCheckpoints && this.opts.recentCheckpoints.length > 0) {
      const lines = this.opts.recentCheckpoints.map(
        (c) => `- "${c.description}" — ${c.summary}`
      );
      parts.push(`## Recent checkpoints\n\n${lines.join("\n")}`);
    }
    if (this.opts.checkpointIndexUri) {
      parts.push(`## Checkpoint history\n\nFull checkpoint index available at: \`${this.opts.checkpointIndexUri}\` (use logos_read to access).`);
    }
    return parts.length > 0 ? "\n\n" + parts.join("\n\n") : "";
  }

  private async queryCrystals(context: string): Promise<string> {
    const lc = this.opts.logosClient;
    if (!lc) return "";

    try {
      await lc.write("logos://proc/memory/crystal/query/input", context);
      const raw = await lc.read("logos://proc/memory/crystal/query/output");
      const data = JSON.parse(raw);
      const crystals = data?.crystals as Array<{ label: string; bullets: string }> | undefined;
      if (!crystals || crystals.length === 0) return "";

      const lines = crystals.map(
        (c) => `[${c.label}]\n${c.bullets.trim()}`
      );
      return `\n\n## Behavioral Notes\n\n${lines.join("\n\n")}`;
    } catch {
      return "";
    }
  }

  private async queryToolRanking(task: string): Promise<{ tools: AgentTool[]; notes: string }> {
    const lc = this.opts.logosClient;
    if (!lc) return { tools: this.opts.tools, notes: "" };

    try {
      await lc.write("logos://proc/memory/tool/query/input", task);
      const raw = await lc.read("logos://proc/memory/tool/query/output");
      const data = JSON.parse(raw);
      const ranked = data?.ranked_tools as Array<{
        tool_name: string;
        score: number;
        memories: string[];
      }> | undefined;

      if (!ranked || ranked.length === 0) return { tools: this.opts.tools, notes: "" };

      const hasMemories = ranked.some((r) => r.score > 0);
      let filteredTools = this.opts.tools;
      if (hasMemories && this.opts.tools.length > 15) {
        const topNames = new Set(
          ranked
            .filter((r) => r.score > 0.3)
            .map((r) => r.tool_name)
        );
        const coreTools = new Set(["logos_exec", "logos_read", "logos_write", "logos_call", "logos_complete"]);
        filteredTools = this.opts.tools.filter(
          (t) => coreTools.has(t.name) || topNames.has(t.name) || !hasMemories
        );
      }

      const toolNotes = ranked
        .filter((r) => r.memories.length > 0)
        .map((r) => `[${r.tool_name}]\n${r.memories.join("\n")}`)
        .join("\n\n");

      return { tools: filteredTools, notes: toolNotes };
    } catch {
      return { tools: this.opts.tools, notes: "" };
    }
  }

  private toolDocsBlock(): string {
    return `## Tools

- **logos_exec(command)** — Execute a shell command in the project workspace. Output truncated to ~200 lines.
  - The working directory is the project root. Use standard shell commands.
  - To create/edit files, use \`cat > file << 'EOF'\` or \`sed -i\`.
  - To read files, use \`cat\`, \`head\`, \`grep\`, etc.
- **logos_read(uri)** — Read from the Logos VFS. Use to discover proc tools (\`logos://proc/\`) or retrieve truncated output.
- **logos_call(tool, params)** — Invoke a proc tool (e.g. \`web_search\`, \`fetch_url\`).
- **logos_complete(...)** — MANDATORY final call. Options:
  - Normal finish: \`{ summary, reply, task_log }\`
  - **Plan mode**: \`{ summary, reply, task_log, plan: ["step 1", "step 2", ...] }\` — decomposes the task into subtasks. Each subtask will be executed by a fresh agent. Use plan mode when the task has multiple distinct steps or is too complex for a single pass.
  - Blocked: \`{ summary, reply, task_log, sleep: { reason, retry } }\``;
  }

  private operationalRules(): string {
    return `- Your working directory is the project root. All file paths are relative to it.
- You MUST call logos_complete to finish your turn.
- Execute commands one at a time, observe output, then decide next steps.
- To create or edit files, use logos_exec with shell commands (cat, sed, echo, etc.). Do NOT use logos_write for project files.
- If you encounter an unrecoverable error, call logos_complete with sleep.
- Do NOT ask the user for input. Work autonomously.
- Be efficient — minimize unnecessary commands.
- Before calling logos_complete, verify your work (e.g. run tests, check file contents).`;
  }
}

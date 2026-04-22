import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { ChatClient } from "../../agent/core/chatClient";
import { reactLoop } from "../../agent/core/reactLoop";
import type { ReactLoopEvent } from "../../agent/core/reactLoop";
import type { AgentTool, LogosCompleteParams } from "../../agent/core/types";
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

export interface TaskTreeOptions {
  client: ChatClient;
  model: string;
  tools: AgentTool[];
  originalTask: string;
  maxTurnsPerAgent: number;
  temperature?: number;
  contextLimit?: number;
  kernelMode: boolean;
  sessionId?: string;
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
    this.root = createNode(opts.originalTask, null);
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

    const systemPrompt = role === "executor"
      ? this.buildExecutorPrompt(node)
      : this.buildPlannerPrompt(node);

    const userMessage = role === "executor"
      ? node.description
      : "Review progress and decide how to proceed.";

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    const loop = reactLoop({
      client: this.opts.client,
      model: this.opts.model,
      messages,
      tools: this.opts.tools,
      maxTurns: this.opts.maxTurnsPerAgent,
      temperature: this.opts.temperature ?? 0.2,
      contextLimit: this.opts.contextLimit,
      signal: this.abortController.signal,
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

      if (event.type === "logos_complete") {
        completeParams = event.params;
      }
    }

    const wasAborted = this.abortController?.signal.aborted ?? false;
    this.abortController = null;
    return { params: completeParams, turns, wasAborted };
  }

  buildExecutorPrompt(node: TaskNode): string {
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
${ancestorBlock}${siblingsBlock}

${this.toolDocsBlock()}

## Rules

${this.operationalRules()}

When done, call logos_complete with:
- \`summary\`: concise description of what you accomplished.
- \`task_log\`: detailed execution record (required).
- If the task is too complex, call logos_complete with \`plan\` to decompose it.
- If blocked, call logos_complete with \`sleep\`.`;
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

Always include \`task_log\` with your reasoning.

${this.operationalRules()}`;
  }

  private toolDocsBlock(): string {
    return `## Tools

- **logos_exec(command)** — Execute a shell command in the project workspace. Output truncated to ~200 lines.
  - The working directory is the project root. Use standard shell commands.
  - To create/edit files, use \`cat > file << 'EOF'\` or \`sed -i\`.
  - To read files, use \`cat\`, \`head\`, \`grep\`, etc.
- **logos_complete(...)** — MANDATORY: call this when done or blocked.`;
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

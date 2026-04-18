/**
 * Bench-runner runtime layer.
 *
 * Separates the "runtime" role (task creation, token management, session
 * lifecycle) from the "agent" role (ReAct loop, tool use).  This matches
 * RFC §12.4: "Task creation is the responsibility of the runtime, not
 * the agent."
 *
 * Two session modes:
 *   - Kernel: connects to logos-kernel via gRPC, full URI-based tools
 *   - Standalone: local bash exec only, no kernel needed
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { AgentTool, LogosCompleteParams } from "../core/types";
import type { TurnOutcome } from "./completeHandler";
import { createLogosClient } from "./logosClient";
import { createAllLogosTools, tailLines } from "./logosTools";
import { createLogosCompleteTool } from "../tools/logosComplete";
import { createCompleteHandler } from "./completeHandler";

// ── Public types ─────────────────────────────────────────────

export interface BenchSession {
  taskId: string;
  tools: AgentTool[];
  handleComplete: (
    taskId: string,
    params: LogosCompleteParams,
  ) => Promise<TurnOutcome>;
  handleTimeout?: (taskId: string) => Promise<TurnOutcome>;
  cleanup: () => void;
  useKernel: boolean;
}

export interface KernelSessionOptions {
  socketPath: string;
  taskDescription: string;
  agentConfigId: string;
  /** Per-command timeout for logos_exec (default: 590s). */
  execTimeoutMs?: number;
}

// ── Kernel session ───────────────────────────────────────────

export async function createKernelSession(
  opts: KernelSessionOptions,
): Promise<BenchSession> {
  const logosClient = createLogosClient({ socketPath: opts.socketPath });

  const taskId = `bench-${randomUUID().slice(0, 8)}`;

  await logosClient.write(
    "logos://system/tasks",
    JSON.stringify({
      task_id: taskId,
      description: opts.taskDescription,
      workspace: `logos://sandbox/${taskId}`,
    }),
  );

  const token = `tok-${randomUUID()}`;
  await logosClient.registerToken(token, taskId, "agent", opts.agentConfigId);
  await logosClient.handshake(token);
  console.log(`[bench-runtime] kernel session bound to task ${taskId}`);

  const logosTools = createAllLogosTools(logosClient, {
    execTimeoutMs: opts.execTimeoutMs,
    taskId,
  });
  const tools = [...logosTools, createLogosCompleteTool()];
  const handler = createCompleteHandler({ logosClient });

  return {
    taskId,
    tools,
    handleComplete: (_, params) => handler.handle(taskId, params),
    handleTimeout: (_) => handler.handleTimeout(taskId),
    cleanup: () => logosClient.close(),
    useKernel: true,
  };
}

// ── Standalone session (no kernel) ───────────────────────────

const STDOUT_TAIL_LINES = 200;
const STDERR_TAIL_LINES = 50;

function createLocalExecTool(): AgentTool {
  return {
    name: "logos_exec",
    label: "Execute",
    description:
      "Execute a shell command. Output is truncated to the last ~200 lines.",
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
  signal?: AbortSignal,
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

    const onAbort = () => {
      child.kill("SIGTERM");
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => (stdout += String(c)));
    child.stderr.on("data", (c: Buffer) => (stderr += String(c)));
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, sig) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (timedOut) {
        resolve(
          `[timed out]\nstdout:\n${tailLines(stdout, STDOUT_TAIL_LINES)}\nstderr:\n${tailLines(stderr, STDERR_TAIL_LINES)}`,
        );
        return;
      }
      const lines = [
        `exit_code: ${code ?? "null"}`,
        `signal: ${sig ?? "null"}`,
      ];
      if (stdout)
        lines.push(`\nstdout:\n${tailLines(stdout, STDOUT_TAIL_LINES)}`);
      if (stderr)
        lines.push(`\nstderr:\n${tailLines(stderr, STDERR_TAIL_LINES)}`);
      resolve(lines.join("\n"));
    });
  });
}

export function createStandaloneSession(): BenchSession {
  const tools = [createLocalExecTool(), createLogosCompleteTool()];

  return {
    taskId: "local",
    tools,
    handleComplete: async (_, params) => {
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
    },
    cleanup: () => {},
    useKernel: false,
  };
}

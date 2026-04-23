import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "../../agent/core/types";
import type { LogosClient } from "../../agent/runtime/logosClient";
import { createTuiLogosClient, type TuiLogosClient } from "../session/tuiLogosClient";
import { createManagedSession, type ManagedSession } from "../session/sessionManager";
import { createTuiCompleteHandler, type CheckpointRecord } from "./tuiCompleteHandler";
export type { CheckpointRecord } from "./tuiCompleteHandler";

const STDOUT_TAIL_LINES = 200;
const STDERR_TAIL_LINES = 50;
const DEFAULT_EXEC_TIMEOUT_MS = 590_000;
const MAX_TOOL_OUTPUT_CHARS = 100_000;

function tailLines(text: string, maxLines: number, hint?: string): string {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const n = lines.length - maxLines;
  const prefix = hint
    ? `[... ${n} lines omitted — ${hint} ...]\n`
    : `[... ${n} lines omitted ...]\n`;
  return prefix + lines.slice(-maxLines).join("\n");
}

import type { LogosCompleteParams } from "../../agent/core/types";
import type { TaskNode } from "./taskTree";

export interface TuiSession {
  sessionId: string;
  tools: AgentTool[];
  managedSession: ManagedSession;
  onNodeComplete: (node: TaskNode, params: LogosCompleteParams) => Promise<void>;
  logosClient: LogosClient;
  projectName: string;
  initialCheckpointId: string;
  getCheckpointHistory: () => CheckpointRecord[];
  cleanup: () => void;
}

export interface TuiSessionOptions {
  socketPath: string;
  projectPath: string;
  sessionId?: string;
  agentConfigId?: string;
  execTimeoutMs?: number;
  onCheckpoint?: (checkpointId: string, record: CheckpointRecord) => void;
}

function createExecTool(client: LogosClient, sessionId: string, workspacePath: string, execTimeoutMs?: number): AgentTool {
  const timeoutMs = execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const timeoutSec = Math.round(timeoutMs / 1000);

  return {
    name: "logos_exec",
    label: "Execute",
    description:
      "Execute a shell command in the project workspace. " +
      "The working directory is the project root. Output is truncated to the last ~200 lines; " +
      `full output is saved and can be retrieved with logos_read("logos://session/${sessionId}/terminal/{call_id}.stdout"). ` +
      `Commands time out after ~${timeoutSec}s.`,
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute in the project workspace." }),
    }),
    execute: async (callId, params, signal, onChunk) => {
      return execViaGrpc(client, sessionId, callId, params.command, timeoutMs, timeoutSec, signal);
    },
  };
}

async function execViaGrpc(
  client: LogosClient, sessionId: string, callId: string,
  command: string, timeoutMs: number, timeoutSec: number, signal?: AbortSignal,
): Promise<{ content: Array<{ type: string; text: string }>; details?: any }> {
  let result: { stdout: string; stderr: string; exit_code: number };
  try {
    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
      : null;
    const execPromise = client.exec(command);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`logos_exec timed out after ${timeoutSec}s`)),
        timeoutMs,
      )
    );
    const racers: Promise<any>[] = [execPromise, timeoutPromise];
    if (abortPromise) racers.push(abortPromise);
    result = await Promise.race(racers);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "aborted") {
      return { content: [{ type: "text", text: "Command aborted by user." }] };
    }
    if (msg.includes("timed out")) {
      return {
        content: [{
          type: "text",
          text: `exit_code: -1 (TIMEOUT after ${timeoutSec}s)\n\nThe command did not complete within the time limit.`,
        }],
      };
    }
    throw err;
  }

  const logBase = `logos://session/${sessionId}/terminal/${callId}`;
  if (result.stdout) {
    client.write(`${logBase}.stdout`, result.stdout).catch(() => {});
  }
  if (result.stderr) {
    client.write(`${logBase}.stderr`, result.stderr).catch(() => {});
  }

  const logHintStdout = `logos_read("${logBase}.stdout")`;
  const logHintStderr = `logos_read("${logBase}.stderr")`;

  let stdout = tailLines(result.stdout, STDOUT_TAIL_LINES, logHintStdout) || "(empty)";
  let stderr = tailLines(result.stderr, STDERR_TAIL_LINES, logHintStderr) || "(empty)";

  const combined = stdout.length + stderr.length;
  if (combined > MAX_TOOL_OUTPUT_CHARS) {
    const stderrBudget = Math.min(stderr.length, Math.floor(MAX_TOOL_OUTPUT_CHARS * 0.2));
    const stdoutBudget = MAX_TOOL_OUTPUT_CHARS - stderrBudget;
    if (stdout.length > stdoutBudget) {
      stdout = stdout.slice(0, stdoutBudget) +
        `\n[... truncated — use ${logHintStdout} for full output ...]`;
    }
    if (stderr.length > stderrBudget) {
      stderr = stderr.slice(0, stderrBudget) +
        `\n[... truncated — use ${logHintStderr} for full output ...]`;
    }
  }

  const text = [
    `exit_code: ${result.exit_code}`,
    "",
    "stdout:",
    stdout,
    "",
    "stderr:",
    stderr,
  ].join("\n");

  return { content: [{ type: "text", text }], details: result };
}

function execViaSpawn(
  client: LogosClient, sessionId: string, workspacePath: string, callId: string,
  command: string, timeoutMs: number, timeoutSec: number,
  signal?: AbortSignal, onChunk?: (chunk: string) => void,
): Promise<{ content: Array<{ type: string; text: string }>; details?: any }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn("bash", ["-c", command], {
      cwd: workspacePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: workspacePath },
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(-1, true);
    }, timeoutMs);

    const onAbort = () => {
      child.kill("SIGKILL");
      settle(-1, false, true);
    };
    if (signal) {
      if (signal.aborted) {
        child.kill("SIGKILL");
        resolve({ content: [{ type: "text", text: "Command aborted by user." }] });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    let stdoutBuf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const str = String(chunk);
      stdout += str;
      if (onChunk) {
        stdoutBuf += str;
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop()!;
        for (const line of lines) {
          onChunk(line);
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });

    function settle(exitCode: number, timedOut = false, aborted = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      if (onChunk && stdoutBuf) {
        onChunk(stdoutBuf);
        stdoutBuf = "";
      }

      if (aborted) {
        resolve({ content: [{ type: "text", text: "Command aborted by user." }] });
        return;
      }

      const logBase = `logos://session/${sessionId}/terminal/${callId}`;
      if (stdout) {
        client.write(`${logBase}.stdout`, stdout).catch(() => {});
      }
      if (stderr) {
        client.write(`${logBase}.stderr`, stderr).catch(() => {});
      }

      if (timedOut) {
        resolve({
          content: [{
            type: "text",
            text: `exit_code: -1 (TIMEOUT after ${timeoutSec}s)\n\nThe command did not complete within the time limit.`,
          }],
        });
        return;
      }

      const logHintStdout = `logos_read("${logBase}.stdout")`;
      const logHintStderr = `logos_read("${logBase}.stderr")`;

      let stdoutText = tailLines(stdout, STDOUT_TAIL_LINES, logHintStdout) || "(empty)";
      let stderrText = tailLines(stderr, STDERR_TAIL_LINES, logHintStderr) || "(empty)";

      const combined = stdoutText.length + stderrText.length;
      if (combined > MAX_TOOL_OUTPUT_CHARS) {
        const stderrBudget = Math.min(stderrText.length, Math.floor(MAX_TOOL_OUTPUT_CHARS * 0.2));
        const stdoutBudget = MAX_TOOL_OUTPUT_CHARS - stderrBudget;
        if (stdoutText.length > stdoutBudget) {
          stdoutText = stdoutText.slice(0, stdoutBudget) +
            `\n[... truncated — use ${logHintStdout} for full output ...]`;
        }
        if (stderrText.length > stderrBudget) {
          stderrText = stderrText.slice(0, stderrBudget) +
            `\n[... truncated — use ${logHintStderr} for full output ...]`;
        }
      }

      const text = [
        `exit_code: ${exitCode}`,
        "",
        "stdout:",
        stdoutText,
        "",
        "stderr:",
        stderrText,
      ].join("\n");

      resolve({ content: [{ type: "text", text }], details: { stdout, stderr, exit_code: exitCode } });
    }

    child.on("error", () => {
      settle(-1);
    });

    child.on("close", (code) => {
      settle(code ?? -1);
    });
  });
}

function createReadTool(client: LogosClient): AgentTool {
  return {
    name: "logos_read",
    label: "Read",
    description:
      "Read from the Logos VFS. Use to discover available proc tools " +
      "(`logos://proc/`) or read system state (`logos://system/tasks`). " +
      "For reading project files, prefer `logos_exec(\"cat file.txt\")`. " +
      "Supports optional offset (byte offset) and limit (max bytes) for large content.",
    parameters: Type.Object({
      uri: Type.String({ description: 'Logos URI to read, e.g. "logos://proc/" or "logos://system/tasks".' }),
      offset: Type.Optional(Type.Number({ description: "Byte offset to start reading from (default: 0)." })),
      limit: Type.Optional(Type.Number({ description: "Max bytes to return (default: no limit, capped at ~400K chars)." })),
    }),
    execute: async (_id, params) => {
      const content = await client.read(params.uri);
      const offset = params.offset ?? 0;
      const limit = params.limit ?? MAX_TOOL_OUTPUT_CHARS;
      const sliced = content.slice(offset, offset + limit);
      const truncated = sliced.length < content.length - offset;
      let text = sliced;
      if (truncated) {
        text += `\n\n[... truncated — showing bytes ${offset}..${offset + sliced.length} of ${content.length}. Use offset/limit to read more. ...]`;
      }
      return { content: [{ type: "text", text }] };
    },
  };
}

function createCallTool(client: LogosClient, sessionId: string): AgentTool {
  return {
    name: "logos_call",
    label: "Call",
    description:
      "Invoke a proc tool by name with structured JSON parameters. " +
      "Use `logos_read(\"logos://proc/\")` to discover available tools. " +
      "Built-in tools include: web_search, fetch_url.",
    parameters: Type.Object({
      tool: Type.String({ description: 'Proc tool name, e.g. "web_search" or "fetch_url".' }),
      params: Type.Optional(Type.String({ description: "JSON string of parameters. Omit or use '{}' for no parameters." })),
    }),
    execute: async (callId, params) => {
      const toolParams = params.params ? JSON.parse(params.params) : {};
      try {
        const result = await client.call(params.tool, toolParams);
        const raw = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        if (raw.length > MAX_TOOL_OUTPUT_CHARS) {
          const logUri = `logos://session/${sessionId}/call/${callId}.result`;
          client.write(logUri, raw).catch(() => {});
          const text = raw.slice(0, MAX_TOOL_OUTPUT_CHARS) +
            `\n\n[... truncated — showing first ${MAX_TOOL_OUTPUT_CHARS} chars of ${raw.length} total. Use logos_read("${logUri}") for full output ...]`;
          return { content: [{ type: "text", text }] };
        }
        return { content: [{ type: "text", text: raw }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `[error] ${msg}` }] };
      }
    },
  };
}

function createCompleteTool(): AgentTool {
  return {
    name: "logos_complete",
    label: "Complete",
    description:
      "Mandatory final call of every agent turn. You MUST call this to finish.",
    parameters: Type.Object({
      summary: Type.String({ description: "What happened this turn — used for context management." }),
      reply: Type.Optional(Type.String({ description: "Message to deliver to the user." })),
      task_log: Type.Optional(Type.String({ description: "Detailed execution log for long-term memory." })),
      sleep: Type.Optional(
        Type.Object({
          reason: Type.Union([Type.Literal("recoverable_error"), Type.Literal("awaiting_user")]),
          retry: Type.Boolean(),
        }, { description: "Put the task to sleep instead of finishing." })
      ),
      plan: Type.Optional(
        Type.Array(Type.String(), { description: "List of subtask descriptions to decompose into." })
      ),
    }),
    execute: async () => ({
      content: [{ type: "text", text: "Turn completed." }],
    }),
  };
}

export async function createTuiSession(
  opts: TuiSessionOptions,
): Promise<TuiSession> {
  const client = createTuiLogosClient(opts.socketPath);
  const sessionId = opts.sessionId ?? `tui-${randomUUID().slice(0, 8)}`;

  const token = `tok-${randomUUID()}`;
  await client.registerToken(token, sessionId, "agent", opts.agentConfigId ?? "tui");
  await client.handshake(token);
  console.log(`[tui-runtime] kernel session bound to ${sessionId}`);

  const managedSession = await createManagedSession({
    sessionClient: client.session,
    projectPath: opts.projectPath,
    sessionId,
  });

  const initialCheckpointId = `cp-init-${randomUUID().slice(0, 8)}`;
  try {
    await client.session.checkpoint(sessionId, initialCheckpointId);
    console.log(`[tui-runtime] initial checkpoint ${initialCheckpointId}`);
  } catch (e) {
    console.warn(`[tui-runtime] initial checkpoint failed: ${e}`);
  }

  const completeHandler = createTuiCompleteHandler({
    sessionId,
    sessionClient: client.session,
    logosClient: client,
    onCheckpoint: opts.onCheckpoint,
  });

  const tools: AgentTool[] = [
    createExecTool(client, sessionId, managedSession.workspacePath, opts.execTimeoutMs),
    createReadTool(client),
    createCallTool(client, sessionId),
    createCompleteTool(),
  ];

  const projectName = basename(opts.projectPath);

  return {
    sessionId,
    tools,
    managedSession,
    onNodeComplete: completeHandler.handle,
    logosClient: client,
    projectName,
    initialCheckpointId,
    getCheckpointHistory: completeHandler.getHistory,
    cleanup: () => client.close(),
  };
}

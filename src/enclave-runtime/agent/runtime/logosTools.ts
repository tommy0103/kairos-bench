/**
 * Logos kernel primitives exposed as AgentTools for the ReAct loop.
 *
 * Each tool delegates to the LogosClient gRPC interface.
 * logos_complete is NOT here — it is intercepted by the reactLoop
 * and handled by the CompleteHandler.
 *
 * logos_exec writes full output to logos://sandbox/{task_id}/terminal/{call_id}.stdout
 * and returns a truncated tail to the agent (RFC §5.1).
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "../core/types";
import type { LogosClient } from "./logosClient";

const STDOUT_TAIL_LINES = 200;
const STDERR_TAIL_LINES = 50;
const DEFAULT_EXEC_TIMEOUT_MS = 590_000;
const MAX_TOOL_OUTPUT_CHARS = 100_000; // ~100K tokens

/**
 * Keep the last `maxLines` lines of `text`.
 * When truncation occurs, prepend an omission notice containing `hint`
 * so the agent knows where to find the full output.
 */
export function tailLines(
  text: string,
  maxLines: number,
  hint?: string
): string {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const n = lines.length - maxLines;
  const prefix = hint
    ? `[... ${n} lines omitted — ${hint} ...]\n`
    : `[... ${n} lines omitted ...]\n`;
  return prefix + lines.slice(-maxLines).join("\n");
}

export function createLogosReadTool(client: LogosClient): AgentTool {
  return {
    name: "logos_read",
    label: "Read",
    description:
      "Read content from a Logos URI. Works across all namespaces " +
      "(memory/, sandbox/, system/, proc/, services/, etc.). " +
      "Supports optional offset (byte offset) and limit (max bytes) for large content.",
    parameters: Type.Object({
      uri: Type.String({
        description:
          'Logos URI to read, e.g. "logos://memory/messages" or "logos://system/tasks".',
      }),
      offset: Type.Optional(
        Type.Number({
          description: "Byte offset to start reading from (default: 0).",
        })
      ),
      limit: Type.Optional(
        Type.Number({
          description:
            "Max bytes to return (default: no limit, but capped at ~400K chars).",
        })
      ),
    }),
    execute: async (_id, params) => {
      const content = await client.read(params.uri);
      const offset = params.offset ?? 0;
      const limit = params.limit ?? MAX_TOOL_OUTPUT_CHARS;
      const sliced = content.slice(offset, offset + limit);
      const truncated = sliced.length < content.length - offset;
      const totalLen = content.length;
      let text = sliced;
      if (truncated) {
        text += `\n\n[... truncated — showing bytes ${offset}..${
          offset + sliced.length
        } of ${totalLen}. Use offset/limit to read more. ...]`;
      }
      return { content: [{ type: "text", text }] };
    },
  };
}

export function createLogosWriteTool(client: LogosClient): AgentTool {
  return {
    name: "logos_write",
    label: "Write",
    description:
      "Write content to a Logos URI. Creates or overwrites the resource. " +
      "Set append=true to append instead of overwrite. " +
      "For large files, split into multiple calls with append=true to avoid stream truncation. " +
      "Pure data operation — no side effects beyond storage.",
    parameters: Type.Object({
      uri: Type.String({
        description: "Logos URI to write to.",
      }),
      content: Type.String({
        description: "Content to write.",
      }),
      append: Type.Optional(
        Type.Boolean({
          description:
            "If true, append to existing content instead of overwriting. Default: false.",
        })
      ),
    }),
    execute: async (_id, params) => {
      if (params.append) {
        let existing = "";
        try {
          existing = await client.read(params.uri);
        } catch {
          // file doesn't exist yet
        }
        await client.write(params.uri, existing + params.content);
        return {
          content: [{ type: "text", text: `Appended to ${params.uri}` }],
        };
      }
      await client.write(params.uri, params.content);
      return { content: [{ type: "text", text: `Written to ${params.uri}` }] };
    },
  };
}

export function createLogosPatchTool(client: LogosClient): AgentTool {
  return {
    name: "logos_patch",
    label: "Patch",
    description:
      "Partially update content at a Logos URI. Merges the provided " +
      "partial into the existing content (JSON merge-patch semantics).",
    parameters: Type.Object({
      uri: Type.String({
        description: "Logos URI to patch.",
      }),
      partial: Type.String({
        description: "Partial content (JSON merge-patch).",
      }),
    }),
    execute: async (_id, params) => {
      await client.patch(params.uri, params.partial);
      return { content: [{ type: "text", text: `Patched ${params.uri}` }] };
    },
  };
}

export function createLogosExecTool(
  client: LogosClient,
  execTimeoutMs?: number,
  taskId?: string,
): AgentTool {
  const timeoutMs = execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const timeoutSec = Math.round(timeoutMs / 1000);
  return {
    name: "logos_exec",
    label: "Execute",
    description:
      "Execute a shell command in the sandbox. Logos URIs are translated " +
      "to real paths automatically. Output is truncated to the last ~200 " +
      `lines; full output is saved to logos://sandbox/${taskId ?? "{task_id}"}/terminal/{call_id}.stdout ` +
      "(retrieve with logos_read). " +
      `Commands time out after ~${timeoutSec}s — never run foreground services (use & or daemon mode).`,
    parameters: Type.Object({
      command: Type.String({
        description:
          "Shell command to execute. Logos URIs (logos://sandbox/...) are a remote filesystem and can only be accessed via logos_read/logos_write, NOT via shell commands. " +
          "are translated to container paths automatically.",
      }),
    }),
    execute: async (callId, params) => {
      let result: { stdout: string; stderr: string; exit_code: number };
      try {
        result = await Promise.race([
          client.exec(params.command),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(new Error(`logos_exec timed out after ${timeoutSec}s`)),
              timeoutMs
            )
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
                  `exit_code: -1 (TIMEOUT after ${timeoutSec}s)\n\n` +
                  "The command did not complete within the time limit. " +
                  "This usually means the command is blocking (e.g. a service running in foreground). " +
                  "Use background mode (append & or use daemon flags) for long-running services.",
              },
            ],
          };
        }
        throw err;
      }

      const logBase = `logos://sandbox/${taskId ?? "unknown"}/terminal/${callId}`;
      if (result.stdout) {
        client.write(`${logBase}.stdout`, result.stdout).catch(() => {});
      }
      if (result.stderr) {
        client.write(`${logBase}.stderr`, result.stderr).catch(() => {});
      }

      let stdout =
        tailLines(
          result.stdout,
          STDOUT_TAIL_LINES,
          `read ${logBase}.stdout for full output`
        ) || "(empty)";
      let stderr =
        tailLines(
          result.stderr,
          STDERR_TAIL_LINES,
          `read ${logBase}.stderr for full output`
        ) || "(empty)";

      const combined = stdout.length + stderr.length;
      if (combined > MAX_TOOL_OUTPUT_CHARS) {
        const stderrBudget = Math.min(
          stderr.length,
          Math.floor(MAX_TOOL_OUTPUT_CHARS * 0.2)
        );
        const stdoutBudget = MAX_TOOL_OUTPUT_CHARS - stderrBudget;
        if (stdout.length > stdoutBudget) {
          stdout =
            stdout.slice(0, stdoutBudget) +
            `\n[... stdout truncated at ${stdoutBudget} chars — read ${logBase}.stdout for full output ...]`;
        }
        if (stderr.length > stderrBudget) {
          stderr =
            stderr.slice(0, stderrBudget) +
            `\n[... stderr truncated at ${stderrBudget} chars — read ${logBase}.stderr for full output ...]`;
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
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  };
}

export function createLogosCallTool(client: LogosClient, taskId?: string): AgentTool {
  return {
    name: "logos_call",
    label: "Call",
    description:
      "Invoke a proc tool by name with structured JSON parameters. " +
      "Use logos_read('logos://proc/') to discover available tools.",
    parameters: Type.Object({
      tool: Type.String({
        description: 'Proc tool name, e.g. "web_search" or "memory.search".',
      }),
      params: Type.Optional(
        Type.String({
          description:
            "JSON string of parameters to pass to the tool. " +
            "Omit or use '{}' for no parameters.",
        })
      ),
    }),
    execute: async (callId, params) => {
      const toolParams = params.params ? JSON.parse(params.params) : {};
      try {
        const result = await client.call(params.tool, toolParams);
        const raw =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
        if (raw.length > MAX_TOOL_OUTPUT_CHARS) {
          const logUri = `logos://sandbox/${taskId ?? "unknown"}/call/${callId}.result`;
          client.write(logUri, raw).catch(() => {});
          const text =
            raw.slice(0, MAX_TOOL_OUTPUT_CHARS) +
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

export function createAllLogosTools(
  client: LogosClient,
  opts?: { execTimeoutMs?: number; taskId?: string }
): AgentTool[] {
  return [
    createLogosReadTool(client),
    createLogosWriteTool(client),
    createLogosPatchTool(client),
    createLogosExecTool(client, opts?.execTimeoutMs, opts?.taskId),
    createLogosCallTool(client, opts?.taskId),
  ];
}

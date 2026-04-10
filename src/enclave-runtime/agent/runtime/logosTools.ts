/**
 * Logos kernel primitives exposed as AgentTools for the ReAct loop.
 *
 * Each tool delegates to the LogosClient gRPC interface.
 * logos_complete is NOT here — it is intercepted by the reactLoop
 * and handled by the CompleteHandler.
 *
 * logos_exec writes full output to logos://sandbox/terminal/{call_id}.stdout
 * and returns a truncated tail to the agent (RFC §5.1).
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "../core/types";
import type { LogosClient } from "./logosClient";

const STDOUT_TAIL_LINES = 200;
const STDERR_TAIL_LINES = 50;
const DEFAULT_EXEC_TIMEOUT_MS = 590_000;

/**
 * Keep the last `maxLines` lines of `text`.
 * When truncation occurs, prepend an omission notice containing `hint`
 * so the agent knows where to find the full output.
 */
export function tailLines(
  text: string,
  maxLines: number,
  hint?: string,
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
      "(memory/, sandbox/, system/, proc/, services/, etc.).",
    parameters: Type.Object({
      uri: Type.String({
        description:
          'Logos URI to read, e.g. "logos://memory/messages" or "logos://system/tasks".',
      }),
    }),
    execute: async (_id, params) => {
      const content = await client.read(params.uri);
      return { content: [{ type: "text", text: content }] };
    },
  };
}

export function createLogosWriteTool(client: LogosClient): AgentTool {
  return {
    name: "logos_write",
    label: "Write",
    description:
      "Write content to a Logos URI. Creates or overwrites the resource. " +
      "Pure data operation — no side effects beyond storage.",
    parameters: Type.Object({
      uri: Type.String({
        description: "Logos URI to write to.",
      }),
      content: Type.String({
        description: "Content to write.",
      }),
    }),
    execute: async (_id, params) => {
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
): AgentTool {
  const timeoutMs = execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const timeoutSec = Math.round(timeoutMs / 1000);
  return {
    name: "logos_exec",
    label: "Execute",
    description:
      "Execute a shell command in the sandbox. Logos URIs are translated " +
      "to real paths automatically. Output is truncated to the last ~200 " +
      "lines; full output is saved to logos://sandbox/terminal/{call_id}.stdout " +
      "(retrieve with logos_read). " +
      `Commands time out after ~${timeoutSec}s — never run foreground services (use & or daemon mode).`,
    parameters: Type.Object({
      command: Type.String({
        description:
          "Shell command to execute. Logos URIs (logos://sandbox/...) " +
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
              () => reject(new Error(`logos_exec timed out after ${timeoutSec}s`)),
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

      const logBase = `logos://sandbox/terminal/${callId}`;
      if (result.stdout) {
        client.write(`${logBase}.stdout`, result.stdout).catch(() => {});
      }
      if (result.stderr) {
        client.write(`${logBase}.stderr`, result.stderr).catch(() => {});
      }

      const text = [
        `exit_code: ${result.exit_code}`,
        "",
        "stdout:",
        tailLines(
          result.stdout,
          STDOUT_TAIL_LINES,
          `read ${logBase}.stdout for full output`,
        ) || "(empty)",
        "",
        "stderr:",
        tailLines(
          result.stderr,
          STDERR_TAIL_LINES,
          `read ${logBase}.stderr for full output`,
        ) || "(empty)",
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  };
}

export function createLogosCallTool(client: LogosClient): AgentTool {
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
    execute: async (_id, params) => {
      const toolParams = params.params
        ? JSON.parse(params.params)
        : {};
      const result = await client.call(params.tool, toolParams);
      const text =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }] };
    },
  };
}

export function createAllLogosTools(
  client: LogosClient,
  opts?: { execTimeoutMs?: number },
): AgentTool[] {
  return [
    createLogosReadTool(client),
    createLogosWriteTool(client),
    createLogosPatchTool(client),
    createLogosExecTool(client, opts?.execTimeoutMs),
    createLogosCallTool(client),
  ];
}

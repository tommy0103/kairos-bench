import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "../../agent/core/types";
import { createLogosCompleteTool } from "../../agent/tools/logosComplete";

const STDOUT_TAIL_LINES = 200;
const STDERR_TAIL_LINES = 50;
const DEFAULT_TIMEOUT_MS = 590_000;
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

function createTuiExecTool(cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): AgentTool {
  const timeoutSec = Math.round(timeoutMs / 1000);
  const logDir = join(cwd, ".logos", "terminal");

  return {
    name: "logos_exec",
    label: "Execute",
    description:
      "Execute a shell command in the project workspace. Output is truncated to the last ~200 lines; " +
      "full output is saved to .logos/terminal/{call_id}.stdout (read with `cat`). " +
      `Commands time out after ~${timeoutSec}s.`,
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute." }),
    }),
    execute: async (callId, params, signal) => {
      let result: { stdout: string; stderr: string; exitCode: number };
      try {
        result = await runLocal(params.command, cwd, timeoutMs, signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("timed out")) {
          return {
            content: [{
              type: "text",
              text:
                `exit_code: -1 (TIMEOUT after ${timeoutSec}s)\n\n` +
                "The command did not complete within the time limit.",
            }],
          };
        }
        if (msg === "aborted") {
          return { content: [{ type: "text", text: "Command aborted." }] };
        }
        throw err;
      }

      try {
        mkdirSync(logDir, { recursive: true });
        if (result.stdout) writeFileSync(join(logDir, `${callId}.stdout`), result.stdout);
        if (result.stderr) writeFileSync(join(logDir, `${callId}.stderr`), result.stderr);
      } catch {}

      const logHintStdout = `cat .logos/terminal/${callId}.stdout`;
      const logHintStderr = `cat .logos/terminal/${callId}.stderr`;

      let stdout = tailLines(result.stdout, STDOUT_TAIL_LINES, logHintStdout) || "(empty)";
      let stderr = tailLines(result.stderr, STDERR_TAIL_LINES, logHintStderr) || "(empty)";

      const combined = stdout.length + stderr.length;
      if (combined > MAX_TOOL_OUTPUT_CHARS) {
        const stderrBudget = Math.min(stderr.length, Math.floor(MAX_TOOL_OUTPUT_CHARS * 0.2));
        const stdoutBudget = MAX_TOOL_OUTPUT_CHARS - stderrBudget;
        if (stdout.length > stdoutBudget) {
          stdout = stdout.slice(0, stdoutBudget) +
            `\n[... truncated — run \`${logHintStdout}\` for full output ...]`;
        }
        if (stderr.length > stderrBudget) {
          stderr = stderr.slice(0, stderrBudget) +
            `\n[... truncated — run \`${logHintStderr}\` for full output ...]`;
        }
      }

      const text = [
        `exit_code: ${result.exitCode}`,
        "",
        "stdout:",
        stdout,
        "",
        "stderr:",
        stderr,
      ].join("\n");

      return { content: [{ type: "text", text }], details: result };
    },
  };
}

function runLocal(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], { cwd, env: process.env });
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
        resolve({ stdout, stderr, exitCode: -1 });
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

export interface TuiStandaloneSessionOptions {
  cwd?: string;
  execTimeoutMs?: number;
}

export function createTuiStandaloneSession(opts?: TuiStandaloneSessionOptions) {
  const cwd = opts?.cwd ?? process.cwd();
  const tools = [
    createTuiExecTool(cwd, opts?.execTimeoutMs),
    createLogosCompleteTool(),
  ];

  return {
    tools,
    cwd,
    cleanup: () => {},
  };
}

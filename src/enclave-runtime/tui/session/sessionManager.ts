import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { SessionLifecycleClient } from "./tuiLogosClient";

export interface SessionManagerOptions {
  sessionClient: SessionLifecycleClient;
  projectPath: string;
  sessionId?: string;
}

export interface ManagedSession {
  sessionId: string;
  projectPath: string;
  workspacePath: string;
  rollback(checkpointId: string): Promise<void>;
  fork(newSessionId?: string): Promise<string>;
  accept(files: string[]): Promise<void>;
}

export async function createManagedSession(
  opts: SessionManagerOptions,
): Promise<ManagedSession> {
  const sessionId = opts.sessionId ?? `s-${randomUUID().slice(0, 8)}`;

  await ensureJuiceFS();

  console.log(`[session] creating session ${sessionId} from ${opts.projectPath}`);
  const { workspacePath } = await opts.sessionClient.createSession(opts.projectPath, sessionId);
  console.log(`[session] session ${sessionId} ready (workspace: ${workspacePath})`);

  return {
    sessionId,
    projectPath: opts.projectPath,
    workspacePath,

    async rollback(checkpointId: string) {
      console.log(`[session] rolling back to ${checkpointId}`);
      await opts.sessionClient.rollback(sessionId, checkpointId);
      console.log(`[session] rollback complete`);
    },

    async fork(newSessionId?: string) {
      const newSid = newSessionId ?? `s-${randomUUID().slice(0, 8)}`;
      console.log(`[session] forking ${sessionId} → ${newSid}`);
      await opts.sessionClient.fork(sessionId, newSid);
      console.log(`[session] fork complete: ${newSid}`);
      return newSid;
    },

    async accept(files: string[]) {
      console.log(`[session] accepting ${files.length} files → ${opts.projectPath}`);
      await runCommand("rsync", [
        "-a",
        ...files.map((f) => `--include=${f}`),
        "--exclude=*",
        `${opts.projectPath}/`,
      ]);
      console.log(`[session] accept complete`);
    },
  };
}

async function ensureJuiceFS(): Promise<void> {
  try {
    await runCommand("juicefs", ["version"]);
  } catch {
    throw new Error(
      "juicefs binary not found. Install it: curl -sSL https://d.juicefs.com/install | sh",
    );
  }
}

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += String(c)));
    child.stderr.on("data", (c: Buffer) => (stderr += String(c)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

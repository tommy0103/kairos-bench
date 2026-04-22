import { randomUUID } from "node:crypto";
import type { LogosCompleteParams } from "../../agent/core/types";
import type { LogosClient } from "../../agent/runtime/logosClient";
import type { SessionLifecycleClient } from "../session/tuiLogosClient";
import type { TaskNode } from "./taskTree";

export interface TuiCompleteHandlerOptions {
  sessionId: string;
  sessionClient: SessionLifecycleClient;
  logosClient: LogosClient;
  onCheckpoint?: (checkpointId: string) => void;
}

export function createTuiCompleteHandler(opts: TuiCompleteHandlerOptions) {
  const { sessionId, sessionClient, logosClient, onCheckpoint } = opts;

  async function handle(node: TaskNode, params: LogosCompleteParams): Promise<void> {
    const checkpointId = `cp-${randomUUID().slice(0, 8)}`;

    try {
      await sessionClient.checkpoint(sessionId, checkpointId);
      node.checkpointPath = `logos://session/${sessionId}/checkpoints/${checkpointId}`;
    } catch (e) {
      console.warn(`[checkpoint] juicefs clone failed: ${e}`);
    }

    if (params.task_log) {
      const logUri = `logos://session/${sessionId}/checkpoints/${checkpointId}/log.md`;
      try {
        await logosClient.write(logUri, params.task_log);
      } catch (e) {
        console.warn(`[checkpoint] task_log write failed: ${e}`);
      }
    }

    onCheckpoint?.(checkpointId);
  }

  return { handle };
}

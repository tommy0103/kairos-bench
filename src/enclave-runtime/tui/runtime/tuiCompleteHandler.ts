import { randomUUID } from "node:crypto";
import type { LogosCompleteParams } from "../../agent/core/types";
import type { LogosClient } from "../../agent/runtime/logosClient";
import type { SessionLifecycleClient } from "../session/tuiLogosClient";
import type { TaskNode } from "./taskTree";

export interface CheckpointRecord {
  checkpointId: string;
  nodeId: string;
  description: string;
  summary?: string;
  timestamp: number;
}

export interface TuiCompleteHandlerOptions {
  sessionId: string;
  sessionClient: SessionLifecycleClient;
  logosClient: LogosClient;
  onCheckpoint?: (checkpointId: string, record: CheckpointRecord) => void;
}

export function createTuiCompleteHandler(opts: TuiCompleteHandlerOptions) {
  const { sessionId, sessionClient, logosClient, onCheckpoint } = opts;
  const checkpointHistory: CheckpointRecord[] = [];

  async function handle(node: TaskNode, params: LogosCompleteParams): Promise<void> {
    const checkpointId = `cp-${randomUUID().slice(0, 8)}`;
    let checkpointOk = false;

    try {
      await sessionClient.checkpoint(sessionId, checkpointId);
      node.checkpointPath = `logos://session/${sessionId}/checkpoints/${checkpointId}`;
      checkpointOk = true;
    } catch (e) {
      console.warn(`[checkpoint] failed (continuing without snapshot): ${e}`);
      node.checkpointPath = undefined;
    }

    if (params.task_log && checkpointOk) {
      const logUri = `logos://session/${sessionId}/checkpoints/${checkpointId}/log.md`;
      try {
        await logosClient.write(logUri, params.task_log);
      } catch (e) {
        console.warn(`[checkpoint] task_log write failed: ${e}`);
      }
    }

    const record: CheckpointRecord = {
      checkpointId,
      nodeId: node.id,
      description: node.description,
      summary: params.summary,
      timestamp: Date.now(),
    };
    checkpointHistory.push(record);

    if (checkpointOk) {
      const indexUri = `logos://session/${sessionId}/checkpoints/index.json`;
      try {
        await logosClient.write(indexUri, JSON.stringify(checkpointHistory, null, 2));
      } catch (e) {
        console.warn(`[checkpoint] index write failed: ${e}`);
      }
    }

    onCheckpoint?.(checkpointId, record);
  }

  function getHistory(): CheckpointRecord[] {
    return checkpointHistory;
  }

  return { handle, getHistory };
}

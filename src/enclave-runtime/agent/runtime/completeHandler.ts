/**
 * logos_complete handler — routes through Logos kernel via gRPC.
 *
 * When the reactLoop detects a logos_complete tool call, it captures
 * the params and yields them. The adapter then calls this handler,
 * which delegates to Call("system.complete", ...) on the kernel.
 *
 * The kernel atomically: updates task status, writes task_log,
 * creates anchors, etc. — see RFC 002 §9.1.
 */
import type { LogosCompleteParams } from "../core/types";
import type { LogosClient } from "./logosClient";

export interface SystemCompleteResult {
  reply?: string;
  anchor_id?: string;
  task_id?: string;
}

export type TurnOutcome =
  | { type: "finished"; taskId: string; reply?: string; anchorId?: string }
  | {
      type: "sleep";
      taskId: string;
      reply?: string;
      reason: string;
      retry: boolean;
    }
  | { type: "resume"; discardedTaskId: string; resumeTaskId: string }
  | { type: "plan"; taskId: string; subtasks: string[] }
  | { type: "explore"; taskId: string; approaches: string[] }
  | { type: "timeout"; taskId: string };

export interface CompleteHandlerOptions {
  logosClient: LogosClient;
}

export function createCompleteHandler(options: CompleteHandlerOptions) {
  const { logosClient } = options;

  async function handle(
    taskId: string,
    params: LogosCompleteParams
  ): Promise<TurnOutcome> {
    const { summary, reply, anchor, task_log, sleep, resume, plan, explore } = params;

    if (explore && explore.length > 0) {
      const kernelParams: Record<string, unknown> = {
        task_id: taskId,
        summary,
      };
      if (reply) kernelParams.reply = reply;
      await logosClient.call("system.complete", kernelParams);
      return { type: "explore", taskId, approaches: explore };
    }

    if (resume) {
      // Resume is a runtime-side operation: discard current task, rebind to target.
      // Still call system.complete on the kernel to finalize the current task.
      const kernelParams: Record<string, unknown> = {
        task_id: taskId,
        summary,
        resume,
      };
      if (reply) kernelParams.reply = reply;
      await logosClient.call("system.complete", kernelParams);
      return {
        type: "resume",
        discardedTaskId: taskId,
        resumeTaskId: resume,
      };
    }

    if (plan && plan.length > 0) {
      const kernelParams: Record<string, unknown> = {
        task_id: taskId,
        summary,
        "plan.todo": plan,
      };
      if (reply) kernelParams.reply = reply;
      await logosClient.call("system.complete", kernelParams);
      return { type: "plan", taskId, subtasks: plan };
    }

    // Normal finish or sleep — delegate everything to the kernel.
    const kernelParams: Record<string, unknown> = {
      task_id: taskId,
      summary,
    };
    if (reply) kernelParams.reply = reply;
    if (anchor) kernelParams.anchor = true;
    if (task_log) kernelParams.task_log = task_log;
    if (sleep) {
      kernelParams.sleep_reason = sleep.reason;
      kernelParams.sleep_retry = sleep.retry;
    }

    const result = (await logosClient.call(
      "system.complete",
      kernelParams
    )) as SystemCompleteResult;

    if (sleep) {
      return {
        type: "sleep",
        taskId,
        reply: result.reply ?? reply,
        reason: sleep.reason,
        retry: sleep.retry,
      };
    }

    return {
      type: "finished",
      taskId,
      reply: result.reply ?? reply,
      anchorId: result.anchor_id,
    };
  }

  async function handleTimeout(taskId: string): Promise<TurnOutcome> {
    try {
      await logosClient.call("system.complete", {
        task_id: taskId,
        summary: "Turn timed out: logos_complete was never called",
        sleep_reason: "recoverable_error",
        sleep_retry: true,
      });
    } catch (err) {
      console.error(
        "[completeHandler] failed to notify kernel of timeout:",
        err
      );
    }

    return {
      type: "timeout",
      taskId,
    };
  }

  return { handle, handleTimeout };
}

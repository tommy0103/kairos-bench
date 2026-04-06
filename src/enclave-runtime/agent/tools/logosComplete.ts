import { Type } from "@sinclair/typebox";
import type { AgentTool } from "../core/types";

export function createLogosCompleteTool(): AgentTool {
  return {
    name: "logos_complete",
    label: "Logos Complete",
    description:
      "Mandatory final call of every agent turn. " +
      "You MUST call this tool to finish the current turn. " +
      "Use the `reply` field to deliver a message to the user. " +
      "Use `summary` to describe what happened this turn.",
    parameters: Type.Object({
      summary: Type.String({
        description:
          "What happened this turn — used for context window management.",
      }),
      reply: Type.Optional(
        Type.String({
          description:
            "Message to deliver to the user. Omit if no user-facing output is needed.",
        })
      ),
      anchor: Type.Optional(
        Type.Boolean({
          description:
            "Whether a meaningful checkpoint was reached. Triggers state snapshot when true.",
        })
      ),
      task_log: Type.Optional(
        Type.String({
          description:
            "Detailed execution log for long-term memory / debugging.",
        })
      ),
      sleep: Type.Optional(
        Type.Object(
          {
            reason: Type.Union([
              Type.Literal("recoverable_error"),
              Type.Literal("awaiting_user"),
            ], { description: "Why the task is sleeping." }),
            retry: Type.Boolean({
              description: "Whether the adapter should auto-retry this task.",
            }),
          },
          {
            description:
              "Put the task to sleep instead of finishing. " +
              "Use recoverable_error for transient failures, awaiting_user when input is needed.",
          }
        )
      ),
      resume: Type.Optional(
        Type.String({
          description:
            "Task ID to resume. Discards the current task and rebinds to the target.",
        })
      ),
      plan: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "List of subtask descriptions. Triggers Phase 3 planning — " +
            "the adapter will create subtasks for each entry.",
        })
      ),
      explore: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "List of alternative approach descriptions. Triggers explore mode — " +
            "each approach runs in parallel in an isolated workspace copy of /app. " +
            "First success wins. Max 3 approaches.",
        })
      ),
    }),
    execute: async () => ({
      content: [{ type: "text", text: "Turn completed." }],
    }),
  };
}

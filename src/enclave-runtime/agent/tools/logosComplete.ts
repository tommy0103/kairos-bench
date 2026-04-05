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
    }),
    execute: async () => ({
      content: [{ type: "text", text: "Turn completed." }],
    }),
  };
}

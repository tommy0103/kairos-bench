import type { AgentTool } from "../core/types";
import { Type } from "@sinclair/typebox";

interface ApoptosisDetails {
  targetToolName: string;
  stagedToolCallId: string;
}

export function createApoptosisTool(): AgentTool<any, ApoptosisDetails> {
  return {
    name: "apoptosis",
    label: "Apoptosis tool",
    description:
      "Request removing a registered tool by name. Actual removal is handled by the loop runner event listener.",
    parameters: Type.Object({
      toolName: Type.String({
        minLength: 1,
        description: "Tool name to remove from dynamicToolRegistry.",
      }),
    }),
    execute: async (toolCallId, params) => {
      const targetToolName = params.toolName.trim();
      if (!targetToolName) {
        throw new Error("toolName is required.");
      }

      return {
        content: [
          {
            type: "text",
            text: `Apoptosis requested for tool '${targetToolName}'. Loop runner will process the actual removal.`,
          },
        ],
        details: {
          targetToolName,
          stagedToolCallId: toolCallId,
        },
      };
    },
  };
}

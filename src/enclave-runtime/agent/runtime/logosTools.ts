/**
 * Logos kernel primitives exposed as AgentTools for the ReAct loop.
 *
 * Each tool delegates to the LogosClient gRPC interface.
 * logos_complete is NOT here — it is intercepted by the reactLoop
 * and handled by the CompleteHandler.
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "../core/types";
import type { LogosClient } from "./logosClient";

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

export function createLogosExecTool(client: LogosClient): AgentTool {
  return {
    name: "logos_exec",
    label: "Execute",
    description:
      "Execute a shell command in the sandbox. Logos URIs in the command " +
      "are automatically translated to sandbox filesystem paths. " +
      "Use this for all terminal operations.",
    parameters: Type.Object({
      command: Type.String({
        description:
          "Shell command to execute. Logos URIs (logos://sandbox/...) " +
          "are translated to container paths automatically.",
      }),
    }),
    execute: async (_id, params) => {
      const result = await client.exec(params.command);
      const text = [
        `exit_code: ${result.exit_code}`,
        "",
        "stdout:",
        result.stdout || "(empty)",
        "",
        "stderr:",
        result.stderr || "(empty)",
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

export function createAllLogosTools(client: LogosClient): AgentTool[] {
  return [
    createLogosReadTool(client),
    createLogosWriteTool(client),
    createLogosPatchTool(client),
    createLogosExecTool(client),
    createLogosCallTool(client),
  ];
}

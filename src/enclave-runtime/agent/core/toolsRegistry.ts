import type { AgentTool } from "./types";

export interface ToolsRegistry {
  getVersion: () => number;
  getCurrentTools: () => AgentTool[];
  registerStaticTool: (tool: AgentTool) => number;
  registerDynamicTool: (tool: AgentTool) => number;
  unregisterTool: (name: string) => boolean;
  replaceStaticTools: (tools: AgentTool[]) => number;
}

export function createToolsRegistry(initialStaticTools: AgentTool[] = []): ToolsRegistry {
  const staticToolRegistry = new Map<string, AgentTool>(
    initialStaticTools.map((tool) => [tool.name, tool])
  );
  const dynamicToolRegistry = new Map<string, AgentTool>();
  let version = 1;

  const bumpVersion = () => {
    version += 1;
    return version;
  };

  const getCurrentTools = () => {
    const merged = new Map<string, AgentTool>(staticToolRegistry);
    for (const [name, tool] of dynamicToolRegistry) {
      merged.set(name, tool);
    }
    return Array.from(merged.values());
  };

  const registerStaticTool = (tool: AgentTool) => {
    staticToolRegistry.set(tool.name, tool);
    return bumpVersion();
  };

  const registerDynamicTool = (tool: AgentTool) => {
    dynamicToolRegistry.set(tool.name, tool);
    return bumpVersion();
  };

  const unregisterTool = (name: string) => {
    const deletedDynamic = dynamicToolRegistry.delete(name);
    const deletedStatic = staticToolRegistry.delete(name);
    const deleted = deletedDynamic || deletedStatic;
    if (deleted) {
      bumpVersion();
    }
    return deleted;
  };

  const replaceStaticTools = (tools: AgentTool[]) => {
    staticToolRegistry.clear();
    for (const tool of tools) {
      staticToolRegistry.set(tool.name, tool);
    }
    return bumpVersion();
  };

  return {
    getVersion: () => version,
    getCurrentTools,
    registerStaticTool,
    registerDynamicTool,
    unregisterTool,
    replaceStaticTools,
  };
}

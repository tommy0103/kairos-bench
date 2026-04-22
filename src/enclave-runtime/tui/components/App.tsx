import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { ChatClient } from "../../agent/core/chatClient";
import type { AgentTool, LogosCompleteParams } from "../../agent/core/types";
import { TaskTree, type TaskTreeEvent, type TaskNode } from "../runtime/taskTree";
import { Terminal } from "./Terminal";
import { Timeline } from "./Timeline";
import { FileView } from "./FileView";
import { InputBox } from "./InputBox";
import { getWorkspaceDiff, type FileDiff } from "../runtime/diffEngine";
import type { LogosClient } from "../../agent/runtime/logosClient";

interface AppProps {
  client: ChatClient;
  model: string;
  tools: AgentTool[];
  contextLimit: number;
  initialTask: string;
  onNodeComplete?: (node: TaskNode, params: LogosCompleteParams) => Promise<void>;
  logosClient?: LogosClient;
  sessionId?: string;
  initialCheckpointId?: string;
}

type Mode = "running" | "prompt" | "inject";

export const App: React.FC<AppProps> = ({ client, model, tools, contextLimit, initialTask, onNodeComplete, logosClient, sessionId, initialCheckpointId }) => {
  const { exit } = useApp();
  const [lines, setLines] = useState<string[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<string[]>([]);
  const [children, setChildren] = useState<Array<{ label: string; status: string }>>([]);
  const [changedFiles, setChangedFiles] = useState<FileDiff[]>([]);
  const [mode, setMode] = useState<Mode>("running");
  const treeRef = useRef<TaskTree | null>(null);
  const lastCheckpointRef = useRef<string>(initialCheckpointId ?? "");

  const addLine = useCallback((line: string) => {
    setLines((prev) => {
      const next = [...prev, line];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  const wrappedOnNodeComplete = useCallback(async (node: TaskNode, params: LogosCompleteParams) => {
    if (onNodeComplete) {
      await onNodeComplete(node, params);
    }
    if (node.checkpointPath) {
      const cpId = node.checkpointPath.split("/").pop() ?? "";
      if (cpId) {
        lastCheckpointRef.current = cpId;
        setChangedFiles([]);
      }
    }
  }, [onNodeComplete]);

  const startJob = useCallback((task: string) => {
    const tree = new TaskTree({
      client,
      model,
      tools,
      originalTask: task,
      maxTurnsPerAgent: 100,
      temperature: 0.2,
      contextLimit,
      kernelMode: true,
      onNodeComplete: wrappedOnNodeComplete,
    });
    treeRef.current = tree;

    const handler = (ev: TaskTreeEvent) => {
      switch (ev.type) {
        case "node_created":
          addLine(`+ "${ev.node.description}"`);
          break;
        case "node_updated":
          addLine(`~ ${ev.node.status}: "${ev.node.description}"`);
          break;
        case "depth_changed":
          setBreadcrumb(ev.breadcrumb.map((n) => n.description));
          break;
        case "execution_started":
          addLine(`▶ ${ev.role}: "${ev.node.description}"`);
          setChildren(
            tree.getCurrentChildren().map((c) =>
              c.type === "node"
                ? { label: c.node.description, status: c.node.status }
                : { label: c.description, status: "pending" }
            )
          );
          break;
        case "execution_finished":
          addLine("■ finished");
          break;
        case "react_loop_event": {
          const re = ev.event;
          if (re.type === "tool_execution_start") {
            const args = JSON.stringify(re.params);
            const preview = args.length > 120 ? args.slice(0, 120) + "…" : args;
            addLine(`  [${re.toolName}] ${preview}`);
          } else if (re.type === "tool_execution_end" && re.toolName !== "logos_complete") {
            const text =
              typeof re.result === "object" && re.result !== null
                ? ((re.result as any)?.content?.[0]?.text ?? "")
                : String(re.result ?? "");
            const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
            addLine(`  → ${preview}`);
            if (logosClient && sessionId && lastCheckpointRef.current) {
              getWorkspaceDiff(logosClient, sessionId, lastCheckpointRef.current).then(setChangedFiles).catch(() => {});
            }
          } else if (re.type === "logos_complete") {
            addLine(`  ✓ ${re.params.summary}`);
          }
          break;
        }
      }
    };

    tree.on("event", handler);
    setMode("running");
    setBreadcrumb([task.length > 50 ? task.slice(0, 50) + "…" : task]);
    setChildren([]);

    tree.run().then(() => {
      tree.off("event", handler);
      treeRef.current = null;
      setMode("prompt");
      addLine("");
      addLine("Ready for next task. Type your prompt and press Enter. (Ctrl+C to quit)");
    });
  }, [client, model, tools, contextLimit, addLine]);

  useEffect(() => {
    if (initialTask) {
      addLine(`Task: ${initialTask}`);
      addLine("");
      startJob(initialTask);
    } else {
      setMode("prompt");
      addLine("Welcome to Kairos TUI. Type your task and press Enter.");
    }
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (mode === "running") {
      if (key.escape) {
        addLine("[ESC] aborting...");
        treeRef.current?.abort("User pressed ESC");
        treeRef.current?.resumeAfterAbort();
        return;
      }
      if (input === "i") {
        setMode("inject");
        return;
      }
    }
  }, { isActive: mode === "running" });

  const handlePromptSubmit = useCallback((task: string) => {
    addLine("");
    addLine(`Task: ${task}`);
    addLine("");
    startJob(task);
  }, [addLine, startJob]);

  const handleInjectSubmit = useCallback((msg: string) => {
    treeRef.current?.injectUserMessage(msg);
    addLine(`[user] ${msg}`);
    setMode("running");
  }, [addLine]);

  const handleInjectCancel = useCallback(() => {
    setMode("running");
  }, []);

  const statusLine = (() => {
    switch (mode) {
      case "running":
        return "ESC: abort | i: inject message | Ctrl+C: quit";
      case "inject":
        return "Type message, Enter to send, ESC to cancel";
      case "prompt":
        return "Enter task, Ctrl+C to quit";
    }
  })();

  return (
    <Box flexDirection="column" width="100%">
      <Box flexGrow={1} flexDirection="row">
        <Box flexGrow={1} flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1}>
          <Text bold color="blue">Terminal</Text>
          <Terminal lines={lines} />
        </Box>
        <Box width={40} flexDirection="column" borderStyle="single" borderColor="green" paddingX={1}>
          <Text bold color="green">Files</Text>
          <FileView files={changedFiles} />
        </Box>
      </Box>

      <Box borderStyle="single" borderColor="yellow" paddingX={1} flexDirection="column" width="100%">
        {mode === "running" && <Timeline breadcrumb={breadcrumb} children={children} />}
        {mode === "prompt" && (
          <InputBox prefix="❯ " onSubmit={handlePromptSubmit} />
        )}
        {mode === "inject" && (
          <InputBox prefix="[msg] " onSubmit={handleInjectSubmit} onCancel={handleInjectCancel} />
        )}
        <Text color="gray">{statusLine}</Text>
      </Box>
    </Box>
  );
};

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { ChatClient } from "../../agent/core/chatClient";
import type { AgentTool, LogosCompleteParams } from "../../agent/core/types";
import { TaskTree, type TaskTreeEvent, type TaskNode, type ConversationTurn } from "../runtime/taskTree";
import { Terminal } from "./Terminal";
import { Timeline } from "./Timeline";
import { FileView } from "./FileView";
import { InputBox } from "./InputBox";
import { AcceptPanel } from "./AcceptPanel";
import { ContextBar } from "./ContextBar";
import { getWorkspaceDiff, getInlineDiffSummary, getIncrementalDiffSummary, takeWorkspaceSnapshot, type FileDiff, type WorkspaceSnapshot } from "../runtime/diffEngine";
import type { LogosClient } from "../../agent/runtime/logosClient";

import type { ManagedSession } from "../session/sessionManager";

interface AppProps {
  client: ChatClient;
  model: string;
  tools: AgentTool[];
  contextLimit: number;
  initialTask: string;
  onNodeComplete?: (node: TaskNode, params: LogosCompleteParams) => Promise<void>;
  onAccept?: (files: string[]) => Promise<void>;
  managedSession?: ManagedSession;
  logosClient?: LogosClient;
  sessionId?: string;
  initialCheckpointId?: string;
}

type Mode = "running" | "prompt" | "inject" | "abort_prompt" | "accept";
type FocusPanel = "terminal" | "files";

const WRITE_CMD_PATTERNS = /^\s*(sed\s+-i|perl\s+-[ip]|awk\s+-i|cat\s*>|tee\s|echo\s.*>|printf\s.*>|patch\b|git\s+apply|git\s+checkout|mv\s|cp\s|rm\s|mkdir\s|touch\s|chmod\s|chown\s|ln\s|install\s)/;
const HEREDOC_PATTERN = /<<['"]?\w*['"]?/;
const TARGETS_OUTSIDE_WORKSPACE = /(?:>|>>|cat\s*>\s*|tee\s+|mv\s+\S+\s+|cp\s+\S+\s+|touch\s+|mkdir\s+(?:-p\s+)?)\/(?:tmp|dev|proc|sys|var|etc)\//;

function isFileWriteCommand(cmd: string): boolean {
  if (TARGETS_OUTSIDE_WORKSPACE.test(cmd)) return false;
  const lines = cmd.split(/[;&\n|]/).map((s) => s.trim()).filter(Boolean);
  return lines.some((l) => WRITE_CMD_PATTERNS.test(l) || HEREDOC_PATTERN.test(l));
}

export const App: React.FC<AppProps> = ({ client, model, tools, contextLimit, initialTask, onNodeComplete, onAccept, managedSession, logosClient, sessionId, initialCheckpointId }) => {
  const { exit } = useApp();
  const [lines, setLines] = useState<string[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<string[]>([]);
  const [children, setChildren] = useState<Array<{ label: string; status: string }>>([]);
  const [changedFiles, setChangedFiles] = useState<FileDiff[]>([]);
  const [mode, setMode] = useState<Mode>("running");
  const [focusPanel, setFocusPanel] = useState<FocusPanel>("terminal");
  const [viewNodeId, setViewNodeId] = useState<string | null>(null);
  const [timelineSelIdx, setTimelineSelIdx] = useState(0);
  const [viewBreadcrumb, setViewBreadcrumb] = useState<string[]>([]);
  const [viewChildren, setViewChildren] = useState<Array<{ label: string; status: string }>>([]);
  const [contextUsage, setContextUsage] = useState<{ used: number; limit: number } | null>(null);
  const treeRef = useRef<TaskTree | null>(null);
  const conversationHistory = useRef<ConversationTurn[]>([]);
  const lastCheckpointRef = useRef<string>(initialCheckpointId ?? "");
  const jobCheckpointRef = useRef<string>(initialCheckpointId ?? "");
  const streamedToolCalls = useRef<Set<string>>(new Set());
  const pendingCommands = useRef<Map<string, string>>(new Map());
  const preExecSnapshots = useRef<Map<string, WorkspaceSnapshot>>(new Map());
  const lineBuffer = useRef<string[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sanitizeLine = (line: string): string => {
    let s = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    if (s.includes("\r")) {
      const parts = s.split("\r");
      s = parts[parts.length - 1];
    }
    return s;
  };

  const addLine = useCallback((line: string) => {
    lineBuffer.current.push(sanitizeLine(line));
    if (!flushTimer.current) {
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        const batch = lineBuffer.current;
        lineBuffer.current = [];
        if (batch.length > 0) {
          setLines((prev) => [...prev, ...batch]);
        }
      }, 60);
    }
  }, []);

  const addLines = useCallback((newLines: string[]) => {
    lineBuffer.current.push(...newLines.map(sanitizeLine));
    if (!flushTimer.current) {
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        const batch = lineBuffer.current;
        lineBuffer.current = [];
        if (batch.length > 0) {
          setLines((prev) => [...prev, ...batch]);
        }
      }, 60);
    }
  }, []);

  const wrappedOnNodeComplete = useCallback(async (node: TaskNode, params: LogosCompleteParams) => {
    if (onNodeComplete) {
      await onNodeComplete(node, params);
    }
    if (node.parentId === null && params.reply) {
      const last = conversationHistory.current[conversationHistory.current.length - 1];
      if (last?.role === "agent") {
        last.content = params.reply;
      } else {
        conversationHistory.current.push({ role: "agent", content: params.reply });
      }
    }
    if (node.checkpointPath) {
      const cpId = node.checkpointPath.split("/").pop() ?? "";
      if (cpId) {
        lastCheckpointRef.current = cpId;
        setChangedFiles([]);
      }
    }
  }, [onNodeComplete]);

  const startJob = useCallback(async (task: string) => {
    let projectState: string | undefined;
    if (logosClient) {
      try {
        const content = (await logosClient.exec("cat PROJECT_STATE.md 2>/dev/null || true")).stdout.trim();
        if (content) projectState = content;
      } catch {}
    }

    conversationHistory.current.push({ role: "user", content: task });

    const recentHistory = conversationHistory.current.slice(-6, -1);
    let synthesizedTask = task;
    if (recentHistory.length > 0) {
      const historyText = recentHistory.map((turn) =>
        turn.role === "user" ? `[User]: ${turn.content}` : `[Agent]: ${turn.content}`
      ).join("\n\n");
      synthesizedTask = `## Recent conversation context\n\n${historyText}\n\n## Current request\n\n${task}`;
    }

    const tree = new TaskTree({
      client,
      model,
      tools,
      originalTask: synthesizedTask,
      displayTask: task,
      maxTurnsPerAgent: 100,
      temperature: 0.2,
      contextLimit,
      kernelMode: true,
      sessionId,
      projectState,
      checkpointIndexUri: sessionId ? `logos://session/${sessionId}/checkpoints/index.json` : undefined,
      conversationHistory: conversationHistory.current.slice(-6),
      logosClient,
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
          setChildren(
            tree.getCurrentChildren().map((c) =>
              c.type === "node"
                ? { label: c.node.description, status: c.node.status }
                : { label: c.description, status: "pending" }
            )
          );
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
            if (re.toolName === "logos_exec") {
              pendingCommands.current.set(re.toolCallId, String(re.params.command ?? ""));
              const cmd = String(re.params.command ?? "");
              if (isFileWriteCommand(cmd) && logosClient && lastCheckpointRef.current) {
                takeWorkspaceSnapshot(logosClient, lastCheckpointRef.current).then((snap) => {
                  preExecSnapshots.current.set(re.toolCallId, snap);
                }).catch(() => {});
              }
            }
            const args = JSON.stringify(re.params);
            const preview = args.length > 200 ? args.slice(0, 200) + "…" : args;
            addLine(`  [${re.toolName}] ${preview}`);
          } else if (re.type === "tool_output_chunk") {
            streamedToolCalls.current.add(re.toolCallId);
            for (const l of re.chunk.split("\n")) {
              addLine(`  ${l}`);
            }
          } else if (re.type === "tool_execution_end" && re.toolName !== "logos_complete") {
            const cmd = pendingCommands.current.get(re.toolCallId) ?? "";
            pendingCommands.current.delete(re.toolCallId);
            const isWriteCommand = re.toolName === "logos_exec" && isFileWriteCommand(cmd);

            if (streamedToolCalls.current.has(re.toolCallId)) {
              streamedToolCalls.current.delete(re.toolCallId);
              const details = (re.result as any)?.details;
              if (details) {
                addLine(`  → exit_code: ${details.exit_code}`);
              }
            } else if (isWriteCommand && logosClient && sessionId && lastCheckpointRef.current) {
              const details = (re.result as any)?.details;
              if (details) {
                addLine(`  → exit_code: ${details.exit_code}`);
              }
              const beforeSnap = preExecSnapshots.current.get(re.toolCallId);
              preExecSnapshots.current.delete(re.toolCallId);
              const cpId = lastCheckpointRef.current;
              (beforeSnap
                ? takeWorkspaceSnapshot(logosClient, cpId).then((afterSnap) =>
                    getIncrementalDiffSummary(logosClient, cpId, beforeSnap, afterSnap))
                : getInlineDiffSummary(logosClient, sessionId, cpId)
              ).then((entries) => {
                if (entries.length === 0) return;
                const diffLines: string[] = [];
                for (const e of entries) {
                  const stats = e.additions || e.deletions ? ` (+${e.additions} -${e.deletions})` : "";
                  diffLines.push(`  → ${e.path}${stats}`);
                  for (const l of e.lines) {
                    diffLines.push(`    ${l}`);
                  }
                }
                addLines(diffLines);
              }).catch(() => {});
            } else {
              const text =
                typeof re.result === "object" && re.result !== null
                  ? ((re.result as any)?.content?.[0]?.text ?? "")
                  : String(re.result ?? "");
              const resultLines = text.split("\n");
              const maxResultLines = 30;
              if (resultLines.length > maxResultLines) {
                addLine(`  → [${resultLines.length} lines, showing last ${maxResultLines}]`);
                for (const l of resultLines.slice(-maxResultLines)) {
                  addLine(l);
                }
              } else {
                for (const l of resultLines) {
                  addLine(`  ${l}`);
                }
              }
            }
            if (logosClient && sessionId && lastCheckpointRef.current) {
              getWorkspaceDiff(logosClient, sessionId, jobCheckpointRef.current).then(setChangedFiles).catch(() => {});
            }
          } else if (re.type === "token_usage") {
            setContextUsage({ used: re.estimatedTokens, limit: re.limit });
          } else if (re.type === "logos_complete") {
            addLine(`  ✓ ${re.params.summary}`);
            if (re.params.reply) {
              addLine(`  💬 ${re.params.reply}`);
            }
          }
          break;
        }
      }
    };

    tree.on("event", handler);
    jobCheckpointRef.current = lastCheckpointRef.current;
    setMode("running");
    setBreadcrumb([task]);
    setChildren([]);
    setContextUsage(null);

    tree.run().then(async () => {
      tree.off("event", handler);
      treeRef.current = null;
      if (logosClient && sessionId && jobCheckpointRef.current) {
        try {
          const files = await getWorkspaceDiff(logosClient, sessionId, jobCheckpointRef.current);
          if (files.length > 0) {
            setChangedFiles(files);
            setMode("accept");
            addLine("");
            addLine("Job complete. Review and accept/reject changes.");
            return;
          }
        } catch {}
      }
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
        treeRef.current?.abort();
        setMode("abort_prompt");
        return;
      }
      if (key.tab) {
        setFocusPanel((p) => p === "terminal" ? "files" : "terminal");
        return;
      }
      if (key.leftArrow && focusPanel === "terminal") {
        const tree = treeRef.current;
        if (!tree) return;
        const currentViewId = viewNodeId ?? tree.current?.id ?? tree.root.id;
        const node = tree.getNode(currentViewId);
        if (node?.parentId) {
          const parent = tree.getNode(node.parentId);
          if (parent) {
            setViewNodeId(parent.id);
            setTimelineSelIdx(0);
            setViewBreadcrumb(tree.getAncestorChain(parent).map((n) => n.description));
            const kids = parent.children.map((c) => ({ label: c.description, status: c.status }));
            const pending = parent.pendingPlan.map((d) => ({ label: d, status: "pending" }));
            setViewChildren([...kids, ...pending]);
          }
        }
        return;
      }
      if (key.rightArrow && focusPanel === "terminal") {
        const tree = treeRef.current;
        if (!tree) return;
        const currentViewId = viewNodeId ?? tree.current?.id ?? tree.root.id;
        const node = tree.getNode(currentViewId);
        if (!node) return;
        const allKids = [...node.children];
        const target = allKids[timelineSelIdx];
        if (target && target.children.length > 0) {
          setViewNodeId(target.id);
          setTimelineSelIdx(0);
          setViewBreadcrumb(tree.getAncestorChain(target).map((n) => n.description));
          const kids = target.children.map((c) => ({ label: c.description, status: c.status }));
          const pending = target.pendingPlan.map((d) => ({ label: d, status: "pending" }));
          setViewChildren([...kids, ...pending]);
        }
        return;
      }
      if ((input === "h" || input === "l") && focusPanel === "terminal" && viewNodeId) {
        if (input === "h") {
          setTimelineSelIdx((i) => Math.max(0, i - 1));
        } else {
          setTimelineSelIdx((i) => Math.min((viewChildren.length || 1) - 1, i + 1));
        }
        return;
      }
      if (input === "q" && viewNodeId) {
        setViewNodeId(null);
        setTimelineSelIdx(0);
        return;
      }
      if (input === "r" && viewNodeId && managedSession) {
        const tree = treeRef.current;
        if (!tree) return;
        const currentViewId = viewNodeId;
        const node = tree.getNode(currentViewId);
        if (!node) return;
        const allKids = [...node.children];
        const target = allKids[timelineSelIdx];
        if (target?.checkpointPath) {
          const cpId = target.checkpointPath.split("/").pop();
          if (cpId) {
            addLine(`[rollback] rolling back to ${cpId}...`);
            managedSession.rollback(cpId).then(() => {
              lastCheckpointRef.current = cpId;
              setChangedFiles([]);
              setViewNodeId(null);
              setTimelineSelIdx(0);
              addLine(`[rollback] done. workspace restored to checkpoint ${cpId}`);
            }).catch((e) => {
              addLine(`[rollback] failed: ${e}`);
            });
          }
        }
        return;
      }
      if (input === "f" && viewNodeId && managedSession) {
        const tree = treeRef.current;
        if (!tree) return;
        const currentViewId = viewNodeId;
        const node = tree.getNode(currentViewId);
        if (!node) return;
        const allKids = [...node.children];
        const target = allKids[timelineSelIdx];
        if (target?.checkpointPath) {
          addLine(`[fork] forking session...`);
          managedSession.fork().then((newSid) => {
            addLine(`[fork] new session created: ${newSid}`);
            addLine(`[fork] switch to new session to continue from this checkpoint`);
          }).catch((e) => {
            addLine(`[fork] failed: ${e}`);
          });
        }
        return;
      }
      if (input === "i") {
        setMode("inject");
        return;
      }
    }
  }, { isActive: mode === "running" });

  const handleAbortSubmit = useCallback((instruction: string) => {
    const msg = instruction.trim() || "User interrupted, please reconsider the approach";
    addLine(`[abort] ${msg}`);
    treeRef.current?.abort(msg);
    treeRef.current?.resumeAfterAbort();
    setMode("running");
  }, [addLine]);

  const handleAbortCancel = useCallback(() => {
    addLine("[abort] (cancelled, resuming with default instruction)");
    treeRef.current?.abort("User pressed ESC");
    treeRef.current?.resumeAfterAbort();
    setMode("running");
  }, [addLine]);

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

  const handleAcceptFiles = useCallback(async (files: string[]) => {
    if (onAccept) {
      addLine(`[accept] syncing ${files.length} file(s)...`);
      try {
        await onAccept(files);
        addLine("[accept] done");
      } catch (e) {
        addLine(`[accept] error: ${e}`);
      }
    }
    setMode("prompt");
    addLine("");
    addLine("Ready for next task. Type your prompt and press Enter. (Ctrl+C to quit)");
  }, [onAccept, addLine]);

  const handleRejectFiles = useCallback(() => {
    addLine("[reject] changes kept in workspace but not synced");
    setMode("prompt");
    addLine("");
    addLine("Ready for next task. Type your prompt and press Enter. (Ctrl+C to quit)");
  }, [addLine]);

  const statusLine = (() => {
    switch (mode) {
      case "running":
        return viewNodeId
          ? "←→ navigate | h/l select | r rollback | f fork | q back to live"
          : "ESC: abort | i: inject | Tab: switch panel | ←→ browse tree | Ctrl+C: quit";
      case "abort_prompt":
        return "Type abort instruction (Enter to send, ESC for default)";
      case "inject":
        return "Type message, Enter to send, ESC to cancel";
      case "accept":
        return "";
      case "prompt":
        return "Enter task, Ctrl+C to quit";
    }
  })();

  return (
    <Box flexDirection="column" width="100%">
      <Box flexGrow={1} flexDirection="row">
        <Box flexGrow={1} flexDirection="column" borderStyle="single" borderColor={focusPanel === "terminal" ? "blue" : "gray"} paddingX={1}>
          <Text bold color={focusPanel === "terminal" ? "blue" : "gray"}>Terminal</Text>
          <Terminal lines={lines} isActive={mode === "running" && focusPanel === "terminal"} />
        </Box>
        <Box width={40} flexDirection="column" borderStyle="single" borderColor={focusPanel === "files" ? "green" : "gray"} paddingX={1}>
          <Text bold color={focusPanel === "files" ? "green" : "gray"}>Files</Text>
          <FileView files={changedFiles} isActive={mode === "running" && focusPanel === "files"} logosClient={logosClient} checkpointId={jobCheckpointRef.current || undefined} />
        </Box>
      </Box>

      <Box borderStyle="single" borderColor="yellow" paddingX={1} flexDirection="column" width="100%">
        {mode === "accept" ? (
          <AcceptPanel
            files={changedFiles}
            logosClient={logosClient}
            checkpointId={jobCheckpointRef.current || undefined}
            onAccept={handleAcceptFiles}
            onReject={handleRejectFiles}
          />
        ) : (
          <>
            {(mode === "running" || mode === "abort_prompt") && (
              viewNodeId
                ? <Timeline breadcrumb={viewBreadcrumb} children={viewChildren} selectedIndex={timelineSelIdx} isNavigating={true} />
                : <Timeline breadcrumb={breadcrumb} children={children} />
            )}
            {mode === "prompt" && (
              <InputBox prefix="❯ " onSubmit={handlePromptSubmit} />
            )}
            {mode === "inject" && (
              <InputBox prefix="[msg] " onSubmit={handleInjectSubmit} onCancel={handleInjectCancel} />
            )}
            {mode === "abort_prompt" && (
              <InputBox prefix="[abort instruction] " onSubmit={handleAbortSubmit} onCancel={handleAbortCancel} />
            )}
            {mode === "running" && contextUsage && (
              <ContextBar used={contextUsage.used} limit={contextUsage.limit} />
            )}
            {statusLine && <Text color="gray">{statusLine}</Text>}
          </>
        )}
      </Box>
    </Box>
  );
};

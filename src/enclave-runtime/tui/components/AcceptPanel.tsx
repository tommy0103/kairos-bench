import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { FileDiff } from "../runtime/diffEngine";
import { getFileDiffContent } from "../runtime/diffEngine";
import type { LogosClient } from "../../agent/runtime/logosClient";

interface AcceptPanelProps {
  files: FileDiff[];
  logosClient?: LogosClient;
  checkpointId?: string;
  onAccept: (acceptedFiles: string[]) => void;
  onReject: () => void;
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  added: { icon: "A", color: "green" },
  modified: { icon: "M", color: "yellow" },
  deleted: { icon: "D", color: "red" },
};

export const AcceptPanel: React.FC<AcceptPanelProps> = React.memo(({ files, logosClient, checkpointId, onAccept, onReject }) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [accepted, setAccepted] = useState<Set<string>>(() => new Set(files.map((f) => f.path)));
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [diffLines, setDiffLines] = useState<string[]>([]);

  const toggleFile = useCallback((index: number) => {
    const file = files[index];
    if (!file) return;
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(file.path)) next.delete(file.path);
      else next.add(file.path);
      return next;
    });
  }, [files]);

  const toggleExpand = useCallback((index: number) => {
    if (expandedIndex === index) {
      setExpandedIndex(null);
      setDiffLines([]);
      return;
    }
    const file = files[index];
    if (!file || !logosClient || !checkpointId) return;
    setExpandedIndex(index);
    getFileDiffContent(logosClient, checkpointId, file.path, file.status).then((lines) => {
      setDiffLines(lines);
    }).catch(() => {
      setDiffLines(["(error loading diff)"]);
    });
  }, [expandedIndex, files, logosClient, checkpointId]);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(files.length - 1, i + 1));
    } else if (input === " ") {
      toggleFile(selectedIndex);
    } else if (input === "d" || input === "D") {
      toggleExpand(selectedIndex);
    } else if (input === "a" || input === "A") {
      onAccept(Array.from(accepted));
    } else if (input === "r" || input === "R") {
      onReject();
    } else if (input === "s" || input === "S") {
      setAccepted(new Set(files.map((f) => f.path)));
    } else if (input === "n" || input === "N") {
      setAccepted(new Set());
    }
  });

  if (files.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No changes to accept.</Text>
      </Box>
    );
  }

  const acceptedCount = files.filter((f) => accepted.has(f.path)).length;

  return (
    <Box flexDirection="column">
      <Text bold color="yellow">Accept changes ({acceptedCount}/{files.length} selected)</Text>
      <Text color="gray">Space: toggle  S: select all  N: select none  D: diff  A: accept  R: reject</Text>
      <Box flexDirection="column" marginTop={1}>
        {files.map((file, i) => {
          const { icon, color } = STATUS_ICONS[file.status] ?? { icon: "?", color: "white" };
          const isAccepted = accepted.has(file.path);
          const checkbox = isAccepted ? "☑" : "☐";
          const stats = file.additions || file.deletions
            ? ` +${file.additions} -${file.deletions}`
            : "";
          const selected = i === selectedIndex;
          return (
            <Box key={i} flexDirection="column">
              <Text wrap="truncate" inverse={selected}>
                <Text color={isAccepted ? "green" : "gray"}>{checkbox} </Text>
                <Text color={color}>{icon} </Text>
                <Text>{file.path}</Text>
                {stats && <Text color="gray">{stats}</Text>}
              </Text>
              {i === expandedIndex && (
                <Box flexDirection="column" paddingLeft={4}>
                  {diffLines.map((line, j) => {
                    let lineColor = "white";
                    if (line.startsWith("+")) lineColor = "green";
                    else if (line.startsWith("-")) lineColor = "red";
                    else if (line.startsWith("@@")) lineColor = "cyan";
                    return <Text key={j} color={lineColor} wrap="truncate">{line}</Text>;
                  })}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
});

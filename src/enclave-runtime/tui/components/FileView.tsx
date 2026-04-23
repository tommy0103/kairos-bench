import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { FileDiff } from "../runtime/diffEngine";
import { getFileDiffContent } from "../runtime/diffEngine";
import type { LogosClient } from "../../agent/runtime/logosClient";

interface FileViewProps {
  files: FileDiff[];
  isActive: boolean;
  logosClient?: LogosClient;
  checkpointId?: string;
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  added: { icon: "A", color: "green" },
  modified: { icon: "M", color: "yellow" },
  deleted: { icon: "D", color: "red" },
};

export const FileView: React.FC<FileViewProps> = React.memo(({ files, isActive, logosClient, checkpointId }) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [diffLines, setDiffLines] = useState<string[]>([]);
  const [loadingDiff, setLoadingDiff] = useState(false);

  useEffect(() => {
    if (selectedIndex >= files.length) {
      setSelectedIndex(Math.max(0, files.length - 1));
    }
  }, [files.length]);

  useEffect(() => {
    setExpandedIndex(null);
    setDiffLines([]);
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
    setLoadingDiff(true);
    getFileDiffContent(logosClient, checkpointId, file.path, file.status).then((lines) => {
      setDiffLines(lines);
      setLoadingDiff(false);
    }).catch(() => {
      setDiffLines(["(error loading diff)"]);
      setLoadingDiff(false);
    });
  }, [expandedIndex, files, logosClient, checkpointId]);

  useInput((input, key) => {
    if (files.length === 0) return;
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(files.length - 1, i + 1));
    } else if (input === "d" || input === "D") {
      toggleExpand(selectedIndex);
    }
  }, { isActive });

  if (files.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray" italic>No changes yet</Text>
      </Box>
    );
  }

  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);

  return (
    <Box flexDirection="column">
      {files.map((file, i) => {
        const { icon, color } = STATUS_ICONS[file.status] ?? { icon: "?", color: "white" };
        const stats = file.additions || file.deletions
          ? ` +${file.additions} -${file.deletions}`
          : "";
        const selected = i === selectedIndex && isActive;
        return (
          <Box key={i} flexDirection="column">
            <Text wrap="truncate" inverse={selected}>
              <Text color={color}>{icon} </Text>
              <Text>{file.path}</Text>
              {stats && <Text color="gray">{stats}</Text>}
              {i === expandedIndex && <Text color="gray"> ▾</Text>}
            </Text>
            {i === expandedIndex && (
              <Box flexDirection="column" paddingLeft={2}>
                {loadingDiff ? (
                  <Text color="gray">loading...</Text>
                ) : (
                  diffLines.map((line, j) => {
                    let lineColor = "white";
                    if (line.startsWith("+")) lineColor = "green";
                    else if (line.startsWith("-")) lineColor = "red";
                    else if (line.startsWith("@@")) lineColor = "cyan";
                    return <Text key={j} color={lineColor} wrap="truncate">{line}</Text>;
                  })
                )}
              </Box>
            )}
          </Box>
        );
      })}
      <Text color="gray">
        {files.length} file(s) <Text color="green">+{totalAdd}</Text> <Text color="red">-{totalDel}</Text>
      </Text>
      {isActive && <Text color="gray" dimColor>↑↓ select  D expand</Text>}
    </Box>
  );
});

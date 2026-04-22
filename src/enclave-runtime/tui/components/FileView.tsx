import React from "react";
import { Box, Text } from "ink";
import type { FileDiff } from "../runtime/diffEngine";

interface FileViewProps {
  files: FileDiff[];
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  added: { icon: "A", color: "green" },
  modified: { icon: "M", color: "yellow" },
  deleted: { icon: "D", color: "red" },
};

export const FileView: React.FC<FileViewProps> = React.memo(({ files }) => {
  if (files.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray" italic>No changes yet</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {files.map((file, i) => {
        const { icon, color } = STATUS_ICONS[file.status] ?? { icon: "?", color: "white" };
        const stats = file.additions || file.deletions
          ? ` +${file.additions} -${file.deletions}`
          : "";
        return (
          <Text key={i} wrap="truncate">
            <Text color={color}>{icon} </Text>
            <Text>{file.path}</Text>
            {stats && <Text color="gray">{stats}</Text>}
          </Text>
        );
      })}
      <Text color="gray">{files.length} file(s) changed</Text>
    </Box>
  );
});

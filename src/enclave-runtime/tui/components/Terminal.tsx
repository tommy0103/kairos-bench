import React from "react";
import { Box, Text } from "ink";

interface TerminalProps {
  lines: string[];
  maxVisible?: number;
}

export const Terminal: React.FC<TerminalProps> = React.memo(({ lines, maxVisible = 30 }) => {
  const visible = lines.slice(-maxVisible);
  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((line, i) => {
        let color: string | undefined;
        if (line.startsWith("  →")) color = "gray";
        else if (line.startsWith("  ✓")) color = "green";
        else if (line.startsWith("  [")) color = "cyan";
        else if (line.startsWith("▶")) color = "yellow";
        else if (line.startsWith("~")) color = "magenta";
        else if (line.startsWith("[ESC]") || line.startsWith("[user]")) color = "red";

        return (
          <Text key={i} color={color} wrap="truncate">
            {line}
          </Text>
        );
      })}
    </Box>
  );
});

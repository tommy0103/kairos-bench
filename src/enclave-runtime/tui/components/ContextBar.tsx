import React from "react";
import { Box, Text, useStdout } from "ink";

interface ContextBarProps {
  used: number;
  limit: number;
}

export const ContextBar: React.FC<ContextBarProps> = React.memo(({ used, limit }) => {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 120;

  const ratio = Math.min(used / limit, 1);
  const pct = Math.round(ratio * 100);

  const label = "Context ";
  const stats = ` ${String(pct).padStart(3)}%  ${formatTokens(used)} / ${formatTokens(limit)} tokens`;
  const chrome = label.length + stats.length + 2;
  const barWidth = Math.min(Math.max(width - chrome, 8), 30);

  const filled = Math.round(barWidth * ratio);
  const empty = barWidth - filled;

  const color = ratio < 0.6 ? "green" : ratio < 0.8 ? "yellow" : "red";

  return (
    <Box>
      <Text bold>Context </Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text color="gray" dimColor>{"░".repeat(empty)}</Text>
      <Text bold color={color}> {pct}%</Text>
      <Text color="gray">  {formatTokens(used)} / {formatTokens(limit)} tokens</Text>
    </Box>
  );
});

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

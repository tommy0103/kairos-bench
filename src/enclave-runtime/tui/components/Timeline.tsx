import React from "react";
import { Box, Text } from "ink";

interface TimelineProps {
  breadcrumb: string[];
  children: Array<{ label: string; status: string }>;
}

const STATUS_ICONS: Record<string, string> = {
  completed: "✓",
  running: "▶",
  aborted: "⚠",
  failed: "✗",
  pending: "_",
};

const STATUS_COLORS: Record<string, string> = {
  completed: "green",
  running: "yellow",
  aborted: "red",
  failed: "red",
  pending: "gray",
};

function truncateBreadcrumb(parts: string[], maxWidth: number): string[] {
  const full = parts.join(" > ");
  if (full.length <= maxWidth) return parts;
  if (parts.length <= 2) return parts;
  const first = parts[0];
  const last2 = parts.slice(-2);
  const truncated = [first, "...", ...last2];
  return truncated;
}

export const Timeline: React.FC<TimelineProps> = React.memo(({ breadcrumb, children }) => {
  const crumbs = truncateBreadcrumb(
    breadcrumb.map((s) => (s.length > 30 ? s.slice(0, 30) + "…" : s)),
    80,
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="yellow" bold>
          {crumbs.join(" > ")}
        </Text>
      </Box>
      <Box gap={1} flexWrap="wrap">
        {children.map((child, i) => {
          const icon = STATUS_ICONS[child.status] ?? "?";
          const color = STATUS_COLORS[child.status] ?? "white";
          const label = child.label.length > 25 ? child.label.slice(0, 25) + "…" : child.label;
          return (
            <Text key={i}>
              <Text color={color}>[{icon}</Text>
              <Text> {label}</Text>
              <Text color={color}>]</Text>
            </Text>
          );
        })}
      </Box>
    </Box>
  );
});

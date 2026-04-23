import React from "react";
import { Box, Text, useStdout } from "ink";

interface TimelineProps {
  breadcrumb: string[];
  children: Array<{ label: string; status: string }>;
  selectedIndex?: number;
  isNavigating?: boolean;
}

const STATUS_ICONS: Record<string, string> = {
  completed: "✓",
  running: "▶",
  aborted: "⚠",
  failed: "✗",
  pending: "·",
};

const STATUS_COLORS: Record<string, string> = {
  completed: "green",
  running: "yellow",
  aborted: "red",
  failed: "red",
  pending: "gray",
};

const CRUMB_MAX = 30;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function buildBreadcrumb(parts: string[], maxWidth: number): string {
  const truncated = parts.map((p) => truncate(p, CRUMB_MAX));
  const full = truncated.join(" › ");
  if (full.length <= maxWidth) return full;
  if (parts.length <= 2) return truncated.join(" › ");
  const first = truncated[0];
  const last = truncated[truncated.length - 1];
  return `${first} › … › ${last}`;
}

export const Timeline: React.FC<TimelineProps> = React.memo(({ breadcrumb, children, selectedIndex, isNavigating }) => {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 120;
  const crumbStr = buildBreadcrumb(breadcrumb, width - 20);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="yellow" bold wrap="truncate">{crumbStr}</Text>
        {isNavigating && <Text color="gray" dimColor> (←→)</Text>}
      </Box>
      <Box flexDirection="column" marginLeft={1}>
        {children.map((child, i) => {
          const icon = STATUS_ICONS[child.status] ?? "?";
          const color = STATUS_COLORS[child.status] ?? "white";
          const selected = isNavigating && i === selectedIndex;
          const isLast = i === children.length - 1;
          const branch = isLast ? "└─" : "├─";
          return (
            <Box key={i}>
              <Text color="gray" dimColor>{branch}</Text>
              <Text inverse={selected} wrap="wrap">
                <Text color={color}>{icon} </Text>
                <Text>{child.label}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
});

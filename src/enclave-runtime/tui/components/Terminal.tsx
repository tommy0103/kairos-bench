import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput, useStdout } from "ink";

interface TerminalProps {
  lines: string[];
  isActive?: boolean;
}

function colorForLine(line: string): string | undefined {
  if (line.startsWith("  →")) return "gray";
  if (line.startsWith("  ✓")) return "green";
  if (line.startsWith("  💬")) return "white";
  if (line.startsWith("  [")) return "cyan";
  if (line.startsWith("▶")) return "yellow";
  if (line.startsWith("~")) return "magenta";
  if (line.startsWith("[ESC]") || line.startsWith("[user]")) return "red";
  return undefined;
}

export const Terminal: React.FC<TerminalProps> = React.memo(({ lines, isActive = true }) => {
  const { stdout } = useStdout();
  const visibleRows = (stdout?.rows ?? 24) - 8;
  const [scrollOffset, setScrollOffset] = useState(0);
  const isFollowing = useRef(true);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const visibleRowsRef = useRef(visibleRows);
  visibleRowsRef.current = visibleRows;

  useEffect(() => {
    if (isFollowing.current) {
      setScrollOffset(Math.max(0, lines.length - visibleRows));
    }
  }, [lines.length, visibleRows]);

  useInput((input, key) => {
    if (key.upArrow) {
      isFollowing.current = false;
      setScrollOffset((o) => Math.max(0, o - 1));
    } else if (key.downArrow) {
      setScrollOffset((o) => {
        const maxOffset = Math.max(0, linesRef.current.length - visibleRowsRef.current);
        const next = Math.min(maxOffset, o + 1);
        if (next >= maxOffset) isFollowing.current = true;
        return next;
      });
    } else if (key.pageUp) {
      isFollowing.current = false;
      setScrollOffset((o) => Math.max(0, o - (visibleRowsRef.current - 2)));
    } else if (key.pageDown) {
      setScrollOffset((o) => {
        const maxOffset = Math.max(0, linesRef.current.length - visibleRowsRef.current);
        const next = Math.min(maxOffset, o + (visibleRowsRef.current - 2));
        if (next >= maxOffset) isFollowing.current = true;
        return next;
      });
    } else if (input === "G") {
      isFollowing.current = true;
      setScrollOffset(Math.max(0, lines.length - visibleRows));
    }
  }, { isActive });

  const visible = lines.slice(scrollOffset, scrollOffset + visibleRows);
  const atBottom = isFollowing.current;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((line, i) => {
        return (
          <Text key={scrollOffset + i} color={colorForLine(line)} wrap="wrap">
            {line}
          </Text>
        );
      })}
      {!atBottom && (
        <Text color="gray" dimColor>↓ {lines.length - scrollOffset - visibleRows} more lines (↑↓ PgUp/PgDn scroll, G to follow)</Text>
      )}
    </Box>
  );
});

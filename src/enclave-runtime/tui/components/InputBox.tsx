import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface InputBoxProps {
  prefix: string;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
}

export const InputBox: React.FC<InputBoxProps> = React.memo(({ prefix, onSubmit, onCancel }) => {
  const [buffer, setBuffer] = useState("");
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.escape && onCancel) {
      onCancel();
      return;
    }
    if (key.return) {
      if (buffer.trim()) {
        onSubmit(buffer.trim());
      }
      setBuffer("");
      setCursor(0);
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(buffer.length, c + 1));
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setBuffer((b) => b.slice(0, cursor - 1) + b.slice(cursor));
        setCursor((c) => c - 1);
      }
      return;
    }
    if (input) {
      const clean = input.replace(/[\n\r]/g, " ");
      setBuffer((b) => b.slice(0, cursor) + clean + b.slice(cursor));
      setCursor((c) => c + clean.length);
    }
  });

  return (
    <Box>
      <Text wrap="wrap">
        <Text color="cyan">{prefix}</Text>
        {buffer.slice(0, cursor)}
        <Text inverse>{buffer[cursor] ?? " "}</Text>
        {buffer.slice(cursor + 1)}
      </Text>
    </Box>
  );
});

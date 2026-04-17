/**
 * Missing spec supplements — factual information that SHOULD have been in the
 * task description but was omitted.
 *
 * These are NOT strategic hints or implementation guidance (that's agentSkills).
 * These are objective, verifiable facts that the task author forgot to mention
 * and that the agent cannot reasonably discover on its own.
 *
 * Only activated when trigger keywords match the task description.
 */

export interface MissingSpec {
  id: string;
  name: string;
  /** Any of these keyword groups triggers the spec (OR of ANDs). */
  triggers: string[][];
  /** Factual supplement appended to the task description. */
  spec: string;
}

export const MISSING_SPECS: MissingSpec[] = [
  {
    id: "win311-boot-sequence",
    name: "Windows 3.11 boot sequence",
    triggers: [
      ["windows 3.11", "qemu"],
      ["win311", "qemu"],
      ["windows 3.1", "qemu"],
    ],
    spec:
      "NOTE: The win311.img disk boots into MS-DOS, not directly into Windows. " +
      "After QEMU starts, you must send the keystrokes `win` followed by Enter " +
      "via the QEMU monitor (e.g. `sendkey w`, `sendkey i`, `sendkey n`, `sendkey ret`) " +
      "to launch the Windows 3.11 graphical desktop. The VM is not ready until " +
      "the Windows GUI is visible — allow ~10 seconds after sending `win` for it to load. " +
      "IMPORTANT: The QEMU monitor MUST be configured as a UNIX socket at `/tmp/qemu-monitor.sock` " +
      "using `-monitor unix:/tmp/qemu-monitor.sock,server,nowait`. Do NOT use telnet or TCP for the monitor.",
  },
];

export function detectMissingSpecs(taskText: string): MissingSpec[] {
  const lower = taskText.toLowerCase();
  return MISSING_SPECS.filter((spec) =>
    spec.triggers.some((group) => group.every((kw) => lower.includes(kw)))
  );
}

export function buildMissingSpecSection(taskText: string): string {
  const matched = detectMissingSpecs(taskText);
  if (matched.length === 0) return "";
  const sections = matched.map((s) => s.spec).join("\n\n");
  return `\n\n## Additional task information\n\n${sections}`;
}

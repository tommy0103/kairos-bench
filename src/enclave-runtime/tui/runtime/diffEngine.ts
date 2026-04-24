import type { LogosClient } from "../../agent/runtime/logosClient";

export interface FileDiff {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
}

export interface InlineDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  lines: string[];
}

const MAX_INLINE_LINES_PER_FILE = 8;
const MAX_INLINE_FILES = 5;

export async function getInlineDiffSummary(
  client: LogosClient,
  sessionId: string,
  lastCheckpointId: string,
): Promise<InlineDiffEntry[]> {
  const diffs = await getWorkspaceDiff(client, sessionId, lastCheckpointId);
  if (diffs.length === 0) return [];

  const entries: InlineDiffEntry[] = [];
  const snapshotRelative = `../checkpoints/${lastCheckpointId}/snapshot`;

  for (const d of diffs.slice(0, MAX_INLINE_FILES)) {
    const entry: InlineDiffEntry = { ...d, lines: [] };
    try {
      if (d.status === "modified") {
        const result = await client.exec(
          `diff --unified=1 "${snapshotRelative}/${d.path}" "./${d.path}" 2>/dev/null | grep '^[+-]' | grep -v '^[+-][+-][+-]' | head -${MAX_INLINE_LINES_PER_FILE}`
        );
        entry.lines = result.stdout.split("\n").filter(Boolean);
      } else if (d.status === "added") {
        const result = await client.exec(
          `head -${MAX_INLINE_LINES_PER_FILE} "./${d.path}" 2>/dev/null`
        );
        entry.lines = result.stdout.split("\n").filter(Boolean).map((l) => `+${l}`);
      } else if (d.status === "deleted") {
        entry.lines = [`(file deleted)`];
      }
    } catch {}
    entries.push(entry);
  }

  if (diffs.length > MAX_INLINE_FILES) {
    entries.push({
      path: `... and ${diffs.length - MAX_INLINE_FILES} more files`,
      status: "modified",
      additions: 0,
      deletions: 0,
      lines: [],
    });
  }

  return entries;
}

export type WorkspaceSnapshot = Map<string, { status: string; mtime: string }>;

export async function takeWorkspaceSnapshot(
  client: LogosClient,
  lastCheckpointId: string,
): Promise<WorkspaceSnapshot> {
  const snap: WorkspaceSnapshot = new Map();
  try {
    const snapshotRelative = `../checkpoints/${lastCheckpointId}/snapshot`;
    const result = await client.exec(
      `diff -rq ${snapshotRelative} . --exclude='.logos' --exclude='.git' --exclude='node_modules' --exclude='*.tsbuildinfo' --exclude='.DS_Store' --exclude='*.pyc' --exclude='__pycache__' --exclude='.next' --exclude='dist' --exclude='.turbo' --exclude='*.lock' --exclude='bun.lock' --exclude='coverage' 2>/dev/null | grep -v '/node_modules/\\|/\\.git/\\|/coverage/\\|/\\.next/\\|/dist/\\|\\.tsbuildinfo' | head -200; echo "---SNAP_END---"`
    );
    const lines = result.stdout.split("\n").filter((l) => l && l !== "---SNAP_END---");
    for (const line of lines) {
      if (line.startsWith("Only in .")) {
        const match = line.match(/^Only in \.\/?(.*):\s*(.+)$/);
        if (match) {
          const dir = match[1] ? match[1] + "/" : "";
          snap.set(dir + match[2], { status: "added", mtime: "" });
        }
      } else if (line.includes(`Only in ${snapshotRelative}`)) {
        const regex = new RegExp(`^Only in ${snapshotRelative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/?(.*):\\s*(.+)$`);
        const match = line.match(regex);
        if (match) {
          const dir = match[1] ? match[1] + "/" : "";
          snap.set(dir + match[2], { status: "deleted", mtime: "" });
        }
      } else if (line.startsWith("Files ")) {
        const match = line.match(/^Files .+ and \.\/?(.+) differ$/);
        if (match) {
          snap.set(match[1], { status: "modified", mtime: "" });
        }
      }
    }
  } catch {}
  return snap;
}

export function diffSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): FileDiff[] {
  const diffs: FileDiff[] = [];
  for (const [path, info] of after) {
    const prev = before.get(path);
    if (!prev) {
      diffs.push({ path, status: info.status as FileDiff["status"], additions: 0, deletions: 0 });
    } else if (prev.status !== info.status) {
      diffs.push({ path, status: info.status as FileDiff["status"], additions: 0, deletions: 0 });
    }
  }
  return diffs;
}

export async function getIncrementalDiffSummary(
  client: LogosClient,
  lastCheckpointId: string,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): Promise<InlineDiffEntry[]> {
  const changed = diffSnapshots(before, after);
  if (changed.length === 0) return [];

  const entries: InlineDiffEntry[] = [];
  const snapshotRelative = `../checkpoints/${lastCheckpointId}/snapshot`;

  for (const d of changed.slice(0, MAX_INLINE_FILES)) {
    const entry: InlineDiffEntry = { ...d, lines: [] };
    try {
      if (d.status === "modified") {
        const result = await client.exec(
          `diff --unified=1 "${snapshotRelative}/${d.path}" "./${d.path}" 2>/dev/null | grep '^[+-]' | grep -v '^[+-][+-][+-]' | head -${MAX_INLINE_LINES_PER_FILE}`
        );
        entry.lines = result.stdout.split("\n").filter(Boolean);
      } else if (d.status === "added") {
        const result = await client.exec(
          `head -${MAX_INLINE_LINES_PER_FILE} "./${d.path}" 2>/dev/null`
        );
        entry.lines = result.stdout.split("\n").filter(Boolean).map((l) => `+${l}`);
      } else if (d.status === "deleted") {
        entry.lines = [`(file deleted)`];
      }
    } catch {}
    entries.push(entry);
  }

  if (changed.length > MAX_INLINE_FILES) {
    entries.push({
      path: `... and ${changed.length - MAX_INLINE_FILES} more files`,
      status: "modified",
      additions: 0,
      deletions: 0,
      lines: [],
    });
  }

  return entries;
}

const MAX_DIFF_LINES = 60;

export async function getFileDiffContent(
  client: LogosClient,
  lastCheckpointId: string,
  filePath: string,
  fileStatus: string,
): Promise<string[]> {
  const snapshotRelative = `../checkpoints/${lastCheckpointId}/snapshot`;
  try {
    if (fileStatus === "added") {
      const result = await client.exec(
        `head -${MAX_DIFF_LINES} "./${filePath}" 2>/dev/null`
      );
      return result.stdout.split("\n").filter(Boolean).map((l) => `+${l}`);
    } else if (fileStatus === "deleted") {
      const result = await client.exec(
        `head -${MAX_DIFF_LINES} "${snapshotRelative}/${filePath}" 2>/dev/null`
      );
      return result.stdout.split("\n").filter(Boolean).map((l) => `-${l}`);
    } else {
      const result = await client.exec(
        `diff --unified=3 "${snapshotRelative}/${filePath}" "./${filePath}" 2>/dev/null | head -${MAX_DIFF_LINES}`
      );
      return result.stdout.split("\n");
    }
  } catch {
    return ["(unable to read diff)"];
  }
}

export async function getWorkspaceDiff(
  client: LogosClient,
  sessionId: string,
  lastCheckpointId: string,
): Promise<FileDiff[]> {
  try {
    const snapshotRelative = `../checkpoints/${lastCheckpointId}/snapshot`;
    const result = await client.exec(
      `diff -rq ${snapshotRelative} . --exclude='.logos' --exclude='.git' --exclude='node_modules' --exclude='*.tsbuildinfo' --exclude='.DS_Store' --exclude='*.pyc' --exclude='__pycache__' --exclude='.next' --exclude='dist' --exclude='.turbo' --exclude='*.lock' --exclude='bun.lock' --exclude='coverage' 2>/dev/null | grep -v '/node_modules/\\|/\\.git/\\|/coverage/\\|/\\.next/\\|/dist/\\|\\.tsbuildinfo' | head -100; echo "---DIFF_END---"`
    );

    const lines = result.stdout.split("\n").filter((l) => l && l !== "---DIFF_END---");
    const diffs: FileDiff[] = [];

    for (const line of lines) {
      if (line.startsWith("Only in .")) {
        const match = line.match(/^Only in \.\/?(.*):\s*(.+)$/);
        if (match) {
          const dir = match[1] ? match[1] + "/" : "";
          diffs.push({ path: dir + match[2], status: "added", additions: 0, deletions: 0 });
        }
      } else if (line.includes(`Only in ${snapshotRelative}`)) {
        const regex = new RegExp(`^Only in ${snapshotRelative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/?(.*):\\s*(.+)$`);
        const match = line.match(regex);
        if (match) {
          const dir = match[1] ? match[1] + "/" : "";
          diffs.push({ path: dir + match[2], status: "deleted", additions: 0, deletions: 0 });
        }
      } else if (line.startsWith("Files ")) {
        const match = line.match(/^Files .+ and \.\/?(.+) differ$/);
        if (match) {
          diffs.push({ path: match[1], status: "modified", additions: 0, deletions: 0 });
        }
      }
    }

    if (diffs.length > 0) {
      const toCheck = diffs.filter((d) => d.status === "added" || d.status === "deleted");
      if (toCheck.length > 0) {
        const checkPaths = toCheck.map((d) => {
          const base = d.status === "deleted" ? snapshotRelative : ".";
          return `"${base}/${d.path}"`;
        });
        try {
          const isFileResult = await client.exec(
            `for p in ${checkPaths.join(" ")}; do [ -f "$p" ] && echo "F:$p" || echo "D:$p"; done`
          );
          const dirs = new Set<string>();
          for (const line of isFileResult.stdout.split("\n")) {
            if (line.startsWith("D:")) {
              const p = line.slice(2).replace(/^\.\//, "").replace(new RegExp(`^${snapshotRelative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), "");
              dirs.add(p);
            }
          }
          for (let i = diffs.length - 1; i >= 0; i--) {
            if (dirs.has(diffs[i].path)) {
              diffs.splice(i, 1);
            }
          }
        } catch {}
      }

      const modified = diffs.filter((d) => d.status === "modified");
      if (modified.length > 0) {
        const statResult = await client.exec(
          `for f in ${modified.map((d) => `"${d.path}"`).join(" ")}; do ` +
          `diff --unified=0 "${snapshotRelative}/$f" "./$f" 2>/dev/null | ` +
          `awk 'BEGIN{a=0;d=0} /^[+][^+]/{a++} /^[-][^-]/{d++} END{print FILENAME":"a":"d}' FILENAME="$f"; done 2>/dev/null`
        );
        for (const line of statResult.stdout.split("\n")) {
          const match = line.match(/^(.+):(\d+):(\d+)$/);
          if (match) {
            const d = diffs.find((d) => d.path === match[1]);
            if (d) {
              d.additions = parseInt(match[2]) || 0;
              d.deletions = parseInt(match[3]) || 0;
            }
          }
        }
      }

      for (const d of diffs) {
        if (d.status === "added") {
          try {
            const wc = await client.exec(`wc -l < "${d.path}" 2>/dev/null || echo 0`);
            d.additions = parseInt(wc.stdout.trim()) || 0;
          } catch {}
        }
      }
    }

    return diffs;
  } catch {
    return [];
  }
}

import type { LogosClient } from "../../agent/runtime/logosClient";

export interface FileDiff {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
}

export async function getWorkspaceDiff(
  client: LogosClient,
  sessionId: string,
  lastCheckpointId: string,
): Promise<FileDiff[]> {
  try {
    const snapshotRelative = `../checkpoints/${lastCheckpointId}/snapshot`;
    const result = await client.exec(
      `diff -rq ${snapshotRelative} . --exclude='.logos' 2>/dev/null | head -100; echo "---DIFF_END---"`
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
      const modified = diffs.filter((d) => d.status === "modified");
      if (modified.length > 0) {
        const statResult = await client.exec(
          `for f in ${modified.map((d) => `"${d.path}"`).join(" ")}; do ` +
          `diff --unified=0 "${snapshotRelative}/$f" "./$f" 2>/dev/null | ` +
          `awk '/^[+][^+]/{a++} /^[-][^-]/{d++} END{print FILENAME":"a":"d}' FILENAME="$f"; done 2>/dev/null`
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

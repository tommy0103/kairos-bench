import { resolve, sep } from "node:path";

export function getSafeToolsRoot(): string {
  const configuredRoot = process.env.MEMORY_FILES_ROOT?.trim();
  if (!configuredRoot) {
    throw new Error("MEMORY_FILES_ROOT is required for safe tools root.");
  }
  return configuredRoot;
}

export function resolveSafePath(inputPath: string): string {
  const normalized = inputPath.trim();
  if (!normalized) {
    throw new Error("Path is required.");
  }
  const configuredRoot = resolve(getSafeToolsRoot());
  const safeRoot = configuredRoot;
  const absolutePath = resolve(safeRoot, normalized);
  if (absolutePath !== safeRoot && !absolutePath.startsWith(`${safeRoot}${sep}`)) {
    throw new Error("Path is outside the allowed tools directory.");
  }
  return absolutePath;
}

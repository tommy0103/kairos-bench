import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyProtoTree(sourceDir: string, targetDir: string): Promise<void> {
  if (!(await exists(sourceDir))) {
    throw new Error(`Proto source directory not found: ${sourceDir}`);
  }
  await mkdir(targetDir, { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true });
}

async function main(): Promise<void> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(currentDir, "..");
  const runtimeRoot = resolve(root, ".runtime");
  const runtimeProtoRoot = resolve(runtimeRoot, "proto");

  const enclaveProtoSource = resolve(root, "src/enclave-runtime/proto");
  const vfsProtoSource = resolve(root, "src/vfs/proto");

  const enclaveProtoTarget = resolve(runtimeProtoRoot, "enclave-runtime");
  const vfsProtoTarget = resolve(runtimeProtoRoot, "vfs");

  if (!runtimeProtoRoot.startsWith(`${runtimeRoot}/`) && runtimeProtoRoot !== runtimeRoot) {
    throw new Error(`Unsafe runtime proto path: ${runtimeProtoRoot}`);
  }

  await rm(runtimeProtoRoot, { recursive: true, force: true });
  await mkdir(runtimeProtoRoot, { recursive: true });

  await copyProtoTree(enclaveProtoSource, enclaveProtoTarget);
  await copyProtoTree(vfsProtoSource, vfsProtoTarget);

  console.log("Proto sync complete.");
  console.log(`- ${enclaveProtoSource} -> ${enclaveProtoTarget}`);
  console.log(`- ${vfsProtoSource} -> ${vfsProtoTarget}`);
}

main().catch(error => {
  console.error("Proto sync failed:", error);
  process.exit(1);
});

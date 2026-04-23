#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

JFS_META="${JFS_META:-sqlite3:///tmp/kairos-jfs/meta.db}"
JFS_MNT="${JFS_MNT:-/tmp/kairos-test/mnt}"
SOCK="${LOGOS_SOCKET:-$ROOT/src/vfs/data/state/logos.sock}"
KERNEL_BIN="${LOGOS_KERNEL:-$ROOT/src/vfs/target/debug/logos-kernel}"
MODEL="${MODEL:-claude-opus-4-7}"

if [ -z "${API_KEY:-}" ]; then
  echo "Error: API_KEY is required." >&2
  exit 1
fi

task="${1:-}"

# --- JuiceFS ---
JFS_META_PATH="${JFS_META#sqlite3://}"
if ! mountpoint -q "$JFS_MNT" 2>/dev/null; then
  echo "[tui-kernel] setting up juicefs..."
  mkdir -p "$(dirname "$JFS_META_PATH")" "$JFS_MNT"
  if [ ! -f "$JFS_META_PATH" ]; then
    rm -rf ~/.juicefs/local/kairos-tui
    juicefs format "$JFS_META" kairos-tui
  fi
  if ! juicefs mount "$JFS_META" "$JFS_MNT" -d 2>/dev/null; then
    echo "[tui-kernel] mount failed, reinitializing juicefs..."
    rm -f "$JFS_META_PATH"
    rm -rf ~/.juicefs/local/kairos-tui
    juicefs format "$JFS_META" kairos-tui
    juicefs mount "$JFS_META" "$JFS_MNT" -d
  fi
  echo "[tui-kernel] juicefs mounted at $JFS_MNT"
else
  echo "[tui-kernel] juicefs already mounted at $JFS_MNT"
fi

# --- Kernel ---
cleanup() {
  if [ -n "${KERNEL_PID:-}" ]; then
    echo "[tui-kernel] stopping kernel (pid $KERNEL_PID)..."
    kill "$KERNEL_PID" 2>/dev/null || true
    wait "$KERNEL_PID" 2>/dev/null || true
  fi
  rm -f "$SOCK"
}
trap cleanup EXIT

if [ ! -S "$SOCK" ] || ! lsof -U "$SOCK" &>/dev/null; then
  echo "[tui-kernel] starting kernel → $SOCK"
  rm -f "$SOCK"
  VFS_LISTEN="unix://$SOCK" \
  VFS_SESSION_ROOT="$JFS_MNT" \
    "$KERNEL_BIN" &
  KERNEL_PID=$!

  for i in $(seq 1 30); do
    [ -S "$SOCK" ] && break
    sleep 0.2
  done
  if [ ! -S "$SOCK" ]; then
    echo "[tui-kernel] kernel failed to start" >&2
    exit 1
  fi
  echo "[tui-kernel] kernel ready (pid $KERNEL_PID)"
else
  echo "[tui-kernel] using existing kernel at $SOCK"
  KERNEL_PID=""
fi

# --- TUI ---
export API_KEY MODEL LOGOS_SOCKET="$SOCK"
export BASE_URL="${BASE_URL:-https://api.deepseek.com/v1}"
export API_PROVIDER="${API_PROVIDER:-}"

exec bun run "$ROOT/src/enclave-runtime/tui/app.tsx" "$task"

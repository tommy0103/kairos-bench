#!/bin/bash
# Standalone install script for logos agent.
# Used when running outside Harbor (e.g. manual Docker testing).
# Harbor mode uses logos_agent.py's install() method instead.
set -euo pipefail

KAIROS_DIR="${KAIROS_DIR:-/opt/kairos}"

echo "[logos-agent] configuring apt mirror..."
sed -i 's|http://archive.ubuntu.com|http://mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true
sed -i 's|http://security.ubuntu.com|http://mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true

echo "[logos-agent] installing system dependencies..."
for i in 1 2 3; do
    apt-get update -qq && \
    apt-get install -y -qq --fix-missing curl unzip git ca-certificates > /dev/null 2>&1 && break
    echo "[logos-agent] apt retry $i/3..."
    sleep 5
done

if ! command -v bun &> /dev/null; then
    echo "[logos-agent] installing Bun via npmmirror..."
    BUN_INSTALL="$HOME/.bun"
    mkdir -p "$BUN_INSTALL/bin"
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64)  BUN_PKG="@oven/bun-linux-x64" ;;
        aarch64) BUN_PKG="@oven/bun-linux-aarch64" ;;
        *)       echo "[logos-agent] unsupported arch: $ARCH"; exit 1 ;;
    esac
    TARBALL_URL=$(curl -fsSL "https://registry.npmmirror.com/${BUN_PKG}/latest" | grep -o '"tarball":"[^"]*"' | head -1 | cut -d'"' -f4)
    curl -fsSL "$TARBALL_URL" | tar xz -C /tmp
    cp /tmp/package/bin/bun "$BUN_INSTALL/bin/bun"
    chmod +x "$BUN_INSTALL/bin/bun"
    rm -rf /tmp/package
    export PATH="$BUN_INSTALL/bin:$PATH"
else
    echo "[logos-agent] Bun already installed"
fi

export PATH="$HOME/.bun/bin:$PATH"

if [ ! -d "$KAIROS_DIR" ]; then
    echo "[logos-agent] cloning kairos-runtime..."
    if [ -n "${KAIROS_REPO_URL:-}" ]; then
        git clone --depth 1 "$KAIROS_REPO_URL" "$KAIROS_DIR"
    else
        echo "[logos-agent] ERROR: set KAIROS_REPO_URL or mount repo at $KAIROS_DIR"
        exit 1
    fi
fi

cd "$KAIROS_DIR"
echo "[logos-agent] installing npm dependencies..."
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun install --frozen-lockfile 2>/dev/null || \
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun install

echo "[logos-agent] verifying build..."
bun build src/enclave-runtime/bench-runner.ts --target bun --outdir /tmp/_bench_verify > /dev/null 2>&1
rm -rf /tmp/_bench_verify

echo "[logos-agent] setup complete"

#!/bin/bash
# Standalone install script for logos agent.
# Used when running outside Harbor (e.g. manual Docker testing).
# Harbor mode uses logos_agent.py's install() method instead.
set -euo pipefail

KAIROS_DIR="${KAIROS_DIR:-/opt/kairos}"

echo "[logos-agent] installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl unzip git ca-certificates > /dev/null 2>&1

if ! command -v bun &> /dev/null; then
    echo "[logos-agent] installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    source "$HOME/.bun/env"
else
    echo "[logos-agent] Bun already installed"
fi

source "$HOME/.bun/env"

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
bun install --frozen-lockfile 2>/dev/null || bun install

echo "[logos-agent] verifying build..."
bun build src/enclave-runtime/bench-runner.ts --target bun --outdir /tmp/_bench_verify > /dev/null 2>&1
rm -rf /tmp/_bench_verify

echo "[logos-agent] setup complete"

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

# ── Init VFS submodule ────────────────────────────────────────
echo "[logos-agent] initializing vfs submodule..."
git submodule update --init --depth 1 src/vfs 2>/dev/null || \
  echo "[logos-agent] WARNING: submodule init failed (SSH key missing?), trying HTTPS..."
if [ ! -f src/vfs/proto/logos.proto ]; then
    git submodule set-url src/vfs https://github.com/kairos-plan9/logos-fs.git 2>/dev/null || true
    git submodule update --init --depth 1 src/vfs 2>/dev/null || \
      echo "[logos-agent] WARNING: vfs submodule unavailable, kernel mode disabled"
fi

# ── Install npm dependencies ─────────────────────────────────
echo "[logos-agent] installing npm dependencies..."
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun install --frozen-lockfile 2>/dev/null || \
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun install

echo "[logos-agent] verifying build..."
bun build src/enclave-runtime/bench-runner.ts --target bun --outdir /tmp/_bench_verify > /dev/null 2>&1
rm -rf /tmp/_bench_verify

# ── Build Logos kernel + MCP ──────────────────────────────────
if [ -f src/vfs/Cargo.toml ]; then
    if ! command -v cargo &> /dev/null; then
        echo "[logos-agent] installing Rust toolchain (rsproxy mirror)..."
        export RUSTUP_DIST_SERVER=https://rsproxy.cn
        export RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup
        curl --proto '=https' --tlsv1.2 -sSf https://rsproxy.cn/rustup-init.sh | sh -s -- -y --default-toolchain stable 2>&1 | tail -3
        source "$HOME/.cargo/env"

        mkdir -p "$HOME/.cargo"
        cat > "$HOME/.cargo/config.toml" << 'CARGO_CFG'
[source.crates-io]
replace-with = 'rsproxy-sparse'
[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
[registries.rsproxy]
index = "https://rsproxy.cn/crates.io-index"
CARGO_CFG
    fi

    echo "[logos-agent] building logos-kernel (release)..."
    cargo build --manifest-path src/vfs/Cargo.toml --bin logos-kernel --release 2>&1 | tail -5

    echo "[logos-agent] building logos-mcp (release)..."
    cargo build --manifest-path src/vfs/Cargo.toml --bin logos-mcp --release 2>&1 | tail -5
else
    echo "[logos-agent] vfs not available, skipping kernel build"
fi

# ── Start Logos kernel ────────────────────────────────────────
LOGOS_SOCK="$KAIROS_DIR/src/vfs/data/state/sandbox/logos.sock"
KERNEL_BIN="$KAIROS_DIR/src/vfs/target/release/logos-kernel"

if [ -x "$KERNEL_BIN" ]; then
    rm -f "$LOGOS_SOCK"
    echo "[logos-agent] starting logos-kernel..."
    nohup "$KERNEL_BIN" > /tmp/logos-kernel.log 2>&1 &
    KERNEL_PID=$!

    for i in $(seq 1 30); do
        [ -S "$LOGOS_SOCK" ] && break
        sleep 1
    done

    if [ -S "$LOGOS_SOCK" ]; then
        echo "[logos-agent] logos-kernel ready (pid=$KERNEL_PID, socket=$LOGOS_SOCK)"
        export LOGOS_SOCKET="$LOGOS_SOCK"
    else
        echo "[logos-agent] WARNING: logos-kernel did not start within 30s"
        tail -20 /tmp/logos-kernel.log 2>/dev/null
    fi
else
    echo "[logos-agent] kernel binary not found, running in standalone mode"
fi

echo "[logos-agent] setup complete"

"""
Logos agent for Terminal-Bench 2.0 (Harbor harness).

Implements Harbor BaseInstalledAgent — installs Bun + kairos runtime into the
task container, then runs bench-runner.ts with the task description.

Kernel mode: downloads pre-built logos-kernel from GitHub Release, starts it
as a background daemon, and passes LOGOS_SOCKET to bench-runner.

Usage (Harbor CLI):
    harbor run \
        -d terminal-bench/terminal-bench-2 \
        --agent-import-path src.terminal_bench.logos_agent:LogosAgent \
        --task-id hello-world

    # With model and API key:
    API_KEY=sk-xxx harbor run \
        -d terminal-bench/terminal-bench-2 \
        --agent-import-path src.terminal_bench.logos_agent:LogosAgent \
        -n 4
"""

import os
import shlex

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


KAIROS_DIR = "/opt/kairos"
LOGOS_BIN_DIR = "/opt/logos"
LOGOS_RELEASE_URL = (
    "https://github.com/tommy0103/kairos-bench/releases/download/logos-v0.1.0/logos-linux-x64.tar.gz"
)


class LogosAgent(BaseInstalledAgent):

    @staticmethod
    def name() -> str:
        return "logos"

    def populate_context_post_run(self, context: AgentContext) -> None:
        metadata = dict(context.metadata or {})
        metadata.update(
            {
                "agent": self.name(),
                "model_name": self.model_name,
                "runtime": "kairos-bench-runner",
            }
        )
        context.metadata = metadata

    def _build_env_exports(self) -> str:
        """Build shell export statements for env vars to forward into the container."""
        pairs: dict[str, str] = {}

        for key in ("API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"):
            val = os.environ.get(key)
            if val:
                pairs["API_KEY"] = val
                break

        for key in ("MODEL", "BASE_URL", "MAX_TURNS"):
            val = os.environ.get(key)
            if val:
                pairs[key] = val

        return " && ".join(
            f"export {k}={shlex.quote(v)}" for k, v in pairs.items()
        )

    async def install(self, environment: BaseEnvironment) -> None:
        # 1. System deps (apt with aliyun mirror)
        await self.exec_as_root(
            environment,
            command=(
                "sed -i 's|http://archive.ubuntu.com|http://mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true && "
                "sed -i 's|http://security.ubuntu.com|http://mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true && "
                "for i in 1 2 3; do "
                "  apt-get update -qq && "
                "  apt-get install -y -qq --fix-missing curl unzip git ca-certificates && break; "
                "  echo \"apt retry $i/3...\"; sleep 5; "
                "done"
            ),
        )

        # 2. Bun (prefer npmjs, fall back to npmmirror)
        await self.exec_as_agent(
            environment,
            command=(
                'if ! command -v bun &>/dev/null; then '
                '  BUN_INSTALL="$HOME/.bun" && mkdir -p "$BUN_INSTALL/bin" && '
                '  ARCH=$(uname -m) && '
                '  case "$ARCH" in x86_64) BUN_PKG="@oven/bun-linux-x64";; aarch64) BUN_PKG="@oven/bun-linux-aarch64";; esac && '
                '  TARBALL_URL="" && '
                '  for BUN_REGISTRY in "https://registry.npmjs.org" "https://registry.npmmirror.com"; do '
                '    TARBALL_URL=$(curl -fsSL "${BUN_REGISTRY}/${BUN_PKG}/latest" | grep -o \'\"tarball\":\"[^\"]*\"\' | head -1 | cut -d\'"\' -f4 || true) && '
                '    [ -n "$TARBALL_URL" ] && break; '
                '  done && '
                '  [ -n "$TARBALL_URL" ] || { echo "failed to resolve Bun tarball URL"; exit 1; } && '
                '  curl -fsSL "$TARBALL_URL" | tar xz -C /tmp && '
                '  cp /tmp/package/bin/bun "$BUN_INSTALL/bin/bun" && '
                '  chmod +x "$BUN_INSTALL/bin/bun" && '
                '  rm -rf /tmp/package; '
                "fi"
            ),
        )

        # 3. Clone repo + install deps + download pre-built kernel
        kairos_repo = os.environ.get(
            "KAIROS_REPO_URL",
            "https://github.com/tommy0103/kairos-bench.git",
        )
        await self.exec_as_agent(
            environment,
            command=(
                f"export PATH=$HOME/.bun/bin:$PATH && "
                # Clone repo
                f"if [ ! -d {KAIROS_DIR} ]; then "
                f"  git clone --depth 1 {shlex.quote(kairos_repo)} {KAIROS_DIR}; "
                f"fi && "
                f"cd {KAIROS_DIR} && "
                # npm deps (production only, skip playwright browsers)
                f"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 "
                f"bun install --production --frozen-lockfile 2>/dev/null || "
                f"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun install --production && "
                # Download pre-built logos-kernel + logos-mcp + logos.proto
                f"mkdir -p {LOGOS_BIN_DIR} && "
                f"if [ ! -x {LOGOS_BIN_DIR}/logos-kernel ]; then "
                f"  echo '[logos-agent] downloading pre-built kernel...' && "
                f"  curl -fsSL {shlex.quote(LOGOS_RELEASE_URL)} | tar xz -C {LOGOS_BIN_DIR} && "
                f"  chmod +x {LOGOS_BIN_DIR}/logos-kernel {LOGOS_BIN_DIR}/logos-mcp; "
                f"fi && "
                # Place proto where logosClient.ts expects it
                f"mkdir -p {KAIROS_DIR}/src/vfs/proto && "
                f"cp {LOGOS_BIN_DIR}/logos.proto {KAIROS_DIR}/src/vfs/proto/logos.proto"
            ),
        )

        # 4. Start logos-kernel daemon
        state_dir = f"{LOGOS_BIN_DIR}/state"
        logos_sock = f"{state_dir}/sandbox/logos.sock"
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {state_dir}/sandbox {state_dir}/entities {state_dir}/memory "
                f"  {state_dir}/proc-store {state_dir}/svc-store && "
                f"rm -f {logos_sock} && "
                f"VFS_SANDBOX_ROOT={state_dir}/sandbox "
                f"VFS_SYSTEM_DB={state_dir}/system.db "
                f"VFS_USERS_ROOT={state_dir}/entities "
                f"VFS_MEMORY_ROOT={state_dir}/memory "
                f"VFS_PROC_STORE_ROOT={state_dir}/proc-store "
                f"VFS_SVC_STORE_ROOT={state_dir}/svc-store "
                f"SANDBOX_MODE=host "
                f"nohup {LOGOS_BIN_DIR}/logos-kernel > /tmp/logos-kernel.log 2>&1 & "
                f"echo \"[logos-agent] waiting for kernel socket...\" && "
                f"for i in $(seq 1 30); do "
                f"  [ -S {logos_sock} ] && break; "
                f"  sleep 1; "
                f"done && "
                f"if [ -S {logos_sock} ]; then "
                f"  echo '[logos-agent] kernel ready'; "
                f"else "
                f"  echo '[logos-agent] ERROR: kernel failed to start:' && "
                f"  cat /tmp/logos-kernel.log && "
                f"  exit 1; "
                f"fi"
            ),
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env_exports = self._build_env_exports()
        escaped = shlex.quote(instruction)
        logos_sock = f"{LOGOS_BIN_DIR}/state/sandbox/logos.sock"

        cmd_parts = [
            "export PATH=$HOME/.bun/bin:$PATH",
        ]
        if env_exports:
            cmd_parts.append(env_exports)
        cmd_parts.append(
            f"export LOGOS_SOCKET={shlex.quote(logos_sock)} && "
            f"cd {KAIROS_DIR} && "
            f"bun run src/enclave-runtime/bench-runner.ts {escaped}"
        )

        await self.exec_as_agent(
            environment,
            command=" && ".join(cmd_parts),
        )

"""
Logos agent for Terminal-Bench 2.0 (Harbor harness).

Implements Harbor BaseInstalledAgent — installs Bun + kairos runtime into the
task container, then runs bench-runner.ts with the task description.

Two operating modes controlled by LOGOS_SOCKET env var:
  - Standalone (default): bench-runner uses local bash exec, no kernel needed.
  - Kernel mode: set LOGOS_SOCKET to a running logos-kernel Unix socket.

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

    # Legacy (tb CLI):
    tb run --dataset terminal-bench-core==head \
        --agent-import-path src.terminal_bench.logos_agent:LogosAgent \
        --task-id hello-world
"""

import os
import shlex

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


KAIROS_DIR = "/opt/kairos"


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

        for key in ("MODEL", "BASE_URL", "MAX_TURNS", "LOGOS_SOCKET"):
            val = os.environ.get(key)
            if val:
                pairs[key] = val

        return " && ".join(
            f"export {k}={shlex.quote(v)}" for k, v in pairs.items()
        )

    async def install(self, environment: BaseEnvironment) -> None:
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

        await self.exec_as_agent(
            environment,
            command=(
                'if ! command -v bun &>/dev/null; then '
                '  BUN_INSTALL="$HOME/.bun" && mkdir -p "$BUN_INSTALL/bin" && '
                '  ARCH=$(uname -m) && '
                '  case "$ARCH" in x86_64) BUN_PKG="@oven/bun-linux-x64";; aarch64) BUN_PKG="@oven/bun-linux-aarch64";; esac && '
                '  TARBALL_URL=$(curl -fsSL "https://registry.npmmirror.com/${BUN_PKG}/latest" | grep -o \'\"tarball\":\"[^\"]*\"\' | head -1 | cut -d\'"\' -f4) && '
                '  curl -fsSL "$TARBALL_URL" | tar xz -C /tmp && '
                '  cp /tmp/package/bin/bun "$BUN_INSTALL/bin/bun" && '
                '  chmod +x "$BUN_INSTALL/bin/bun" && '
                '  rm -rf /tmp/package; '
                "fi"
            ),
        )

        kairos_repo = os.environ.get(
            "KAIROS_REPO_URL",
            "https://github.com/user/kairos-runtime-test.git",
        )
        await self.exec_as_agent(
            environment,
            command=(
                f"export PATH=$HOME/.bun/bin:$PATH && "
                f"if [ ! -d {KAIROS_DIR} ]; then "
                f"  git clone --depth 1 {shlex.quote(kairos_repo)} {KAIROS_DIR}; "
                f"fi && "
                f"cd {KAIROS_DIR} && "
                f"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 "
                f"bun install --frozen-lockfile 2>/dev/null || "
                f"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun install"
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

        cmd_parts = [
            "export PATH=$HOME/.bun/bin:$PATH",
        ]
        if env_exports:
            cmd_parts.append(env_exports)
        cmd_parts.append(
            f"cd {KAIROS_DIR} && "
            f"bun run src/enclave-runtime/bench-runner.ts {escaped}"
        )

        await self.exec_as_agent(
            environment,
            command=" && ".join(cmd_parts),
        )

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
            command="apt-get update -qq && apt-get install -y -qq curl unzip git ca-certificates",
        )

        await self.exec_as_agent(
            environment,
            command=(
                'if ! command -v bun &>/dev/null; then '
                "  curl -fsSL https://bun.sh/install | bash && "
                "  source $HOME/.bun/env; "
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
                f"source $HOME/.bun/env && "
                f"if [ ! -d {KAIROS_DIR} ]; then "
                f"  git clone --depth 1 {shlex.quote(kairos_repo)} {KAIROS_DIR}; "
                f"fi && "
                f"cd {KAIROS_DIR} && "
                f"bun install --frozen-lockfile 2>/dev/null || bun install"
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
            "source $HOME/.bun/env",
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

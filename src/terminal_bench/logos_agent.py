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
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


def _load_env_file() -> None:
    """Load .env from the project root into os.environ (existing vars take precedence)."""
    env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        eq = line.find("=")
        if eq < 1:
            continue
        key = line[:eq].strip()
        val = line[eq + 1 :].strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
            val = val[1:-1]
        else:
            # strip inline comments (only for unquoted values)
            comment_idx = val.find(" #")
            if comment_idx >= 0:
                val = val[:comment_idx].rstrip()
        os.environ.setdefault(key, val)


_load_env_file()

KAIROS_DIR = "/opt/kairos"
LOGOS_BIN_DIR = "/opt/logos"
LOGOS_RELEASE_URL = (
    "https://github.com/tommy0103/kairos-bench/releases/download/v0.1.3/logos-linux-x64-web.tar.gz"
    # https://github.com/tommy0103/kairos-bench/releases/tag/v0.1.3
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

        for key in (
            "MODEL", "API_PROVIDER", "BASE_URL",
            "MAX_TURNS", "ANTHROPIC_MAX_TOKENS", "CONTEXT_LIMIT",
            "EVAL_RETRIES", "OPENAI_API_MODE",
            "EVALUATOR_MODEL", "EVALUATOR_API_KEY",
            "EVALUATOR_API_PROVIDER", "EVALUATOR_BASE_URL",
        ):
            val = os.environ.get(key)
            if val:
                pairs[key] = val

        for key in ("http_proxy", "https_proxy"):
            val = os.environ.get(key)
            if val:
                pairs[key] = val
        

        return " && ".join(
            f"export {k}={shlex.quote(v)}" for k, v in pairs.items()
        )

    async def install(self, environment: BaseEnvironment) -> None:
        # 1a. Rewrite Ubuntu apt sources to the configured mirror, then apt-get update.
        # Mirror host comes from $APT_MIRROR_HOST (e.g. `azure.archive.ubuntu.com`,
        # `mirrors.tuna.tsinghua.edu.cn/ubuntu`, ...). Set to empty to keep the default.
        # Covers both the legacy /etc/apt/sources.list and the deb822 files under
        # /etc/apt/sources.list.d/ (e.g. ubuntu.sources on 24.04), handling both
        # `deb http://...` and `URIs: http://...` lines.
        # NOTE: use `,` as the sed s-command delimiter — using `|` collides with
        # the regex alternation in `(archive|security)` and silently fails
        # (hidden by `|| true`), which previously caused agent setups to hang
        # 360s on the unreachable archive.ubuntu.com.
        # The outer `timeout` bounds each apt attempt so a stuck mirror/DNS
        # fails fast instead of eating the whole 360s agent setup budget.
        apt_mirror = os.environ.get("APT_MIRROR_HOST", "azure.archive.ubuntu.com").strip()
        if apt_mirror:
            # Strip scheme if the user set a full URL, and any trailing slash,
            # so the sed replacement composes a valid `http://<host>[/path]`.
            apt_mirror = apt_mirror.removeprefix("http://").removeprefix("https://").rstrip("/")
            rewrite_cmd = (
                "for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do "
                f"  [ -f \"$f\" ] && sed -i -E 's,https?://(archive|security)\\.ubuntu\\.com,http://{apt_mirror},g' \"$f\" || true; "
                "done && "
            )
        else:
            rewrite_cmd = ""

        await self.exec_as_root(
            environment,
            command=(
                f"{rewrite_cmd}"
                "APT_OPTS='-o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20' && "
                "for i in 1 2 3 4 5; do "
                "  timeout 60 apt-get $APT_OPTS update -qq && break; "
                "  echo \"[logos-agent] apt update retry $i/5...\"; sleep 5; "
                "done"
            ),
        )

        # 1b. install base packages
        await self.exec_as_root(
            environment,
            command=(
                "APT_OPTS='-o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20' && "
                "for i in 1 2 3 4 5; do "
                "  timeout 120 apt-get $APT_OPTS install -y -qq --fix-missing "
                "    curl unzip git ca-certificates poppler-utils lynx xxd bsdmainutils python3 python3-pip python3-numpy && break; "
                "  echo \"[logos-agent] apt install retry $i/5...\"; sleep 5; "
                "done"
            ),
        )

        # 1c. ensure libssl3
        await self.exec_as_root(
            environment,
            command=(
                "apt-get install -y -qq libssl3 2>/dev/null || "
                "( echo 'deb http://deb.debian.org/debian bookworm main' > /etc/apt/sources.list.d/bookworm-libssl.list && "
                "  apt-get update -qq && "
                "  apt-get install -y -qq libssl3 && "
                "  rm -f /etc/apt/sources.list.d/bookworm-libssl.list && "
                "  apt-get update -qq "
                ") || echo '[logos-agent] WARNING: could not install libssl3'"
            ),
        )

        # 2. Bun (prefer npmjs, fall back to npmmirror)
        await self.exec_as_agent(
            environment,
            command=(
                'echo "[logos-agent] step 2/6: installing bun..." && '
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
                'fi && echo "[logos-agent] step 2/6: done"'
            ),
        )

        # 3. Clone repo
        kairos_repo = os.environ.get(
            "KAIROS_REPO_URL",
            "https://github.com/tommy0103/kairos-bench.git",
        )
        await self.exec_as_agent(
            environment,
            command=(
                f"export PATH=$HOME/.bun/bin:$PATH && "
                f"echo '[logos-agent] step 3/6: cloning kairos repo...' && "
                f"if [ ! -f {KAIROS_DIR}/package.json ]; then "
                f"  rm -rf {KAIROS_DIR} && "
                f"  for i in 1 2 3; do "
                f"    git clone --depth 1 --single-branch -b researcher {shlex.quote(kairos_repo)} {KAIROS_DIR} && break; "
                f"    printf '[logos-agent] git clone retry %s/3...\\n' \"$i\" && "
                f"    rm -rf {KAIROS_DIR} && "
                f"    sleep 5; "
                f"  done; "
                f"fi && "
                f"[ -f {KAIROS_DIR}/package.json ] || "
                f"{{ echo '[logos-agent] ERROR: failed to clone kairos repo'; exit 1; }} && "
                f"echo '[logos-agent] step 3/6: done'"
            ),
        )

        # 4. Install dependencies
        await self.exec_as_agent(
            environment,
            command=(
                f"export PATH=$HOME/.bun/bin:$PATH && "
                f"echo '[logos-agent] step 4/6: installing kairos dependencies...' && "
                f"cd {KAIROS_DIR} && "
                f"(PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun install) && "
                f"echo '[logos-agent] step 4/6: done'"
            ),
        )

        # 5. Download pre-built logos-kernel + logos-mcp + logos.proto
        await self.exec_as_agent(
            environment,
            command=(
                f"export PATH=$HOME/.bun/bin:$PATH && "
                f"echo '[logos-agent] step 5/6: ensuring logos binaries...' && "
                f"mkdir -p {LOGOS_BIN_DIR} && "
                f"if [ ! -x {LOGOS_BIN_DIR}/logos-kernel ]; then "
                f"  echo '[logos-agent] downloading pre-built kernel...' && "
                f"  curl --retry 3 --retry-all-errors --retry-delay 2 -fsSL {shlex.quote(LOGOS_RELEASE_URL)} | tar xz -C {LOGOS_BIN_DIR} && "
                f"  chmod +x {LOGOS_BIN_DIR}/logos-kernel {LOGOS_BIN_DIR}/logos-mcp; "
                f"fi && "
                f"mkdir -p {KAIROS_DIR}/src/vfs/proto && "
                f"cp {LOGOS_BIN_DIR}/logos.proto {KAIROS_DIR}/src/vfs/proto/logos.proto && "
                f"echo '[logos-agent] step 5/6: done'"
            ),
        )

        # 6. Start logos-kernel daemon
        state_dir = f"{LOGOS_BIN_DIR}/state"
        logos_sock = f"{state_dir}/sandbox/logos.sock"
        await self.exec_as_agent(
            environment,
            command=(
                f"echo '[logos-agent] step 6/6: starting kernel...' && "
                f"mkdir -p {state_dir}/sandbox {state_dir}/entities {state_dir}/memory "
                f"  {state_dir}/proc-store {state_dir}/svc-store && "
                f"rm -f {logos_sock} && "
                f"unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY && "
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
            "unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY"
        )
        cmd_parts.append(
            "mkdir -p /logs/agent && "
            "set -o pipefail && "
            f"export LOGOS_SOCKET={shlex.quote(logos_sock)} && "
            f"cd {KAIROS_DIR} && "
            f"bun run src/enclave-runtime/bench-runner.ts {escaped} 2>&1 | tee /logs/agent/bench-runner.txt"
        )

        await self.exec_as_agent(
            environment,
            command=" && ".join(cmd_parts),
        )
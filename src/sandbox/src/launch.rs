use std::io;

use crate::config::SandboxConfig;
use crate::mounts::build_mounts;
use crate::runtime::{CtrRuntime, DryRunRuntime, SandboxRuntime};
use crate::socket::{parse_uds_path, prepare_socket_mountpoint};
use crate::spec::build_spec;

pub fn run() -> io::Result<()> {
    let mut cfg = SandboxConfig::from_env();
    cfg.validate()?;

    std::fs::create_dir_all(&cfg.host_runtime_dir)?;
    std::fs::create_dir_all(&cfg.host_enclave_runtime_dir)?;

    let enclave_socket_path = parse_uds_path(&cfg.enclave_socket)?;
    let vfs_socket_path = parse_uds_path(&cfg.vfs_socket)?;

    prepare_socket_mountpoint(&enclave_socket_path)?;
    prepare_socket_mountpoint(&vfs_socket_path)?;

    // 关键约束：在构建 OciSpec 前，把进程命令改写为“先装 bun，再启动主进程”。
    prepare_bun_bootstrap_before_spec(&mut cfg);
    let mounts = build_mounts(&cfg, enclave_socket_path, vfs_socket_path);
    let spec = build_spec(&cfg, mounts);

    if use_dry_run_runtime() {
        let runtime = DryRunRuntime;
        return runtime.run(&spec);
    }

    let runtime = CtrRuntime::new();
    runtime.run(&spec)
}

fn prepare_bun_bootstrap_before_spec(cfg: &mut SandboxConfig) {
    let app_cmd = cfg.process_args.iter().map(|arg| shell_escape(arg)).collect::<Vec<_>>().join(" ");
    let workdir = shell_escape(&cfg.process_cwd.to_string_lossy());

    // Debian slim 不包含 bun：先安装 bun，再进入工作目录执行 bun run dev（或自定义命令）。
    let bootstrap = format!(
        "set -e; \
if ! command -v bun >/dev/null 2>&1; then \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl unzip; \
  curl -fsSL https://bun.sh/install | bash; \
fi; \
export BUN_INSTALL=\"${{BUN_INSTALL:-/root/.bun}}\"; \
export PATH=\"$BUN_INSTALL/bin:$PATH\"; \
cd {workdir}; \
{app_cmd}"
    );

    cfg.process_args = vec!["/bin/sh".to_string(), "-lc".to_string(), bootstrap];
}

fn shell_escape(input: &str) -> String {
    let escaped = input.replace('\'', "'\"'\"'");
    format!("'{escaped}'")
}

fn use_dry_run_runtime() -> bool {
    match std::env::var("SANDBOX_DRY_RUN") {
        Ok(value) => {
            let lowered = value.trim().to_ascii_lowercase();
            lowered == "1" || lowered == "true" || lowered == "yes"
        }
        Err(_) => false,
    }
}

use std::env;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct SandboxConfig {
    pub namespace: String,
    pub container_id: String,
    pub snapshot_key: String,
    pub image: String,
    pub enclave_socket: String,
    pub vfs_socket: String,
    pub host_runtime_dir: PathBuf,
    pub host_enclave_runtime_dir: PathBuf,
    pub container_runtime_dir: PathBuf,
    pub container_enclave_dir: PathBuf,
    pub process_cwd: PathBuf,
    pub process_args: Vec<String>,
    pub process_env: Vec<(String, String)>,
}

impl SandboxConfig {
    pub fn from_env() -> Self {
        let project_root = resolve_project_root();

        let host_runtime_dir =
            resolve_path_from_env("SANDBOX_HOST_RUNTIME_DIR", &project_root.join(".runtime"));
        let host_enclave_runtime_dir = resolve_path_from_env(
            "SANDBOX_HOST_ENCLAVE_RUNTIME_DIR",
            &project_root.join("src/enclave-runtime"),
        );

        Self {
            namespace: env::var("SANDBOX_NAMESPACE").unwrap_or_else(|_| "default".to_string()),
            container_id: env::var("SANDBOX_CONTAINER_ID")
                .unwrap_or_else(|_| "kairos-enclave-sandbox".to_string()),
            snapshot_key: env::var("SANDBOX_SNAPSHOT_KEY")
                .unwrap_or_else(|_| "kairos-enclave-snapshot".to_string()),
            image: resolve_image(),
            enclave_socket: env::var("ENCLAVE_LISTEN")
                .unwrap_or_else(|_| "unix:///tmp/kairos-runtime-enclave.sock".to_string()),
            vfs_socket: env::var("VFS_LISTEN")
                .unwrap_or_else(|_| "unix:///tmp/kairos-runtime-vfs.sock".to_string()),
            host_runtime_dir,
            host_enclave_runtime_dir,
            container_runtime_dir: resolve_path_from_env(
                "SANDBOX_CONTAINER_RUNTIME_DIR",
                Path::new(".runtime"),
            ),
            container_enclave_dir: resolve_path_from_env(
                "SANDBOX_CONTAINER_ENCLAVE_DIR",
                Path::new("enclave"),
            ),
            process_cwd: resolve_path_from_env("SANDBOX_PROCESS_CWD", Path::new("enclave")),
            process_args: resolve_process_args(),
            process_env: resolve_process_env(),
        }
    }

    pub fn validate(&self) -> io::Result<()> {
        if self.image.trim() != "debian:slim" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "sandbox image must be debian:slim, got {}",
                    self.image.trim()
                ),
            ));
        }

        if self.process_args.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "sandbox process args must not be empty",
            ));
        }

        Ok(())
    }
}

fn resolve_project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

fn resolve_path_from_env(name: &str, default_value: &Path) -> PathBuf {
    env::var(name)
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_value.to_path_buf())
}

fn resolve_process_args() -> Vec<String> {
    if let Ok(raw) = env::var("SANDBOX_PROCESS_ARGS") {
        let args: Vec<String> = raw
            .split_whitespace()
            .filter(|segment| !segment.is_empty())
            .map(ToOwned::to_owned)
            .collect();
        if !args.is_empty() {
            return args;
        }
    }

    vec!["bun".to_string(), "run".to_string(), "dev".to_string()]
}

fn resolve_process_env() -> Vec<(String, String)> {
    let mut vars = Vec::new();
    for (key, value) in env::vars() {
        if key.starts_with("SANDBOX_CHILD_ENV_") {
            let env_key = key.trim_start_matches("SANDBOX_CHILD_ENV_").to_string();
            if !env_key.is_empty() {
                vars.push((env_key, value));
            }
        }
    }
    vars.sort_by(|a, b| a.0.cmp(&b.0));
    vars
}

fn resolve_image() -> String {
    if let Ok(image) = env::var("SANDBOX_IMAGE") {
        if !image.trim().is_empty() {
            return image;
        }
    }

    if let Ok(image) = env::var("SANDBOX_ROOTFS") {
        if !image.trim().is_empty() {
            return image;
        }
    }

    "debian:slim".to_string()
}

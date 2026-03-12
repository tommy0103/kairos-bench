use std::path::PathBuf;

use crate::config::SandboxConfig;

#[derive(Debug, Clone)]
pub struct BindMount {
    pub source: PathBuf,
    pub target: PathBuf,
    pub options: Vec<String>,
}

impl BindMount {
    fn rw_bind(source: PathBuf, target: PathBuf) -> Self {
        Self {
            source,
            target,
            options: vec![
                "rbind".to_string(),
                "rw".to_string(),
                "rprivate".to_string(),
            ],
        }
    }

    fn ro_bind(source: PathBuf, target: PathBuf) -> Self {
        Self {
            source,
            target,
            options: vec!["bind".to_string(), "ro".to_string()],
        }
    }
}

pub fn build_mounts(
    cfg: &SandboxConfig,
    enclave_socket_path: PathBuf,
    vfs_socket_path: PathBuf,
) -> Vec<BindMount> {
    vec![
        BindMount::rw_bind(cfg.host_runtime_dir.clone(), cfg.container_runtime_dir.clone()),
        BindMount::rw_bind(
            cfg.host_enclave_runtime_dir.clone(),
            cfg.container_enclave_dir.clone(),
        ),
        BindMount::ro_bind(enclave_socket_path.clone(), enclave_socket_path),
        BindMount::ro_bind(vfs_socket_path.clone(), vfs_socket_path),
    ]
}

use std::io;
use std::time::Duration;

use containerd_client::services::v1::containers_client::ContainersClient;
use containerd_client::services::v1::snapshots::snapshots_client::SnapshotsClient;
use containerd_client::services::v1::tasks_client::TasksClient;
use containerd_client::services::v1::{
    Container, CreateContainerRequest, CreateTaskRequest, DeleteContainerRequest,
    DeleteTaskRequest, GetImageRequest, KillRequest, StartRequest, WaitRequest,
};
use containerd_client::types::Mount;
use containerd_client::{
    Client,
    tonic::{Code, Request},
    with_namespace,
};
use prost_types::Any;
use tokio::runtime::Builder;

use crate::mounts::BindMount;
use crate::spec::OciSpecDraft;

pub trait SandboxRuntime {
    fn run(&self, spec: &OciSpecDraft) -> io::Result<()>;
}

pub struct DryRunRuntime;

impl SandboxRuntime for DryRunRuntime {
    fn run(&self, spec: &OciSpecDraft) -> io::Result<()> {
        println!(
            "[sandbox] dry-run start namespace={} container_id={} snapshot_key={} image={}",
            spec.namespace, spec.container_id, spec.snapshot_key, spec.image
        );
        println!(
            "[sandbox] process cwd={} args={:?}",
            spec.process.cwd.display(),
            spec.process.args
        );
        for (key, value) in &spec.process.env {
            println!("[sandbox] process env {key}={value}");
        }
        for mount in &spec.mounts {
            println!(
                "[sandbox] mount {} -> {} opts={:?}",
                mount.source.display(),
                mount.target.display(),
                mount.options
            );
        }
        println!("[sandbox] dry-run finished");
        Ok(())
    }
}

pub struct CtrRuntime {
    containerd_socket: String,
    snapshotter: String,
    runtime_name: String,
}

impl CtrRuntime {
    pub fn new() -> Self {
        Self {
            containerd_socket: "/run/containerd/containerd.sock".to_string(),
            snapshotter: "overlayfs".to_string(),
            runtime_name: "io.containerd.runc.v2".to_string(),
        }
    }
}

impl SandboxRuntime for CtrRuntime {
    fn run(&self, spec: &OciSpecDraft) -> io::Result<()> {
        let rt = Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|err| io::Error::other(format!("tokio runtime init failed: {err}")))?;
        rt.block_on(self.run_async(spec))
    }
}

impl CtrRuntime {
    async fn run_async(&self, spec: &OciSpecDraft) -> io::Result<()> {
        println!(
            "[sandbox] containerd-client runtime start namespace={} container_id={} snapshot_key={} image={}",
            spec.namespace, spec.container_id, spec.snapshot_key, spec.image
        );

        let client = Client::from_path(&self.containerd_socket)
            .await
            .map_err(|err| {
                let message = format!("{err}");
                let hint = if message.contains("permission denied") {
                    " (permission denied; try running sandboxd with sudo, or grant your user access to containerd.sock)"
                } else {
                    ""
                };
                io::Error::other(format!(
                    "connect containerd socket '{}' failed: {}{} (debug: {:?})",
                    self.containerd_socket, message, hint, err
                ))
            })?;

        self.cleanup_best_effort(&client, spec, true).await;
        let resolved_image_ref = self.ensure_image_exists(&client, spec).await?;

        let mut containers_client = client.containers();
        let container = Container {
            id: spec.container_id.clone(),
            labels: Default::default(),
            image: resolved_image_ref,
            runtime: Some(containerd_client::services::v1::container::Runtime {
                name: self.runtime_name.clone(),
                options: None,
            }),
            spec: Some(Any {
                type_url: "types.containerd.io/opencontainers/runtime-spec/1/Spec".to_string(),
                value: serde_json::to_vec(&build_oci_spec(spec))
                    .map_err(|err| io::Error::other(format!("serialize oci spec failed: {err}")))?,
            }),
            snapshotter: self.snapshotter.clone(),
            snapshot_key: spec.snapshot_key.clone(),
            created_at: None,
            updated_at: None,
            extensions: Default::default(),
            sandbox: String::new(),
        };

        containers_client
            .create(with_namespace!(
                CreateContainerRequest {
                    container: Some(container)
                },
                &spec.namespace
            ))
            .await
            .map_err(to_io_err("create container"))?;

        let rootfs = self.fetch_snapshot_mounts(&client, spec).await?;
        let mut tasks_client = client.tasks();
        tasks_client
            .create(with_namespace!(
                CreateTaskRequest {
                    container_id: spec.container_id.clone(),
                    rootfs,
                    stdin: String::new(),
                    stdout: String::new(),
                    stderr: String::new(),
                    terminal: false,
                    checkpoint: None,
                    options: None,
                    runtime_path: String::new(),
                },
                &spec.namespace
            ))
            .await
            .map_err(to_io_err("create task"))?;

        tasks_client
            .start(with_namespace!(
                StartRequest {
                    container_id: spec.container_id.clone(),
                    exec_id: String::new(),
                },
                &spec.namespace
            ))
            .await
            .map_err(to_io_err("start task"))?;

        tasks_client
            .wait(with_namespace!(
                WaitRequest {
                    container_id: spec.container_id.clone(),
                    exec_id: String::new(),
                },
                &spec.namespace
            ))
            .await
            .map_err(to_io_err("wait task"))?;

        self.cleanup_best_effort(&client, spec, false).await;
        println!("[sandbox] containerd-client runtime finished");
        Ok(())
    }

    async fn ensure_image_exists(&self, client: &Client, spec: &OciSpecDraft) -> io::Result<String> {
        let mut images_client = client.images();
        let candidates = image_ref_candidates(&spec.image);
        let mut has_not_found = false;

        for candidate in &candidates {
            let result = images_client
                .get(with_namespace!(
                    GetImageRequest {
                        name: candidate.clone(),
                    },
                    &spec.namespace
                ))
                .await;

            match result {
                Ok(_) => return Ok(candidate.clone()),
                Err(status) if status.code() == Code::NotFound => {
                    has_not_found = true;
                }
                Err(status) => {
                    return Err(io::Error::other(format!(
                        "check image '{}' existence failed: {status}",
                        candidate
                    )));
                }
            }
        }

        if has_not_found {
            let pull_hint = candidates
                .last()
                .cloned()
                .unwrap_or_else(|| spec.image.clone());
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "image '{}' not found in containerd namespace '{}'. Pre-pull it with: sudo ctr -n {} images pull {}",
                    spec.image, spec.namespace, spec.namespace, pull_hint
                ),
            ));
        }

        Err(io::Error::other("check image existence failed for unknown reason"))
    }

    async fn fetch_snapshot_mounts(
        &self,
        client: &Client,
        spec: &OciSpecDraft,
    ) -> io::Result<Vec<Mount>> {
        let mut snapshots_client: SnapshotsClient<_> = client.snapshots();
        let response = snapshots_client
            .mounts(with_namespace!(
                containerd_client::services::v1::snapshots::MountsRequest {
                    snapshotter: self.snapshotter.clone(),
                    key: spec.snapshot_key.clone(),
                },
                &spec.namespace
            ))
            .await
            .map_err(to_io_err("fetch snapshot mounts"))?;
        Ok(response.into_inner().mounts)
    }

    async fn cleanup_best_effort(
        &self,
        client: &Client,
        spec: &OciSpecDraft,
        kill_before_delete: bool,
    ) {
        let mut tasks_client: TasksClient<_> = client.tasks();
        if kill_before_delete {
            let _ = tasks_client
                .kill(with_namespace!(
                    KillRequest {
                        container_id: spec.container_id.clone(),
                        exec_id: String::new(),
                        signal: 9,
                        all: true,
                    },
                    &spec.namespace
                ))
                .await;
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        let _ = tasks_client
            .delete(with_namespace!(
                DeleteTaskRequest {
                    container_id: spec.container_id.clone(),
                },
                &spec.namespace
            ))
            .await;

        let mut containers_client: ContainersClient<_> = client.containers();
        let _ = containers_client
            .delete(with_namespace!(
                DeleteContainerRequest {
                    id: spec.container_id.clone(),
                },
                &spec.namespace
            ))
            .await;

        let mut snapshots_client: SnapshotsClient<_> = client.snapshots();
        let _ = snapshots_client
            .remove(with_namespace!(
                containerd_client::services::v1::snapshots::RemoveSnapshotRequest {
                    snapshotter: self.snapshotter.clone(),
                    key: spec.snapshot_key.clone(),
                },
                &spec.namespace
            ))
            .await;
    }
}

fn build_oci_spec(spec: &OciSpecDraft) -> serde_json::Value {
    let process_env = spec
        .process
        .env
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>();

    let mounts = spec
        .mounts
        .iter()
        .map(bind_mount_to_json)
        .collect::<Vec<_>>();

    serde_json::json!({
        "ociVersion": "1.0.2",
        "process": {
            "terminal": false,
            "cwd": spec.process.cwd,
            "args": spec.process.args,
            "env": process_env
        },
        "root": {
            "path": "rootfs",
            "readonly": false
        },
        "mounts": mounts
    })
}

fn bind_mount_to_json(mount: &BindMount) -> serde_json::Value {
    serde_json::json!({
        "destination": mount.target,
        "type": "bind",
        "source": mount.source,
        "options": mount.options
    })
}

fn to_io_err(
    context: &'static str,
) -> impl FnOnce(containerd_client::tonic::Status) -> io::Error {
    move |err| io::Error::other(format!("{context} failed: {err}"))
}

fn image_ref_candidates(image: &str) -> Vec<String> {
    let trimmed = image.trim();
    if trimmed.is_empty() {
        return vec![image.to_string()];
    }

    let mut refs = vec![trimmed.to_string()];
    let has_registry_or_namespace = trimmed.contains('/');
    if !has_registry_or_namespace {
        refs.push(format!("docker.io/library/{trimmed}"));
    } else if !trimmed.starts_with("docker.io/") && !trimmed.starts_with("registry-1.docker.io/") {
        refs.push(format!("docker.io/{trimmed}"));
    }
    refs
}

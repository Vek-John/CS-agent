use crate::{
    local_log,
    protocol::{RuntimeInit, RuntimeReady, READY_SCHEMA, TARGET_TRIPLE},
    updater::VerifiedUpdateBackup,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    async_runtime::Receiver, webview::Cookie, AppHandle, Emitter, Manager, Runtime, WebviewWindow,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use url::Url;

const READY_TIMEOUT: Duration = Duration::from_secs(20);
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(7);
const TERM_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicRuntimeStatus {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<&'static str>,
}

#[derive(Debug)]
struct RuntimeState {
    status: PublicRuntimeStatus,
    child: Option<CommandChild>,
    app_origin: Option<String>,
    viewer_origin: Option<String>,
    admin_token: Option<String>,
    stopping: bool,
    maintenance_navigation: bool,
    review_ended_for_update: bool,
    generation: u64,
}

#[derive(Clone, Debug)]
pub struct Supervisor {
    inner: Arc<Mutex<RuntimeState>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SupervisorError {
    #[error("RUNTIME_RESOURCE_MISSING")]
    ResourceMissing,
    #[error("RUNTIME_DIRECTORY_FAILED")]
    DirectoryFailed,
    #[error("RUNTIME_SPAWN_FAILED")]
    SpawnFailed,
    #[error("RUNTIME_INIT_FAILED")]
    InitFailed,
    #[error("RUNTIME_READY_TIMEOUT")]
    ReadyTimeout,
    #[error("RUNTIME_READY_INVALID")]
    InvalidReady,
    #[error("RUNTIME_EXITED_EARLY")]
    ExitedEarly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MonitorExitDisposition {
    Stale,
    ExpectedStop,
    UnexpectedExit,
}

fn monitor_exit_disposition(
    current_generation: u64,
    monitored_generation: u64,
    stopping: bool,
) -> MonitorExitDisposition {
    if current_generation != monitored_generation {
        MonitorExitDisposition::Stale
    } else if stopping {
        MonitorExitDisposition::ExpectedStop
    } else {
        MonitorExitDisposition::UnexpectedExit
    }
}

impl Default for Supervisor {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RuntimeState {
                status: PublicRuntimeStatus {
                    state: "starting",
                    message: None,
                },
                child: None,
                app_origin: None,
                viewer_origin: None,
                admin_token: None,
                stopping: false,
                maintenance_navigation: false,
                review_ended_for_update: false,
                generation: 0,
            })),
        }
    }
}

impl Supervisor {
    pub fn public_status(&self) -> PublicRuntimeStatus {
        self.inner
            .lock()
            .expect("supervisor lock poisoned")
            .status
            .clone()
    }

    pub fn coaching_busy<R: Runtime>(&self, app: &AppHandle<R>) -> bool {
        let state = self.inner.lock().expect("supervisor lock poisoned");
        let _ = app;
        state.child.is_none() || state.status.state != "ready" || !state.review_ended_for_update
    }

    pub fn review_ended_for_update(&self) -> bool {
        self.inner
            .lock()
            .expect("supervisor lock poisoned")
            .review_ended_for_update
    }

    pub async fn backup_before_update<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Option<VerifiedUpdateBackup> {
        let transport = {
            let state = self.inner.lock().expect("supervisor lock poisoned");
            state.app_origin.clone().zip(state.admin_token.clone())
        };
        let Some((origin, token)) = transport else {
            return None;
        };
        let response = request_admin_backup(origin, token).await?;
        let data_dir = app.path().app_data_dir().ok()?;
        validate_backup_response(response, &data_dir)
    }

    pub async fn review_library_stats(&self) -> Option<ReviewLibraryStats> {
        let transport = {
            let state = self.inner.lock().expect("supervisor lock poisoned");
            state.app_origin.clone().zip(state.admin_token.clone())
        };
        let (origin, token) = transport?;
        request_admin_library_stats(origin, token).await
    }

    pub async fn review_library_verify(&self) -> Option<ReviewLibraryVerificationSummary> {
        let transport = {
            let state = self.inner.lock().expect("supervisor lock poisoned");
            state.app_origin.clone().zip(state.admin_token.clone())
        };
        let (origin, token) = transport?;
        request_admin_library_verification(origin, token).await
    }

    pub async fn review_library_clear_cache(&self) -> Option<ReviewLibraryCacheCleanup> {
        let transport = {
            let state = self.inner.lock().expect("supervisor lock poisoned");
            state.app_origin.clone().zip(state.admin_token.clone())
        };
        let (origin, token) = transport?;
        request_admin_library_cache_cleanup(origin, token).await
    }

    pub async fn review_library_entries(&self) -> Option<ReviewLibraryEntries> {
        let transport = {
            let state = self.inner.lock().expect("supervisor lock poisoned");
            state.app_origin.clone().zip(state.admin_token.clone())
        };
        let (origin, token) = transport?;
        request_admin_library_entries(origin, token).await
    }

    pub async fn review_library_demo_impact(
        &self,
        demo_id: String,
    ) -> Option<ReviewLibraryDemoDeletionImpact> {
        let transport = {
            let state = self.inner.lock().expect("supervisor lock poisoned");
            state.app_origin.clone().zip(state.admin_token.clone())
        };
        let (origin, token) = transport?;
        request_admin_library_demo_impact(origin, token, demo_id).await
    }

    pub async fn review_library_delete_review(
        &self,
        review_id: String,
    ) -> Option<ReviewLibraryDeleteResult> {
        let transport = {
            let state = self.inner.lock().expect("supervisor lock poisoned");
            state.app_origin.clone().zip(state.admin_token.clone())
        };
        let (origin, token) = transport?;
        request_admin_library_delete_review(origin, token, review_id).await
    }

    pub async fn review_library_delete_demo(
        &self,
        demo_id: String,
        impact_token: String,
    ) -> Result<ReviewLibraryDeleteResult, &'static str> {
        let transport = {
            let state = self.inner.lock().expect("supervisor lock poisoned");
            state.app_origin.clone().zip(state.admin_token.clone())
        };
        let (origin, token) = transport.ok_or("REVIEW_LIBRARY_UNAVAILABLE")?;
        request_admin_library_delete_demo(origin, token, demo_id, impact_token).await
    }

    pub fn allows_navigation(&self, url: &Url) -> bool {
        let state = self.inner.lock().expect("supervisor lock poisoned");
        if state.maintenance_navigation
            && matches!(url.scheme(), "tauri" | "asset")
            && url.host_str() == Some("localhost")
            && url.path() == "/update-waiting.html"
            && url.query().is_none()
            && url.fragment().is_none()
        {
            return true;
        }
        exact_runtime_navigation(url, state.app_origin.as_deref(), "127.0.0.1")
            || exact_runtime_navigation(url, state.viewer_origin.as_deref(), "localhost")
    }

    pub async fn end_review_for_update<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<(), &'static str> {
        {
            let mut state = self.inner.lock().expect("supervisor lock poisoned");
            if state.child.is_none() || state.status.state != "ready" {
                return Err("UPDATE_REVIEW_UNAVAILABLE");
            }
            state.maintenance_navigation = true;
        }
        let target = Url::parse("tauri://localhost/update-waiting.html")
            .map_err(|_| "UPDATE_REVIEW_UNAVAILABLE")?;
        let main = app
            .get_webview_window("main")
            .ok_or("UPDATE_REVIEW_UNAVAILABLE")?;
        if main.navigate(target.clone()).is_err()
            || !wait_for_window_url(&main, &target, Duration::from_secs(2)).await
        {
            let mut state = self.inner.lock().expect("supervisor lock poisoned");
            state.maintenance_navigation = false;
            state.review_ended_for_update = false;
            return Err("UPDATE_REVIEW_UNAVAILABLE");
        }
        {
            let mut state = self.inner.lock().expect("supervisor lock poisoned");
            state.maintenance_navigation = false;
            state.review_ended_for_update = true;
        }
        let _ = main.hide();
        Ok(())
    }

    pub async fn resume_review<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), &'static str> {
        if !self.review_ended_for_update() {
            return Ok(());
        }
        let origin = self
            .inner
            .lock()
            .expect("supervisor lock poisoned")
            .app_origin
            .clone()
            .ok_or("UPDATE_REVIEW_UNAVAILABLE")?;
        let target =
            Url::parse(&format!("{origin}/desktop")).map_err(|_| "UPDATE_REVIEW_UNAVAILABLE")?;
        let main = app
            .get_webview_window("main")
            .ok_or("UPDATE_REVIEW_UNAVAILABLE")?;
        main.navigate(target.clone())
            .map_err(|_| "UPDATE_REVIEW_UNAVAILABLE")?;
        if !wait_for_window_url(&main, &target, Duration::from_secs(2)).await {
            return Err("UPDATE_REVIEW_UNAVAILABLE");
        }
        self.inner
            .lock()
            .expect("supervisor lock poisoned")
            .review_ended_for_update = false;
        main.show().map_err(|_| "UPDATE_REVIEW_UNAVAILABLE")?;
        main.set_focus().map_err(|_| "UPDATE_REVIEW_UNAVAILABLE")?;
        if let Some(settings) = app.get_webview_window("settings") {
            let _ = settings.hide();
        }
        Ok(())
    }

    pub fn open_memory<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), &'static str> {
        let origin = {
            let state = self.inner.lock().expect("supervisor lock poisoned");
            if state.status.state != "ready"
                || state.child.is_none()
                || state.review_ended_for_update
            {
                return Err("MEMORY_UNAVAILABLE");
            }
            state.app_origin.clone().ok_or("MEMORY_UNAVAILABLE")?
        };
        let target = Url::parse(&format!("{origin}/memory")).map_err(|_| "MEMORY_UNAVAILABLE")?;
        if !self.allows_navigation(&target) {
            return Err("MEMORY_UNAVAILABLE");
        }
        let main = app.get_webview_window("main").ok_or("MEMORY_UNAVAILABLE")?;
        main.navigate(target).map_err(|_| "MEMORY_UNAVAILABLE")?;
        main.show().map_err(|_| "MEMORY_UNAVAILABLE")?;
        main.set_focus().map_err(|_| "MEMORY_UNAVAILABLE")?;
        if let Some(settings) = app.get_webview_window("settings") {
            let _ = settings.hide();
        }
        Ok(())
    }

    pub async fn start<R: Runtime>(&self, app: AppHandle<R>) -> Result<(), SupervisorError> {
        let generation = {
            let mut state = self.inner.lock().expect("supervisor lock poisoned");
            state.generation = state.generation.wrapping_add(1);
            state.stopping = false;
            state.maintenance_navigation = false;
            state.review_ended_for_update = false;
            state.app_origin = None;
            state.viewer_origin = None;
            state.admin_token = None;
            state.generation
        };
        let paths = match RuntimePaths::resolve(&app) {
            Ok(paths) => paths,
            Err(error) => return self.fail(&app, error),
        };
        if let Err(error) = paths.prepare() {
            return self.fail(&app, error);
        }
        local_log::record(&app, "RUNTIME_STARTING");

        let runtime_entry = paths.runtime_root.join("runtime.cjs");
        if !runtime_entry.is_file() || !paths.viewer_root.is_dir() {
            return self.fail(&app, SupervisorError::ResourceMissing);
        }

        let sidecar = match app.shell().sidecar("cs-agent-runtime") {
            Ok(sidecar) => sidecar,
            Err(_) => return self.fail(&app, SupervisorError::SpawnFailed),
        };
        let mut restricted_sidecar = sidecar.env_clear().arg("--permission");
        for directory in [
            &paths.runtime_root,
            &paths.viewer_root,
            &paths.data_dir,
            &paths.cache_dir,
            &paths.log_dir,
        ] {
            restricted_sidecar = restricted_sidecar.arg(node_fs_permission("read", directory)?);
        }
        for directory in [&paths.data_dir, &paths.cache_dir, &paths.log_dir] {
            restricted_sidecar = restricted_sidecar.arg(node_fs_permission("write", directory)?);
        }
        let (mut rx, mut child) = match restricted_sidecar
            .arg("--jitless")
            .arg(&runtime_entry)
            .spawn()
        {
            Ok(spawned) => spawned,
            Err(_) => return self.fail(&app, SupervisorError::SpawnFailed),
        };
        let expected_pid = child.pid();

        let provider = match crate::provider::runtime_provider(&paths.data_dir) {
            Ok(provider) => provider,
            Err(_) => {
                let _ = child.kill();
                return self.fail(&app, SupervisorError::InitFailed);
            }
        };
        let init = RuntimeInit {
            schema_version: crate::protocol::INIT_SCHEMA,
            app_version: app.package_info().version.to_string(),
            build_sha: option_env!("CS_AGENT_BUILD_SHA")
                .unwrap_or("development")
                .to_owned(),
            target_triple: TARGET_TRIPLE,
            data_dir: paths.data_dir,
            cache_dir: paths.cache_dir,
            log_dir: paths.log_dir,
            runtime_root: paths.runtime_root,
            viewer_root: paths.viewer_root,
            provider,
        };
        let mut init_line = match serde_json::to_vec(&init) {
            Ok(line) => line,
            Err(_) => {
                let _ = child.kill();
                return self.fail(&app, SupervisorError::InitFailed);
            }
        };
        init_line.push(b'\n');
        let write_result = child.write(&init_line);
        init_line.fill(0);
        if write_result.is_err() {
            let _ = child.kill();
            return self.fail(&app, SupervisorError::InitFailed);
        }

        self.inner.lock().expect("supervisor lock poisoned").child = Some(child);

        let ready =
            match tokio::time::timeout(READY_TIMEOUT, receive_ready(&mut rx, expected_pid)).await {
                Ok(Ok(ready)) => ready,
                Ok(Err(error)) => return self.fail_and_kill(&app, error),
                Err(_) => return self.fail_and_kill(&app, SupervisorError::ReadyTimeout),
            };

        {
            let mut state = self.inner.lock().expect("supervisor lock poisoned");
            state.app_origin = Some(ready.app_origin.clone());
            state.viewer_origin = Some(ready.viewer_origin.clone());
            state.admin_token = Some(ready.admin_token.clone());
        }
        if let Err(error) = self.activate_main_window(&app, &ready) {
            return self.fail_and_kill(&app, error);
        }

        {
            let mut state = self.inner.lock().expect("supervisor lock poisoned");
            state.status = PublicRuntimeStatus {
                state: "ready",
                message: None,
            };
        }
        notify_bootstrap(&app);
        local_log::record(&app, "RUNTIME_READY");

        let monitor = self.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                let duplicate_ready = match &event {
                    CommandEvent::Stdout(line) => {
                        serde_json::from_slice::<serde_json::Value>(line)
                            .ok()
                            .and_then(|value| {
                                value
                                    .get("schemaVersion")
                                    .and_then(|value| value.as_str())
                                    .map(str::to_owned)
                            })
                            .as_deref()
                            == Some(READY_SCHEMA)
                    }
                    _ => false,
                };
                if duplicate_ready
                    || matches!(event, CommandEvent::Terminated(_) | CommandEvent::Error(_))
                {
                    let disposition = {
                        let mut state = monitor.inner.lock().expect("supervisor lock poisoned");
                        let disposition =
                            monitor_exit_disposition(state.generation, generation, state.stopping);
                        if disposition != MonitorExitDisposition::Stale {
                            state.child = None;
                        }
                        disposition
                    };
                    if disposition == MonitorExitDisposition::UnexpectedExit {
                        local_log::record(&app, "RUNTIME_EXITED_EARLY");
                        monitor.show_failure(&app, SupervisorError::ExitedEarly);
                    }
                    break;
                }
            }
        });

        Ok(())
    }

    fn activate_main_window<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        ready: &RuntimeReady,
    ) -> Result<(), SupervisorError> {
        let main = app
            .get_webview_window("main")
            .ok_or(SupervisorError::SpawnFailed)?;
        let cookie = Cookie::build(("cs_agent_runtime", ready.session_token.clone()))
            .domain("127.0.0.1")
            .path("/")
            .http_only(true)
            .same_site(cookie::SameSite::Strict)
            .build();
        main.set_cookie(cookie)
            .map_err(|_| SupervisorError::InvalidReady)?;

        let desktop_url = format!("{}/desktop", ready.app_origin);
        main.navigate(Url::parse(&desktop_url).map_err(|_| SupervisorError::InvalidReady)?)
            .map_err(|_| SupervisorError::InvalidReady)?;
        main.show().map_err(|_| SupervisorError::SpawnFailed)?;
        main.set_focus().map_err(|_| SupervisorError::SpawnFailed)?;
        if let Some(bootstrap) = app.get_webview_window("bootstrap") {
            let _ = bootstrap.hide();
        }
        Ok(())
    }

    fn fail<R: Runtime, T>(
        &self,
        app: &AppHandle<R>,
        error: SupervisorError,
    ) -> Result<T, SupervisorError> {
        self.show_failure(app, error);
        Err(error)
    }

    fn fail_and_kill<R: Runtime, T>(
        &self,
        app: &AppHandle<R>,
        error: SupervisorError,
    ) -> Result<T, SupervisorError> {
        if let Some(child) = self
            .inner
            .lock()
            .expect("supervisor lock poisoned")
            .child
            .take()
        {
            let _ = child.kill();
        }
        self.fail(app, error)
    }

    fn show_failure<R: Runtime>(&self, app: &AppHandle<R>, error: SupervisorError) {
        let message = match error {
            SupervisorError::ResourceMissing => "本地运行资源尚未准备好。请重新安装或联系支持。",
            SupervisorError::ReadyTimeout => "本地教练启动超时，可以重新启动应用。",
            _ => "本地教练未能安全启动，可以重新启动应用。",
        };
        {
            let mut state = self.inner.lock().expect("supervisor lock poisoned");
            state.status = PublicRuntimeStatus {
                state: "error",
                message: Some(message),
            };
            state.app_origin = None;
            state.viewer_origin = None;
            state.admin_token = None;
        }
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
        if let Some(bootstrap) = app.get_webview_window("bootstrap") {
            let _ = bootstrap.show();
            let _ = bootstrap.set_focus();
        }
        notify_bootstrap(app);
        local_log::record(app, "RUNTIME_START_FAILED");
    }

    pub async fn shutdown<R: Runtime>(&self, app: &AppHandle<R>) {
        let (pid, child, app_origin, admin_token) = {
            let mut state = self.inner.lock().expect("supervisor lock poisoned");
            state.stopping = true;
            let pid = state.child.as_ref().map(CommandChild::pid);
            state.viewer_origin = None;
            (
                pid,
                state.child.take(),
                state.app_origin.take(),
                state.admin_token.take(),
            )
        };

        let Some(child) = child else { return };
        let Some(pid) = pid else { return };

        if let (Some(origin), Some(token)) = (app_origin, admin_token) {
            if request_admin_shutdown(origin, token).await
                && wait_for_process_exit(pid, GRACEFUL_SHUTDOWN_TIMEOUT).await
            {
                let _ = app.emit("cs-agent-runtime-stopped", ());
                local_log::record(app, "RUNTIME_STOPPED");
                return;
            }
        }

        if process_is_alive(pid) {
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
        if !wait_for_process_exit(pid, TERM_SHUTDOWN_TIMEOUT).await {
            let _ = child.kill();
        }
        let _ = app.emit("cs-agent-runtime-stopped", ());
        local_log::record(app, "RUNTIME_FORCE_STOPPED");
    }

    pub fn terminate_now(&self) {
        let child = {
            let mut state = self.inner.lock().expect("supervisor lock poisoned");
            state.stopping = true;
            state.app_origin = None;
            state.viewer_origin = None;
            state.admin_token = None;
            state.child.take()
        };
        if let Some(child) = child {
            let _ = child.kill();
        }
    }
}

fn exact_runtime_navigation(url: &Url, expected_origin: Option<&str>, expected_host: &str) -> bool {
    expected_origin.is_some_and(|origin| {
        url.scheme() == "http"
            && url.host_str() == Some(expected_host)
            && url.origin().ascii_serialization() == origin
    })
}

async fn wait_for_window_url<R: Runtime>(
    window: &WebviewWindow<R>,
    expected: &Url,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if window.url().is_ok_and(|current| current == *expected) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    false
}

fn node_fs_permission(access: &str, directory: &Path) -> Result<OsString, SupervisorError> {
    if !matches!(access, "read" | "write")
        || !directory.is_absolute()
        || directory.as_os_str().as_bytes().contains(&b'*')
    {
        return Err(SupervisorError::DirectoryFailed);
    }
    let mut argument = OsString::from(format!("--allow-fs-{access}="));
    argument.push(directory.as_os_str());
    Ok(argument)
}

async fn request_admin_shutdown(origin: String, token: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(url) = Url::parse(&origin) else {
            return false;
        };
        let Some(port) = url.port() else {
            return false;
        };
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(1)) else {
            return false;
        };
        let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
        let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
        let request = format!(
            "POST /_desktop/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        if stream.write_all(request.as_bytes()).is_err() {
            return false;
        }
        let mut response = [0_u8; 64];
        let Ok(read) = stream.read(&mut response) else {
            return false;
        };
        response[..read].starts_with(b"HTTP/1.1 202")
    })
    .await
    .unwrap_or(false)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupResponse {
    schema_version: String,
    database_path: String,
    manifest_path: String,
    created_at: String,
    database_sha256: String,
    migration_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLibraryStats {
    pub schema_version: String,
    pub demo_count: u64,
    pub review_count: u64,
    pub raw_demo_bytes: u64,
    pub artifact_bytes: u64,
    pub cache_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLibraryVerificationSummary {
    pub schema_version: String,
    pub checked_demos: u64,
    pub checked_artifacts: u64,
    pub issue_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLibraryCacheCleanup {
    pub schema_version: String,
    pub removed_bytes: u64,
    pub cache_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLibraryReviewEntry {
    pub review_id: String,
    pub demo_id: String,
    pub original_filename: String,
    pub selected_player_id: String,
    pub selected_player_name: String,
    pub title: String,
    pub map_name: Option<String>,
    pub score_text: Option<String>,
    pub status: String,
    pub active_revision_id: Option<String>,
    pub current_cue_id: Option<String>,
    pub current_playback_tick: Option<u64>,
    pub completed_cue_count: u64,
    pub total_cue_count: u64,
    pub created_at: String,
    pub last_opened_at: String,
    pub completed_at: Option<String>,
    pub demo_status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLibraryDemoEntry {
    pub demo_id: String,
    pub original_filename: String,
    pub byte_size: u64,
    pub map_name: Option<String>,
    pub status: String,
    pub imported_at: String,
    pub last_opened_at: String,
    pub review_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLibraryEntries {
    pub schema_version: String,
    pub reviews: Vec<ReviewLibraryReviewEntry>,
    pub demos: Vec<ReviewLibraryDemoEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLibraryAffectedReview {
    pub review_id: String,
    pub title: String,
    pub selected_player_name: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLibraryDemoDeletionImpact {
    pub schema_version: String,
    pub demo_id: String,
    pub original_filename: String,
    pub affected_review_count: u64,
    pub affected_reviews: Vec<ReviewLibraryAffectedReview>,
    pub truncated: bool,
    pub impact_token: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLibraryDeleteResult {
    pub deleted: bool,
    pub target_id: String,
    pub removed_review_count: u64,
    pub removed_demo: bool,
}

fn bounded_string(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum && !value.as_bytes().contains(&0)
}

fn bounded_library_object_id(value: &str) -> bool {
    bounded_string(value, 160)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_review_status(value: &str) -> bool {
    matches!(
        value,
        "PREPARING" | "READY" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "STALE"
    )
}

fn valid_demo_status(value: &str) -> bool {
    matches!(value, "IMPORTING" | "READY" | "MISSING" | "CORRUPT")
}

fn validate_library_entries(value: ReviewLibraryEntries) -> Option<ReviewLibraryEntries> {
    if value.schema_version != "review-library-entries.v1"
        || value.reviews.len() > 50
        || value.demos.len() > 50
        || value.reviews.iter().any(|review| {
            !bounded_library_object_id(&review.review_id)
                || !bounded_library_object_id(&review.demo_id)
                || !bounded_string(&review.original_filename, 255)
                || !bounded_string(&review.selected_player_id, 160)
                || !bounded_string(&review.selected_player_name, 160)
                || !bounded_string(&review.title, 200)
                || review.map_name.as_deref().is_some_and(|item| !bounded_string(item, 120))
                || review.score_text.as_deref().is_some_and(|item| !bounded_string(item, 80))
                || !valid_review_status(&review.status)
                || review.active_revision_id.as_deref().is_some_and(|item| !bounded_library_object_id(item))
                || review.current_cue_id.as_deref().is_some_and(|item| !bounded_string(item, 160))
                || review.completed_cue_count > review.total_cue_count
                || !bounded_string(&review.created_at, 64)
                || !bounded_string(&review.last_opened_at, 64)
                || review.completed_at.as_deref().is_some_and(|item| !bounded_string(item, 64))
                || !valid_demo_status(&review.demo_status)
        })
        || value.demos.iter().any(|demo| {
            !bounded_library_object_id(&demo.demo_id)
                || !bounded_string(&demo.original_filename, 255)
                || demo.map_name.as_deref().is_some_and(|item| !bounded_string(item, 120))
                || !valid_demo_status(&demo.status)
                || !bounded_string(&demo.imported_at, 64)
                || !bounded_string(&demo.last_opened_at, 64)
        })
    {
        return None;
    }
    Some(value)
}

fn validate_demo_deletion_impact(
    value: ReviewLibraryDemoDeletionImpact,
    expected_demo_id: &str,
) -> Option<ReviewLibraryDemoDeletionImpact> {
    let bounded_count = u64::try_from(value.affected_reviews.len()).ok()?;
    if value.schema_version != "review-library-demo-deletion-impact.v1"
        || value.demo_id != expected_demo_id
        || !bounded_library_object_id(&value.demo_id)
        || !bounded_string(&value.original_filename, 255)
        || value.affected_reviews.len() > 50
        || (!value.truncated && value.affected_review_count != bounded_count)
        || (value.truncated && value.affected_review_count <= bounded_count)
        || value.impact_token.len() != 64
        || !value.impact_token.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || value.affected_reviews.iter().any(|review| {
            !bounded_library_object_id(&review.review_id)
                || !bounded_string(&review.title, 200)
                || !bounded_string(&review.selected_player_name, 160)
                || !valid_review_status(&review.status)
        })
    {
        return None;
    }
    Some(value)
}

fn validate_delete_result(
    value: ReviewLibraryDeleteResult,
    expected_target_id: &str,
    removed_demo: bool,
) -> Option<ReviewLibraryDeleteResult> {
    (value.deleted && value.target_id == expected_target_id && value.removed_demo == removed_demo)
        .then_some(value)
}

async fn request_admin_json<T>(
    origin: String,
    token: String,
    method: &'static str,
    request_path: &'static str,
) -> Option<T>
where
    T: DeserializeOwned + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let url = Url::parse(&origin).ok()?;
        let port = url.port()?;
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2)).ok()?;
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
        let request = format!(
            "{method} {request_path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).ok()?;
        let mut response = Vec::with_capacity(2048);
        stream.take(16 * 1024).read_to_end(&mut response).ok()?;
        if !response.starts_with(b"HTTP/1.1 200") {
            return None;
        }
        let body_start = response.windows(4).position(|value| value == b"\r\n\r\n")?;
        serde_json::from_slice::<T>(&response[body_start + 4..]).ok()
    })
    .await
    .unwrap_or(None)
}

async fn request_dynamic_admin_library_json<T>(
    origin: String,
    token: String,
    method: &'static str,
    request_path: String,
    impact_token: Option<String>,
) -> Option<(u16, T)>
where
    T: DeserializeOwned + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let url = Url::parse(&origin).ok()?;
        let port = url.port()?;
        if !request_path.starts_with("/_desktop/library/")
            || request_path.len() > 240
            || request_path.bytes().any(|byte| matches!(byte, b'\r' | b'\n' | b'?' | b'#'))
        {
            return None;
        }
        if impact_token.as_deref().is_some_and(|value| {
            value.len() != 64
                || !value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        }) {
            return None;
        }
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2)).ok()?;
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let impact_header = impact_token
            .map(|value| format!("X-Cs-Agent-Library-Impact-Token: {value}\r\n"))
            .unwrap_or_default();
        let request = format!(
            "{method} {request_path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n{impact_header}Content-Length: 0\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).ok()?;
        let mut response = Vec::with_capacity(4096);
        stream.take(16 * 1024).read_to_end(&mut response).ok()?;
        let status = if response.starts_with(b"HTTP/1.1 200") {
            200
        } else if response.starts_with(b"HTTP/1.1 409") {
            409
        } else {
            return None;
        };
        let body_start = response.windows(4).position(|value| value == b"\r\n\r\n")?;
        let body = serde_json::from_slice::<T>(&response[body_start + 4..]).ok()?;
        Some((status, body))
    })
    .await
    .unwrap_or(None)
}

async fn request_admin_library_entries(
    origin: String,
    token: String,
) -> Option<ReviewLibraryEntries> {
    let body: ReviewLibraryEntries =
        request_admin_json(origin, token, "GET", "/_desktop/library/entries").await?;
    validate_library_entries(body)
}

async fn request_admin_library_demo_impact(
    origin: String,
    token: String,
    demo_id: String,
) -> Option<ReviewLibraryDemoDeletionImpact> {
    if !bounded_library_object_id(&demo_id) {
        return None;
    }
    let path = format!("/_desktop/library/demos/{demo_id}/impact");
    let (status, body): (u16, ReviewLibraryDemoDeletionImpact) =
        request_dynamic_admin_library_json(origin, token, "GET", path, None).await?;
    (status == 200)
        .then(|| validate_demo_deletion_impact(body, &demo_id))
        .flatten()
}

async fn request_admin_library_delete_review(
    origin: String,
    token: String,
    review_id: String,
) -> Option<ReviewLibraryDeleteResult> {
    if !bounded_library_object_id(&review_id) {
        return None;
    }
    let path = format!("/_desktop/library/reviews/{review_id}");
    let (status, body): (u16, ReviewLibraryDeleteResult) =
        request_dynamic_admin_library_json(origin, token, "DELETE", path, None).await?;
    (status == 200)
        .then(|| validate_delete_result(body, &review_id, false))
        .flatten()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AdminLibraryErrorResponse {
    code: String,
}

async fn request_admin_library_delete_demo(
    origin: String,
    token: String,
    demo_id: String,
    impact_token: String,
) -> Result<ReviewLibraryDeleteResult, &'static str> {
    if !bounded_library_object_id(&demo_id)
        || impact_token.len() != 64
        || !impact_token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("REVIEW_LIBRARY_INVALID_DELETE");
    }
    let path = format!("/_desktop/library/demos/{demo_id}");
    let response = request_dynamic_admin_library_json::<serde_json::Value>(
        origin,
        token,
        "DELETE",
        path,
        Some(impact_token),
    )
    .await
    .ok_or("REVIEW_LIBRARY_UNAVAILABLE")?;
    if response.0 == 409 {
        let error = serde_json::from_value::<AdminLibraryErrorResponse>(response.1)
            .map_err(|_| "REVIEW_LIBRARY_UNAVAILABLE")?;
        return if error.code == "DELETION_IMPACT_CHANGED" {
            Err("REVIEW_LIBRARY_IMPACT_CHANGED")
        } else {
            Err("REVIEW_LIBRARY_UNAVAILABLE")
        };
    }
    let body = serde_json::from_value::<ReviewLibraryDeleteResult>(response.1)
        .map_err(|_| "REVIEW_LIBRARY_UNAVAILABLE")?;
    validate_delete_result(body, &demo_id, true).ok_or("REVIEW_LIBRARY_UNAVAILABLE")
}

async fn request_admin_library_verification(
    origin: String,
    token: String,
) -> Option<ReviewLibraryVerificationSummary> {
    let body: ReviewLibraryVerificationSummary =
        request_admin_json(origin, token, "POST", "/_desktop/library/verify").await?;
    let checked = body.checked_demos.checked_add(body.checked_artifacts)?;
    (body.schema_version == "review-library-verification-summary.v1"
        && body.issue_count <= checked)
        .then_some(body)
}

async fn request_admin_library_cache_cleanup(
    origin: String,
    token: String,
) -> Option<ReviewLibraryCacheCleanup> {
    let body: ReviewLibraryCacheCleanup =
        request_admin_json(origin, token, "POST", "/_desktop/library/clear-cache").await?;
    (body.schema_version == "review-library-cache-cleanup.v1").then_some(body)
}

async fn request_admin_library_stats(
    origin: String,
    token: String,
) -> Option<ReviewLibraryStats> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = Url::parse(&origin).ok()?;
        let port = url.port()?;
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2)).ok()?;
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let request = format!(
            "GET /_desktop/library/stats HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).ok()?;
        let mut response = Vec::with_capacity(2048);
        stream.take(16 * 1024).read_to_end(&mut response).ok()?;
        if !response.starts_with(b"HTTP/1.1 200") {
            return None;
        }
        let body_start = response.windows(4).position(|value| value == b"\r\n\r\n")?;
        let body = serde_json::from_slice::<ReviewLibraryStats>(&response[body_start + 4..]).ok()?;
        let summed = body
            .raw_demo_bytes
            .checked_add(body.artifact_bytes)?
            .checked_add(body.cache_bytes)?;
        (body.schema_version == "review-library-stats.v1" && body.total_bytes == summed)
            .then_some(body)
    })
    .await
    .unwrap_or(None)
}

async fn request_admin_backup(origin: String, token: String) -> Option<BackupResponse> {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(url) = Url::parse(&origin) else {
            return None;
        };
        let Some(port) = url.port() else {
            return None;
        };
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(2)) else {
            return None;
        };
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
        let request = format!(
            "POST /_desktop/backup HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        if stream.write_all(request.as_bytes()).is_err() {
            return None;
        }
        let mut response = Vec::with_capacity(4096);
        if stream.take(16 * 1024).read_to_end(&mut response).is_err()
            || !response.starts_with(b"HTTP/1.1 201")
        {
            return None;
        }
        let Some(body_start) = response.windows(4).position(|value| value == b"\r\n\r\n") else {
            return None;
        };
        let Ok(body) = serde_json::from_slice::<BackupResponse>(&response[body_start + 4..]) else {
            return None;
        };
        (body.schema_version == "desktop-runtime-backup.v1"
            && Path::new(&body.database_path).is_absolute()
            && Path::new(&body.manifest_path).is_absolute()
            && !body.created_at.is_empty()
            && body.database_sha256.len() == 64
            && body.database_sha256.chars().all(|value| value.is_ascii_hexdigit())
            && body.migration_count > 0)
            .then_some(body)
    })
    .await
    .unwrap_or(None)
}

fn validate_backup_response(body: BackupResponse, data_dir: &Path) -> Option<VerifiedUpdateBackup> {
    let database_path = PathBuf::from(&body.database_path);
    let manifest_path = PathBuf::from(&body.manifest_path);
    let backup_dir = data_dir.join("backups");
    let database_name = database_path.file_name()?.to_str()?;
    let expected_manifest = PathBuf::from(format!("{}.manifest.json", database_path.display()));
    let database_type = fs::symlink_metadata(&database_path).ok()?.file_type();
    let manifest_type = fs::symlink_metadata(&manifest_path).ok()?.file_type();
    if database_path.parent() != Some(backup_dir.as_path())
        || manifest_path != expected_manifest
        || !database_name.starts_with("cs-agent-pre-update-")
        || !database_name.ends_with(".sqlite3")
        || !database_type.is_file()
        || !manifest_type.is_file()
    {
        return None;
    }
    Some(VerifiedUpdateBackup {
        database_path,
        manifest_path,
        database_sha256: body.database_sha256,
        migration_count: body.migration_count,
    })
}

fn process_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

async fn wait_for_process_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while process_is_alive(pid) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    !process_is_alive(pid)
}

async fn receive_ready(
    rx: &mut Receiver<CommandEvent>,
    expected_pid: u32,
) -> Result<RuntimeReady, SupervisorError> {
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let looks_like_ready = serde_json::from_slice::<serde_json::Value>(&line)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("schemaVersion")
                            .and_then(|value| value.as_str())
                            .map(str::to_owned)
                    })
                    .as_deref()
                    == Some(READY_SCHEMA);
                if looks_like_ready {
                    return RuntimeReady::parse_and_validate(&line, expected_pid)
                        .map_err(|_| SupervisorError::InvalidReady);
                }
            }
            CommandEvent::Terminated(_) | CommandEvent::Error(_) => {
                return Err(SupervisorError::ExitedEarly)
            }
            CommandEvent::Stderr(_) => {}
            _ => {}
        }
    }
    Err(SupervisorError::ExitedEarly)
}

fn notify_bootstrap<R: Runtime>(app: &AppHandle<R>) {
    if let Some(bootstrap) = app.get_webview_window("bootstrap") {
        let _ = bootstrap.eval("window.dispatchEvent(new Event('cs-agent-runtime-status'))");
    }
}

struct RuntimePaths {
    data_dir: PathBuf,
    cache_dir: PathBuf,
    log_dir: PathBuf,
    runtime_root: PathBuf,
    viewer_root: PathBuf,
}

impl RuntimePaths {
    fn resolve<R: Runtime>(app: &AppHandle<R>) -> Result<Self, SupervisorError> {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|_| SupervisorError::DirectoryFailed)?;
        Ok(Self {
            data_dir: app
                .path()
                .app_data_dir()
                .map_err(|_| SupervisorError::DirectoryFailed)?,
            cache_dir: app
                .path()
                .app_cache_dir()
                .map_err(|_| SupervisorError::DirectoryFailed)?,
            log_dir: app
                .path()
                .app_log_dir()
                .map_err(|_| SupervisorError::DirectoryFailed)?,
            runtime_root: resource_dir.join("resources/runtime-root"),
            viewer_root: resource_dir.join("resources/viewer-root"),
        })
    }

    fn prepare(&self) -> Result<(), SupervisorError> {
        for directory in [&self.data_dir, &self.cache_dir, &self.log_dir] {
            fs::create_dir_all(directory).map_err(|_| SupervisorError::DirectoryFailed)?;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| SupervisorError::DirectoryFailed)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, thread};
    use tauri::async_runtime::channel;
    use tempfile::tempdir;

    #[tokio::test]
    async fn timeout_error_contains_no_runtime_output() {
        let (_tx, mut rx) = channel(1);
        let result =
            tokio::time::timeout(Duration::from_millis(10), receive_ready(&mut rx, 42)).await;
        assert!(result.is_err());
        assert_eq!(
            SupervisorError::ReadyTimeout.to_string(),
            "RUNTIME_READY_TIMEOUT"
        );
    }

    #[test]
    fn navigation_gate_allows_only_the_two_ready_runtime_origins() {
        let app_origin = "http://127.0.0.1:43001";
        let viewer_origin = "http://localhost:43002";
        assert!(exact_runtime_navigation(
            &Url::parse("http://127.0.0.1:43001/desktop").unwrap(),
            Some(app_origin),
            "127.0.0.1",
        ));
        assert!(exact_runtime_navigation(
            &Url::parse(
                "http://localhost:43002/?host=1&parentOrigin=http%3A%2F%2F127.0.0.1%3A43001",
            )
            .unwrap(),
            Some(viewer_origin),
            "localhost",
        ));
        for rejected in [
            "http://127.0.0.1:43003/desktop",
            "http://192.168.1.4:43001/desktop",
            "https://127.0.0.1:43001/desktop",
            "http://localhost:43003/?host=1",
            "http://127.0.0.1:43002/?host=1",
        ] {
            let url = Url::parse(rejected).unwrap();
            assert!(!exact_runtime_navigation(
                &url,
                Some(app_origin),
                "127.0.0.1"
            ));
            assert!(!exact_runtime_navigation(
                &url,
                Some(viewer_origin),
                "localhost"
            ));
        }
    }

    #[tokio::test]
    async fn malformed_ready_is_redacted_to_stable_error() {
        let (tx, mut rx) = channel(1);
        tx.send(CommandEvent::Stdout(
            br#"{"schemaVersion":"desktop-runtime-ready.v2","sessionToken":"do-not-print"}"#
                .to_vec(),
        ))
        .await
        .unwrap();
        let error = receive_ready(&mut rx, 42).await.unwrap_err();
        assert_eq!(error, SupervisorError::InvalidReady);
        assert!(!error.to_string().contains("do-not-print"));
    }

    #[tokio::test]
    async fn readiness_watcher_returns_before_the_lifecycle_terminates() {
        let (tx, mut rx) = channel(2);
        let ready = serde_json::json!({
            "schemaVersion": "desktop-runtime-ready.v2",
            "protocolVersion": "desktop-runtime-http.v2",
            "appOrigin": "http://127.0.0.1:30101",
            "viewerOrigin": "http://localhost:30102",
            "pid": 42,
            "targetTriple": TARGET_TRIPLE,
            "nodeVersion": "24.19.0",
            "checkpointBackend": "SQLITE",
            "recoverableAfterRefresh": true,
            "sessionToken": "s".repeat(43),
            "adminToken": "a".repeat(43)
        });
        tx.send(CommandEvent::Stdout(serde_json::to_vec(&ready).unwrap()))
            .await
            .unwrap();
        tx.send(CommandEvent::Terminated(
            tauri_plugin_shell::process::TerminatedPayload {
                code: Some(0),
                signal: None,
            },
        ))
        .await
        .unwrap();
        assert!(receive_ready(&mut rx, 42).await.is_ok());
        assert!(matches!(rx.recv().await, Some(CommandEvent::Terminated(_))));
    }

    #[test]
    fn old_monitor_cannot_retire_a_restarted_runtime_generation() {
        assert_eq!(
            monitor_exit_disposition(2, 1, false),
            MonitorExitDisposition::Stale
        );
        assert_eq!(
            monitor_exit_disposition(2, 2, true),
            MonitorExitDisposition::ExpectedStop
        );
        assert_eq!(
            monitor_exit_disposition(2, 2, false),
            MonitorExitDisposition::UnexpectedExit
        );
    }

    #[test]
    fn node_permissions_are_exact_paths_without_wildcards() {
        let read = node_fs_permission(
            "read",
            Path::new("/Applications/CS Agent Coach.app/Contents/Resources/runtime-root"),
        )
        .unwrap();
        let write = node_fs_permission(
            "write",
            Path::new("/Users/test/Library/Application Support/com.csagent.coach"),
        )
        .unwrap();
        assert_eq!(
            read,
            "--allow-fs-read=/Applications/CS Agent Coach.app/Contents/Resources/runtime-root"
        );
        assert_eq!(
            write,
            "--allow-fs-write=/Users/test/Library/Application Support/com.csagent.coach"
        );
        assert!(node_fs_permission("read", Path::new("/tmp/*")).is_err());
        assert!(node_fs_permission("child", Path::new("/tmp")).is_err());
        assert!(node_fs_permission("read", Path::new("relative")).is_err());
    }

    #[tokio::test]
    async fn admin_shutdown_uses_the_memory_only_bearer_transport() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let read = stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
            String::from_utf8_lossy(&request[..read]).into_owned()
        });

        let accepted =
            request_admin_shutdown(format!("http://127.0.0.1:{port}"), "a".repeat(43)).await;
        assert!(accepted);
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /_desktop/shutdown HTTP/1.1\r\n"));
        assert!(request.contains("Authorization: Bearer "));
        assert!(!request.contains("Origin:"));
    }

    #[tokio::test]
    async fn admin_backup_requires_a_strict_success_summary() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let read = stream.read(&mut request).unwrap();
            let body = serde_json::json!({
                "schemaVersion": "desktop-runtime-backup.v1",
                "databasePath": "/tmp/backups/memory.sqlite3",
                "manifestPath": "/tmp/backups/memory.json",
                "createdAt": "2026-08-30T00:00:00.000Z",
                "databaseSha256": "a".repeat(64),
                "migrationCount": 2
            })
            .to_string();
            write!(
                stream,
                "HTTP/1.1 201 Created\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            String::from_utf8_lossy(&request[..read]).into_owned()
        });
        assert!(
            request_admin_backup(format!("http://127.0.0.1:{port}"), "b".repeat(43))
                .await
                .is_some()
        );
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /_desktop/backup HTTP/1.1\r\n"));
        assert!(request.contains("Authorization: Bearer "));
        assert!(!request.contains("Origin:"));
    }

    #[tokio::test]
    async fn admin_library_stats_are_bounded_and_use_memory_only_bearer_transport() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let read = stream.read(&mut request).unwrap();
            let body = serde_json::json!({
                "schemaVersion": "review-library-stats.v1",
                "demoCount": 2,
                "reviewCount": 3,
                "rawDemoBytes": 1024,
                "artifactBytes": 256,
                "cacheBytes": 0,
                "totalBytes": 1280
            })
            .to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            String::from_utf8_lossy(&request[..read]).into_owned()
        });
        let stats = request_admin_library_stats(
            format!("http://127.0.0.1:{port}"),
            "c".repeat(43),
        )
        .await
        .expect("valid stats");
        assert_eq!(stats.total_bytes, 1280);
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /_desktop/library/stats HTTP/1.1\r\n"));
        assert!(request.contains("Authorization: Bearer "));
        assert!(!request.contains("Origin:"));
    }

    #[tokio::test]
    async fn admin_library_maintenance_uses_strict_bounded_summaries() {
        let verification_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let verification_port = verification_listener.local_addr().unwrap().port();
        let verification_server = thread::spawn(move || {
            let (mut stream, _) = verification_listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let read = stream.read(&mut request).unwrap();
            let body = serde_json::json!({
                "schemaVersion": "review-library-verification-summary.v1",
                "checkedDemos": 2,
                "checkedArtifacts": 1,
                "issueCount": 1
            })
            .to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            String::from_utf8_lossy(&request[..read]).into_owned()
        });
        let verified = request_admin_library_verification(
            format!("http://127.0.0.1:{verification_port}"),
            "v".repeat(43),
        )
        .await
        .expect("valid verification summary");
        assert_eq!(verified.issue_count, 1);
        let request = verification_server.join().unwrap();
        assert!(request.starts_with("POST /_desktop/library/verify HTTP/1.1\r\n"));
        assert!(request.contains("Authorization: Bearer "));

        let cleanup_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let cleanup_port = cleanup_listener.local_addr().unwrap().port();
        let cleanup_server = thread::spawn(move || {
            let (mut stream, _) = cleanup_listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let read = stream.read(&mut request).unwrap();
            let body = serde_json::json!({
                "schemaVersion": "review-library-cache-cleanup.v1",
                "removedBytes": 0,
                "cacheBytes": 0
            })
            .to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            String::from_utf8_lossy(&request[..read]).into_owned()
        });
        let cleanup = request_admin_library_cache_cleanup(
            format!("http://127.0.0.1:{cleanup_port}"),
            "c".repeat(43),
        )
        .await
        .expect("valid cleanup summary");
        assert_eq!(cleanup.removed_bytes, 0);
        let request = cleanup_server.join().unwrap();
        assert!(request.starts_with("POST /_desktop/library/clear-cache HTTP/1.1\r\n"));
        assert!(!request.contains("Origin:"));
    }

    #[test]
    fn settings_library_entry_and_impact_dtos_are_strict_and_bounded() {
        let entries = serde_json::from_value::<ReviewLibraryEntries>(serde_json::json!({
            "schemaVersion": "review-library-entries.v1",
            "reviews": [{
                "reviewId": "review-a",
                "demoId": "demo-a",
                "originalFilename": "match.dem",
                "selectedPlayerId": "player-a",
                "selectedPlayerName": "Player A",
                "title": "Mirage review",
                "status": "READY",
                "completedCueCount": 1,
                "totalCueCount": 2,
                "createdAt": "2026-09-02T00:00:00.000Z",
                "lastOpenedAt": "2026-09-02T00:00:00.000Z",
                "demoStatus": "READY"
            }],
            "demos": [{
                "demoId": "demo-a",
                "originalFilename": "match.dem",
                "byteSize": 72,
                "status": "READY",
                "importedAt": "2026-09-02T00:00:00.000Z",
                "lastOpenedAt": "2026-09-02T00:00:00.000Z",
                "reviewCount": 1
            }]
        })).unwrap();
        assert!(validate_library_entries(entries).is_some());
        assert!(serde_json::from_value::<ReviewLibraryEntries>(serde_json::json!({
            "schemaVersion": "review-library-entries.v1",
            "reviews": [],
            "demos": [],
            "rawPath": "/private/demo.dem"
        })).is_err());

        let impact = serde_json::from_value::<ReviewLibraryDemoDeletionImpact>(serde_json::json!({
            "schemaVersion": "review-library-demo-deletion-impact.v1",
            "demoId": "demo-a",
            "originalFilename": "match.dem",
            "affectedReviewCount": 1,
            "affectedReviews": [{
                "reviewId": "review-a",
                "title": "Mirage review",
                "selectedPlayerName": "Player A",
                "status": "READY"
            }],
            "truncated": false,
            "impactToken": "a".repeat(64)
        })).unwrap();
        assert!(validate_demo_deletion_impact(impact, "demo-a").is_some());
    }

    #[tokio::test]
    async fn settings_demo_delete_uses_only_bounded_ids_and_an_impact_header() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let read = stream.read(&mut request).unwrap();
            let body = serde_json::json!({
                "deleted": true,
                "targetId": "demo-a",
                "removedReviewCount": 2,
                "removedDemo": true
            }).to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            ).unwrap();
            String::from_utf8_lossy(&request[..read]).into_owned()
        });
        let result = request_admin_library_delete_demo(
            format!("http://127.0.0.1:{port}"),
            "d".repeat(43),
            "demo-a".to_owned(),
            "a".repeat(64),
        ).await.expect("valid deletion result");
        assert_eq!(result.removed_review_count, 2);
        let request = server.join().unwrap();
        assert!(request.starts_with("DELETE /_desktop/library/demos/demo-a HTTP/1.1\r\n"));
        assert!(request.contains("X-Cs-Agent-Library-Impact-Token: "));
        assert!(request.contains("Content-Length: 0\r\n"));
        assert!(!request.contains("/private/"));
    }

    #[test]
    fn backup_summary_is_constrained_to_private_regular_backup_files() {
        let root = tempdir().unwrap();
        let backups = root.path().join("backups");
        fs::create_dir(&backups).unwrap();
        let database = backups.join("cs-agent-pre-update-0.1.0-fixture.sqlite3");
        let manifest = PathBuf::from(format!("{}.manifest.json", database.display()));
        fs::write(&database, b"database").unwrap();
        fs::write(&manifest, b"manifest").unwrap();
        let response = BackupResponse {
            schema_version: "desktop-runtime-backup.v1".to_owned(),
            database_path: database.display().to_string(),
            manifest_path: manifest.display().to_string(),
            created_at: "2026-08-30T00:00:00.000Z".to_owned(),
            database_sha256: "a".repeat(64),
            migration_count: 2,
        };
        assert!(validate_backup_response(response, root.path()).is_some());

        let outside = root.path().join("outside.sqlite3");
        fs::write(&outside, b"outside").unwrap();
        let forged = BackupResponse {
            schema_version: "desktop-runtime-backup.v1".to_owned(),
            database_path: outside.display().to_string(),
            manifest_path: format!("{}.manifest.json", outside.display()),
            created_at: "2026-08-30T00:00:00.000Z".to_owned(),
            database_sha256: "a".repeat(64),
            migration_count: 2,
        };
        assert!(validate_backup_response(forged, root.path()).is_none());
    }
}

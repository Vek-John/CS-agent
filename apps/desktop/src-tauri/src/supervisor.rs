use crate::{
    local_log,
    protocol::{RuntimeInit, RuntimeReady, READY_SCHEMA, TARGET_TRIPLE},
    updater::VerifiedUpdateBackup,
};
use serde::{Deserialize, Serialize};
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

mod local_log;
mod protocol;
mod provider;
mod supervisor;
pub mod updater;

use provider::{DesktopPaths, ProviderManager, ProviderSaveInput, ProviderStatus};
use serde::Deserialize;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use supervisor::{
    PublicRuntimeStatus, ReviewLibraryCacheCleanup, ReviewLibraryDeleteResult,
    ReviewLibraryDemoDeletionImpact, ReviewLibraryEntries, ReviewLibraryStats,
    ReviewLibraryVerificationSummary, Supervisor,
};
use tauri::{
    menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem},
    webview::{NewWindowResponse, WebviewWindowBuilder},
    AppHandle, Manager, RunEvent, Runtime, WebviewUrl,
};
use updater::{
    require_idle_for_install, PublicUpdateStatus, UpdateError, UpdateManager, UPDATER_TARGET,
};

#[tauri::command]
fn runtime_status(supervisor: tauri::State<'_, Supervisor>) -> PublicRuntimeStatus {
    supervisor.public_status()
}

#[tauri::command]
fn provider_status(
    provider: tauri::State<'_, ProviderManager>,
) -> Result<ProviderStatus, &'static str> {
    provider.status()
}

#[tauri::command]
fn provider_validate(
    provider: tauri::State<'_, ProviderManager>,
    input: ProviderSaveInput,
) -> Result<ProviderStatus, &'static str> {
    provider.validate(input)
}

#[tauri::command]
fn provider_save(
    provider: tauri::State<'_, ProviderManager>,
    input: ProviderSaveInput,
) -> Result<ProviderStatus, &'static str> {
    provider.save(input)
}

#[tauri::command]
fn provider_delete(
    provider: tauri::State<'_, ProviderManager>,
) -> Result<ProviderStatus, &'static str> {
    provider.delete()
}

#[tauri::command]
fn desktop_paths(app: AppHandle) -> Result<DesktopPaths, &'static str> {
    let data_dir = app.path().app_data_dir().map_err(|_| "PATHS_UNAVAILABLE")?;
    Ok(DesktopPaths {
        data_dir: data_dir.display().to_string(),
        database_path: data_dir.join("cs-agent.sqlite3").display().to_string(),
        cache_dir: app
            .path()
            .app_cache_dir()
            .map_err(|_| "PATHS_UNAVAILABLE")?
            .display()
            .to_string(),
        log_dir: app
            .path()
            .app_log_dir()
            .map_err(|_| "PATHS_UNAVAILABLE")?
            .display()
            .to_string(),
        backup_available: true,
        export_available: true,
    })
}

#[tauri::command]
fn open_memory(
    app: AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
) -> Result<(), &'static str> {
    supervisor.open_memory(&app)?;
    local_log::record(&app, "MEMORY_MANAGER_OPENED");
    Ok(())
}

#[tauri::command]
fn open_log_directory(app: AppHandle) -> Result<(), &'static str> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|_| "LOG_DIRECTORY_UNAVAILABLE")?;
    fs::create_dir_all(&directory).map_err(|_| "LOG_DIRECTORY_UNAVAILABLE")?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|_| "LOG_DIRECTORY_UNAVAILABLE")?;
    let status = Command::new("/usr/bin/open")
        .env_clear()
        .arg(&directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "LOG_DIRECTORY_UNAVAILABLE")?;
    if !status.success() {
        return Err("LOG_DIRECTORY_UNAVAILABLE");
    }
    local_log::record(&app, "LOG_DIRECTORY_OPENED");
    Ok(())
}

#[tauri::command]
fn open_library_directory(app: AppHandle) -> Result<(), &'static str> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "LIBRARY_DIRECTORY_UNAVAILABLE")?
        .join("library");
    fs::create_dir_all(&directory).map_err(|_| "LIBRARY_DIRECTORY_UNAVAILABLE")?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|_| "LIBRARY_DIRECTORY_UNAVAILABLE")?;
    let status = Command::new("/usr/bin/open")
        .env_clear()
        .arg(&directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "LIBRARY_DIRECTORY_UNAVAILABLE")?;
    if !status.success() {
        return Err("LIBRARY_DIRECTORY_UNAVAILABLE");
    }
    local_log::record(&app, "REVIEW_LIBRARY_OPENED");
    Ok(())
}

#[tauri::command]
async fn review_library_stats(
    supervisor: tauri::State<'_, Supervisor>,
) -> Result<ReviewLibraryStats, &'static str> {
    supervisor
        .review_library_stats()
        .await
        .ok_or("REVIEW_LIBRARY_UNAVAILABLE")
}

#[tauri::command]
async fn review_library_verify(
    supervisor: tauri::State<'_, Supervisor>,
) -> Result<ReviewLibraryVerificationSummary, &'static str> {
    supervisor
        .review_library_verify()
        .await
        .ok_or("REVIEW_LIBRARY_VERIFY_UNAVAILABLE")
}

#[tauri::command]
async fn review_library_clear_cache(
    supervisor: tauri::State<'_, Supervisor>,
) -> Result<ReviewLibraryCacheCleanup, &'static str> {
    supervisor
        .review_library_clear_cache()
        .await
        .ok_or("REVIEW_LIBRARY_CACHE_CLEANUP_UNAVAILABLE")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewLibraryObjectInput {
    object_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewLibraryDemoDeleteInput {
    demo_id: String,
    impact_token: String,
}

#[tauri::command]
async fn review_library_entries(
    supervisor: tauri::State<'_, Supervisor>,
) -> Result<ReviewLibraryEntries, &'static str> {
    supervisor
        .review_library_entries()
        .await
        .ok_or("REVIEW_LIBRARY_UNAVAILABLE")
}

#[tauri::command]
async fn review_library_demo_impact(
    supervisor: tauri::State<'_, Supervisor>,
    input: ReviewLibraryObjectInput,
) -> Result<ReviewLibraryDemoDeletionImpact, &'static str> {
    supervisor
        .review_library_demo_impact(input.object_id)
        .await
        .ok_or("REVIEW_LIBRARY_IMPACT_UNAVAILABLE")
}

#[tauri::command]
async fn review_library_delete_review(
    app: AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    input: ReviewLibraryObjectInput,
) -> Result<ReviewLibraryDeleteResult, &'static str> {
    let result = supervisor
        .review_library_delete_review(input.object_id)
        .await
        .ok_or("REVIEW_LIBRARY_DELETE_UNAVAILABLE")?;
    local_log::record(&app, "REVIEW_LIBRARY_REVIEW_DELETED");
    Ok(result)
}

#[tauri::command]
async fn review_library_delete_demo(
    app: AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    input: ReviewLibraryDemoDeleteInput,
) -> Result<ReviewLibraryDeleteResult, &'static str> {
    let result = supervisor
        .review_library_delete_demo(input.demo_id, input.impact_token)
        .await?;
    local_log::record(&app, "REVIEW_LIBRARY_DEMO_DELETED");
    Ok(result)
}

#[tauri::command]
async fn runtime_restart(
    app: AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
) -> Result<(), &'static str> {
    supervisor.shutdown(&app).await;
    app.restart()
}

fn app_version(app: &AppHandle) -> Result<semver::Version, &'static str> {
    semver::Version::parse(&app.package_info().version.to_string())
        .map_err(|_| "UPDATE_VERSION_INVALID")
}

async fn restart_runtime_for_settings(app: &AppHandle, supervisor: &Supervisor) {
    supervisor.shutdown(app).await;
    if supervisor.start(app.clone()).await.is_ok() {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
        if let Some(settings) = app.get_webview_window("settings") {
            let _ = settings.show();
            let _ = settings.set_focus();
        }
    }
}

#[tauri::command]
fn update_status(
    app: AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    updater: tauri::State<'_, UpdateManager>,
) -> Result<PublicUpdateStatus, &'static str> {
    Ok(updater.status(
        &app_version(&app)?,
        supervisor.coaching_busy(&app),
        supervisor.review_ended_for_update(),
    ))
}

#[tauri::command]
async fn update_check(
    app: AppHandle,
    updater: tauri::State<'_, UpdateManager>,
) -> Result<(), &'static str> {
    local_log::record(&app, "UPDATE_CHECK_REQUESTED");
    updater.check(&app).await.map_err(UpdateError::code)
}

#[tauri::command]
async fn update_download_stage(
    app: AppHandle,
    updater: tauri::State<'_, UpdateManager>,
) -> Result<(), &'static str> {
    local_log::record(&app, "UPDATE_DOWNLOAD_REQUESTED");
    updater
        .download_and_stage(&app)
        .await
        .map_err(UpdateError::code)
}

#[tauri::command]
async fn update_install(
    app: AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    updater: tauri::State<'_, UpdateManager>,
) -> Result<(), &'static str> {
    local_log::record(&app, "UPDATE_INSTALL_REQUESTED");
    if let Err(error) = require_idle_for_install(supervisor.coaching_busy(&app)) {
        updater.report_error(error);
        return Err(error.code());
    }
    let Some(backup) = supervisor.backup_before_update(&app).await else {
        updater.report_error(UpdateError::BackupRequired);
        restart_runtime_for_settings(&app, &supervisor).await;
        return Err(UpdateError::BackupRequired.code());
    };
    supervisor.shutdown(&app).await;
    if let Err(error) = updater.install_current_app(&backup) {
        // RENAME_SWAP is all-or-nothing. If any preflight or swap boundary
        // rejects the update, restore the unchanged runtime for the user.
        restart_runtime_for_settings(&app, &supervisor).await;
        return Err(error.code());
    }
    // Download and install remain separate confirmations. Once the atomic
    // swap succeeds, the confirmed install action always enters the new app;
    // RELAUNCH_REQUIRED remains only if the platform restart call rejects.
    updater.relaunch(&app).map_err(UpdateError::code)
}

#[tauri::command]
fn update_relaunch(
    app: AppHandle,
    updater: tauri::State<'_, UpdateManager>,
) -> Result<(), &'static str> {
    updater.relaunch(&app).map_err(UpdateError::code)
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), &'static str> {
    show_settings(&app)?;
    local_log::record(&app, "SETTINGS_OPENED");
    Ok(())
}

#[tauri::command]
async fn update_end_review(
    app: AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    updater: tauri::State<'_, UpdateManager>,
) -> Result<(), &'static str> {
    if !updater.has_staged_update() {
        return Err("UPDATE_STATE_INVALID");
    }
    supervisor.end_review_for_update(&app).await?;
    local_log::record(&app, "UPDATE_REVIEW_ENDED");
    Ok(())
}

#[tauri::command]
fn update_open_fallback(
    app: AppHandle,
    updater: tauri::State<'_, UpdateManager>,
) -> Result<(), &'static str> {
    let url = updater
        .verified_fallback_dmg_url()
        .map_err(UpdateError::code)?;
    let status = Command::new("/usr/bin/open")
        .env_clear()
        .arg(url.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "UPDATE_DMG_OPEN_FAILED")?;
    if !status.success() {
        return Err("UPDATE_DMG_OPEN_FAILED");
    }
    local_log::record(&app, "UPDATE_DMG_FALLBACK_OPENED");
    Ok(())
}

fn show_settings<R: Runtime>(app: &AppHandle<R>) -> Result<(), &'static str> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|_| "SETTINGS_UNAVAILABLE")?;
        window.set_focus().map_err(|_| "SETTINGS_UNAVAILABLE")?;
        return Ok(());
    }
    let window =
        WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
            .title("CS Agent 设置")
            .inner_size(680.0, 720.0)
            .min_inner_size(520.0, 520.0)
            .resizable(true)
            .on_navigation(is_bundled_url)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .build()
            .map_err(|_| "SETTINGS_UNAVAILABLE")?;
    let settings_on_close = window.clone();
    let app_on_close = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let app = app_on_close.clone();
            let supervisor = app.state::<Supervisor>().inner().clone();
            let settings = settings_on_close.clone();
            tauri::async_runtime::spawn(async move {
                if supervisor.review_ended_for_update() {
                    if supervisor.resume_review(&app).await.is_ok() {
                        local_log::record(&app, "UPDATE_REVIEW_RESUMED");
                    }
                } else {
                    let _ = settings.hide();
                }
            });
        }
    });
    Ok(())
}

#[tauri::command]
async fn hide_settings(
    app: AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
) -> Result<(), &'static str> {
    if supervisor.review_ended_for_update() {
        supervisor.resume_review(&app).await?;
        local_log::record(&app, "UPDATE_REVIEW_RESUMED");
        return Ok(());
    }
    let window = app
        .get_webview_window("settings")
        .ok_or("SETTINGS_UNAVAILABLE")?;
    window.hide().map_err(|_| "SETTINGS_UNAVAILABLE")
}

fn is_bundled_url(url: &url::Url) -> bool {
    matches!(url.scheme(), "tauri" | "asset") && url.host_str() == Some("localhost")
}

const SETTINGS_MENU_ID: &str = "cs-agent-settings";

fn desktop_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let settings = MenuItemBuilder::with_id(SETTINGS_MENU_ID, "设置…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        app_menu.insert_items(&[&settings, &separator], 2)?;
    }
    Ok(menu)
}

pub fn run() {
    let supervisor = Supervisor::default();
    let startup_supervisor = supervisor.clone();
    let bootstrap_navigation = Arc::new(AtomicBool::new(true));
    let bootstrap_for_navigation = Arc::clone(&bootstrap_navigation);
    let navigation_supervisor = supervisor.clone();

    let builder = tauri::Builder::default()
        // Single-instance must be the first registered plugin.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let label = if app.state::<Supervisor>().public_status().state == "ready" {
                "main"
            } else {
                "bootstrap"
            };
            let target = app.get_webview_window(label);
            if let Some(window) = target {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .target(UPDATER_TARGET)
                .build(),
        )
        .menu(desktop_menu)
        .on_menu_event(|app, event| {
            if event.id() == SETTINGS_MENU_ID {
                let _ = show_settings(app);
                local_log::record(app, "SETTINGS_OPENED");
            }
        })
        .manage(supervisor.clone())
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            open_settings,
            provider_status,
            provider_validate,
            provider_save,
            provider_delete,
            desktop_paths,
            open_memory,
            open_log_directory,
            open_library_directory,
            review_library_stats,
            review_library_entries,
            review_library_demo_impact,
            review_library_delete_review,
            review_library_delete_demo,
            review_library_verify,
            review_library_clear_cache,
            runtime_restart,
            update_status,
            update_check,
            update_download_stage,
            update_end_review,
            update_install,
            update_relaunch,
            update_open_fallback,
            hide_settings
        ])
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            local_log::record(app.handle(), "HOST_START");
            app.manage(ProviderManager::new(data_dir.clone()));
            app.manage(UpdateManager::new(data_dir));
            let bootstrap =
                WebviewWindowBuilder::new(app, "bootstrap", WebviewUrl::App("index.html".into()))
                    .title("CS Agent Coach")
                    .inner_size(620.0, 500.0)
                    .min_inner_size(520.0, 420.0)
                    .resizable(true)
                    .visible(false)
                    .on_navigation(is_bundled_url)
                    .on_new_window(|_, _| NewWindowResponse::Deny)
                    .build()?;

            let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("CS Agent Coach")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1180.0, 720.0)
                .resizable(true)
                .visible(false)
                .on_navigation(move |url| {
                    if bootstrap_for_navigation.load(Ordering::Acquire) && is_bundled_url(url) {
                        return true;
                    }
                    navigation_supervisor.allows_navigation(url)
                })
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            bootstrap_navigation.store(false, Ordering::Release);

            let main_on_close = main.clone();
            main.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = main_on_close.hide();
                }
            });

            let _ = main.hide();
            bootstrap.show()?;
            bootstrap.set_focus()?;

            let app_handle = app.handle().clone();
            let runtime_supervisor = startup_supervisor.clone();
            tauri::async_runtime::spawn(async move {
                let startup = runtime_supervisor.start(app_handle.clone()).await;
                if let Ok(version) =
                    semver::Version::parse(&app_handle.package_info().version.to_string())
                {
                    let update_manager = app_handle.state::<UpdateManager>().inner().clone();
                    if startup.is_ok() {
                        update_manager.confirm_healthy_version(&version);
                        if update_manager.automatic_check(&app_handle).await {
                            let _ = show_settings(&app_handle);
                        }
                    } else if update_manager
                        .rollback_failed_pending_update(&version)
                        .unwrap_or(false)
                    {
                        // The current process is the failed new version. The
                        // atomic swap restored the previous bundle at this
                        // executable path; restart exactly once into it.
                        app_handle.restart();
                    }
                }
            });
            Ok(())
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("failed to build CS Agent desktop host");
    let shutdown_supervisor = supervisor;
    let shutting_down = Arc::new(AtomicBool::new(false));

    app.run(move |app, event| match event {
        RunEvent::Exit => {
            local_log::record(app, "HOST_EXIT");
            shutdown_supervisor.terminate_now();
        }
        RunEvent::ExitRequested { api, .. } => {
            if !shutting_down.swap(true, Ordering::AcqRel) {
                api.prevent_exit();
                let app = app.clone();
                let supervisor = shutdown_supervisor.clone();
                tauri::async_runtime::spawn(async move {
                    supervisor.shutdown(&app).await;
                    app.exit(0);
                });
            }
        }
        RunEvent::Reopen { .. } => {
            let label = if app.state::<Supervisor>().public_status().state == "ready" {
                "main"
            } else {
                "bootstrap"
            };
            let target = app.get_webview_window(label);
            if let Some(window) = target {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}

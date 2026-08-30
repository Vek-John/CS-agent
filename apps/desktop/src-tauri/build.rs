fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let config_bytes = std::fs::read("tauri.conf.json").expect("failed to read tauri.conf.json");
    let config: serde_json::Value =
        serde_json::from_slice(&config_bytes).expect("failed to parse tauri.conf.json");
    let endpoints = config
        .pointer("/plugins/updater/endpoints")
        .and_then(serde_json::Value::as_array)
        .expect("updater endpoints must be an array");
    assert!(
        endpoints.len() == 1
            && endpoints[0].as_str()
                == Some(
                    "https://github.com/Vek-John/CS-agent/releases/latest/download/latest.json",
                ),
        "updater endpoint must remain the frozen HTTPS GitHub manifest"
    );
    let public_key = config
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 4096
                && !value
                    .as_bytes()
                    .iter()
                    .any(|byte| matches!(byte, b'\r' | b'\n'))
        })
        .expect("updater public key must be a bounded single-line string");
    println!("cargo:rustc-env=CS_AGENT_UPDATER_PUBLIC_KEY={public_key}");

    let manifest = tauri_build::AppManifest::new().commands(&[
        "runtime_status",
        "open_settings",
        "provider_status",
        "provider_validate",
        "provider_save",
        "provider_delete",
        "desktop_paths",
        "open_memory",
        "open_log_directory",
        "runtime_restart",
        "update_status",
        "update_check",
        "update_download_stage",
        "update_end_review",
        "update_install",
        "update_relaunch",
        "update_open_fallback",
        "hide_settings",
    ]);

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build the Tauri application manifest");
}

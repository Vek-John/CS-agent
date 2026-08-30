use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Runtime};

const LOG_FILE: &str = "desktop.log";
const ARCHIVE_FILE: &str = "desktop.log.1";
const MAX_LOG_BYTES: u64 = 512 * 1024;

/// Records only a stable lifecycle code. Paths, tokens, Demo names, provider
/// responses, prompts and Memory content never enter this log interface.
pub fn record<R: Runtime>(app: &AppHandle<R>, event: &'static str) {
    if !valid_event(event) {
        return;
    }
    let Ok(directory) = app.path().app_log_dir() else {
        return;
    };
    let _ = append_at(&directory, event, MAX_LOG_BYTES);
}

fn valid_event(event: &str) -> bool {
    (1..=64).contains(&event.len())
        && event
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte == b'_' || byte.is_ascii_digit())
}

fn append_at(directory: &Path, event: &str, max_bytes: u64) -> std::io::Result<()> {
    if !valid_event(event) || max_bytes < 128 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid local log input",
        ));
    }
    fs::create_dir_all(directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    let path = directory.join(LOG_FILE);
    let archive = directory.join(ARCHIVE_FILE);
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let line = format!("{{\"time\":{seconds},\"event\":\"{event}\"}}\n");

    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unsafe local log target",
            ));
        }
        if metadata.len().saturating_add(line.len() as u64) > max_bytes {
            if let Ok(archive_metadata) = fs::symlink_metadata(&archive) {
                if archive_metadata.file_type().is_symlink() || !archive_metadata.is_file() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "unsafe local log archive",
                    ));
                }
                fs::remove_file(&archive)?;
            }
            fs::rename(&path, &archive)?;
        }
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)?;
    file.write_all(line.as_bytes())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn lifecycle_log_is_bounded_private_and_contains_only_event_codes() {
        let root = tempdir().unwrap();
        append_at(root.path(), "HOST_START", 256).unwrap();
        append_at(root.path(), "RUNTIME_READY", 256).unwrap();
        let current = root.path().join(LOG_FILE);
        let text = fs::read_to_string(&current).unwrap();
        assert!(text.contains("\"event\":\"HOST_START\""));
        assert!(text.contains("\"event\":\"RUNTIME_READY\""));
        assert_eq!(
            fs::metadata(&current).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(root.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );

        for _ in 0..20 {
            append_at(root.path(), "RUNTIME_READY", 256).unwrap();
        }
        assert!(root.path().join(ARCHIVE_FILE).is_file());
        assert!(fs::metadata(root.path().join(LOG_FILE)).unwrap().len() <= 256);
        assert!(fs::metadata(root.path().join(ARCHIVE_FILE)).unwrap().len() <= 256);
    }

    #[test]
    fn lifecycle_log_rejects_unbounded_or_sensitive_free_form_values() {
        let root = tempdir().unwrap();
        assert!(append_at(root.path(), "TOKEN=do-not-log", 256).is_err());
        assert!(append_at(root.path(), "demo.dem", 256).is_err());
        assert!(!root.path().join(LOG_FILE).exists());
    }
}

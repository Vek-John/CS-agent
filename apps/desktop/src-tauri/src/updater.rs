use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    ffi::CString,
    fs,
    io::{Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::UpdaterExt;
use tokio::io::AsyncWriteExt;
use url::Url;

const PUBLIC_KEY: &str = env!("CS_AGENT_UPDATER_PUBLIC_KEY");
const TARGET: &str = "darwin-aarch64";
pub const UPDATER_TARGET: &str = TARGET;
const IDENTIFIER: &str = "com.csagent.coach";
const MAX_DOWNLOAD_BYTES: u64 = 450 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 1536 * 1024 * 1024;
const MAX_ARCHIVE_FILES: usize = 50_000;
const RECEIPT_FILE: &str = "pending-update.json";
const ROLLBACK_RECEIPT_FILE: &str = "rolled-back-update.json";
const LAST_AUTOMATIC_CHECK_FILE: &str = "last-automatic-update-check";
const AUTOMATIC_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Debug)]
pub struct VerifiedUpdateBackup {
    pub database_path: PathBuf,
    pub manifest_path: PathBuf,
    pub database_sha256: String,
    pub migration_count: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicUpdateStatus {
    phase: &'static str,
    current_version: String,
    available_version: Option<String>,
    release_notes: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    progress_percent: Option<u8>,
    error_code: Option<&'static str>,
    fallback_dmg_url: Option<String>,
    public_updates_configured: bool,
    coaching_busy: bool,
    review_ended_for_update: bool,
    can_check: bool,
    can_download: bool,
    can_end_review: bool,
    can_resume_review: bool,
    can_install: bool,
    can_relaunch: bool,
}

#[derive(Clone, Debug)]
struct AvailableUpdate {
    version: Version,
    download_url: Url,
    signature: String,
    release_notes: Option<String>,
}

#[derive(Clone, Debug)]
struct StagedUpdate {
    version: Version,
    staging_root: PathBuf,
    new_app: PathBuf,
}

#[derive(Debug)]
struct UpdateState {
    phase: &'static str,
    available: Option<AvailableUpdate>,
    staged: Option<StagedUpdate>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    error_code: Option<&'static str>,
    fallback_dmg_url: Option<String>,
    can_relaunch: bool,
}

#[derive(Clone, Debug)]
pub struct UpdateManager {
    inner: Arc<Mutex<UpdateState>>,
    data_dir: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum UpdateError {
    #[error("UPDATE_PUBLIC_KEY_NOT_CONFIGURED")]
    PublicKeyNotConfigured,
    #[error("UPDATE_CHECK_FAILED")]
    CheckFailed,
    #[error("UPDATE_MANIFEST_INVALID")]
    ManifestInvalid,
    #[error("UPDATE_NOT_AVAILABLE")]
    NotAvailable,
    #[error("UPDATE_DOWNLOAD_FAILED")]
    DownloadFailed,
    #[error("UPDATE_DOWNLOAD_TOO_LARGE")]
    DownloadTooLarge,
    #[error("UPDATE_SIGNATURE_INVALID")]
    SignatureInvalid,
    #[error("UPDATE_STAGE_FAILED")]
    StageFailed,
    #[error("UPDATE_ARCHIVE_INVALID")]
    ArchiveInvalid,
    #[error("UPDATE_APP_INVALID")]
    AppInvalid,
    #[error("UPDATE_COACHING_BUSY")]
    CoachingBusy,
    #[error("UPDATE_BACKUP_REQUIRED")]
    BackupRequired,
    #[error("UPDATE_ATOMIC_SWAP_UNAVAILABLE")]
    AtomicSwapUnavailable,
    #[error("UPDATE_DMG_FALLBACK_REQUIRED")]
    DmgFallbackRequired,
    #[error("UPDATE_RELAUNCH_UNAVAILABLE")]
    RelaunchUnavailable,
    #[error("UPDATE_STATE_INVALID")]
    StateInvalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SignatureVerificationError {
    #[error("VERIFY_PUBLIC_KEY_INVALID")]
    PublicKeyInvalid,
    #[error("VERIFY_SIGNATURE_INVALID")]
    SignatureInvalid,
    #[error("VERIFY_ARCHIVE_INVALID")]
    ArchiveInvalid,
    #[error("VERIFY_ARCHIVE_TOO_LARGE")]
    ArchiveTooLarge,
}

impl SignatureVerificationError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::PublicKeyInvalid => "VERIFY_PUBLIC_KEY_INVALID",
            Self::SignatureInvalid => "VERIFY_SIGNATURE_INVALID",
            Self::ArchiveInvalid => "VERIFY_ARCHIVE_INVALID",
            Self::ArchiveTooLarge => "VERIFY_ARCHIVE_TOO_LARGE",
        }
    }
}

impl UpdateManager {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            inner: Arc::new(Mutex::new(UpdateState {
                phase: if public_key().is_some() {
                    "IDLE"
                } else {
                    "UNAVAILABLE"
                },
                available: None,
                staged: None,
                downloaded_bytes: 0,
                total_bytes: None,
                error_code: if public_key().is_some() {
                    None
                } else {
                    Some("UPDATE_PUBLIC_KEY_NOT_CONFIGURED")
                },
                fallback_dmg_url: None,
                can_relaunch: false,
            })),
        }
    }

    pub fn status(
        &self,
        current_version: &Version,
        coaching_busy: bool,
        review_ended_for_update: bool,
    ) -> PublicUpdateStatus {
        let state = self.inner.lock().expect("updater lock poisoned");
        let available_version = state
            .available
            .as_ref()
            .map(|value| value.version.to_string());
        let release_notes = state
            .available
            .as_ref()
            .and_then(|value| value.release_notes.clone());
        let progress_percent = state.total_bytes.and_then(|total| {
            (total > 0)
                .then(|| ((state.downloaded_bytes.saturating_mul(100) / total).min(100)) as u8)
        });
        PublicUpdateStatus {
            phase: state.phase,
            current_version: current_version.to_string(),
            available_version,
            release_notes,
            downloaded_bytes: state.downloaded_bytes,
            total_bytes: state.total_bytes,
            progress_percent,
            error_code: state.error_code,
            fallback_dmg_url: state.fallback_dmg_url.clone(),
            public_updates_configured: public_key().is_some(),
            coaching_busy,
            review_ended_for_update,
            can_check: public_key().is_some() && check_allowed(state.phase),
            can_download: state.phase == "AVAILABLE",
            can_end_review: state.phase == "STAGED" && !review_ended_for_update,
            can_resume_review: review_ended_for_update,
            can_install: state.phase == "STAGED" && !coaching_busy,
            can_relaunch: state.can_relaunch,
        }
    }

    pub fn has_staged_update(&self) -> bool {
        self.inner.lock().expect("updater lock poisoned").phase == "STAGED"
    }

    pub fn verified_fallback_dmg_url(&self) -> Result<Url, UpdateError> {
        let state = self.inner.lock().expect("updater lock poisoned");
        if state.phase != "DMG_FALLBACK" {
            return Err(UpdateError::StateInvalid);
        }
        let version = state
            .available
            .as_ref()
            .map(|available| &available.version)
            .ok_or(UpdateError::StateInvalid)?;
        let expected = dmg_fallback_url(version);
        if state.fallback_dmg_url.as_deref() != Some(expected.as_str()) {
            return Err(UpdateError::ManifestInvalid);
        }
        let url = Url::parse(&expected).map_err(|_| UpdateError::ManifestInvalid)?;
        validate_dmg_fallback_url(&url, version)?;
        Ok(url)
    }

    pub async fn check<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), UpdateError> {
        if public_key().is_none() {
            return self.fail(UpdateError::PublicKeyNotConfigured, None);
        }
        if !check_allowed(self.inner.lock().expect("updater lock poisoned").phase) {
            return Err(UpdateError::StateInvalid);
        }
        self.set_phase("CHECKING", None);
        let updater = app
            .updater_builder()
            .target(TARGET)
            .timeout(Duration::from_secs(20))
            .build();
        let updater = match updater {
            Ok(value) => value,
            Err(_) => return self.fail(UpdateError::CheckFailed, None),
        };
        let update = match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => {
                self.set_phase("CURRENT", None);
                return Ok(());
            }
            Err(_) => return self.fail(UpdateError::CheckFailed, None),
        };
        let current = match Version::parse(&app.package_info().version.to_string()) {
            Ok(value) => value,
            Err(_) => return self.fail(UpdateError::ManifestInvalid, None),
        };
        let available = match validate_update_metadata(
            &update.raw_json,
            &current,
            &update.version,
            &update.download_url,
            &update.signature,
        ) {
            Ok(value) => value,
            Err(error) => return self.fail(error, None),
        };
        let mut state = self.inner.lock().expect("updater lock poisoned");
        cleanup_staged(state.staged.take());
        state.phase = "AVAILABLE";
        state.fallback_dmg_url = Some(dmg_fallback_url(&available.version));
        state.available = Some(available);
        state.downloaded_bytes = 0;
        state.total_bytes = None;
        state.error_code = None;
        state.can_relaunch = false;
        Ok(())
    }

    pub async fn automatic_check<R: Runtime>(&self, app: &AppHandle<R>) -> bool {
        if public_key().is_none() || !automatic_check_due(&self.data_dir) {
            return false;
        }
        // Record the attempt before network I/O so a transient failure cannot
        // create an update-request loop on every process restart.
        if record_automatic_check(&self.data_dir).is_err() {
            return false;
        }
        let completed = self.check(app).await.is_ok();
        let phase = self.inner.lock().expect("updater lock poisoned").phase;
        automatic_prompt_needed(completed, phase)
    }

    pub async fn download_and_stage<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<(), UpdateError> {
        let available = self
            .inner
            .lock()
            .expect("updater lock poisoned")
            .available
            .clone()
            .ok_or(UpdateError::NotAvailable)?;
        let Some(current_app) = application_bundle_path() else {
            return self.fail(UpdateError::DmgFallbackRequired, Some(&available.version));
        };
        let staging_root = match same_volume_staging(&current_app) {
            Ok(path) => path,
            Err(_) => return self.fail(UpdateError::DmgFallbackRequired, Some(&available.version)),
        };
        let archive_path = staging_root.join("update.app.tar.gz");
        self.set_phase("DOWNLOADING", None);
        if let Err(error) = self.stream_download(app, &available, &archive_path).await {
            let _ = fs::remove_dir_all(&staging_root);
            return self.fail(error, Some(&available.version));
        }
        if let Err(error) = verify_download_signature(&archive_path, &available.signature) {
            let _ = fs::remove_dir_all(&staging_root);
            return self.fail(error, Some(&available.version));
        }
        let version = available.version.clone();
        let extract_root = staging_root.clone();
        let archive = archive_path.clone();
        let new_app = match tauri::async_runtime::spawn_blocking(move || {
            extract_safe_app_archive(&archive, &extract_root)
        })
        .await
        {
            Ok(Ok(path)) => path,
            _ => {
                let _ = fs::remove_dir_all(&staging_root);
                return self.fail(UpdateError::ArchiveInvalid, Some(&version));
            }
        };
        let validated_app = new_app.clone();
        let expected_version = version.clone();
        if !tauri::async_runtime::spawn_blocking(move || {
            validate_app_bundle(&validated_app, &expected_version)
        })
        .await
        .unwrap_or(false)
        {
            let _ = fs::remove_dir_all(&staging_root);
            return self.fail(UpdateError::AppInvalid, Some(&version));
        }
        let _ = fs::remove_file(archive_path);
        let mut state = self.inner.lock().expect("updater lock poisoned");
        cleanup_staged(state.staged.take());
        state.staged = Some(StagedUpdate {
            version,
            staging_root,
            new_app,
        });
        state.phase = "STAGED";
        state.error_code = None;
        Ok(())
    }

    async fn stream_download<R: Runtime>(
        &self,
        _app: &AppHandle<R>,
        available: &AvailableUpdate,
        destination: &Path,
    ) -> Result<(), UpdateError> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(Duration::from_secs(15 * 60))
            .build()
            .map_err(|_| UpdateError::DownloadFailed)?;
        let response = client
            .get(available.download_url.clone())
            .header("Accept", "application/octet-stream")
            .send()
            .await
            .map_err(|_| UpdateError::DownloadFailed)?;
        if !response.status().is_success() || response.url().scheme() != "https" {
            return Err(UpdateError::DownloadFailed);
        }
        let total = response.content_length();
        if total.is_some_and(|value| value == 0 || value > MAX_DOWNLOAD_BYTES) {
            return Err(UpdateError::DownloadTooLarge);
        }
        {
            let mut state = self.inner.lock().expect("updater lock poisoned");
            state.total_bytes = total;
            state.downloaded_bytes = 0;
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(destination)
            .await
            .map_err(|_| UpdateError::StageFailed)?;
        let mut received = 0_u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| UpdateError::DownloadFailed)?;
            received = received
                .checked_add(chunk.len() as u64)
                .ok_or(UpdateError::DownloadTooLarge)?;
            if received > MAX_DOWNLOAD_BYTES || total.is_some_and(|expected| received > expected) {
                return Err(UpdateError::DownloadTooLarge);
            }
            file.write_all(&chunk)
                .await
                .map_err(|_| UpdateError::StageFailed)?;
            self.inner
                .lock()
                .expect("updater lock poisoned")
                .downloaded_bytes = received;
        }
        if received == 0 || total.is_some_and(|expected| expected != received) {
            return Err(UpdateError::DownloadFailed);
        }
        file.flush().await.map_err(|_| UpdateError::StageFailed)?;
        file.sync_all()
            .await
            .map_err(|_| UpdateError::StageFailed)?;
        Ok(())
    }

    pub fn install_staged(
        &self,
        current_app: &Path,
        backup: &VerifiedUpdateBackup,
    ) -> Result<(), UpdateError> {
        self.install_staged_with(current_app, backup, validate_app_bundle, atomic_swap)
    }

    fn install_staged_with<Validate, Swap>(
        &self,
        current_app: &Path,
        backup: &VerifiedUpdateBackup,
        validate: Validate,
        swap: Swap,
    ) -> Result<(), UpdateError>
    where
        Validate: Fn(&Path, &Version) -> bool,
        Swap: Fn(&Path, &Path) -> Result<(), UpdateError>,
    {
        let staged = self
            .inner
            .lock()
            .expect("updater lock poisoned")
            .staged
            .clone()
            .ok_or(UpdateError::NotAvailable)?;
        self.inner.lock().expect("updater lock poisoned").phase = "INSTALLING";
        if fs::metadata(current_app)
            .map(|metadata| metadata.dev())
            .ok()
            != fs::metadata(&staged.new_app)
                .map(|metadata| metadata.dev())
                .ok()
        {
            return self.fail(UpdateError::DmgFallbackRequired, Some(&staged.version));
        }
        if !validate(&staged.new_app, &staged.version) {
            return self.fail(UpdateError::AppInvalid, Some(&staged.version));
        }
        if let Err(error) = write_update_receipt(
            &self.data_dir,
            &staged.version,
            &staged.new_app,
            &staged.staging_root,
            backup,
        ) {
            return self.fail(error, Some(&staged.version));
        }
        if swap(&staged.new_app, current_app).is_err() {
            let _ = fs::remove_file(self.data_dir.join(RECEIPT_FILE));
            return self.fail(UpdateError::AtomicSwapUnavailable, Some(&staged.version));
        }
        let mut state = self.inner.lock().expect("updater lock poisoned");
        state.phase = "RELAUNCH_REQUIRED";
        state.error_code = None;
        state.can_relaunch = true;
        // After RENAME_SWAP this path contains the complete previous app and
        // must survive until the new version reports a healthy runtime.
        state.staged = None;
        Ok(())
    }

    pub fn install_current_app(&self, backup: &VerifiedUpdateBackup) -> Result<(), UpdateError> {
        let Some(current_app) = application_bundle_path() else {
            let version = self
                .inner
                .lock()
                .expect("updater lock poisoned")
                .available
                .as_ref()
                .map(|value| value.version.clone());
            return self.fail(UpdateError::DmgFallbackRequired, version.as_ref());
        };
        self.install_staged(&current_app, backup)
    }

    pub fn report_error(&self, error: UpdateError) {
        if matches!(
            error,
            UpdateError::CoachingBusy | UpdateError::BackupRequired
        ) {
            self.inner.lock().expect("updater lock poisoned").error_code = Some(error.code());
            return;
        }
        let version = self
            .inner
            .lock()
            .expect("updater lock poisoned")
            .available
            .as_ref()
            .map(|value| value.version.clone());
        let _: Result<(), UpdateError> = self.fail(error, version.as_ref());
    }

    pub fn confirm_healthy_version(&self, current_version: &Version) {
        if let Some(current_app) = application_bundle_path() {
            self.confirm_healthy_version_at(current_version, &current_app);
        }
        cleanup_healthy_rollback(&self.data_dir, current_version);
    }

    fn confirm_healthy_version_at(&self, current_version: &Version, current_app: &Path) {
        let receipt_path = self.data_dir.join(RECEIPT_FILE);
        if let Ok(bytes) = fs::read(&receipt_path) {
            if let Ok(receipt) = serde_json::from_slice::<UpdateReceipt>(&bytes) {
                if receipt.schema_version == "desktop-update-receipt.v1"
                    && receipt.version == current_version.to_string()
                {
                    if let Some((staging_root, old_app)) =
                        verified_cleanup_paths(&receipt, current_app)
                    {
                        let _ = fs::remove_dir_all(&old_app);
                        let _ = fs::remove_dir_all(&staging_root);
                        let _ = fs::remove_file(&receipt_path);
                    }
                }
            }
        }
    }

    pub fn rollback_failed_pending_update(
        &self,
        current_version: &Version,
    ) -> Result<bool, UpdateError> {
        let receipt_path = self.data_dir.join(RECEIPT_FILE);
        if self.data_dir.join(ROLLBACK_RECEIPT_FILE).exists() {
            return Ok(false);
        }
        let bytes = match fs::read(&receipt_path) {
            Ok(bytes) => bytes,
            Err(_) => return Ok(false),
        };
        let receipt = match serde_json::from_slice::<UpdateReceipt>(&bytes) {
            Ok(receipt) => receipt,
            Err(_) => return Ok(false),
        };
        if !rollback_receipt_matches(&receipt, current_version) {
            return Ok(false);
        }
        let current_app = application_bundle_path().ok_or(UpdateError::AtomicSwapUnavailable)?;
        let (_, old_app) = verified_cleanup_paths(&receipt, &current_app)
            .ok_or(UpdateError::AtomicSwapUnavailable)?;
        let old_version = bundle_version(&old_app).ok_or(UpdateError::AppInvalid)?;
        if old_version >= *current_version || !validate_app_bundle(&old_app, &old_version) {
            return Err(UpdateError::AppInvalid);
        }
        let displaced_database = restore_backup_for_rollback(&receipt, &self.data_dir)?;
        if let Err(error) = atomic_swap(&old_app, &current_app) {
            let live_database = self.data_dir.join("cs-agent.sqlite3");
            if atomic_swap(&displaced_database, &live_database).is_ok() {
                // The validated backup is again displaced and the future DB
                // is live; only this positively confirmed case is removable.
                let _ = fs::remove_file(&displaced_database);
            }
            return Err(error);
        }
        let _ = fs::remove_file(displaced_database);
        // A successful swap already prevents a loop because the restored app
        // version no longer equals receipt.version. Retire the receipt as an
        // explicit marker; if this rename is interrupted, the mismatch still
        // makes the next launch refuse another rollback.
        let _ = fs::rename(&receipt_path, self.data_dir.join(ROLLBACK_RECEIPT_FILE));
        self.inner.lock().expect("updater lock poisoned").phase = "ROLLED_BACK";
        Ok(true)
    }

    pub fn relaunch<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), UpdateError> {
        if !self
            .inner
            .lock()
            .expect("updater lock poisoned")
            .can_relaunch
        {
            return Err(UpdateError::RelaunchUnavailable);
        }
        app.restart()
    }

    fn set_phase(&self, phase: &'static str, error: Option<&'static str>) {
        let mut state = self.inner.lock().expect("updater lock poisoned");
        state.phase = phase;
        state.error_code = error;
    }

    fn fail<T>(&self, error: UpdateError, version: Option<&Version>) -> Result<T, UpdateError> {
        let mut state = self.inner.lock().expect("updater lock poisoned");
        state.phase = if matches!(
            error,
            UpdateError::DmgFallbackRequired | UpdateError::AtomicSwapUnavailable
        ) {
            "DMG_FALLBACK"
        } else if error == UpdateError::PublicKeyNotConfigured {
            "UNAVAILABLE"
        } else {
            "ERROR"
        };
        state.error_code = Some(error.code());
        if let Some(version) = version {
            state.fallback_dmg_url = Some(dmg_fallback_url(version));
        }
        Err(error)
    }
}

impl UpdateError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::PublicKeyNotConfigured => "UPDATE_PUBLIC_KEY_NOT_CONFIGURED",
            Self::CheckFailed => "UPDATE_CHECK_FAILED",
            Self::ManifestInvalid => "UPDATE_MANIFEST_INVALID",
            Self::NotAvailable => "UPDATE_NOT_AVAILABLE",
            Self::DownloadFailed => "UPDATE_DOWNLOAD_FAILED",
            Self::DownloadTooLarge => "UPDATE_DOWNLOAD_TOO_LARGE",
            Self::SignatureInvalid => "UPDATE_SIGNATURE_INVALID",
            Self::StageFailed => "UPDATE_STAGE_FAILED",
            Self::ArchiveInvalid => "UPDATE_ARCHIVE_INVALID",
            Self::AppInvalid => "UPDATE_APP_INVALID",
            Self::CoachingBusy => "UPDATE_COACHING_BUSY",
            Self::BackupRequired => "UPDATE_BACKUP_REQUIRED",
            Self::AtomicSwapUnavailable => "UPDATE_ATOMIC_SWAP_UNAVAILABLE",
            Self::DmgFallbackRequired => "UPDATE_DMG_FALLBACK_REQUIRED",
            Self::RelaunchUnavailable => "UPDATE_RELAUNCH_UNAVAILABLE",
            Self::StateInvalid => "UPDATE_STATE_INVALID",
        }
    }
}

fn public_key() -> Option<PublicKey> {
    decode_public_key(PUBLIC_KEY).ok()
}

fn verify_download_signature(path: &Path, encoded_signature: &str) -> Result<(), UpdateError> {
    verify_updater_archive_signature(PUBLIC_KEY, path, encoded_signature)
        .map_err(|_| UpdateError::SignatureInvalid)
}

fn decode_public_key(encoded_public_key: &str) -> Result<PublicKey, SignatureVerificationError> {
    if encoded_public_key.is_empty() || encoded_public_key.len() > 4096 {
        return Err(SignatureVerificationError::PublicKeyInvalid);
    }
    let decoded = STANDARD
        .decode(encoded_public_key.trim())
        .map_err(|_| SignatureVerificationError::PublicKeyInvalid)?;
    let text =
        std::str::from_utf8(&decoded).map_err(|_| SignatureVerificationError::PublicKeyInvalid)?;
    PublicKey::decode(text).map_err(|_| SignatureVerificationError::PublicKeyInvalid)
}

pub fn verify_updater_archive_signature(
    encoded_public_key: &str,
    archive_path: &Path,
    encoded_signature: &str,
) -> Result<(), SignatureVerificationError> {
    let key = decode_public_key(encoded_public_key)?;
    let metadata =
        fs::metadata(archive_path).map_err(|_| SignatureVerificationError::ArchiveInvalid)?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(SignatureVerificationError::ArchiveInvalid);
    }
    if metadata.len() > MAX_DOWNLOAD_BYTES {
        return Err(SignatureVerificationError::ArchiveTooLarge);
    }
    if encoded_signature.is_empty() || encoded_signature.len() > 4096 {
        return Err(SignatureVerificationError::SignatureInvalid);
    }
    let signature_bytes = STANDARD
        .decode(encoded_signature)
        .map_err(|_| SignatureVerificationError::SignatureInvalid)?;
    let signature_text = std::str::from_utf8(&signature_bytes)
        .map_err(|_| SignatureVerificationError::SignatureInvalid)?;
    let signature = Signature::decode(signature_text)
        .map_err(|_| SignatureVerificationError::SignatureInvalid)?;
    let mut verifier = key
        .verify_stream(&signature)
        .map_err(|_| SignatureVerificationError::SignatureInvalid)?;
    let mut file =
        fs::File::open(archive_path).map_err(|_| SignatureVerificationError::ArchiveInvalid)?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| SignatureVerificationError::ArchiveInvalid)?;
        if read == 0 {
            break;
        }
        verifier.update(&buffer[..read]);
    }
    verifier
        .finalize()
        .map_err(|_| SignatureVerificationError::SignatureInvalid)
}

fn validate_update_metadata(
    raw: &serde_json::Value,
    current: &Version,
    version_text: &str,
    download_url: &Url,
    signature: &str,
) -> Result<AvailableUpdate, UpdateError> {
    let object = raw.as_object().ok_or(UpdateError::ManifestInvalid)?;
    let allowed = ["version", "notes", "pub_date", "platforms"];
    if object.len() != allowed.len() || !allowed.iter().all(|key| object.contains_key(*key)) {
        return Err(UpdateError::ManifestInvalid);
    }
    let version = Version::parse(version_text).map_err(|_| UpdateError::ManifestInvalid)?;
    if &version <= current
        || object.get("version").and_then(serde_json::Value::as_str) != Some(version_text)
    {
        return Err(UpdateError::ManifestInvalid);
    }
    let release_notes =
        bounded_plain_text_notes(object.get("notes").ok_or(UpdateError::ManifestInvalid)?)?;
    let platforms = object
        .get("platforms")
        .and_then(serde_json::Value::as_object)
        .ok_or(UpdateError::ManifestInvalid)?;
    if platforms.len() != 1 || !platforms.contains_key(TARGET) {
        return Err(UpdateError::ManifestInvalid);
    }
    let target = platforms[TARGET]
        .as_object()
        .ok_or(UpdateError::ManifestInvalid)?;
    if target.len() != 2 || !target.contains_key("signature") || !target.contains_key("url") {
        return Err(UpdateError::ManifestInvalid);
    }
    let expected_url = target["url"].as_str().ok_or(UpdateError::ManifestInvalid)?;
    let expected_signature = target["signature"]
        .as_str()
        .ok_or(UpdateError::ManifestInvalid)?;
    if expected_url != download_url.as_str()
        || expected_signature != signature
        || signature.len() < 40
        || signature.len() > 4096
    {
        return Err(UpdateError::ManifestInvalid);
    }
    validate_download_url(download_url, &version)?;
    Ok(AvailableUpdate {
        version,
        download_url: download_url.clone(),
        signature: signature.to_owned(),
        release_notes,
    })
}

fn validate_download_url(url: &Url, version: &Version) -> Result<(), UpdateError> {
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path()
            != format!(
                "/Vek-John/CS-agent/releases/download/desktop-v{version}/CS-Agent-Coach.app.tar.gz"
            )
    {
        return Err(UpdateError::ManifestInvalid);
    }
    Ok(())
}

fn dmg_fallback_url(version: &Version) -> String {
    format!(
        "https://github.com/Vek-John/CS-agent/releases/download/desktop-v{version}/CS-Agent-Coach_{version}_aarch64.dmg"
    )
}

fn validate_dmg_fallback_url(url: &Url, version: &Version) -> Result<(), UpdateError> {
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path()
            != format!(
                "/Vek-John/CS-agent/releases/download/desktop-v{version}/CS-Agent-Coach_{version}_aarch64.dmg"
            )
    {
        return Err(UpdateError::ManifestInvalid);
    }
    Ok(())
}

fn same_volume_staging(current_app: &Path) -> Result<PathBuf, UpdateError> {
    let parent = current_app.parent().ok_or(UpdateError::StageFailed)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| UpdateError::StageFailed)?
        .as_nanos();
    for sequence in 0..8_u8 {
        let candidate = parent.join(format!(
            ".cs-agent-update-{}-{stamp}-{sequence}",
            std::process::id()
        ));
        match fs::DirBuilder::new().mode(0o700).create(&candidate) {
            Ok(()) => {
                if fs::metadata(parent).map(|metadata| metadata.dev()).ok()
                    == fs::metadata(&candidate).map(|metadata| metadata.dev()).ok()
                {
                    return Ok(candidate);
                }
                let _ = fs::remove_dir(&candidate);
                return Err(UpdateError::StageFailed);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(UpdateError::StageFailed),
        }
    }
    Err(UpdateError::StageFailed)
}

fn safe_archive_path(path: &Path) -> Result<(String, PathBuf), UpdateError> {
    if path.as_os_str().as_bytes().len() > 1024 || path.is_absolute() {
        return Err(UpdateError::ArchiveInvalid);
    }
    let mut components = path.components();
    let Some(Component::Normal(top)) = components.next() else {
        return Err(UpdateError::ArchiveInvalid);
    };
    let top = top.to_str().ok_or(UpdateError::ArchiveInvalid)?.to_owned();
    if !top.ends_with(".app") || top.starts_with('.') {
        return Err(UpdateError::ArchiveInvalid);
    }
    let mut clean = PathBuf::from(&top);
    for component in components {
        match component {
            Component::Normal(value) => clean.push(value),
            _ => return Err(UpdateError::ArchiveInvalid),
        }
    }
    Ok((top, clean))
}

fn extract_safe_app_archive(
    archive_path: &Path,
    staging_root: &Path,
) -> Result<PathBuf, UpdateError> {
    let file = fs::File::open(archive_path).map_err(|_| UpdateError::ArchiveInvalid)?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let mut top_levels = BTreeSet::new();
    let mut expanded = 0_u64;
    let mut files = 0_usize;
    for entry in archive.entries().map_err(|_| UpdateError::ArchiveInvalid)? {
        let mut entry = entry.map_err(|_| UpdateError::ArchiveInvalid)?;
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir()) || kind.is_symlink() || kind.is_hard_link() {
            return Err(UpdateError::ArchiveInvalid);
        }
        files = files.checked_add(1).ok_or(UpdateError::ArchiveInvalid)?;
        if files > MAX_ARCHIVE_FILES {
            return Err(UpdateError::ArchiveInvalid);
        }
        expanded = expanded
            .checked_add(entry.size())
            .ok_or(UpdateError::ArchiveInvalid)?;
        if expanded > MAX_EXPANDED_BYTES {
            return Err(UpdateError::ArchiveInvalid);
        }
        let path = entry.path().map_err(|_| UpdateError::ArchiveInvalid)?;
        let (top, clean) = safe_archive_path(&path)?;
        top_levels.insert(top);
        let destination = staging_root.join(clean);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|_| UpdateError::ArchiveInvalid)?;
        }
        entry
            .unpack(&destination)
            .map_err(|_| UpdateError::ArchiveInvalid)?;
    }
    if top_levels.len() != 1 {
        return Err(UpdateError::ArchiveInvalid);
    }
    let app = staging_root.join(top_levels.into_iter().next().unwrap());
    if !app.is_dir() {
        return Err(UpdateError::ArchiveInvalid);
    }
    Ok(app)
}

fn validate_app_bundle(app: &Path, expected_version: &Version) -> bool {
    let info_path = app.join("Contents/Info.plist");
    let Ok(plist) = plist::Value::from_file(&info_path) else {
        return false;
    };
    let Some(dictionary) = plist.as_dictionary() else {
        return false;
    };
    let expected_version_text = expected_version.to_string();
    if dictionary
        .get("CFBundleIdentifier")
        .and_then(plist::Value::as_string)
        != Some(IDENTIFIER)
        || dictionary
            .get("CFBundleShortVersionString")
            .and_then(plist::Value::as_string)
            != Some(expected_version_text.as_str())
    {
        return false;
    }
    let Some(executable) = dictionary
        .get("CFBundleExecutable")
        .and_then(plist::Value::as_string)
    else {
        return false;
    };
    if executable.is_empty() || executable.contains('/') || executable.contains('\0') {
        return false;
    }
    let executable_path = app.join("Contents/MacOS").join(executable);
    let executable_is_valid = fs::metadata(&executable_path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0);
    if !executable_is_valid
        || !command_success(
            "/usr/bin/lipo",
            &["-archs", path_text(&executable_path)],
            Some("arm64"),
        )
    {
        return false;
    }
    if !walk_macho_arm64(app) {
        return false;
    }
    command_success(
        "/usr/bin/codesign",
        &[
            "--verify",
            "--deep",
            "--strict",
            "--verbose=2",
            path_text(app),
        ],
        None,
    ) && command_success(
        "/usr/sbin/spctl",
        &[
            "--assess",
            "--type",
            "execute",
            "--verbose=4",
            path_text(app),
        ],
        None,
    )
}

fn bundle_version(app: &Path) -> Option<Version> {
    let plist = plist::Value::from_file(app.join("Contents/Info.plist")).ok()?;
    let raw = plist
        .as_dictionary()?
        .get("CFBundleShortVersionString")?
        .as_string()?;
    Version::parse(raw).ok()
}

fn walk_macho_arm64(root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            return false;
        };
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            return false;
        };
        // Signed bundles must not carry set-id/sticky bits or writable
        // group/other permissions into the atomic install boundary.
        if metadata.permissions().mode() & 0o7022 != 0 {
            return false;
        }
        if file_type.is_symlink() {
            return false;
        }
        if file_type.is_dir() {
            if !walk_macho_arm64(&path) {
                return false;
            }
            continue;
        }
        if !file_type.is_file() {
            return false;
        }
        let Ok(output) = Command::new("/usr/bin/file")
            .env_clear()
            .arg("-b")
            .arg(&path)
            .output()
        else {
            return false;
        };
        if output.status.success()
            && String::from_utf8_lossy(&output.stdout).contains("Mach-O")
            && !command_success(
                "/usr/bin/lipo",
                &["-archs", path_text(&path)],
                Some("arm64"),
            )
        {
            return false;
        }
    }
    true
}

fn path_text(path: &Path) -> &str {
    path.to_str().unwrap_or("")
}

fn command_success(command: &str, args: &[&str], expected_stdout: Option<&str>) -> bool {
    let Ok(output) = Command::new(command).env_clear().args(args).output() else {
        return false;
    };
    output.status.success()
        && expected_stdout.map_or(true, |expected| {
            String::from_utf8_lossy(&output.stdout).trim() == expected
        })
}

fn application_bundle_path() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    executable
        .ancestors()
        .find(|path| path.extension().is_some_and(|value| value == "app"))
        .map(Path::to_path_buf)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateReceipt {
    schema_version: String,
    version: String,
    old_app_path: String,
    staging_root: String,
    backup_database_path: String,
    backup_manifest_path: String,
    backup_database_sha256: String,
    backup_migration_count: u64,
}

fn write_update_receipt(
    data_dir: &Path,
    version: &Version,
    old_app_path_after_swap: &Path,
    staging_root: &Path,
    backup: &VerifiedUpdateBackup,
) -> Result<(), UpdateError> {
    fs::create_dir_all(data_dir).map_err(|_| UpdateError::StageFailed)?;
    fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))
        .map_err(|_| UpdateError::StageFailed)?;
    let receipt = UpdateReceipt {
        schema_version: "desktop-update-receipt.v1".to_owned(),
        version: version.to_string(),
        old_app_path: old_app_path_after_swap.display().to_string(),
        staging_root: staging_root.display().to_string(),
        backup_database_path: backup.database_path.display().to_string(),
        backup_manifest_path: backup.manifest_path.display().to_string(),
        backup_database_sha256: backup.database_sha256.clone(),
        backup_migration_count: backup.migration_count,
    };
    let bytes = serde_json::to_vec(&receipt).map_err(|_| UpdateError::StageFailed)?;
    let temporary = data_dir.join(format!(".{RECEIPT_FILE}-{}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| UpdateError::StageFailed)?;
    file.write_all(&bytes)
        .map_err(|_| UpdateError::StageFailed)?;
    file.sync_all().map_err(|_| UpdateError::StageFailed)?;
    if fs::rename(&temporary, data_dir.join(RECEIPT_FILE)).is_err() {
        let _ = fs::remove_file(temporary);
        return Err(UpdateError::StageFailed);
    }
    Ok(())
}

fn verified_cleanup_paths(
    receipt: &UpdateReceipt,
    current_app: &Path,
) -> Option<(PathBuf, PathBuf)> {
    let old_app = PathBuf::from(&receipt.old_app_path);
    let staging_root = PathBuf::from(&receipt.staging_root);
    let staging_name = staging_root.file_name()?.to_str()?;
    let staging_type = fs::symlink_metadata(&staging_root).ok()?.file_type();
    let old_type = fs::symlink_metadata(&old_app).ok()?.file_type();
    if !staging_name.starts_with(".cs-agent-update-")
        || !staging_type.is_dir()
        || !old_type.is_dir()
        || staging_root.parent() != current_app.parent()
        || old_app.parent() != Some(staging_root.as_path())
        || old_app.file_name() != current_app.file_name()
        || old_app.extension().and_then(|value| value.to_str()) != Some("app")
    {
        return None;
    }
    Some((staging_root, old_app))
}

fn rollback_receipt_matches(receipt: &UpdateReceipt, current_version: &Version) -> bool {
    receipt.schema_version == "desktop-update-receipt.v1"
        && Version::parse(&receipt.version).ok().as_ref() == Some(current_version)
}

fn cleanup_healthy_rollback(data_dir: &Path, current_version: &Version) {
    let marker_path = data_dir.join(ROLLBACK_RECEIPT_FILE);
    let Ok(bytes) = fs::read(&marker_path) else {
        return;
    };
    let Ok(receipt) = serde_json::from_slice::<UpdateReceipt>(&bytes) else {
        return;
    };
    let Ok(failed_version) = Version::parse(&receipt.version) else {
        return;
    };
    let Some(current_app) = application_bundle_path() else {
        return;
    };
    let Some((staging_root, failed_app)) = verified_cleanup_paths(&receipt, &current_app) else {
        return;
    };
    if receipt.schema_version != "desktop-update-receipt.v1"
        || failed_version <= *current_version
        || bundle_version(&failed_app).as_ref() != Some(&failed_version)
    {
        return;
    }
    let _ = fs::remove_dir_all(&failed_app);
    let _ = fs::remove_dir_all(&staging_root);
    let _ = fs::remove_file(marker_path);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupManifest {
    schema_version: String,
    created_at: String,
    database_sha256: String,
    migration_ledger: Vec<BackupMigration>,
    database_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupMigration {
    migration_id: String,
    checksum: String,
}

fn restore_backup_for_rollback(
    receipt: &UpdateReceipt,
    data_dir: &Path,
) -> Result<PathBuf, UpdateError> {
    let backup = PathBuf::from(&receipt.backup_database_path);
    let manifest_path = PathBuf::from(&receipt.backup_manifest_path);
    let backup_dir = data_dir.join("backups");
    let backup_name = backup
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(UpdateError::BackupRequired)?;
    if backup.parent() != Some(backup_dir.as_path())
        || !backup_name.starts_with("cs-agent-pre-update-")
        || !backup_name.ends_with(".sqlite3")
        || manifest_path != PathBuf::from(format!("{}.manifest.json", backup.display()))
        || fs::symlink_metadata(&backup)
            .map(|metadata| !metadata.file_type().is_file())
            .unwrap_or(true)
        || fs::symlink_metadata(&manifest_path)
            .map(|metadata| !metadata.file_type().is_file())
            .unwrap_or(true)
    {
        return Err(UpdateError::BackupRequired);
    }
    let manifest_bytes = fs::read(&manifest_path).map_err(|_| UpdateError::BackupRequired)?;
    if manifest_bytes.len() > 1024 * 1024 {
        return Err(UpdateError::BackupRequired);
    }
    let manifest: BackupManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| UpdateError::BackupRequired)?;
    if manifest.schema_version != "desktop-sqlite-backup.v1"
        || manifest.created_at.is_empty()
        || manifest.database_path != receipt.backup_database_path
        || manifest.database_sha256 != receipt.backup_database_sha256
        || manifest.migration_ledger.len() as u64 != receipt.backup_migration_count
        || manifest.migration_ledger.is_empty()
        || manifest.migration_ledger.iter().any(|migration| {
            migration.migration_id.is_empty()
                || migration.checksum.len() != 64
                || !migration
                    .checksum
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
        })
        || sha256_file(&backup)? != receipt.backup_database_sha256
    {
        return Err(UpdateError::BackupRequired);
    }
    let live_database = data_dir.join("cs-agent.sqlite3");
    if !fs::symlink_metadata(&live_database)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
    {
        return Err(UpdateError::BackupRequired);
    }
    let stage = data_dir.join(format!(
        ".rollback-restore-{}-{}.sqlite3",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| UpdateError::BackupRequired)?
            .as_nanos()
    ));
    let mut source = fs::File::open(&backup).map_err(|_| UpdateError::BackupRequired)?;
    let mut target = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&stage)
        .map_err(|_| UpdateError::BackupRequired)?;
    if std::io::copy(&mut source, &mut target).is_err() || target.sync_all().is_err() {
        let _ = fs::remove_file(&stage);
        return Err(UpdateError::BackupRequired);
    }
    if sha256_file(&stage)? != receipt.backup_database_sha256 {
        let _ = fs::remove_file(&stage);
        return Err(UpdateError::BackupRequired);
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", live_database.display(), suffix));
        match fs::symlink_metadata(&sidecar) {
            Ok(metadata) if metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
                if fs::remove_file(&sidecar).is_err() {
                    let _ = fs::remove_file(&stage);
                    return Err(UpdateError::BackupRequired);
                }
            }
            Ok(_) => {
                let _ = fs::remove_file(&stage);
                return Err(UpdateError::BackupRequired);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                let _ = fs::remove_file(&stage);
                return Err(UpdateError::BackupRequired);
            }
        }
        if fs::symlink_metadata(&sidecar).is_ok() {
            let _ = fs::remove_file(&stage);
            return Err(UpdateError::BackupRequired);
        }
    }
    if let Err(error) = atomic_swap(&stage, &live_database) {
        let _ = fs::remove_file(&stage);
        return Err(error);
    }
    if fs::File::open(data_dir)
        .and_then(|directory| directory.sync_all())
        .is_err()
    {
        if atomic_swap(&stage, &live_database).is_ok() {
            let _ = fs::remove_file(&stage);
        }
        return Err(UpdateError::BackupRequired);
    }
    Ok(stage)
}

fn sha256_file(path: &Path) -> Result<String, UpdateError> {
    let mut file = fs::File::open(path).map_err(|_| UpdateError::BackupRequired)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| UpdateError::BackupRequired)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(target_os = "macos")]
fn atomic_swap(first: &Path, second: &Path) -> Result<(), UpdateError> {
    const RENAME_SWAP: u32 = 0x0000_0002;
    unsafe extern "C" {
        fn renamex_np(from: *const libc::c_char, to: *const libc::c_char, flags: u32) -> i32;
    }
    let first = CString::new(first.as_os_str().as_bytes())
        .map_err(|_| UpdateError::AtomicSwapUnavailable)?;
    let second = CString::new(second.as_os_str().as_bytes())
        .map_err(|_| UpdateError::AtomicSwapUnavailable)?;
    let result = unsafe { renamex_np(first.as_ptr(), second.as_ptr(), RENAME_SWAP) };
    if result == 0 {
        Ok(())
    } else {
        Err(UpdateError::AtomicSwapUnavailable)
    }
}

#[cfg(not(target_os = "macos"))]
fn atomic_swap(_first: &Path, _second: &Path) -> Result<(), UpdateError> {
    Err(UpdateError::AtomicSwapUnavailable)
}

fn cleanup_staged(staged: Option<StagedUpdate>) {
    if let Some(staged) = staged {
        let _ = fs::remove_dir_all(staged.staging_root);
    }
}

pub fn require_idle_for_install(coaching_busy: bool) -> Result<(), UpdateError> {
    if coaching_busy {
        Err(UpdateError::CoachingBusy)
    } else {
        Ok(())
    }
}

fn bounded_plain_text_notes(value: &serde_json::Value) -> Result<Option<String>, UpdateError> {
    if value.is_null() {
        return Ok(None);
    }
    let raw = value.as_str().ok_or(UpdateError::ManifestInvalid)?;
    if raw.len() > 2_000
        || raw.contains(['<', '>'])
        || raw
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(UpdateError::ManifestInvalid);
    }
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let notes = normalized.trim();
    Ok((!notes.is_empty()).then(|| notes.to_owned()))
}

fn automatic_prompt_needed(check_completed: bool, phase: &str) -> bool {
    check_completed && phase == "AVAILABLE"
}

fn check_allowed(phase: &str) -> bool {
    !matches!(
        phase,
        "CHECKING" | "DOWNLOADING" | "STAGED" | "INSTALLING" | "RELAUNCH_REQUIRED"
    )
}

fn automatic_check_due(data_dir: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(data_dir.join(LAST_AUTOMATIC_CHECK_FILE)) else {
        return true;
    };
    let Ok(last) = raw.trim().parse::<u64>() else {
        return true;
    };
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return false;
    };
    now.as_secs().saturating_sub(last) >= AUTOMATIC_CHECK_INTERVAL.as_secs()
}

fn record_automatic_check(data_dir: &Path) -> Result<(), UpdateError> {
    fs::create_dir_all(data_dir).map_err(|_| UpdateError::StageFailed)?;
    fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))
        .map_err(|_| UpdateError::StageFailed)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| UpdateError::StageFailed)?
        .as_secs();
    let path = data_dir.join(LAST_AUTOMATIC_CHECK_FILE);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&path)
        .map_err(|_| UpdateError::StageFailed)?;
    file.write_all(now.to_string().as_bytes())
        .map_err(|_| UpdateError::StageFailed)?;
    file.sync_all().map_err(|_| UpdateError::StageFailed)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| UpdateError::StageFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tar::{Builder, EntryType, Header};
    use tempfile::tempdir;

    fn manifest(version: &str, url: &str) -> serde_json::Value {
        serde_json::json!({
            "version": version,
            "notes": "fixture",
            "pub_date": "2026-08-30T00:00:00Z",
            "platforms": {
                "darwin-aarch64": { "signature": "S".repeat(80), "url": url }
            }
        })
    }

    #[test]
    fn manifest_requires_strict_increment_and_immutable_github_asset() {
        let current = Version::parse("1.2.3").unwrap();
        let url = Url::parse("https://github.com/Vek-John/CS-agent/releases/download/desktop-v1.2.4/CS-Agent-Coach.app.tar.gz").unwrap();
        assert!(validate_update_metadata(
            &manifest("1.2.4", url.as_str()),
            &current,
            "1.2.4",
            &url,
            &"S".repeat(80)
        )
        .is_ok());
        assert_eq!(
            validate_update_metadata(
                &manifest("1.2.3", url.as_str()),
                &current,
                "1.2.3",
                &url,
                &"S".repeat(80)
            )
            .unwrap_err(),
            UpdateError::ManifestInvalid
        );
        let mutable = Url::parse("https://github.com/Vek-John/CS-agent/releases/latest/download/CS-Agent-Coach.app.tar.gz").unwrap();
        assert_eq!(
            validate_update_metadata(
                &manifest("1.2.4", mutable.as_str()),
                &current,
                "1.2.4",
                &mutable,
                &"S".repeat(80)
            )
            .unwrap_err(),
            UpdateError::ManifestInvalid
        );
    }

    #[test]
    fn release_notes_are_bounded_plain_text_and_auto_prompt_is_available_only() {
        assert_eq!(
            bounded_plain_text_notes(&serde_json::json!("  Important fixes.\r\nRestart once.  "))
                .unwrap(),
            Some("Important fixes.\nRestart once.".to_owned())
        );
        assert_eq!(
            bounded_plain_text_notes(&serde_json::json!("<strong>unsafe</strong>")).unwrap_err(),
            UpdateError::ManifestInvalid
        );
        assert!(bounded_plain_text_notes(&serde_json::json!("x".repeat(2_001))).is_err());
        assert!(automatic_prompt_needed(true, "AVAILABLE"));
        for phase in ["CURRENT", "ERROR", "CHECKING", "UNAVAILABLE", "STAGED"] {
            assert!(!automatic_prompt_needed(true, phase));
        }
        assert!(!automatic_prompt_needed(false, "AVAILABLE"));
        for phase in ["STAGED", "INSTALLING", "RELAUNCH_REQUIRED"] {
            assert!(!check_allowed(phase));
        }
        for phase in ["IDLE", "CURRENT", "AVAILABLE", "ERROR"] {
            assert!(check_allowed(phase));
        }
    }

    #[test]
    fn archive_paths_reject_absolute_parent_and_extra_top_level() {
        assert!(safe_archive_path(Path::new("CS Agent Coach.app/Contents/Info.plist")).is_ok());
        assert_eq!(
            safe_archive_path(Path::new("../evil.app/file")).unwrap_err(),
            UpdateError::ArchiveInvalid
        );
        assert_eq!(
            safe_archive_path(Path::new("/evil.app/file")).unwrap_err(),
            UpdateError::ArchiveInvalid
        );
        assert_eq!(
            safe_archive_path(Path::new("README/file")).unwrap_err(),
            UpdateError::ArchiveInvalid
        );
    }

    #[test]
    fn extraction_rejects_symlink_entries() {
        let root = tempdir().unwrap();
        let archive_path = root.path().join("fixture.tar.gz");
        let output = fs::File::create(&archive_path).unwrap();
        let encoder = flate2::write::GzEncoder::new(output, flate2::Compression::default());
        let mut archive = Builder::new(encoder);
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_cksum();
        header.set_link_name("/tmp/escape").unwrap();
        archive
            .append_data(&mut header, "CS Agent Coach.app/link", &[][..])
            .unwrap();
        archive.finish().unwrap();
        assert_eq!(
            extract_safe_app_archive(&archive_path, root.path()).unwrap_err(),
            UpdateError::ArchiveInvalid
        );
    }

    #[test]
    fn extraction_rejects_hardlinks_and_multiple_app_bundles() {
        let root = tempdir().unwrap();
        let hardlink_path = root.path().join("hardlink.tar.gz");
        let output = fs::File::create(&hardlink_path).unwrap();
        let encoder = flate2::write::GzEncoder::new(output, flate2::Compression::default());
        let mut archive = Builder::new(encoder);
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Link);
        header.set_size(0);
        header.set_mode(0o600);
        header.set_cksum();
        header
            .set_link_name("CS Agent Coach.app/Contents/Info.plist")
            .unwrap();
        archive
            .append_data(&mut header, "CS Agent Coach.app/link", &[][..])
            .unwrap();
        archive.finish().unwrap();
        assert_eq!(
            extract_safe_app_archive(&hardlink_path, root.path()).unwrap_err(),
            UpdateError::ArchiveInvalid
        );

        let multiple_path = root.path().join("multiple.tar.gz");
        let output = fs::File::create(&multiple_path).unwrap();
        let encoder = flate2::write::GzEncoder::new(output, flate2::Compression::default());
        let mut archive = Builder::new(encoder);
        for path in ["First.app/file", "Second.app/file"] {
            let mut header = Header::new_gnu();
            header.set_entry_type(EntryType::Regular);
            header.set_size(1);
            header.set_mode(0o600);
            header.set_cksum();
            archive.append_data(&mut header, path, &b"x"[..]).unwrap();
        }
        archive.finish().unwrap();
        assert_eq!(
            extract_safe_app_archive(&multiple_path, root.path()).unwrap_err(),
            UpdateError::ArchiveInvalid
        );
    }

    #[test]
    fn invalid_checked_in_public_key_disables_network_updates() {
        assert!(public_key().is_none());
    }

    #[test]
    fn release_verifier_streams_a_known_public_minisign_vector() {
        let root = tempdir().unwrap();
        let archive = root.path().join("archive.tar.gz");
        fs::write(&archive, b"test").unwrap();
        let public_key = STANDARD.encode(
            "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
        );
        let signature = STANDARD.encode(
            "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==",
        );
        assert!(verify_updater_archive_signature(&public_key, &archive, &signature).is_ok());
        fs::write(&archive, b"Test").unwrap();
        assert_eq!(
            verify_updater_archive_signature(&public_key, &archive, &signature).unwrap_err(),
            SignatureVerificationError::SignatureInvalid
        );
    }

    #[test]
    fn automatic_checks_are_rate_limited_for_twenty_four_hours() {
        let root = tempdir().unwrap();
        assert!(automatic_check_due(root.path()));
        record_automatic_check(root.path()).unwrap();
        assert!(!automatic_check_due(root.path()));
        assert_eq!(
            fs::metadata(root.path().join(LAST_AUTOMATIC_CHECK_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn install_preflight_rejects_active_coaching() {
        assert_eq!(
            require_idle_for_install(true).unwrap_err(),
            UpdateError::CoachingBusy
        );
        assert!(require_idle_for_install(false).is_ok());
    }

    #[test]
    fn healthy_cleanup_rejects_forged_receipt_paths() {
        let root = tempdir().unwrap();
        let current_app = root.path().join("CS Agent Coach.app");
        let staging_root = root.path().join(".cs-agent-update-1-fixture-0");
        let old_app = staging_root.join("CS Agent Coach.app");
        fs::create_dir(&current_app).unwrap();
        fs::create_dir(&staging_root).unwrap();
        fs::create_dir(&old_app).unwrap();
        let receipt = UpdateReceipt {
            schema_version: "desktop-update-receipt.v1".to_owned(),
            version: "1.2.4".to_owned(),
            old_app_path: old_app.display().to_string(),
            staging_root: staging_root.display().to_string(),
            backup_database_path: "/tmp/backups/pre.sqlite3".to_owned(),
            backup_manifest_path: "/tmp/backups/pre.sqlite3.manifest.json".to_owned(),
            backup_database_sha256: "a".repeat(64),
            backup_migration_count: 2,
        };
        assert_eq!(
            verified_cleanup_paths(&receipt, &current_app),
            Some((staging_root.clone(), old_app.clone()))
        );

        let forged = UpdateReceipt {
            old_app_path: current_app.display().to_string(),
            staging_root: root.path().display().to_string(),
            ..receipt
        };
        assert!(verified_cleanup_paths(&forged, &current_app).is_none());
    }

    #[test]
    fn rollback_state_only_matches_the_failed_new_version_receipt() {
        let current = Version::parse("1.2.4").unwrap();
        let receipt = UpdateReceipt {
            schema_version: "desktop-update-receipt.v1".to_owned(),
            version: current.to_string(),
            old_app_path: "/Applications/.cs-agent-update-fixture/CS Agent Coach.app".to_owned(),
            staging_root: "/Applications/.cs-agent-update-fixture".to_owned(),
            backup_database_path: "/tmp/backups/pre.sqlite3".to_owned(),
            backup_manifest_path: "/tmp/backups/pre.sqlite3.manifest.json".to_owned(),
            backup_database_sha256: "a".repeat(64),
            backup_migration_count: 2,
        };
        assert!(rollback_receipt_matches(&receipt, &current));
        assert!(!rollback_receipt_matches(
            &receipt,
            &Version::parse("1.2.3").unwrap()
        ));
        let forged = UpdateReceipt {
            schema_version: "desktop-update-receipt.v0".to_owned(),
            ..receipt
        };
        assert!(!rollback_receipt_matches(&forged, &current));
    }

    #[test]
    fn ordinary_startup_failure_without_matching_pending_receipt_never_rolls_back() {
        let root = tempdir().unwrap();
        let manager = UpdateManager::new(root.path().to_path_buf());
        let current = Version::parse("1.2.4").unwrap();
        assert_eq!(manager.rollback_failed_pending_update(&current), Ok(false));

        let unrelated = UpdateReceipt {
            schema_version: "desktop-update-receipt.v1".to_owned(),
            version: "9.9.9".to_owned(),
            old_app_path: "/Applications/.cs-agent-update-forged/Other.app".to_owned(),
            staging_root: "/Applications/.cs-agent-update-forged".to_owned(),
            backup_database_path: "/tmp/backups/pre.sqlite3".to_owned(),
            backup_manifest_path: "/tmp/backups/pre.sqlite3.manifest.json".to_owned(),
            backup_database_sha256: "a".repeat(64),
            backup_migration_count: 2,
        };
        fs::write(
            root.path().join(RECEIPT_FILE),
            serde_json::to_vec(&unrelated).unwrap(),
        )
        .unwrap();
        assert_eq!(manager.rollback_failed_pending_update(&current), Ok(false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rollback_restores_verified_backup_atomically_and_rejects_tampering() {
        let root = tempdir().unwrap();
        let backups = root.path().join("backups");
        fs::create_dir(&backups).unwrap();
        let live = root.path().join("cs-agent.sqlite3");
        let backup = backups.join("cs-agent-pre-update-1.2.3-fixture.sqlite3");
        fs::write(&live, b"SQLite format 3\0future-ledger").unwrap();
        fs::write(&backup, b"SQLite format 3\0previous-ledger").unwrap();
        let hash = sha256_file(&backup).unwrap();
        let manifest = PathBuf::from(format!("{}.manifest.json", backup.display()));
        fs::write(
            &manifest,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": "desktop-sqlite-backup.v1",
                "createdAt": "2026-08-30T00:00:00.000Z",
                "databaseSha256": hash,
                "migrationLedger": [{ "migrationId": "desktop-checkpoint-001", "checksum": "a".repeat(64) }],
                "databasePath": backup.display().to_string()
            }))
            .unwrap(),
        )
        .unwrap();
        let receipt = UpdateReceipt {
            schema_version: "desktop-update-receipt.v1".to_owned(),
            version: "1.2.4".to_owned(),
            old_app_path: "/Applications/.cs-agent-update-fixture/CS Agent Coach.app".to_owned(),
            staging_root: "/Applications/.cs-agent-update-fixture".to_owned(),
            backup_database_path: backup.display().to_string(),
            backup_manifest_path: manifest.display().to_string(),
            backup_database_sha256: hash.clone(),
            backup_migration_count: 1,
        };
        let displaced = restore_backup_for_rollback(&receipt, root.path()).unwrap();
        assert_eq!(
            fs::read(&live).unwrap(),
            b"SQLite format 3\0previous-ledger"
        );
        assert_eq!(
            fs::read(&displaced).unwrap(),
            b"SQLite format 3\0future-ledger"
        );
        atomic_swap(&displaced, &live).unwrap();
        fs::remove_file(displaced).unwrap();

        let tampered = UpdateReceipt {
            backup_database_sha256: "f".repeat(64),
            ..receipt
        };
        assert_eq!(
            restore_backup_for_rollback(&tampered, root.path()).unwrap_err(),
            UpdateError::BackupRequired
        );
        assert_eq!(fs::read(&live).unwrap(), b"SQLite format 3\0future-ledger");

        let guarded = UpdateReceipt {
            backup_database_sha256: hash,
            ..tampered
        };
        fs::create_dir(format!("{}-wal", live.display())).unwrap();
        assert_eq!(
            restore_backup_for_rollback(&guarded, root.path()).unwrap_err(),
            UpdateError::BackupRequired
        );
        assert_eq!(fs::read(&live).unwrap(), b"SQLite format 3\0future-ledger");
        assert!(!fs::read_dir(root.path())
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".rollback-restore-")));
    }

    #[test]
    fn relaunch_required_state_preserves_only_the_recovery_action() {
        let manager = UpdateManager::new(tempdir().unwrap().path().to_path_buf());
        {
            let mut state = manager.inner.lock().unwrap();
            state.phase = "RELAUNCH_REQUIRED";
            state.can_relaunch = true;
        }
        let status = manager.status(&Version::parse("1.2.4").unwrap(), false, true);
        assert!(!check_allowed(status.phase));
        assert!(status.can_relaunch);
        assert!(!status.can_check);
        assert!(!status.can_download);
        assert!(!status.can_install);
    }

    #[test]
    fn staged_update_requires_an_explicit_review_end_before_install() {
        let manager = UpdateManager::new(tempdir().unwrap().path().to_path_buf());
        manager.inner.lock().unwrap().phase = "STAGED";

        let active = manager.status(&Version::parse("1.2.4").unwrap(), true, false);
        assert!(active.can_end_review);
        assert!(!active.can_resume_review);
        assert!(!active.can_install);

        let ended = manager.status(&Version::parse("1.2.4").unwrap(), false, true);
        assert!(!ended.can_end_review);
        assert!(ended.can_resume_review);
        assert!(ended.can_install);
    }

    #[test]
    fn manual_dmg_open_uses_only_the_version_pinned_github_asset() {
        let manager = UpdateManager::new(tempdir().unwrap().path().to_path_buf());
        let version = Version::parse("1.2.4").unwrap();
        {
            let mut state = manager.inner.lock().unwrap();
            state.phase = "DMG_FALLBACK";
            state.available = Some(AvailableUpdate {
                version: version.clone(),
                download_url: Url::parse(
                    "https://github.com/Vek-John/CS-agent/releases/download/desktop-v1.2.4/CS-Agent-Coach.app.tar.gz",
                )
                .unwrap(),
                signature: "test-signature".to_owned(),
                release_notes: None,
            });
            state.fallback_dmg_url = Some(dmg_fallback_url(&version));
        }
        assert_eq!(
            manager.verified_fallback_dmg_url().unwrap().as_str(),
            "https://github.com/Vek-John/CS-agent/releases/download/desktop-v1.2.4/CS-Agent-Coach_1.2.4_aarch64.dmg"
        );

        manager.inner.lock().unwrap().fallback_dmg_url =
            Some("https://attacker.invalid/update.dmg".to_owned());
        assert_eq!(
            manager.verified_fallback_dmg_url().unwrap_err(),
            UpdateError::ManifestInvalid
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rename_swap_atomically_exchanges_new_and_old_app_fixtures() {
        let root = tempdir().unwrap();
        let first = root.path().join("first.app");
        let second = root.path().join("second.app");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        fs::write(first.join("marker"), "first").unwrap();
        fs::write(second.join("marker"), "second").unwrap();
        atomic_swap(&first, &second).unwrap();
        assert_eq!(fs::read_to_string(first.join("marker")).unwrap(), "second");
        assert_eq!(fs::read_to_string(second.join("marker")).unwrap(), "first");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn staged_version_swap_preserves_data_until_health_then_retires_old_app() {
        let root = tempdir().unwrap();
        let data_dir = root.path().join("data");
        fs::create_dir(&data_dir).unwrap();
        let live_database = data_dir.join("cs-agent.sqlite3");
        fs::write(&live_database, b"SQLite format 3\0user-data-v1").unwrap();

        let current_app = root.path().join("CS Agent Coach.app");
        let staging_root = root.path().join(".cs-agent-update-1.2.4-fixture-0");
        let new_app = staging_root.join("CS Agent Coach.app");
        fs::create_dir(&current_app).unwrap();
        fs::create_dir(&staging_root).unwrap();
        fs::create_dir(&new_app).unwrap();
        fs::write(current_app.join("marker"), "1.2.3").unwrap();
        fs::write(new_app.join("marker"), "1.2.4").unwrap();

        let manager = UpdateManager::new(data_dir.clone());
        let next_version = Version::parse("1.2.4").unwrap();
        {
            let mut state = manager.inner.lock().unwrap();
            state.phase = "STAGED";
            state.staged = Some(StagedUpdate {
                version: next_version.clone(),
                staging_root: staging_root.clone(),
                new_app: new_app.clone(),
            });
        }
        let backup = VerifiedUpdateBackup {
            database_path: data_dir.join("backups/cs-agent-pre-update-fixture.sqlite3"),
            manifest_path: data_dir
                .join("backups/cs-agent-pre-update-fixture.sqlite3.manifest.json"),
            database_sha256: "a".repeat(64),
            migration_count: 1,
        };

        manager
            .install_staged_with(
                &current_app,
                &backup,
                |candidate, version| {
                    candidate == new_app.as_path()
                        && version == &next_version
                        && fs::read_to_string(candidate.join("marker")).unwrap() == "1.2.4"
                },
                atomic_swap,
            )
            .unwrap();
        assert_eq!(
            fs::read_to_string(current_app.join("marker")).unwrap(),
            "1.2.4"
        );
        assert_eq!(fs::read_to_string(new_app.join("marker")).unwrap(), "1.2.3");
        assert!(data_dir.join(RECEIPT_FILE).is_file());
        assert_eq!(
            fs::read(&live_database).unwrap(),
            b"SQLite format 3\0user-data-v1"
        );
        let status = manager.status(&next_version, false, true);
        assert_eq!(status.phase, "RELAUNCH_REQUIRED");
        assert!(status.can_relaunch);

        manager.confirm_healthy_version_at(&next_version, &current_app);
        assert!(!staging_root.exists());
        assert!(!data_dir.join(RECEIPT_FILE).exists());
        assert_eq!(
            fs::read_to_string(current_app.join("marker")).unwrap(),
            "1.2.4"
        );
        assert_eq!(
            fs::read(&live_database).unwrap(),
            b"SQLite format 3\0user-data-v1"
        );
    }
}

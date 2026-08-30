use crate::protocol::ProviderInit;
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

const KEYCHAIN_SERVICE: &str = "com.csagent.coach.provider";
const KEYCHAIN_ACCOUNT: &str = "api-key";
const ITEM_NOT_FOUND: i32 = -25300;
const CONFIG_FILE: &str = "provider-config.json";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProviderKind {
    None,
    Deepseek,
    OpenaiCompatible,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderPreferences {
    schema_version: String,
    kind: ProviderKind,
    base_url: Option<String>,
    model: Option<String>,
}

impl Default for ProviderPreferences {
    fn default() -> Self {
        Self {
            schema_version: "desktop-provider-preferences.v1".to_owned(),
            kind: ProviderKind::None,
            base_url: None,
            model: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSaveInput {
    kind: ProviderKind,
    api_key: Option<String>,
    delete_api_key: bool,
    base_url: Option<String>,
    model: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    kind: ProviderKind,
    has_api_key: bool,
    base_url: Option<String>,
    model: Option<String>,
    restart_required: bool,
    validation: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPaths {
    pub data_dir: String,
    pub database_path: String,
    pub cache_dir: String,
    pub log_dir: String,
    pub backup_available: bool,
    pub export_available: bool,
}

#[derive(Debug)]
pub struct ProviderManager {
    data_dir: PathBuf,
    restart_required: AtomicBool,
}

impl ProviderManager {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            restart_required: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> Result<ProviderStatus, &'static str> {
        let preferences = read_preferences(&self.data_dir)?;
        let has_api_key = read_keychain()?.is_some();
        Ok(ProviderStatus {
            kind: preferences.kind,
            has_api_key,
            base_url: preferences.base_url,
            model: preferences.model,
            restart_required: self.restart_required.load(Ordering::Acquire),
            validation: "NOT_RUN",
        })
    }

    pub fn validate(&self, input: ProviderSaveInput) -> Result<ProviderStatus, &'static str> {
        let preferences = validate_input(&input, read_keychain()?.is_some())?;
        Ok(ProviderStatus {
            kind: preferences.kind,
            has_api_key: input.api_key.as_ref().is_some_and(|key| !key.is_empty())
                || (!input.delete_api_key && read_keychain()?.is_some()),
            base_url: preferences.base_url,
            model: preferences.model,
            restart_required: self.restart_required.load(Ordering::Acquire),
            validation: "CONFIG_AND_KEYCHAIN_OK",
        })
    }

    pub fn save(&self, input: ProviderSaveInput) -> Result<ProviderStatus, &'static str> {
        let existing_key = read_keychain()?.is_some();
        let preferences = validate_input(&input, existing_key)?;
        if matches!(preferences.kind, ProviderKind::None) || input.delete_api_key {
            delete_keychain()?;
        }
        if let Some(key) = input.api_key.as_deref() {
            set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, key.as_bytes())
                .map_err(|_| "KEYCHAIN_WRITE_FAILED")?;
        }
        write_preferences(&self.data_dir, &preferences)?;
        self.restart_required.store(true, Ordering::Release);
        self.status()
    }

    pub fn delete(&self) -> Result<ProviderStatus, &'static str> {
        delete_keychain()?;
        write_preferences(&self.data_dir, &ProviderPreferences::default())?;
        self.restart_required.store(true, Ordering::Release);
        self.status()
    }
}

pub fn runtime_provider(data_dir: &Path) -> Result<ProviderInit, &'static str> {
    let preferences = read_preferences(data_dir)?;
    match preferences.kind {
        ProviderKind::None => Ok(ProviderInit::default()),
        ProviderKind::Deepseek => Ok(ProviderInit {
            kind: "DEEPSEEK".to_owned(),
            api_key: Some(
                String::from_utf8(read_keychain()?.ok_or("PROVIDER_KEY_MISSING")?)
                    .map_err(|_| "PROVIDER_KEY_INVALID")?,
            ),
            base_url: preferences.base_url,
            model: preferences.model,
        }),
        ProviderKind::OpenaiCompatible => Ok(ProviderInit {
            kind: "OPENAI_COMPATIBLE".to_owned(),
            api_key: read_keychain()?
                .map(String::from_utf8)
                .transpose()
                .map_err(|_| "PROVIDER_KEY_INVALID")?,
            base_url: preferences.base_url,
            model: preferences.model,
        }),
    }
}

fn validate_input(
    input: &ProviderSaveInput,
    existing_key: bool,
) -> Result<ProviderPreferences, &'static str> {
    if input
        .api_key
        .as_ref()
        .is_some_and(|key| key.is_empty() || key.len() > 512 || key.chars().any(char::is_control))
    {
        return Err("PROVIDER_KEY_INVALID");
    }
    match input.kind {
        ProviderKind::None => Ok(ProviderPreferences::default()),
        ProviderKind::Deepseek => {
            if input.delete_api_key
                || (!existing_key && input.api_key.as_deref().unwrap_or("").len() < 8)
            {
                return Err("PROVIDER_KEY_REQUIRED");
            }
            let model = bounded(input.model.as_deref(), 1, 120).ok_or("PROVIDER_MODEL_INVALID")?;
            let base = input
                .base_url
                .as_deref()
                .unwrap_or("https://api.deepseek.com");
            if !matches!(
                base,
                "https://api.deepseek.com" | "https://api.deepseek.com/"
            ) {
                return Err("PROVIDER_URL_INVALID");
            }
            Ok(ProviderPreferences {
                schema_version: "desktop-provider-preferences.v1".to_owned(),
                kind: ProviderKind::Deepseek,
                base_url: Some(base.to_owned()),
                model: Some(model.to_owned()),
            })
        }
        ProviderKind::OpenaiCompatible => {
            let model = bounded(input.model.as_deref(), 1, 120).ok_or("PROVIDER_MODEL_INVALID")?;
            let base = bounded(input.base_url.as_deref(), 1, 2048).ok_or("PROVIDER_URL_INVALID")?;
            let url = url::Url::parse(base).map_err(|_| "PROVIDER_URL_INVALID")?;
            let loopback_http = url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
            if (url.scheme() != "https" && !loopback_http)
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("PROVIDER_URL_INVALID");
            }
            Ok(ProviderPreferences {
                schema_version: "desktop-provider-preferences.v1".to_owned(),
                kind: ProviderKind::OpenaiCompatible,
                base_url: Some(base.trim_end_matches('/').to_owned()),
                model: Some(model.to_owned()),
            })
        }
    }
}

fn bounded(value: Option<&str>, min: usize, max: usize) -> Option<&str> {
    value.filter(|value| (min..=max).contains(&value.len()) && !value.chars().any(char::is_control))
}

fn read_keychain() -> Result<Option<Vec<u8>>, &'static str> {
    match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(secret) => Ok(Some(secret)),
        Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
        Err(_) => Err("KEYCHAIN_READ_FAILED"),
    }
}

fn delete_keychain() -> Result<(), &'static str> {
    match delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
        Err(_) => Err("KEYCHAIN_DELETE_FAILED"),
    }
}

fn read_preferences(data_dir: &Path) -> Result<ProviderPreferences, &'static str> {
    let path = data_dir.join(CONFIG_FILE);
    if !path.exists() {
        return Ok(ProviderPreferences::default());
    }
    let bytes = fs::read(path).map_err(|_| "PROVIDER_CONFIG_READ_FAILED")?;
    let preferences: ProviderPreferences =
        serde_json::from_slice(&bytes).map_err(|_| "PROVIDER_CONFIG_INVALID")?;
    if preferences.schema_version != "desktop-provider-preferences.v1" {
        return Err("PROVIDER_CONFIG_INVALID");
    }
    Ok(preferences)
}

fn write_preferences(
    data_dir: &Path,
    preferences: &ProviderPreferences,
) -> Result<(), &'static str> {
    fs::create_dir_all(data_dir).map_err(|_| "PROVIDER_CONFIG_WRITE_FAILED")?;
    fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))
        .map_err(|_| "PROVIDER_CONFIG_WRITE_FAILED")?;
    let temporary = data_dir.join(format!(".provider-config-{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| "PROVIDER_CONFIG_WRITE_FAILED")?;
    let bytes = serde_json::to_vec(preferences).map_err(|_| "PROVIDER_CONFIG_WRITE_FAILED")?;
    file.write_all(&bytes)
        .map_err(|_| "PROVIDER_CONFIG_WRITE_FAILED")?;
    file.sync_all()
        .map_err(|_| "PROVIDER_CONFIG_WRITE_FAILED")?;
    fs::rename(&temporary, data_dir.join(CONFIG_FILE))
        .map_err(|_| "PROVIDER_CONFIG_WRITE_FAILED")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TemporaryKeychainItem(String);

    impl Drop for TemporaryKeychainItem {
        fn drop(&mut self) {
            let _ = delete_generic_password(&self.0, "temporary-test");
        }
    }

    #[test]
    fn keychain_generic_password_round_trip_is_cleaned_up() {
        let service = format!("com.csagent.coach.test.{}", std::process::id());
        let _cleanup = TemporaryKeychainItem(service.clone());
        let _ = delete_generic_password(&service, "temporary-test");
        set_generic_password(&service, "temporary-test", b"ephemeral-test-secret").unwrap();
        assert_eq!(
            get_generic_password(&service, "temporary-test").unwrap(),
            b"ephemeral-test-secret"
        );
        delete_generic_password(&service, "temporary-test").unwrap();
        assert_eq!(
            get_generic_password(&service, "temporary-test")
                .unwrap_err()
                .code(),
            ITEM_NOT_FOUND
        );
    }

    #[test]
    fn preferences_never_serialize_api_key() {
        let preferences = ProviderPreferences {
            schema_version: "desktop-provider-preferences.v1".to_owned(),
            kind: ProviderKind::Deepseek,
            base_url: Some("https://api.deepseek.com".to_owned()),
            model: Some("deepseek-chat".to_owned()),
        };
        let encoded = serde_json::to_string(&preferences).unwrap();
        assert!(!encoded.contains("apiKey"));
        assert!(!encoded.contains("secret"));
    }

    #[test]
    fn rejects_remote_plain_http_provider() {
        let input = ProviderSaveInput {
            kind: ProviderKind::OpenaiCompatible,
            api_key: None,
            delete_api_key: false,
            base_url: Some("http://example.com/v1".to_owned()),
            model: Some("model".to_owned()),
        };
        assert_eq!(validate_input(&input, false), Err("PROVIDER_URL_INVALID"));
    }
}

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use url::Url;

pub const INIT_SCHEMA: &str = "desktop-runtime-init.v1";
pub const READY_SCHEMA: &str = "desktop-runtime-ready.v2";
pub const HTTP_PROTOCOL: &str = "desktop-runtime-http.v2";
pub const TARGET_TRIPLE: &str = "aarch64-apple-darwin";
pub const CHECKPOINT_BACKEND: &str = "SQLITE";
pub const PINNED_NODE_VERSION: &str = "24.19.0";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInit {
    pub schema_version: &'static str,
    pub app_version: String,
    pub build_sha: String,
    pub target_triple: &'static str,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub log_dir: PathBuf,
    pub runtime_root: PathBuf,
    pub viewer_root: PathBuf,
    pub provider: ProviderInit,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInit {
    pub kind: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
}

impl Default for ProviderInit {
    fn default() -> Self {
        Self {
            kind: "NONE".to_owned(),
            api_key: None,
            base_url: None,
            model: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeReady {
    pub schema_version: String,
    pub protocol_version: String,
    pub app_origin: String,
    pub viewer_origin: String,
    pub session_token: String,
    pub admin_token: String,
    pub pid: u32,
    pub target_triple: String,
    pub node_version: String,
    pub checkpoint_backend: String,
    pub recoverable_after_refresh: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ReadyError {
    #[error("READY_INVALID_JSON")]
    InvalidJson,
    #[error("READY_WRONG_SCHEMA")]
    WrongSchema,
    #[error("READY_WRONG_PROTOCOL")]
    WrongProtocol,
    #[error("READY_INVALID_ORIGIN")]
    InvalidOrigin,
    #[error("READY_INVALID_TOKEN")]
    InvalidToken,
    #[error("READY_WRONG_PROCESS")]
    WrongProcess,
    #[error("READY_WRONG_TARGET")]
    WrongTarget,
    #[error("READY_INVALID_VERSION")]
    InvalidVersion,
    #[error("READY_WRONG_CHECKPOINT")]
    WrongCheckpoint,
    #[error("READY_NOT_RECOVERABLE")]
    NotRecoverable,
}

impl RuntimeReady {
    pub fn parse_and_validate(line: &[u8], expected_pid: u32) -> Result<Self, ReadyError> {
        if line.len() > 16 * 1024 {
            return Err(ReadyError::InvalidJson);
        }
        let ready: Self = serde_json::from_slice(line).map_err(|_| ReadyError::InvalidJson)?;
        if ready.schema_version != READY_SCHEMA {
            return Err(ReadyError::WrongSchema);
        }
        if ready.protocol_version != HTTP_PROTOCOL {
            return Err(ReadyError::WrongProtocol);
        }
        let app_url = validate_loopback_origin(&ready.app_origin, "127.0.0.1")?;
        let viewer_url = validate_loopback_origin(&ready.viewer_origin, "localhost")?;
        if ready.app_origin == ready.viewer_origin {
            return Err(ReadyError::InvalidOrigin);
        }
        if app_url.port() == viewer_url.port() {
            return Err(ReadyError::InvalidOrigin);
        }
        validate_token(&ready.session_token)?;
        validate_token(&ready.admin_token)?;
        if ready.session_token == ready.admin_token {
            return Err(ReadyError::InvalidToken);
        }
        if ready.pid == 0 || ready.pid != expected_pid {
            return Err(ReadyError::WrongProcess);
        }
        if ready.target_triple != TARGET_TRIPLE {
            return Err(ReadyError::WrongTarget);
        }
        if ready.node_version != PINNED_NODE_VERSION {
            return Err(ReadyError::InvalidVersion);
        }
        if ready.checkpoint_backend != CHECKPOINT_BACKEND {
            return Err(ReadyError::WrongCheckpoint);
        }
        if !ready.recoverable_after_refresh {
            return Err(ReadyError::NotRecoverable);
        }
        Ok(ready)
    }
}

fn validate_loopback_origin(raw: &str, expected_host: &str) -> Result<Url, ReadyError> {
    if raw.len() > 128 || raw.ends_with('/') {
        return Err(ReadyError::InvalidOrigin);
    }
    let url = Url::parse(raw).map_err(|_| ReadyError::InvalidOrigin)?;
    if url.scheme() != "http"
        || url.host_str() != Some(expected_host)
        || url.port().is_none()
        || url.port() == Some(0)
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ReadyError::InvalidOrigin);
    }
    Ok(url)
}

fn validate_token(token: &str) -> Result<(), ReadyError> {
    if token.len() != 43
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ReadyError::InvalidToken);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_ready() -> serde_json::Value {
        json!({
            "schemaVersion": READY_SCHEMA,
            "protocolVersion": HTTP_PROTOCOL,
            "appOrigin": "http://127.0.0.1:43001",
            "viewerOrigin": "http://localhost:43002",
            "sessionToken": "s".repeat(43),
            "adminToken": "a".repeat(43),
            "pid": 9123,
            "targetTriple": TARGET_TRIPLE,
            "nodeVersion": PINNED_NODE_VERSION,
            "checkpointBackend": CHECKPOINT_BACKEND,
            "recoverableAfterRefresh": true
        })
    }

    #[test]
    fn accepts_strict_ready_contract() {
        let line = serde_json::to_vec(&valid_ready()).unwrap();
        RuntimeReady::parse_and_validate(&line, 9123).unwrap();
    }

    #[test]
    fn rejects_lan_origin() {
        let mut value = valid_ready();
        value["appOrigin"] = json!("http://192.168.1.20:43001");
        assert_eq!(
            RuntimeReady::parse_and_validate(&serde_json::to_vec(&value).unwrap(), 9123),
            Err(ReadyError::InvalidOrigin)
        );
    }

    #[test]
    fn rejects_old_ipv6_or_shared_ipv4_viewer_authority() {
        for viewer in ["http://[::1]:43002", "http://127.0.0.1:43002"] {
            let mut value = valid_ready();
            value["viewerOrigin"] = json!(viewer);
            assert_eq!(
                RuntimeReady::parse_and_validate(&serde_json::to_vec(&value).unwrap(), 9123),
                Err(ReadyError::InvalidOrigin)
            );
        }
    }

    #[test]
    fn rejects_reusing_the_app_port_for_the_viewer_authority() {
        let mut value = valid_ready();
        value["viewerOrigin"] = json!("http://localhost:43001");
        assert_eq!(
            RuntimeReady::parse_and_validate(&serde_json::to_vec(&value).unwrap(), 9123),
            Err(ReadyError::InvalidOrigin)
        );
    }

    #[test]
    fn rejects_wrong_schema_and_unknown_fields() {
        let mut value = valid_ready();
        value["schemaVersion"] = json!("desktop-runtime-ready.v3");
        assert_eq!(
            RuntimeReady::parse_and_validate(&serde_json::to_vec(&value).unwrap(), 9123),
            Err(ReadyError::WrongSchema)
        );

        let mut value = valid_ready();
        value["unexpected"] = json!(true);
        assert_eq!(
            RuntimeReady::parse_and_validate(&serde_json::to_vec(&value).unwrap(), 9123),
            Err(ReadyError::InvalidJson)
        );
    }

    #[test]
    fn rejects_every_non_43_byte_token() {
        let mut value = valid_ready();
        for length in [42, 44, 513] {
            value["sessionToken"] = json!("x".repeat(length));
            assert_eq!(
                RuntimeReady::parse_and_validate(&serde_json::to_vec(&value).unwrap(), 9123),
                Err(ReadyError::InvalidToken)
            );
        }
    }
}

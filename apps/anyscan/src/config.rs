use std::{
    env, fs,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Path, PathBuf},
};

use crate::core::{
    ExtensionKind, ExtensionManifest, GobusterTargetConfig, OperatorRecord, OperatorRole,
    PortScanRequest, RepositoryDefinition, ScanDefaultsSummary, TargetDefinition,
    normalize_request_profile_name, sanitize_paths,
};
use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub storage: StorageConfig,
    pub server: ServerConfig,
    pub auth: AuthConfig,
    pub inventory: InventoryConfig,
    pub scan: ScanConfig,
    pub public: PublicSiteConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub bind_addr: String,
    pub private_control_plane_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AuthConfig {
    pub admin_username: String,
    pub admin_password: String,
    pub jwt_secret: String,
    pub session_ttl_seconds: u64,
    pub operators: Vec<OperatorConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct InventoryConfig {
    pub allowed_host_suffixes: Vec<String>,
    pub allowed_hosts: Vec<String>,
    pub allowed_cidrs: Vec<String>,
    pub allowed_ports: Vec<u16>,
    pub default_paths: Vec<String>,
    pub path_profiles: Vec<String>,
    pub request_profiles: Vec<RequestProfileConfig>,
    pub bootstrap_targets: Vec<TargetDefinition>,
    pub bootstrap_repositories: Vec<RepositoryDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OperatorConfig {
    pub username: String,
    pub password: String,
    pub role: OperatorRole,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProxyMode {
    DirectOnly,
    PreferProxy,
    ProxyOnly,
    ProxyThenDirect,
    DirectThenProxy,
}

impl ProxyMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProxyMode::DirectOnly => "direct_only",
            ProxyMode::PreferProxy => "prefer_proxy",
            ProxyMode::ProxyOnly => "proxy_only",
            ProxyMode::ProxyThenDirect => "proxy_then_direct",
            ProxyMode::DirectThenProxy => "direct_then_proxy",
        }
    }
}

impl Default for ProxyMode {
    fn default() -> Self {
        Self::DirectOnly
    }
}

impl std::str::FromStr for ProxyMode {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "direct_only" => Ok(Self::DirectOnly),
            "prefer_proxy" => Ok(Self::PreferProxy),
            "proxy_only" => Ok(Self::ProxyOnly),
            "proxy_then_direct" => Ok(Self::ProxyThenDirect),
            "direct_then_proxy" => Ok(Self::DirectThenProxy),
            other => Err(format!("unknown proxy mode: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RequestProfileConfig {
    pub name: String,
    pub headers: Vec<RequestProfileSecretRef>,
    pub cookies: Vec<RequestProfileSecretRef>,
    pub bearer_token_env: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RequestProfileSecretRef {
    pub name: String,
    pub env: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ScanConfig {
    pub concurrency: usize,
    pub request_timeout_secs: u64,
    pub max_response_bytes: usize,
    pub max_paths_per_target: usize,
    pub max_parallel_paths_per_target: usize,
    pub max_concurrent_requests_per_host: usize,
    pub enable_path_discovery: bool,
    pub max_discovered_paths_per_target: usize,
    pub host_backoff_initial_ms: u64,
    pub host_backoff_max_ms: u64,
    pub user_agent: String,
    pub poll_interval_seconds: u64,
    pub allow_invalid_tls: bool,
    pub allow_authenticated_request_profiles: bool,
    pub proxy_mode: ProxyMode,
    pub proxy_url: Option<String>,
    pub extension_manifest_paths: Vec<String>,
    pub extension_manifest_dirs: Vec<String>,
    pub gobuster: GobusterConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PublicSiteConfig {
    pub service_name: String,
    pub base_url: Option<String>,
    pub security_email: String,
    pub abuse_email: String,
    pub opt_out_email: String,
    pub scanner_ip_ranges: Vec<String>,
    pub scanner_asns: Vec<String>,
    pub reverse_dns_patterns: Vec<String>,
    pub user_agent_examples: Vec<String>,
    pub published_search_scope: Vec<String>,
    pub data_retention_days: u64,
    pub opt_out_response_sla_hours: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct StorageConfig {
    pub redis_url: Option<String>,
    pub redis_username: Option<String>,
    pub redis_password: Option<String>,
    pub anygpt_api_env_path: Option<String>,
    pub redis_db: i64,
    pub redis_tls: bool,
    pub redis_startup_wait: bool,
    pub redis_startup_timeout_seconds: u64,
    pub redis_key_prefix: String,
    pub redis_lock_ttl_ms: u64,
    pub redis_lock_retry_delay_ms: u64,
    pub redis_lock_max_wait_ms: u64,
    pub redis_run_lease_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GobusterConfig {
    pub enabled: bool,
    pub wordlist: Vec<String>,
    pub patterns: Vec<String>,
    pub extensions: Vec<String>,
    pub add_slash: bool,
    pub discover_backup: bool,
    pub status_codes: Vec<u16>,
    pub status_codes_blacklist: Vec<u16>,
    pub exclude_lengths: Vec<usize>,
    pub max_candidates_per_target: usize,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            storage: StorageConfig::default(),
            server: ServerConfig::default(),
            auth: AuthConfig::default(),
            inventory: InventoryConfig::default(),
            scan: ScanConfig::default(),
            public: PublicSiteConfig::default(),
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind_addr: "127.0.0.1:8088".to_string(),
            private_control_plane_only: false,
        }
    }
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            admin_username: "admin".to_string(),
            admin_password: "change-me".to_string(),
            jwt_secret: "change-me-session-secret".to_string(),
            session_ttl_seconds: 43_200,
            operators: Vec::new(),
        }
    }
}

impl Default for OperatorConfig {
    fn default() -> Self {
        Self {
            username: String::new(),
            password: String::new(),
            role: OperatorRole::Admin,
            enabled: true,
        }
    }
}

impl Default for InventoryConfig {
    fn default() -> Self {
        Self {
            allowed_host_suffixes: vec!["localhost".to_string()],
            allowed_hosts: Vec::new(),
            allowed_cidrs: Vec::new(),
            allowed_ports: Vec::new(),
            default_paths: Vec::new(),
            path_profiles: vec![
                "baseline".to_string(),
                "public-entrypoints".to_string(),
                "build-manifests".to_string(),
                "well-known-metadata".to_string(),
                "sitemaps-and-indexes".to_string(),
                "service-workers-and-pwa".to_string(),
                "docs-and-explorers".to_string(),
            ],
            request_profiles: Vec::new(),
            bootstrap_targets: Vec::new(),
            bootstrap_repositories: default_bootstrap_repositories(),
        }
    }
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            redis_url: Some(DEFAULT_ANYSCAN_REDIS_URL.to_string()),
            redis_username: None,
            redis_password: None,
            anygpt_api_env_path: None,
            redis_db: DEFAULT_ANYSCAN_REDIS_DB,
            redis_tls: false,
            redis_startup_wait: true,
            redis_startup_timeout_seconds: 20,
            redis_key_prefix: DEFAULT_ANYSCAN_REDIS_KEY_PREFIX.to_string(),
            redis_lock_ttl_ms: 5_000,
            redis_lock_retry_delay_ms: 50,
            redis_lock_max_wait_ms: 5_000,
            redis_run_lease_seconds: 120,
        }
    }
}

impl Default for ScanConfig {
    fn default() -> Self {
        Self {
            concurrency: 16,
            request_timeout_secs: 10,
            max_response_bytes: 256 * 1024,
            max_paths_per_target: 32,
            max_parallel_paths_per_target: 4,
            max_concurrent_requests_per_host: 4,
            enable_path_discovery: true,
            max_discovered_paths_per_target: 12,
            host_backoff_initial_ms: 250,
            host_backoff_max_ms: 4_000,
            user_agent: "AnyScan/0.1".to_string(),
            poll_interval_seconds: 15,
            allow_invalid_tls: false,
            allow_authenticated_request_profiles: false,
            proxy_mode: ProxyMode::DirectOnly,
            proxy_url: None,
            extension_manifest_paths: Vec::new(),
            extension_manifest_dirs: Vec::new(),
            gobuster: GobusterConfig::default(),
        }
    }
}

impl Default for PublicSiteConfig {
    fn default() -> Self {
        Self {
            service_name: "AnyScan".to_string(),
            base_url: None,
            security_email: "security@example.invalid".to_string(),
            abuse_email: "abuse@example.invalid".to_string(),
            opt_out_email: "optout@example.invalid".to_string(),
            scanner_ip_ranges: Vec::new(),
            scanner_asns: Vec::new(),
            reverse_dns_patterns: Vec::new(),
            user_agent_examples: Vec::new(),
            published_search_scope: vec![
                "service banners".to_string(),
                "http response metadata".to_string(),
                "tls and certificate metadata".to_string(),
            ],
            data_retention_days: 90,
            opt_out_response_sla_hours: 72,
        }
    }
}

impl Default for GobusterConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            wordlist: DEFAULT_GOBUSTER_WORDLIST
                .iter()
                .map(|entry| entry.to_string())
                .collect(),
            patterns: Vec::new(),
            extensions: Vec::new(),
            add_slash: false,
            discover_backup: false,
            status_codes: Vec::new(),
            status_codes_blacklist: vec![404],
            exclude_lengths: Vec::new(),
            max_candidates_per_target: 128,
        }
    }
}

const DEFAULT_ANYSCAN_REDIS_DB: i64 = 0;
const DEFAULT_ANYSCAN_REDIS_URL: &str = "redis://127.0.0.1:6380/0";
const DEFAULT_ANYSCAN_REDIS_KEY_PREFIX: &str = "anyscan:";
const RESERVED_ANYGPT_EXPERIMENTAL_REDIS_DB: i64 = 1;

const DEFAULT_GOBUSTER_WORDLIST: &[&str] = &[
    "admin",
    "api",
    "app",
    "assets",
    "backup",
    "config",
    "console",
    "debug",
    "docs",
    "env",
    "graphql",
    "health",
    "internal",
    "login",
    "manifest",
    "metrics",
    "openapi",
    "runtime",
    "server-status",
    "settings",
    "static",
    "swagger",
];

const KNOWN_PATH_PROFILES: &[&str] = &[
    "baseline",
    "public-entrypoints",
    "build-manifests",
    "well-known-metadata",
    "sitemaps-and-indexes",
    "docs-and-explorers",
    "graphql-and-schema",
    "service-workers-and-pwa",
    "extended-framework-artifacts",
    "extended-config-variants",
    "observability-and-debug",
    "js-bundles",
    "source-maps",
    "framework-leaks",
    "client-configs",
    "legacy-configs",
    "backup-configs",
];

const BASELINE_PATHS: &[&str] = &[
    "/.env",
    "/.env.local",
    "/config.json",
    "/openapi.json",
    "/swagger.json",
    "/v2/api-docs",
];

const PUBLIC_ENTRYPOINT_PATHS: &[&str] = &[
    "/",
    "/index.html",
    "/robots.txt",
    "/manifest.json",
    "/site.webmanifest",
];

const BUILD_MANIFEST_PATHS: &[&str] = &[
    "/asset-manifest.json",
    "/build/manifest.json",
    "/dist/manifest.json",
    "/vite.manifest.json",
    "/_next/build-manifest.json",
];

const WELL_KNOWN_METADATA_PATHS: &[&str] = &[
    "/.well-known/security.txt",
    "/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server",
    "/.well-known/assetlinks.json",
    "/.well-known/apple-app-site-association",
];

const SITEMAP_AND_INDEX_PATHS: &[&str] = &[
    "/sitemap.xml",
    "/sitemap_index.xml",
    "/sitemap-index.xml",
    "/sitemap.txt",
];

const DOCS_AND_EXPLORER_PATHS: &[&str] = &[
    "/docs",
    "/openapi.yaml",
    "/openapi.yml",
    "/api-docs",
    "/swagger-ui",
    "/redoc",
];

const GRAPHQL_AND_SCHEMA_PATHS: &[&str] = &[
    "/graphql",
    "/api/graphql",
    "/graphiql",
    "/playground",
    "/graphql/schema",
];

const SERVICE_WORKER_AND_PWA_PATHS: &[&str] = &[
    "/sw.js",
    "/service-worker.js",
    "/firebase-messaging-sw.js",
    "/ngsw.json",
];

const EXTENDED_FRAMEWORK_ARTIFACT_PATHS: &[&str] = &[
    "/assets/app.js",
    "/assets/main.js",
    "/static/js/runtime-main.js",
    "/static/js/bundle.js",
    "/_next/static/runtime/main.js",
    "/_next/static/runtime/webpack.js",
    "/_next/static/chunks/webpack.js",
];

const JS_BUNDLE_PATHS: &[&str] = &[
    "/app.js",
    "/main.js",
    "/assets/index.js",
    "/static/js/main.js",
    "/_next/static/chunks/main.js",
];

const SOURCE_MAP_PATHS: &[&str] = &[
    "/app.js.map",
    "/main.js.map",
    "/assets/index.js.map",
    "/static/js/main.js.map",
    "/_next/static/chunks/main.js.map",
];

const FRAMEWORK_LEAK_PATHS: &[&str] = &[
    "/.env.production",
    "/.env.development",
    "/.env.test",
    "/env.js",
    "/server.js",
];

const EXTENDED_CONFIG_VARIANT_PATHS: &[&str] = &[
    "/config.production.json",
    "/config.development.json",
    "/config.local.json",
    "/settings.local.json",
    "/runtime-config.production.json",
    "/runtime-config.production.js",
];

const OBSERVABILITY_AND_DEBUG_PATHS: &[&str] = &[
    "/actuator/env",
    "/actuator/configprops",
    "/debug/config",
    "/admin/config",
    "/internal/config",
];

const CLIENT_CONFIG_PATHS: &[&str] = &[
    "/config.js",
    "/settings.js",
    "/runtime-config.js",
    "/runtime-config.json",
    "/public/env.js",
];

const LEGACY_CONFIG_PATHS: &[&str] = &[
    "/config.yml",
    "/config.yaml",
    "/settings.json",
    "/application.yml",
    "/application.yaml",
];

const BACKUP_CONFIG_PATHS: &[&str] = &[
    "/.env.bak",
    "/.env.old",
    "/config.json.bak",
    "/config.yml.bak",
    "/application.yml.bak",
    "/settings.json.bak",
];

const DEFAULT_BOOTSTRAP_REPOSITORY_NAME: &str = "VulnScanner-zmap-alternative";
const DEFAULT_BOOTSTRAP_REPOSITORY_GITHUB_URL: &str =
    "https://github.com/Lorikazzzz/VulnScanner-zmap-alternative.git";
const DEFAULT_BOOTSTRAP_REPOSITORY_LOCAL_PATH: &str = "/root/AnyGPT/VulnScanner-zmap-alternative-";
const DEFAULT_BOOTSTRAP_REPOSITORY_STATUS: &str = "tracked";
const DEFAULT_BOOTSTRAP_REPOSITORY_DESCRIPTION: &str =
    "Standalone C scanner repository tracked for later runtime execution work.";
const DEFAULT_PORT_SCAN_RATE_LIMIT: u64 = 1_000;

fn default_bootstrap_repositories() -> Vec<RepositoryDefinition> {
    vec![RepositoryDefinition {
        name: DEFAULT_BOOTSTRAP_REPOSITORY_NAME.to_string(),
        github_url: DEFAULT_BOOTSTRAP_REPOSITORY_GITHUB_URL.to_string(),
        local_path: DEFAULT_BOOTSTRAP_REPOSITORY_LOCAL_PATH.to_string(),
        description: Some(DEFAULT_BOOTSTRAP_REPOSITORY_DESCRIPTION.to_string()),
        status: DEFAULT_BOOTSTRAP_REPOSITORY_STATUS.to_string(),
        related_target_ids: Vec::new(),
    }]
}

fn normalize_operator_configs(auth: &AuthConfig) -> Result<Vec<OperatorConfig>> {
    let operators = if auth.operators.is_empty() {
        vec![OperatorConfig {
            username: auth.admin_username.clone(),
            password: auth.admin_password.clone(),
            role: OperatorRole::Admin,
            enabled: true,
        }]
    } else {
        auth.operators.clone()
    };

    let mut normalized = Vec::new();
    for operator in operators {
        let username = operator.username.trim().to_ascii_lowercase();
        if username.is_empty() {
            return Err(anyhow!("auth.operators.username is required"));
        }
        if normalized
            .iter()
            .any(|existing: &OperatorConfig| existing.username == username)
        {
            return Err(anyhow!("duplicate auth operator username {username}"));
        }
        let password = operator.password.trim().to_string();
        if password.is_empty() {
            return Err(anyhow!("auth operator {username} password is required"));
        }
        normalized.push(OperatorConfig {
            username,
            password,
            role: operator.role,
            enabled: operator.enabled,
        });
    }

    if normalized.is_empty() {
        return Err(anyhow!("at least one auth operator is required"));
    }
    if !normalized.iter().any(|operator| operator.enabled) {
        return Err(anyhow!("at least one enabled auth operator is required"));
    }
    if !normalized
        .iter()
        .any(|operator| operator.enabled && operator.role == OperatorRole::Admin)
    {
        return Err(anyhow!("at least one enabled admin operator is required"));
    }

    Ok(normalized)
}

fn normalize_config_path_list(values: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let candidate = value.trim();
        if candidate.is_empty() {
            continue;
        }
        let candidate = candidate.to_string();
        if !normalized.contains(&candidate) {
            normalized.push(candidate);
        }
    }
    normalized
}

fn normalize_csv_string_list(values: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        for candidate in value.split(',') {
            let candidate = candidate.trim();
            if candidate.is_empty() {
                continue;
            }
            let candidate = candidate.to_string();
            if !normalized.contains(&candidate) {
                normalized.push(candidate);
            }
        }
    }
    normalized
}

fn normalize_worker_pool_name(value: &str) -> Option<String> {
    let normalized = value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| match character {
            'a'..='z' | '0'..='9' | '-' | '_' | '.' => character,
            _ => '-',
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn normalize_worker_tags(values: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let candidate = value.trim().to_ascii_lowercase();
        if !candidate.is_empty() && !normalized.contains(&candidate) {
            normalized.push(candidate);
        }
    }
    normalized
}

fn normalize_extension_name(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| match character {
            'a'..='z' | '0'..='9' | '-' | '_' | '.' => character,
            _ => '-',
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn normalize_extension_tags(values: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let tag = value.trim().to_ascii_lowercase();
        if !tag.is_empty() && !normalized.contains(&tag) {
            normalized.push(tag);
        }
    }
    normalized
}

fn extension_manifest_file_supported(path: &Path) -> bool {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
    {
        Some(extension) => matches!(extension.as_str(), "json" | "toml" | "yaml" | "yml"),
        None => false,
    }
}

fn normalize_extension_manifest(
    manifest: ExtensionManifest,
    source_path: &Path,
) -> Result<ExtensionManifest> {
    let name = normalize_extension_name(&manifest.name);
    if name.is_empty() {
        return Err(anyhow!(
            "extension manifest {} requires a name",
            source_path.display()
        ));
    }

    let version = manifest.version.trim().to_string();
    if version.is_empty() {
        return Err(anyhow!(
            "extension manifest {} requires a version",
            source_path.display()
        ));
    }

    let command = trim_optional_string(manifest.command);
    if manifest.enabled
        && matches!(
            manifest.kind,
            ExtensionKind::ScannerAdapter
                | ExtensionKind::DetectorPack
                | ExtensionKind::Importer
                | ExtensionKind::Provisioner
        )
        && command.is_none()
    {
        return Err(anyhow!(
            "{} extension {name} requires a command",
            manifest.kind.as_str()
        ));
    }

    let output_format = trim_optional_string(manifest.output_format);
    if manifest.enabled {
        match manifest.kind {
            ExtensionKind::ScannerAdapter => {
                if output_format
                    .as_deref()
                    .is_some_and(|value| value != "endpoint_lines" && value != "json_lines")
                {
                    return Err(anyhow!(
                        "scanner adapter extension {name} uses unsupported output_format {}; expected endpoint_lines or json_lines",
                        output_format.as_deref().unwrap_or_default()
                    ));
                }
            }
            ExtensionKind::DetectorPack => {
                if output_format
                    .as_deref()
                    .is_some_and(|value| value != "finding_json_lines")
                {
                    return Err(anyhow!(
                        "detector pack extension {name} uses unsupported output_format {}; expected finding_json_lines",
                        output_format.as_deref().unwrap_or_default()
                    ));
                }
            }
            ExtensionKind::Importer => {
                if output_format.as_deref().is_some_and(|value| {
                    value != "target_json_lines" && value != "target_url_lines"
                }) {
                    return Err(anyhow!(
                        "importer extension {name} uses unsupported output_format {}; expected target_json_lines or target_url_lines",
                        output_format.as_deref().unwrap_or_default()
                    ));
                }
            }
            ExtensionKind::Provisioner => {
                if output_format
                    .as_deref()
                    .is_some_and(|value| value != "text")
                {
                    return Err(anyhow!(
                        "provisioner extension {name} uses unsupported output_format {}; expected text",
                        output_format.as_deref().unwrap_or_default()
                    ));
                }
            }
            ExtensionKind::Enricher => {}
        }
    }

    Ok(ExtensionManifest {
        name,
        version,
        kind: manifest.kind,
        enabled: manifest.enabled,
        description: trim_optional_string(manifest.description),
        command,
        args: manifest
            .args
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect(),
        tags: normalize_extension_tags(&manifest.tags),
        output_format,
        source_path: Some(source_path.to_string_lossy().into_owned()),
    })
}

fn load_extension_manifest_from_path(path: &Path) -> Result<ExtensionManifest> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read extension manifest {}", path.display()))?;

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();

    let manifest = match extension.as_str() {
        "json" => {
            let manifest: ExtensionManifest = serde_json::from_str(&raw).with_context(|| {
                format!("failed to parse JSON extension manifest {}", path.display())
            })?;
            manifest
        }
        "toml" => {
            let manifest: ExtensionManifest = toml::from_str(&raw).with_context(|| {
                format!("failed to parse TOML extension manifest {}", path.display())
            })?;
            manifest
        }
        "yaml" | "yml" => {
            let manifest: ExtensionManifest = serde_yaml::from_str(&raw).with_context(|| {
                format!("failed to parse YAML extension manifest {}", path.display())
            })?;
            manifest
        }
        _ => {
            return Err(anyhow!(
                "unsupported extension manifest format {}; expected .json, .toml, .yaml, or .yml",
                path.display()
            ));
        }
    };

    normalize_extension_manifest(manifest, path)
}

fn collect_extension_manifest_paths(
    manifest_paths: &[String],
    manifest_dirs: &[String],
) -> Result<Vec<PathBuf>> {
    let mut candidates = Vec::new();

    for value in manifest_paths {
        let path = PathBuf::from(value);
        if !path.exists() {
            return Err(anyhow!(
                "extension manifest path {} does not exist",
                path.display()
            ));
        }
        if !path.is_file() {
            return Err(anyhow!(
                "extension manifest path {} must be a file",
                path.display()
            ));
        }
        if !extension_manifest_file_supported(&path) {
            return Err(anyhow!(
                "unsupported extension manifest path {}; expected .json, .toml, .yaml, or .yml",
                path.display()
            ));
        }
        let display = path.to_string_lossy().into_owned();
        if !candidates
            .iter()
            .any(|candidate: &PathBuf| candidate.to_string_lossy() == display)
        {
            candidates.push(path);
        }
    }

    for value in manifest_dirs {
        let dir = PathBuf::from(value);
        if !dir.exists() {
            return Err(anyhow!(
                "extension manifest directory {} does not exist",
                dir.display()
            ));
        }
        if !dir.is_dir() {
            return Err(anyhow!(
                "extension manifest directory {} must be a directory",
                dir.display()
            ));
        }
        let mut entries = fs::read_dir(&dir)
            .with_context(|| format!("failed to read extension directory {}", dir.display()))?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .map(|entry| entry.path())
            .filter(|path| path.is_file() && extension_manifest_file_supported(path))
            .collect::<Vec<_>>();
        entries.sort();
        for path in entries {
            let display = path.to_string_lossy().into_owned();
            if !candidates
                .iter()
                .any(|candidate: &PathBuf| candidate.to_string_lossy() == display)
            {
                candidates.push(path);
            }
        }
    }

    Ok(candidates)
}

fn load_extension_manifests_from_paths(
    manifest_paths: &[String],
    manifest_dirs: &[String],
) -> Result<Vec<ExtensionManifest>> {
    let mut manifests = Vec::new();
    let mut seen_names = Vec::new();

    for path in collect_extension_manifest_paths(manifest_paths, manifest_dirs)? {
        let manifest = load_extension_manifest_from_path(&path)?;
        if seen_names.contains(&manifest.name) {
            return Err(anyhow!(
                "duplicate extension manifest name {}",
                manifest.name
            ));
        }
        seen_names.push(manifest.name.clone());
        manifests.push(manifest);
    }

    Ok(manifests)
}

pub fn resolve_scan_proxy_url(scan: &ScanConfig) -> Option<String> {
    trim_optional_string(scan.proxy_url.clone()).or_else(|| {
        [
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "ALL_PROXY",
            "https_proxy",
            "http_proxy",
            "all_proxy",
        ]
        .iter()
        .find_map(|name| trim_optional_string(env::var(name).ok()))
    })
}

fn normalize_path_profiles(profiles: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();

    for profile in profiles {
        let lowered = profile.trim().to_ascii_lowercase();
        if !lowered.is_empty() && !normalized.contains(&lowered) {
            normalized.push(lowered);
        }
    }

    normalized
}

fn path_profile_paths(profile: &str) -> Option<&'static [&'static str]> {
    match profile {
        "baseline" => Some(BASELINE_PATHS),
        "public-entrypoints" => Some(PUBLIC_ENTRYPOINT_PATHS),
        "build-manifests" => Some(BUILD_MANIFEST_PATHS),
        "well-known-metadata" => Some(WELL_KNOWN_METADATA_PATHS),
        "sitemaps-and-indexes" => Some(SITEMAP_AND_INDEX_PATHS),
        "docs-and-explorers" => Some(DOCS_AND_EXPLORER_PATHS),
        "graphql-and-schema" => Some(GRAPHQL_AND_SCHEMA_PATHS),
        "service-workers-and-pwa" => Some(SERVICE_WORKER_AND_PWA_PATHS),
        "extended-framework-artifacts" => Some(EXTENDED_FRAMEWORK_ARTIFACT_PATHS),
        "extended-config-variants" => Some(EXTENDED_CONFIG_VARIANT_PATHS),
        "observability-and-debug" => Some(OBSERVABILITY_AND_DEBUG_PATHS),
        "js-bundles" => Some(JS_BUNDLE_PATHS),
        "source-maps" => Some(SOURCE_MAP_PATHS),
        "framework-leaks" => Some(FRAMEWORK_LEAK_PATHS),
        "client-configs" => Some(CLIENT_CONFIG_PATHS),
        "legacy-configs" => Some(LEGACY_CONFIG_PATHS),
        "backup-configs" => Some(BACKUP_CONFIG_PATHS),
        _ => None,
    }
}

fn expand_default_paths(default_paths: &[String], profiles: &[String]) -> Result<Vec<String>> {
    let mut combined = default_paths.to_vec();

    for profile in profiles {
        let profile_paths = path_profile_paths(profile).ok_or_else(|| {
            anyhow!(
                "unknown inventory.path_profiles entry {profile}; expected one of {}",
                KNOWN_PATH_PROFILES.join(", ")
            )
        })?;
        combined.extend(profile_paths.iter().map(|path| path.to_string()));
    }

    Ok(sanitize_paths(&combined))
}

fn normalize_request_profile_secret_refs(
    entries: &[RequestProfileSecretRef],
    kind: &str,
    profile_name: &str,
) -> Result<Vec<RequestProfileSecretRef>> {
    let mut normalized = Vec::new();
    let mut seen_names = Vec::new();

    for entry in entries {
        let name = entry.name.trim().to_string();
        if name.is_empty() {
            return Err(anyhow!(
                "request profile {profile_name} {kind} entries require a name"
            ));
        }

        let env = entry.env.trim().to_string();
        if env.is_empty() {
            return Err(anyhow!(
                "request profile {profile_name} {kind} entry {name} requires an env reference"
            ));
        }

        let dedupe_key = name.to_ascii_lowercase();
        if seen_names.contains(&dedupe_key) {
            return Err(anyhow!(
                "request profile {profile_name} defines duplicate {kind} entry {name}"
            ));
        }
        seen_names.push(dedupe_key);
        normalized.push(RequestProfileSecretRef { name, env });
    }

    Ok(normalized)
}

fn normalize_request_profiles(
    profiles: &[RequestProfileConfig],
) -> Result<Vec<RequestProfileConfig>> {
    let mut normalized = Vec::new();
    let mut seen_names = Vec::new();

    for profile in profiles {
        let Some(name) = normalize_request_profile_name(Some(profile.name.clone())) else {
            return Err(anyhow!("inventory.request_profiles entries require a name"));
        };

        if seen_names.contains(&name) {
            return Err(anyhow!("duplicate inventory.request_profiles entry {name}"));
        }
        seen_names.push(name.clone());

        let headers = normalize_request_profile_secret_refs(&profile.headers, "headers", &name)?;
        let cookies = normalize_request_profile_secret_refs(&profile.cookies, "cookies", &name)?;
        let bearer_token_env = profile
            .bearer_token_env
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        if headers.is_empty() && cookies.is_empty() && bearer_token_env.is_none() {
            return Err(anyhow!(
                "request profile {name} must define at least one header, cookie, or bearer token env reference"
            ));
        }

        normalized.push(RequestProfileConfig {
            name,
            headers,
            cookies,
            bearer_token_env,
        });
    }

    Ok(normalized)
}

fn normalize_gobuster_token_list(values: &[String], lowercase: bool) -> Vec<String> {
    let mut normalized = Vec::new();

    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        let candidate = if lowercase {
            trimmed.to_ascii_lowercase()
        } else {
            trimmed.to_string()
        };
        if !normalized.contains(&candidate) {
            normalized.push(candidate);
        }
    }

    normalized
}

fn normalize_gobuster_extensions(values: &[String]) -> Vec<String> {
    normalize_gobuster_token_list(values, true)
        .into_iter()
        .map(|value| value.trim_start_matches('.').to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn normalize_gobuster_patterns(values: &[String]) -> Result<Vec<String>> {
    let normalized = normalize_gobuster_token_list(values, false);
    for pattern in &normalized {
        if !pattern.contains("{GOBUSTER}") {
            return Err(anyhow!(
                "scan.gobuster.patterns entries must contain {{GOBUSTER}}"
            ));
        }
    }
    Ok(normalized)
}

fn normalize_gobuster_status_codes(values: &[u16]) -> Vec<u16> {
    let mut normalized = values.to_vec();
    normalized.sort_unstable();
    normalized.dedup();
    normalized
}

fn normalize_gobuster_exclude_lengths(values: &[usize]) -> Vec<usize> {
    let mut normalized = values.to_vec();
    normalized.sort_unstable();
    normalized.dedup();
    normalized
}

fn normalize_target_gobuster_config(config: GobusterTargetConfig) -> Result<GobusterTargetConfig> {
    Ok(GobusterTargetConfig {
        enabled: config.enabled,
        wordlist: normalize_gobuster_token_list(&config.wordlist, false),
        extensions: normalize_gobuster_extensions(&config.extensions),
        add_slash: config.add_slash,
        discover_backup: config.discover_backup,
    })
}

fn parse_boolish(value: &str) -> bool {
    matches!(value, "1" | "true" | "TRUE" | "yes")
}

fn trim_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_repository_status(value: Option<String>) -> String {
    let raw = value.unwrap_or_default();
    let normalized = raw
        .replace('_', " ")
        .split_whitespace()
        .map(|segment| segment.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join("-");
    if normalized.is_empty() {
        DEFAULT_BOOTSTRAP_REPOSITORY_STATUS.to_string()
    } else {
        normalized
    }
}

fn normalize_repository_related_target_ids(values: &[i64]) -> Vec<i64> {
    let mut normalized = values
        .iter()
        .copied()
        .filter(|target_id| *target_id > 0)
        .collect::<Vec<_>>();
    normalized.sort_unstable();
    normalized.dedup();
    normalized
}

fn normalize_inventory_host(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        return None;
    }

    let unwrapped = trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(trimmed);
    let normalized = unwrapped.trim().to_ascii_lowercase();
    (!normalized.is_empty()).then_some(normalized)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct InventoryCidr {
    network: IpAddr,
    prefix_len: u8,
}

impl InventoryCidr {
    fn parse(value: &str) -> Result<Self> {
        let trimmed = value.trim();
        let (host, prefix_len) = trimmed
            .split_once('/')
            .ok_or_else(|| anyhow!("inventory CIDR {trimmed} must be in host/prefix format"))?;
        let host = normalize_inventory_host(host)
            .ok_or_else(|| anyhow!("inventory CIDR {trimmed} must include a host"))?;
        let ip = host
            .parse::<IpAddr>()
            .with_context(|| format!("inventory CIDR {trimmed} must use an IPv4 or IPv6 host"))?;
        let prefix_len = prefix_len.trim().parse::<u8>().with_context(|| {
            format!("inventory CIDR {trimmed} must use a numeric prefix length")
        })?;
        let max_prefix_len = match ip {
            IpAddr::V4(_) => 32,
            IpAddr::V6(_) => 128,
        };
        if prefix_len > max_prefix_len {
            return Err(anyhow!(
                "inventory CIDR {trimmed} prefix length must be between 0 and {max_prefix_len}"
            ));
        }

        Ok(Self {
            network: truncate_ip_to_prefix(ip, prefix_len),
            prefix_len,
        })
    }

    fn contains(&self, candidate: IpAddr) -> bool {
        match (self.network, candidate) {
            (IpAddr::V4(_), IpAddr::V4(_)) | (IpAddr::V6(_), IpAddr::V6(_)) => {
                truncate_ip_to_prefix(candidate, self.prefix_len) == self.network
            }
            _ => false,
        }
    }

    fn canonical_string(&self) -> String {
        format!("{}/{}", self.network, self.prefix_len)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PortScanTargetRange {
    Single(Ipv4Addr),
    Cidr(InventoryCidr),
    Range(Ipv4Addr, Ipv4Addr),
}

impl PortScanTargetRange {
    fn parse(value: &str) -> Result<Self> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("port scan target_range is required"));
        }

        if trimmed.contains('/') {
            let cidr = InventoryCidr::parse(trimmed)
                .with_context(|| format!("invalid port scan target range {trimmed}"))?;
            if !matches!(cidr.network, IpAddr::V4(_)) {
                return Err(anyhow!(
                    "port scan target_range {trimmed} must use IPv4 addresses"
                ));
            }
            return Ok(Self::Cidr(cidr));
        }

        if let Some((start, end)) = trimmed.split_once('-') {
            let start = parse_port_scan_ipv4_address(start, trimmed)?;
            let end = parse_port_scan_ipv4_address(end, trimmed)?;
            if u32::from(start) > u32::from(end) {
                return Err(anyhow!(
                    "port scan target_range {trimmed} must use an ascending IPv4 range"
                ));
            }
            return Ok(Self::Range(start, end));
        }

        Ok(Self::Single(parse_port_scan_ipv4_address(
            trimmed, trimmed,
        )?))
    }

    fn canonical_string(&self) -> String {
        match self {
            Self::Single(address) => address.to_string(),
            Self::Cidr(cidr) => cidr.canonical_string(),
            Self::Range(start, end) => format!("{start}-{end}"),
        }
    }

    fn start_ip(&self) -> Ipv4Addr {
        match self {
            Self::Single(address) => *address,
            Self::Cidr(cidr) => match cidr.network {
                IpAddr::V4(address) => address,
                IpAddr::V6(_) => unreachable!("port scan CIDRs are validated as IPv4"),
            },
            Self::Range(start, _) => *start,
        }
    }

    fn end_ip(&self) -> Ipv4Addr {
        match self {
            Self::Single(address) => *address,
            Self::Cidr(cidr) => match cidr.network {
                IpAddr::V4(address) => {
                    let host_bits = 32u32.saturating_sub(cidr.prefix_len as u32);
                    let base = u32::from(address);
                    let mask = if host_bits == 32 {
                        u32::MAX
                    } else if host_bits == 0 {
                        0
                    } else {
                        (1u32 << host_bits) - 1
                    };
                    Ipv4Addr::from(base | mask)
                }
                IpAddr::V6(_) => unreachable!("port scan CIDRs are validated as IPv4"),
            },
            Self::Range(_, end) => *end,
        }
    }

    fn is_single_host(&self) -> bool {
        matches!(self, Self::Single(_))
    }
}

fn normalize_inventory_cidr(value: &str) -> Result<String> {
    InventoryCidr::parse(value).map(|cidr| cidr.canonical_string())
}

fn parse_port_scan_ipv4_address(value: &str, target_range: &str) -> Result<Ipv4Addr> {
    value
        .trim()
        .parse::<Ipv4Addr>()
        .with_context(|| format!("port scan target_range {target_range} must use IPv4 addresses"))
}

fn port_scan_range_is_allowed(
    inventory: &InventoryConfig,
    target_range: &PortScanTargetRange,
) -> bool {
    if inventory.allowed_host_suffixes.is_empty()
        && inventory.allowed_hosts.is_empty()
        && inventory.allowed_cidrs.is_empty()
    {
        return true;
    }

    if target_range.is_single_host() {
        return inventory.host_is_allowed(&target_range.start_ip().to_string());
    }

    inventory.allowed_cidrs.iter().any(|allowed_cidr| {
        InventoryCidr::parse(allowed_cidr)
            .map(|cidr| {
                cidr.contains(IpAddr::V4(target_range.start_ip()))
                    && cidr.contains(IpAddr::V4(target_range.end_ip()))
            })
            .unwrap_or(false)
    })
}

pub fn parse_port_scan_ports(value: &str) -> Result<Vec<u16>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("port scan ports are required"));
    }

    let mut ports = Vec::new();
    for segment in trimmed.split(',') {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }

        if let Some((start, end)) = segment.split_once('-') {
            let start = parse_port_scan_port_value(start, segment)?;
            let end = parse_port_scan_port_value(end, segment)?;
            if start > end {
                return Err(anyhow!(
                    "port scan port range {segment} must use an ascending range"
                ));
            }
            for port in start..=end {
                if !ports.contains(&port) {
                    ports.push(port);
                }
            }
            continue;
        }

        let port = parse_port_scan_port_value(segment, segment)?;
        if !ports.contains(&port) {
            ports.push(port);
        }
    }

    if ports.is_empty() {
        return Err(anyhow!("port scan ports are required"));
    }

    Ok(ports)
}

fn parse_port_scan_port_value(value: &str, segment: &str) -> Result<u16> {
    let port = value
        .trim()
        .parse::<u16>()
        .with_context(|| format!("invalid port scan port value {value}"))?;
    if port == 0 {
        return Err(anyhow!(
            "port scan port segment {segment} must use ports between 1 and 65535"
        ));
    }
    Ok(port)
}

fn truncate_ip_to_prefix(ip: IpAddr, prefix_len: u8) -> IpAddr {
    match ip {
        IpAddr::V4(address) => {
            let mask = if prefix_len == 0 {
                0
            } else {
                u32::MAX << (32 - prefix_len)
            };
            IpAddr::V4(Ipv4Addr::from(u32::from(address) & mask))
        }
        IpAddr::V6(address) => {
            let mask = if prefix_len == 0 {
                0
            } else {
                u128::MAX << (128 - prefix_len)
            };
            IpAddr::V6(Ipv6Addr::from(u128::from(address) & mask))
        }
    }
}

#[derive(Debug, Default)]
struct AnyGptApiRedisCredentials {
    redis_url: String,
    redis_username: Option<String>,
    redis_password: Option<String>,
    redis_db: Option<i64>,
    redis_tls: Option<bool>,
}

fn parse_dotenv_assignment(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    let trimmed = trimmed.strip_prefix("export ").unwrap_or(trimmed).trim();
    let (key, raw_value) = trimmed.split_once('=')?;
    let key = key.trim();
    if key.is_empty() {
        return None;
    }

    let mut value = raw_value.trim().to_string();
    let is_quoted = ((value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\'')))
        && value.len() >= 2;
    if is_quoted {
        value = value[1..value.len() - 1].to_string();
    } else if let Some((prefix, _)) = value.split_once(" #") {
        value = prefix.trim_end().to_string();
    }

    Some((key.to_string(), value))
}

fn load_anygpt_api_redis_credentials(path: &Path) -> Result<AnyGptApiRedisCredentials> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read AnyGPT API env file {}", path.display()))?;
    let mut credentials = AnyGptApiRedisCredentials::default();

    for line in raw.lines() {
        let Some((key, value)) = parse_dotenv_assignment(line) else {
            continue;
        };
        match key.as_str() {
            "REDIS_URL" => credentials.redis_url = value,
            "REDIS_USERNAME" => credentials.redis_username = Some(value),
            "REDIS_PASSWORD" => credentials.redis_password = Some(value),
            "REDIS_DB" => {
                let parsed = value.parse::<i64>().with_context(|| {
                    format!(
                        "AnyGPT API env file {} has invalid REDIS_DB value {value}",
                        path.display()
                    )
                })?;
                credentials.redis_db = Some(parsed);
            }
            "REDIS_TLS" => credentials.redis_tls = Some(parse_boolish(&value)),
            _ => {}
        }
    }

    if credentials.redis_url.trim().is_empty() {
        return Err(anyhow!(
            "AnyGPT API env file {} does not define REDIS_URL",
            path.display()
        ));
    }

    Ok(credentials)
}

fn resolved_redis_db_from_url(redis_url: &str, fallback_db: i64, url_label: &str) -> Result<i64> {
    let redis_url = redis_url.trim();
    if redis_url.is_empty() {
        return Ok(fallback_db);
    }
    if !redis_url.contains("://") {
        return Ok(fallback_db);
    }

    let parsed =
        Url::parse(redis_url).with_context(|| format!("invalid {url_label} {redis_url}"))?;
    let path = parsed.path().trim();
    if path.is_empty() || path == "/" {
        return Ok(fallback_db);
    }

    let db_path = path.trim_start_matches('/');
    if db_path.is_empty() {
        return Ok(fallback_db);
    }
    if db_path.contains('/') {
        return Err(anyhow!(
            "{url_label} database path must be a single /<db-number> segment, received {redis_url}"
        ));
    }

    let redis_db = db_path.parse::<i64>().with_context(|| {
        format!("{url_label} database path must be numeric, received {redis_url}")
    })?;
    if redis_db < 0 {
        return Err(anyhow!("{url_label} database path must be zero or greater"));
    }
    Ok(redis_db)
}

fn resolved_anygpt_api_redis_db(credentials: &AnyGptApiRedisCredentials) -> Result<i64> {
    resolved_redis_db_from_url(
        &credentials.redis_url,
        credentials.redis_db.unwrap_or(0),
        "AnyGPT API REDIS_URL",
    )
}

fn inherited_redis_url_for_anyscan(redis_url: &str) -> Result<String> {
    let redis_url = redis_url.trim();
    if redis_url.is_empty() {
        return Err(anyhow!("AnyGPT API REDIS_URL must not be empty"));
    }

    if !redis_url.contains("://") {
        return Ok(redis_url.to_string());
    }

    let mut parsed = Url::parse(redis_url)
        .with_context(|| format!("invalid AnyGPT API REDIS_URL {redis_url}"))?;
    parsed.set_path("/");
    Ok(parsed.to_string())
}

fn push_unique_candidate(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidates.contains(&candidate) {
        candidates.push(candidate);
    }
}

fn collect_anygpt_api_env_candidates(candidates: &mut Vec<PathBuf>, base: &Path, env_file: &str) {
    push_unique_candidate(candidates, base.join(env_file));
    push_unique_candidate(candidates, base.join("apps").join("api").join(env_file));
    push_unique_candidate(candidates, base.join("api").join(env_file));

    if let Some(parent) = base.parent() {
        push_unique_candidate(candidates, parent.join("api").join(env_file));
        push_unique_candidate(candidates, parent.join("apps").join("api").join(env_file));
    }
}

fn resolve_anygpt_api_env_path(
    config_path: Option<&Path>,
    explicit_path: Option<&str>,
) -> Result<Option<PathBuf>> {
    if let Some(explicit_path) = explicit_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let candidate = PathBuf::from(explicit_path);
        if candidate.exists() {
            return Ok(Some(candidate));
        }
        return Err(anyhow!(
            "AnyGPT API env file {} does not exist",
            candidate.display()
        ));
    }

    let env_file = if env::var("NODE_ENV").ok().as_deref() == Some("test") {
        ".env.test"
    } else {
        ".env"
    };
    let mut candidates = Vec::new();

    if let Some(config_path) = config_path {
        if let Some(parent) = config_path.parent() {
            collect_anygpt_api_env_candidates(&mut candidates, parent, env_file);
        }
    }
    if let Ok(current_dir) = env::current_dir() {
        collect_anygpt_api_env_candidates(&mut candidates, &current_dir, env_file);
    }
    collect_anygpt_api_env_candidates(
        &mut candidates,
        Path::new(env!("CARGO_MANIFEST_DIR")),
        env_file,
    );

    Ok(candidates.into_iter().find(|candidate| candidate.exists()))
}

impl InventoryConfig {
    pub fn request_profile(&self, name: &str) -> Option<&RequestProfileConfig> {
        let normalized_name = normalize_request_profile_name(Some(name.to_string()))?;
        self.request_profiles
            .iter()
            .find(|profile| profile.name == normalized_name)
    }

    pub fn host_is_allowed(&self, host: &str) -> bool {
        let Some(host) = normalize_inventory_host(host) else {
            return false;
        };
        let cidr_allowed = host.parse::<IpAddr>().ok().is_some_and(|ip| {
            self.allowed_cidrs.iter().any(|cidr| {
                InventoryCidr::parse(cidr)
                    .map(|cidr| cidr.contains(ip))
                    .unwrap_or(false)
            })
        });
        let host_allowed = self.allowed_host_suffixes.is_empty()
            && self.allowed_hosts.is_empty()
            && self.allowed_cidrs.is_empty()
            || self
                .allowed_hosts
                .iter()
                .any(|allowed_host| allowed_host == &host)
            || self
                .allowed_host_suffixes
                .iter()
                .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
            || cidr_allowed;

        host_allowed
    }

    pub fn port_is_allowed(&self, port: Option<u16>) -> bool {
        if self.allowed_ports.is_empty() {
            return true;
        }

        port.is_some_and(|port| self.allowed_ports.contains(&port))
    }

    pub fn url_is_allowed(&self, url: &Url) -> bool {
        let Some(host) = url.host_str() else {
            return false;
        };

        self.host_is_allowed(host) && self.port_is_allowed(url.port_or_known_default())
    }
}

impl AppConfig {
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let mut config = if let Some(path) = path {
            if path.exists() {
                let raw = fs::read_to_string(path)
                    .with_context(|| format!("failed to read config file {}", path.display()))?;
                toml::from_str::<AppConfig>(&raw)
                    .with_context(|| format!("failed to parse config file {}", path.display()))?
            } else {
                AppConfig::default()
            }
        } else {
            AppConfig::default()
        };

        config.apply_env_overrides();
        config.apply_anygpt_api_redis_credentials(path)?;
        config.validate()?;
        Ok(config)
    }

    fn should_inherit_anygpt_api_redis_credentials(&self) -> bool {
        let redis_url_needs_inheritance = self.storage.redis_url.is_none()
            || self.storage.redis_url.as_deref() == Some(DEFAULT_ANYSCAN_REDIS_URL);
        let missing_auth =
            self.storage.redis_username.is_none() || self.storage.redis_password.is_none();
        let missing_tls = !self.storage.redis_tls;

        redis_url_needs_inheritance
            || (self.storage.anygpt_api_env_path.is_some() && (missing_auth || missing_tls))
    }

    fn apply_anygpt_api_redis_credentials(&mut self, config_path: Option<&Path>) -> Result<()> {
        if !self.should_inherit_anygpt_api_redis_credentials() {
            return Ok(());
        }

        let Some(env_path) =
            resolve_anygpt_api_env_path(config_path, self.storage.anygpt_api_env_path.as_deref())?
        else {
            return Ok(());
        };
        let credentials = load_anygpt_api_redis_credentials(&env_path)?;
        self.storage.anygpt_api_env_path = Some(env_path.to_string_lossy().into_owned());
        let redis_url_needs_inheritance = self.storage.redis_url.is_none()
            || self.storage.redis_url.as_deref() == Some(DEFAULT_ANYSCAN_REDIS_URL);

        if redis_url_needs_inheritance {
            self.storage.redis_url = Some(inherited_redis_url_for_anyscan(
                &credentials.redis_url,
            )?);
        }
        if self.storage.redis_username.is_none() {
            self.storage.redis_username = credentials.redis_username.clone();
        }
        if self.storage.redis_password.is_none() {
            self.storage.redis_password = credentials.redis_password.clone();
        }
        if !self.storage.redis_tls {
            if let Some(redis_tls) = credentials.redis_tls {
                self.storage.redis_tls = redis_tls;
            }
        }

        let anygpt_api_db = resolved_anygpt_api_redis_db(&credentials)?;
        let anyscan_db = resolved_dragonfly_db(&self.storage)?;
        if anyscan_db == anygpt_api_db {
            self.storage.redis_db = anygpt_api_db;
        }

        Ok(())
    }

    pub fn validate(&mut self) -> Result<()> {
        let bind_addr: SocketAddr = self
            .server
            .bind_addr
            .parse()
            .with_context(|| format!("invalid bind address {}", self.server.bind_addr))?;

        if self.server.private_control_plane_only && !bind_addr.ip().is_loopback() {
            return Err(anyhow!(
                "server.private_control_plane_only requires a loopback bind address"
            ));
        }

        self.auth.operators = normalize_operator_configs(&self.auth)?;
        if self.auth.session_ttl_seconds == 0 {
            return Err(anyhow!(
                "auth.session_ttl_seconds must be greater than zero"
            ));
        }
        if let Some(primary_admin) = self
            .auth
            .operators
            .iter()
            .find(|operator| operator.enabled && operator.role == OperatorRole::Admin)
            .or_else(|| self.auth.operators.iter().find(|operator| operator.enabled))
        {
            self.auth.admin_username = primary_admin.username.clone();
            self.auth.admin_password = primary_admin.password.clone();
        }

        self.inventory.allowed_host_suffixes = self
            .inventory
            .allowed_host_suffixes
            .iter()
            .filter_map(|suffix| normalize_inventory_host(suffix))
            .collect();
        self.inventory.allowed_host_suffixes.sort();
        self.inventory.allowed_host_suffixes.dedup();

        self.inventory.allowed_hosts = self
            .inventory
            .allowed_hosts
            .iter()
            .filter_map(|host| normalize_inventory_host(host))
            .collect();
        self.inventory.allowed_hosts.sort();
        self.inventory.allowed_hosts.dedup();

        self.inventory.allowed_cidrs = self
            .inventory
            .allowed_cidrs
            .iter()
            .map(|cidr| normalize_inventory_cidr(cidr))
            .collect::<Result<Vec<_>>>()?;
        self.inventory.allowed_cidrs.sort();
        self.inventory.allowed_cidrs.dedup();

        self.inventory.allowed_ports.sort_unstable();
        self.inventory.allowed_ports.dedup();

        self.inventory.path_profiles = normalize_path_profiles(&self.inventory.path_profiles);
        self.inventory.default_paths =
            expand_default_paths(&self.inventory.default_paths, &self.inventory.path_profiles)?;
        self.inventory.request_profiles =
            normalize_request_profiles(&self.inventory.request_profiles)?;
        if self.inventory.default_paths.is_empty() {
            return Err(anyhow!(
                "inventory.default_paths must contain at least one path"
            ));
        }

        if self.scan.concurrency == 0 {
            return Err(anyhow!("scan.concurrency must be greater than zero"));
        }

        if self.scan.request_timeout_secs == 0 {
            return Err(anyhow!(
                "scan.request_timeout_secs must be greater than zero"
            ));
        }

        if self.scan.max_response_bytes < 4096 {
            return Err(anyhow!(
                "scan.max_response_bytes must be at least 4096 bytes"
            ));
        }

        if self.scan.max_paths_per_target == 0 {
            return Err(anyhow!(
                "scan.max_paths_per_target must be greater than zero"
            ));
        }

        if self.scan.max_parallel_paths_per_target == 0 {
            return Err(anyhow!(
                "scan.max_parallel_paths_per_target must be greater than zero"
            ));
        }

        if self.scan.max_concurrent_requests_per_host == 0 {
            return Err(anyhow!(
                "scan.max_concurrent_requests_per_host must be greater than zero"
            ));
        }

        if self.scan.host_backoff_initial_ms == 0 {
            return Err(anyhow!(
                "scan.host_backoff_initial_ms must be greater than zero"
            ));
        }

        if self.scan.host_backoff_max_ms < self.scan.host_backoff_initial_ms {
            return Err(anyhow!(
                "scan.host_backoff_max_ms must be greater than or equal to scan.host_backoff_initial_ms"
            ));
        }

        if self.scan.max_discovered_paths_per_target > self.scan.max_paths_per_target {
            return Err(anyhow!(
                "scan.max_discovered_paths_per_target must be less than or equal to scan.max_paths_per_target"
            ));
        }

        self.public.service_name = self.public.service_name.trim().to_string();
        if self.public.service_name.is_empty() {
            return Err(anyhow!("public.service_name is required"));
        }
        self.public.base_url = trim_optional_string(self.public.base_url.take());
        if let Some(base_url) = self.public.base_url.as_deref() {
            let mut parsed = Url::parse(base_url)
                .with_context(|| format!("invalid public.base_url {base_url}"))?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(anyhow!("public.base_url must use http or https"));
            }
            parsed.set_query(None);
            parsed.set_fragment(None);
            self.public.base_url = Some(parsed.to_string().trim_end_matches('/').to_string());
        }
        self.public.security_email = self.public.security_email.trim().to_string();
        self.public.abuse_email = self.public.abuse_email.trim().to_string();
        self.public.opt_out_email = self.public.opt_out_email.trim().to_string();
        if self.public.security_email.is_empty() {
            return Err(anyhow!("public.security_email is required"));
        }
        if self.public.abuse_email.is_empty() {
            return Err(anyhow!("public.abuse_email is required"));
        }
        if self.public.opt_out_email.is_empty() {
            return Err(anyhow!("public.opt_out_email is required"));
        }
        self.public.scanner_ip_ranges = normalize_csv_string_list(&self.public.scanner_ip_ranges);
        self.public.scanner_asns = normalize_csv_string_list(&self.public.scanner_asns);
        self.public.reverse_dns_patterns =
            normalize_csv_string_list(&self.public.reverse_dns_patterns);
        self.public.user_agent_examples =
            normalize_csv_string_list(&self.public.user_agent_examples);
        self.public.published_search_scope =
            normalize_csv_string_list(&self.public.published_search_scope);
        if self.public.published_search_scope.is_empty() {
            return Err(anyhow!(
                "public.published_search_scope must contain at least one entry"
            ));
        }
        if self.public.data_retention_days == 0 {
            return Err(anyhow!(
                "public.data_retention_days must be greater than zero"
            ));
        }
        if self.public.opt_out_response_sla_hours == 0 {
            return Err(anyhow!(
                "public.opt_out_response_sla_hours must be greater than zero"
            ));
        }

        self.scan.proxy_url = trim_optional_string(self.scan.proxy_url.take());
        self.scan.extension_manifest_paths =
            normalize_config_path_list(&self.scan.extension_manifest_paths);
        self.scan.extension_manifest_dirs =
            normalize_config_path_list(&self.scan.extension_manifest_dirs);

        if matches!(self.scan.proxy_mode, ProxyMode::ProxyOnly)
            && resolve_scan_proxy_url(&self.scan).is_none()
        {
            return Err(anyhow!(
                "scan.proxy_mode proxy_only requires scan.proxy_url or HTTP_PROXY/HTTPS_PROXY/ALL_PROXY"
            ));
        }
        if let Some(proxy_url) = self.scan.proxy_url.as_deref() {
            let parsed_proxy_url = Url::parse(proxy_url)
                .with_context(|| format!("invalid scan.proxy_url {proxy_url}"))?;
            if !matches!(parsed_proxy_url.scheme(), "http" | "https") {
                return Err(anyhow!("scan.proxy_url must use http or https"));
            }
        }
        let _ = load_extension_manifests_from_paths(
            &self.scan.extension_manifest_paths,
            &self.scan.extension_manifest_dirs,
        )?;

        self.scan.gobuster.wordlist =
            normalize_gobuster_token_list(&self.scan.gobuster.wordlist, false);
        self.scan.gobuster.patterns = normalize_gobuster_patterns(&self.scan.gobuster.patterns)?;
        self.scan.gobuster.extensions =
            normalize_gobuster_extensions(&self.scan.gobuster.extensions);
        self.scan.gobuster.status_codes =
            normalize_gobuster_status_codes(&self.scan.gobuster.status_codes);
        self.scan.gobuster.status_codes_blacklist =
            normalize_gobuster_status_codes(&self.scan.gobuster.status_codes_blacklist);
        self.scan.gobuster.exclude_lengths =
            normalize_gobuster_exclude_lengths(&self.scan.gobuster.exclude_lengths);

        if self.scan.gobuster.max_candidates_per_target == 0 {
            return Err(anyhow!(
                "scan.gobuster.max_candidates_per_target must be greater than zero"
            ));
        }

        if self.scan.gobuster.enabled && self.scan.gobuster.wordlist.is_empty() {
            return Err(anyhow!(
                "scan.gobuster.enabled requires at least one scan.gobuster.wordlist entry"
            ));
        }

        if !self.scan.gobuster.status_codes.is_empty()
            && self
                .scan
                .gobuster
                .status_codes
                .iter()
                .any(|code| self.scan.gobuster.status_codes_blacklist.contains(code))
        {
            return Err(anyhow!(
                "scan.gobuster.status_codes and scan.gobuster.status_codes_blacklist must not overlap"
            ));
        }

        let has_non_default_admin_password = self.auth.operators.iter().any(|operator| {
            operator.enabled
                && operator.role == OperatorRole::Admin
                && operator.password != "change-me"
        });
        if !bind_addr.ip().is_loopback()
            && (!has_non_default_admin_password
                || self.auth.jwt_secret == "change-me-session-secret")
        {
            return Err(anyhow!(
                "non-loopback binds require a non-default admin password and ANYSCAN_JWT_SECRET override"
            ));
        }

        let bootstrap = self
            .inventory
            .bootstrap_targets
            .clone()
            .into_iter()
            .map(|target| self.normalize_target_definition(target))
            .collect::<Result<Vec<_>>>()?;
        self.inventory.bootstrap_targets = bootstrap;

        let bootstrap_repositories = self
            .inventory
            .bootstrap_repositories
            .clone()
            .into_iter()
            .map(|repository| self.normalize_repository_definition(repository))
            .collect::<Result<Vec<_>>>()?;
        self.inventory.bootstrap_repositories = bootstrap_repositories;

        self.storage.redis_url = trim_optional_string(self.storage.redis_url.take());
        self.storage.redis_username = trim_optional_string(self.storage.redis_username.take());
        self.storage.redis_password = trim_optional_string(self.storage.redis_password.take());
        self.storage.anygpt_api_env_path =
            trim_optional_string(self.storage.anygpt_api_env_path.take());
        self.storage.redis_key_prefix = self.storage.redis_key_prefix.trim().to_string();
        if self.storage.redis_key_prefix.is_empty() {
            self.storage.redis_key_prefix = DEFAULT_ANYSCAN_REDIS_KEY_PREFIX.to_string();
        }
        if self.storage.redis_db < 0 {
            return Err(anyhow!("storage.redis_db must be zero or greater"));
        }
        if self.storage.redis_lock_ttl_ms == 0 {
            return Err(anyhow!(
                "storage.redis_lock_ttl_ms must be greater than zero"
            ));
        }
        if self.storage.redis_lock_retry_delay_ms == 0 {
            return Err(anyhow!(
                "storage.redis_lock_retry_delay_ms must be greater than zero"
            ));
        }
        if self.storage.redis_lock_max_wait_ms == 0 {
            return Err(anyhow!(
                "storage.redis_lock_max_wait_ms must be greater than zero"
            ));
        }
        if self.storage.redis_startup_timeout_seconds == 0 {
            return Err(anyhow!(
                "storage.redis_startup_timeout_seconds must be greater than zero"
            ));
        }
        if self.storage.redis_run_lease_seconds == 0 {
            return Err(anyhow!(
                "storage.redis_run_lease_seconds must be greater than zero"
            ));
        }
        if self.storage.redis_url.is_none() {
            return Err(anyhow!("Dragonfly requires REDIS_URL or storage.redis_url"));
        }
        let resolved_redis_db = resolved_dragonfly_db(&self.storage)?;
        if resolved_redis_db == RESERVED_ANYGPT_EXPERIMENTAL_REDIS_DB {
            return Err(anyhow!(
                "Dragonfly DB 1 is reserved by AnyGPT API experimental/control-plane workflows and may be flushed during startup cloning; use REDIS_DB=0 with a dedicated ANYSCAN_REDIS_KEY_PREFIX or another supported dedicated DB"
            ));
        }

        Ok(())
    }

    pub fn scan_defaults_summary(&self) -> ScanDefaultsSummary {
        ScanDefaultsSummary {
            concurrency: self.scan.concurrency,
            request_timeout_secs: self.scan.request_timeout_secs,
            max_response_bytes: self.scan.max_response_bytes,
            max_paths_per_target: self.scan.max_paths_per_target,
            max_parallel_paths_per_target: self.scan.max_parallel_paths_per_target,
            max_concurrent_requests_per_host: self.scan.max_concurrent_requests_per_host,
            enable_path_discovery: self.scan.enable_path_discovery,
            max_discovered_paths_per_target: self.scan.max_discovered_paths_per_target,
            host_backoff_initial_ms: self.scan.host_backoff_initial_ms,
            host_backoff_max_ms: self.scan.host_backoff_max_ms,
            poll_interval_seconds: self.scan.poll_interval_seconds,
            allow_invalid_tls: self.scan.allow_invalid_tls,
            directory_probing_enabled: self.scan.gobuster.enabled,
            directory_probing_wordlist_count: self.scan.gobuster.wordlist.len(),
            directory_probing_wordlist: self.scan.gobuster.wordlist.clone(),
            directory_probing_extensions: self.scan.gobuster.extensions.clone(),
            directory_probing_add_slash: self.scan.gobuster.add_slash,
            directory_probing_discover_backup: self.scan.gobuster.discover_backup,
        }
    }

    pub fn with_scan_defaults_summary(&self, summary: &ScanDefaultsSummary) -> Result<Self> {
        let mut config = self.clone();
        config.scan.concurrency = summary.concurrency;
        config.scan.request_timeout_secs = summary.request_timeout_secs;
        config.scan.max_response_bytes = summary.max_response_bytes;
        config.scan.max_paths_per_target = summary.max_paths_per_target;
        config.scan.max_parallel_paths_per_target = summary.max_parallel_paths_per_target;
        config.scan.max_concurrent_requests_per_host = summary.max_concurrent_requests_per_host;
        config.scan.enable_path_discovery = summary.enable_path_discovery;
        config.scan.max_discovered_paths_per_target = summary.max_discovered_paths_per_target;
        config.scan.host_backoff_initial_ms = summary.host_backoff_initial_ms;
        config.scan.host_backoff_max_ms = summary.host_backoff_max_ms;
        config.scan.poll_interval_seconds = summary.poll_interval_seconds;
        config.scan.allow_invalid_tls = summary.allow_invalid_tls;
        config.scan.gobuster.enabled = summary.directory_probing_enabled;
        config.scan.gobuster.wordlist = summary.directory_probing_wordlist.clone();
        config.scan.gobuster.extensions = summary.directory_probing_extensions.clone();
        config.scan.gobuster.add_slash = summary.directory_probing_add_slash;
        config.scan.gobuster.discover_backup = summary.directory_probing_discover_backup;
        config.validate()?;
        Ok(config)
    }

    pub fn resolved_default_paths(&self) -> Result<Vec<String>> {
        let profiles = normalize_path_profiles(&self.inventory.path_profiles);
        expand_default_paths(&self.inventory.default_paths, &profiles)
    }

    pub fn normalize_target_definition(
        &self,
        target: TargetDefinition,
    ) -> Result<TargetDefinition> {
        let strategy = target.strategy;
        let label = target.label.trim().to_string();
        if label.is_empty() {
            return Err(anyhow!("target label is required"));
        }

        let mut url = Url::parse(target.base_url.trim())
            .with_context(|| format!("invalid target URL {}", target.base_url))?;

        let scheme = url.scheme();
        if scheme != "http" && scheme != "https" {
            return Err(anyhow!("target URL must use http or https"));
        }

        if url.query().is_some() || url.fragment().is_some() {
            return Err(anyhow!(
                "target URL must not include query strings or fragments"
            ));
        }

        if !matches!(url.path(), "" | "/") {
            return Err(anyhow!(
                "target URL must be rooted at the host; provide scan paths separately"
            ));
        }

        let host = url
            .host_str()
            .ok_or_else(|| anyhow!("target URL must include a host"))?
            .to_ascii_lowercase();

        if !self.inventory.host_is_allowed(&host) {
            return Err(anyhow!(
                "host {host} is outside inventory.allowed_host_suffixes, inventory.allowed_hosts, and inventory.allowed_cidrs"
            ));
        }

        let port = url.port_or_known_default();
        if !self.inventory.port_is_allowed(port) {
            return Err(anyhow!(
                "target URL port {} is outside inventory.allowed_ports",
                port.unwrap_or_default()
            ));
        }

        url.set_path("/");
        url.set_query(None);
        url.set_fragment(None);

        let paths = if target.paths.is_empty() {
            self.resolved_default_paths()?
        } else {
            sanitize_paths(&target.paths)
        };

        if paths.is_empty() {
            return Err(anyhow!("target requires at least one scan path"));
        }

        let request_profile = normalize_request_profile_name(target.request_profile);
        if let Some(profile_name) = request_profile.as_deref() {
            if !self.scan.allow_authenticated_request_profiles {
                return Err(anyhow!(
                    "target request_profile {profile_name} is disabled by scan.allow_authenticated_request_profiles"
                ));
            }
            if self.inventory.request_profile(profile_name).is_none() {
                return Err(anyhow!(
                    "target request_profile {profile_name} is not defined in inventory.request_profiles"
                ));
            }
        }

        let mut gobuster = normalize_target_gobuster_config(target.gobuster)?;
        if gobuster.enabled && gobuster.wordlist.is_empty() {
            gobuster.wordlist = self.scan.gobuster.wordlist.clone();
        }

        let mut tags = Vec::new();
        for tag in target.tags {
            let trimmed = tag.trim().to_ascii_lowercase();
            if !trimmed.is_empty() && !tags.contains(&trimmed) {
                tags.push(trimmed);
            }
        }

        Ok(TargetDefinition {
            label,
            base_url: url.to_string().trim_end_matches('/').to_string(),
            strategy,
            paths,
            tags,
            request_profile,
            gobuster,
        })
    }

    pub fn normalized_bootstrap_targets(&self) -> Result<Vec<TargetDefinition>> {
        self.inventory
            .bootstrap_targets
            .clone()
            .into_iter()
            .map(|target| self.normalize_target_definition(target))
            .collect()
    }

    pub fn normalize_repository_definition(
        &self,
        repository: RepositoryDefinition,
    ) -> Result<RepositoryDefinition> {
        let name = repository.name.trim().to_string();
        if name.is_empty() {
            return Err(anyhow!("repository name is required"));
        }

        let mut github_url = Url::parse(repository.github_url.trim())
            .with_context(|| format!("invalid repository URL {}", repository.github_url))?;
        let scheme = github_url.scheme();
        if scheme != "http" && scheme != "https" {
            return Err(anyhow!("repository URL must use http or https"));
        }
        if github_url.host_str().is_none() {
            return Err(anyhow!("repository URL must include a host"));
        }
        if github_url.query().is_some() || github_url.fragment().is_some() {
            return Err(anyhow!(
                "repository URL must not include query strings or fragments"
            ));
        }

        let normalized_path = github_url.path().trim_end_matches('/').to_string();
        let path_segments = normalized_path
            .trim_start_matches('/')
            .split('/')
            .filter(|segment| !segment.trim().is_empty())
            .collect::<Vec<_>>();
        if path_segments.len() < 2 {
            return Err(anyhow!(
                "repository URL must include an owner and repository path"
            ));
        }
        github_url.set_path(&normalized_path);
        github_url.set_query(None);
        github_url.set_fragment(None);

        let mut local_path = repository.local_path.trim().to_string();
        if local_path.is_empty() {
            return Err(anyhow!("repository local_path is required"));
        }
        if local_path.len() > 1 {
            local_path = local_path.trim_end_matches('/').to_string();
        }

        Ok(RepositoryDefinition {
            name,
            github_url: github_url.to_string(),
            local_path,
            description: trim_optional_string(repository.description),
            status: normalize_repository_status(Some(repository.status)),
            related_target_ids: normalize_repository_related_target_ids(
                &repository.related_target_ids,
            ),
        })
    }

    pub fn normalized_bootstrap_repositories(&self) -> Result<Vec<RepositoryDefinition>> {
        self.inventory
            .bootstrap_repositories
            .clone()
            .into_iter()
            .map(|repository| self.normalize_repository_definition(repository))
            .collect()
    }

    pub fn normalize_port_scan_request(&self, request: PortScanRequest) -> Result<PortScanRequest> {
        let target_range = PortScanTargetRange::parse(&request.target_range)?;
        if !port_scan_range_is_allowed(&self.inventory, &target_range) {
            return Err(anyhow!(
                "port scan target_range {} is outside inventory allowlists",
                target_range.canonical_string()
            ));
        }

        let normalized_ports = request
            .ports
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>();
        let ports = parse_port_scan_ports(&normalized_ports)?;
        if let Some(port) = ports
            .iter()
            .copied()
            .find(|port| !self.inventory.port_is_allowed(Some(*port)))
        {
            return Err(anyhow!(
                "port scan port {port} is outside inventory.allowed_ports"
            ));
        }

        let tags = normalize_worker_tags(&request.tags);
        let worker_pool = request
            .worker_pool
            .as_deref()
            .and_then(normalize_worker_pool_name);

        let bootstrap_policy = if request.bootstrap_policy.enabled {
            crate::core::WorkerBootstrapPolicy {
                enabled: true,
                worker_pool: request
                    .bootstrap_policy
                    .worker_pool
                    .as_deref()
                    .and_then(normalize_worker_pool_name)
                    .or_else(|| worker_pool.clone()),
                tags: normalize_worker_tags(&request.bootstrap_policy.tags),
            }
        } else {
            Default::default()
        };

        Ok(PortScanRequest {
            target_range: target_range.canonical_string(),
            ports: normalized_ports,
            schemes: request.schemes,
            tags,
            rate_limit: request.rate_limit.max(DEFAULT_PORT_SCAN_RATE_LIMIT),
            worker_pool,
            bootstrap_policy,
        })
    }

    pub fn operator_records(&self) -> Vec<OperatorRecord> {
        self.auth
            .operators
            .iter()
            .map(|operator| OperatorRecord {
                username: operator.username.clone(),
                role: operator.role,
                enabled: operator.enabled,
            })
            .collect()
    }

    pub fn operator(&self, username: &str) -> Option<OperatorRecord> {
        let username = username.trim().to_ascii_lowercase();
        self.auth
            .operators
            .iter()
            .find(|operator| operator.username == username)
            .map(|operator| OperatorRecord {
                username: operator.username.clone(),
                role: operator.role,
                enabled: operator.enabled,
            })
    }

    pub fn authenticate_operator(&self, username: &str, password: &str) -> Option<OperatorRecord> {
        let username = username.trim().to_ascii_lowercase();
        self.auth
            .operators
            .iter()
            .find(|operator| {
                operator.enabled && operator.username == username && operator.password == password
            })
            .map(|operator| OperatorRecord {
                username: operator.username.clone(),
                role: operator.role,
                enabled: operator.enabled,
            })
    }

    pub fn load_extension_manifests(&self) -> Result<Vec<ExtensionManifest>> {
        load_extension_manifests_from_paths(
            &self.scan.extension_manifest_paths,
            &self.scan.extension_manifest_dirs,
        )
    }

    pub fn enabled_extension_manifests(&self) -> Result<Vec<ExtensionManifest>> {
        Ok(self
            .load_extension_manifests()?
            .into_iter()
            .filter(|manifest| manifest.enabled)
            .collect())
    }

    pub fn host_is_allowed(&self, host: &str) -> bool {
        self.inventory.host_is_allowed(host)
    }

    fn apply_env_overrides(&mut self) {
        if let Ok(value) = env::var("ANYGPT_API_ENV_FILE") {
            self.storage.anygpt_api_env_path = Some(value);
        }
        if let Ok(value) = env::var("ANYSCAN_ANYGPT_API_ENV_FILE") {
            self.storage.anygpt_api_env_path = Some(value);
        }
        if let Ok(value) = env::var("REDIS_URL") {
            self.storage.redis_url = Some(value);
        }
        if let Ok(value) = env::var("REDIS_USERNAME") {
            self.storage.redis_username = Some(value);
        }
        if let Ok(value) = env::var("REDIS_PASSWORD") {
            self.storage.redis_password = Some(value);
        }
        if let Ok(value) = env::var("REDIS_DB") {
            if let Ok(parsed) = value.parse() {
                self.storage.redis_db = parsed;
            }
        }
        if let Ok(value) = env::var("REDIS_TLS") {
            self.storage.redis_tls = matches!(value.as_str(), "1" | "true" | "TRUE" | "yes");
        }
        if let Ok(value) = env::var("REDIS_STARTUP_WAIT") {
            self.storage.redis_startup_wait =
                !matches!(value.as_str(), "0" | "false" | "FALSE" | "no");
        }
        if let Ok(value) = env::var("SKIP_REDIS_STARTUP_WAIT") {
            if matches!(value.as_str(), "1" | "true" | "TRUE" | "yes") {
                self.storage.redis_startup_wait = false;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_REDIS_STARTUP_TIMEOUT_SECONDS") {
            if let Ok(parsed) = value.parse() {
                self.storage.redis_startup_timeout_seconds = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_REDIS_KEY_PREFIX") {
            self.storage.redis_key_prefix = value;
        }
        if let Ok(value) = env::var("ANYSCAN_REDIS_LOCK_TTL_MS") {
            if let Ok(parsed) = value.parse() {
                self.storage.redis_lock_ttl_ms = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_REDIS_LOCK_RETRY_DELAY_MS") {
            if let Ok(parsed) = value.parse() {
                self.storage.redis_lock_retry_delay_ms = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_REDIS_LOCK_MAX_WAIT_MS") {
            if let Ok(parsed) = value.parse() {
                self.storage.redis_lock_max_wait_ms = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_REDIS_RUN_LEASE_SECONDS") {
            if let Ok(parsed) = value.parse() {
                self.storage.redis_run_lease_seconds = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_BIND_ADDR") {
            self.server.bind_addr = value;
        }
        if let Ok(value) = env::var("ANYSCAN_PRIVATE_CONTROL_PLANE_ONLY") {
            self.server.private_control_plane_only =
                matches!(value.as_str(), "1" | "true" | "TRUE" | "yes");
        }
        if let Ok(value) = env::var("ANYSCAN_ADMIN_USERNAME") {
            self.auth.admin_username = value;
        }
        if let Ok(value) = env::var("ANYSCAN_ADMIN_PASSWORD") {
            self.auth.admin_password = value;
        }
        if let Ok(value) = env::var("ANYSCAN_JWT_SECRET") {
            self.auth.jwt_secret = value;
        }
        if let Ok(value) = env::var("ANYSCAN_SESSION_TTL_SECONDS") {
            if let Ok(parsed) = value.parse() {
                self.auth.session_ttl_seconds = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_ALLOWED_HOST_SUFFIXES") {
            self.inventory.allowed_host_suffixes = value
                .split(',')
                .map(|item| item.trim().to_string())
                .collect();
        }
        if let Ok(value) = env::var("ANYSCAN_ALLOWED_HOSTS") {
            self.inventory.allowed_hosts = value
                .split(',')
                .map(|item| item.trim().to_string())
                .collect();
        }
        if let Ok(value) = env::var("ANYSCAN_ALLOWED_CIDRS") {
            self.inventory.allowed_cidrs = value
                .split(',')
                .map(|item| item.trim().to_string())
                .collect();
        }
        if let Ok(value) = env::var("ANYSCAN_ALLOWED_PORTS") {
            self.inventory.allowed_ports = value
                .split(',')
                .filter_map(|item| item.trim().parse::<u16>().ok())
                .collect();
        }
        if let Ok(value) = env::var("ANYSCAN_DEFAULT_PATHS") {
            self.inventory.default_paths = value
                .split(',')
                .map(|item| item.trim().to_string())
                .collect();
        }
        if let Ok(value) = env::var("ANYSCAN_PATH_PROFILES") {
            self.inventory.path_profiles = value
                .split(',')
                .map(|item| item.trim().to_string())
                .collect();
        }
        if let Ok(value) = env::var("ANYSCAN_SCAN_CONCURRENCY") {
            if let Ok(parsed) = value.parse() {
                self.scan.concurrency = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_MAX_PATHS_PER_TARGET") {
            if let Ok(parsed) = value.parse() {
                self.scan.max_paths_per_target = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_MAX_PARALLEL_PATHS_PER_TARGET") {
            if let Ok(parsed) = value.parse() {
                self.scan.max_parallel_paths_per_target = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_MAX_CONCURRENT_REQUESTS_PER_HOST") {
            if let Ok(parsed) = value.parse() {
                self.scan.max_concurrent_requests_per_host = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_ENABLE_PATH_DISCOVERY") {
            self.scan.enable_path_discovery =
                matches!(value.as_str(), "1" | "true" | "TRUE" | "yes");
        }
        if let Ok(value) = env::var("ANYSCAN_MAX_DISCOVERED_PATHS_PER_TARGET") {
            if let Ok(parsed) = value.parse() {
                self.scan.max_discovered_paths_per_target = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_HOST_BACKOFF_INITIAL_MS") {
            if let Ok(parsed) = value.parse() {
                self.scan.host_backoff_initial_ms = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_HOST_BACKOFF_MAX_MS") {
            if let Ok(parsed) = value.parse() {
                self.scan.host_backoff_max_ms = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_SCAN_INTERVAL_SECONDS") {
            if let Ok(parsed) = value.parse() {
                self.scan.poll_interval_seconds = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_ALLOW_INVALID_TLS") {
            self.scan.allow_invalid_tls = matches!(value.as_str(), "1" | "true" | "TRUE" | "yes");
        }
        if let Ok(value) = env::var("ANYSCAN_PROXY_MODE") {
            if let Ok(parsed) = value.parse() {
                self.scan.proxy_mode = parsed;
            }
        }
        if let Ok(value) = env::var("ANYSCAN_PROXY_URL") {
            self.scan.proxy_url = Some(value);
        }
        if let Ok(value) = env::var("ANYSCAN_EXTENSION_MANIFEST_PATHS") {
            self.scan.extension_manifest_paths = value
                .split(',')
                .map(|item| item.trim().to_string())
                .collect();
        }
        if let Ok(value) = env::var("ANYSCAN_EXTENSION_MANIFEST_DIRS") {
            self.scan.extension_manifest_dirs = value
                .split(',')
                .map(|item| item.trim().to_string())
                .collect();
        }
    }
}

fn resolved_dragonfly_db(storage: &StorageConfig) -> Result<i64> {
    let redis_url = storage
        .redis_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(redis_url) = redis_url else {
        return Ok(storage.redis_db);
    };

    resolved_redis_db_from_url(redis_url, storage.redis_db, "REDIS_URL")
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use crate::core::{
        GobusterTargetConfig, PortScanRequest, RepositoryDefinition, ScanDefaultsSummary,
        TargetDefinition, TargetStrategy,
    };

    use super::{
        AppConfig, DEFAULT_ANYSCAN_REDIS_DB, DEFAULT_ANYSCAN_REDIS_KEY_PREFIX,
        DEFAULT_PORT_SCAN_RATE_LIMIT, RequestProfileConfig, RequestProfileSecretRef,
        parse_port_scan_ports,
    };

    fn write_temp_anygpt_api_env(contents: &str) -> PathBuf {
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("anyscan-anygpt-api-env-{unique_suffix}"));
        fs::create_dir_all(&dir).expect("temporary test directory should be created");
        let path = dir.join(".env");
        fs::write(&path, contents).expect("temporary AnyGPT API env file should be written");
        path
    }

    fn cleanup_temp_anygpt_api_env(path: &PathBuf) {
        let _ = fs::remove_file(path);
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir(parent);
        }
    }

    #[test]
    fn exact_allowed_hosts_accept_ip_literals_and_ipv6_endpoints() {
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes.clear();
        config.inventory.allowed_hosts = vec!["10.0.0.5".to_string(), "[2001:db8::10]".to_string()];

        config
            .validate()
            .expect("exact host allowlist should validate for IP literals and IPv6 hosts");

        assert!(config.host_is_allowed("10.0.0.5"));
        assert!(config.host_is_allowed("[2001:db8::10]"));
        assert!(config.host_is_allowed("2001:db8::10"));
        assert!(!config.host_is_allowed("10.0.0.6"));
    }

    #[test]
    fn cidr_allowlists_accept_ipv4_targets_within_range() {
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes.clear();
        config.inventory.allowed_hosts.clear();
        config.inventory.allowed_cidrs = vec!["10.42.0.0/24".to_string()];

        config
            .validate()
            .expect("IPv4 CIDR allowlist should validate");

        assert!(config.host_is_allowed("10.42.0.17"));
        assert!(!config.host_is_allowed("10.42.1.17"));

        let normalized = config
            .normalize_target_definition(TargetDefinition {
                label: "CIDR target".to_string(),
                base_url: "http://10.42.0.17:8080".to_string(),
                paths: Vec::new(),
                tags: vec!["internal".to_string()],
                request_profile: None,
                strategy: TargetStrategy::Hybrid,
                gobuster: Default::default(),
            })
            .expect("target inside allowed IPv4 CIDR should normalize");
        assert_eq!(normalized.base_url, "http://10.42.0.17:8080");
    }

    #[test]
    fn cidr_allowlists_accept_ipv6_targets_within_range() {
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes.clear();
        config.inventory.allowed_hosts.clear();
        config.inventory.allowed_cidrs = vec!["2001:db8::/120".to_string()];
        config.inventory.allowed_ports = vec![8443];

        config
            .validate()
            .expect("IPv6 CIDR allowlist should validate");

        assert!(config.host_is_allowed("2001:db8::42"));
        assert!(!config.host_is_allowed("2001:db8:1::42"));

        let normalized = config
            .normalize_target_definition(TargetDefinition {
                label: "IPv6 CIDR target".to_string(),
                base_url: "https://[2001:db8::42]:8443".to_string(),
                paths: Vec::new(),
                tags: vec!["internal".to_string()],
                request_profile: None,
                strategy: TargetStrategy::Hybrid,
                gobuster: Default::default(),
            })
            .expect("target inside allowed IPv6 CIDR should normalize");
        assert_eq!(normalized.base_url, "https://[2001:db8::42]:8443");
    }

    #[test]
    fn target_normalization_enforces_allowed_ports_for_ip_targets() {
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes.clear();
        config.inventory.allowed_hosts = vec!["127.0.0.1".to_string()];
        config.inventory.allowed_ports = vec![8080, 8443];
        config
            .validate()
            .expect("target config with explicit ports should validate");

        let normalized = config
            .normalize_target_definition(TargetDefinition {
                label: "Internal service".to_string(),
                base_url: "http://127.0.0.1:8080".to_string(),
                paths: Vec::new(),
                tags: vec!["internal".to_string()],
                request_profile: None,
                strategy: TargetStrategy::Hybrid,
                gobuster: Default::default(),
            })
            .expect("allowed IP target should normalize");
        assert_eq!(normalized.base_url, "http://127.0.0.1:8080");

        let error = config
            .normalize_target_definition(TargetDefinition {
                label: "Wrong port".to_string(),
                base_url: "http://127.0.0.1:9090".to_string(),
                paths: Vec::new(),
                tags: vec!["internal".to_string()],
                request_profile: None,
                strategy: TargetStrategy::Hybrid,
                gobuster: Default::default(),
            })
            .expect_err("disallowed port should fail normalization");
        assert!(
            error
                .to_string()
                .contains("target URL port 9090 is outside inventory.allowed_ports")
        );
    }

    #[test]
    fn target_normalization_supports_ipv6_hosts_with_explicit_ports() {
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes.clear();
        config.inventory.allowed_hosts = vec!["2001:db8::10".to_string()];
        config.inventory.allowed_ports = vec![8443];
        config
            .validate()
            .expect("IPv6 inventory allowlist should validate");

        let normalized = config
            .normalize_target_definition(TargetDefinition {
                label: "IPv6 service".to_string(),
                base_url: "https://[2001:db8::10]:8443".to_string(),
                paths: Vec::new(),
                tags: vec!["internal".to_string()],
                request_profile: None,
                strategy: TargetStrategy::Hybrid,
                gobuster: Default::default(),
            })
            .expect("allowed IPv6 target should normalize");
        assert_eq!(normalized.base_url, "https://[2001:db8::10]:8443");
    }

    #[test]
    fn host_suffix_allows_owned_subdomains() {
        let config = AppConfig::default();
        assert!(config.host_is_allowed("localhost"));
        assert!(config.host_is_allowed("api.localhost"));
        assert!(!config.host_is_allowed("example.com"));
    }

    #[test]
    fn default_path_profiles_expand_baseline_catalog() {
        let config = AppConfig::default();
        let paths = config
            .resolved_default_paths()
            .expect("baseline path profiles should resolve");

        assert!(paths.contains(&"/.env".to_string()));
        assert!(paths.contains(&"/.env.local".to_string()));
        assert!(paths.contains(&"/swagger.json".to_string()));
        assert!(paths.contains(&"/".to_string()));
        assert!(paths.contains(&"/asset-manifest.json".to_string()));
        assert!(paths.contains(&"/.well-known/security.txt".to_string()));
        assert!(paths.contains(&"/sitemap.xml".to_string()));
        assert!(paths.contains(&"/service-worker.js".to_string()));
        assert!(paths.contains(&"/docs".to_string()));
    }

    #[test]
    fn opt_in_path_profiles_expand_extended_catalogs() {
        let mut config = AppConfig::default();
        config.inventory.path_profiles = vec![
            "graphql-and-schema".to_string(),
            "extended-framework-artifacts".to_string(),
            "extended-config-variants".to_string(),
            "observability-and-debug".to_string(),
        ];
        config.inventory.default_paths.clear();
        config
            .validate()
            .expect("extended opt-in profiles should validate");

        let paths = config
            .resolved_default_paths()
            .expect("extended path profiles should resolve");
        assert!(paths.contains(&"/graphql".to_string()));
        assert!(paths.contains(&"/static/js/runtime-main.js".to_string()));
        assert!(paths.contains(&"/config.production.json".to_string()));
        assert!(paths.contains(&"/actuator/env".to_string()));
    }

    #[test]
    fn unknown_path_profile_is_rejected() {
        let mut config = AppConfig::default();
        config.inventory.path_profiles = vec!["baseline".to_string(), "mystery".to_string()];

        let error = config
            .validate()
            .expect_err("unknown profile should fail validation");
        assert!(
            error
                .to_string()
                .contains("unknown inventory.path_profiles entry mystery")
        );
    }

    #[test]
    fn dragonfly_storage_rejects_reserved_anygpt_db_one() {
        let mut config = AppConfig::default();
        config.storage.redis_url = Some("127.0.0.1:6380".to_string());
        config.storage.redis_db = 1;

        let error = config
            .validate()
            .expect_err("Dragonfly DB 1 should be rejected for anyscan");
        assert!(error.to_string().contains(
            "Dragonfly DB 1 is reserved by AnyGPT API experimental/control-plane workflows"
        ));
    }

    #[test]
    fn dragonfly_storage_rejects_full_url_pointing_at_reserved_db_one() {
        let mut config = AppConfig::default();
        config.storage.redis_url = Some("redis://127.0.0.1:6380/1".to_string());
        config.storage.redis_db = 2;

        let error = config
            .validate()
            .expect_err("REDIS_URL /1 should be rejected even when REDIS_DB differs");
        assert!(error.to_string().contains(
            "Dragonfly DB 1 is reserved by AnyGPT API experimental/control-plane workflows"
        ));
    }

    #[test]
    fn dragonfly_storage_accepts_default_shared_db_zero() {
        let mut config = AppConfig::default();
        config.storage.redis_url = Some("redis://127.0.0.1:6380/0".to_string());
        config.storage.redis_db = 1;

        config
            .validate()
            .expect("Dragonfly DB 0 should remain valid for anyscan");
    }

    #[test]
    fn anygpt_api_env_credentials_are_inherited_into_dedicated_exposure_store() {
        let env_path = write_temp_anygpt_api_env(
            "REDIS_URL=redis://dragonfly.internal:6380/0\nREDIS_USERNAME=default\nREDIS_PASSWORD=secret\nREDIS_DB=0\n",
        );
        let env_path_string = env_path.to_string_lossy().into_owned();
        let mut config = AppConfig::default();
        config.storage.redis_url = None;
        config.storage.anygpt_api_env_path = Some(env_path_string.clone());

        config
            .apply_anygpt_api_redis_credentials(None)
            .expect("AnyGPT API Redis credentials should be inherited successfully");

        assert_eq!(
            config.storage.redis_url.as_deref(),
            Some("redis://dragonfly.internal:6380/")
        );
        assert_eq!(config.storage.redis_username.as_deref(), Some("default"));
        assert_eq!(config.storage.redis_password.as_deref(), Some("secret"));
        assert_eq!(config.storage.redis_db, DEFAULT_ANYSCAN_REDIS_DB);
        assert_eq!(
            config.storage.redis_key_prefix,
            DEFAULT_ANYSCAN_REDIS_KEY_PREFIX.to_string()
        );
        assert_eq!(
            config.storage.anygpt_api_env_path.as_deref(),
            Some(env_path_string.as_str())
        );
        assert_eq!(
            super::resolved_dragonfly_db(&config.storage)
                .expect("resolved anyscan Dragonfly DB should be parsed"),
            DEFAULT_ANYSCAN_REDIS_DB
        );

        cleanup_temp_anygpt_api_env(&env_path);
    }

    #[test]
    fn inherited_anygpt_api_credentials_share_db_zero_with_prefix_isolation() {
        let env_path = write_temp_anygpt_api_env(
            "REDIS_URL=redis://dragonfly.internal:6380/0\nREDIS_USERNAME=default\nREDIS_PASSWORD=secret\nREDIS_DB=0\n",
        );
        let env_path_string = env_path.to_string_lossy().into_owned();
        let mut config = AppConfig::default();
        config.storage.redis_url = None;
        config.storage.redis_db = 0;
        config.storage.anygpt_api_env_path = Some(env_path_string);

        config.apply_anygpt_api_redis_credentials(None).expect(
            "sharing the AnyGPT API Dragonfly DB should work when namespace isolation is used",
        );
        assert_eq!(
            super::resolved_dragonfly_db(&config.storage)
                .expect("resolved anyscan Dragonfly DB should be parsed"),
            0
        );
        assert_eq!(
            config.storage.redis_key_prefix,
            DEFAULT_ANYSCAN_REDIS_KEY_PREFIX
        );

        cleanup_temp_anygpt_api_env(&env_path);
    }

    #[test]
    fn inherited_anygpt_api_credentials_preserve_explicit_isolated_key_prefix() {
        let env_path = write_temp_anygpt_api_env(
            "REDIS_URL=redis://dragonfly.internal:6380/0\nREDIS_USERNAME=default\nREDIS_PASSWORD=secret\nREDIS_DB=0\n",
        );
        let env_path_string = env_path.to_string_lossy().into_owned();
        let mut config = AppConfig::default();
        config.storage.redis_url = None;
        config.storage.redis_db = 0;
        config.storage.redis_key_prefix = "anyscan:test:isolated:".to_string();
        config.storage.anygpt_api_env_path = Some(env_path_string);

        config
            .apply_anygpt_api_redis_credentials(None)
            .expect("explicit isolated namespace should survive AnyGPT API env inheritance");
        assert_eq!(
            super::resolved_dragonfly_db(&config.storage)
                .expect("resolved anyscan Dragonfly DB should be parsed"),
            0
        );
        assert_eq!(
            config.storage.redis_key_prefix,
            "anyscan:test:isolated:".to_string()
        );

        cleanup_temp_anygpt_api_env(&env_path);
    }

    #[test]
    fn discovery_budget_cannot_exceed_total_path_budget() {
        let mut config = AppConfig::default();
        config.scan.max_paths_per_target = 4;
        config.scan.max_discovered_paths_per_target = 5;

        let error = config
            .validate()
            .expect_err("discovery budget above total budget should fail validation");
        assert!(error.to_string().contains(
            "scan.max_discovered_paths_per_target must be less than or equal to scan.max_paths_per_target"
        ));
    }

    #[test]
    fn parallel_path_budget_must_be_positive() {
        let mut config = AppConfig::default();
        config.scan.max_parallel_paths_per_target = 0;

        let error = config
            .validate()
            .expect_err("parallel path budget must be positive");
        assert!(
            error
                .to_string()
                .contains("scan.max_parallel_paths_per_target must be greater than zero")
        );
    }

    #[test]
    fn per_host_request_budget_must_be_positive() {
        let mut config = AppConfig::default();
        config.scan.max_concurrent_requests_per_host = 0;

        let error = config
            .validate()
            .expect_err("per-host request budget must be positive");
        assert!(
            error
                .to_string()
                .contains("scan.max_concurrent_requests_per_host must be greater than zero")
        );
    }

    #[test]
    fn host_backoff_window_must_be_valid() {
        let mut config = AppConfig::default();
        config.scan.host_backoff_initial_ms = 500;
        config.scan.host_backoff_max_ms = 250;

        let error = config
            .validate()
            .expect_err("host backoff max must be at least the initial delay");
        assert!(error.to_string().contains(
            "scan.host_backoff_max_ms must be greater than or equal to scan.host_backoff_initial_ms"
        ));
    }

    #[test]
    fn target_normalization_uses_default_paths() {
        let config = AppConfig::default();
        let expected_paths = config
            .resolved_default_paths()
            .expect("default paths should resolve");
        let normalized = config
            .normalize_target_definition(TargetDefinition {
                label: "Local API".to_string(),
                base_url: "http://localhost:3000".to_string(),
                paths: Vec::new(),
                tags: vec!["Prod".to_string(), "prod".to_string()],
                request_profile: None,
                strategy: TargetStrategy::Hybrid,
                gobuster: Default::default(),
            })
            .expect("target should normalize");

        assert_eq!(normalized.base_url, "http://localhost:3000");
        assert_eq!(normalized.paths, expected_paths);
        assert_eq!(normalized.tags, vec!["prod"]);
        assert_eq!(normalized.strategy, TargetStrategy::Hybrid);
    }

    #[test]
    fn repository_normalization_trims_and_sanitizes_fields() {
        let config = AppConfig::default();
        let normalized = config
            .normalize_repository_definition(RepositoryDefinition {
                name: "  VulnScanner-zmap-alternative  ".to_string(),
                github_url: "https://github.com/Lorikazzzz/VulnScanner-zmap-alternative.git/"
                    .to_string(),
                local_path: " /tmp/vulnscanner/ ".to_string(),
                description: Some("  Standalone scanner mirror  ".to_string()),
                status: " Ready To Track ".to_string(),
                related_target_ids: vec![4, 0, 2, 4],
            })
            .expect("repository should normalize");

        assert_eq!(normalized.name, "VulnScanner-zmap-alternative");
        assert_eq!(
            normalized.github_url,
            "https://github.com/Lorikazzzz/VulnScanner-zmap-alternative.git"
        );
        assert_eq!(normalized.local_path, "/tmp/vulnscanner");
        assert_eq!(
            normalized.description.as_deref(),
            Some("Standalone scanner mirror")
        );
        assert_eq!(normalized.status, "ready-to-track");
        assert_eq!(normalized.related_target_ids, vec![2, 4]);
    }

    #[test]
    fn default_bootstrap_repository_is_available() {
        let mut config = AppConfig::default();
        config
            .validate()
            .expect("default bootstrap repository should validate");

        let repositories = config
            .normalized_bootstrap_repositories()
            .expect("default bootstrap repositories should normalize");
        assert_eq!(repositories.len(), 1);
        assert_eq!(repositories[0].name, "VulnScanner-zmap-alternative");
        assert_eq!(
            repositories[0].github_url,
            "https://github.com/Lorikazzzz/VulnScanner-zmap-alternative.git"
        );
        assert_eq!(
            repositories[0].local_path,
            "/root/AnyGPT/VulnScanner-zmap-alternative-"
        );
        assert_eq!(repositories[0].status, "tracked");
    }

    #[test]
    fn parse_port_scan_ports_supports_ranges_and_deduplicates() {
        let ports =
            parse_port_scan_ports("80, 443, 8000-8002, 443").expect("port scan ports should parse");

        assert_eq!(ports, vec![80, 443, 8000, 8001, 8002]);
    }

    #[test]
    fn normalize_port_scan_request_applies_allowlists_and_defaults() {
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes.clear();
        config.inventory.allowed_cidrs = vec!["10.0.0.0/24".to_string()];
        config.inventory.allowed_ports = vec![80, 443];
        config.validate().expect("config should validate");

        let normalized = config
            .normalize_port_scan_request(PortScanRequest {
                target_range: " 10.0.0.5-10.0.0.9 ".to_string(),
                ports: " 80, 443 ".to_string(),
                schemes: crate::core::PortScanSchemePolicy::Both,
                tags: vec!["Edge".to_string(), "edge".to_string(), "Prod".to_string()],
                rate_limit: 0,
                worker_pool: Some(" Core-Scanners ".to_string()),
                bootstrap_policy: crate::core::WorkerBootstrapPolicy {
                    enabled: true,
                    worker_pool: None,
                    tags: vec!["Edge".to_string(), "bootstrap".to_string()],
                },
            })
            .expect("port scan request should normalize");

        assert_eq!(normalized.target_range, "10.0.0.5-10.0.0.9");
        assert_eq!(normalized.ports, "80,443");
        assert_eq!(normalized.tags, vec!["edge", "prod"]);
        assert_eq!(normalized.rate_limit, DEFAULT_PORT_SCAN_RATE_LIMIT);
        assert_eq!(normalized.worker_pool.as_deref(), Some("core-scanners"));
        assert!(normalized.bootstrap_policy.enabled);
        assert_eq!(
            normalized.bootstrap_policy.worker_pool.as_deref(),
            Some("core-scanners")
        );
        assert_eq!(normalized.bootstrap_policy.tags, vec!["edge", "bootstrap"]);
    }

    #[test]
    fn normalize_port_scan_request_rejects_disallowed_ranges() {
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes.clear();
        config.inventory.allowed_cidrs = vec!["10.0.0.0/24".to_string()];
        config.validate().expect("config should validate");

        let error = config
            .normalize_port_scan_request(PortScanRequest {
                target_range: "10.0.1.0/24".to_string(),
                ports: "80".to_string(),
                schemes: crate::core::PortScanSchemePolicy::Auto,
                tags: Vec::new(),
                rate_limit: 10,
                worker_pool: None,
                bootstrap_policy: Default::default(),
            })
            .expect_err("disallowed range should be rejected");

        assert!(
            error
                .to_string()
                .contains("port scan target_range 10.0.1.0/24 is outside inventory allowlists")
        );
    }

    #[test]
    fn request_profile_names_must_be_unique() {
        let mut config = AppConfig::default();
        config.inventory.request_profiles = vec![
            RequestProfileConfig {
                name: "admin".to_string(),
                headers: vec![RequestProfileSecretRef {
                    name: "X-Admin-Token".to_string(),
                    env: "ADMIN_TOKEN".to_string(),
                }],
                cookies: Vec::new(),
                bearer_token_env: None,
            },
            RequestProfileConfig {
                name: "ADMIN".to_string(),
                headers: vec![RequestProfileSecretRef {
                    name: "X-Other".to_string(),
                    env: "OTHER_TOKEN".to_string(),
                }],
                cookies: Vec::new(),
                bearer_token_env: None,
            },
        ];

        let error = config
            .validate()
            .expect_err("duplicate request profile names should fail validation");
        assert!(
            error
                .to_string()
                .contains("duplicate inventory.request_profiles entry admin")
        );
    }

    #[test]
    fn target_request_profile_must_exist() {
        let mut config = AppConfig::default();
        config.scan.allow_authenticated_request_profiles = true;
        let error = config
            .normalize_target_definition(TargetDefinition {
                label: "Private API".to_string(),
                base_url: "http://localhost:4000".to_string(),
                paths: Vec::new(),
                tags: vec!["private".to_string()],
                request_profile: Some("missing".to_string()),
                strategy: TargetStrategy::Hybrid,
                gobuster: Default::default(),
            })
            .expect_err("missing request profile should fail validation");
        assert!(
            error
                .to_string()
                .contains("target request_profile missing is not defined")
        );
    }

    #[test]
    fn target_request_profile_is_normalized_when_defined() {
        let mut config = AppConfig::default();
        config.inventory.request_profiles = vec![RequestProfileConfig {
            name: "private-api".to_string(),
            headers: vec![RequestProfileSecretRef {
                name: "X-Api-Key".to_string(),
                env: "PRIVATE_API_KEY".to_string(),
            }],
            cookies: Vec::new(),
            bearer_token_env: None,
        }];
        config.scan.allow_authenticated_request_profiles = true;
        config.validate().expect("request profiles should validate");

        let normalized = config
            .normalize_target_definition(TargetDefinition {
                label: "Private API".to_string(),
                base_url: "http://localhost:4000".to_string(),
                paths: Vec::new(),
                tags: vec!["Private".to_string()],
                request_profile: Some(" Private-API ".to_string()),
                strategy: TargetStrategy::Hybrid,
                gobuster: Default::default(),
            })
            .expect("target should accept a configured request profile");
        assert_eq!(normalized.request_profile.as_deref(), Some("private-api"));
    }

    #[test]
    fn target_gobuster_uses_runtime_default_wordlist_when_enabled_without_override() {
        let config = AppConfig::default();
        let normalized = config
            .normalize_target_definition(TargetDefinition {
                label: "Directory probe".to_string(),
                base_url: "http://localhost:4000".to_string(),
                paths: Vec::new(),
                tags: vec!["private".to_string()],
                request_profile: None,
                strategy: TargetStrategy::Hybrid,
                gobuster: GobusterTargetConfig {
                    enabled: true,
                    wordlist: Vec::new(),
                    extensions: vec!["json".to_string()],
                    add_slash: true,
                    discover_backup: false,
                },
            })
            .expect("target gobuster settings should normalize");

        assert!(normalized.gobuster.enabled);
        assert!(!normalized.gobuster.wordlist.is_empty());
        assert_eq!(normalized.gobuster.extensions, vec!["json"]);
        assert!(normalized.gobuster.add_slash);
    }

    #[test]
    fn scan_defaults_summary_round_trips_into_effective_config() {
        let config = AppConfig::default();
        let updated = config
            .with_scan_defaults_summary(&ScanDefaultsSummary {
                concurrency: 2,
                request_timeout_secs: 5,
                max_response_bytes: 65_536,
                max_paths_per_target: 12,
                max_parallel_paths_per_target: 2,
                max_concurrent_requests_per_host: 1,
                enable_path_discovery: false,
                max_discovered_paths_per_target: 4,
                host_backoff_initial_ms: 150,
                host_backoff_max_ms: 600,
                poll_interval_seconds: 30,
                allow_invalid_tls: false,
                directory_probing_enabled: true,
                directory_probing_wordlist_count: 2,
                directory_probing_wordlist: vec!["admin".to_string(), "debug".to_string()],
                directory_probing_extensions: vec!["json".to_string()],
                directory_probing_add_slash: true,
                directory_probing_discover_backup: true,
            })
            .expect("scan settings should produce a valid config");

        assert_eq!(updated.scan.concurrency, 2);
        assert_eq!(updated.scan.max_parallel_paths_per_target, 2);
        assert!(!updated.scan.enable_path_discovery);
        assert!(updated.scan.gobuster.enabled);
        assert_eq!(updated.scan.gobuster.wordlist, vec!["admin", "debug"]);
        assert_eq!(updated.scan.gobuster.extensions, vec!["json"]);
        assert!(updated.scan.gobuster.add_slash);
        assert!(updated.scan.gobuster.discover_backup);
    }

    #[test]
    fn gobuster_patterns_require_placeholder() {
        let mut config = AppConfig::default();
        config.scan.gobuster.patterns = vec!["admin".to_string()];

        let error = config
            .validate()
            .expect_err("gobuster patterns without placeholder should fail validation");
        assert!(
            error
                .to_string()
                .contains("scan.gobuster.patterns entries must contain {GOBUSTER}")
        );
    }

    #[test]
    fn gobuster_status_lists_must_not_overlap() {
        let mut config = AppConfig::default();
        config.scan.gobuster.enabled = true;
        config.scan.gobuster.status_codes = vec![200, 403];
        config.scan.gobuster.status_codes_blacklist = vec![404, 403];

        let error = config
            .validate()
            .expect_err("overlapping gobuster status lists should fail validation");
        assert!(error.to_string().contains(
            "scan.gobuster.status_codes and scan.gobuster.status_codes_blacklist must not overlap"
        ));
    }
}

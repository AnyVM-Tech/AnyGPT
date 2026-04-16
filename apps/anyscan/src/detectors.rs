use std::{
    collections::HashSet,
    io::Write,
    process::{Command, Stdio},
};

use crate::{
    config::AppConfig,
    core::{redact_secret, ExtensionManifest, FindingCandidate, Severity},
    fetcher::FetchedDocument,
};
use anyhow::{anyhow, Context, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use serde_yaml::Value as YamlValue;
use sha2::{Digest, Sha256};
use toml::Value as TomlValue;
use tracing::error;
use url::Url;

#[derive(Debug, Clone)]
enum DetectorPrefilter {
    BodyContainsAny(&'static [&'static str]),
    PathContainsAny(&'static [&'static str]),
    PathOrBodyContainsAny {
        path_hints: &'static [&'static str],
        body_literals: &'static [&'static str],
    },
}

enum DetectorKind {
    Regex(&'static Regex),
    Structured(fn(&FetchedDocument) -> Vec<StructuredMatch>),
}

struct DetectorDefinition {
    name: &'static str,
    severity: Severity,
    kind: DetectorKind,
    prefilter: DetectorPrefilter,
}

struct StructuredMatch {
    start: usize,
    end: usize,
    evidence_value: String,
    secret_value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct StructuredScalarField {
    key: String,
    value: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ExternalFindingCandidate {
    detector: String,
    severity: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    secret_value: Option<String>,
    #[serde(default)]
    redacted_value: Option<String>,
    #[serde(default)]
    evidence: Option<String>,
    #[serde(default)]
    evidence_value: Option<String>,
    #[serde(default)]
    start: Option<usize>,
    #[serde(default)]
    end: Option<usize>,
    #[serde(default)]
    fingerprint: Option<String>,
}

#[derive(Debug, Serialize)]
struct ExternalDetectorInvocation<'a> {
    detector_pack: &'a str,
    path: &'a str,
    url: &'a str,
    status: u16,
    content_type: Option<&'a str>,
    body: &'a str,
    truncated: bool,
    coverage_source: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContextValueKind {
    HighEntropy,
    TokenLike,
    Password,
    ConnectionString,
}

#[derive(Debug, Clone)]
struct ContextualAssignmentRule {
    name: &'static str,
    severity: Severity,
    keywords: &'static [&'static str],
    value_kind: ContextValueKind,
    min_value_len: usize,
}

static OPENAI_KEY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b").expect("valid regex"));
static AWS_ACCESS_KEY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bAKIA[0-9A-Z]{16}\b").expect("valid regex"));
static GITHUB_PAT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b").expect("valid regex"));
static GITHUB_APP_TOKEN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bgh(?:o|u|s|r)_[A-Za-z0-9_]{20,}\b").expect("valid regex"));
static ANTHROPIC_KEY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b").expect("valid regex"));
static GOOGLE_API_KEY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bAIza[0-9A-Za-z_-]{35}\b").expect("valid regex"));
static OPENROUTER_KEY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bsk-or-v1-[A-Za-z0-9_-]{20,}\b").expect("valid regex"));
static STRIPE_LIVE_KEY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b").expect("valid regex"));
static GITLAB_PAT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bglpat-[A-Za-z0-9_-]{20,}\b").expect("valid regex"));
static HUGGINGFACE_TOKEN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bhf_[A-Za-z0-9]{20,}\b").expect("valid regex"));
static SENDGRID_KEY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b").expect("valid regex")
});
static PYPI_TOKEN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bpypi-[A-Za-z0-9_-]{20,}\b").expect("valid regex"));
static NPM_TOKEN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bnpm_[A-Za-z0-9]{36}\b").expect("valid regex"));
static GOOGLE_OAUTH_ACCESS_TOKEN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bya29\.[0-9A-Za-z._-]{20,}\b").expect("valid regex"));
static SHOPIFY_ADMIN_API_TOKEN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bshpat_[A-Za-z0-9]{20,}\b").expect("valid regex"));
static TELEGRAM_BOT_TOKEN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b").expect("valid regex"));
static SLACK_TOKEN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b").expect("valid regex"));
static SLACK_APP_TOKEN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bxapp-[0-9A-Za-z-]{20,}\b").expect("valid regex"));
static SLACK_WEBHOOK: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+\b").expect("valid regex")
});
static DISCORD_WEBHOOK: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"https://discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9._-]+\b")
        .expect("valid regex")
});
static DATABASE_URL_WITH_CREDS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql)://[^:@\s/]+:[^@\s/]+@[^\s"'<>]+\b"#)
        .expect("valid regex")
});
static AZURE_STORAGE_CONNECTION_STRING: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"DefaultEndpointsProtocol=[^;\r\n]+;AccountName=[^;\r\n]+;AccountKey=[A-Za-z0-9+/=]{20,}(?:;[^\r\n]+)*",
    )
    .expect("valid regex")
});
static PRIVATE_KEY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?s)-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----.*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----",
    )
    .expect("valid regex")
});
static CONTEXTUAL_ASSIGNMENT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?mi)(?P<key>["']?[A-Za-z_][A-Za-z0-9_.-]{1,63}["']?)\s*(?:=|:)\s*(?P<value>"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}|[A-Za-z][A-Za-z0-9+.-]*://[^\s"'`]+|[A-Za-z0-9_./+=:@$%?!;-]{4,})"#)
        .expect("valid regex")
});
static NPMRC_AUTH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?mi)^\s*(?:[^\r\n=:]+:)?(?P<key>_authToken|_auth|npmAuthToken)\s*[=:]\s*(?P<value>"[^"\r\n]+"|'[^'\r\n]+'|[^\s#;]+)"#,
    )
    .expect("valid regex")
});
static PYPIRC_PASSWORD_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?mi)^\s*password\s*=\s*(?P<value>[^\r\n#;]+)").expect("valid regex")
});
static NETRC_PASSWORD_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?mi)\bpassword\s+(?P<value>[^\s#]+)").expect("valid regex"));

fn exact_detector(
    name: &'static str,
    severity: Severity,
    regex: &'static Regex,
    literals: &'static [&'static str],
) -> DetectorDefinition {
    DetectorDefinition {
        name,
        severity,
        kind: DetectorKind::Regex(regex),
        prefilter: DetectorPrefilter::BodyContainsAny(literals),
    }
}

fn structured_detector(
    name: &'static str,
    severity: Severity,
    prefilter: DetectorPrefilter,
    scanner: fn(&FetchedDocument) -> Vec<StructuredMatch>,
) -> DetectorDefinition {
    DetectorDefinition {
        name,
        severity,
        kind: DetectorKind::Structured(scanner),
        prefilter,
    }
}

static DETECTORS: Lazy<Vec<DetectorDefinition>> = Lazy::new(|| {
    vec![
        structured_detector(
            "firebase_admin_service_account_private_key",
            Severity::Critical,
            DetectorPrefilter::PathOrBodyContainsAny {
                path_hints: &[
                    "firebase",
                    "firebase-adminsdk",
                    "service-account",
                    "service_account",
                ],
                body_literals: &[
                    "firebase-adminsdk",
                    "private_key_id",
                    "client_email",
                    "gserviceaccount.com",
                    "service_account",
                ],
            },
            scan_firebase_admin_service_account_private_keys,
        ),
        structured_detector(
            "google_service_account_private_key",
            Severity::Critical,
            DetectorPrefilter::PathOrBodyContainsAny {
                path_hints: &[
                    "google",
                    "gcloud",
                    "service-account",
                    "service_account",
                    "credentials",
                ],
                body_literals: &[
                    "private_key_id",
                    "client_email",
                    "gserviceaccount.com",
                    "service_account",
                    "token_uri",
                ],
            },
            scan_google_service_account_private_keys,
        ),
        structured_detector(
            "google_authorized_user_refresh_token",
            Severity::High,
            DetectorPrefilter::PathOrBodyContainsAny {
                path_hints: &[
                    "application_default_credentials",
                    "authorized_user",
                    "google",
                    "oauth",
                ],
                body_literals: &[
                    "authorized_user",
                    "refresh_token",
                    "client_id",
                    "googleusercontent.com",
                ],
            },
            scan_google_authorized_user_refresh_tokens,
        ),
        exact_detector(
            "private_key_material",
            Severity::Critical,
            &PRIVATE_KEY,
            &["PRIVATE KEY"],
        ),
        exact_detector(
            "anthropic_api_key",
            Severity::High,
            &ANTHROPIC_KEY,
            &["sk-ant-"],
        ),
        exact_detector(
            "openrouter_api_key",
            Severity::High,
            &OPENROUTER_KEY,
            &["sk-or-v1-"],
        ),
        exact_detector("openai_api_key", Severity::High, &OPENAI_KEY, &["sk-"]),
        exact_detector("google_api_key", Severity::High, &GOOGLE_API_KEY, &["AIza"]),
        exact_detector(
            "google_oauth_access_token",
            Severity::High,
            &GOOGLE_OAUTH_ACCESS_TOKEN,
            &["ya29."],
        ),
        exact_detector(
            "stripe_live_api_key",
            Severity::High,
            &STRIPE_LIVE_KEY,
            &["sk_live_", "rk_live_"],
        ),
        exact_detector(
            "aws_access_key_id",
            Severity::High,
            &AWS_ACCESS_KEY,
            &["AKIA"],
        ),
        exact_detector(
            "github_personal_access_token",
            Severity::High,
            &GITHUB_PAT,
            &["ghp_", "github_pat_"],
        ),
        exact_detector(
            "github_app_or_oauth_token",
            Severity::High,
            &GITHUB_APP_TOKEN,
            &["gho_", "ghu_", "ghs_", "ghr_"],
        ),
        exact_detector(
            "gitlab_personal_access_token",
            Severity::High,
            &GITLAB_PAT,
            &["glpat-"],
        ),
        exact_detector(
            "huggingface_access_token",
            Severity::High,
            &HUGGINGFACE_TOKEN,
            &["hf_"],
        ),
        exact_detector("sendgrid_api_key", Severity::High, &SENDGRID_KEY, &["SG."]),
        exact_detector("pypi_api_token", Severity::High, &PYPI_TOKEN, &["pypi-"]),
        exact_detector("npm_access_token", Severity::High, &NPM_TOKEN, &["npm_"]),
        exact_detector(
            "shopify_admin_api_token",
            Severity::High,
            &SHOPIFY_ADMIN_API_TOKEN,
            &["shpat_"],
        ),
        exact_detector(
            "telegram_bot_token",
            Severity::High,
            &TELEGRAM_BOT_TOKEN,
            &["TELEGRAM", "telegram", "BOT_TOKEN", "bot_token"],
        ),
        exact_detector(
            "slack_access_token",
            Severity::High,
            &SLACK_TOKEN,
            &["xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"],
        ),
        exact_detector(
            "slack_app_token",
            Severity::High,
            &SLACK_APP_TOKEN,
            &["xapp-"],
        ),
        exact_detector(
            "slack_webhook",
            Severity::Medium,
            &SLACK_WEBHOOK,
            &["hooks.slack.com/services/"],
        ),
        exact_detector(
            "discord_webhook",
            Severity::Medium,
            &DISCORD_WEBHOOK,
            &["discord.com/api/webhooks/", "discordapp.com/api/webhooks/"],
        ),
        structured_detector(
            "aws_shared_credentials_secret_access_key",
            Severity::High,
            DetectorPrefilter::PathOrBodyContainsAny {
                path_hints: &[".aws/credentials", ".aws/config"],
                body_literals: &[
                    "aws_secret_access_key",
                    "aws_access_key_id",
                    "aws_session_token",
                ],
            },
            scan_aws_shared_credentials_secret_access_keys,
        ),
        structured_detector(
            "aws_shared_credentials_session_token",
            Severity::High,
            DetectorPrefilter::PathOrBodyContainsAny {
                path_hints: &[".aws/credentials", ".aws/config"],
                body_literals: &[
                    "aws_session_token",
                    "aws_secret_access_key",
                    "aws_access_key_id",
                ],
            },
            scan_aws_shared_credentials_session_tokens,
        ),
        structured_detector(
            "azure_service_principal_client_secret",
            Severity::High,
            DetectorPrefilter::PathOrBodyContainsAny {
                path_hints: &["azure", "service-principal", "credential"],
                body_literals: &[
                    "tenantId",
                    "tenant_id",
                    "subscriptionId",
                    "subscription_id",
                    "clientId",
                    "client_id",
                    "appId",
                    "app_id",
                    "clientSecret",
                    "client_secret",
                ],
            },
            scan_azure_service_principal_client_secrets,
        ),
        structured_detector(
            "google_oauth_client_secret",
            Severity::High,
            DetectorPrefilter::PathOrBodyContainsAny {
                path_hints: &["google", "oauth", "client-secret", "credentials"],
                body_literals: &[
                    "client_secret",
                    "clientSecret",
                    "accounts.google.com",
                    "oauth2.googleapis.com",
                    "googleusercontent.com",
                    "auth_uri",
                    "token_uri",
                ],
            },
            scan_google_oauth_client_secrets,
        ),
        structured_detector(
            "npm_registry_auth",
            Severity::High,
            DetectorPrefilter::PathOrBodyContainsAny {
                path_hints: &[".npmrc", ".yarnrc", ".yarnrc.yml"],
                body_literals: &["_authToken=", "_auth=", "npmAuthToken:"],
            },
            scan_npm_registry_auth,
        ),
        structured_detector(
            "pypirc_password",
            Severity::High,
            DetectorPrefilter::PathContainsAny(&[".pypirc"]),
            scan_pypirc_passwords,
        ),
        structured_detector(
            "netrc_machine_password",
            Severity::High,
            DetectorPrefilter::PathContainsAny(&[".netrc"]),
            scan_netrc_passwords,
        ),
        structured_detector(
            "docker_registry_auth",
            Severity::High,
            DetectorPrefilter::PathOrBodyContainsAny {
                path_hints: &[".docker/config.json", ".dockerconfigjson", "docker-config"],
                body_literals: &["\"auths\"", "\"identitytoken\"", "\"auth\""],
            },
            scan_docker_registry_auth,
        ),
        structured_detector(
            "kubeconfig_embedded_credential",
            Severity::High,
            DetectorPrefilter::PathOrBodyContainsAny {
                path_hints: &["kubeconfig", ".kube/config"],
                body_literals: &[
                    "client-key-data",
                    "client-certificate-data",
                    "access-token",
                    "refresh-token",
                    "current-context",
                ],
            },
            scan_kubeconfig_credentials,
        ),
    ]
});

static CONTEXTUAL_ASSIGNMENT_RULES: Lazy<Vec<ContextualAssignmentRule>> = Lazy::new(|| {
    vec![
        ContextualAssignmentRule {
            name: "generic_connection_string",
            severity: Severity::High,
            keywords: &[
                "database_url",
                "databaseurl",
                "db_url",
                "dburl",
                "connection_string",
                "connectionstring",
                "conn_string",
                "connstring",
                "dsn",
                "jdbc_url",
                "jdbcurl",
                "redis_url",
                "redisurl",
                "mongodb_uri",
                "mongodburi",
                "postgres_url",
                "postgresurl",
                "mysql_url",
                "mysqlurl",
                "amqp_url",
                "amqpurl",
            ],
            value_kind: ContextValueKind::ConnectionString,
            min_value_len: 12,
        },
        ContextualAssignmentRule {
            name: "generic_authorization_header",
            severity: Severity::High,
            keywords: &[
                "authorization",
                "auth_header",
                "authheader",
                "bearer_token",
                "bearertoken",
            ],
            value_kind: ContextValueKind::TokenLike,
            min_value_len: 16,
        },
        ContextualAssignmentRule {
            name: "generic_api_key",
            severity: Severity::High,
            keywords: &[
                "api_key",
                "apikey",
                "app_key",
                "appkey",
                "access_key",
                "accesskey",
                "auth_key",
                "authkey",
                "secret_access_key",
                "secretaccesskey",
            ],
            value_kind: ContextValueKind::HighEntropy,
            min_value_len: 16,
        },
        ContextualAssignmentRule {
            name: "generic_client_secret",
            severity: Severity::High,
            keywords: &[
                "client_secret",
                "clientsecret",
                "consumer_secret",
                "consumersecret",
                "signing_secret",
                "signingsecret",
                "webhook_secret",
                "webhooksecret",
                "app_secret",
                "appsecret",
                "secret_key",
                "secretkey",
            ],
            value_kind: ContextValueKind::HighEntropy,
            min_value_len: 16,
        },
        ContextualAssignmentRule {
            name: "generic_access_token",
            severity: Severity::High,
            keywords: &[
                "access_token",
                "accesstoken",
                "auth_token",
                "authtoken",
                "api_token",
                "apitoken",
                "session_token",
                "sessiontoken",
                "refresh_token",
                "refreshtoken",
                "id_token",
                "idtoken",
                "token",
            ],
            value_kind: ContextValueKind::TokenLike,
            min_value_len: 16,
        },
        ContextualAssignmentRule {
            name: "generic_password",
            severity: Severity::High,
            keywords: &["password", "passwd", "pwd"],
            value_kind: ContextValueKind::Password,
            min_value_len: 10,
        },
    ]
});

const STRUCTURED_SECRET_FIELD_HINTS: &[&str] = &[
    "apiKey",
    "api_key",
    "accessKey",
    "access_key",
    "clientSecret",
    "client_secret",
    "accessToken",
    "access_token",
    "connectionString",
    "connection_string",
    "databaseUrl",
    "database_url",
    "password",
    "passwd",
    "secret",
    "token",
];

#[derive(Debug, Clone, Default)]
pub struct DetectorEngine {
    external_packs: Vec<ExtensionManifest>,
}

impl DetectorEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_config(config: &AppConfig) -> Result<Self> {
        Ok(Self {
            external_packs: config
                .enabled_extension_manifests()?
                .into_iter()
                .filter(ExtensionManifest::is_detector_pack)
                .collect(),
        })
    }

    pub fn has_external_packs(&self) -> bool {
        !self.external_packs.is_empty()
    }

    pub fn scan_document(&self, document: &FetchedDocument) -> Vec<FindingCandidate> {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();

        scan_detectors(document, &mut seen, &mut findings);
        scan_contextual_assignments(document, &mut seen, &mut findings);
        scan_structured_contextual_assignments(document, &mut seen, &mut findings);
        scan_external_detector_packs(document, &mut seen, &mut findings, &self.external_packs);

        findings
    }
}

fn scan_detectors(
    document: &FetchedDocument,
    seen: &mut HashSet<String>,
    findings: &mut Vec<FindingCandidate>,
) {
    for detector in candidate_detectors(document) {
        match detector.kind {
            DetectorKind::Regex(regex) => {
                for matched in regex.find_iter(&document.body) {
                    push_finding_candidate(
                        findings,
                        seen,
                        document,
                        detector.name,
                        &detector.severity,
                        matched.start(),
                        matched.end(),
                        matched.as_str(),
                        matched.as_str(),
                    );
                }
            }
            DetectorKind::Structured(scanner) => {
                for matched in scanner(document) {
                    push_finding_candidate(
                        findings,
                        seen,
                        document,
                        detector.name,
                        &detector.severity,
                        matched.start,
                        matched.end,
                        &matched.evidence_value,
                        &matched.secret_value,
                    );
                }
            }
        }
    }
}

fn scan_contextual_assignments(
    document: &FetchedDocument,
    seen: &mut HashSet<String>,
    findings: &mut Vec<FindingCandidate>,
) {
    for captures in CONTEXTUAL_ASSIGNMENT_RE.captures_iter(&document.body) {
        let Some(key_match) = captures.name("key") else {
            continue;
        };
        let Some(value_match) = captures.name("value") else {
            continue;
        };

        let key = normalize_contextual_key(key_match.as_str());
        let Some(rule) = contextual_assignment_rule(&key) else {
            continue;
        };

        let normalized_value = normalize_contextual_value(value_match.as_str());
        if !validate_contextual_value(document, &key, &normalized_value, rule) {
            continue;
        }

        push_finding_candidate(
            findings,
            seen,
            document,
            rule.name,
            &rule.severity,
            value_match.start(),
            value_match.end(),
            value_match.as_str(),
            &normalized_value,
        );
    }
}

fn scan_structured_contextual_assignments(
    document: &FetchedDocument,
    seen: &mut HashSet<String>,
    findings: &mut Vec<FindingCandidate>,
) {
    if !should_scan_structured_fields(document) {
        return;
    }

    for field in structured_scalar_fields(document) {
        let key = normalize_contextual_key(&field.key);
        let Some(rule) = contextual_assignment_rule(&key) else {
            continue;
        };

        let normalized_value = normalize_contextual_value(&field.value);
        if !validate_contextual_value(document, &key, &normalized_value, rule) {
            continue;
        }

        let Some(matched) = structured_match_from_value(document, &normalized_value) else {
            continue;
        };

        push_finding_candidate(
            findings,
            seen,
            document,
            rule.name,
            &rule.severity,
            matched.start,
            matched.end,
            &matched.evidence_value,
            &matched.secret_value,
        );
    }
}

fn scan_external_detector_packs(
    document: &FetchedDocument,
    seen: &mut HashSet<String>,
    findings: &mut Vec<FindingCandidate>,
    external_packs: &[ExtensionManifest],
) {
    for manifest in external_packs {
        match run_external_detector_pack(document, manifest) {
            Ok(candidates) => {
                for candidate in candidates {
                    let dedupe_key = format!("{}:{}", candidate.path, candidate.fingerprint);
                    if seen.insert(dedupe_key) {
                        findings.push(candidate);
                    }
                }
            }
            Err(error) => {
                error!(
                    detector_pack = %manifest.name,
                    path = %document.path,
                    %error,
                    "external detector pack failed"
                );
            }
        }
    }
}

fn run_external_detector_pack(
    document: &FetchedDocument,
    manifest: &ExtensionManifest,
) -> Result<Vec<FindingCandidate>> {
    let command = manifest
        .resolved_command()
        .ok_or_else(|| anyhow!("detector pack {} is missing a command", manifest.name))?;
    let invocation = serde_json::to_vec(&ExternalDetectorInvocation {
        detector_pack: &manifest.name,
        path: &document.path,
        url: &document.url,
        status: document.status,
        content_type: document.content_type.as_deref(),
        body: &document.body,
        truncated: document.truncated,
        coverage_source: &document.coverage_source,
    })
    .context("failed to serialize detector pack invocation")?;

    let mut child = Command::new(&command)
        .args(&manifest.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to spawn detector pack {}", manifest.name))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(&invocation).with_context(|| {
            format!("failed to write detector pack input for {}", manifest.name)
        })?;
    }

    let output = child
        .wait_with_output()
        .with_context(|| format!("failed to wait for detector pack {}", manifest.name))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!(
            "detector pack {} exited unsuccessfully{}",
            manifest.name,
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    parse_external_detector_output(&stdout, document, manifest)
}

fn parse_external_detector_output(
    output: &str,
    document: &FetchedDocument,
    manifest: &ExtensionManifest,
) -> Result<Vec<FindingCandidate>> {
    match manifest.output_format() {
        "finding_json_lines" => parse_external_finding_json_lines(output, document),
        other => Err(anyhow!(
            "detector pack {} uses unsupported output format {}",
            manifest.name,
            other
        )),
    }
}

fn parse_external_finding_json_lines(
    output: &str,
    document: &FetchedDocument,
) -> Result<Vec<FindingCandidate>> {
    let mut findings = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let record: ExternalFindingCandidate = serde_json::from_str(line)
            .with_context(|| format!("invalid detector pack JSON line: {line}"))?;
        if let Some(candidate) = external_finding_candidate_from_record(&record, document)? {
            findings.push(candidate);
        }
    }
    Ok(findings)
}

fn external_finding_candidate_from_record(
    record: &ExternalFindingCandidate,
    document: &FetchedDocument,
) -> Result<Option<FindingCandidate>> {
    let detector = record.detector.trim();
    if detector.is_empty() {
        return Ok(None);
    }

    let severity = record
        .severity
        .trim()
        .to_ascii_lowercase()
        .parse::<Severity>()
        .map_err(|error| anyhow!(error))?;
    let path = record
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(document.path.as_str())
        .to_string();

    let secret_value = record
        .secret_value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let fingerprint = match (
        secret_value.as_deref(),
        record
            .fingerprint
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    ) {
        (Some(secret_value), Some(existing_fingerprint)) => {
            let computed_fingerprint = fingerprint(secret_value);
            if computed_fingerprint != existing_fingerprint {
                computed_fingerprint
            } else {
                existing_fingerprint.to_string()
            }
        }
        (Some(secret_value), None) => fingerprint(secret_value),
        (None, Some(existing_fingerprint)) => existing_fingerprint.to_string(),
        (None, None) => return Ok(None),
    };
    let redacted_value = match (
        secret_value.as_deref(),
        record
            .redacted_value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    ) {
        (Some(secret_value), Some(redacted_value)) => {
            if redacted_value == secret_value {
                redact_secret(secret_value)
            } else {
                redacted_value.to_string()
            }
        }
        (Some(secret_value), None) => redact_secret(secret_value),
        (None, Some(redacted_value)) => redacted_value.to_string(),
        (None, None) => return Ok(None),
    };
    let evidence = if let Some(evidence) = record
        .evidence
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        evidence.to_string()
    } else if let Some(evidence_value) = record
        .evidence_value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let (start, end) = match (record.start, record.end) {
            (Some(start), Some(end)) if start < end && end <= document.body.len() => (start, end),
            _ => document
                .body
                .find(evidence_value)
                .map(|start| (start, start + evidence_value.len()))
                .unwrap_or((0, evidence_value.len().min(document.body.len()))),
        };
        build_evidence(document, start, end, evidence_value)
    } else {
        format!("external detector {detector} matched {redacted_value}")
    };

    Ok(Some(FindingCandidate {
        detector: detector.to_string(),
        severity,
        path,
        redacted_value,
        evidence,
        fingerprint,
    }))
}

fn should_scan_structured_fields(document: &FetchedDocument) -> bool {
    is_contextual_secret_path(&document.path)
        || STRUCTURED_SECRET_FIELD_HINTS
            .iter()
            .any(|hint| document.body.contains(hint))
}

fn structured_scalar_fields(document: &FetchedDocument) -> Vec<StructuredScalarField> {
    let trimmed_body = document.body.trim();
    if trimmed_body.is_empty() {
        return Vec::new();
    }

    let lowered_path = document.path.to_ascii_lowercase();
    let mut fields = Vec::new();
    let mut seen = HashSet::new();

    let mut parsed_json = false;
    let mut parsed_yaml = false;
    let mut parsed_toml = false;

    if lowered_path.ends_with(".json")
        || lowered_path.ends_with(".webmanifest")
        || trimmed_body.starts_with('{')
        || trimmed_body.starts_with('[')
    {
        parsed_json = collect_json_structured_fields(trimmed_body, &mut fields, &mut seen);
    }

    if lowered_path.ends_with(".yaml")
        || lowered_path.ends_with(".yml")
        || lowered_path.ends_with("kubeconfig")
    {
        parsed_yaml = collect_yaml_structured_fields(trimmed_body, &mut fields, &mut seen);
    }

    if lowered_path.ends_with(".toml") {
        parsed_toml = collect_toml_structured_fields(trimmed_body, &mut fields, &mut seen);
    }

    if fields.is_empty()
        && !parsed_json
        && !parsed_yaml
        && !parsed_toml
        && (lowered_path.ends_with(".config")
            || lowered_path.ends_with(".conf")
            || lowered_path.contains("/config")
            || lowered_path.contains("/settings"))
    {
        collect_json_structured_fields(trimmed_body, &mut fields, &mut seen);
        collect_yaml_structured_fields(trimmed_body, &mut fields, &mut seen);
        collect_toml_structured_fields(trimmed_body, &mut fields, &mut seen);
    }

    fields
}

fn collect_json_structured_fields(
    body: &str,
    fields: &mut Vec<StructuredScalarField>,
    seen: &mut HashSet<StructuredScalarField>,
) -> bool {
    let Ok(json) = serde_json::from_str::<JsonValue>(body) else {
        return false;
    };
    collect_json_string_fields(None, &json, fields, seen);
    true
}

fn collect_json_string_fields(
    prefix: Option<&str>,
    value: &JsonValue,
    fields: &mut Vec<StructuredScalarField>,
    seen: &mut HashSet<StructuredScalarField>,
) {
    match value {
        JsonValue::Object(map) => {
            for (key, value) in map {
                let next_prefix = join_structured_field_path(prefix, key);
                collect_json_string_fields(Some(&next_prefix), value, fields, seen);
            }
        }
        JsonValue::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                let next_prefix = join_structured_field_path(prefix, &index.to_string());
                collect_json_string_fields(Some(&next_prefix), value, fields, seen);
            }
        }
        JsonValue::String(string) => {
            if let Some(prefix) = prefix {
                push_structured_scalar_field(fields, seen, prefix, string);
            }
        }
        _ => {}
    }
}

fn collect_yaml_structured_fields(
    body: &str,
    fields: &mut Vec<StructuredScalarField>,
    seen: &mut HashSet<StructuredScalarField>,
) -> bool {
    let Ok(yaml) = serde_yaml::from_str::<YamlValue>(body) else {
        return false;
    };
    collect_yaml_string_fields(None, &yaml, fields, seen);
    true
}

fn collect_yaml_string_fields(
    prefix: Option<&str>,
    value: &YamlValue,
    fields: &mut Vec<StructuredScalarField>,
    seen: &mut HashSet<StructuredScalarField>,
) {
    match value {
        YamlValue::Mapping(map) => {
            for (key, value) in map {
                let Some(segment) = yaml_key_segment(key) else {
                    continue;
                };
                let next_prefix = join_structured_field_path(prefix, &segment);
                collect_yaml_string_fields(Some(&next_prefix), value, fields, seen);
            }
        }
        YamlValue::Sequence(values) => {
            for (index, value) in values.iter().enumerate() {
                let next_prefix = join_structured_field_path(prefix, &index.to_string());
                collect_yaml_string_fields(Some(&next_prefix), value, fields, seen);
            }
        }
        YamlValue::String(string) => {
            if let Some(prefix) = prefix {
                push_structured_scalar_field(fields, seen, prefix, string);
            }
        }
        _ => {}
    }
}

fn collect_toml_structured_fields(
    body: &str,
    fields: &mut Vec<StructuredScalarField>,
    seen: &mut HashSet<StructuredScalarField>,
) -> bool {
    let Ok(toml) = body.parse::<TomlValue>() else {
        return false;
    };
    collect_toml_string_fields(None, &toml, fields, seen);
    true
}

fn collect_toml_string_fields(
    prefix: Option<&str>,
    value: &TomlValue,
    fields: &mut Vec<StructuredScalarField>,
    seen: &mut HashSet<StructuredScalarField>,
) {
    match value {
        TomlValue::Table(table) => {
            for (key, value) in table {
                let next_prefix = join_structured_field_path(prefix, key);
                collect_toml_string_fields(Some(&next_prefix), value, fields, seen);
            }
        }
        TomlValue::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                let next_prefix = join_structured_field_path(prefix, &index.to_string());
                collect_toml_string_fields(Some(&next_prefix), value, fields, seen);
            }
        }
        TomlValue::String(string) => {
            if let Some(prefix) = prefix {
                push_structured_scalar_field(fields, seen, prefix, string);
            }
        }
        _ => {}
    }
}

fn join_structured_field_path(prefix: Option<&str>, segment: &str) -> String {
    match prefix {
        Some(prefix) if !prefix.is_empty() => format!("{prefix}.{segment}"),
        _ => segment.to_string(),
    }
}

fn yaml_key_segment(value: &YamlValue) -> Option<String> {
    match value {
        YamlValue::String(string) => Some(string.clone()),
        YamlValue::Number(number) => Some(number.to_string()),
        YamlValue::Bool(boolean) => Some(boolean.to_string()),
        _ => None,
    }
}

fn push_structured_scalar_field(
    fields: &mut Vec<StructuredScalarField>,
    seen: &mut HashSet<StructuredScalarField>,
    key: &str,
    value: &str,
) {
    let field = StructuredScalarField {
        key: key.to_string(),
        value: value.to_string(),
    };
    if field.key.is_empty() || field.value.trim().is_empty() || !seen.insert(field.clone()) {
        return;
    }
    fields.push(field);
}

fn scan_aws_shared_credentials_secret_access_keys(
    document: &FetchedDocument,
) -> Vec<StructuredMatch> {
    scan_assignment_values_for_keys(document, &["aws_secret_access_key"], |value| {
        looks_like_high_entropy_secret(value) || looks_like_base64_secret(value)
    })
}

fn scan_aws_shared_credentials_session_tokens(document: &FetchedDocument) -> Vec<StructuredMatch> {
    scan_assignment_values_for_keys(document, &["aws_session_token"], |value| {
        looks_like_token_like_secret(value)
            || looks_like_high_entropy_secret(value)
            || looks_like_base64_secret(value)
    })
}

fn scan_azure_service_principal_client_secrets(document: &FetchedDocument) -> Vec<StructuredMatch> {
    let fields = structured_scalar_fields(document);
    let has_tenant = fields.iter().any(|field| {
        let key = normalize_contextual_key(&field.key);
        key_matches_keyword(&key, "tenant_id") || key_matches_keyword(&key, "tenantid")
    });
    let has_application = fields.iter().any(|field| {
        let key = normalize_contextual_key(&field.key);
        key_matches_keyword(&key, "client_id")
            || key_matches_keyword(&key, "clientid")
            || key_matches_keyword(&key, "app_id")
            || key_matches_keyword(&key, "appid")
    });
    if !has_tenant || !has_application {
        return Vec::new();
    }

    scan_structured_scalar_secret_fields(
        document,
        &fields,
        &["client_secret", "clientsecret"],
        |value| {
            looks_like_high_entropy_secret(value)
                || looks_like_token_like_secret(value)
                || looks_like_secretish_password(value)
        },
    )
}

fn scan_google_oauth_client_secrets(document: &FetchedDocument) -> Vec<StructuredMatch> {
    let fields = structured_scalar_fields(document);
    let has_google_client_id = fields.iter().any(|field| {
        let key = normalize_contextual_key(&field.key);
        let value = normalize_contextual_value(&field.value);
        key_matches_keyword(&key, "client_id")
            && value
                .to_ascii_lowercase()
                .contains("apps.googleusercontent.com")
    });
    let has_google_oauth_url = fields.iter().any(|field| {
        normalize_contextual_value(&field.value)
            .to_ascii_lowercase()
            .contains("googleapis.com")
            || normalize_contextual_value(&field.value)
                .to_ascii_lowercase()
                .contains("accounts.google.com")
    });
    if !has_google_client_id || !has_google_oauth_url {
        return Vec::new();
    }

    scan_structured_scalar_secret_fields(
        document,
        &fields,
        &["client_secret", "clientsecret"],
        |value| {
            looks_like_token_like_secret(value)
                || looks_like_high_entropy_secret(value)
                || looks_like_secretish_password(value)
        },
    )
}

fn scan_firebase_admin_service_account_private_keys(
    document: &FetchedDocument,
) -> Vec<StructuredMatch> {
    scan_google_service_account_private_keys_internal(document, true)
}

fn scan_google_service_account_private_keys(document: &FetchedDocument) -> Vec<StructuredMatch> {
    scan_google_service_account_private_keys_internal(document, false)
}

fn scan_google_service_account_private_keys_internal(
    document: &FetchedDocument,
    firebase_only: bool,
) -> Vec<StructuredMatch> {
    let fields = structured_scalar_fields(document);
    if !has_google_service_account_metadata(&fields) {
        return Vec::new();
    }

    let is_firebase_account = fields.iter().any(|field| {
        structured_field_matches_keyword(field, "client_email")
            && normalize_contextual_value(&field.value)
                .to_ascii_lowercase()
                .contains("firebase-adminsdk")
    }) || document.path.to_ascii_lowercase().contains("firebase");

    if firebase_only {
        if !is_firebase_account {
            return Vec::new();
        }
    } else if is_firebase_account {
        return Vec::new();
    }

    scan_structured_private_key_fields(document, &fields, &["private_key"])
}

fn scan_google_authorized_user_refresh_tokens(document: &FetchedDocument) -> Vec<StructuredMatch> {
    let fields = structured_scalar_fields(document);
    if !has_google_authorized_user_metadata(&fields) {
        return Vec::new();
    }

    scan_structured_scalar_secret_fields(
        document,
        &fields,
        &["refresh_token", "refreshtoken"],
        |value| looks_like_token_like_secret(value) || looks_like_high_entropy_secret(value),
    )
}

fn has_google_service_account_metadata(fields: &[StructuredScalarField]) -> bool {
    let has_service_account_type = fields.iter().any(|field| {
        structured_field_matches_keyword(field, "type")
            && normalize_contextual_value(&field.value).eq_ignore_ascii_case("service_account")
    });
    let has_gserviceaccount_email = fields.iter().any(|field| {
        structured_field_matches_keyword(field, "client_email")
            && normalize_contextual_value(&field.value)
                .to_ascii_lowercase()
                .ends_with(".gserviceaccount.com")
    });
    let has_private_key_id = fields.iter().any(|field| {
        structured_field_matches_keyword(field, "private_key_id")
            && normalize_contextual_value(&field.value).len() >= 16
    });

    has_service_account_type && has_gserviceaccount_email && has_private_key_id
}

fn has_google_authorized_user_metadata(fields: &[StructuredScalarField]) -> bool {
    let has_authorized_user_type = fields.iter().any(|field| {
        structured_field_matches_keyword(field, "type")
            && normalize_contextual_value(&field.value).eq_ignore_ascii_case("authorized_user")
    });
    let has_google_client_id = fields.iter().any(|field| {
        structured_field_matches_keyword(field, "client_id")
            && normalize_contextual_value(&field.value)
                .to_ascii_lowercase()
                .contains("apps.googleusercontent.com")
    });

    has_authorized_user_type && has_google_client_id
}

fn structured_field_matches_keyword(field: &StructuredScalarField, keyword: &str) -> bool {
    key_matches_keyword(&normalize_contextual_key(&field.key), keyword)
}

fn looks_like_private_key_block(value: &str) -> bool {
    let candidate = normalize_contextual_value(value);
    PRIVATE_KEY.is_match(&candidate) && candidate.contains("-----END")
}

fn scan_assignment_values_for_keys<F>(
    document: &FetchedDocument,
    keys: &[&str],
    validator: F,
) -> Vec<StructuredMatch>
where
    F: Fn(&str) -> bool,
{
    let mut matches = Vec::new();

    for captures in CONTEXTUAL_ASSIGNMENT_RE.captures_iter(&document.body) {
        let Some(key_match) = captures.name("key") else {
            continue;
        };
        let Some(value_match) = captures.name("value") else {
            continue;
        };

        let key = normalize_contextual_key(key_match.as_str());
        if !keys
            .iter()
            .any(|candidate| key_matches_keyword(&key, candidate))
        {
            continue;
        }

        let normalized_value = normalize_contextual_value(value_match.as_str());
        if looks_like_placeholder_secret(&normalized_value) || !validator(&normalized_value) {
            continue;
        }

        matches.push(StructuredMatch {
            start: value_match.start(),
            end: value_match.end(),
            evidence_value: value_match.as_str().to_string(),
            secret_value: normalized_value,
        });
    }

    matches
}

fn scan_structured_scalar_secret_fields<F>(
    document: &FetchedDocument,
    fields: &[StructuredScalarField],
    keys: &[&str],
    validator: F,
) -> Vec<StructuredMatch>
where
    F: Fn(&str) -> bool,
{
    let mut matches = Vec::new();

    for field in fields {
        let key = normalize_contextual_key(&field.key);
        if !keys
            .iter()
            .any(|candidate| key_matches_keyword(&key, candidate))
        {
            continue;
        }

        let normalized_value = normalize_contextual_value(&field.value);
        if looks_like_placeholder_secret(&normalized_value) || !validator(&normalized_value) {
            continue;
        }

        let Some(matched) = structured_match_from_value(document, &normalized_value) else {
            continue;
        };
        matches.push(matched);
    }

    matches
}

fn scan_structured_private_key_fields(
    document: &FetchedDocument,
    fields: &[StructuredScalarField],
    keys: &[&str],
) -> Vec<StructuredMatch> {
    let mut matches = Vec::new();

    for field in fields {
        let key = normalize_contextual_key(&field.key);
        if !keys
            .iter()
            .any(|candidate| key_matches_keyword(&key, candidate))
        {
            continue;
        }

        let normalized_value = normalize_contextual_value(&field.value);
        if looks_like_placeholder_secret(&normalized_value)
            || !looks_like_private_key_block(&normalized_value)
        {
            continue;
        }

        let Some(matched) = structured_body_match_from_value(document, &normalized_value) else {
            continue;
        };
        matches.push(matched);
    }

    matches
}

fn scan_npm_registry_auth(document: &FetchedDocument) -> Vec<StructuredMatch> {
    let mut matches = Vec::new();

    for captures in NPMRC_AUTH_RE.captures_iter(&document.body) {
        let Some(key_match) = captures.name("key") else {
            continue;
        };
        let Some(value_match) = captures.name("value") else {
            continue;
        };

        let key = key_match.as_str().to_ascii_lowercase();
        let normalized_value = normalize_contextual_value(value_match.as_str());
        if looks_like_placeholder_secret(&normalized_value) {
            continue;
        }

        let valid = if key == "_auth" {
            looks_like_high_entropy_secret(&normalized_value)
                || looks_like_base64_secret(&normalized_value)
                || looks_like_secretish_password(&normalized_value)
        } else {
            looks_like_token_like_secret(&normalized_value)
                || looks_like_high_entropy_secret(&normalized_value)
                || looks_like_base64_secret(&normalized_value)
        };
        if !valid {
            continue;
        }

        matches.push(StructuredMatch {
            start: value_match.start(),
            end: value_match.end(),
            evidence_value: value_match.as_str().to_string(),
            secret_value: normalized_value,
        });
    }

    matches
}

fn scan_pypirc_passwords(document: &FetchedDocument) -> Vec<StructuredMatch> {
    let mut matches = Vec::new();

    for captures in PYPIRC_PASSWORD_RE.captures_iter(&document.body) {
        let Some(value_match) = captures.name("value") else {
            continue;
        };
        let normalized_value = normalize_contextual_value(value_match.as_str());
        if looks_like_placeholder_secret(&normalized_value) {
            continue;
        }
        if !(looks_like_secretish_password(&normalized_value)
            || looks_like_token_like_secret(&normalized_value)
            || looks_like_high_entropy_secret(&normalized_value))
        {
            continue;
        }

        matches.push(StructuredMatch {
            start: value_match.start(),
            end: value_match.end(),
            evidence_value: value_match.as_str().to_string(),
            secret_value: normalized_value,
        });
    }

    matches
}

fn scan_netrc_passwords(document: &FetchedDocument) -> Vec<StructuredMatch> {
    let mut matches = Vec::new();

    for captures in NETRC_PASSWORD_RE.captures_iter(&document.body) {
        let Some(value_match) = captures.name("value") else {
            continue;
        };
        let normalized_value = normalize_contextual_value(value_match.as_str());
        if looks_like_placeholder_secret(&normalized_value) {
            continue;
        }
        if !(looks_like_secretish_password(&normalized_value)
            || looks_like_token_like_secret(&normalized_value)
            || looks_like_high_entropy_secret(&normalized_value))
        {
            continue;
        }

        matches.push(StructuredMatch {
            start: value_match.start(),
            end: value_match.end(),
            evidence_value: value_match.as_str().to_string(),
            secret_value: normalized_value,
        });
    }

    matches
}

fn scan_docker_registry_auth(document: &FetchedDocument) -> Vec<StructuredMatch> {
    let Ok(json) = serde_json::from_str::<JsonValue>(&document.body) else {
        return Vec::new();
    };
    let Some(auths) = json.get("auths").and_then(JsonValue::as_object) else {
        return Vec::new();
    };

    let mut matches = Vec::new();
    for auth_config in auths.values() {
        let Some(config) = auth_config.as_object() else {
            continue;
        };

        for key in ["auth", "identitytoken", "identityToken"] {
            let Some(value) = config.get(key).and_then(JsonValue::as_str) else {
                continue;
            };
            if looks_like_placeholder_secret(value) {
                continue;
            }

            let valid = if key == "auth" {
                looks_like_high_entropy_secret(value) || looks_like_base64_secret(value)
            } else {
                looks_like_token_like_secret(value) || looks_like_high_entropy_secret(value)
            };
            if !valid {
                continue;
            }

            if let Some(matched) = structured_match_from_value(document, value) {
                matches.push(matched);
            }
        }
    }

    matches
}

fn scan_kubeconfig_credentials(document: &FetchedDocument) -> Vec<StructuredMatch> {
    let Ok(yaml) = serde_yaml::from_str::<YamlValue>(&document.body) else {
        return Vec::new();
    };

    let mut matches = Vec::new();
    collect_kubeconfig_credentials(document, &yaml, &mut matches);
    matches
}

fn collect_kubeconfig_credentials(
    document: &FetchedDocument,
    value: &YamlValue,
    matches: &mut Vec<StructuredMatch>,
) {
    match value {
        YamlValue::Mapping(map) => {
            for (key, value) in map {
                if let Some(key_str) = key.as_str() {
                    maybe_push_kubeconfig_credential(document, key_str, value, matches);
                }
                collect_kubeconfig_credentials(document, value, matches);
            }
        }
        YamlValue::Sequence(values) => {
            for value in values {
                collect_kubeconfig_credentials(document, value, matches);
            }
        }
        _ => {}
    }
}

fn maybe_push_kubeconfig_credential(
    document: &FetchedDocument,
    key: &str,
    value: &YamlValue,
    matches: &mut Vec<StructuredMatch>,
) {
    let Some(secret_value) = value.as_str() else {
        return;
    };
    if looks_like_placeholder_secret(secret_value) {
        return;
    }

    let normalized_key = key.to_ascii_lowercase();
    let valid = match normalized_key.as_str() {
        "token" | "access-token" | "refresh-token" | "client-secret" => {
            looks_like_token_like_secret(secret_value)
                || looks_like_high_entropy_secret(secret_value)
        }
        "password" => looks_like_secretish_password(secret_value),
        "client-key-data" | "client-certificate-data" => {
            looks_like_high_entropy_secret(secret_value) || looks_like_base64_secret(secret_value)
        }
        _ => false,
    };
    if !valid {
        return;
    }

    if let Some(matched) = structured_match_from_value(document, secret_value) {
        matches.push(matched);
    }
}

fn structured_match_from_value(
    document: &FetchedDocument,
    secret_value: &str,
) -> Option<StructuredMatch> {
    let (start, end, evidence_value) = resolve_match_span(&document.body, secret_value)?;
    Some(StructuredMatch {
        start,
        end,
        evidence_value,
        secret_value: secret_value.to_string(),
    })
}

fn structured_body_match_from_value(
    document: &FetchedDocument,
    secret_value: &str,
) -> Option<StructuredMatch> {
    let (start, end, evidence_value) = resolve_match_span(&document.body, secret_value)?;
    Some(StructuredMatch {
        start,
        end,
        secret_value: evidence_value.clone(),
        evidence_value,
    })
}

fn resolve_match_span(body: &str, secret_value: &str) -> Option<(usize, usize, String)> {
    let normalized = normalize_contextual_value(secret_value);
    let mut candidates = Vec::new();
    if !normalized.is_empty() {
        candidates.push(normalized);
    }

    if let Ok(json_encoded) = serde_json::to_string(secret_value) {
        let encoded = json_encoded.trim_matches('"').to_string();
        if !encoded.is_empty() && !candidates.iter().any(|candidate| candidate == &encoded) {
            candidates.push(encoded);
        }
    }

    for candidate in candidates {
        if let Some(start) = body.find(&candidate) {
            return Some((start, start + candidate.len(), candidate));
        }
    }

    None
}

fn push_finding_candidate(
    findings: &mut Vec<FindingCandidate>,
    seen: &mut HashSet<String>,
    document: &FetchedDocument,
    detector_name: &str,
    severity: &Severity,
    start: usize,
    end: usize,
    evidence_value: &str,
    secret_value: &str,
) {
    let secret_value = secret_value.trim();
    if secret_value.is_empty() {
        return;
    }

    let fingerprint = fingerprint(secret_value);
    let dedupe_key = format!("{}:{fingerprint}", document.path);
    if !seen.insert(dedupe_key) {
        return;
    }

    findings.push(FindingCandidate {
        detector: detector_name.to_string(),
        severity: severity.clone(),
        path: document.path.clone(),
        redacted_value: redact_secret(secret_value),
        evidence: build_evidence(document, start, end, evidence_value),
        fingerprint,
    });
}

fn candidate_detectors(document: &FetchedDocument) -> Vec<&'static DetectorDefinition> {
    DETECTORS
        .iter()
        .filter(|detector| detector.prefilter.matches(document))
        .collect()
}

fn contextual_assignment_rule(key: &str) -> Option<&'static ContextualAssignmentRule> {
    CONTEXTUAL_ASSIGNMENT_RULES.iter().find(|rule| {
        rule.keywords
            .iter()
            .any(|keyword| key_matches_keyword(key, keyword))
    })
}

fn key_matches_keyword(key: &str, keyword: &str) -> bool {
    key == keyword
        || key.starts_with(&format!("{keyword}_"))
        || key.ends_with(&format!("_{keyword}"))
        || key.contains(&format!("_{keyword}_"))
}

impl DetectorPrefilter {
    fn matches(&self, document: &FetchedDocument) -> bool {
        let lowered_path = document.path.to_ascii_lowercase();

        match self {
            Self::BodyContainsAny(literals) => literals
                .iter()
                .any(|literal| document.body.contains(literal)),
            Self::PathContainsAny(hints) => hints.iter().any(|hint| lowered_path.contains(hint)),
            Self::PathOrBodyContainsAny {
                path_hints,
                body_literals,
            } => {
                path_hints.iter().any(|hint| lowered_path.contains(hint))
                    || body_literals
                        .iter()
                        .any(|literal| document.body.contains(literal))
            }
        }
    }
}

fn normalize_contextual_key(value: &str) -> String {
    value
        .trim()
        .trim_matches(&['"', '\''][..])
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace('.', "_")
}

fn normalize_contextual_value(value: &str) -> String {
    value
        .trim()
        .trim_end_matches(|ch| ch == ',' || ch == ';')
        .trim_matches(&['"', '\''][..])
        .trim()
        .to_string()
}

fn validate_contextual_value(
    document: &FetchedDocument,
    key: &str,
    value: &str,
    rule: &ContextualAssignmentRule,
) -> bool {
    if value.len() < rule.min_value_len || looks_like_placeholder_secret(value) {
        return false;
    }

    match rule.value_kind {
        ContextValueKind::HighEntropy => looks_like_high_entropy_secret(value),
        ContextValueKind::TokenLike => {
            if key == "token" && !is_contextual_secret_path(&document.path) {
                let candidate = strip_auth_scheme(value).unwrap_or(value);
                return looks_like_jwt(candidate);
            }
            looks_like_token_like_secret(value)
        }
        ContextValueKind::Password => looks_like_secretish_password(value),
        ContextValueKind::ConnectionString => looks_like_connection_string(value),
    }
}

fn looks_like_placeholder_secret(value: &str) -> bool {
    let candidate = strip_auth_scheme(value).unwrap_or(value).trim();
    if candidate.is_empty() {
        return true;
    }

    let lowered = candidate.to_ascii_lowercase();
    let exact_placeholders = [
        "example",
        "placeholder",
        "changeme",
        "dummy",
        "sample",
        "test",
        "testing",
        "secret",
        "password",
        "token",
        "api_key",
        "apikey",
        "null",
        "undefined",
        "none",
        "redacted",
        "masked",
    ];
    if exact_placeholders.contains(&lowered.as_str()) {
        return true;
    }

    if lowered.starts_with("${")
        || lowered.starts_with("{{")
        || lowered.starts_with('<')
        || lowered.starts_with("your_")
        || lowered.starts_with("your-")
        || lowered.starts_with("replace_")
        || lowered.starts_with("replace-")
        || lowered.ends_with("_here")
        || lowered.ends_with("-here")
        || lowered.contains("changeme")
        || lowered.contains("placeholder")
        || lowered.contains("<redacted>")
    {
        return true;
    }

    unique_char_count(candidate) <= 2 && candidate.len() >= 8
}

fn looks_like_connection_string(value: &str) -> bool {
    if AZURE_STORAGE_CONNECTION_STRING.is_match(value) {
        let lowered = value.to_ascii_lowercase();
        return !(lowered.contains("<redacted>")
            || lowered.contains("changeme")
            || lowered.contains("placeholder")
            || lowered.contains("accountname=example"));
    }

    if !DATABASE_URL_WITH_CREDS.is_match(value) {
        let lowered = value.to_ascii_lowercase();
        return lowered.starts_with("jdbc:")
            && lowered.contains("user=")
            && lowered.contains("password=")
            && !lowered.contains("example");
    }

    let Ok(parsed) = Url::parse(value) else {
        return true;
    };

    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if host == "example.com"
        || host == "example.org"
        || host == "example.net"
        || host == "example.test"
        || host.starts_with("example.")
    {
        return false;
    }

    !parsed.username().is_empty()
        && parsed
            .password()
            .map(|password| !looks_like_placeholder_secret(password))
            .unwrap_or(false)
}

fn looks_like_token_like_secret(value: &str) -> bool {
    let candidate = strip_auth_scheme(value).unwrap_or(value).trim();
    looks_like_jwt(candidate) || looks_like_high_entropy_secret(candidate)
}

fn looks_like_high_entropy_secret(value: &str) -> bool {
    let candidate = strip_auth_scheme(value).unwrap_or(value).trim();
    if candidate.len() < 16
        || candidate.contains("://")
        || candidate.chars().any(|ch| ch.is_whitespace())
    {
        return false;
    }

    let class_count = char_class_count(candidate);
    let unique_count = unique_char_count(candidate);
    let has_separator = candidate.contains('_')
        || candidate.contains('-')
        || candidate.contains('/')
        || candidate.contains('+')
        || candidate.contains('=');

    (class_count >= 3 && unique_count >= 8)
        || (class_count >= 2 && unique_count >= 10 && has_separator && candidate.len() >= 20)
        || looks_like_jwt(candidate)
}

fn looks_like_base64_secret(value: &str) -> bool {
    let candidate = value.trim();
    candidate.len() >= 12
        && candidate.len() % 4 == 0
        && unique_char_count(candidate) >= 6
        && candidate
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=' | '-' | '_'))
}

fn looks_like_jwt(value: &str) -> bool {
    let mut parts = value.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };

    value.starts_with("eyJ")
        && header.len() >= 8
        && payload.len() >= 8
        && signature.len() >= 8
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn looks_like_secretish_password(value: &str) -> bool {
    if value.len() < 10 || value.contains("://") || value.chars().any(|ch| ch.is_whitespace()) {
        return false;
    }

    let class_count = char_class_count(value);
    let unique_count = unique_char_count(value);
    (class_count >= 2 && unique_count >= 6)
        || (class_count >= 1 && unique_count >= 10 && value.len() >= 16)
}

fn is_contextual_secret_path(path: &str) -> bool {
    let lowered = path.trim().to_ascii_lowercase();
    lowered.ends_with(".env")
        || lowered.contains(".env.")
        || lowered.ends_with(".json")
        || lowered.ends_with(".yaml")
        || lowered.ends_with(".yml")
        || lowered.ends_with(".toml")
        || lowered.ends_with(".ini")
        || lowered.ends_with(".conf")
        || lowered.ends_with(".config")
        || lowered.ends_with(".js")
        || lowered.ends_with(".cjs")
        || lowered.ends_with(".mjs")
        || lowered.ends_with(".ts")
        || lowered.ends_with(".tsx")
        || lowered.ends_with(".npmrc")
        || lowered.ends_with(".pypirc")
        || lowered.ends_with(".netrc")
        || lowered.ends_with("kubeconfig")
        || lowered.ends_with("/config")
        || lowered.contains("/settings")
}

fn strip_auth_scheme(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    strip_ascii_case_prefix(trimmed, "Bearer ")
        .or_else(|| strip_ascii_case_prefix(trimmed, "Basic "))
        .map(str::trim)
}

fn strip_ascii_case_prefix<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    if value.len() >= prefix.len() && value[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&value[prefix.len()..])
    } else {
        None
    }
}

fn char_class_count(value: &str) -> usize {
    let has_lower = value.chars().any(|ch| ch.is_ascii_lowercase());
    let has_upper = value.chars().any(|ch| ch.is_ascii_uppercase());
    let has_digit = value.chars().any(|ch| ch.is_ascii_digit());
    let has_symbol = value.chars().any(|ch| !ch.is_ascii_alphanumeric());
    [has_lower, has_upper, has_digit, has_symbol]
        .into_iter()
        .filter(|present| *present)
        .count()
}

fn unique_char_count(value: &str) -> usize {
    value.chars().collect::<HashSet<_>>().len()
}

fn build_evidence(document: &FetchedDocument, start: usize, end: usize, matched: &str) -> String {
    let line_number = document.body[..start]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        + 1;
    let line_start = document.body[..start]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let line_end = document.body[end..]
        .find('\n')
        .map(|offset| end + offset)
        .unwrap_or(document.body.len());
    let line = &document.body[line_start..line_end];
    let match_start_in_line = start.saturating_sub(line_start);
    let match_end_in_line = match_start_in_line + matched.len();

    let prefix = abbreviate_suffix(&line[..match_start_in_line], 48);
    let suffix = abbreviate_prefix(&line[match_end_in_line..], 48);
    let excerpt = format!("{prefix}{}{suffix}", redact_secret(matched));
    let content_type = document.content_type.as_deref().unwrap_or("unknown");
    let truncated = if document.truncated {
        ", truncated"
    } else {
        ""
    };

    format!(
        "status={} type={} line={}{} :: {}",
        document.status,
        content_type,
        line_number,
        truncated,
        excerpt.trim()
    )
}

fn abbreviate_prefix(value: &str, keep: usize) -> String {
    if value.chars().count() <= keep {
        return value.to_string();
    }

    let prefix = value.chars().take(keep).collect::<String>();
    format!("{prefix}…")
}

fn abbreviate_suffix(value: &str, keep: usize) -> String {
    let total = value.chars().count();
    if total <= keep {
        return value.to_string();
    }

    let suffix = value
        .chars()
        .skip(total.saturating_sub(keep))
        .collect::<String>();
    format!("…{suffix}")
}

fn fingerprint(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use crate::fetcher::FetchedDocument;

    use super::{candidate_detectors, DetectorEngine};

    fn document(path: &str, body: &str) -> FetchedDocument {
        FetchedDocument {
            path: path.to_string(),
            url: format!("https://example.test{path}"),
            status: 200,
            content_type: Some("text/plain".to_string()),
            body: body.to_string(),
            truncated: false,
            coverage_source: "test-seed".to_string(),
        }
    }

    #[test]
    fn detector_engine_redacts_matches() {
        let engine = DetectorEngine::new();
        let findings = engine.scan_document(&document(
            "/.env",
            "OPENAI_API_KEY=sk-proj-1234567890abcdefghijklmnopqrstuv",
        ));
        assert_eq!(findings.len(), 1);
        assert!(findings[0].redacted_value.contains("****"));
        assert_eq!(findings[0].path, "/.env");
    }

    #[test]
    fn detector_engine_finds_expanded_provider_catalog() {
        let engine = DetectorEngine::new();
        let findings = engine.scan_document(&document(
            "/config.js",
            concat!(
                "const anthropic='sk-ant-1234567890abcdefghijklmnopqrstuv';\n",
                "const stripe='sk", "_live_1234567890abcdefghijklmnopqrst';\n",
                "const openrouter='sk-or-v1-1234567890abcdefghijklmnopqrstuv';\n",
                "const google='AIza12345678901234567890123456789012345';\n",
                "const googleOauth='ya29.a0AfH6SMBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';\n",
                "const gitlab='glpat-1234567890abcdefghijklmnopqrstuv';\n",
                "const huggingface='hf_1234567890abcdefghijklmnopqrstuv';\n",
                "const sendgrid='SG.qwertyuiopasdfghjklzxcvbnm1234.asdfghjklqwertyuiopzxcvbnm1234';\n",
                "const pypi='pypi-AgEIcHlwaS5vcmcCJDEyMzQ1Njc4OTBhYmNkZWYxMjM0NTY';\n",
                "const npm='npm_1234567890abcdefghijklmnopqrstuvwxyz';\n",
                "const shopify='shpat_1234567890abcdefghijklmnopqrstuv';\n",
                "const slack='xox", "b-123456789012-abcdefghijklmnopqrstuvwx';\n",
                "const slackApp='xap", "p-1-123456789012-abcdefghijklmnopqrstuvwx';\n"
            ),
        ));

        let detectors = findings
            .iter()
            .map(|finding| finding.detector.as_str())
            .collect::<HashSet<_>>();
        assert!(detectors.contains("anthropic_api_key"));
        assert!(detectors.contains("stripe_live_api_key"));
        assert!(detectors.contains("openrouter_api_key"));
        assert!(detectors.contains("google_api_key"));
        assert!(detectors.contains("google_oauth_access_token"));
        assert!(detectors.contains("gitlab_personal_access_token"));
        assert!(detectors.contains("huggingface_access_token"));
        assert!(detectors.contains("sendgrid_api_key"));
        assert!(detectors.contains("pypi_api_token"));
        assert!(detectors.contains("npm_access_token"));
        assert!(detectors.contains("shopify_admin_api_token"));
        assert!(detectors.contains("slack_access_token"));
        assert!(detectors.contains("slack_app_token"));
    }

    #[test]
    fn detector_engine_finds_contextual_assignments_without_provider_prefixes() {
        let engine = DetectorEngine::new();
        let findings = engine.scan_document(&document(
            "/application.json",
            concat!(
                "AWS_SECRET_ACCESS_KEY=Zx9wVb3qRt7yLm2Nf8KpQ4sJd6Hc1XvB0mNeUaYw\n",
                "DATABASE_URL=postgres://svcuser:S3cr3tPassw0rd!@db.internal.local:5432/app\n",
                "AUTHORIZATION=Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6ImFkbWluIn0.c2lnbmF0dXJld2l0aGVudHJvcHkxMjM0NTY\n",
                "DB_PASSWORD=Sup3rS3cretPass!\n",
                "AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=prodstore;AccountKey=QWxhZGRpbjpPcGVuU2VzYW1lL0xvbmdLZXlWYWx1ZVN0cmluZw==;EndpointSuffix=core.windows.net\n"
            ),
        ));

        let detectors = findings
            .iter()
            .map(|finding| finding.detector.as_str())
            .collect::<HashSet<_>>();
        assert!(detectors.contains("generic_api_key"));
        assert!(detectors.contains("generic_connection_string"));
        assert!(detectors.contains("generic_authorization_header"));
        assert!(detectors.contains("generic_password"));
    }

    #[test]
    fn detector_engine_finds_structured_artifact_credentials() {
        let engine = DetectorEngine::new();

        let npm_findings = engine.scan_document(&document(
            "/.npmrc",
            "//registry.npmjs.org/:_auth=QWxhZGRpbjpPcGVuU2VzYW1lMTIzNDU2\n",
        ));
        assert_eq!(npm_findings.len(), 1);
        assert_eq!(npm_findings[0].detector, "npm_registry_auth");

        let pypirc_findings = engine.scan_document(&document(
            "/.pypirc",
            "[pypi]\nusername = __token__\npassword = Sup3rPypiPassw0rd!\n",
        ));
        assert_eq!(pypirc_findings.len(), 1);
        assert_eq!(pypirc_findings[0].detector, "pypirc_password");

        let netrc_findings = engine.scan_document(&document(
            "/.netrc",
            "machine api.example.test login svc password Sup3rS3cretPass!\n",
        ));
        assert_eq!(netrc_findings.len(), 1);
        assert_eq!(netrc_findings[0].detector, "netrc_machine_password");

        let docker_findings = engine.scan_document(&document(
            "/.docker/config.json",
            r#"{"auths":{"registry.example.test":{"auth":"QWxhZGRpbjpPcGVuU2VzYW1lMTIzNDU2"}}}"#,
        ));
        assert_eq!(docker_findings.len(), 1);
        assert_eq!(docker_findings[0].detector, "docker_registry_auth");

        let kube_findings = engine.scan_document(&document(
            "/.kube/config",
            concat!(
                "apiVersion: v1\n",
                "kind: Config\n",
                "current-context: prod\n",
                "users:\n",
                "  - name: prod\n",
                "    user:\n",
                "      token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwcm9kIiwicm9sZSI6ImFkbWluIn0.c2lnbmF0dXJlYm9keXdpdGhzdWZmaWNpZW50ZW50cm9weQ\n"
            ),
        ));
        assert_eq!(kube_findings.len(), 1);
        assert_eq!(kube_findings[0].detector, "kubeconfig_embedded_credential");
    }

    #[test]
    fn detector_engine_finds_service_account_credential_artifacts() {
        let engine = DetectorEngine::new();

        let google_service_account_findings = engine.scan_document(&document(
            "/google/service-account.json",
            concat!(
                "{\n",
                "  \"type\": \"service_account\",\n",
                "  \"project_id\": \"sample-project\",\n",
                "  \"private_key_id\": \"1234567890abcdef1234567890abcdef12345678\",\n",
                "  \"private_key\": \"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCAbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/=\\n-----END PRIVATE KEY-----\\n\",\n",
                "  \"client_email\": \"svc-account@sample-project.iam.gserviceaccount.com\",\n",
                "  \"client_id\": \"123456789012345678901\",\n",
                "  \"token_uri\": \"https://oauth2.googleapis.com/token\"\n",
                "}\n"
            ),
        ));
        assert_eq!(google_service_account_findings.len(), 1);
        assert_eq!(
            google_service_account_findings[0].detector,
            "google_service_account_private_key"
        );

        let firebase_service_account_findings = engine.scan_document(&document(
            "/firebase/firebase-adminsdk.json",
            concat!(
                "{\n",
                "  \"type\": \"service_account\",\n",
                "  \"project_id\": \"sample-project\",\n",
                "  \"private_key_id\": \"abcdef1234567890abcdef1234567890abcdef12\",\n",
                "  \"private_key\": \"-----BEGIN PRIVATE KEY-----\\nQWERTYUIOPLKJHGFDSAZXCVBNM0123456789+/=abcd\\n-----END PRIVATE KEY-----\\n\",\n",
                "  \"client_email\": \"firebase-adminsdk-abc12@sample-project.iam.gserviceaccount.com\",\n",
                "  \"client_id\": \"109876543210987654321\",\n",
                "  \"token_uri\": \"https://oauth2.googleapis.com/token\"\n",
                "}\n"
            ),
        ));
        assert_eq!(firebase_service_account_findings.len(), 1);
        assert_eq!(
            firebase_service_account_findings[0].detector,
            "firebase_admin_service_account_private_key"
        );

        let authorized_user_findings = engine.scan_document(&document(
            "/config/application_default_credentials.json",
            concat!(
                "{\n",
                "  \"type\": \"authorized_user\",\n",
                "  \"client_id\": \"123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com\",\n",
                "  \"client_secret\": \"your_client_secret_here\",\n",
                "  \"refresh_token\": \"1//0gAbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEFGHIJKLMN\"\n",
                "}\n"
            ),
        ));
        assert_eq!(authorized_user_findings.len(), 1);
        assert_eq!(
            authorized_user_findings[0].detector,
            "google_authorized_user_refresh_token"
        );
    }

    #[test]
    fn detector_engine_ignores_placeholder_service_account_artifacts() {
        let engine = DetectorEngine::new();

        let google_service_account_findings = engine.scan_document(&document(
            "/google/service-account.json",
            concat!(
                "{\n",
                "  \"type\": \"service_account\",\n",
                "  \"project_id\": \"sample-project\",\n",
                "  \"private_key_id\": \"1234567890abcdef1234567890abcdef12345678\",\n",
                "  \"private_key\": \"<redacted>\",\n",
                "  \"client_email\": \"svc-account@sample-project.iam.gserviceaccount.com\",\n",
                "  \"client_id\": \"123456789012345678901\",\n",
                "  \"token_uri\": \"https://oauth2.googleapis.com/token\"\n",
                "}\n"
            ),
        ));
        assert!(google_service_account_findings.is_empty());

        let firebase_service_account_findings = engine.scan_document(&document(
            "/firebase/firebase-adminsdk.json",
            concat!(
                "{\n",
                "  \"type\": \"service_account\",\n",
                "  \"project_id\": \"sample-project\",\n",
                "  \"private_key_id\": \"abcdef1234567890abcdef1234567890abcdef12\",\n",
                "  \"private_key\": \"your_private_key_here\",\n",
                "  \"client_email\": \"firebase-adminsdk-abc12@sample-project.iam.gserviceaccount.com\",\n",
                "  \"client_id\": \"109876543210987654321\",\n",
                "  \"token_uri\": \"https://oauth2.googleapis.com/token\"\n",
                "}\n"
            ),
        ));
        assert!(firebase_service_account_findings.is_empty());

        let authorized_user_findings = engine.scan_document(&document(
            "/config/application_default_credentials.json",
            concat!(
                "{\n",
                "  \"type\": \"authorized_user\",\n",
                "  \"client_id\": \"123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com\",\n",
                "  \"client_secret\": \"your_client_secret_here\",\n",
                "  \"refresh_token\": \"${GOOGLE_REFRESH_TOKEN}\"\n",
                "}\n"
            ),
        ));
        assert!(authorized_user_findings.is_empty());
    }

    #[test]
    fn detector_engine_finds_cloud_credential_artifacts() {
        let engine = DetectorEngine::new();

        let aws_findings = engine.scan_document(&document(
            "/.aws/credentials",
            concat!(
                "[default]\n",
                "aws_access_key_id = AKIA1234567890ABCDEF\n",
                "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG+bPxRfiCYzEXAMPLEKEY99\n",
                "aws_session_token = FwoGZXIvYXdzEO7//////////wEaDK2v8nB5dHjK9LmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoP\n"
            ),
        ));
        let aws_detectors = aws_findings
            .iter()
            .map(|finding| finding.detector.as_str())
            .collect::<HashSet<_>>();
        assert!(aws_detectors.contains("aws_access_key_id"));
        assert!(aws_detectors.contains("aws_shared_credentials_secret_access_key"));
        assert!(aws_detectors.contains("aws_shared_credentials_session_token"));

        let azure_findings = engine.scan_document(&document(
            "/azure/service-principal.json",
            concat!(
                "{\n",
                "  \"tenantId\": \"11111111-2222-3333-4444-555555555555\",\n",
                "  \"clientId\": \"66666666-7777-8888-9999-000000000000\",\n",
                "  \"subscriptionId\": \"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\",\n",
                "  \"clientSecret\": \"Azur3SpnClientSecretValueQwErTy123456789!\"\n",
                "}\n"
            ),
        ));
        assert_eq!(azure_findings.len(), 1);
        assert_eq!(
            azure_findings[0].detector,
            "azure_service_principal_client_secret"
        );

        let google_findings = engine.scan_document(&document(
            "/google/oauth-client.json",
            concat!(
                "{\n",
                "  \"installed\": {\n",
                "    \"client_id\": \"123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com\",\n",
                "    \"project_id\": \"sample-project\",\n",
                "    \"auth_uri\": \"https://accounts.google.com/o/oauth2/auth\",\n",
                "    \"token_uri\": \"https://oauth2.googleapis.com/token\",\n",
                "    \"client_secret\": \"GOCSPX-1234567890abcdefghijklmnopqrstuv\"\n",
                "  }\n",
                "}\n"
            ),
        ));
        assert_eq!(google_findings.len(), 1);
        assert_eq!(google_findings[0].detector, "google_oauth_client_secret");
    }

    #[test]
    fn detector_engine_ignores_placeholder_cloud_credential_artifacts() {
        let engine = DetectorEngine::new();

        let aws_findings = engine.scan_document(&document(
            "/.aws/credentials",
            concat!(
                "[default]\n",
                "aws_access_key_id = AKIA1234567890ABCDEF\n",
                "aws_secret_access_key = ${AWS_SECRET_ACCESS_KEY}\n",
                "aws_session_token = <redacted>\n"
            ),
        ));
        let aws_detectors = aws_findings
            .iter()
            .map(|finding| finding.detector.as_str())
            .collect::<HashSet<_>>();
        assert!(aws_detectors.contains("aws_access_key_id"));
        assert!(!aws_detectors.contains("aws_shared_credentials_secret_access_key"));
        assert!(!aws_detectors.contains("aws_shared_credentials_session_token"));

        let azure_findings = engine.scan_document(&document(
            "/azure/service-principal.json",
            concat!(
                "{\n",
                "  \"tenantId\": \"11111111-2222-3333-4444-555555555555\",\n",
                "  \"clientId\": \"66666666-7777-8888-9999-000000000000\",\n",
                "  \"clientSecret\": \"your_client_secret_here\"\n",
                "}\n"
            ),
        ));
        assert!(azure_findings.is_empty());

        let google_findings = engine.scan_document(&document(
            "/google/oauth-client.json",
            concat!(
                "{\n",
                "  \"installed\": {\n",
                "    \"client_id\": \"123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com\",\n",
                "    \"auth_uri\": \"https://accounts.google.com/o/oauth2/auth\",\n",
                "    \"token_uri\": \"https://oauth2.googleapis.com/token\",\n",
                "    \"client_secret\": \"your_client_secret_here\"\n",
                "  }\n",
                "}\n"
            ),
        ));
        assert!(google_findings.is_empty());
    }

    #[test]
    fn detector_engine_finds_nested_structured_secret_fields_in_json() {
        let engine = DetectorEngine::new();
        let findings = engine.scan_document(&document(
            "/config/app.json",
            concat!(
                "{\n",
                "  \"integrations\": {\n",
                "    \"vendor\": {\n",
                "      \"api\": { \"key\": \"Zx9wVb3qRt7yLm2Nf8KpQ4sJd6Hc1XvB0mNeUaYw\" },\n",
                "      \"oauth\": { \"client\": { \"secret\": \"Cli3ntS3cretValu3Z9y8x7w6v5u4t3s2AaBb\" } },\n",
                "      \"database\": { \"url\": \"postgres://svcuser:Sup3rS3cretPassw0rd!@db.internal.local:5432/app\" }\n",
                "    }\n",
                "  }\n",
                "}\n"
            ),
        ));

        let detectors = findings
            .iter()
            .map(|finding| finding.detector.as_str())
            .collect::<HashSet<_>>();
        assert!(detectors.contains("generic_api_key"));
        assert!(detectors.contains("generic_client_secret"));
        assert!(detectors.contains("generic_connection_string"));
    }

    #[test]
    fn detector_engine_finds_nested_structured_secret_fields_in_yaml_and_toml() {
        let engine = DetectorEngine::new();

        let yaml_findings = engine.scan_document(&document(
            "/settings/runtime.yaml",
            concat!(
                "integrations:\n",
                "  payments:\n",
                "    client:\n",
                "      secret: Paym3ntSecretValueAbCdEfGhIjKlMnOpQr\n",
                "  cache:\n",
                "    redis:\n",
                "      url: redis://svcuser:Sup3rRedisPassw0rd!@redis.internal.local:6379/0\n"
            ),
        ));
        let yaml_detectors = yaml_findings
            .iter()
            .map(|finding| finding.detector.as_str())
            .collect::<HashSet<_>>();
        assert!(yaml_detectors.contains("generic_client_secret"));
        assert!(yaml_detectors.contains("generic_connection_string"));

        let toml_findings = engine.scan_document(&document(
            "/config/runtime.toml",
            concat!(
                "[oauth.client]\n",
                "secret = \"TomlClientSecretValue9QwErTyUiOpAsDfGhJkLz\"\n\n",
                "[database]\n",
                "url = \"mysql://svcuser:Sup3rMySqlPassw0rd!@mysql.internal.local:3306/app\"\n"
            ),
        ));
        let toml_detectors = toml_findings
            .iter()
            .map(|finding| finding.detector.as_str())
            .collect::<HashSet<_>>();
        assert!(toml_detectors.contains("generic_client_secret"));
        assert!(toml_detectors.contains("generic_connection_string"));
    }

    #[test]
    fn detector_engine_ignores_nested_structured_placeholders() {
        let engine = DetectorEngine::new();
        let findings = engine.scan_document(&document(
            "/config/app.json",
            concat!(
                "{\n",
                "  \"integrations\": {\n",
                "    \"vendor\": {\n",
                "      \"api\": { \"key\": \"${API_KEY}\" },\n",
                "      \"oauth\": { \"client\": { \"secret\": \"your_client_secret_here\" } },\n",
                "      \"database\": { \"url\": \"postgres://user:password@example.com:5432/app\" }\n",
                "    }\n",
                "  }\n",
                "}\n"
            ),
        ));

        assert!(findings.is_empty());
    }

    #[test]
    fn detector_engine_ignores_placeholder_structured_credentials() {
        let engine = DetectorEngine::new();

        let npm_findings = engine.scan_document(&document(
            "/.npmrc",
            "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
        ));
        assert!(npm_findings.is_empty());

        let pypirc_findings = engine.scan_document(&document(
            "/.pypirc",
            "[pypi]\nusername = __token__\npassword = changeme123\n",
        ));
        assert!(pypirc_findings.is_empty());

        let docker_findings = engine.scan_document(&document(
            "/.docker/config.json",
            r#"{"auths":{"registry.example.test":{"auth":"<redacted>"}}}"#,
        ));
        assert!(docker_findings.is_empty());
    }

    #[test]
    fn detector_engine_ignores_placeholders_and_examples() {
        let engine = DetectorEngine::new();
        let findings = engine.scan_document(&document(
            "/application.yml",
            concat!(
                "API_KEY=your_api_key_here\n",
                "ACCESS_TOKEN=${ACCESS_TOKEN}\n",
                "PASSWORD=changeme123\n",
                "DATABASE_URL=postgres://user:password@example.com:5432/app\n",
                "AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=example;AccountKey=<redacted>;EndpointSuffix=core.windows.net\n"
            ),
        ));

        assert!(findings.is_empty());
    }

    #[test]
    fn detector_engine_prefers_specific_detectors_over_generic_matches() {
        let engine = DetectorEngine::new();
        let findings = engine.scan_document(&document(
            "/.env",
            "OPENAI_API_KEY=sk-proj-1234567890abcdefghijklmnopqrstuv",
        ));

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].detector, "openai_api_key");
    }

    #[test]
    fn detector_engine_prefers_specific_registry_detectors_over_structured_fallbacks() {
        let engine = DetectorEngine::new();
        let findings = engine.scan_document(&document(
            "/.npmrc",
            "//registry.npmjs.org/:_authToken=npm_1234567890abcdefghijklmnopqrstuvwxyz\n",
        ));

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].detector, "npm_access_token");
    }

    #[test]
    fn detector_prefilter_targets_only_relevant_families() {
        let candidates = candidate_detectors(&document(
            "/config.js",
            concat!(
                "const token='github_pat_example'; ",
                "const hook='https://hooks.slack.com/services/T/B/C'; ",
                "const gitlab='glpat-example';"
            ),
        ))
        .into_iter()
        .map(|detector| detector.name)
        .collect::<HashSet<_>>();

        assert!(candidates.contains("github_personal_access_token"));
        assert!(candidates.contains("slack_webhook"));
        assert!(candidates.contains("gitlab_personal_access_token"));
        assert!(!candidates.contains("google_api_key"));
        assert!(!candidates.contains("aws_access_key_id"));
    }

    #[test]
    fn detector_prefilter_uses_path_hints_for_structured_detectors() {
        let candidates = candidate_detectors(&document(
            "/.npmrc",
            "registry=https://registry.npmjs.org/\n_authToken=${NPM_TOKEN}\n",
        ))
        .into_iter()
        .map(|detector| detector.name)
        .collect::<HashSet<_>>();

        assert!(candidates.contains("npm_registry_auth"));
        assert!(!candidates.contains("kubeconfig_embedded_credential"));
    }
}

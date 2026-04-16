use std::process::Command;
use std::str;
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::Client;
use url::Url;

use crate::core::{PublicResourceKind, PublicWorkflowStatus, VerificationMethod};

const HTTP_VERIFICATION_TIMEOUT_SECONDS: u64 = 6;
const HTTP_VERIFICATION_MAX_BYTES: usize = 8 * 1024;
const STANDARD_HTTP_VERIFICATION_PATHS: &[&str] = &[
    "/.well-known/anyscan-verification.txt",
    "/anyscan-verification.txt",
];

#[derive(Debug, Clone)]
pub struct PublicVerificationResult {
    pub status: PublicWorkflowStatus,
    pub summary: String,
    pub verification_attempted_at: Option<DateTime<Utc>>,
    pub verification_completed_at: Option<DateTime<Utc>>,
}

impl PublicVerificationResult {
    fn submitted(summary: impl Into<String>) -> Self {
        Self {
            status: PublicWorkflowStatus::Submitted,
            summary: summary.into(),
            verification_attempted_at: None,
            verification_completed_at: None,
        }
    }

    fn attempted_submitted(summary: impl Into<String>, attempted_at: DateTime<Utc>) -> Self {
        Self {
            status: PublicWorkflowStatus::Submitted,
            summary: summary.into(),
            verification_attempted_at: Some(attempted_at),
            verification_completed_at: None,
        }
    }

    fn verified(summary: impl Into<String>, verified_at: DateTime<Utc>) -> Self {
        Self {
            status: PublicWorkflowStatus::Verified,
            summary: summary.into(),
            verification_attempted_at: Some(verified_at),
            verification_completed_at: Some(verified_at),
        }
    }
}

pub async fn verify_public_resource_control(
    resource_kind: PublicResourceKind,
    resource: &str,
    verification_method: VerificationMethod,
    verification_value: &str,
    requester_email: &str,
) -> PublicVerificationResult {
    match verification_method {
        VerificationMethod::DnsTxt => verify_dns_txt(resource_kind, resource, verification_value).await,
        VerificationMethod::HttpFile => {
            verify_http_file(resource_kind, resource, verification_value).await
        }
        VerificationMethod::Email => PublicVerificationResult::submitted(format!(
            "Email verification is recorded for {requester_email}, but operator review is still required before this request can be marked verified."
        )),
        VerificationMethod::ManualReview => PublicVerificationResult::submitted(
            "Manual review was selected, so no automated verification was attempted.",
        ),
    }
}

async fn verify_dns_txt(
    resource_kind: PublicResourceKind,
    resource: &str,
    verification_value: &str,
) -> PublicVerificationResult {
    if resource_kind != PublicResourceKind::Domain {
        return PublicVerificationResult::submitted(
            "DNS TXT verification is currently supported only for domain resources.",
        );
    }

    let token = verification_value.trim().to_string();
    let attempted_at = Utc::now();
    if token.is_empty() {
        return PublicVerificationResult::attempted_submitted(
            "DNS TXT verification requires a non-empty token.",
            attempted_at,
        );
    }

    let resource_owned = resource.to_string();
    let token_owned = token.clone();
    let lookup_result = tokio::task::spawn_blocking(move || lookup_dns_txt_records(&resource_owned))
        .await;

    let records = match lookup_result {
        Ok(Ok(records)) => records,
        Ok(Err(error)) => {
            return PublicVerificationResult::attempted_submitted(
                format!("DNS TXT verification could not be completed: {error}"),
                attempted_at,
            );
        }
        Err(error) => {
            return PublicVerificationResult::attempted_submitted(
                format!("DNS TXT verification task failed: {error}"),
                attempted_at,
            );
        }
    };

    if records.iter().any(|record| dns_record_matches_token(record, &token_owned)) {
        PublicVerificationResult::verified(
            format!(
                "Verified automatically: a DNS TXT record on {resource} matched the provided token."
            ),
            attempted_at,
        )
    } else {
        PublicVerificationResult::attempted_submitted(
            format!(
                "No DNS TXT record on {resource} matched the provided token. You can retry later or request manual review."
            ),
            attempted_at,
        )
    }
}

async fn verify_http_file(
    resource_kind: PublicResourceKind,
    resource: &str,
    verification_value: &str,
) -> PublicVerificationResult {
    if resource_kind == PublicResourceKind::Cidr {
        return PublicVerificationResult::submitted(
            "HTTP file verification is not supported for CIDR resources. Use manual review instead.",
        );
    }

    let token = verification_value.trim();
    let attempted_at = Utc::now();
    if token.is_empty() {
        return PublicVerificationResult::attempted_submitted(
            "HTTP file verification requires a non-empty token.",
            attempted_at,
        );
    }

    if verification_value.trim_start().starts_with("http://")
        || verification_value.trim_start().starts_with("https://")
    {
        return PublicVerificationResult::attempted_submitted(
            "HTTP file verification expects a token value. Publish that token at /.well-known/anyscan-verification.txt on the claimed host and resubmit.",
            attempted_at,
        );
    }

    let candidate_urls = http_verification_candidate_urls(resource_kind, resource);
    if candidate_urls.is_empty() {
        return PublicVerificationResult::attempted_submitted(
            "HTTP file verification could not derive a valid host for the claimed resource.",
            attempted_at,
        );
    }

    let client = match Client::builder()
        .user_agent("AnyScan verification/0.1")
        .timeout(Duration::from_secs(HTTP_VERIFICATION_TIMEOUT_SECONDS))
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return PublicVerificationResult::attempted_submitted(
                format!("HTTP file verification could not initialize the HTTP client: {error}"),
                attempted_at,
            );
        }
    };

    for candidate_url in candidate_urls {
        let response = match client.get(candidate_url.as_str()).send().await {
            Ok(response) => response,
            Err(_) => continue,
        };
        if !response.status().is_success() {
            continue;
        }
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let bytes = if bytes.len() > HTTP_VERIFICATION_MAX_BYTES {
            &bytes[..HTTP_VERIFICATION_MAX_BYTES]
        } else {
            &bytes[..]
        };
        let body = String::from_utf8_lossy(bytes);
        if body_contains_token(&body, token) {
            return PublicVerificationResult::verified(
                format!(
                    "Verified automatically: the provided token was found at {}.",
                    candidate_url
                ),
                attempted_at,
            );
        }
    }

    PublicVerificationResult::attempted_submitted(
        format!(
            "No verification token was found at the standard AnyScan HTTP verification paths for {resource}. Publish the token at /.well-known/anyscan-verification.txt and retry."
        ),
        attempted_at,
    )
}

fn lookup_dns_txt_records(resource: &str) -> Result<Vec<String>, String> {
    let output = Command::new("/usr/bin/dig")
        .args(["+short", "TXT", resource])
        .output()
        .map_err(|error| format!("failed to execute dig: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("dig exited with status {}", output.status)
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let records = stdout
        .lines()
        .map(parse_dig_txt_output_line)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    Ok(records)
}

fn parse_dig_txt_output_line(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if !trimmed.contains('"') {
        return trimmed.to_string();
    }

    let mut current = String::new();
    let mut in_quotes = false;
    for ch in trimmed.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            _ if in_quotes => current.push(ch),
            _ => {}
        }
    }
    current
}

fn dns_record_matches_token(record: &str, token: &str) -> bool {
    let normalized_record = record.trim();
    let normalized_token = token.trim();
    normalized_record == normalized_token || normalized_record.contains(normalized_token)
}

fn http_verification_candidate_urls(
    resource_kind: PublicResourceKind,
    resource: &str,
) -> Vec<Url> {
    let host = match resource_kind {
        PublicResourceKind::Domain | PublicResourceKind::Ip => resource.trim(),
        PublicResourceKind::Cidr => return Vec::new(),
    };
    if host.is_empty() {
        return Vec::new();
    }

    let mut urls = Vec::new();
    for scheme in ["https", "http"] {
        for path in STANDARD_HTTP_VERIFICATION_PATHS {
            if let Ok(url) = Url::parse(&format!("{scheme}://{host}{path}")) {
                urls.push(url);
            }
        }
    }
    urls
}

fn body_contains_token(body: &str, token: &str) -> bool {
    let trimmed_body = body.trim();
    let trimmed_token = token.trim();
    trimmed_body == trimmed_token || trimmed_body.contains(trimmed_token)
}

#[cfg(test)]
mod tests {
    use super::{
        body_contains_token, dns_record_matches_token, http_verification_candidate_urls,
        parse_dig_txt_output_line,
    };
    use crate::core::PublicResourceKind;

    #[test]
    fn parse_dig_txt_output_line_concatenates_quoted_segments() {
        assert_eq!(
            parse_dig_txt_output_line("\"anyscan-\" \"token-123\""),
            "anyscan-token-123"
        );
    }

    #[test]
    fn dns_record_matching_accepts_exact_and_contained_tokens() {
        assert!(dns_record_matches_token("token-123", "token-123"));
        assert!(dns_record_matches_token("anyscan-verification=token-123", "token-123"));
        assert!(!dns_record_matches_token("token-999", "token-123"));
    }

    #[test]
    fn http_candidate_urls_use_standard_anyscan_paths() {
        let urls = http_verification_candidate_urls(PublicResourceKind::Domain, "example.com");
        let rendered = urls.iter().map(|url| url.as_str().to_string()).collect::<Vec<_>>();
        assert!(rendered.contains(&"https://example.com/.well-known/anyscan-verification.txt".to_string()));
        assert!(rendered.contains(&"http://example.com/anyscan-verification.txt".to_string()));
    }

    #[test]
    fn http_body_match_looks_for_token() {
        assert!(body_contains_token("token-123", "token-123"));
        assert!(body_contains_token("proof token-123 here", "token-123"));
        assert!(!body_contains_token("proof token-999 here", "token-123"));
    }
}

use std::{
    cmp::Ordering,
    collections::{BinaryHeap, HashMap, HashSet},
    env,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
    config::{
        resolve_scan_proxy_url, AppConfig, GobusterConfig, InventoryConfig, ProxyMode, ScanConfig,
    },
    core::{
        merge_coverage_source_stat, merge_coverage_source_stats, normalize_request_profile_name,
        sanitize_paths, sort_coverage_source_stats, FetchTelemetry, GobusterTargetConfig,
        TargetRecord,
    },
};
use anyhow::{anyhow, Context, Result};
use futures::stream::{FuturesUnordered, StreamExt};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::{header, redirect, Client, Proxy, RequestBuilder};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    sync::{Mutex, OwnedSemaphorePermit, Semaphore},
    time::Instant,
};
use url::Url;

#[derive(Debug, Clone)]
pub struct FetchedDocument {
    pub path: String,
    pub url: String,
    pub status: u16,
    pub content_type: Option<String>,
    pub body: String,
    pub truncated: bool,
    pub coverage_source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredPath {
    pub path: String,
    pub source: String,
    pub score: u16,
    pub depth: u8,
}

#[derive(Debug, Clone, Default)]
pub struct TargetFetchReport {
    pub documents: Vec<FetchedDocument>,
    pub discovered_paths: Vec<DiscoveredPath>,
    pub telemetry: FetchTelemetry,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Fetcher {
    direct_client: Client,
    proxy_client: Option<Client>,
    inventory: InventoryConfig,
    scan: ScanConfig,
    gobuster: GobusterConfig,
    host_throttles: Arc<HostThrottleRegistry>,
}

#[derive(Debug, Default)]
struct HostThrottleRegistry {
    entries: Mutex<HashMap<String, Arc<HostThrottle>>>,
}

#[derive(Debug)]
struct HostThrottle {
    permits: Arc<Semaphore>,
    backoff: Mutex<HostBackoffState>,
    initial_backoff: Duration,
    max_backoff: Duration,
}

#[derive(Debug, Default)]
struct HostBackoffState {
    consecutive_slowdowns: u32,
    next_allowed_at: Option<Instant>,
}

#[derive(Debug, Clone)]
struct ResponseSnapshot {
    document: FetchedDocument,
    textual: bool,
    similarity_key: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct ResponseBaseline {
    status: u16,
    body_len: usize,
}

#[derive(Debug)]
struct FetchPathOutcome {
    path: String,
    telemetry: FetchTelemetry,
    result: Result<ResponseSnapshot>,
}

#[derive(Debug, Clone, Default)]
struct ResolvedRequestProfile {
    headers: Vec<(String, String)>,
    cookie_header: Option<String>,
    bearer_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DiscoveryPathCandidate {
    path: String,
    source: &'static str,
    score: u16,
    depth: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InitialPathCandidate {
    path: String,
    priority: u16,
    depth: u8,
    source: String,
}

impl DiscoveryPathCandidate {
    fn to_report_entry(&self) -> DiscoveredPath {
        DiscoveredPath {
            path: self.path.clone(),
            source: self.source.to_string(),
            score: self.score,
            depth: self.depth,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ScheduledPath {
    path: String,
    priority: u16,
    depth: u8,
    source: String,
    sequence: u64,
}

impl Ord for ScheduledPath {
    fn cmp(&self, other: &Self) -> Ordering {
        self.priority
            .cmp(&other.priority)
            .then_with(|| other.sequence.cmp(&self.sequence))
    }
}

impl PartialOrd for ScheduledPath {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DiscoveryHint {
    path: String,
    source: &'static str,
    score: u16,
}

static HTML_ATTRIBUTE_DISCOVERY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new("(?i)(?:src|href|content)\\s*=\\s*[\"']([^\"'#]+)[\"']")
        .expect("html attribute discovery regex should compile")
});
static SOURCE_MAP_DISCOVERY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        "(?im)(?:^|\\s)(?://[#@]\\s*sourceMappingURL=|/\\*[#@]\\s*sourceMappingURL=)([^\\s*]+)",
    )
    .expect("source map discovery regex should compile")
});
static QUOTED_PATH_DISCOVERY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        "(?i)[\"']([^\"']+(?:\\.(?:js|map|json|txt|xml|ya?ml|webmanifest|env)|/(?:openapi\\.json|swagger\\.json|v2/api-docs|runtime-config(?:\\.json|\\.js)?|config(?:\\.json|\\.js|\\.ya?ml)?|settings(?:\\.json|\\.js)?|asset-manifest\\.json))[^\"']*)[\"']",
    )
    .expect("quoted path discovery regex should compile")
});
static XML_LOC_DISCOVERY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new("(?is)<loc>\\s*([^<]+?)\\s*</loc>").expect("xml loc discovery regex should compile")
});

const AUTHORITATIVE_DISCOVERY_MIN_COVERAGE_SCORE: u16 = 560;
const MAX_OPENAPI_ROUTE_CANDIDATES: usize = 24;
const MAX_ADAPTIVE_PREFIXES: usize = 6;
const MAX_ADAPTIVE_CANDIDATES: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiscoveryNormalizationPolicy {
    Default,
    Authoritative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FetchTransport {
    Direct,
    Proxy,
}

impl FetchTransport {
    fn as_str(&self) -> &'static str {
        match self {
            FetchTransport::Direct => "direct",
            FetchTransport::Proxy => "proxy",
        }
    }
}

impl Fetcher {
    pub fn new(config: &AppConfig) -> Result<Self> {
        let direct_client = build_http_client(&config.scan, None)
            .context("failed to build direct reqwest client")?;
        let resolved_proxy_url = if matches!(config.scan.proxy_mode, ProxyMode::DirectOnly) {
            None
        } else {
            resolve_scan_proxy_url(&config.scan)
        };
        let proxy_client = resolved_proxy_url
            .as_deref()
            .map(|proxy_url| {
                build_http_client(&config.scan, Some(proxy_url)).with_context(|| {
                    format!("failed to build proxied reqwest client for {proxy_url}")
                })
            })
            .transpose()?;

        if matches!(config.scan.proxy_mode, ProxyMode::ProxyOnly) && proxy_client.is_none() {
            return Err(anyhow!(
                "scan.proxy_mode proxy_only requires scan.proxy_url or HTTP_PROXY/HTTPS_PROXY/ALL_PROXY"
            ));
        }

        Ok(Self {
            direct_client,
            proxy_client,
            inventory: config.inventory.clone(),
            scan: config.scan.clone(),
            gobuster: config.scan.gobuster.clone(),
            host_throttles: Arc::new(HostThrottleRegistry::default()),
        })
    }

    fn initial_target_candidates(&self, target: &TargetRecord) -> Vec<InitialPathCandidate> {
        let mut candidates: Vec<InitialPathCandidate> = Vec::new();
        let mut seen = HashMap::new();
        let has_explicit_paths = !target.paths.is_empty();
        let paths = sanitize_paths(if has_explicit_paths {
            &target.paths
        } else {
            &self.inventory.default_paths
        });

        for path in paths {
            let priority = seed_candidate_priority(&path, has_explicit_paths, None);
            push_initial_target_candidate(
                &mut candidates,
                &mut seen,
                path,
                priority,
                "target-seed".to_string(),
            );
        }

        if target.strategy.uses_persisted_discovery() {
            for (path, score, source) in self.persisted_discovery_seed_paths(target) {
                let priority = seed_candidate_priority(&path, false, Some(score));
                push_initial_target_candidate(&mut candidates, &mut seen, path, priority, source);
            }
        }

        let gobuster = self.effective_gobuster_config(target);
        for (path, score, source) in self.gobuster_seed_paths(&gobuster) {
            let priority = seed_candidate_priority(&path, false, Some(score));
            push_initial_target_candidate(&mut candidates, &mut seen, path, priority, source);
        }

        candidates.sort_by(|left, right| right.priority.cmp(&left.priority));
        candidates
    }

    fn persisted_discovery_seed_paths(&self, target: &TargetRecord) -> Vec<(String, u16, String)> {
        let mut discovered_paths = target
            .discovery_provenance
            .iter()
            .map(|entry| {
                (
                    entry.path.clone(),
                    entry.score,
                    entry.depth,
                    persisted_coverage_source(&entry.source),
                )
            })
            .collect::<Vec<_>>();
        discovered_paths.sort_by(|left, right| {
            right
                .1
                .cmp(&left.1)
                .then_with(|| left.2.cmp(&right.2))
                .then_with(|| left.0.cmp(&right.0))
        });

        let mut seed_paths = Vec::new();
        for (path, score, _, source) in discovered_paths {
            if !seed_paths
                .iter()
                .any(|(existing_path, _, _)| existing_path == &path)
            {
                seed_paths.push((path, score, source));
            }
        }
        seed_paths
    }

    fn effective_gobuster_config(&self, target: &TargetRecord) -> GobusterConfig {
        merge_gobuster_target_config(&self.gobuster, &target.gobuster)
    }

    fn gobuster_seed_paths(&self, gobuster: &GobusterConfig) -> Vec<(String, u16, String)> {
        if !gobuster.enabled {
            return Vec::new();
        }

        let mut candidates: Vec<(String, u16, String)> = Vec::new();
        let mut seen = HashSet::new();
        let mut push_candidate = |path: String, score: u16, source: &str| {
            let sanitized = sanitize_paths(&[path]).into_iter().next();
            let Some(path) = sanitized else {
                return;
            };
            if !seen.insert(path.clone()) {
                return;
            }
            candidates.push((path, score, source.to_string()));
        };

        for word in &gobuster.wordlist {
            for candidate in build_gobuster_word_candidates(word, gobuster) {
                push_candidate(candidate.path, candidate.score, candidate.source);
            }
        }

        candidates.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
        candidates.truncate(gobuster.max_candidates_per_target.max(1));
        candidates
    }

    pub async fn fetch_target(&self, target: &TargetRecord) -> Result<TargetFetchReport> {
        self.ensure_target_allowed(target)?;
        let request_profile = Arc::new(self.resolve_request_profile(target)?);
        let effective_gobuster = self.effective_gobuster_config(target);
        let base_url = Url::parse(&target.base_url)
            .with_context(|| format!("invalid target URL {}", target.base_url))?;

        let mut report = TargetFetchReport::default();
        let max_paths_per_target = self.scan.max_paths_per_target.max(1);
        let max_parallel_paths_per_target = self
            .scan
            .max_parallel_paths_per_target
            .max(1)
            .min(max_paths_per_target);
        let initial_candidates = self.initial_target_candidates(target);
        let mut pending_paths = BinaryHeap::new();
        let mut scheduled_paths = HashSet::new();
        let mut scheduled_discovered_paths = 0usize;
        let mut next_sequence = 0u64;
        for candidate in initial_candidates {
            if enqueue_frontier_path(
                &mut pending_paths,
                &mut scheduled_paths,
                candidate.path,
                candidate.priority,
                candidate.depth,
                candidate.source.clone(),
                &mut next_sequence,
            ) {
                merge_coverage_source_stat(
                    &mut report.telemetry.coverage_sources,
                    &candidate.source,
                    1,
                    0,
                    0,
                    0,
                    0,
                );
            }
        }

        let control_probe_path = build_control_probe_path(target);
        let control_baseline = self
            .fetch_path(
                base_url.clone(),
                control_probe_path.clone(),
                true,
                String::new(),
                Arc::clone(&request_profile),
            )
            .await;
        merge_fetch_telemetry(&mut report.telemetry, &control_baseline.telemetry);
        let (control_similarity_key, control_baseline_signature) = match control_baseline.result {
            Ok(snapshot) => (
                snapshot.similarity_key.clone(),
                Some(ResponseBaseline {
                    status: snapshot.document.status,
                    body_len: snapshot.document.body.len(),
                }),
            ),
            Err(error) => {
                report
                    .errors
                    .push(format!("control probe {}: {error}", control_probe_path));
                (None, None)
            }
        };

        let mut seen_responses = HashSet::new();
        let mut completed_paths = 0usize;
        let mut in_flight = FuturesUnordered::new();

        loop {
            while in_flight.len() < max_parallel_paths_per_target
                && completed_paths + in_flight.len() < max_paths_per_target
            {
                let Some(scheduled) = pending_paths.pop() else {
                    break;
                };
                let path_depth = scheduled.depth;
                let coverage_source = scheduled.source.clone();
                let fetcher = self.clone();
                let base_url = base_url.clone();
                let request_profile = Arc::clone(&request_profile);
                in_flight.push(async move {
                    (
                        path_depth,
                        fetcher
                            .fetch_path(
                                base_url,
                                scheduled.path,
                                false,
                                coverage_source,
                                request_profile,
                            )
                            .await,
                    )
                });
            }

            let Some((path_depth, outcome)) = in_flight.next().await else {
                break;
            };
            completed_paths += 1;
            merge_fetch_telemetry(&mut report.telemetry, &outcome.telemetry);

            match outcome.result {
                Ok(snapshot) => {
                    if !snapshot.textual {
                        continue;
                    }

                    if let (Some(control_key), Some(response_key)) = (
                        control_similarity_key.as_deref(),
                        snapshot.similarity_key.as_deref(),
                    ) {
                        if response_key == control_key {
                            report.telemetry.control_match_responses += 1;
                            continue;
                        }
                    }

                    let dedupe_key = snapshot.similarity_key.clone().unwrap_or_else(|| {
                        response_similarity_key(&snapshot.document.body, &snapshot.document.path)
                    });
                    if !seen_responses.insert(dedupe_key) {
                        report.telemetry.duplicate_responses += 1;
                        continue;
                    }

                    if is_gobuster_coverage_source(&snapshot.document.coverage_source)
                        && !should_keep_gobuster_response(
                            &effective_gobuster,
                            control_baseline_signature,
                            &snapshot,
                        )
                    {
                        report.telemetry.control_match_responses += 1;
                        continue;
                    }

                    if self.scan.enable_path_discovery
                        && target.strategy.allows_live_discovery()
                        && scheduled_discovered_paths < self.scan.max_discovered_paths_per_target
                    {
                        for discovered_path in discover_candidate_path_candidates(
                            &base_url,
                            &snapshot.document.path,
                            path_depth,
                            &snapshot.document.body,
                        ) {
                            if scheduled_discovered_paths
                                >= self.scan.max_discovered_paths_per_target
                            {
                                break;
                            }
                            if enqueue_frontier_path(
                                &mut pending_paths,
                                &mut scheduled_paths,
                                discovered_path.path.clone(),
                                discovered_path.score,
                                discovered_path.depth,
                                discovered_path.source.to_string(),
                                &mut next_sequence,
                            ) {
                                merge_coverage_source_stat(
                                    &mut report.telemetry.coverage_sources,
                                    discovered_path.source,
                                    1,
                                    0,
                                    0,
                                    1,
                                    0,
                                );
                                report
                                    .discovered_paths
                                    .push(discovered_path.to_report_entry());
                                scheduled_discovered_paths += 1;
                            }
                        }
                    }

                    merge_coverage_source_stat(
                        &mut report.telemetry.coverage_sources,
                        &snapshot.document.coverage_source,
                        0,
                        0,
                        1,
                        0,
                        0,
                    );
                    report.telemetry.documents_scanned += 1;
                    report.documents.push(snapshot.document);
                }
                Err(error) => {
                    report
                        .errors
                        .push(format!("{}{}: {error}", target.base_url, outcome.path));
                }
            }
        }

        report.discovered_paths.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.depth.cmp(&right.depth))
                .then_with(|| left.path.cmp(&right.path))
        });

        sort_coverage_source_stats(&mut report.telemetry.coverage_sources);

        Ok(report)
    }

    async fn fetch_path(
        &self,
        base_url: Url,
        path: String,
        is_control_request: bool,
        coverage_source: String,
        request_profile: Arc<ResolvedRequestProfile>,
    ) -> FetchPathOutcome {
        let mut telemetry = FetchTelemetry {
            request_count: 0,
            control_requests: if is_control_request { 1 } else { 0 },
            ..FetchTelemetry::default()
        };
        if !is_control_request {
            merge_coverage_source_stat(
                &mut telemetry.coverage_sources,
                &coverage_source,
                0,
                1,
                0,
                0,
                0,
            );
        }

        let result: Result<ResponseSnapshot> = async {
            let relative = path.trim_start_matches('/');
            let url = base_url
                .join(relative)
                .with_context(|| format!("failed to join path {path} to {base_url}"))?;
            let host_throttle = self.host_throttle_for_url(&url).await;
            let _host_permit = host_throttle.acquire().await?;
            host_throttle.wait_until_ready().await;

            let transports = self.transport_attempts();
            if transports.is_empty() {
                return Err(anyhow!(
                    "no fetch transport is available for proxy mode {}",
                    self.scan.proxy_mode.as_str()
                ));
            }

            let mut errors = Vec::new();
            for transport in transports {
                let Some(client) = self.client_for_transport(transport) else {
                    continue;
                };
                telemetry.request_count += 1;

                let request = apply_request_profile(client.get(url.clone()), &request_profile);
                let mut response = match request.send().await {
                    Ok(response) => response,
                    Err(error) => {
                        host_throttle.record_transport_error().await;
                        telemetry.request_error_count += 1;
                        errors.push(format!(
                            "{} transport request failed for {}: {}",
                            transport.as_str(),
                            url,
                            error
                        ));
                        continue;
                    }
                };

                let status = response.status().as_u16();
                host_throttle.record_status(status).await;
                let content_type = response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .map(|value| value.to_string());
                let (body, truncated) =
                    match read_response_body(&mut response, self.scan.max_response_bytes).await {
                        Ok(result) => result,
                        Err(error) => {
                            host_throttle.record_transport_error().await;
                            telemetry.request_error_count += 1;
                            errors.push(format!(
                                "{} transport failed reading {}: {}",
                                transport.as_str(),
                                url,
                                error
                            ));
                            continue;
                        }
                    };
                if truncated {
                    telemetry.truncated_responses += 1;
                }

                let textual = is_textual_response(content_type.as_deref(), &body);
                if !textual {
                    telemetry.non_text_responses += 1;
                }

                let similarity_key = textual.then(|| response_similarity_key(&body, &path));

                return Ok(ResponseSnapshot {
                    document: FetchedDocument {
                        path: path.clone(),
                        url: url.to_string(),
                        status,
                        content_type: content_type.clone(),
                        body,
                        truncated,
                        coverage_source: coverage_source.clone(),
                    },
                    textual,
                    similarity_key,
                });
            }

            Err(anyhow!(if errors.is_empty() {
                format!("request failed for {}", url)
            } else {
                errors.join("; ")
            }))
        }
        .await;

        FetchPathOutcome {
            path,
            telemetry,
            result,
        }
    }

    fn transport_attempts(&self) -> Vec<FetchTransport> {
        match self.scan.proxy_mode {
            ProxyMode::DirectOnly => vec![FetchTransport::Direct],
            ProxyMode::PreferProxy => {
                if self.proxy_client.is_some() {
                    vec![FetchTransport::Proxy]
                } else {
                    vec![FetchTransport::Direct]
                }
            }
            ProxyMode::ProxyOnly => self
                .proxy_client
                .as_ref()
                .map(|_| vec![FetchTransport::Proxy])
                .unwrap_or_default(),
            ProxyMode::ProxyThenDirect => {
                if self.proxy_client.is_some() {
                    vec![FetchTransport::Proxy, FetchTransport::Direct]
                } else {
                    vec![FetchTransport::Direct]
                }
            }
            ProxyMode::DirectThenProxy => {
                if self.proxy_client.is_some() {
                    vec![FetchTransport::Direct, FetchTransport::Proxy]
                } else {
                    vec![FetchTransport::Direct]
                }
            }
        }
    }

    fn client_for_transport(&self, transport: FetchTransport) -> Option<&Client> {
        match transport {
            FetchTransport::Direct => Some(&self.direct_client),
            FetchTransport::Proxy => self.proxy_client.as_ref(),
        }
    }

    async fn host_throttle_for_url(&self, url: &Url) -> Arc<HostThrottle> {
        let key = host_throttle_key(url);
        let mut entries = self.host_throttles.entries.lock().await;
        Arc::clone(entries.entry(key).or_insert_with(|| {
            Arc::new(HostThrottle::new(
                self.scan.max_concurrent_requests_per_host,
                Duration::from_millis(self.scan.host_backoff_initial_ms),
                Duration::from_millis(self.scan.host_backoff_max_ms),
            ))
        }))
    }

    fn resolve_request_profile(&self, target: &TargetRecord) -> Result<ResolvedRequestProfile> {
        let Some(profile_name) = normalize_request_profile_name(target.request_profile.clone())
        else {
            return Ok(ResolvedRequestProfile::default());
        };
        if !self.scan.allow_authenticated_request_profiles {
            return Err(anyhow!(
                "target {} references request_profile {}, but authenticated request profiles are disabled",
                target.label,
                profile_name
            ));
        }
        let profile = self
            .inventory
            .request_profile(&profile_name)
            .ok_or_else(|| {
                anyhow!(
                    "target {} references unknown request_profile {}",
                    target.label,
                    profile_name
                )
            })?;

        let mut resolved = ResolvedRequestProfile::default();

        for header_ref in &profile.headers {
            header::HeaderName::from_bytes(header_ref.name.as_bytes()).with_context(|| {
                format!(
                    "request profile {} header {} is not a valid HTTP header name",
                    profile.name, header_ref.name
                )
            })?;
            let value = resolve_request_profile_secret(
                &profile.name,
                "header",
                &header_ref.name,
                &header_ref.env,
            )?;
            header::HeaderValue::from_str(&value).with_context(|| {
                format!(
                    "request profile {} header {} resolved from {} is not a valid header value",
                    profile.name, header_ref.name, header_ref.env
                )
            })?;
            resolved.headers.push((header_ref.name.clone(), value));
        }

        if !profile.cookies.is_empty() {
            let mut cookie_pairs = Vec::new();
            for cookie_ref in &profile.cookies {
                let value = resolve_request_profile_secret(
                    &profile.name,
                    "cookie",
                    &cookie_ref.name,
                    &cookie_ref.env,
                )?;
                if value.contains(['\r', '\n']) {
                    return Err(anyhow!(
                        "request profile {} cookie {} resolved from {} contains invalid control characters",
                        profile.name,
                        cookie_ref.name,
                        cookie_ref.env
                    ));
                }
                cookie_pairs.push(format!("{}={}", cookie_ref.name, value));
            }
            let cookie_header = cookie_pairs.join("; ");
            header::HeaderValue::from_str(&cookie_header).with_context(|| {
                format!(
                    "request profile {} cookies resolved from env references are not valid for the Cookie header",
                    profile.name
                )
            })?;
            resolved.cookie_header = Some(cookie_header);
        }

        if let Some(token_env) = profile.bearer_token_env.as_deref() {
            let token = resolve_request_profile_secret(
                &profile.name,
                "bearer token",
                "authorization",
                token_env,
            )?;
            header::HeaderValue::from_str(&format!("Bearer {token}")).with_context(|| {
                format!(
                    "request profile {} bearer token resolved from {} is not a valid Authorization header value",
                    profile.name, token_env
                )
            })?;
            resolved.bearer_token = Some(token);
        }

        Ok(resolved)
    }

    fn ensure_target_allowed(&self, target: &TargetRecord) -> Result<()> {
        let url = Url::parse(&target.base_url)
            .with_context(|| format!("invalid target URL {}", target.base_url))?;
        if !self.inventory.url_is_allowed(&url) {
            return Err(anyhow!(
                "target {} is outside configured inventory host and port allowlists",
                target.base_url
            ));
        }

        Ok(())
    }
}

fn build_http_client(scan: &ScanConfig, proxy_url: Option<&str>) -> Result<Client> {
    let mut builder = Client::builder()
        .danger_accept_invalid_certs(scan.allow_invalid_tls)
        .redirect(redirect::Policy::none())
        .timeout(Duration::from_secs(scan.request_timeout_secs))
        .user_agent(scan.user_agent.clone())
        .no_proxy();

    if let Some(proxy_url) = proxy_url {
        builder = builder.proxy(
            Proxy::all(proxy_url).with_context(|| format!("invalid scan proxy URL {proxy_url}"))?,
        );
    }

    builder.build().context("failed to build reqwest client")
}

fn apply_request_profile(
    mut request: RequestBuilder,
    request_profile: &ResolvedRequestProfile,
) -> RequestBuilder {
    for (name, value) in &request_profile.headers {
        request = request.header(name, value);
    }
    if let Some(cookie_header) = &request_profile.cookie_header {
        request = request.header(header::COOKIE, cookie_header);
    }
    if let Some(token) = &request_profile.bearer_token {
        request = request.bearer_auth(token);
    }
    request
}

impl HostThrottle {
    fn new(
        max_concurrent_requests: usize,
        initial_backoff: Duration,
        max_backoff: Duration,
    ) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(max_concurrent_requests.max(1))),
            backoff: Mutex::new(HostBackoffState::default()),
            initial_backoff,
            max_backoff,
        }
    }

    async fn acquire(&self) -> Result<OwnedSemaphorePermit> {
        self.permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| anyhow!("host request limiter unexpectedly closed"))
    }

    async fn wait_until_ready(&self) {
        loop {
            let next_allowed_at = {
                let mut backoff = self.backoff.lock().await;
                match backoff.next_allowed_at {
                    Some(deadline) if deadline > Instant::now() => Some(deadline),
                    Some(_) => {
                        backoff.next_allowed_at = None;
                        None
                    }
                    None => None,
                }
            };
            let Some(deadline) = next_allowed_at else {
                return;
            };
            tokio::time::sleep_until(deadline).await;
        }
    }

    async fn record_transport_error(&self) {
        self.schedule_backoff().await;
    }

    async fn record_status(&self, status: u16) {
        if status_requires_host_backoff(status) {
            self.schedule_backoff().await;
            return;
        }

        let mut backoff = self.backoff.lock().await;
        backoff.consecutive_slowdowns = 0;
        if !backoff
            .next_allowed_at
            .map(|deadline| deadline > Instant::now())
            .unwrap_or(false)
        {
            backoff.next_allowed_at = None;
        }
    }

    async fn schedule_backoff(&self) {
        let mut backoff = self.backoff.lock().await;
        backoff.consecutive_slowdowns = backoff.consecutive_slowdowns.saturating_add(1);
        let delay = exponential_backoff_delay(
            self.initial_backoff,
            self.max_backoff,
            backoff.consecutive_slowdowns,
        );
        let now = Instant::now();
        let baseline = backoff
            .next_allowed_at
            .filter(|deadline| *deadline > now)
            .unwrap_or(now);
        backoff.next_allowed_at = Some(baseline + delay);
    }
}

fn host_throttle_key(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let port = url.port_or_known_default().unwrap_or_default();
    format!("{}://{}:{}", url.scheme(), host, port)
}

fn status_requires_host_backoff(status: u16) -> bool {
    status == 408 || status == 425 || status == 429 || matches!(status, 500 | 502 | 503 | 504)
}

fn exponential_backoff_delay(initial: Duration, max: Duration, attempt: u32) -> Duration {
    if attempt <= 1 {
        return initial;
    }

    let cap = max.max(initial);
    let multiplier = 1u128 << attempt.saturating_sub(1).min(10);
    let delay_ms = initial
        .as_millis()
        .saturating_mul(multiplier)
        .min(cap.as_millis());
    Duration::from_millis(delay_ms as u64)
}

fn merge_fetch_telemetry(target: &mut FetchTelemetry, delta: &FetchTelemetry) {
    target.request_count += delta.request_count;
    target.control_requests += delta.control_requests;
    target.documents_scanned += delta.documents_scanned;
    target.non_text_responses += delta.non_text_responses;
    target.truncated_responses += delta.truncated_responses;
    target.duplicate_responses += delta.duplicate_responses;
    target.control_match_responses += delta.control_match_responses;
    target.request_error_count += delta.request_error_count;
    merge_coverage_source_stats(&mut target.coverage_sources, &delta.coverage_sources);
    sort_coverage_source_stats(&mut target.coverage_sources);
}

fn resolve_request_profile_secret(
    profile_name: &str,
    kind: &str,
    item_name: &str,
    env_name: &str,
) -> Result<String> {
    let value = env::var(env_name).with_context(|| {
        format!(
            "request profile {} {} {} requires env {}",
            profile_name, kind, item_name, env_name
        )
    })?;
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        return Err(anyhow!(
            "request profile {} {} {} resolved from {} is empty",
            profile_name,
            kind,
            item_name,
            env_name
        ));
    }
    Ok(trimmed)
}

fn build_control_probe_path(target: &TargetRecord) -> String {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "/.well-known/anyscan-control-{}-{}-{nonce}.txt",
        target.id.max(0),
        target.paths.len()
    )
}

fn enqueue_frontier_path(
    pending_paths: &mut BinaryHeap<ScheduledPath>,
    scheduled_paths: &mut HashSet<String>,
    path: String,
    priority: u16,
    depth: u8,
    source: String,
    next_sequence: &mut u64,
) -> bool {
    if !scheduled_paths.insert(path.clone()) {
        return false;
    }

    let sequence = *next_sequence;
    *next_sequence = next_sequence.saturating_add(1);
    pending_paths.push(ScheduledPath {
        path,
        priority,
        depth,
        source,
        sequence,
    });
    true
}

fn push_initial_target_candidate(
    candidates: &mut Vec<InitialPathCandidate>,
    seen: &mut HashMap<String, usize>,
    path: String,
    priority: u16,
    source: String,
) {
    if let Some(index) = seen.get(&path).copied() {
        if priority > candidates[index].priority {
            candidates[index].priority = priority;
            candidates[index].source = source;
        }
        return;
    }

    let index = candidates.len();
    seen.insert(path.clone(), index);
    candidates.push(InitialPathCandidate {
        path,
        priority,
        depth: 0,
        source,
    });
}

fn persisted_coverage_source(source: &str) -> String {
    let source = source.trim();
    if source.is_empty() {
        return "persisted-discovery".to_string();
    }
    if source.starts_with("persisted-") {
        return source.to_string();
    }
    format!("persisted-{source}")
}

#[derive(Debug, Clone)]
struct GobusterSeedCandidate {
    path: String,
    source: &'static str,
    score: u16,
}

const GOBUSTER_BACKUP_SUFFIXES: &[&str] = &["~", ".bak", ".old", ".1", ".orig"];

fn push_gobuster_candidate(
    candidates: &mut Vec<GobusterSeedCandidate>,
    candidate: String,
    source: &'static str,
) {
    let sanitized = sanitize_paths(&[candidate]).into_iter().next();
    let Some(path) = sanitized else {
        return;
    };
    let score = gobuster_candidate_score(&path, source);
    if let Some(existing) = candidates.iter_mut().find(|existing| existing.path == path) {
        if score > existing.score {
            existing.score = score;
            existing.source = source;
        }
        return;
    }
    candidates.push(GobusterSeedCandidate {
        path,
        source,
        score,
    });
}

fn build_gobuster_word_candidates(
    word: &str,
    config: &GobusterConfig,
) -> Vec<GobusterSeedCandidate> {
    let token = word.trim();
    if token.is_empty() {
        return Vec::new();
    }

    let mut candidates: Vec<GobusterSeedCandidate> = Vec::new();

    let base_candidate = if token.starts_with('/') {
        token.to_string()
    } else {
        format!("/{token}")
    };
    push_gobuster_candidate(&mut candidates, base_candidate, "gobuster-wordlist");

    for pattern in &config.patterns {
        let rendered = pattern.replace("{GOBUSTER}", token);
        if !rendered.trim().is_empty() {
            let candidate = if rendered.starts_with('/') {
                rendered
            } else {
                format!("/{rendered}")
            };
            push_gobuster_candidate(&mut candidates, candidate, "gobuster-pattern");
        }
    }

    let explicit_candidates = candidates
        .iter()
        .map(|candidate| candidate.path.clone())
        .collect::<Vec<_>>();

    if config.add_slash {
        for path in &explicit_candidates {
            if should_add_gobuster_slash(path) {
                push_gobuster_candidate(
                    &mut candidates,
                    format!("{}/", path.trim_end_matches('/')),
                    "gobuster-add-slash",
                );
            }
        }
    }

    if !config.extensions.is_empty() {
        for path in &explicit_candidates {
            if !gobuster_candidate_supports_extensions(path) {
                continue;
            }
            for extension in &config.extensions {
                push_gobuster_candidate(
                    &mut candidates,
                    format!(
                        "{}.{}",
                        path.trim_end_matches('/'),
                        extension.trim_start_matches('.')
                    ),
                    "gobuster-extension",
                );
            }
        }
    }

    if config.discover_backup {
        let backup_seeds = candidates
            .iter()
            .map(|candidate| candidate.path.clone())
            .collect::<Vec<_>>();
        for path in &backup_seeds {
            if path == "/" {
                continue;
            }
            for suffix in GOBUSTER_BACKUP_SUFFIXES {
                push_gobuster_candidate(
                    &mut candidates,
                    format!("{path}{suffix}"),
                    "gobuster-backup",
                );
            }
        }
    }

    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
    });
    candidates
}

fn gobuster_candidate_score(path: &str, source: &str) -> u16 {
    let base = candidate_coverage_score(path).max(620);
    match source {
        "gobuster-wordlist" => base.max(860),
        "gobuster-pattern" => base.max(840),
        "gobuster-add-slash" => base.max(800),
        "gobuster-extension" => base.max(780),
        "gobuster-backup" => base.max(760),
        _ => base,
    }
}

fn gobuster_candidate_supports_extensions(path: &str) -> bool {
    let trimmed = path.trim().trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "/" {
        return false;
    }
    let last_segment = trimmed.rsplit('/').next().unwrap_or_default();
    !last_segment.is_empty() && !last_segment.contains('.')
}

fn should_add_gobuster_slash(path: &str) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "/" || trimmed.ends_with('/') {
        return false;
    }
    let last_segment = trimmed.rsplit('/').next().unwrap_or_default();
    !last_segment.is_empty() && !last_segment.contains('.')
}

fn is_gobuster_coverage_source(source: &str) -> bool {
    source.trim().starts_with("gobuster-")
}

fn should_keep_gobuster_response(
    config: &GobusterConfig,
    baseline: Option<ResponseBaseline>,
    snapshot: &ResponseSnapshot,
) -> bool {
    let status = snapshot.document.status;
    let body_len = snapshot.document.body.len();

    if !config.status_codes.is_empty() && !config.status_codes.contains(&status) {
        return false;
    }
    if config.status_codes_blacklist.contains(&status) {
        return false;
    }
    if config.exclude_lengths.contains(&body_len) {
        return false;
    }
    if let Some(baseline) = baseline {
        if baseline.status == status && baseline.body_len == body_len {
            return false;
        }
    }
    true
}

fn merge_gobuster_target_config(
    base: &GobusterConfig,
    target: &GobusterTargetConfig,
) -> GobusterConfig {
    if is_default_target_gobuster_config(target) {
        return base.clone();
    }

    let mut effective = base.clone();
    effective.enabled = target.enabled
        || !target.wordlist.is_empty()
        || !target.extensions.is_empty()
        || target.add_slash
        || target.discover_backup;
    if !target.wordlist.is_empty() {
        effective.wordlist = target.wordlist.clone();
    }
    if !target.extensions.is_empty() {
        effective.extensions = target.extensions.clone();
    }
    if target.add_slash {
        effective.add_slash = true;
    }
    if target.discover_backup {
        effective.discover_backup = true;
    }
    effective
}

fn is_default_target_gobuster_config(target: &GobusterTargetConfig) -> bool {
    !target.enabled
        && target.wordlist.is_empty()
        && target.extensions.is_empty()
        && !target.add_slash
        && !target.discover_backup
}

fn seed_candidate_priority(
    path: &str,
    is_explicit_path: bool,
    persisted_score: Option<u16>,
) -> u16 {
    let base_priority = path_coverage_score(path).max(640);
    match (is_explicit_path, persisted_score) {
        (true, _) => base_priority.saturating_add(220),
        (false, Some(score)) => base_priority.max(score.saturating_add(60)),
        (false, None) => base_priority,
    }
}

#[cfg(test)]
fn discover_candidate_paths(base_url: &Url, current_path: &str, body: &str) -> Vec<String> {
    discover_candidate_path_candidates(base_url, current_path, 0, body)
        .into_iter()
        .map(|candidate| candidate.path)
        .collect()
}

fn discover_candidate_path_candidates(
    base_url: &Url,
    current_path: &str,
    current_depth: u8,
    body: &str,
) -> Vec<DiscoveryPathCandidate> {
    let mut discovered = Vec::new();
    let mut seen = HashMap::new();
    let next_depth = current_depth.saturating_add(1);

    for captures in HTML_ATTRIBUTE_DISCOVERY_RE.captures_iter(body) {
        if let Some(candidate) = captures.get(1).map(|value| value.as_str()) {
            push_discovered_candidate(
                &mut discovered,
                &mut seen,
                base_url,
                current_path,
                candidate,
                "html-link",
                920,
                next_depth,
            );
        }
    }

    for captures in QUOTED_PATH_DISCOVERY_RE.captures_iter(body) {
        if let Some(candidate) = captures.get(1).map(|value| value.as_str()) {
            if !(candidate.contains('/')
                || candidate.starts_with("./")
                || candidate.starts_with("../")
                || looks_like_interesting_filename(candidate))
            {
                continue;
            }
            push_discovered_candidate(
                &mut discovered,
                &mut seen,
                base_url,
                current_path,
                candidate,
                "quoted-string",
                720,
                next_depth,
            );
        }
    }

    for captures in SOURCE_MAP_DISCOVERY_RE.captures_iter(body) {
        if let Some(candidate) = captures.get(1).map(|value| value.as_str()) {
            push_discovered_candidate(
                &mut discovered,
                &mut seen,
                base_url,
                current_path,
                candidate,
                "source-map-hint",
                960,
                next_depth,
            );
        }
    }

    for candidate in structured_document_candidates(current_path, body) {
        push_authoritative_discovered_candidate(
            &mut discovered,
            &mut seen,
            base_url,
            current_path,
            &candidate.path,
            candidate.source,
            candidate.score,
            next_depth,
        );
    }

    let explicit_candidates = discovered
        .iter()
        .map(|candidate| candidate.path.clone())
        .collect::<Vec<_>>();
    for candidate in &explicit_candidates {
        for derived in derive_priority_candidate_paths(candidate) {
            push_discovered_candidate(
                &mut discovered,
                &mut seen,
                base_url,
                current_path,
                &derived.path,
                derived.source,
                derived.score,
                next_depth,
            );
        }
    }

    for candidate in semantic_document_candidates(current_path, body) {
        push_discovered_candidate(
            &mut discovered,
            &mut seen,
            base_url,
            current_path,
            &candidate.path,
            candidate.source,
            candidate.score,
            next_depth,
        );
    }

    let adaptive_seed_paths = discovered
        .iter()
        .map(|candidate| candidate.path.clone())
        .collect::<Vec<_>>();
    for candidate in adaptive_document_candidates(base_url, current_path, &adaptive_seed_paths) {
        push_discovered_candidate(
            &mut discovered,
            &mut seen,
            base_url,
            current_path,
            &candidate.path,
            candidate.source,
            candidate.score,
            next_depth,
        );
    }

    for candidate in explicit_candidates {
        for derived in derive_semantic_candidate_paths(&candidate) {
            push_discovered_candidate(
                &mut discovered,
                &mut seen,
                base_url,
                current_path,
                &derived.path,
                derived.source,
                derived.score,
                next_depth,
            );
        }
    }

    for derived in derive_semantic_candidate_paths(current_path) {
        push_discovered_candidate(
            &mut discovered,
            &mut seen,
            base_url,
            current_path,
            &derived.path,
            derived.source,
            derived.score,
            next_depth,
        );
    }

    discovered.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.depth.cmp(&right.depth))
            .then_with(|| left.path.cmp(&right.path))
    });
    discovered
}

fn structured_document_candidates(current_path: &str, body: &str) -> Vec<DiscoveryHint> {
    let lowered_path = current_path.trim().to_ascii_lowercase();
    let lowered_body = body.to_ascii_lowercase();
    let trimmed_body = body.trim();
    let mut candidates = Vec::new();

    if lowered_path == "/robots.txt" || lowered_path.ends_with("/robots.txt") {
        for candidate in robots_txt_candidates(body) {
            push_unique_hint(
                &mut candidates,
                candidate.path,
                candidate.source,
                candidate.score,
            );
        }
    }

    if lowered_path.ends_with(".xml")
        || lowered_body.contains("<urlset")
        || lowered_body.contains("<sitemapindex")
    {
        for candidate in sitemap_document_candidates(body) {
            push_unique_hint(
                &mut candidates,
                candidate.path,
                candidate.source,
                candidate.score,
            );
        }
    }

    if looks_like_openapi_document(&lowered_path, &lowered_body, trimmed_body) {
        for candidate in openapi_document_candidates(body) {
            push_unique_hint(
                &mut candidates,
                candidate.path,
                candidate.source,
                candidate.score,
            );
        }
    }

    if lowered_path.ends_with(".json")
        || lowered_path.ends_with(".webmanifest")
        || lowered_path.ends_with(".yaml")
        || lowered_path.ends_with(".yml")
        || trimmed_body.starts_with('{')
        || trimmed_body.starts_with('[')
        || looks_like_structured_yaml_document(&lowered_body, trimmed_body)
    {
        for candidate in json_document_candidates(current_path, body) {
            push_unique_hint(
                &mut candidates,
                candidate.path,
                candidate.source,
                candidate.score,
            );
        }
    }

    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
    });
    candidates
}

fn robots_txt_candidates(body: &str) -> Vec<DiscoveryHint> {
    let mut candidates = Vec::new();

    for raw_line in body.lines() {
        let stripped = raw_line.split('#').next().unwrap_or_default().trim();
        if stripped.is_empty() {
            continue;
        }

        if let Some(value) = strip_ascii_case_prefix(stripped, "Sitemap:") {
            let sitemap = value.trim();
            if !sitemap.is_empty() {
                push_unique_hint(
                    &mut candidates,
                    sitemap.to_string(),
                    "robots-sitemap",
                    candidate_coverage_score(sitemap).max(900),
                );
            }
            continue;
        }

        let directive = strip_ascii_case_prefix(stripped, "Allow:")
            .map(|value| ("robots-allow", value, 820))
            .or_else(|| {
                strip_ascii_case_prefix(stripped, "Disallow:")
                    .map(|value| ("robots-disallow", value, 800))
            });
        let Some((source, value, default_score)) = directive else {
            continue;
        };
        let Some(candidate) = sanitize_robots_directive_candidate(value) else {
            continue;
        };
        push_unique_hint(
            &mut candidates,
            candidate.clone(),
            source,
            candidate_coverage_score(&candidate).max(default_score),
        );
    }

    candidates
}

fn strip_ascii_case_prefix<'a>(input: &'a str, prefix: &str) -> Option<&'a str> {
    (input.len() >= prefix.len() && input[..prefix.len()].eq_ignore_ascii_case(prefix))
        .then_some(&input[prefix.len()..])
}

fn sanitize_robots_directive_candidate(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('$');
    let trimmed = trimmed
        .split_once('*')
        .map(|(prefix, _)| prefix)
        .unwrap_or(trimmed)
        .trim();
    if trimmed.is_empty() || matches!(trimmed, "/" | "*") {
        return None;
    }
    Some(trimmed.to_string())
}

fn sitemap_document_candidates(body: &str) -> Vec<DiscoveryHint> {
    let mut candidates = Vec::new();

    for captures in XML_LOC_DISCOVERY_RE.captures_iter(body) {
        if let Some(candidate) = captures.get(1).map(|value| value.as_str().trim()) {
            if candidate.is_empty() {
                continue;
            }
            push_unique_hint(
                &mut candidates,
                candidate.to_string(),
                "sitemap-xml",
                candidate_coverage_score(candidate).max(760),
            );
        }
    }

    candidates
}

fn json_document_candidates(current_path: &str, body: &str) -> Vec<DiscoveryHint> {
    let Some(value) = parse_document_value(body) else {
        return Vec::new();
    };

    let mut candidates = Vec::new();
    collect_json_document_candidates(&value, current_path, None, &mut candidates);
    candidates
}

fn parse_document_value(body: &str) -> Option<Value> {
    serde_json::from_str::<Value>(body).ok().or_else(|| {
        serde_yaml::from_str::<serde_yaml::Value>(body)
            .ok()
            .and_then(|value| serde_json::to_value(value).ok())
    })
}

fn looks_like_structured_yaml_document(lowered_body: &str, trimmed_body: &str) -> bool {
    if trimmed_body.is_empty() || trimmed_body.starts_with('<') {
        return false;
    }

    lowered_body.contains("openapi:")
        || lowered_body.contains("swagger:")
        || lowered_body.contains("paths:")
        || lowered_body.contains("start_url:")
        || lowered_body.contains("scope:")
}

fn looks_like_openapi_document(lowered_path: &str, lowered_body: &str, trimmed_body: &str) -> bool {
    lowered_path.contains("openapi")
        || lowered_path.contains("swagger")
        || lowered_path.contains("api-docs")
        || lowered_body.contains("\"openapi\"")
        || lowered_body.contains("\"swagger\"")
        || lowered_body.contains("openapi:")
        || lowered_body.contains("swagger:")
        || (lowered_body.contains("\"paths\"") || lowered_body.contains("\npaths:"))
            && (trimmed_body.starts_with('{')
                || looks_like_structured_yaml_document(lowered_body, trimmed_body))
}

fn openapi_document_candidates(body: &str) -> Vec<DiscoveryHint> {
    let Some(value) = parse_document_value(body) else {
        return Vec::new();
    };
    let Some(paths) = value.get("paths").and_then(|value| value.as_object()) else {
        return Vec::new();
    };

    let prefixes = openapi_server_prefixes(&value);
    let mut candidates = Vec::new();
    for route in paths.keys() {
        for prefix in &prefixes {
            let Some(candidate) = combine_openapi_route(prefix, route) else {
                continue;
            };
            push_unique_hint(
                &mut candidates,
                candidate.clone(),
                "openapi-route",
                candidate_coverage_score(&candidate).max(700),
            );
        }
    }

    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
    });
    candidates.truncate(MAX_OPENAPI_ROUTE_CANDIDATES);
    candidates
}

fn openapi_server_prefixes(value: &Value) -> Vec<String> {
    let mut prefixes = vec![String::new()];

    if let Some(base_path) = value.get("basePath").and_then(|value| value.as_str()) {
        if let Some(prefix) = normalize_openapi_template_path(base_path) {
            push_unique_string(&mut prefixes, prefix);
        }
    }

    if let Some(servers) = value.get("servers").and_then(|value| value.as_array()) {
        for server in servers {
            let Some(server_url) = server.get("url").and_then(|value| value.as_str()) else {
                continue;
            };
            if let Some(prefix) = normalize_openapi_template_path(server_url) {
                push_unique_string(&mut prefixes, prefix);
            }
        }
    }

    prefixes
}

fn combine_openapi_route(prefix: &str, route: &str) -> Option<String> {
    let route = normalize_openapi_template_path(route)?;
    let normalized_prefix = normalize_openapi_template_path(prefix).unwrap_or_default();
    if normalized_prefix.is_empty() || normalized_prefix == "/" {
        return Some(route);
    }
    if route == normalized_prefix || route.starts_with(&format!("{normalized_prefix}/")) {
        return Some(route);
    }

    Some(format!(
        "{}/{}",
        normalized_prefix.trim_end_matches('/'),
        route.trim_start_matches('/')
    ))
}

fn normalize_openapi_template_path(candidate: &str) -> Option<String> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut path = if let Ok(url) = Url::parse(trimmed) {
        url.path().to_string()
    } else {
        trimmed
            .split(['?', '#'])
            .next()
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    if path.is_empty() {
        return None;
    }
    if !path.starts_with('/') {
        path = format!("/{path}");
    }

    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .take_while(|segment| !looks_like_path_template_segment(segment))
        .collect::<Vec<_>>();
    if segments.is_empty() {
        return None;
    }

    Some(format!("/{}", segments.join("/")))
}

fn looks_like_path_template_segment(segment: &str) -> bool {
    let trimmed = segment.trim();
    trimmed.is_empty()
        || trimmed.starts_with(':')
        || trimmed.starts_with('*')
        || trimmed.contains('{')
        || trimmed.contains('}')
}

fn push_unique_string(values: &mut Vec<String>, candidate: String) {
    if !values.iter().any(|value| value == &candidate) {
        values.push(candidate);
    }
}

fn collect_json_document_candidates(
    value: &Value,
    current_path: &str,
    current_key: Option<&str>,
    candidates: &mut Vec<DiscoveryHint>,
) {
    match value {
        Value::Object(entries) => {
            for (key, entry_value) in entries {
                collect_json_document_candidates(entry_value, current_path, Some(key), candidates);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_json_document_candidates(item, current_path, current_key, candidates);
            }
        }
        Value::String(candidate) => {
            let Some((source, score)) =
                json_string_candidate_hint(current_path, current_key, candidate)
            else {
                return;
            };
            push_unique_hint(candidates, candidate.trim().to_string(), source, score);
        }
        _ => {}
    }
}

fn json_string_candidate_hint(
    current_path: &str,
    current_key: Option<&str>,
    candidate: &str,
) -> Option<(&'static str, u16)> {
    if !looks_like_structured_candidate_string(current_key, candidate) {
        return None;
    }

    let lowered_path = current_path.trim().to_ascii_lowercase();
    let lowered_key = current_key.unwrap_or_default().trim().to_ascii_lowercase();
    let base_score = candidate_coverage_score(candidate).max(760);

    if let Some(hint) = manifest_json_candidate_hint(&lowered_path, &lowered_key, base_score) {
        return Some(hint);
    }

    let hint = match lowered_key.as_str() {
        "src" | "file" | "imports" | "dynamicimports" | "css" | "assets" | "entry" => {
            ("json-asset-path", base_score.max(860))
        }
        "sitemap" => ("json-sitemap", base_score.max(920)),
        "start_url" | "scope" | "url" | "href" | "action" => {
            ("json-link-path", base_score.max(800))
        }
        _ if lowered_path.contains("manifest") || lowered_path.ends_with(".webmanifest") => {
            ("json-manifest-path", base_score.max(800))
        }
        _ => ("json-string-path", base_score),
    };

    Some(hint)
}

fn manifest_json_candidate_hint(
    lowered_path: &str,
    lowered_key: &str,
    base_score: u16,
) -> Option<(&'static str, u16)> {
    let asset_key = matches!(
        lowered_key,
        "src" | "file" | "imports" | "dynamicimports" | "css" | "assets" | "entry"
    );
    let manifest_link_key = matches!(
        lowered_key,
        "start_url" | "scope" | "url" | "href" | "action"
    );
    let icon_key = matches!(lowered_key, "icons" | "screenshots" | "shortcuts");

    if lowered_path.ends_with("/asset-manifest.json")
        || lowered_path.ends_with("/build/manifest.json")
        || lowered_path.ends_with("/dist/manifest.json")
    {
        return Some(("asset-manifest", base_score.max(930)));
    }

    if lowered_path.ends_with("/vite.manifest.json") {
        return Some(("vite-manifest", base_score.max(930)));
    }

    if lowered_path.contains("/_next/")
        && (lowered_path.ends_with("manifest.json")
            || lowered_path.ends_with("routes-manifest.json"))
    {
        return Some(("next-manifest", base_score.max(925)));
    }

    if lowered_path.ends_with("/manifest.json") || lowered_path.ends_with(".webmanifest") {
        return Some((
            "web-manifest",
            if asset_key || manifest_link_key || icon_key {
                base_score.max(900)
            } else {
                base_score.max(830)
            },
        ));
    }

    None
}

fn looks_like_structured_candidate_string(current_key: Option<&str>, candidate: &str) -> bool {
    let trimmed = candidate.trim();
    if trimmed.is_empty()
        || trimmed.len() > 256
        || trimmed.contains(['\n', '\r'])
        || trimmed.starts_with('#')
        || trimmed.starts_with("data:")
        || trimmed.starts_with("javascript:")
    {
        return false;
    }

    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with('/')
        || trimmed.starts_with("./")
        || trimmed.starts_with("../")
        || trimmed.contains('/')
        || looks_like_interesting_filename(trimmed)
    {
        return true;
    }

    current_key.is_some_and(|key| {
        matches!(
            key.trim().to_ascii_lowercase().as_str(),
            "start_url" | "scope" | "url" | "href" | "action" | "id"
        ) && candidate_coverage_score(&format!("/{trimmed}"))
            >= AUTHORITATIVE_DISCOVERY_MIN_COVERAGE_SCORE
    })
}

fn path_coverage_score(path: &str) -> u16 {
    let lowered = path.trim().to_ascii_lowercase();
    if lowered.is_empty() || lowered == "/" {
        return 620;
    }

    let mut score = 620;

    if lowered.starts_with("/.well-known/") {
        score = score.max(900);
    }
    if lowered.ends_with("robots.txt")
        || lowered.ends_with("sitemap.xml")
        || lowered.ends_with("sitemap_index.xml")
        || lowered.ends_with("sitemap-index.xml")
        || lowered.ends_with("sitemap.txt")
    {
        score = score.max(900);
    }
    if lowered.ends_with(".map") {
        score = score.max(930);
    }
    if lowered.ends_with(".env") || lowered.contains("/.env") {
        score = score.max(920);
    }
    if lowered.ends_with("manifest.json") || lowered.ends_with(".webmanifest") {
        score = score.max(880);
    }
    if lowered.ends_with("openapi.json")
        || lowered.ends_with("openapi.yaml")
        || lowered.ends_with("openapi.yml")
        || lowered.ends_with("swagger.json")
        || lowered.contains("api-docs")
    {
        score = score.max(870);
    }
    if lowered.contains("runtime-config")
        || lowered.contains("config")
        || lowered.contains("settings")
        || lowered.ends_with("/env.js")
    {
        score = score.max(850);
    }
    if lowered == "/graphql"
        || lowered.contains("/graphql/")
        || lowered.contains("graphiql")
        || lowered.contains("playground")
    {
        score = score.max(800);
    }
    if lowered == "/api"
        || lowered.contains("/api/")
        || lowered.contains("/v1/")
        || lowered.contains("/v2/")
        || lowered.contains("/rest/")
    {
        score = score.max(770);
    }
    if lowered.contains("service-worker")
        || lowered.ends_with("/sw.js")
        || lowered.ends_with("/ngsw.json")
    {
        score = score.max(800);
    }
    if lowered.contains("/assets/")
        || lowered.contains("/static/")
        || lowered.contains("/build/")
        || lowered.contains("/dist/")
        || lowered.contains("/_next/")
    {
        score = score.max(760);
    }
    if lowered.contains("/docs") || lowered.contains("redoc") || lowered.contains("swagger-ui") {
        score = score.max(760);
    }
    if lowered == "/admin"
        || lowered.contains("/admin/")
        || lowered == "/internal"
        || lowered.contains("/internal/")
        || lowered.contains("actuator")
        || lowered == "/debug"
        || lowered.contains("/debug/")
    {
        score = score.max(760);
    }
    if lowered.ends_with(".js") || lowered.ends_with(".mjs") || lowered.ends_with(".cjs") {
        score = score.max(780);
    }
    if lowered.ends_with(".json") || lowered.ends_with(".yaml") || lowered.ends_with(".yml") {
        score = score.max(760);
    }
    if lowered.ends_with(".xml") || lowered.ends_with(".txt") {
        score = score.max(740);
    }
    if lowered.ends_with(".bak") || lowered.ends_with(".old") {
        score = score.max(720);
    }

    score
}

fn candidate_coverage_score(candidate: &str) -> u16 {
    let trimmed = candidate.trim();
    if let Ok(url) = Url::parse(trimmed) {
        return path_coverage_score(url.path());
    }
    path_coverage_score(trimmed)
}

fn looks_like_interesting_filename(candidate: &str) -> bool {
    let trimmed = candidate.trim().trim_start_matches('/');
    if trimmed.is_empty() || trimmed.contains('/') {
        return false;
    }

    is_interesting_discovered_path(&format!("/{trimmed}"))
}

fn semantic_document_candidates(current_path: &str, body: &str) -> Vec<DiscoveryHint> {
    let lowered_body = body.to_ascii_lowercase();
    let lowered_path = current_path.trim().to_ascii_lowercase();
    let mut candidates = Vec::new();

    if lowered_path == "/" || lowered_path.ends_with(".html") {
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "manifest.json"),
            "manifest-ref",
            860,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "site.webmanifest"),
            "manifest-ref",
            850,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "robots.txt"),
            "crawler-index-ref",
            900,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "sitemap.xml"),
            "crawler-index-ref",
            890,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, ".well-known/security.txt"),
            "well-known-ref",
            860,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "sw.js"),
            "service-worker-ref",
            820,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "service-worker.js"),
            "service-worker-ref",
            810,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "runtime-config.json"),
            "runtime-config-ref",
            820,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "runtime-config.js"),
            "runtime-config-ref",
            800,
        );
    }

    if lowered_body.contains("/_next/static/") || lowered_body.contains("__next_data__") {
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "_next/build-manifest.json"),
            "nextjs-build-manifest",
            840,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "_next/static/chunks/main.js"),
            "nextjs-chunk",
            790,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "_next/static/chunks/webpack.js"),
            "nextjs-chunk",
            785,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "_next/static/runtime/main.js"),
            "nextjs-runtime-chunk",
            780,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "_next/static/runtime/webpack.js"),
            "nextjs-runtime-chunk",
            775,
        );
    }

    if lowered_body.contains("/@vite/client")
        || lowered_body.contains("import.meta.env")
        || lowered_body.contains("vite.manifest")
    {
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "vite.manifest.json"),
            "vite-manifest",
            830,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "assets/index.js"),
            "vite-asset",
            780,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "assets/main.js"),
            "vite-asset",
            775,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "assets/index.js.map"),
            "vite-source-map",
            800,
        );
    }

    if lowered_body.contains("asset-manifest") || lowered_body.contains("webpack") {
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "asset-manifest.json"),
            "webpack-manifest",
            820,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "static/js/main.js"),
            "webpack-bundle",
            770,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "static/js/runtime-main.js"),
            "webpack-bundle",
            765,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "static/js/main.js.map"),
            "webpack-source-map",
            790,
        );
    }

    if lowered_body.contains("manifest.json") || lowered_body.contains("webmanifest") {
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "manifest.json"),
            "manifest-ref",
            860,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "site.webmanifest"),
            "manifest-ref",
            850,
        );
    }

    if lowered_body.contains("runtime-config")
        || lowered_body.contains("publicruntimeconfig")
        || lowered_body.contains("window.__env")
        || lowered_body.contains("window.env")
        || lowered_body.contains("process.env")
    {
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "runtime-config.json"),
            "runtime-config-ref",
            820,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "runtime-config.js"),
            "runtime-config-ref",
            800,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "env.js"),
            "runtime-config-ref",
            780,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "config.json"),
            "config-ref",
            760,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "config.js"),
            "config-ref",
            740,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "settings.json"),
            "config-ref",
            720,
        );
    }

    if lowered_body.contains("openapi")
        || lowered_body.contains("swagger")
        || lowered_body.contains("api-docs")
    {
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "openapi.json"),
            "api-schema-ref",
            800,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "openapi.yaml"),
            "api-schema-ref",
            790,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "openapi.yml"),
            "api-schema-ref",
            785,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "swagger.json"),
            "api-schema-ref",
            790,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "v2/api-docs"),
            "api-schema-ref",
            780,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "docs"),
            "api-schema-ref",
            770,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "swagger-ui"),
            "api-schema-ref",
            760,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "redoc"),
            "api-schema-ref",
            750,
        );
    }

    if lowered_body.contains("navigator.serviceworker")
        || lowered_body.contains("serviceworker.register")
        || lowered_body.contains("firebase-messaging-sw")
    {
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "sw.js"),
            "service-worker-ref",
            830,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "service-worker.js"),
            "service-worker-ref",
            820,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "firebase-messaging-sw.js"),
            "service-worker-ref",
            810,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "ngsw.json"),
            "service-worker-ref",
            800,
        );
    }

    if lowered_body.contains("graphql") || lowered_body.contains("graphiql") {
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "graphql"),
            "graphql-ref",
            800,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "graphiql"),
            "graphql-ref",
            790,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(current_path, "playground"),
            "graphql-ref",
            780,
        );
    }

    candidates
}

fn derive_priority_candidate_paths(path: &str) -> Vec<DiscoveryHint> {
    let mut candidates = Vec::new();

    if let Some(candidate) = replace_path_suffix(path, ".js", ".js.map") {
        push_unique_hint(&mut candidates, candidate, "derived-source-map", 900);
    }
    if let Some(candidate) = replace_path_suffix(path, ".mjs", ".mjs.map") {
        push_unique_hint(&mut candidates, candidate, "derived-source-map", 900);
    }
    if let Some(candidate) = replace_path_suffix(path, ".cjs", ".cjs.map") {
        push_unique_hint(&mut candidates, candidate, "derived-source-map", 900);
    }
    if let Some(candidate) = replace_path_suffix(path, ".js.map", ".js") {
        push_unique_hint(&mut candidates, candidate, "derived-bundle", 760);
    }

    candidates
}

fn derive_semantic_candidate_paths(path: &str) -> Vec<DiscoveryHint> {
    let lowered = path.trim().to_ascii_lowercase();
    let mut candidates = Vec::new();

    if lowered == "/" || lowered.ends_with("/index.html") {
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "manifest.json"),
            "derived-manifest-sibling",
            780,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "site.webmanifest"),
            "derived-manifest-sibling",
            770,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "asset-manifest.json"),
            "derived-manifest-sibling",
            760,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "robots.txt"),
            "derived-crawler-index",
            800,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "sitemap.xml"),
            "derived-crawler-index",
            790,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, ".well-known/security.txt"),
            "derived-well-known",
            780,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "sw.js"),
            "derived-service-worker",
            770,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "service-worker.js"),
            "derived-service-worker",
            760,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "runtime-config.json"),
            "derived-runtime-config",
            780,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "runtime-config.js"),
            "derived-runtime-config",
            770,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "env.js"),
            "derived-runtime-config",
            750,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "config.json"),
            "derived-runtime-config",
            740,
        );
    }

    if let Some(candidate) = replace_path_suffix(path, ".js", ".js.map") {
        push_unique_hint(&mut candidates, candidate, "derived-source-map", 900);
    }
    if let Some(candidate) = replace_path_suffix(path, ".mjs", ".mjs.map") {
        push_unique_hint(&mut candidates, candidate, "derived-source-map", 900);
    }
    if let Some(candidate) = replace_path_suffix(path, ".cjs", ".cjs.map") {
        push_unique_hint(&mut candidates, candidate, "derived-source-map", 900);
    }
    if let Some(candidate) = replace_path_suffix(path, ".js.map", ".js") {
        push_unique_hint(&mut candidates, candidate, "derived-bundle", 760);
    }

    if lowered.ends_with(".json") {
        push_unique_hint(
            &mut candidates,
            format!("{path}.bak"),
            "derived-backup-variant",
            700,
        );
        push_unique_hint(
            &mut candidates,
            format!("{path}.old"),
            "derived-backup-variant",
            690,
        );
        if has_config_semantics(&lowered) {
            if let Some(candidate) = replace_path_suffix(path, ".json", ".js") {
                push_unique_hint(&mut candidates, candidate, "derived-config-variant", 760);
            }
            if let Some(candidate) = replace_path_suffix(path, ".json", ".yaml") {
                push_unique_hint(&mut candidates, candidate, "derived-config-variant", 750);
            }
            if let Some(candidate) = replace_path_suffix(path, ".json", ".yml") {
                push_unique_hint(&mut candidates, candidate, "derived-config-variant", 750);
            }
            if let Some(candidate) = insert_before_suffix(path, ".json", ".production") {
                push_unique_hint(&mut candidates, candidate, "derived-config-variant", 740);
            }
            if let Some(candidate) = insert_before_suffix(path, ".json", ".development") {
                push_unique_hint(&mut candidates, candidate, "derived-config-variant", 735);
            }
            if let Some(candidate) = insert_before_suffix(path, ".json", ".local") {
                push_unique_hint(&mut candidates, candidate, "derived-config-variant", 730);
            }
        }
        if lowered.contains("manifest") {
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "manifest.json"),
                "derived-manifest-sibling",
                780,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "site.webmanifest"),
                "derived-manifest-sibling",
                770,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "asset-manifest.json"),
                "derived-manifest-sibling",
                760,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "sw.js"),
                "derived-service-worker",
                750,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "service-worker.js"),
                "derived-service-worker",
                740,
            );
        }
        if lowered.contains("openapi")
            || lowered.contains("swagger")
            || lowered.contains("api-docs")
        {
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "openapi.json"),
                "derived-api-schema-sibling",
                780,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "openapi.yaml"),
                "derived-api-schema-sibling",
                775,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "openapi.yml"),
                "derived-api-schema-sibling",
                770,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "swagger.json"),
                "derived-api-schema-sibling",
                770,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "v2/api-docs"),
                "derived-api-schema-sibling",
                760,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "docs"),
                "derived-api-schema-sibling",
                750,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "swagger-ui"),
                "derived-api-schema-sibling",
                740,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "redoc"),
                "derived-api-schema-sibling",
                730,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "graphql"),
                "derived-graphql-schema",
                780,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "graphql/schema"),
                "derived-graphql-schema",
                770,
            );
        }
        if lowered.contains("service-worker")
            || lowered.ends_with("/sw.js")
            || lowered.ends_with("/ngsw.json")
        {
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "ngsw.json"),
                "derived-service-worker-config",
                760,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "firebase-messaging-sw.js"),
                "derived-service-worker-config",
                750,
            );
        }
    }

    if lowered.ends_with(".js") || lowered.ends_with(".mjs") || lowered.ends_with(".cjs") {
        if lowered.contains("runtime") || lowered.contains("config") || lowered.contains("env") {
            push_unique_hint(
                &mut candidates,
                replace_path_suffix(path, ".js", ".json")
                    .or_else(|| replace_path_suffix(path, ".mjs", ".json"))
                    .or_else(|| replace_path_suffix(path, ".cjs", ".json"))
                    .unwrap_or_else(|| sibling_path(path, "runtime-config.json")),
                "derived-config-json",
                780,
            );
        }
        if lowered.contains("service-worker") || lowered.ends_with("/sw.js") {
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "ngsw.json"),
                "derived-service-worker-config",
                760,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "firebase-messaging-sw.js"),
                "derived-service-worker-config",
                750,
            );
        }
        if lowered.contains("graphql") {
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "graphql"),
                "derived-graphql-schema",
                780,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "graphql/schema"),
                "derived-graphql-schema",
                770,
            );
            push_unique_hint(
                &mut candidates,
                sibling_path(path, "graphiql"),
                "derived-graphql-schema",
                760,
            );
        }
    }

    if lowered.ends_with(".yaml") || lowered.ends_with(".yml") {
        push_unique_hint(
            &mut candidates,
            format!("{path}.bak"),
            "derived-backup-variant",
            700,
        );
        if has_config_semantics(&lowered) {
            if let Some(candidate) = replace_path_suffix(path, ".yaml", ".json") {
                push_unique_hint(&mut candidates, candidate, "derived-config-variant", 760);
            }
            if let Some(candidate) = replace_path_suffix(path, ".yaml", ".js") {
                push_unique_hint(&mut candidates, candidate, "derived-config-variant", 750);
            }
            if let Some(candidate) = replace_path_suffix(path, ".yml", ".json") {
                push_unique_hint(&mut candidates, candidate, "derived-config-variant", 760);
            }
            if let Some(candidate) = replace_path_suffix(path, ".yml", ".js") {
                push_unique_hint(&mut candidates, candidate, "derived-config-variant", 750);
            }
            if lowered.contains("openapi") {
                push_unique_hint(
                    &mut candidates,
                    sibling_path(path, "openapi.json"),
                    "derived-api-schema-sibling",
                    770,
                );
            }
        }
    }

    if lowered.ends_with(".env") || lowered.contains("/.env") {
        push_unique_hint(
            &mut candidates,
            format!("{path}.local"),
            "derived-env-variant",
            780,
        );
        push_unique_hint(
            &mut candidates,
            format!("{path}.production"),
            "derived-env-variant",
            770,
        );
        push_unique_hint(
            &mut candidates,
            format!("{path}.development"),
            "derived-env-variant",
            770,
        );
        push_unique_hint(
            &mut candidates,
            format!("{path}.test"),
            "derived-env-variant",
            760,
        );
        push_unique_hint(
            &mut candidates,
            format!("{path}.bak"),
            "derived-backup-variant",
            700,
        );
        push_unique_hint(
            &mut candidates,
            format!("{path}.old"),
            "derived-backup-variant",
            690,
        );
    }

    if has_config_semantics(&lowered) {
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "runtime-config.json"),
            "derived-runtime-config",
            780,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "runtime-config.js"),
            "derived-runtime-config",
            770,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "config.json"),
            "derived-config-variant",
            750,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "config.js"),
            "derived-config-variant",
            740,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "config.production.json"),
            "derived-config-variant",
            735,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "settings.json"),
            "derived-config-variant",
            730,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "settings.local.json"),
            "derived-config-variant",
            725,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "env.js"),
            "derived-runtime-config",
            720,
        );
    }

    if lowered.ends_with("robots.txt") {
        push_unique_hint(
            &mut candidates,
            sibling_path(path, "sitemap.xml"),
            "derived-crawler-index",
            820,
        );
        push_unique_hint(
            &mut candidates,
            sibling_path(path, ".well-known/security.txt"),
            "derived-well-known",
            800,
        );
    }

    candidates.truncate(16);
    candidates
}

fn adaptive_document_candidates(
    base_url: &Url,
    current_path: &str,
    seed_paths: &[String],
) -> Vec<DiscoveryHint> {
    let prefixes = adaptive_candidate_prefixes(base_url, current_path, seed_paths);
    let mut candidates = Vec::new();

    for prefix in prefixes.into_iter().take(MAX_ADAPTIVE_PREFIXES) {
        for (source, score, candidate) in adaptive_prefix_candidates(&prefix) {
            push_unique_hint(&mut candidates, candidate, source, score);
        }
    }

    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
    });
    candidates.truncate(MAX_ADAPTIVE_CANDIDATES);
    candidates
}

fn adaptive_candidate_prefixes(
    base_url: &Url,
    current_path: &str,
    seed_paths: &[String],
) -> Vec<String> {
    let mut scored_prefixes = Vec::new();
    let mut seen = HashSet::new();

    push_adaptive_prefix(&mut scored_prefixes, &mut seen, "/".to_string());
    push_adaptive_prefix(
        &mut scored_prefixes,
        &mut seen,
        path_directory(current_path).to_string(),
    );

    for token in host_hint_tokens(base_url) {
        push_adaptive_prefix(&mut scored_prefixes, &mut seen, format!("/{token}"));
    }

    for path in seed_paths {
        for prefix in path_prefix_chain(path) {
            push_adaptive_prefix(&mut scored_prefixes, &mut seen, prefix);
        }
    }

    scored_prefixes.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    scored_prefixes
        .into_iter()
        .map(|(_, prefix)| prefix)
        .collect()
}

fn push_adaptive_prefix(
    prefixes: &mut Vec<(u16, String)>,
    seen: &mut HashSet<String>,
    prefix: String,
) {
    let normalized = if prefix.trim().is_empty() {
        "/".to_string()
    } else {
        let sanitized = sanitize_paths(&[prefix])
            .into_iter()
            .next()
            .unwrap_or_else(|| "/".to_string());
        if sanitized.is_empty() {
            "/".to_string()
        } else {
            sanitized
        }
    };
    if !seen.insert(normalized.clone()) {
        return;
    }

    prefixes.push((adaptive_prefix_score(&normalized), normalized));
}

fn adaptive_prefix_score(prefix: &str) -> u16 {
    let lowered = prefix.trim().to_ascii_lowercase();
    if lowered == "/" {
        return 900;
    }
    if lowered.contains("/api") || lowered.contains("/v1") || lowered.contains("/v2") {
        return 890;
    }
    if lowered.contains("/admin") || lowered.contains("/internal") {
        return 870;
    }
    if lowered.contains("/graphql") {
        return 860;
    }
    if lowered.contains("/app") || lowered.contains("/portal") || lowered.contains("/console") {
        return 840;
    }
    780
}

fn adaptive_prefix_candidates(prefix: &str) -> Vec<(&'static str, u16, String)> {
    let mut candidates = Vec::new();
    let lowered = prefix.trim().to_ascii_lowercase();

    if looks_like_api_prefix(&lowered) || lowered == "/" {
        candidates.push((
            "adaptive-api-prefix",
            860,
            join_prefix_path(prefix, "openapi.json"),
        ));
        candidates.push((
            "adaptive-api-prefix",
            850,
            join_prefix_path(prefix, "swagger.json"),
        ));
        candidates.push((
            "adaptive-api-prefix",
            840,
            join_prefix_path(prefix, "v2/api-docs"),
        ));
        candidates.push((
            "adaptive-api-prefix",
            820,
            join_prefix_path(prefix, "graphql"),
        ));
        candidates.push((
            "adaptive-api-prefix",
            810,
            join_prefix_path(prefix, "graphiql"),
        ));
    }

    if looks_like_config_prefix(&lowered) || lowered == "/" {
        candidates.push((
            "adaptive-config-prefix",
            830,
            join_prefix_path(prefix, "runtime-config.json"),
        ));
        candidates.push((
            "adaptive-config-prefix",
            820,
            join_prefix_path(prefix, "config.json"),
        ));
        candidates.push((
            "adaptive-config-prefix",
            810,
            join_prefix_path(prefix, "settings.json"),
        ));
        candidates.push((
            "adaptive-config-prefix",
            790,
            join_prefix_path(prefix, "env.js"),
        ));
    }

    if lowered == "/" || lowered.contains("/admin") || lowered.contains("/app") {
        candidates.push((
            "adaptive-docs-prefix",
            800,
            join_prefix_path(prefix, "docs"),
        ));
        candidates.push((
            "adaptive-docs-prefix",
            790,
            join_prefix_path(prefix, "swagger-ui"),
        ));
        candidates.push((
            "adaptive-docs-prefix",
            780,
            join_prefix_path(prefix, "redoc"),
        ));
    }

    candidates
}

fn looks_like_api_prefix(prefix: &str) -> bool {
    prefix.contains("/api")
        || prefix.contains("/graphql")
        || prefix.contains("/service")
        || prefix.contains("/docs")
        || prefix.contains("/swagger")
        || prefix.contains("/v1")
        || prefix.contains("/v2")
        || prefix.contains("/rest")
}

fn looks_like_config_prefix(prefix: &str) -> bool {
    prefix.contains("/admin")
        || prefix.contains("/internal")
        || prefix.contains("/app")
        || prefix.contains("/portal")
        || prefix.contains("/console")
        || prefix.contains("/dashboard")
}

fn join_prefix_path(prefix: &str, suffix: &str) -> String {
    let normalized_prefix = prefix.trim();
    if normalized_prefix.is_empty() || normalized_prefix == "/" {
        format!("/{suffix}")
    } else {
        format!("{}/{}", normalized_prefix.trim_end_matches('/'), suffix)
    }
}

fn host_hint_tokens(base_url: &Url) -> Vec<String> {
    let mut tokens = Vec::new();
    let Some(host) = base_url.host_str() else {
        return tokens;
    };

    for token in host
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
    {
        let lowered = token.to_ascii_lowercase();
        if matches!(
            lowered.as_str(),
            "api" | "admin" | "app" | "internal" | "graphql" | "portal" | "console"
        ) {
            push_unique_string(&mut tokens, lowered);
        }
    }

    tokens
}

fn path_prefix_chain(path: &str) -> Vec<String> {
    let sanitized = sanitize_paths(&[path.to_string()]);
    let Some(path) = sanitized.into_iter().next() else {
        return vec!["/".to_string()];
    };

    let mut prefixes = vec!["/".to_string()];
    let segments = path
        .trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();

    let mut current = String::new();
    for (index, segment) in segments.iter().enumerate() {
        let is_file_like = index == segments.len().saturating_sub(1) && segment.contains('.');
        if is_file_like {
            break;
        }
        current.push('/');
        current.push_str(segment);
        push_unique_string(&mut prefixes, current.clone());
    }

    prefixes
}

fn has_config_semantics(path: &str) -> bool {
    ["config", "settings", "runtime", "env", "manifest"]
        .iter()
        .any(|fragment| path.contains(fragment))
}

fn replace_path_suffix(path: &str, suffix: &str, replacement: &str) -> Option<String> {
    let lowered = path.to_ascii_lowercase();
    lowered.ends_with(suffix).then(|| {
        let prefix_len = path.len().saturating_sub(suffix.len());
        format!("{}{}", &path[..prefix_len], replacement)
    })
}

fn insert_before_suffix(path: &str, suffix: &str, inserted: &str) -> Option<String> {
    let lowered = path.to_ascii_lowercase();
    lowered.ends_with(suffix).then(|| {
        let prefix_len = path.len().saturating_sub(suffix.len());
        format!("{}{}{}", &path[..prefix_len], inserted, &path[prefix_len..])
    })
}

fn sibling_path(path: &str, file_name: &str) -> String {
    let directory = path_directory(path);
    if directory == "/" {
        format!("/{file_name}")
    } else {
        format!("{directory}/{file_name}")
    }
}

fn path_directory(path: &str) -> &str {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return "/";
    }

    let without_trailing = trimmed.trim_end_matches('/');
    if let Some((directory, _)) = without_trailing.rsplit_once('/') {
        if directory.is_empty() {
            "/"
        } else {
            directory
        }
    } else {
        "/"
    }
}

fn push_unique_hint(
    candidates: &mut Vec<DiscoveryHint>,
    path: String,
    source: &'static str,
    score: u16,
) {
    if let Some(existing) = candidates
        .iter_mut()
        .find(|candidate| candidate.path == path)
    {
        if score > existing.score {
            existing.source = source;
            existing.score = score;
        }
        return;
    }

    candidates.push(DiscoveryHint {
        path,
        source,
        score,
    });
}

fn push_discovered_candidate(
    discovered: &mut Vec<DiscoveryPathCandidate>,
    seen: &mut HashMap<String, usize>,
    base_url: &Url,
    current_path: &str,
    candidate: &str,
    source: &'static str,
    score: u16,
    depth: u8,
) {
    push_discovered_candidate_with_floor(
        discovered,
        seen,
        base_url,
        current_path,
        candidate,
        source,
        score,
        discovered_score_floor(source),
        depth,
        DiscoveryNormalizationPolicy::Default,
    );
}

fn push_authoritative_discovered_candidate(
    discovered: &mut Vec<DiscoveryPathCandidate>,
    seen: &mut HashMap<String, usize>,
    base_url: &Url,
    current_path: &str,
    candidate: &str,
    source: &'static str,
    score: u16,
    depth: u8,
) {
    push_discovered_candidate_with_floor(
        discovered,
        seen,
        base_url,
        current_path,
        candidate,
        source,
        score,
        authoritative_discovered_score_floor(source),
        depth,
        DiscoveryNormalizationPolicy::Authoritative,
    );
}

fn push_discovered_candidate_with_floor(
    discovered: &mut Vec<DiscoveryPathCandidate>,
    seen: &mut HashMap<String, usize>,
    base_url: &Url,
    current_path: &str,
    candidate: &str,
    source: &'static str,
    score: u16,
    score_floor: u16,
    depth: u8,
    policy: DiscoveryNormalizationPolicy,
) {
    let Some(path) = normalize_discovered_path(base_url, current_path, candidate, policy) else {
        return;
    };

    let effective_score = score.max(score_floor);

    if let Some(index) = seen.get(&path).copied() {
        let existing = &mut discovered[index];
        if effective_score > existing.score
            || (effective_score == existing.score && depth < existing.depth)
        {
            existing.source = source;
            existing.score = effective_score;
            existing.depth = depth;
        }
        return;
    }

    let index = discovered.len();
    seen.insert(path.clone(), index);
    discovered.push(DiscoveryPathCandidate {
        path,
        source,
        score: effective_score,
        depth,
    });
}

fn discovered_score_floor(source: &str) -> u16 {
    authoritative_discovered_score_floor(source)
}

fn authoritative_discovered_score_floor(source: &str) -> u16 {
    match source {
        "robots-txt" | "robots-allow" | "robots-disallow" => 560,
        "robots-sitemap" | "json-sitemap" => 590,
        "sitemap-xml" | "sitemap-loc" => 585,
        "web-manifest" | "json-manifest-path" => 540,
        "asset-manifest" => 555,
        "vite-manifest" => 555,
        "next-manifest" => 555,
        "openapi-route" => 640,
        _ => 0,
    }
}

fn normalize_discovered_path(
    base_url: &Url,
    current_path: &str,
    candidate: &str,
    policy: DiscoveryNormalizationPolicy,
) -> Option<String> {
    let candidate = candidate.trim();
    if candidate.is_empty() {
        return None;
    }

    let lowered = candidate.to_ascii_lowercase();
    if lowered.starts_with('#')
        || lowered.starts_with("data:")
        || lowered.starts_with("javascript:")
        || lowered.starts_with("mailto:")
        || lowered.starts_with("tel:")
        || lowered.starts_with("//")
    {
        return None;
    }

    let current_url = base_url.join(current_path.trim_start_matches('/')).ok()?;
    let mut resolved = current_url.join(candidate).ok()?;
    if !same_origin(base_url, &resolved) {
        return None;
    }

    resolved.set_query(None);
    resolved.set_fragment(None);
    let path = sanitize_paths(&[resolved.path().to_string()])
        .into_iter()
        .next()?;
    if !(is_interesting_discovered_path(&path)
        || matches!(policy, DiscoveryNormalizationPolicy::Authoritative)
            && is_authoritative_route_like_path(&path))
    {
        return None;
    }

    Some(path)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme().eq_ignore_ascii_case(right.scheme())
        && left
            .host_str()
            .zip(right.host_str())
            .map(|(left_host, right_host)| left_host.eq_ignore_ascii_case(right_host))
            .unwrap_or(false)
        && left.port_or_known_default() == right.port_or_known_default()
}

fn is_interesting_discovered_path(path: &str) -> bool {
    let lowered = path.trim().to_ascii_lowercase();
    if lowered.is_empty() || lowered == "/" {
        return false;
    }

    if lowered.starts_with("/.well-known/")
        || lowered.contains("/assets/")
        || lowered.contains("/static/")
        || lowered.contains("/_next/")
        || lowered.contains("/build/")
        || lowered.contains("/dist/")
    {
        return true;
    }

    if lowered == "/api"
        || lowered.contains("/api/")
        || lowered == "/graphql"
        || lowered.contains("/graphql/")
        || lowered.contains("graphiql")
        || lowered.contains("playground")
        || lowered == "/admin"
        || lowered.contains("/admin/")
        || lowered == "/internal"
        || lowered.contains("/internal/")
        || lowered.contains("actuator")
        || lowered == "/debug"
        || lowered.contains("/debug/")
    {
        return true;
    }

    const INTERESTING_SUFFIXES: &[&str] = &[
        ".js",
        ".map",
        ".json",
        ".txt",
        ".xml",
        ".yaml",
        ".yml",
        ".webmanifest",
        ".env",
    ];
    if INTERESTING_SUFFIXES
        .iter()
        .any(|suffix| lowered.ends_with(suffix))
    {
        return true;
    }

    const INTERESTING_NAME_FRAGMENTS: &[&str] = &[
        "manifest", "config", "settings", "openapi", "swagger", "api-docs", "runtime", "server",
        "env",
    ];
    INTERESTING_NAME_FRAGMENTS
        .iter()
        .any(|fragment| lowered.contains(fragment))
}

fn is_authoritative_route_like_path(path: &str) -> bool {
    let lowered = path.trim().to_ascii_lowercase();
    if lowered.is_empty() || lowered == "/" {
        return false;
    }

    let segments = lowered
        .trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.is_empty() || segments.len() > 4 {
        return false;
    }
    if segments.last().is_some_and(|segment| segment.contains('.')) {
        return false;
    }

    segments
        .iter()
        .all(|segment| !segment.is_empty() && segment.len() <= 48)
}

fn response_similarity_key(body: &str, path: &str) -> String {
    const RESPONSE_FINGERPRINT_SAMPLE_CHARS: usize = 8 * 1024;

    let normalized_path = path.trim().to_ascii_lowercase();
    let mut sample = body
        .chars()
        .take(RESPONSE_FINGERPRINT_SAMPLE_CHARS)
        .collect::<String>()
        .to_ascii_lowercase();
    if !normalized_path.is_empty() && sample.contains(&normalized_path) {
        sample = sample.replace(&normalized_path, "<path>");
    }

    let mut hasher = Sha256::new();
    let mut previous_was_whitespace = false;
    let mut compact_len = 0usize;
    for ch in sample.chars() {
        if ch.is_whitespace() {
            if previous_was_whitespace {
                continue;
            }
            previous_was_whitespace = true;
            hasher.update(b" ");
            compact_len += 1;
            continue;
        }

        previous_was_whitespace = false;
        compact_len += 1;
        let mut encoded = [0u8; 4];
        hasher.update(ch.encode_utf8(&mut encoded).as_bytes());
    }
    hasher.update(body.len().to_le_bytes());
    hasher.update(compact_len.to_le_bytes());

    let digest = hasher.finalize();
    let mut fingerprint = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut fingerprint, "{:02x}", byte)
            .expect("response fingerprint formatting should succeed");
    }
    fingerprint
}

async fn read_response_body(
    response: &mut reqwest::Response,
    max_bytes: usize,
) -> Result<(String, bool)> {
    let mut bytes = Vec::new();
    let mut truncated = false;

    while let Some(chunk) = response
        .chunk()
        .await
        .context("failed reading response body")?
    {
        let remaining = max_bytes.saturating_sub(bytes.len());
        if remaining == 0 {
            truncated = true;
            break;
        }

        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }

        bytes.extend_from_slice(&chunk);
    }

    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

fn is_textual_response(content_type: Option<&str>, body: &str) -> bool {
    if let Some(content_type) = content_type {
        let lowered = content_type.to_ascii_lowercase();
        if lowered.starts_with("text/")
            || lowered.contains("json")
            || lowered.contains("javascript")
            || lowered.contains("xml")
            || lowered.contains("yaml")
        {
            return true;
        }
        return false;
    }

    body.is_ascii()
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };

    use axum::{
        extract::{Path, State},
        http::{
            header::{self, CONTENT_TYPE},
            HeaderMap, StatusCode,
        },
        response::Html,
        routing::get,
        Router,
    };
    use chrono::Utc;
    use once_cell::sync::Lazy;
    use tokio::{net::TcpListener, sync::Mutex, task::JoinHandle};
    use url::Url;

    use super::{
        build_gobuster_word_candidates, discover_candidate_path_candidates,
        discover_candidate_paths, response_similarity_key, Fetcher,
    };
    use crate::{
        config::{AppConfig, ProxyMode, RequestProfileConfig, RequestProfileSecretRef},
        core::{CoverageSourceStat, DiscoveryProvenanceRecord, TargetRecord, TargetStrategy},
    };

    static TEST_ENV_COUNTER: AtomicUsize = AtomicUsize::new(1);
    static GLOBAL_ENV_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    fn coverage_source_stat<'a>(
        stats: &'a [CoverageSourceStat],
        source: &str,
    ) -> &'a CoverageSourceStat {
        stats
            .iter()
            .find(|entry| entry.source == source)
            .unwrap_or_else(|| panic!("missing coverage source {source}"))
    }

    async fn spawn_fetcher_test_server() -> (JoinHandle<()>, String) {
        let app = Router::new()
            .route(
                "/",
                get(|| async {
                    Html(
                        "<html><head><link rel=\"manifest\" href=\"/asset-manifest.json\"></head><body><script src=\"/assets/app.js\"></script></body></html>",
                    )
                }),
            )
            .route(
                "/assets/app.js",
                get(|| async {
                    (
                        [(CONTENT_TYPE, "application/javascript")],
                        "console.log('app');\n//# sourceMappingURL=app.js.map",
                    )
                }),
            )
            .route(
                "/assets/app.js.map",
                get(|| async {
                    (
                        [(CONTENT_TYPE, "application/json")],
                        "{\"version\":3,\"file\":\"app.js\"}",
                    )
                }),
            )
            .route(
                "/asset-manifest.json",
                get(|| async {
                    (
                        [(CONTENT_TYPE, "application/json")],
                        "{\"files\":{\"main.js\":\"/assets/app.js\"}}",
                    )
                }),
            );

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let address = listener
            .local_addr()
            .expect("test listener should report local addr");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("test server should stay available")
        });

        (handle, format!("http://{}", address))
    }

    async fn spawn_priority_discovery_test_server() -> (JoinHandle<()>, String) {
        let app = Router::new()
            .route(
                "/seed.js",
                get(|| async {
                    (
                        [(CONTENT_TYPE, "application/javascript")],
                        "console.log('seed');\n//# sourceMappingURL=seed.js.map\nwindow.__ENV__ = {\"runtime\":\"/runtime-config.json\"};",
                    )
                }),
            )
            .route(
                "/seed.js.map",
                get(|| async {
                    (
                        [(CONTENT_TYPE, "application/json")],
                        "{\"version\":3,\"file\":\"seed.js\"}",
                    )
                }),
            )
            .route(
                "/runtime-config.json",
                get(|| async {
                    (
                        [(CONTENT_TYPE, "application/json")],
                        "{\"apiBase\":\"/v1\"}",
                    )
                }),
            );

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("priority discovery listener should bind");
        let address = listener
            .local_addr()
            .expect("priority discovery listener should report local addr");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("priority discovery server should stay available")
        });

        (handle, format!("http://{}", address))
    }

    fn unique_test_env_key(prefix: &str) -> String {
        format!(
            "{}_{}",
            prefix,
            TEST_ENV_COUNTER.fetch_add(1, Ordering::SeqCst)
        )
    }

    async fn with_test_env_var<T, F, Fut>(key: &str, value: &str, action: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        unsafe {
            std::env::set_var(key, value);
        }
        let result = action().await;
        unsafe {
            std::env::remove_var(key);
        }
        result
    }

    async fn with_global_env_var<T, F, Fut>(key: &str, value: &str, action: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let _guard = GLOBAL_ENV_LOCK.lock().await;
        let prior_value = std::env::var(key).ok();
        unsafe {
            std::env::set_var(key, value);
        }
        let result = action().await;
        match prior_value {
            Some(previous) => unsafe {
                std::env::set_var(key, previous);
            },
            None => unsafe {
                std::env::remove_var(key);
            },
        }
        result
    }

    #[derive(Clone, Default)]
    struct AuthCapture {
        headers: Arc<Mutex<Vec<HeaderMap>>>,
    }

    async fn spawn_authenticated_fetch_test_server() -> (JoinHandle<()>, String, AuthCapture) {
        async fn auth_only(
            State(capture): State<AuthCapture>,
            headers: HeaderMap,
        ) -> (StatusCode, [(header::HeaderName, &'static str); 1], String) {
            capture.headers.lock().await.push(headers.clone());

            let bearer = headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok());
            let cookie = headers
                .get(axum::http::header::COOKIE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            let custom = headers
                .get("x-test-secret")
                .and_then(|value| value.to_str().ok());

            if bearer == Some("Bearer super-token")
                && cookie.contains("session_cookie=session-value")
                && custom == Some("custom-header-value")
            {
                (
                    StatusCode::OK,
                    [(CONTENT_TYPE, "application/json")],
                    "{\"ok\":true}".to_string(),
                )
            } else {
                (
                    StatusCode::UNAUTHORIZED,
                    [(CONTENT_TYPE, "text/plain")],
                    "missing auth".to_string(),
                )
            }
        }

        let capture = AuthCapture::default();
        let app = Router::new()
            .route("/secure.json", get(auth_only))
            .with_state(capture.clone());

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("auth listener should bind");
        let address = listener
            .local_addr()
            .expect("auth listener should report local addr");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("auth server should stay available")
        });

        (handle, format!("http://{}", address), capture)
    }

    #[derive(Clone)]
    struct ParallelismProbe {
        in_flight: Arc<AtomicUsize>,
        max_in_flight: Arc<AtomicUsize>,
    }

    async fn spawn_parallel_fetch_test_server() -> (JoinHandle<()>, String, Arc<AtomicUsize>) {
        async fn catch_all(
            State(probe): State<ParallelismProbe>,
            Path(path): Path<String>,
        ) -> ([(&'static str, &'static str); 1], String) {
            let request_path = format!("/{path}");
            if !request_path.contains("anyscan-control-") {
                let current = probe.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                record_max_parallelism(&probe.max_in_flight, current);
                tokio::time::sleep(Duration::from_millis(75)).await;
                probe.in_flight.fetch_sub(1, Ordering::SeqCst);
            }

            (
                [("content-type", "application/json")],
                format!("{{\"artifact\":\"{}\"}}", path.replace('/', "_")),
            )
        }

        let max_in_flight = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/{*path}", get(catch_all))
            .with_state(ParallelismProbe {
                in_flight: Arc::new(AtomicUsize::new(0)),
                max_in_flight: Arc::clone(&max_in_flight),
            });

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("parallel test listener should bind");
        let address = listener
            .local_addr()
            .expect("parallel test listener should report local addr");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("parallel test server should stay available")
        });

        (handle, format!("http://{}", address), max_in_flight)
    }

    #[derive(Clone)]
    struct BackoffProbe {
        request_times: Arc<Mutex<Vec<(String, Instant)>>>,
    }

    async fn spawn_backoff_test_server(
    ) -> (JoinHandle<()>, String, Arc<Mutex<Vec<(String, Instant)>>>) {
        async fn catch_all(
            State(probe): State<BackoffProbe>,
            Path(path): Path<String>,
        ) -> (StatusCode, [(&'static str, &'static str); 1], String) {
            let request_path = format!("/{path}");
            if !request_path.contains("anyscan-control-") {
                probe
                    .request_times
                    .lock()
                    .await
                    .push((request_path.clone(), Instant::now()));
            }

            let status = if request_path == "/throttle" {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::OK
            };
            (
                status,
                [("content-type", "text/plain")],
                format!("response for {request_path}"),
            )
        }

        let request_times = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/{*path}", get(catch_all))
            .with_state(BackoffProbe {
                request_times: Arc::clone(&request_times),
            });

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("backoff test listener should bind");
        let address = listener
            .local_addr()
            .expect("backoff test listener should report local addr");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("backoff test server should stay available")
        });

        (handle, format!("http://{}", address), request_times)
    }

    async fn spawn_gobuster_filter_test_server() -> (JoinHandle<()>, String) {
        async fn catch_all(
            Path(path): Path<String>,
        ) -> (StatusCode, [(&'static str, &'static str); 1], String) {
            let request_path = format!("/{path}");
            if request_path == "/admin" {
                return (
                    StatusCode::OK,
                    [("content-type", "application/json")],
                    "{\"admin\":true}".to_string(),
                );
            }

            (
                StatusCode::OK,
                [("content-type", "text/plain")],
                "not-found-template".to_string(),
            )
        }

        let app = Router::new().route("/{*path}", get(catch_all));

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("gobuster filter listener should bind");
        let address = listener
            .local_addr()
            .expect("gobuster filter listener should report local addr");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("gobuster filter server should stay available")
        });

        (handle, format!("http://{}", address))
    }

    fn record_max_parallelism(max_value: &AtomicUsize, candidate: usize) {
        let mut observed = max_value.load(Ordering::SeqCst);
        while candidate > observed {
            match max_value.compare_exchange(
                observed,
                candidate,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(actual) => observed = actual,
            }
        }
    }

    #[test]
    fn discovered_paths_stay_same_origin_and_filter_uninteresting_links() {
        let base_url = Url::parse("https://app.example.com").expect("base url should parse");
        let body = r#"
            <script src="/assets/app.js"></script>
            <a href="/about">About</a>
            <link rel="manifest" href="/asset-manifest.json">
            //# sourceMappingURL=app.js.map
            {"config":"/runtime-config.json","external":"https://cdn.example.com/app.js"}
        "#;

        let discovered = discover_candidate_paths(&base_url, "/", body);
        assert!(discovered.contains(&"/assets/app.js".to_string()));
        assert!(discovered.contains(&"/asset-manifest.json".to_string()));
        assert!(discovered.contains(&"/app.js.map".to_string()));
        assert!(discovered.contains(&"/runtime-config.json".to_string()));
        assert!(!discovered.contains(&"/about".to_string()));
    }

    #[test]
    fn discovered_paths_semantically_expand_framework_and_config_variants() {
        let base_url = Url::parse("https://app.example.com").expect("base url should parse");
        let body = r#"
            <script src="/assets/app.js"></script>
            <script type="module" src="/@vite/client"></script>
            <script>
                window.__ENV__ = {"runtime":"runtime-config.json"};
                window.__NEXT_DATA__ = {"buildId":"abc123"};
            </script>
        "#;

        let discovered = discover_candidate_paths(&base_url, "/", body);
        assert!(discovered.contains(&"/assets/app.js".to_string()));
        assert!(discovered.contains(&"/assets/app.js.map".to_string()));
        assert!(discovered.contains(&"/runtime-config.json".to_string()));
        assert!(discovered.contains(&"/runtime-config.js".to_string()));
        assert!(discovered.contains(&"/vite.manifest.json".to_string()));
        assert!(discovered.contains(&"/_next/build-manifest.json".to_string()));
    }

    #[test]
    fn discovered_paths_keep_same_ip_and_port_origin() {
        let base_url =
            Url::parse("https://10.0.0.5:8443").expect("base url with explicit port should parse");
        let body = r#"
            {"same_port":"https://10.0.0.5:8443/runtime-config.json","other_port":"https://10.0.0.5:9443/secrets.env"}
        "#;

        let discovered = discover_candidate_paths(&base_url, "/", body);
        assert!(discovered.contains(&"/runtime-config.json".to_string()));
        assert!(!discovered.contains(&"/secrets.env".to_string()));
    }

    #[test]
    fn discovered_paths_parse_robots_txt_directives() {
        let base_url = Url::parse("https://app.example.com").expect("base url should parse");
        let body = "User-agent: *\nAllow: /admin/config\nDisallow: /backup/config.json.bak\nSitemap: /sitemap.xml\n";

        let discovered = discover_candidate_path_candidates(&base_url, "/robots.txt", 0, body);
        let sitemap = discovered
            .iter()
            .find(|candidate| candidate.path == "/sitemap.xml")
            .expect("sitemap hint should be discovered from robots.txt");
        let allow = discovered
            .iter()
            .find(|candidate| candidate.path == "/admin/config")
            .expect("allow directive should be discovered from robots.txt");
        let disallow = discovered
            .iter()
            .find(|candidate| candidate.path == "/backup/config.json.bak")
            .expect("disallow directive should be discovered from robots.txt");

        assert_eq!(sitemap.source, "robots-sitemap");
        assert!(sitemap.score >= 900);
        assert_eq!(allow.source, "robots-allow");
        assert_eq!(disallow.source, "robots-disallow");
    }

    #[test]
    fn gobuster_word_candidates_expand_extensions_patterns_and_backups() {
        let mut config = AppConfig::default();
        config.scan.gobuster.enabled = true;
        config.scan.gobuster.wordlist = vec!["admin".to_string()];
        config.scan.gobuster.patterns = vec!["backup/{GOBUSTER}".to_string()];
        config.scan.gobuster.extensions = vec!["php".to_string(), "json".to_string()];
        config.scan.gobuster.add_slash = true;
        config.scan.gobuster.discover_backup = true;
        config.validate().expect("gobuster config should validate");

        let candidates = build_gobuster_word_candidates("admin", &config.scan.gobuster)
            .into_iter()
            .map(|candidate| candidate.path)
            .collect::<Vec<_>>();

        assert!(candidates.contains(&"/admin".to_string()));
        assert!(candidates.contains(&"/admin/".to_string()));
        assert!(candidates.contains(&"/admin.php".to_string()));
        assert!(candidates.contains(&"/admin.json".to_string()));
        assert!(candidates.contains(&"/admin.bak".to_string()));
        assert!(candidates.contains(&"/backup/admin".to_string()));
    }

    #[test]
    fn discovered_paths_parse_sitemap_xml_locations() {
        let base_url = Url::parse("https://app.example.com").expect("base url should parse");
        let body = r#"
            <urlset>
                <url><loc>https://app.example.com/assets/app.js</loc></url>
                <url><loc>/openapi.json</loc></url>
            </urlset>
        "#;

        let discovered = discover_candidate_path_candidates(&base_url, "/sitemap.xml", 0, body);
        let asset = discovered
            .iter()
            .find(|candidate| candidate.path == "/assets/app.js")
            .expect("asset location should be discovered from sitemap xml");
        let schema = discovered
            .iter()
            .find(|candidate| candidate.path == "/openapi.json")
            .expect("schema location should be discovered from sitemap xml");

        assert_eq!(asset.source, "sitemap-xml");
        assert!(asset.score >= super::AUTHORITATIVE_DISCOVERY_MIN_COVERAGE_SCORE);
        assert_eq!(schema.source, "sitemap-xml");
    }

    #[test]
    fn discovered_paths_parse_asset_and_web_manifests_as_authoritative_sources() {
        let base_url = Url::parse("https://app.example.com").expect("base url should parse");
        let asset_manifest =
            r#"{"files":{"main.js":"/assets/app.js","runtime":"assets/runtime.js"}}"#;
        let discovered_assets = discover_candidate_path_candidates(
            &base_url,
            "/asset-manifest.json",
            0,
            asset_manifest,
        );
        let bundle = discovered_assets
            .iter()
            .find(|candidate| candidate.path == "/assets/app.js")
            .expect("asset manifest should emit the main bundle path");
        let runtime = discovered_assets
            .iter()
            .find(|candidate| candidate.path == "/assets/runtime.js")
            .expect("asset manifest should resolve relative runtime bundle paths");

        assert_eq!(bundle.source, "asset-manifest");
        assert!(bundle.score >= 930);
        assert_eq!(runtime.source, "asset-manifest");

        let web_manifest = r#"{"related_applications":[{"url":"/openapi.json"}],"shortcuts":[{"url":"/service-worker.js"}]}"#;
        let discovered_manifest =
            discover_candidate_path_candidates(&base_url, "/site.webmanifest", 0, web_manifest);
        let schema = discovered_manifest
            .iter()
            .find(|candidate| candidate.path == "/openapi.json")
            .expect("web manifest should emit related application urls");
        let service_worker = discovered_manifest
            .iter()
            .find(|candidate| candidate.path == "/service-worker.js")
            .expect("web manifest should emit shortcut urls when they are interesting");

        assert_eq!(schema.source, "web-manifest");
        assert!(schema.score >= 900);
        assert_eq!(service_worker.source, "web-manifest");
    }

    #[test]
    fn discovered_paths_parse_openapi_json_routes_and_template_prefixes() {
        let base_url = Url::parse("https://app.example.com").expect("base url should parse");
        let body = r#"
            {
              "openapi": "3.1.0",
              "servers": [{"url": "/api/v1"}],
              "paths": {
                "/users/{id}": {"get": {}},
                "/admin/config": {"get": {}}
              }
            }
        "#;

        let discovered = discover_candidate_path_candidates(&base_url, "/openapi.json", 0, body);
        let user_collection = discovered
            .iter()
            .find(|candidate| candidate.path == "/api/v1/users")
            .expect("openapi routes should normalize path templates into collection paths");
        let admin_config = discovered
            .iter()
            .find(|candidate| candidate.path == "/api/v1/admin/config")
            .expect("openapi routes should honor server base path prefixes");

        assert_eq!(user_collection.source, "openapi-route");
        assert!(user_collection.score >= 700);
        assert_eq!(admin_config.source, "openapi-route");
    }

    #[test]
    fn discovered_paths_parse_openapi_yaml_routes() {
        let base_url = Url::parse("https://app.example.com").expect("base url should parse");
        let body = r#"
openapi: 3.0.0
servers:
  - url: /service
paths:
  /graphql:
    get: {}
  /health:
    get: {}
        "#;

        let discovered = discover_candidate_path_candidates(&base_url, "/openapi.yaml", 0, body);
        let graphql = discovered
            .iter()
            .find(|candidate| candidate.path == "/service/graphql")
            .expect("yaml openapi routes should be discovered");
        let health = discovered
            .iter()
            .find(|candidate| candidate.path == "/service/health")
            .expect("yaml openapi server prefixes should be applied");

        assert_eq!(graphql.source, "openapi-route");
        assert_eq!(health.source, "openapi-route");
    }

    #[test]
    fn discovered_paths_adaptively_expand_host_and_route_prefixes() {
        let base_url = Url::parse("https://api.example.com").expect("base url should parse");
        let body = "<html><body>hello</body></html>";

        let discovered = discover_candidate_paths(&base_url, "/docs/index.html", body);
        assert!(discovered.contains(&"/api/openapi.json".to_string()));
        assert!(discovered.contains(&"/api/graphql".to_string()));
        assert!(discovered.contains(&"/docs/openapi.json".to_string()));
    }

    #[test]
    fn auto_strategy_initial_candidates_prioritize_high_value_persisted_discovery() {
        let fetcher = Fetcher::new(&AppConfig::default()).expect("fetcher should build");
        let target = TargetRecord {
            id: 99,
            label: "priority".to_string(),
            base_url: "https://app.example.com".to_string(),
            paths: vec!["/".to_string()],
            tags: Vec::new(),
            request_profile: None,
            gobuster: Default::default(),
            strategy: TargetStrategy::Auto,
            discovery_provenance: vec![DiscoveryProvenanceRecord {
                path: "/assets/app.js".to_string(),
                source: "asset-manifest".to_string(),
                score: 930,
                depth: 1,
                first_seen_at: None,
                last_seen_at: None,
            }],
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let candidates = fetcher.initial_target_candidates(&target);
        assert_eq!(
            candidates.first().map(|candidate| candidate.path.as_str()),
            Some("/assets/app.js")
        );
        assert!(candidates.iter().any(|candidate| candidate.path == "/"));
    }

    #[test]
    fn response_similarity_key_ignores_requested_path_noise() {
        let first = response_similarity_key("missing resource at /assets/a.js", "/assets/a.js");
        let second = response_similarity_key("missing resource at /assets/b.js", "/assets/b.js");

        assert_eq!(first, second);
    }

    #[tokio::test]
    async fn fetch_target_rejects_targets_outside_explicit_ip_port_allowlists() {
        let (server, base_url) = spawn_fetcher_test_server().await;
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes.clear();
        config.inventory.allowed_hosts = vec!["127.0.0.1".to_string()];
        config.inventory.allowed_ports = vec![1];
        config.scan.max_paths_per_target = 1;
        config.scan.enable_path_discovery = false;
        let fetcher = Fetcher::new(&config).expect("fetcher should build");
        let target = TargetRecord {
            id: 12,
            label: "ip-port-guard".to_string(),
            base_url,
            paths: vec!["/".to_string()],
            tags: Vec::new(),
            request_profile: None,
            gobuster: Default::default(),
            strategy: TargetStrategy::Hybrid,
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let error = fetcher
            .fetch_target(&target)
            .await
            .expect_err("disallowed target port should fail fast");
        assert!(error
            .to_string()
            .contains("outside configured inventory host and port allowlists"));

        server.abort();
    }

    #[tokio::test]
    async fn fetch_target_applies_request_profile_credentials() {
        let (server, base_url, capture) = spawn_authenticated_fetch_test_server().await;
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes = vec!["127.0.0.1".to_string()];
        config.scan.max_paths_per_target = 1;
        config.scan.enable_path_discovery = false;
        config.scan.allow_authenticated_request_profiles = true;
        let header_env = unique_test_env_key("ANYSCAN_RUNTIME_TEST_HEADER");
        let cookie_env = unique_test_env_key("ANYSCAN_RUNTIME_TEST_COOKIE");
        let token_env = unique_test_env_key("ANYSCAN_RUNTIME_TEST_TOKEN");
        config.inventory.request_profiles = vec![RequestProfileConfig {
            name: "private-api".to_string(),
            headers: vec![RequestProfileSecretRef {
                name: "x-test-secret".to_string(),
                env: header_env.clone(),
            }],
            cookies: vec![RequestProfileSecretRef {
                name: "session_cookie".to_string(),
                env: cookie_env.clone(),
            }],
            bearer_token_env: Some(token_env.clone()),
        }];
        let target = TargetRecord {
            id: 10,
            label: "authenticated".to_string(),
            base_url,
            paths: vec!["/secure.json".to_string()],
            tags: Vec::new(),
            request_profile: Some("private-api".to_string()),
            gobuster: Default::default(),
            strategy: TargetStrategy::Hybrid,
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let report = with_test_env_var(&header_env, "custom-header-value", || async {
            with_test_env_var(&cookie_env, "session-value", || async {
                with_test_env_var(&token_env, "super-token", || async {
                    let fetcher = Fetcher::new(&config).expect("fetcher should build");
                    fetcher.fetch_target(&target).await
                })
                .await
            })
            .await
        })
        .await
        .expect("authenticated target fetch should succeed");
        let captured = capture.headers.lock().await;
        let auth_request = captured
            .iter()
            .find(|headers| {
                headers
                    .get(axum::http::header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    .is_some()
            })
            .expect("authenticated request should be captured");

        assert_eq!(report.documents.len(), 1);
        assert_eq!(report.documents[0].path, "/secure.json");
        assert_eq!(report.telemetry.request_count, 2);
        assert_eq!(
            auth_request
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some("Bearer super-token")
        );
        assert_eq!(
            auth_request
                .get("x-test-secret")
                .and_then(|value| value.to_str().ok()),
            Some("custom-header-value")
        );
        assert!(auth_request
            .get(axum::http::header::COOKIE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|cookie| cookie.contains("session_cookie=session-value")));

        drop(captured);
        server.abort();
    }

    #[tokio::test]
    async fn fetch_target_fails_when_request_profile_secret_missing() {
        let (_server, base_url, _capture) = spawn_authenticated_fetch_test_server().await;
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes = vec!["127.0.0.1".to_string()];
        config.scan.max_paths_per_target = 1;
        config.scan.enable_path_discovery = false;
        config.scan.allow_authenticated_request_profiles = true;
        let missing_env = unique_test_env_key("ANYSCAN_RUNTIME_TEST_MISSING");
        config.inventory.request_profiles = vec![RequestProfileConfig {
            name: "missing-secret-profile".to_string(),
            headers: vec![RequestProfileSecretRef {
                name: "x-test-secret".to_string(),
                env: missing_env.clone(),
            }],
            cookies: Vec::new(),
            bearer_token_env: None,
        }];
        let fetcher = Fetcher::new(&config).expect("fetcher should build");
        let target = TargetRecord {
            id: 11,
            label: "missing-secret".to_string(),
            base_url,
            paths: vec!["/secure.json".to_string()],
            tags: Vec::new(),
            request_profile: Some("missing-secret-profile".to_string()),
            gobuster: Default::default(),
            strategy: TargetStrategy::Hybrid,
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let error = fetcher
            .fetch_target(&target)
            .await
            .expect_err("missing request profile env should fail fetch")
            .to_string();

        assert!(
            error.contains(&missing_env),
            "expected missing env key in error, got {error}"
        );
        assert!(
            error.contains("request profile"),
            "expected request profile context in error, got {error}"
        );
    }

    #[tokio::test]
    async fn fetch_target_direct_only_ignores_proxy_environment() {
        let (server, base_url) = spawn_fetcher_test_server().await;
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes = vec!["127.0.0.1".to_string()];
        config.scan.max_paths_per_target = 1;
        config.scan.max_discovered_paths_per_target = 1;
        config.scan.enable_path_discovery = false;
        config.scan.proxy_mode = ProxyMode::DirectOnly;
        let target = TargetRecord {
            id: 13,
            label: "direct-only".to_string(),
            base_url,
            paths: vec!["/".to_string()],
            tags: Vec::new(),
            request_profile: None,
            gobuster: Default::default(),
            strategy: TargetStrategy::Hybrid,
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let report = with_global_env_var("HTTP_PROXY", "http://127.0.0.1:9", || async {
            let fetcher = Fetcher::new(&config).expect("direct-only fetcher should build");
            fetcher.fetch_target(&target).await
        })
        .await
        .expect("direct-only fetch should bypass broken proxy environment");

        assert_eq!(report.documents.len(), 1);
        assert_eq!(report.telemetry.request_count, 2);
        assert_eq!(report.telemetry.request_error_count, 0);

        server.abort();
    }

    #[tokio::test]
    async fn fetch_target_proxy_then_direct_falls_back_when_proxy_is_unreachable() {
        let (server, base_url) = spawn_fetcher_test_server().await;
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes = vec!["127.0.0.1".to_string()];
        config.scan.max_paths_per_target = 1;
        config.scan.max_discovered_paths_per_target = 1;
        config.scan.enable_path_discovery = false;
        config.scan.proxy_mode = ProxyMode::ProxyThenDirect;
        config.scan.proxy_url = Some("http://127.0.0.1:9".to_string());
        config
            .validate()
            .expect("proxy fallback config should validate");
        let fetcher = Fetcher::new(&config).expect("proxy fallback fetcher should build");
        let target = TargetRecord {
            id: 14,
            label: "proxy-fallback".to_string(),
            base_url,
            paths: vec!["/".to_string()],
            tags: Vec::new(),
            request_profile: None,
            gobuster: Default::default(),
            strategy: TargetStrategy::Hybrid,
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let report = fetcher
            .fetch_target(&target)
            .await
            .expect("proxy fallback fetch should succeed");

        assert_eq!(report.documents.len(), 1);
        assert_eq!(report.telemetry.request_count, 4);
        assert_eq!(report.telemetry.request_error_count, 2);

        server.abort();
    }

    #[tokio::test]
    async fn fetch_target_uses_bounded_parallel_path_fetching() {
        let (server, base_url, max_in_flight) = spawn_parallel_fetch_test_server().await;
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes = vec!["127.0.0.1".to_string()];
        config.scan.max_paths_per_target = 3;
        config.scan.max_parallel_paths_per_target = 3;
        config.scan.enable_path_discovery = false;
        let fetcher = Fetcher::new(&config).expect("fetcher should build");
        let target = TargetRecord {
            id: 7,
            label: "parallel".to_string(),
            base_url,
            paths: vec![
                "/alpha".to_string(),
                "/beta".to_string(),
                "/gamma".to_string(),
            ],
            tags: Vec::new(),
            request_profile: None,
            gobuster: Default::default(),
            strategy: TargetStrategy::Hybrid,
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let report = fetcher
            .fetch_target(&target)
            .await
            .expect("parallel target fetch should succeed");

        assert_eq!(report.documents.len(), 3);
        assert_eq!(report.telemetry.request_count, 4);
        assert!(max_in_flight.load(Ordering::SeqCst) >= 2);

        server.abort();
    }

    #[tokio::test]
    async fn fetch_target_caps_concurrency_per_host_across_targets() {
        let (server, base_url, max_in_flight) = spawn_parallel_fetch_test_server().await;
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes = vec!["127.0.0.1".to_string()];
        config.scan.max_paths_per_target = 2;
        config.scan.max_parallel_paths_per_target = 2;
        config.scan.max_concurrent_requests_per_host = 1;
        config.scan.enable_path_discovery = false;
        let fetcher = Fetcher::new(&config).expect("fetcher should build");
        let target_a = TargetRecord {
            id: 7,
            label: "parallel-a".to_string(),
            base_url: base_url.clone(),
            paths: vec!["/alpha".to_string(), "/beta".to_string()],
            tags: Vec::new(),
            request_profile: None,
            gobuster: Default::default(),
            strategy: TargetStrategy::Hybrid,
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let target_b = TargetRecord {
            id: 8,
            label: "parallel-b".to_string(),
            base_url,
            paths: vec!["/gamma".to_string(), "/delta".to_string()],
            tags: Vec::new(),
            request_profile: None,
            gobuster: Default::default(),
            strategy: TargetStrategy::Hybrid,
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let (report_a, report_b) = tokio::join!(
            fetcher.fetch_target(&target_a),
            fetcher.fetch_target(&target_b)
        );
        let report_a = report_a.expect("first host-capped target fetch should succeed");
        let report_b = report_b.expect("second host-capped target fetch should succeed");

        assert_eq!(report_a.documents.len(), 2);
        assert_eq!(report_b.documents.len(), 2);
        assert_eq!(max_in_flight.load(Ordering::SeqCst), 1);

        server.abort();
    }

    #[tokio::test]
    async fn fetch_target_applies_adaptive_host_backoff_after_throttle() {
        let (server, base_url, request_times) = spawn_backoff_test_server().await;
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes = vec!["127.0.0.1".to_string()];
        config.scan.max_paths_per_target = 2;
        config.scan.max_parallel_paths_per_target = 1;
        config.scan.max_concurrent_requests_per_host = 1;
        config.scan.host_backoff_initial_ms = 80;
        config.scan.host_backoff_max_ms = 80;
        config.scan.enable_path_discovery = false;
        let fetcher = Fetcher::new(&config).expect("fetcher should build");
        let target = TargetRecord {
            id: 9,
            label: "backoff".to_string(),
            base_url,
            paths: vec!["/throttle".to_string(), "/ok".to_string()],
            tags: Vec::new(),
            request_profile: None,
            gobuster: Default::default(),
            strategy: TargetStrategy::Hybrid,
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let report = fetcher
            .fetch_target(&target)
            .await
            .expect("backoff target fetch should succeed");
        let request_times = request_times.lock().await.clone();
        let throttled_at = request_times
            .iter()
            .find_map(|(path, instant)| (path == "/throttle").then_some(*instant))
            .expect("throttled path should be requested");
        let ok_at = request_times
            .iter()
            .find_map(|(path, instant)| (path == "/ok").then_some(*instant))
            .expect("ok path should be requested");

        assert_eq!(report.telemetry.request_count, 3);
        assert!(
            ok_at.duration_since(throttled_at) >= Duration::from_millis(70),
            "expected host backoff between requests, observed {:?}",
            ok_at.duration_since(throttled_at)
        );

        server.abort();
    }

    #[tokio::test]
    async fn fetch_target_manual_strategy_skips_live_discovery() {
        let (server, base_url) = spawn_fetcher_test_server().await;
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes = vec!["127.0.0.1".to_string()];
        config.scan.max_paths_per_target = 4;
        config.scan.max_discovered_paths_per_target = 3;
        let fetcher = Fetcher::new(&config).expect("fetcher should build");
        let target = TargetRecord {
            id: 2,
            label: "manual".to_string(),
            base_url,
            strategy: TargetStrategy::Manual,
            paths: vec!["/".to_string()],
            tags: Vec::new(),
            request_profile: None,
            gobuster: Default::default(),
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let report = fetcher
            .fetch_target(&target)
            .await
            .expect("manual target fetch should succeed");
        let fetched_paths = report
            .documents
            .iter()
            .map(|document| document.path.clone())
            .collect::<Vec<_>>();

        assert_eq!(fetched_paths, vec!["/".to_string()]);
        assert!(report.discovered_paths.is_empty());

        server.abort();
    }

    #[tokio::test]
    async fn fetch_target_auto_strategy_reuses_persisted_discovery_paths() {
        let (server, base_url) = spawn_fetcher_test_server().await;
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes = vec!["127.0.0.1".to_string()];
        config.scan.max_paths_per_target = 2;
        config.scan.enable_path_discovery = false;
        let fetcher = Fetcher::new(&config).expect("fetcher should build");
        let target = TargetRecord {
            id: 3,
            label: "auto".to_string(),
            base_url,
            strategy: TargetStrategy::Auto,
            paths: vec!["/".to_string()],
            tags: Vec::new(),
            request_profile: None,
            gobuster: Default::default(),
            discovery_provenance: vec![DiscoveryProvenanceRecord {
                path: "/assets/app.js".to_string(),
                source: "persisted-html-link".to_string(),
                score: 920,
                depth: 1,
                first_seen_at: None,
                last_seen_at: None,
            }],
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let report = fetcher
            .fetch_target(&target)
            .await
            .expect("auto target fetch should succeed");
        let fetched_paths = report
            .documents
            .iter()
            .map(|document| document.path.clone())
            .collect::<Vec<_>>();

        assert!(fetched_paths.contains(&"/".to_string()));
        assert!(fetched_paths.contains(&"/assets/app.js".to_string()));
        assert!(report.discovered_paths.is_empty());

        let persisted_document = report
            .documents
            .iter()
            .find(|document| document.path == "/assets/app.js")
            .expect("persisted discovery path should be fetched");
        assert_eq!(persisted_document.coverage_source, "persisted-html-link");
        let persisted_source =
            coverage_source_stat(&report.telemetry.coverage_sources, "persisted-html-link");
        assert_eq!(persisted_source.queued_paths, 1);
        assert_eq!(persisted_source.requested_paths, 1);
        assert_eq!(persisted_source.documents_scanned, 1);

        server.abort();
    }

    #[tokio::test]
    async fn fetch_target_prioritizes_high_scoring_discoveries_and_reports_metadata() {
        let (server, base_url) = spawn_priority_discovery_test_server().await;
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes = vec!["127.0.0.1".to_string()];
        config.scan.max_paths_per_target = 2;
        config.scan.max_discovered_paths_per_target = 1;
        let fetcher = Fetcher::new(&config).expect("fetcher should build");
        let target = TargetRecord {
            id: 33,
            label: "priority-discovery".to_string(),
            base_url,
            paths: vec!["/seed.js".to_string()],
            tags: Vec::new(),
            request_profile: None,
            gobuster: Default::default(),
            strategy: TargetStrategy::Hybrid,
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let report = fetcher
            .fetch_target(&target)
            .await
            .expect("target fetch should succeed");
        let fetched_paths = report
            .documents
            .iter()
            .map(|document| document.path.clone())
            .collect::<Vec<_>>();

        assert!(fetched_paths.contains(&"/seed.js".to_string()));
        assert!(fetched_paths.contains(&"/seed.js.map".to_string()));
        assert!(!fetched_paths.contains(&"/runtime-config.json".to_string()));
        assert_eq!(report.discovered_paths.len(), 1);
        assert_eq!(report.discovered_paths[0].path, "/seed.js.map");
        assert_eq!(report.discovered_paths[0].source, "source-map-hint");
        assert_eq!(report.discovered_paths[0].score, 960);
        assert_eq!(report.discovered_paths[0].depth, 1);

        server.abort();
    }

    #[tokio::test]
    async fn fetch_target_discovers_linked_assets_and_source_maps() {
        let (server, base_url) = spawn_fetcher_test_server().await;
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes = vec!["127.0.0.1".to_string()];
        config.scan.max_paths_per_target = 4;
        config.scan.max_discovered_paths_per_target = 3;
        let fetcher = Fetcher::new(&config).expect("fetcher should build");
        let target = TargetRecord {
            id: 1,
            label: "local".to_string(),
            base_url,
            paths: vec!["/".to_string()],
            tags: Vec::new(),
            request_profile: None,
            gobuster: Default::default(),
            strategy: TargetStrategy::Hybrid,
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let report = fetcher
            .fetch_target(&target)
            .await
            .expect("target fetch should succeed");
        let fetched_paths = report
            .documents
            .iter()
            .map(|document| document.path.clone())
            .collect::<Vec<_>>();

        assert!(fetched_paths.contains(&"/".to_string()));
        assert!(fetched_paths.contains(&"/asset-manifest.json".to_string()));
        assert!(fetched_paths.contains(&"/assets/app.js".to_string()));
        assert!(fetched_paths.contains(&"/assets/app.js.map".to_string()));
        assert_eq!(report.telemetry.request_count, 5);

        let root_document = report
            .documents
            .iter()
            .find(|document| document.path == "/")
            .expect("root document should be fetched");
        assert_eq!(root_document.coverage_source, "target-seed");
        let app_document = report
            .documents
            .iter()
            .find(|document| document.path == "/assets/app.js")
            .expect("app bundle should be fetched");
        assert_eq!(app_document.coverage_source, "html-link");
        let source_map_document = report
            .documents
            .iter()
            .find(|document| document.path == "/assets/app.js.map")
            .expect("source map should be fetched");
        assert_eq!(source_map_document.coverage_source, "derived-source-map");

        let target_seed = coverage_source_stat(&report.telemetry.coverage_sources, "target-seed");
        assert_eq!(target_seed.queued_paths, 1);
        assert_eq!(target_seed.requested_paths, 1);
        assert_eq!(target_seed.documents_scanned, 1);
        let html_link = coverage_source_stat(&report.telemetry.coverage_sources, "html-link");
        assert_eq!(html_link.queued_paths, 2);
        assert_eq!(html_link.requested_paths, 2);
        assert_eq!(html_link.documents_scanned, 2);
        assert_eq!(html_link.discovered_paths, 2);
        let source_map =
            coverage_source_stat(&report.telemetry.coverage_sources, "derived-source-map");
        assert_eq!(source_map.queued_paths, 1);
        assert_eq!(source_map.requested_paths, 1);
        assert_eq!(source_map.documents_scanned, 1);
        assert_eq!(source_map.discovered_paths, 1);
        server.abort();
    }

    #[tokio::test]
    async fn fetch_target_respects_discovery_budget() {
        let (server, base_url) = spawn_fetcher_test_server().await;
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes = vec!["127.0.0.1".to_string()];
        config.scan.max_paths_per_target = 3;
        config.scan.max_discovered_paths_per_target = 1;
        let fetcher = Fetcher::new(&config).expect("fetcher should build");
        let target = TargetRecord {
            id: 1,
            label: "local".to_string(),
            base_url,
            paths: vec!["/".to_string()],
            tags: Vec::new(),
            request_profile: None,
            gobuster: Default::default(),
            strategy: TargetStrategy::Hybrid,
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let report = fetcher
            .fetch_target(&target)
            .await
            .expect("target fetch should succeed");
        let fetched_paths = report
            .documents
            .iter()
            .map(|document| document.path.clone())
            .collect::<Vec<_>>();

        assert!(fetched_paths.contains(&"/".to_string()));
        assert!(
            fetched_paths.contains(&"/asset-manifest.json".to_string())
                || fetched_paths.contains(&"/assets/app.js".to_string())
        );
        assert!(!fetched_paths.contains(&"/assets/app.js.map".to_string()));
        assert_eq!(report.telemetry.request_count, 3);

        server.abort();
    }

    #[tokio::test]
    async fn fetch_target_gobuster_filters_wildcard_like_responses() {
        let (server, base_url) = spawn_gobuster_filter_test_server().await;
        let mut config = AppConfig::default();
        config.inventory.allowed_host_suffixes = vec!["127.0.0.1".to_string()];
        config.scan.enable_path_discovery = false;
        config.scan.max_paths_per_target = 8;
        config.scan.max_discovered_paths_per_target = 8;
        config.scan.gobuster.enabled = true;
        config.scan.gobuster.wordlist = vec!["admin".to_string(), "missing".to_string()];
        config.validate().expect("gobuster config should validate");
        let fetcher = Fetcher::new(&config).expect("fetcher should build");
        let target = TargetRecord {
            id: 44,
            label: "gobuster".to_string(),
            base_url,
            paths: vec!["/".to_string()],
            tags: Vec::new(),
            request_profile: None,
            gobuster: Default::default(),
            strategy: TargetStrategy::Hybrid,
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let report = fetcher
            .fetch_target(&target)
            .await
            .expect("gobuster target fetch should succeed");
        let fetched_paths = report
            .documents
            .iter()
            .map(|document| document.path.clone())
            .collect::<Vec<_>>();

        assert!(fetched_paths.contains(&"/admin".to_string()));
        assert!(!fetched_paths.contains(&"/missing".to_string()));
        assert!(
            coverage_source_stat(&report.telemetry.coverage_sources, "gobuster-wordlist")
                .queued_paths
                >= 2
        );

        server.abort();
    }
}

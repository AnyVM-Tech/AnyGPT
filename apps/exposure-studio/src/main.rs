use std::{collections::HashMap, env, net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    extract::State,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use reqwest::{header, Client, Url};
use serde::de::DeserializeOwned;
use tokio::fs;
use tokio::net::lookup_host;
use tower_http::services::{ServeDir, ServeFile};

mod models;

use models::{
    ApprovedAssetResource,
    ApprovedResource,
    ApprovedResourceScanResult,
    Asset,
    ComplianceSource,
    DashboardSummary,
    EnrichedFinding,
    FindingAssetContext,
    Finding,
    ImplementationResearchLane,
    ProductBrief,
    WebsiteResearchLane,
    YouTubeResearchLane,
    SecurityTxtSummary,
    TestingMethodology,
    VulnerabilityIntelligence,
};

#[derive(Clone)]
struct AppState {
    assets: Arc<Vec<Asset>>,
    findings: Arc<Vec<Finding>>,
    compliance_sources: Arc<Vec<ComplianceSource>>,
    testing_methodologies: Arc<Vec<TestingMethodology>>,
    vulnerability_intelligence: Arc<Vec<VulnerabilityIntelligence>>,
    website_research_lane: Arc<WebsiteResearchLane>,
    youtube_research_lane: Arc<YouTubeResearchLane>,
    implementation_research_lane: Arc<ImplementationResearchLane>,
    summary: Arc<DashboardSummary>,
    product_brief: Arc<ProductBrief>,
}

fn app_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn data_root() -> PathBuf {
    app_root().join("data")
}

fn generated_lane_root() -> PathBuf {
    data_root().join(".generated")
}

fn lane_output_path(env_var_name: &str, file_name: &str) -> PathBuf {
    env::var(env_var_name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| generated_lane_root().join(file_name))
}

fn build_scan_client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(std::time::Duration::from_secs(5))
        .user_agent("SurfaceScope/0.1 approved-resource-scan")
        .build()
        .map_err(|error| format!("failed to build scan client: {error}"))
}

async fn load_json<T>(file_name: &str) -> Result<Vec<T>, String>
where
    T: DeserializeOwned,
{
    let path = data_root().join(file_name);
    let raw = fs::read_to_string(&path)
        .await
        .map_err(|error| format!("failed to read {}: {}", path.display(), error))?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("failed to parse {}: {}", path.display(), error))
}

async fn load_optional_struct<T>(path: PathBuf) -> Result<Option<T>, String>
where
    T: DeserializeOwned,
{
    match fs::read_to_string(&path).await {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|error| format!("failed to parse {}: {}", path.display(), error)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to read {}: {}", path.display(), error)),
    }
}

async fn build_state() -> Result<AppState, String> {
    let assets: Vec<Asset> = load_json("assets.json").await?;
    let findings: Vec<Finding> = load_json("findings.json").await?;
    let compliance_sources: Vec<ComplianceSource> = load_json("compliance_sources.json").await?;
    let testing_methodologies: Vec<TestingMethodology> = load_json("testing_methodologies.json").await?;
    let vulnerability_intelligence: Vec<VulnerabilityIntelligence> = load_json("vulnerability_intelligence.json").await?;
    let website_research_lane = load_optional_struct::<WebsiteResearchLane>(lane_output_path(
        "WEBSITE_LANE_OUTPUT",
        "website_implementation_lane.json",
    ))
    .await?
    .unwrap_or_default();
    let youtube_research_lane = load_optional_struct::<YouTubeResearchLane>(lane_output_path(
        "YOUTUBE_LANE_OUTPUT",
        "youtube_implementation_lane.json",
    ))
    .await?
    .unwrap_or_default();
    let implementation_research_lane =
        load_optional_struct::<ImplementationResearchLane>(lane_output_path(
            "IMPLEMENTATION_LANE_OUTPUT",
            "implementation_lane.json",
        ))
        .await?
        .unwrap_or_default();

    let summary = DashboardSummary {
        product_name: "SurfaceScope".to_string(),
        authorized_assets_only: true,
        asset_count: assets.len(),
        findings_open: findings.iter().filter(|finding| finding.status != "closed").count(),
        disclosure_queue: findings.iter().filter(|finding| finding.needs_disclosure).count(),
        critical_findings: findings.iter().filter(|finding| finding.severity == "critical").count(),
        compliance_sources: compliance_sources.len(),
        testing_methodologies: testing_methodologies.len(),
        vulnerability_intelligence_items: vulnerability_intelligence.len(),
    };

    let product_brief = ProductBrief {
        name: "SurfaceScope".to_string(),
        positioning: "Authorized asset exposure management with evidence-first remediation and disclosure workflow.".to_string(),
        guardrails: vec![
            "Owned or explicitly authorized assets only.".to_string(),
            "Machine-readable findings and evidence retention.".to_string(),
            "Disclosure-safe workflow instead of public third-party indexing.".to_string(),
            "Private report handling with reviewer-only visibility windows before any wider publication.".to_string(),
            "Documented authorization proof, recipient contacts, and escalation paths on every monitored asset.".to_string(),
        ],
        next_steps: vec![
            "Scanner import adapters".to_string(),
            "Owner attestation workflow".to_string(),
            "Disclosure packet export".to_string(),
            "Scheduled research-lane refresh and review".to_string(),
            "CVE and KEV intelligence enrichment".to_string(),
            "Approved testing methodology playbooks".to_string(),
            "Trusted-researcher grace windows and report visibility controls".to_string(),
            "Opt-out, takedown, and abuse-handling queue".to_string(),
            "Resource-claim verification for domains, networks, and delegated services".to_string(),
        ],
    };

    Ok(AppState {
        assets: Arc::new(assets),
        findings: Arc::new(findings),
        compliance_sources: Arc::new(compliance_sources),
        testing_methodologies: Arc::new(testing_methodologies),
        vulnerability_intelligence: Arc::new(vulnerability_intelligence),
        website_research_lane: Arc::new(website_research_lane),
        youtube_research_lane: Arc::new(youtube_research_lane),
        implementation_research_lane: Arc::new(implementation_research_lane),
        summary: Arc::new(summary),
        product_brief: Arc::new(product_brief),
    })
}

fn build_enriched_findings(
    assets: &[Asset],
    findings: &[Finding],
    testing_methodologies: &[TestingMethodology],
    vulnerability_intelligence: &[VulnerabilityIntelligence],
) -> Vec<EnrichedFinding> {
    let asset_index: HashMap<&str, &Asset> = assets.iter().map(|asset| (asset.id.as_str(), asset)).collect();
    let method_index: HashMap<&str, &TestingMethodology> = testing_methodologies
        .iter()
        .map(|method| (method.id.as_str(), method))
        .collect();
    let intelligence_index: HashMap<&str, &VulnerabilityIntelligence> = vulnerability_intelligence
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();

    findings
        .iter()
        .map(|finding| EnrichedFinding {
            id: finding.id.clone(),
            asset_id: finding.asset_id.clone(),
            title: finding.title.clone(),
            severity: finding.severity.clone(),
            status: finding.status.clone(),
            source: finding.source.clone(),
            evidence_url: finding.evidence_url.clone(),
            needs_disclosure: finding.needs_disclosure,
            needs_owner_confirmation: finding.needs_owner_confirmation,
            report_status: finding.report_status.clone(),
            visibility: finding.visibility.clone(),
            grace_period_days: finding.grace_period_days,
            summary: finding.summary.clone(),
            evidence_summary: finding.evidence_summary.clone(),
            remediation_owner: finding.remediation_owner.clone(),
            recipient_contacts: finding.recipient_contacts.clone(),
            escalation_targets: finding.escalation_targets.clone(),
            asset: asset_index.get(finding.asset_id.as_str()).map(|asset| FindingAssetContext {
                id: asset.id.clone(),
                name: asset.name.clone(),
                owner: asset.owner.clone(),
                authorization_state: asset.authorization_state.clone(),
                authorization_basis: asset.authorization_basis.clone(),
                authorization_reference: asset.authorization_reference.clone(),
                resource_scope: asset.resource_scope.clone(),
                exposure_risk: asset.exposure_risk.clone(),
            }),
            related_intelligence: finding
                .related_intelligence_ids
                .iter()
                .filter_map(|id| intelligence_index.get(id.as_str()).cloned().cloned())
                .collect(),
            recommended_methods: finding
                .recommended_method_ids
                .iter()
                .filter_map(|id| method_index.get(id.as_str()).cloned().cloned())
                .collect(),
        })
        .collect()
}

fn flatten_approved_resources(assets: &[Asset]) -> Vec<ApprovedAssetResource> {
    assets
        .iter()
        .flat_map(|asset| {
            asset.approved_resources.iter().cloned().map(|resource| ApprovedAssetResource {
                asset_id: asset.id.clone(),
                asset_name: asset.name.clone(),
                authorization_state: asset.authorization_state.clone(),
                authorization_basis: asset.authorization_basis.clone(),
                resource_scope: asset.resource_scope.clone(),
                resource,
            })
        })
        .collect()
}

fn candidate_urls_for_resource(resource: &ApprovedResource) -> Vec<String> {
    let target = resource.target.trim();
    if target.is_empty() {
        return Vec::new();
    }
    if target.starts_with("http://") || target.starts_with("https://") {
        return vec![target.to_string()];
    }
    match resource.resource_type.as_str() {
        "domain" | "hostname" | "public_web" | "public_api" => vec![
            format!("https://{target}"),
            format!("http://{target}"),
        ],
        "ip" => vec![format!("http://{target}")],
        _ => vec![format!("https://{target}")],
    }
}

async fn resolve_resource_ips(resource: &ApprovedResource) -> Vec<String> {
    let target = resource.target.trim();
    if target.is_empty() {
        return Vec::new();
    }

    let host = if target.starts_with("http://") || target.starts_with("https://") {
        Url::parse(target)
            .ok()
            .and_then(|url| url.host_str().map(|host| host.to_string()))
            .unwrap_or_default()
    } else {
        target.to_string()
    };

    if host.is_empty() {
        return Vec::new();
    }

    let port = if resource.resource_type == "public_api" { 443 } else { 80 };
    let lookup_result = lookup_host((host.as_str(), port)).await;
    match lookup_result {
        Ok(addrs) => {
            let mut ips: Vec<String> = addrs.map(|addr| addr.ip().to_string()).collect();
            ips.sort();
            ips.dedup();
            ips
        }
        Err(_) => Vec::new(),
    }
}

fn extract_html_title(body: &str) -> String {
    // Use ASCII-only byte-level lowercasing so byte indices remain valid for non-ASCII input.
    // `to_lowercase()` can change UTF-8 byte lengths for non-ASCII chars (e.g. Turkish İ),
    // making indices derived from the lowercased string invalid on the original. Since HTML
    // tags only contain ASCII characters, lowercasing bytes is both correct and efficient.
    let lower = String::from_utf8(
        body.bytes().map(|b| b.to_ascii_lowercase()).collect()
    ).unwrap_or_default();
    let open = lower.find("<title>");
    let close = lower.find("</title>");
    match (open, close) {
        (Some(start), Some(end)) if end > start + 7 => body[start + 7..end].trim().to_string(),
        _ => String::new(),
    }
}

fn parse_security_txt(body: &str, fetched_from: &str, status: &str) -> SecurityTxtSummary {
    let mut contact = String::new();
    let mut policy = String::new();
    let mut expires = String::new();

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let lower = trimmed.to_lowercase();
        if lower.starts_with("contact:") && contact.is_empty() {
            contact = trimmed[8..].trim().to_string();
        } else if lower.starts_with("policy:") && policy.is_empty() {
            policy = trimmed[7..].trim().to_string();
        } else if lower.starts_with("expires:") && expires.is_empty() {
            expires = trimmed[8..].trim().to_string();
        }
    }

    SecurityTxtSummary {
        status: status.to_string(),
        fetched_from: fetched_from.to_string(),
        contact,
        policy,
        expires,
    }
}

async fn fetch_security_txt(client: &Client, resource: &ApprovedResource) -> Option<SecurityTxtSummary> {
    let first_url = candidate_urls_for_resource(resource).into_iter().next()?;
    let base = Url::parse(&first_url).ok()?;
    let security_url = base.join("/.well-known/security.txt").ok()?;

    match client.get(security_url.clone()).send().await {
        Ok(response) => {
            let status_code = response.status().as_u16();
            if !response.status().is_success() {
                return Some(parse_security_txt("", security_url.as_str(), if status_code == 404 { "missing" } else { "unreachable" }));
            }
            let content_type = response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string();
            let body = response.text().await.unwrap_or_default();
            let parsed = parse_security_txt(&body, security_url.as_str(), "present");
            let looks_like_html = content_type.contains("text/html") || body.to_lowercase().contains("<html");
            let has_any_directive =
                !parsed.contact.trim().is_empty() || !parsed.policy.trim().is_empty() || !parsed.expires.trim().is_empty();
            if looks_like_html || !has_any_directive {
                return Some(parse_security_txt(&body, security_url.as_str(), "invalid"));
            }
            Some(parsed)
        }
        Err(_) => Some(parse_security_txt("", security_url.as_str(), "unreachable")),
    }
}

async fn scan_resource(client: &Client, asset: &Asset, resource: &ApprovedResource) -> ApprovedResourceScanResult {
    let checked_at = chrono_like_now();
    let resolved_ips = resolve_resource_ips(resource).await;
    let mut notes = Vec::new();
    if resolved_ips.is_empty() {
        notes.push("DNS resolution did not return any IPs during this scan window.".to_string());
    }

    let mut reachability = "unreachable".to_string();
    let mut final_url = String::new();
    let mut http_status = None;
    let mut page_title = String::new();
    let mut server_header = String::new();

    for url in candidate_urls_for_resource(resource) {
        match client.get(url.clone()).send().await {
            Ok(response) => {
                let status = response.status();
                final_url = response.url().to_string();
                http_status = Some(status.as_u16());
                server_header = response
                    .headers()
                    .get(header::SERVER)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                let body = response.text().await.unwrap_or_default();
                page_title = extract_html_title(&body);
                reachability = if status.is_success() {
                    "reachable".to_string()
                } else {
                    "reachable-with-error".to_string()
                };
                if page_title.is_empty() {
                    notes.push("HTTP response did not include an HTML title tag.".to_string());
                }
                // Only stop on a successful response; continue to the next candidate
                // (e.g. http fallback after an https 404) otherwise.
                if status.is_success() {
                    break;
                }
            }
            Err(error) => {
                notes.push(format!("HTTP probe failed for {url}: {error}"));
            }
        }
    }

    let security_txt = fetch_security_txt(client, resource).await;
    if let Some(summary) = &security_txt {
        if summary.status == "missing" {
            notes.push("security.txt was missing at the approved resource origin.".to_string());
        } else if summary.status == "invalid" {
            notes.push("security.txt was reachable but did not contain recognizable Contact, Policy, or Expires fields.".to_string());
        } else if summary.status == "unreachable" {
            notes.push("security.txt could not be fetched from the approved resource origin.".to_string());
        }
    }

    ApprovedResourceScanResult {
        asset_id: asset.id.clone(),
        asset_name: asset.name.clone(),
        authorization_state: asset.authorization_state.clone(),
        authorization_basis: asset.authorization_basis.clone(),
        approval_reference: asset.authorization_reference.clone(),
        resource_scope: asset.resource_scope.clone(),
        resource: resource.clone(),
        checked_at,
        reachability,
        resolved_ips,
        final_url,
        http_status,
        page_title,
        server_header,
        security_txt,
        notes,
    }
}

async fn scan_approved_resources(assets: &[Asset]) -> Result<Vec<ApprovedResourceScanResult>, String> {
    let client = build_scan_client()?;
    let mut results = Vec::new();
    for asset in assets {
        for resource in &asset.approved_resources {
            results.push(scan_resource(&client, asset, resource).await);
        }
    }
    Ok(results)
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let tm = chrono_like_gmtime(secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        tm.year, tm.month, tm.day, tm.hour, tm.minute, tm.second
    )
}

struct SimpleDateTime {
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
}

fn chrono_like_gmtime(timestamp: u64) -> SimpleDateTime {
    let days = (timestamp / 86_400) as i64;
    let secs_of_day = (timestamp % 86_400) as u32;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };

    SimpleDateTime {
        year: year as i32,
        month: month as u32,
        day: day as u32,
        hour: secs_of_day / 3600,
        minute: (secs_of_day % 3600) / 60,
        second: secs_of_day % 60,
    }
}

async fn healthz() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn summary(State(state): State<AppState>) -> impl IntoResponse {
    Json((*state.summary).clone())
}

async fn assets(State(state): State<AppState>) -> impl IntoResponse {
    Json((*state.assets).clone())
}

async fn approved_resources(State(state): State<AppState>) -> impl IntoResponse {
    Json(flatten_approved_resources(state.assets.as_ref()))
}

async fn findings(State(state): State<AppState>) -> impl IntoResponse {
    Json((*state.findings).clone())
}

async fn enriched_findings(State(state): State<AppState>) -> impl IntoResponse {
    Json(build_enriched_findings(
        state.assets.as_ref(),
        state.findings.as_ref(),
        state.testing_methodologies.as_ref(),
        state.vulnerability_intelligence.as_ref(),
    ))
}

async fn compliance_sources(State(state): State<AppState>) -> impl IntoResponse {
    Json((*state.compliance_sources).clone())
}

async fn testing_methodologies(State(state): State<AppState>) -> impl IntoResponse {
    Json((*state.testing_methodologies).clone())
}

async fn vulnerability_intelligence(State(state): State<AppState>) -> impl IntoResponse {
    Json((*state.vulnerability_intelligence).clone())
}

async fn website_research_lane(State(state): State<AppState>) -> impl IntoResponse {
    Json((*state.website_research_lane).clone())
}

async fn youtube_research_lane(State(state): State<AppState>) -> impl IntoResponse {
    Json((*state.youtube_research_lane).clone())
}

async fn implementation_research_lane(State(state): State<AppState>) -> impl IntoResponse {
    Json((*state.implementation_research_lane).clone())
}

async fn product_brief(State(state): State<AppState>) -> impl IntoResponse {
    Json((*state.product_brief).clone())
}

async fn approved_scans(State(state): State<AppState>) -> impl IntoResponse {
    match scan_approved_resources(state.assets.as_ref()).await {
        Ok(results) => Json(results).into_response(),
        Err(error) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response(),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3325);
    let state = build_state().await?;

    let frontend_dir = app_root().join("frontend");
    let index_file = frontend_dir.join("index.html");

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/summary", get(summary))
        .route("/api/assets", get(assets))
        .route("/api/assets/approved-resources", get(approved_resources))
        .route("/api/findings", get(findings))
        .route("/api/findings/enriched", get(enriched_findings))
        .route("/api/scans/approved", get(approved_scans))
        .route("/api/compliance/sources", get(compliance_sources))
        .route("/api/testing-methodologies", get(testing_methodologies))
        .route("/api/vulnerability-intelligence", get(vulnerability_intelligence))
        .route("/api/research/website-lane", get(website_research_lane))
        .route("/api/research/youtube-lane", get(youtube_research_lane))
        .route("/api/research/implementation-lane", get(implementation_research_lane))
        .route("/api/product-brief", get(product_brief))
        .nest_service("/static", ServeDir::new(frontend_dir.clone()))
        .fallback_service(ServeFile::new(index_file))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("SurfaceScope listening on http://{}", addr);
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{build_enriched_findings, build_state};
    use crate::models::{ApprovedResource, Asset, Finding, TestingMethodology, VulnerabilityIntelligence};

    #[test]
    fn enriches_findings_with_asset_intel_and_methods() {
        let assets = vec![Asset {
            id: "asset-1".to_string(),
            name: "api.example.test".to_string(),
            kind: "public_api".to_string(),
            owner: "API Team".to_string(),
            authorization_state: "owned".to_string(),
            authorization_basis: "service owner approval".to_string(),
            authorization_reference: "CMDB record API-001".to_string(),
            resource_scope: "domain".to_string(),
            last_verified_at: "2026-03-29T00:00:00Z".to_string(),
            exposure_risk: "critical".to_string(),
            notes: "demo".to_string(),
            approved_resources: vec![ApprovedResource {
                id: "resource-1".to_string(),
                label: "Primary app surface".to_string(),
                resource_type: "url".to_string(),
                target: "http://127.0.0.1:3325/".to_string(),
                owner_contact: "platform@example.test".to_string(),
                scan_policy: "safe-http-metadata".to_string(),
                approved_by: "Security lead".to_string(),
                approval_reference: "ticket-123".to_string(),
                notes: "Local test target".to_string(),
            }],
        }];
        let findings = vec![Finding {
            id: "finding-1".to_string(),
            asset_id: "asset-1".to_string(),
            title: "Missing disclosure contact metadata".to_string(),
            severity: "medium".to_string(),
            status: "triaging".to_string(),
            source: "security_txt_probe".to_string(),
            evidence_url: None,
            needs_disclosure: false,
            needs_owner_confirmation: true,
            report_status: "draft".to_string(),
            visibility: "internal-review".to_string(),
            grace_period_days: 30,
            summary: "summary".to_string(),
            related_intelligence_ids: vec!["intel-1".to_string()],
            recommended_method_ids: vec!["method-1".to_string()],
            evidence_summary: "evidence".to_string(),
            remediation_owner: "API Team".to_string(),
            recipient_contacts: vec!["security@example.test".to_string()],
            escalation_targets: vec!["platform-abuse@example.test".to_string()],
        }];
        let methods = vec![TestingMethodology {
            id: "method-1".to_string(),
            title: "security.txt verification".to_string(),
            category: "disclosure".to_string(),
            safety_posture: "safe-passive".to_string(),
            objective: "objective".to_string(),
            operator_steps: vec!["step".to_string()],
            evidence_outputs: vec!["body".to_string()],
        }];
        let intel = vec![VulnerabilityIntelligence {
            id: "intel-1".to_string(),
            cve_id: "RFC-9116".to_string(),
            title: "security.txt disclosure-channel support".to_string(),
            source_catalog: "RFC 9116".to_string(),
            vendor: "IETF".to_string(),
            product: "security.txt".to_string(),
            weakness: "disclosure-process-gap".to_string(),
            risk_signal: "coordination-readiness".to_string(),
            public_reference_url: "https://www.rfc-editor.org/rfc/rfc9116".to_string(),
            remediation_focus: "focus".to_string(),
            testing_method_ids: vec!["method-1".to_string()],
        }];

        let enriched = build_enriched_findings(&assets, &findings, &methods, &intel);
        assert_eq!(enriched.len(), 1);
        let item = &enriched[0];
        assert_eq!(item.asset.as_ref().map(|asset| asset.name.as_str()), Some("api.example.test"));
        assert_eq!(item.related_intelligence.len(), 1);
        assert_eq!(item.related_intelligence[0].cve_id, "RFC-9116");
        assert_eq!(item.recommended_methods.len(), 1);
        assert_eq!(item.recommended_methods[0].title, "security.txt verification");
        assert_eq!(item.asset.as_ref().map(|asset| asset.authorization_basis.as_str()), Some("service owner approval"));
        assert_eq!(item.report_status, "draft");
        assert_eq!(item.visibility, "internal-review");
    }

    #[tokio::test]
    async fn fixture_data_loads_and_references_resolve() {
        let state = build_state()
            .await
            .expect("fixture data should deserialize into application state");

        assert!(!state.assets.is_empty(), "expected at least one asset fixture");
        assert!(!state.findings.is_empty(), "expected at least one finding fixture");
        assert!(
            !state.compliance_sources.is_empty(),
            "expected at least one compliance source fixture"
        );
        assert!(
            !state.testing_methodologies.is_empty(),
            "expected at least one testing methodology fixture"
        );
        assert!(
            !state.vulnerability_intelligence.is_empty(),
            "expected at least one vulnerability intelligence fixture"
        );
        assert!(
            state.website_research_lane.source_name.contains("Website"),
            "expected website research lane fixture metadata"
        );
        assert!(
            state.youtube_research_lane.channel_url.starts_with("https://"),
            "expected the youtube research lane to preserve its source URL"
        );
        assert!(
            !state.implementation_research_lane.status.trim().is_empty(),
            "expected the implementation research lane to preserve a status"
        );

        let asset_ids: HashSet<&str> = state.assets.iter().map(|asset| asset.id.as_str()).collect();
        let method_ids: HashSet<&str> = state
            .testing_methodologies
            .iter()
            .map(|method| method.id.as_str())
            .collect();
        let intelligence_ids: HashSet<&str> = state
            .vulnerability_intelligence
            .iter()
            .map(|item| item.id.as_str())
            .collect();

        for source in state.compliance_sources.iter() {
            assert!(!source.id.trim().is_empty(), "compliance source id should not be blank");
            assert!(
                !source.title.trim().is_empty(),
                "compliance source {} should have a title",
                source.id
            );
            assert!(
                source.url.starts_with("https://"),
                "compliance source {} should use an https URL",
                source.id
            );
            assert!(
                !source.requirement.trim().is_empty(),
                "compliance source {} should describe the requirement",
                source.id
            );
            assert!(
                !source.product_response.trim().is_empty(),
                "compliance source {} should describe the product response",
                source.id
            );
        }

        for asset in state.assets.iter() {
            assert!(
                !asset.authorization_basis.trim().is_empty(),
                "asset {} should carry an authorization basis",
                asset.id
            );
            assert!(
                !asset.authorization_reference.trim().is_empty(),
                "asset {} should carry an authorization reference",
                asset.id
            );
            assert!(
                !asset.resource_scope.trim().is_empty(),
                "asset {} should carry a resource scope",
                asset.id
            );
            assert!(
                !asset.approved_resources.is_empty(),
                "asset {} should carry at least one approved resource",
                asset.id
            );
        }

        for finding in state.findings.iter() {
            assert!(
                !finding.report_status.trim().is_empty(),
                "finding {} should carry a report status",
                finding.id
            );
            assert!(
                !finding.visibility.trim().is_empty(),
                "finding {} should carry a visibility classification",
                finding.id
            );
            if finding.needs_disclosure {
                assert!(
                    finding.grace_period_days > 0,
                    "finding {} should carry a disclosure grace period when disclosure is required",
                    finding.id
                );
            }
            assert!(
                asset_ids.contains(finding.asset_id.as_str()),
                "finding {} references missing asset {}",
                finding.id,
                finding.asset_id
            );
            for intelligence_id in &finding.related_intelligence_ids {
                assert!(
                    intelligence_ids.contains(intelligence_id.as_str()),
                    "finding {} references missing intelligence {}",
                    finding.id,
                    intelligence_id
                );
            }
            for method_id in &finding.recommended_method_ids {
                assert!(
                    method_ids.contains(method_id.as_str()),
                    "finding {} references missing testing method {}",
                    finding.id,
                    method_id
                );
            }
        }

        for item in state.vulnerability_intelligence.iter() {
            for method_id in &item.testing_method_ids {
                assert!(
                    method_ids.contains(method_id.as_str()),
                    "intelligence {} references missing testing method {}",
                    item.id,
                    method_id
                );
            }
        }

        let enriched = build_enriched_findings(
            state.assets.as_ref(),
            state.findings.as_ref(),
            state.testing_methodologies.as_ref(),
            state.vulnerability_intelligence.as_ref(),
        );

        assert_eq!(
            enriched.len(),
            state.findings.len(),
            "expected every fixture finding to survive enrichment"
        );

        for (finding, enriched_finding) in state.findings.iter().zip(enriched.iter()) {
            assert!(
                enriched_finding.asset.is_some(),
                "expected enriched finding {} to include its asset context",
                finding.id
            );
            assert_eq!(
                enriched_finding.related_intelligence.len(),
                finding.related_intelligence_ids.len(),
                "expected enriched finding {} to resolve all linked intelligence records",
                finding.id
            );
            assert_eq!(
                enriched_finding.recommended_methods.len(),
                finding.recommended_method_ids.len(),
                "expected enriched finding {} to resolve all linked testing methods",
                finding.id
            );
            assert!(
                !enriched_finding.visibility.trim().is_empty(),
                "expected enriched finding {} to retain visibility state",
                finding.id
            );
        }
    }
}

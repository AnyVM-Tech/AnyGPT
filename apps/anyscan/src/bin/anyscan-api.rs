use std::{convert::Infallible, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use async_stream::stream;
use axum::body::Bytes;
use axum::response::sse::{Event, KeepAlive};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Sse},
    routing::{get, post},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::Utc;
use clap::Parser;
use anyscan::{
    config::AppConfig,
    core::{
        AbuseReportRecord, AbuseReportRequest, ApiEvent, BinDatasetImportRequest, BinDatasetStatus,
        BinLookupLinePreview, BinLookupMatch, BinLookupRequest, BinLookupResponse,
        DashboardSnapshot, FindingRecord, FindingsQuery, OperatorRole, OptOutRecord, OptOutRequest,
        OwnershipClaimRecord, OwnershipClaimRequest, PortScanRecord, PortScanRequest,
        PublicFindingModerationRecord, PublicFindingModerationRequest, PublicFindingRecord,
        PublicFindingSearchQuery, PublicWorkflowKind, PublicWorkflowStatusUpdate,
        RecurringScheduleRecord, RepositoryDefinition, RepositoryRecord, RunScope, RunSummary,
        ScanDefaultsSummary, ScanRunRecord, TargetDefinition, TargetRecord,
        WorkerBootstrapCandidateApproval, WorkerBootstrapCandidateApprovalRequest,
        WorkerBootstrapCandidateRecord, WorkerBootstrapCandidateRejectionRequest,
        WorkerBootstrapJobRecord, WorkerEnrollmentTokenIssueRequest, WorkerEnrollmentTokenIssued,
        WorkerEnrollmentTokenRecord, WorkerLifecycleUpdateRequest, WorkerPoolRecord, WorkerRecord,
        bin_lookup_line_preview, normalized_bin_lookup_limit, parse_bin_lookup_candidates,
    },
    ops::init_tracing,
    public_verification::verify_public_resource_control,
    store::AnyScanStore,
};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use time::Duration as CookieDuration;
use tokio::net::TcpListener;
use tracing::{info, warn};

const SESSION_COOKIE: &str = "anyscan_session";

#[derive(Debug, Parser)]
struct Cli {
    #[arg(long, env = "ANYSCAN_CONFIG")]
    config: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct AppState {
    config: AppConfig,
    store: AnyScanStore,
}

#[derive(Debug, Deserialize)]
struct SessionRequest {
    username: String,
    password: String,
}

#[derive(Debug, Clone, Serialize)]
struct SessionPermissions {
    write: bool,
    manage_settings: bool,
    manage_operators: bool,
    manage_workers: bool,
    approve_bootstrap_candidates: bool,
    moderate_public_findings: bool,
}

#[derive(Debug, Clone, Serialize)]
struct SessionResponse {
    username: String,
    role: OperatorRole,
    permissions: SessionPermissions,
}

#[derive(Debug, Default, Deserialize)]
struct RunRequest {
    #[serde(default)]
    scope: Option<RunScope>,
}

#[derive(Debug, Deserialize)]
struct ScheduleRequest {
    label: String,
    interval_seconds: u64,
    enabled: Option<bool>,
    #[serde(default)]
    scope: Option<RunScope>,
}

#[derive(Debug, Clone)]
struct SessionContext {
    username: String,
    role: OperatorRole,
}

#[derive(Debug, Deserialize)]
struct EventQuery {
    cursor: Option<i64>,
    run_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionClaims {
    sub: String,
    role: OperatorRole,
    iat: usize,
    exp: usize,
}

#[derive(Debug, Clone, Serialize)]
struct PublicProfileResponse {
    service_name: String,
    base_url: Option<String>,
    security_email: String,
    abuse_email: String,
    opt_out_email: String,
    scanner_ip_ranges: Vec<String>,
    scanner_asns: Vec<String>,
    reverse_dns_patterns: Vec<String>,
    user_agent_examples: Vec<String>,
    published_search_scope: Vec<String>,
    data_retention_days: u64,
    opt_out_response_sla_hours: u64,
    max_concurrent_requests_per_host: usize,
    allow_authenticated_request_profiles: bool,
    rate_limit_policy: String,
    scanning_policy_url: String,
    scanner_identity_url: String,
    data_policy_url: String,
    claim_url: String,
    opt_out_url: String,
    abuse_url: String,
    security_txt_url: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let config = AppConfig::load(cli.config.as_deref())?;
    init_tracing("anyscan-api");

    let store = AnyScanStore::from_config(&config)?;
    store.initialize()?;
    seed_bootstrap_inventory(&store, &config)?;

    let state = Arc::new(AppState { config, store });
    let app = Router::new()
        .route("/", get(public_index))
        .route("/app", get(operator_app))
        .route("/scanning-policy", get(public_page))
        .route("/scanner-identity", get(public_page))
        .route("/opt-out", get(public_page))
        .route("/claim", get(public_page))
        .route("/abuse", get(public_page))
        .route("/data-policy", get(public_page))
        .route("/.well-known/security.txt", get(security_txt))
        .route("/api/public/profile", get(public_profile))
        .route("/api/public/findings", get(list_public_findings))
        .route(
            "/api/public/claims",
            get(list_ownership_claims).post(create_ownership_claim),
        )
        .route(
            "/api/public/claims/{claim_id}/status",
            post(update_ownership_claim_status),
        )
        .route(
            "/api/public/opt-outs",
            get(list_opt_out_requests).post(create_opt_out_request),
        )
        .route(
            "/api/public/opt-outs/{opt_out_id}/status",
            post(update_opt_out_status),
        )
        .route(
            "/api/public/abuse-reports",
            get(list_abuse_reports).post(create_abuse_report),
        )
        .route(
            "/api/public/abuse-reports/{report_id}/status",
            post(update_abuse_report_status),
        )
        .route("/api/session", post(login).delete(logout))
        .route("/api/me", get(me))
        .route("/api/dashboard", get(dashboard))
        .route(
            "/api/scan-settings",
            get(get_scan_settings).post(update_scan_settings),
        )
        .route("/api/bin-dataset", get(get_bin_dataset_status))
        .route("/api/bin-dataset/import", post(import_bin_dataset))
        .route("/api/bin-lookup", post(bin_lookup))
        .route("/api/targets", get(list_targets).post(create_target))
        .route(
            "/api/repositories",
            get(list_repositories).post(create_repository),
        )
        .route(
            "/api/port-scans",
            get(list_port_scans).post(queue_port_scan),
        )
        .route("/api/worker-pools", get(list_worker_pools))
        .route("/api/workers", get(list_workers))
        .route("/api/workers/{worker_id}", get(get_worker))
        .route(
            "/api/workers/{worker_id}/lifecycle",
            post(update_worker_lifecycle),
        )
        .route(
            "/api/worker-enrollment-tokens",
            get(list_worker_enrollment_tokens).post(issue_worker_enrollment_token),
        )
        .route(
            "/api/worker-enrollment-tokens/{token_id}/revoke",
            post(revoke_worker_enrollment_token),
        )
        .route("/api/bootstrap-candidates", get(list_bootstrap_candidates))
        .route("/api/bootstrap-jobs", get(list_bootstrap_jobs))
        .route(
            "/api/bootstrap-candidates/{candidate_id}/approve",
            post(approve_bootstrap_candidate),
        )
        .route(
            "/api/bootstrap-candidates/{candidate_id}/reject",
            post(reject_bootstrap_candidate),
        )
        .route("/api/runs", get(list_runs).post(queue_run))
        .route("/api/schedules", get(list_schedules).post(create_schedule))
        .route("/api/findings", get(list_findings))
        .route("/api/findings/publications", get(list_finding_publications))
        .route(
            "/api/findings/{finding_id}/publication",
            post(moderate_public_finding),
        )
        .route("/api/events/stream", get(event_stream))
        .with_state(state.clone());

    let listener = TcpListener::bind(&state.config.server.bind_addr)
        .await
        .with_context(|| format!("failed to bind {}", state.config.server.bind_addr))?;
    info!(bind = %state.config.server.bind_addr, "exposure api listening");
    axum::serve(listener, app)
        .await
        .context("api server failed")?;
    Ok(())
}

async fn public_index() -> Html<&'static str> {
    Html(include_str!("../../public-site.html"))
}

async fn operator_app() -> Html<&'static str> {
    Html(include_str!("../../index.html"))
}

async fn public_page() -> Html<&'static str> {
    Html(include_str!("../../public-site.html"))
}

async fn security_txt(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        build_security_txt(&state.config),
    )
}

async fn public_profile(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PublicProfileResponse>, StatusCode> {
    let scan_defaults = load_effective_scan_defaults(&state)?;
    Ok(Json(build_public_profile_response(
        &state.config,
        &scan_defaults,
    )))
}

async fn list_public_findings(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PublicFindingSearchQuery>,
) -> Result<Json<Vec<PublicFindingRecord>>, StatusCode> {
    let findings = state
        .store
        .search_public_findings(&query)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(findings))
}

async fn create_ownership_claim(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<OwnershipClaimRequest>,
) -> Result<(StatusCode, Json<OwnershipClaimRecord>), StatusCode> {
    let mut record = state
        .store
        .create_ownership_claim(&payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let verification = verify_public_resource_control(
        record.resource_kind,
        &record.resource,
        record.verification_method,
        &record.verification_value,
        &record.requester_email,
    )
    .await;
    match state.store.apply_ownership_claim_verification(
        record.id,
        verification.status,
        Some(&verification.summary),
        verification.verification_attempted_at,
        verification.verification_completed_at,
    ) {
        Ok(updated) => record = updated,
        Err(error) => warn!(claim_id = record.id, ?error, "failed to persist ownership claim verification result"),
    }
    let _ = state.store.append_event(
        None,
        &ApiEvent::PublicWorkflowRecorded {
            workflow: PublicWorkflowKind::OwnershipClaim,
            record_id: record.id,
            resource: record.resource.clone(),
            status: record.status,
        },
    );
    Ok((StatusCode::CREATED, Json(record)))
}

async fn list_ownership_claims(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<OwnershipClaimRecord>>, StatusCode> {
    require_settings_access(&state, &jar)?;
    let records = state
        .store
        .list_ownership_claims()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(records))
}

async fn update_ownership_claim_status(
    Path(claim_id): Path<i64>,
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(payload): Json<PublicWorkflowStatusUpdate>,
) -> Result<Json<OwnershipClaimRecord>, StatusCode> {
    require_settings_access(&state, &jar)?;
    let record = state
        .store
        .update_ownership_claim_status(claim_id, &payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let _ = state.store.append_event(
        None,
        &ApiEvent::PublicWorkflowRecorded {
            workflow: PublicWorkflowKind::OwnershipClaim,
            record_id: record.id,
            resource: record.resource.clone(),
            status: record.status,
        },
    );
    Ok(Json(record))
}

async fn create_opt_out_request(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<OptOutRequest>,
) -> Result<(StatusCode, Json<OptOutRecord>), StatusCode> {
    let mut record = state
        .store
        .create_opt_out_request(&payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let verification = verify_public_resource_control(
        record.resource_kind,
        &record.resource,
        record.verification_method,
        &record.verification_value,
        &record.requester_email,
    )
    .await;
    match state.store.apply_opt_out_verification(
        record.id,
        verification.status,
        Some(&verification.summary),
        verification.verification_attempted_at,
        verification.verification_completed_at,
    ) {
        Ok(updated) => record = updated,
        Err(error) => warn!(opt_out_id = record.id, ?error, "failed to persist opt-out verification result"),
    }
    let _ = state.store.append_event(
        None,
        &ApiEvent::PublicWorkflowRecorded {
            workflow: PublicWorkflowKind::OptOut,
            record_id: record.id,
            resource: record.resource.clone(),
            status: record.status,
        },
    );
    Ok((StatusCode::CREATED, Json(record)))
}

async fn list_opt_out_requests(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<OptOutRecord>>, StatusCode> {
    require_settings_access(&state, &jar)?;
    let records = state
        .store
        .list_opt_out_requests()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(records))
}

async fn update_opt_out_status(
    Path(opt_out_id): Path<i64>,
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(payload): Json<PublicWorkflowStatusUpdate>,
) -> Result<Json<OptOutRecord>, StatusCode> {
    require_settings_access(&state, &jar)?;
    let record = state
        .store
        .update_opt_out_status(opt_out_id, &payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let _ = state.store.append_event(
        None,
        &ApiEvent::PublicWorkflowRecorded {
            workflow: PublicWorkflowKind::OptOut,
            record_id: record.id,
            resource: record.resource.clone(),
            status: record.status,
        },
    );
    Ok(Json(record))
}

async fn create_abuse_report(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AbuseReportRequest>,
) -> Result<(StatusCode, Json<AbuseReportRecord>), StatusCode> {
    let record = state
        .store
        .create_abuse_report(&payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let _ = state.store.append_event(
        None,
        &ApiEvent::PublicWorkflowRecorded {
            workflow: PublicWorkflowKind::AbuseReport,
            record_id: record.id,
            resource: record.affected_resource.clone(),
            status: record.status,
        },
    );
    Ok((StatusCode::CREATED, Json(record)))
}

async fn list_abuse_reports(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<AbuseReportRecord>>, StatusCode> {
    require_settings_access(&state, &jar)?;
    let records = state
        .store
        .list_abuse_reports()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(records))
}

async fn update_abuse_report_status(
    Path(report_id): Path<i64>,
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(payload): Json<PublicWorkflowStatusUpdate>,
) -> Result<Json<AbuseReportRecord>, StatusCode> {
    require_settings_access(&state, &jar)?;
    let record = state
        .store
        .update_abuse_report_status(report_id, &payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let _ = state.store.append_event(
        None,
        &ApiEvent::PublicWorkflowRecorded {
            workflow: PublicWorkflowKind::AbuseReport,
            record_id: record.id,
            resource: record.affected_resource.clone(),
            status: record.status,
        },
    );
    Ok(Json(record))
}

async fn login(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(payload): Json<SessionRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let Some(operator) = state
        .config
        .authenticate_operator(&payload.username, &payload.password)
    else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let session = SessionContext {
        username: operator.username,
        role: operator.role,
    };

    let token = build_session_token(&state.config, &session)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let cookie = Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(CookieDuration::seconds(
            state.config.auth.session_ttl_seconds as i64,
        ))
        .build();

    Ok((jar.add(cookie), Json(session_response(&session))))
}

async fn logout(jar: CookieJar) -> impl IntoResponse {
    let cookie = Cookie::build((SESSION_COOKIE, ""))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(CookieDuration::seconds(0))
        .build();
    (jar.remove(cookie), StatusCode::NO_CONTENT)
}

async fn me(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<SessionResponse>, StatusCode> {
    let session = require_auth(&state, &jar)?;
    Ok(Json(session_response(&session)))
}

async fn dashboard(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<DashboardSnapshot>, StatusCode> {
    require_auth(&state, &jar)?;
    let mut snapshot = state
        .store
        .dashboard_snapshot()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    snapshot.scan_defaults = load_effective_scan_defaults(&state)?;
    snapshot.operators = state.config.operator_records();
    snapshot.workers = state
        .store
        .list_workers()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    snapshot.extensions = state
        .config
        .load_extension_manifests()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    snapshot.bin_dataset_status = state
        .store
        .load_bin_dataset_status()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(snapshot))
}

async fn get_scan_settings(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<ScanDefaultsSummary>, StatusCode> {
    require_auth(&state, &jar)?;
    Ok(Json(load_effective_scan_defaults(&state)?))
}

async fn update_scan_settings(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(payload): Json<ScanDefaultsSummary>,
) -> Result<Json<ScanDefaultsSummary>, StatusCode> {
    require_settings_access(&state, &jar)?;
    let normalized = state
        .config
        .with_scan_defaults_summary(&payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?
        .scan_defaults_summary();
    let persisted = state
        .store
        .upsert_scan_settings(&normalized)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(persisted))
}

async fn get_bin_dataset_status(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Option<BinDatasetStatus>>, StatusCode> {
    require_auth(&state, &jar)?;
    let status = state
        .store
        .load_bin_dataset_status()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(status))
}

async fn import_bin_dataset(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(payload): Json<BinDatasetImportRequest>,
) -> Result<Json<BinDatasetStatus>, StatusCode> {
    require_write_access(&state, &jar)?;
    let status = state
        .store
        .import_bin_dataset(&payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(Json(status))
}

async fn bin_lookup(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(payload): Json<BinLookupRequest>,
) -> Result<Json<BinLookupResponse>, StatusCode> {
    require_auth(&state, &jar)?;

    let candidates = parse_bin_lookup_candidates(&payload.text);
    let processed_lines = payload.text.lines().count();
    let matched_lines = candidates.len();
    let limit = normalized_bin_lookup_limit(payload.limit);

    let line_previews_by_number = payload
        .text
        .lines()
        .enumerate()
        .map(|(index, raw_line)| (index + 1, bin_lookup_line_preview(raw_line)))
        .collect::<std::collections::HashMap<_, _>>();

    let mut aggregated = std::collections::BTreeMap::<String, (usize, Vec<usize>)>::new();
    for candidate in candidates {
        let entry = aggregated
            .entry(candidate.bin)
            .or_insert_with(|| (0usize, Vec::new()));
        entry.0 += 1;
        if !entry.1.contains(&candidate.line_number) {
            entry.1.push(candidate.line_number);
        }
    }

    let bins = aggregated.keys().cloned().collect::<Vec<_>>();
    let metadata = state
        .store
        .lookup_bin_metadata(&bins)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let metadata_by_bin = metadata
        .into_iter()
        .map(|record| (record.bin.clone(), record))
        .collect::<std::collections::HashMap<_, _>>();

    let matches = aggregated
        .into_iter()
        .take(limit)
        .map(|(bin, (occurrences, line_numbers))| {
            let line_previews = line_numbers
                .iter()
                .filter_map(|line_number| {
                    line_previews_by_number
                        .get(line_number)
                        .map(|text| BinLookupLinePreview {
                            line_number: *line_number,
                            text: text.clone(),
                        })
                })
                .collect::<Vec<_>>();

            BinLookupMatch {
                metadata: metadata_by_bin.get(&bin).cloned(),
                bin,
                occurrences,
                line_numbers,
                line_previews,
            }
        })
        .collect::<Vec<_>>();

    let response = BinLookupResponse {
        dataset: state
            .store
            .load_bin_dataset_status()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        processed_lines,
        matched_lines,
        unique_bins: bins.len(),
        matches,
    };

    Ok(Json(response))
}

async fn list_targets(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<TargetRecord>>, StatusCode> {
    require_auth(&state, &jar)?;
    let targets = state
        .store
        .list_targets()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(targets))
}

async fn create_target(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(payload): Json<TargetDefinition>,
) -> Result<Json<TargetRecord>, StatusCode> {
    require_write_access(&state, &jar)?;
    let normalized = state
        .config
        .normalize_target_definition(payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let target = state
        .store
        .upsert_target(&normalized)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(target))
}

async fn list_repositories(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<RepositoryRecord>>, StatusCode> {
    require_auth(&state, &jar)?;
    let repositories = state
        .store
        .list_repositories()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(repositories))
}

async fn create_repository(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(payload): Json<RepositoryDefinition>,
) -> Result<Json<RepositoryRecord>, StatusCode> {
    require_write_access(&state, &jar)?;
    let normalized = state
        .config
        .normalize_repository_definition(payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let repository = state
        .store
        .upsert_repository(&normalized)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(repository))
}

async fn list_port_scans(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<PortScanRecord>>, StatusCode> {
    require_auth(&state, &jar)?;
    let port_scans = state
        .store
        .list_port_scans(50)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(port_scans))
}

async fn queue_port_scan(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(payload): Json<PortScanRequest>,
) -> Result<Json<PortScanRecord>, StatusCode> {
    let session = require_write_access(&state, &jar)?;
    let normalized = state
        .config
        .normalize_port_scan_request(payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let port_scan = state
        .store
        .queue_port_scan(Some(&session.username), &normalized)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    state
        .store
        .append_event(
            None,
            &ApiEvent::PortScanQueued {
                port_scan: port_scan.clone(),
            },
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(port_scan))
}

async fn list_workers(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<WorkerRecord>>, StatusCode> {
    require_auth(&state, &jar)?;
    let workers = state
        .store
        .list_workers()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(workers))
}

async fn list_worker_pools(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<WorkerPoolRecord>>, StatusCode> {
    require_auth(&state, &jar)?;
    let pools = state
        .store
        .list_worker_pools()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(pools))
}

async fn get_worker(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Path(worker_id): Path<String>,
) -> Result<Json<WorkerRecord>, StatusCode> {
    require_auth(&state, &jar)?;
    let worker = state
        .store
        .get_worker(&worker_id)
        .map_err(|_| StatusCode::BAD_REQUEST)?
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(worker))
}

async fn update_worker_lifecycle(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Path(worker_id): Path<String>,
    Json(payload): Json<WorkerLifecycleUpdateRequest>,
) -> Result<Json<WorkerRecord>, StatusCode> {
    require_worker_management_access(&state, &jar)?;
    let worker = state
        .store
        .update_worker_lifecycle_state(&worker_id, payload.lifecycle_state)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    state
        .store
        .append_event(
            None,
            &ApiEvent::WorkerStateChanged {
                worker: worker.clone(),
            },
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(worker))
}

async fn list_worker_enrollment_tokens(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<WorkerEnrollmentTokenRecord>>, StatusCode> {
    require_worker_management_access(&state, &jar)?;
    let tokens = state
        .store
        .list_worker_enrollment_tokens()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(tokens))
}

async fn issue_worker_enrollment_token(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(payload): Json<WorkerEnrollmentTokenIssueRequest>,
) -> Result<Json<WorkerEnrollmentTokenIssued>, StatusCode> {
    let session = require_worker_management_access(&state, &jar)?;
    let issued = state
        .store
        .issue_worker_enrollment_token(Some(&session.username), &payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    state
        .store
        .append_event(
            None,
            &ApiEvent::WorkerEnrollmentTokenIssued {
                token: issued.record.clone(),
            },
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(issued))
}

async fn revoke_worker_enrollment_token(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Path(token_id): Path<i64>,
) -> Result<Json<WorkerEnrollmentTokenRecord>, StatusCode> {
    require_worker_management_access(&state, &jar)?;
    let token = state
        .store
        .revoke_worker_enrollment_token(token_id)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    state
        .store
        .append_event(
            None,
            &ApiEvent::WorkerEnrollmentTokenRevoked {
                token: token.clone(),
            },
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(token))
}

async fn list_bootstrap_candidates(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<WorkerBootstrapCandidateRecord>>, StatusCode> {
    require_worker_management_access(&state, &jar)?;
    let candidates = state
        .store
        .list_bootstrap_candidates()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(candidates))
}

async fn list_bootstrap_jobs(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<WorkerBootstrapJobRecord>>, StatusCode> {
    require_auth(&state, &jar)?;
    let jobs = state
        .store
        .list_bootstrap_jobs()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(jobs))
}

async fn approve_bootstrap_candidate(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Path(candidate_id): Path<i64>,
    Json(payload): Json<WorkerBootstrapCandidateApprovalRequest>,
) -> Result<Json<WorkerBootstrapCandidateApproval>, StatusCode> {
    let session = require_bootstrap_approval_access(&state, &jar)?;
    let approval = state
        .store
        .approve_bootstrap_candidate(candidate_id, Some(&session.username), &payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    state
        .store
        .append_event(
            None,
            &ApiEvent::WorkerBootstrapCandidateApproved {
                candidate: approval.candidate.clone(),
                token: approval.token.record.clone(),
            },
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    state
        .store
        .append_event(
            None,
            &ApiEvent::WorkerEnrollmentTokenIssued {
                token: approval.token.record.clone(),
            },
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(bootstrap_job) = &approval.bootstrap_job {
        state
            .store
            .append_event(
                None,
                &ApiEvent::WorkerBootstrapJobQueued {
                    job: bootstrap_job.clone(),
                },
            )
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    Ok(Json(approval))
}

async fn reject_bootstrap_candidate(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Path(candidate_id): Path<i64>,
    Json(payload): Json<WorkerBootstrapCandidateRejectionRequest>,
) -> Result<Json<WorkerBootstrapCandidateRecord>, StatusCode> {
    require_bootstrap_approval_access(&state, &jar)?;
    let candidate = state
        .store
        .reject_bootstrap_candidate(candidate_id, &payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    state
        .store
        .append_event(
            None,
            &ApiEvent::WorkerBootstrapCandidateRejected {
                candidate: candidate.clone(),
            },
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(candidate))
}

async fn list_runs(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<ScanRunRecord>>, StatusCode> {
    require_auth(&state, &jar)?;
    let runs = state
        .store
        .list_runs(25)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(runs))
}

async fn queue_run(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    body: Bytes,
) -> Result<Json<RunSummary>, StatusCode> {
    let session = require_write_access(&state, &jar)?;
    let request = if body.iter().all(|byte| byte.is_ascii_whitespace()) {
        RunRequest::default()
    } else {
        serde_json::from_slice::<RunRequest>(&body).map_err(|_| StatusCode::BAD_REQUEST)?
    };
    let run = state
        .store
        .queue_run(Some(&session.username), request.scope.as_ref())
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let summary = state
        .store
        .summary(run.id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    state
        .store
        .append_event(
            Some(run.id),
            &ApiEvent::RunQueued {
                run,
                summary: summary.clone(),
            },
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(summary))
}

async fn list_schedules(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<RecurringScheduleRecord>>, StatusCode> {
    require_auth(&state, &jar)?;
    let schedules = state
        .store
        .list_schedules()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(schedules))
}

async fn create_schedule(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(payload): Json<ScheduleRequest>,
) -> Result<Json<RecurringScheduleRecord>, StatusCode> {
    let session = require_write_access(&state, &jar)?;
    let schedule = state
        .store
        .upsert_schedule(
            &payload.label,
            payload.interval_seconds,
            payload.enabled.unwrap_or(true),
            Some(&session.username),
            payload.scope.as_ref(),
        )
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(Json(schedule))
}

async fn list_findings(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Query(query): Query<FindingsQuery>,
) -> Result<Json<Vec<FindingRecord>>, StatusCode> {
    require_auth(&state, &jar)?;
    let findings = state
        .store
        .search_findings(&query)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(findings))
}

async fn list_finding_publications(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> Result<Json<Vec<PublicFindingModerationRecord>>, StatusCode> {
    let session = require_auth(&state, &jar)?;
    let publications = state
        .store
        .list_public_finding_moderation_records()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(sanitize_public_finding_moderation_records(
        publications,
        session.role.can_moderate_public_findings(),
    )))
}

async fn moderate_public_finding(
    Path(finding_id): Path<i64>,
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(payload): Json<PublicFindingModerationRequest>,
) -> Result<Json<PublicFindingModerationRecord>, StatusCode> {
    let session = require_public_finding_moderation_access(&state, &jar)?;
    let record = state
        .store
        .moderate_public_finding(finding_id, Some(&session.username), &payload)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    state
        .store
        .append_event(
            None,
            &ApiEvent::PublicFindingModerated {
                finding: record.clone(),
            },
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(record))
}

async fn event_stream(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Query(query): Query<EventQuery>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    let session = require_auth(&state, &jar)?;
    let store = state.store.clone();
    let requested_run = query.run_id;
    let initial_cursor = query.cursor.unwrap_or(0);
    let can_view_private_publication_notes = session.role.can_moderate_public_findings();

    let event_stream = stream! {
        let mut cursor = initial_cursor;
        loop {
            let events = store.list_events_since(cursor, 100).unwrap_or_default();
            if events.is_empty() {
                yield Ok(Event::default().event("keepalive").data("{\"type\":\"keepalive\"}"));
            } else {
                for stored_event in events {
                    cursor = stored_event.id;
                    if requested_run.map(|run_id| Some(run_id) == stored_event.run_id).unwrap_or(true) {
                        let payload = sanitize_api_event_for_session(
                            stored_event.payload.clone(),
                            can_view_private_publication_notes,
                        );
                        if let Ok(payload) = serde_json::to_string(&payload) {
                            yield Ok(Event::default()
                                .id(stored_event.id.to_string())
                                .event("api_event")
                                .data(payload));
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    };

    Ok(Sse::new(event_stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}

fn seed_bootstrap_inventory(store: &AnyScanStore, config: &AppConfig) -> Result<()> {
    for target in config.normalized_bootstrap_targets()? {
        store.upsert_target(&target)?;
    }
    for repository in config.normalized_bootstrap_repositories()? {
        store.upsert_repository(&repository)?;
    }
    Ok(())
}

fn load_effective_scan_defaults(state: &AppState) -> Result<ScanDefaultsSummary, StatusCode> {
    match state
        .store
        .load_scan_settings()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        Some(settings) => Ok(settings),
        None => Ok(state.config.scan_defaults_summary()),
    }
}

fn session_response(session: &SessionContext) -> SessionResponse {
    SessionResponse {
        username: session.username.clone(),
        role: session.role,
        permissions: SessionPermissions {
            write: session.role.can_write(),
            manage_settings: session.role.can_manage_settings(),
            manage_operators: session.role.can_manage_operators(),
            manage_workers: session.role.can_manage_workers(),
            approve_bootstrap_candidates: session.role.can_approve_bootstrap_candidates(),
            moderate_public_findings: session.role.can_moderate_public_findings(),
        },
    }
}

fn sanitize_public_finding_moderation_record(
    mut record: PublicFindingModerationRecord,
    can_view_private_notes: bool,
) -> PublicFindingModerationRecord {
    if !can_view_private_notes {
        record.reviewer_notes = None;
    }
    record
}

fn sanitize_public_finding_moderation_records(
    records: Vec<PublicFindingModerationRecord>,
    can_view_private_notes: bool,
) -> Vec<PublicFindingModerationRecord> {
    records
        .into_iter()
        .map(|record| sanitize_public_finding_moderation_record(record, can_view_private_notes))
        .collect()
}

fn sanitize_api_event_for_session(
    event: ApiEvent,
    can_view_private_publication_notes: bool,
) -> ApiEvent {
    match event {
        ApiEvent::PublicFindingModerated { finding } => ApiEvent::PublicFindingModerated {
            finding: sanitize_public_finding_moderation_record(
                finding,
                can_view_private_publication_notes,
            ),
        },
        other => other,
    }
}

fn require_auth(state: &AppState, jar: &CookieJar) -> Result<SessionContext, StatusCode> {
    let cookie = jar.get(SESSION_COOKIE).ok_or(StatusCode::UNAUTHORIZED)?;
    let token = cookie.value();
    let claims = decode::<SessionClaims>(
        token,
        &DecodingKey::from_secret(state.config.auth.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let operator = state
        .config
        .operator(&claims.claims.sub)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !operator.enabled {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(SessionContext {
        username: operator.username,
        role: operator.role,
    })
}

fn require_write_access(state: &AppState, jar: &CookieJar) -> Result<SessionContext, StatusCode> {
    let session = require_auth(state, jar)?;
    if !session.role.can_write() {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(session)
}

fn require_settings_access(
    state: &AppState,
    jar: &CookieJar,
) -> Result<SessionContext, StatusCode> {
    let session = require_auth(state, jar)?;
    if !session.role.can_manage_settings() {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(session)
}

fn require_worker_management_access(
    state: &AppState,
    jar: &CookieJar,
) -> Result<SessionContext, StatusCode> {
    let session = require_auth(state, jar)?;
    if !session.role.can_manage_workers() {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(session)
}

fn require_bootstrap_approval_access(
    state: &AppState,
    jar: &CookieJar,
) -> Result<SessionContext, StatusCode> {
    let session = require_auth(state, jar)?;
    if !session.role.can_approve_bootstrap_candidates() {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(session)
}

fn require_public_finding_moderation_access(
    state: &AppState,
    jar: &CookieJar,
) -> Result<SessionContext, StatusCode> {
    let session = require_auth(state, jar)?;
    if !session.role.can_moderate_public_findings() {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(session)
}

fn build_session_token(config: &AppConfig, session: &SessionContext) -> Result<String> {
    let issued_at = Utc::now().timestamp() as usize;
    let claims = SessionClaims {
        sub: session.username.clone(),
        role: session.role,
        iat: issued_at,
        exp: issued_at + config.auth.session_ttl_seconds as usize,
    };
    Ok(encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(config.auth.jwt_secret.as_bytes()),
    )?)
}

fn build_public_profile_response(
    config: &AppConfig,
    scan_defaults: &ScanDefaultsSummary,
) -> PublicProfileResponse {
    let user_agent_examples = if config.public.user_agent_examples.is_empty() {
        vec![config.scan.user_agent.clone()]
    } else {
        config.public.user_agent_examples.clone()
    };
    PublicProfileResponse {
        service_name: config.public.service_name.clone(),
        base_url: config.public.base_url.clone(),
        security_email: config.public.security_email.clone(),
        abuse_email: config.public.abuse_email.clone(),
        opt_out_email: config.public.opt_out_email.clone(),
        scanner_ip_ranges: config.public.scanner_ip_ranges.clone(),
        scanner_asns: config.public.scanner_asns.clone(),
        reverse_dns_patterns: config.public.reverse_dns_patterns.clone(),
        user_agent_examples,
        published_search_scope: config.public.published_search_scope.clone(),
        data_retention_days: config.public.data_retention_days,
        opt_out_response_sla_hours: config.public.opt_out_response_sla_hours,
        max_concurrent_requests_per_host: scan_defaults.max_concurrent_requests_per_host,
        allow_authenticated_request_profiles: config.scan.allow_authenticated_request_profiles,
        rate_limit_policy: format!(
            "At most {} concurrent request(s) per host with {}ms-{}ms host backoff.",
            scan_defaults.max_concurrent_requests_per_host,
            scan_defaults.host_backoff_initial_ms,
            scan_defaults.host_backoff_max_ms
        ),
        scanning_policy_url: public_url(config, "/scanning-policy"),
        scanner_identity_url: public_url(config, "/scanner-identity"),
        data_policy_url: public_url(config, "/data-policy"),
        claim_url: public_url(config, "/claim"),
        opt_out_url: public_url(config, "/opt-out"),
        abuse_url: public_url(config, "/abuse"),
        security_txt_url: public_url(config, "/.well-known/security.txt"),
    }
}

fn public_url(config: &AppConfig, path: &str) -> String {
    match config.public.base_url.as_deref() {
        Some(base_url) => format!("{}{}", base_url.trim_end_matches('/'), path),
        None => path.to_string(),
    }
}

fn build_security_txt(config: &AppConfig) -> String {
    let scan_defaults = config.scan_defaults_summary();
    let profile = build_public_profile_response(config, &scan_defaults);
    let canonical_line = profile
        .base_url
        .as_ref()
        .map(|_| format!("Canonical: {}", profile.security_txt_url))
        .unwrap_or_default();
    let expiration = Utc::now() + chrono::Duration::days(365);
    let mut lines = vec![
        format!("Contact: mailto:{}", profile.security_email),
        format!("Contact: mailto:{}", profile.abuse_email),
        format!("Policy: {}", profile.scanning_policy_url),
        format!("Expires: {}", expiration.to_rfc3339()),
    ];
    if !canonical_line.is_empty() {
        lines.push(canonical_line);
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyscan::core::{PublicFindingStatus, Severity};

    fn sample_public_finding_moderation_record() -> PublicFindingModerationRecord {
        let now = Utc::now();
        PublicFindingModerationRecord {
            finding_id: 7,
            detector: "http".to_string(),
            severity: Severity::High,
            target_base_url: "https://example.test".to_string(),
            path: "/admin".to_string(),
            public_summary: "Admin panel requires authentication.".to_string(),
            reviewer_notes: Some("Contains reproduction details for operators only.".to_string()),
            status: PublicFindingStatus::Published,
            reviewed_by: Some("reviewer".to_string()),
            observed_at: now,
            reviewed_at: now,
            published_at: Some(now),
            updated_at: now,
        }
    }

    #[test]
    fn sanitize_public_finding_moderation_record_hides_private_notes() {
        let record = sample_public_finding_moderation_record();
        let sanitized = sanitize_public_finding_moderation_record(record, false);

        assert_eq!(sanitized.reviewer_notes, None);
    }

    #[test]
    fn sanitize_public_finding_moderation_record_preserves_notes_for_moderators() {
        let record = sample_public_finding_moderation_record();
        let sanitized = sanitize_public_finding_moderation_record(record.clone(), true);

        assert_eq!(sanitized.reviewer_notes, record.reviewer_notes);
    }

    #[test]
    fn sanitize_public_finding_moderation_records_hides_private_notes_in_lists() {
        let records = vec![sample_public_finding_moderation_record()];
        let sanitized = sanitize_public_finding_moderation_records(records, false);

        assert_eq!(sanitized.len(), 1);
        assert_eq!(sanitized[0].reviewer_notes, None);
    }

    #[test]
    fn sanitize_api_event_for_session_hides_public_finding_notes_from_read_only_sessions() {
        let event = ApiEvent::PublicFindingModerated {
            finding: sample_public_finding_moderation_record(),
        };

        let sanitized = sanitize_api_event_for_session(event, false);

        match sanitized {
            ApiEvent::PublicFindingModerated { finding } => {
                assert_eq!(finding.reviewer_notes, None);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn sanitize_api_event_for_session_preserves_public_finding_notes_for_moderators() {
        let event = ApiEvent::PublicFindingModerated {
            finding: sample_public_finding_moderation_record(),
        };

        let sanitized = sanitize_api_event_for_session(event.clone(), true);

        match sanitized {
            ApiEvent::PublicFindingModerated { finding } => {
                let ApiEvent::PublicFindingModerated { finding: original } = event else {
                    unreachable!();
                };
                assert_eq!(finding.reviewer_notes, original.reviewer_notes);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }
}

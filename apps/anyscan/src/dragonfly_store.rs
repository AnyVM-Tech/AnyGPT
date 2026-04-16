use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Read,
    net::IpAddr,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use redis::{Commands, Script, streams::StreamRangeReply};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::{
    config::{AppConfig, StorageConfig},
    core::{
        AbuseReportRecord, AbuseReportRequest, ApiEvent, BinDatasetImportRequest, BinDatasetStatus,
        BinMetadataRecord, DashboardSnapshot, DetectorFindingStat, DiscoveryProvenanceRecord,
        FailedTargetRecord, FetchTelemetry, FindingRecord, FindingsQuery, HybridFindingsRanker,
        JobStatus, NewFinding, OptOutRecord, OptOutRequest, OwnershipClaimRecord,
        OwnershipClaimRequest, PortScanRecord, PortScanRequest, PublicFindingModerationRecord,
        PublicFindingModerationRequest, PublicFindingRecord, PublicFindingSearchQuery,
        PublicFindingStatus, PublicResourceKind, PublicWorkflowStatus, PublicWorkflowStatusUpdate,
        RecurringScheduleRecord, RepositoryDefinition, RepositoryRecord, RunProgressSnapshot,
        RunScope, RunStatus, RunSummary, ScanDefaultsSummary, ScanJobRecord, ScanRunRecord,
        Severity, StoredEvent, TargetDefinition, TargetRecord, WorkerBootstrapCandidateApproval,
        WorkerBootstrapCandidateApprovalRequest, WorkerBootstrapCandidateInput,
        WorkerBootstrapCandidateRecord, WorkerBootstrapCandidateRejectionRequest,
        WorkerBootstrapCandidateStatus, WorkerBootstrapDispatchRequest, WorkerBootstrapJobClaim,
        WorkerBootstrapJobRecord, WorkerBootstrapJobStatus, WorkerEnrollmentTokenIssueRequest,
        WorkerEnrollmentTokenIssued, WorkerEnrollmentTokenRecord, WorkerLifecycleState,
        WorkerPoolRecord, WorkerRecord, WorkerRegistration, merge_coverage_source_stats,
        normalize_public_finding_search_query, normalize_run_scope, run_findings_query,
        sort_coverage_source_stats, utc_now,
    },
};

#[derive(Debug, Clone)]
pub struct DragonflyAnyScanStore {
    client: redis::Client,
    key_prefix: String,
    startup_wait: bool,
    startup_timeout_seconds: u64,
    lock_ttl_ms: u64,
    lock_retry_delay_ms: u64,
    lock_max_wait_ms: u64,
}

const NAMESPACE_KEY_SAMPLE_LIMIT: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DragonflyRuntimeState {
    next_target_id: i64,
    #[serde(default)]
    next_repository_id: i64,
    #[serde(default)]
    next_port_scan_id: i64,
    #[serde(default)]
    next_worker_enrollment_token_id: i64,
    #[serde(default)]
    next_bootstrap_candidate_id: i64,
    #[serde(default)]
    next_bootstrap_job_id: i64,
    #[serde(default)]
    next_ownership_claim_id: i64,
    #[serde(default)]
    next_opt_out_id: i64,
    #[serde(default)]
    next_abuse_report_id: i64,
    next_run_id: i64,
    next_job_id: i64,
    next_finding_id: i64,
    next_event_id: i64,
    next_schedule_id: i64,
    targets: Vec<TargetRecord>,
    #[serde(default)]
    repositories: Vec<RepositoryRecord>,
    #[serde(default)]
    port_scans: Vec<StoredPortScan>,
    runs: Vec<StoredRun>,
    jobs: Vec<ScanJobRecord>,
    #[serde(default)]
    workers: Vec<WorkerRecord>,
    #[serde(default)]
    worker_enrollment_tokens: Vec<StoredWorkerEnrollmentToken>,
    #[serde(default)]
    bootstrap_candidates: Vec<WorkerBootstrapCandidateRecord>,
    #[serde(default)]
    bootstrap_jobs: Vec<WorkerBootstrapJobRecord>,
    #[serde(default)]
    ownership_claims: Vec<OwnershipClaimRecord>,
    #[serde(default)]
    opt_out_requests: Vec<OptOutRecord>,
    #[serde(default)]
    abuse_reports: Vec<AbuseReportRecord>,
    #[serde(default)]
    public_finding_moderation: Vec<PublicFindingModerationRecord>,
    #[serde(default)]
    job_claims: BTreeMap<i64, StoredJobClaim>,
    #[serde(default)]
    bootstrap_job_claims: BTreeMap<i64, StoredJobClaim>,
    #[serde(default)]
    scan_settings: Option<ScanDefaultsSummary>,
    findings: Vec<FindingRecord>,
    events: Vec<StoredEvent>,
    schedules: Vec<RecurringScheduleRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredWorkerEnrollmentToken {
    record: WorkerEnrollmentTokenRecord,
    token_hash: String,
    #[serde(default)]
    token_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredRun {
    schedule_id: Option<i64>,
    run: ScanRunRecord,
    #[serde(default)]
    claimed_by: Option<String>,
    #[serde(default)]
    claim_expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredPortScan {
    port_scan: PortScanRecord,
    #[serde(default)]
    claimed_by: Option<String>,
    #[serde(default)]
    claim_expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredJobClaim {
    claimed_by: String,
    claim_expires_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct BinCsvRow {
    #[serde(rename = "BIN")]
    bin: String,
    #[serde(rename = "Brand")]
    brand: Option<String>,
    #[serde(rename = "Type")]
    card_type: Option<String>,
    #[serde(rename = "Category")]
    category: Option<String>,
    #[serde(rename = "Issuer")]
    issuer: Option<String>,
    #[serde(rename = "IssuerPhone")]
    issuer_phone: Option<String>,
    #[serde(rename = "IssuerUrl")]
    issuer_url: Option<String>,
    #[serde(rename = "isoCode2")]
    iso_code2: Option<String>,
    #[serde(rename = "isoCode3")]
    iso_code3: Option<String>,
    #[serde(rename = "CountryName")]
    country_name: Option<String>,
}

impl DragonflyRuntimeState {
    fn repair_counters(&mut self) {
        self.next_target_id = self.next_target_id.max(
            self.targets
                .iter()
                .map(|target| target.id)
                .max()
                .unwrap_or(0),
        );
        self.next_repository_id = self.next_repository_id.max(
            self.repositories
                .iter()
                .map(|repository| repository.id)
                .max()
                .unwrap_or(0),
        );
        self.next_port_scan_id = self.next_port_scan_id.max(
            self.port_scans
                .iter()
                .map(|port_scan| port_scan.port_scan.id)
                .max()
                .unwrap_or(0),
        );
        self.next_worker_enrollment_token_id = self.next_worker_enrollment_token_id.max(
            self.worker_enrollment_tokens
                .iter()
                .map(|token| token.record.id)
                .max()
                .unwrap_or(0),
        );
        self.next_bootstrap_candidate_id = self.next_bootstrap_candidate_id.max(
            self.bootstrap_candidates
                .iter()
                .map(|candidate| candidate.id)
                .max()
                .unwrap_or(0),
        );
        self.next_bootstrap_job_id = self.next_bootstrap_job_id.max(
            self.bootstrap_jobs
                .iter()
                .map(|job| job.id)
                .max()
                .unwrap_or(0),
        );
        self.next_ownership_claim_id = self.next_ownership_claim_id.max(
            self.ownership_claims
                .iter()
                .map(|claim| claim.id)
                .max()
                .unwrap_or(0),
        );
        self.next_opt_out_id = self.next_opt_out_id.max(
            self.opt_out_requests
                .iter()
                .map(|record| record.id)
                .max()
                .unwrap_or(0),
        );
        self.next_abuse_report_id = self.next_abuse_report_id.max(
            self.abuse_reports
                .iter()
                .map(|report| report.id)
                .max()
                .unwrap_or(0),
        );
        self.next_run_id = self
            .next_run_id
            .max(self.runs.iter().map(|run| run.run.id).max().unwrap_or(0));
        self.next_job_id = self
            .next_job_id
            .max(self.jobs.iter().map(|job| job.id).max().unwrap_or(0));
        self.next_finding_id = self.next_finding_id.max(
            self.findings
                .iter()
                .map(|finding| finding.id)
                .max()
                .unwrap_or(0),
        );
        self.workers
            .sort_by(|left, right| left.worker_id.cmp(&right.worker_id));
        self.worker_enrollment_tokens
            .sort_by(|left, right| left.record.id.cmp(&right.record.id));
        self.bootstrap_candidates
            .sort_by(|left, right| left.id.cmp(&right.id));
        self.bootstrap_jobs
            .sort_by(|left, right| left.id.cmp(&right.id));
        self.ownership_claims
            .sort_by(|left, right| left.id.cmp(&right.id));
        self.opt_out_requests
            .sort_by(|left, right| left.id.cmp(&right.id));
        self.abuse_reports
            .sort_by(|left, right| left.id.cmp(&right.id));
        self.public_finding_moderation
            .sort_by(|left, right| left.finding_id.cmp(&right.finding_id));
        self.next_event_id = self
            .next_event_id
            .max(self.events.iter().map(|event| event.id).max().unwrap_or(0));
        self.next_schedule_id = self.next_schedule_id.max(
            self.schedules
                .iter()
                .map(|schedule| schedule.id)
                .max()
                .unwrap_or(0),
        );
    }

    fn next_target_id(&mut self) -> i64 {
        self.next_target_id += 1;
        self.next_target_id
    }

    fn next_repository_id(&mut self) -> i64 {
        self.next_repository_id += 1;
        self.next_repository_id
    }

    fn next_port_scan_id(&mut self) -> i64 {
        self.next_port_scan_id += 1;
        self.next_port_scan_id
    }

    fn next_worker_enrollment_token_id(&mut self) -> i64 {
        self.next_worker_enrollment_token_id += 1;
        self.next_worker_enrollment_token_id
    }

    fn next_bootstrap_candidate_id(&mut self) -> i64 {
        self.next_bootstrap_candidate_id += 1;
        self.next_bootstrap_candidate_id
    }

    fn next_bootstrap_job_id(&mut self) -> i64 {
        self.next_bootstrap_job_id += 1;
        self.next_bootstrap_job_id
    }

    fn next_ownership_claim_id(&mut self) -> i64 {
        self.next_ownership_claim_id += 1;
        self.next_ownership_claim_id
    }

    fn next_opt_out_id(&mut self) -> i64 {
        self.next_opt_out_id += 1;
        self.next_opt_out_id
    }

    fn next_abuse_report_id(&mut self) -> i64 {
        self.next_abuse_report_id += 1;
        self.next_abuse_report_id
    }

    fn next_run_id(&mut self) -> i64 {
        self.next_run_id += 1;
        self.next_run_id
    }

    fn next_job_id(&mut self) -> i64 {
        self.next_job_id += 1;
        self.next_job_id
    }

    fn next_finding_id(&mut self) -> i64 {
        self.next_finding_id += 1;
        self.next_finding_id
    }

    fn next_schedule_id(&mut self) -> i64 {
        self.next_schedule_id += 1;
        self.next_schedule_id
    }
}

impl DragonflyAnyScanStore {
    pub fn from_config(config: &AppConfig) -> Result<Self> {
        let connection_url = build_redis_connection_url(&config.storage)?;
        let client = redis::Client::open(connection_url.clone()).with_context(|| {
            format!(
                "failed to create Dragonfly client for {}",
                redact_connection_url(&connection_url)
            )
        })?;
        Ok(Self {
            client,
            key_prefix: config.storage.redis_key_prefix.clone(),
            startup_wait: config.storage.redis_startup_wait,
            startup_timeout_seconds: config.storage.redis_startup_timeout_seconds,
            lock_ttl_ms: config.storage.redis_lock_ttl_ms,
            lock_retry_delay_ms: config.storage.redis_lock_retry_delay_ms,
            lock_max_wait_ms: config.storage.redis_lock_max_wait_ms,
        })
    }

    pub fn initialize(&self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(self.startup_timeout_seconds);

        let last_error = loop {
            match self.try_ping() {
                Ok(()) => {
                    self.initialize_state_namespace()?;
                    return Ok(());
                }
                Err(error) => {
                    if !self.startup_wait || Instant::now() >= deadline {
                        break error;
                    }
                }
            }

            thread::sleep(Duration::from_millis(250));
        };

        if self.startup_wait {
            Err(last_error).with_context(|| {
                format!(
                    "timed out waiting {}s for Dragonfly to become ready",
                    self.startup_timeout_seconds
                )
            })
        } else {
            Err(last_error).context("failed to connect to Dragonfly during startup")
        }
    }

    fn initialize_state_namespace(&self) -> Result<()> {
        let mut connection = self.open_connection_for_write("initializing runtime state")?;
        let token = self.acquire_lock(&mut connection)?;
        let result = (|| {
            let state_exists = self.state_exists(&mut connection)?;
            if !state_exists {
                self.ensure_namespace_available_for_bootstrap(&mut connection)?;
            }
            let mut state = self.load_state(&mut connection)?;
            self.prepare_state_locked(&mut connection, &mut state)?;
            self.save_state(&mut connection, &state)?;
            Ok(())
        })();
        let release_result = self.release_lock(&mut connection, &token);
        match (result, release_result) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) => Err(error),
            (Ok(()), Err(error)) => Err(error),
            (Err(error), Err(release_error)) => Err(error)
                .with_context(|| format!("also failed to release Dragonfly lock: {release_error}")),
        }
    }

    pub fn upsert_target(&self, target: &TargetDefinition) -> Result<TargetRecord> {
        self.with_state_mut(|state| {
            let now = utc_now();
            if let Some(existing) = state
                .targets
                .iter_mut()
                .find(|record| record.base_url == target.base_url)
            {
                existing.label = target.label.clone();
                existing.strategy = target.strategy;
                existing.paths = target.paths.clone();
                existing.tags = target.tags.clone();
                existing.request_profile = target.request_profile.clone();
                existing.gobuster = target.gobuster.clone();
                existing.enabled = true;
                existing.updated_at = now;
                return Ok(existing.clone());
            }

            let record = TargetRecord {
                id: state.next_target_id(),
                label: target.label.clone(),
                base_url: target.base_url.clone(),
                strategy: target.strategy,
                paths: target.paths.clone(),
                tags: target.tags.clone(),
                request_profile: target.request_profile.clone(),
                gobuster: target.gobuster.clone(),
                discovery_provenance: Vec::new(),
                enabled: true,
                created_at: now,
                updated_at: now,
            };
            state.targets.push(record.clone());
            Ok(record)
        })
    }

    pub fn list_targets(&self) -> Result<Vec<TargetRecord>> {
        self.with_state(|state| Ok(sorted_targets(state.targets.clone())))
    }

    pub fn list_enabled_targets(&self) -> Result<Vec<TargetRecord>> {
        self.with_state(|state| Ok(sorted_targets(enabled_targets(state))))
    }

    pub fn upsert_repository(&self, repository: &RepositoryDefinition) -> Result<RepositoryRecord> {
        self.with_state_mut(|state| {
            let now = utc_now();
            let github_match_index = state
                .repositories
                .iter()
                .position(|record| record.github_url == repository.github_url);
            let local_path_match_index = state
                .repositories
                .iter()
                .position(|record| record.local_path == repository.local_path);
            let existing_index = match (github_match_index, local_path_match_index) {
                (Some(github_index), Some(local_path_index))
                    if github_index != local_path_index =>
                {
                    return Err(anyhow!(
                        "repository {} and local path {} match different existing records",
                        repository.github_url,
                        repository.local_path
                    ));
                }
                (Some(index), _) | (_, Some(index)) => Some(index),
                (None, None) => None,
            };

            if let Some(index) = existing_index {
                let existing = &mut state.repositories[index];
                existing.name = repository.name.clone();
                existing.github_url = repository.github_url.clone();
                existing.local_path = repository.local_path.clone();
                existing.description = repository.description.clone();
                existing.status = repository.status.clone();
                existing.related_target_ids = repository.related_target_ids.clone();
                existing.updated_at = now;
                return Ok(existing.clone());
            }

            let record = RepositoryRecord {
                id: state.next_repository_id(),
                name: repository.name.clone(),
                github_url: repository.github_url.clone(),
                local_path: repository.local_path.clone(),
                description: repository.description.clone(),
                status: repository.status.clone(),
                related_target_ids: repository.related_target_ids.clone(),
                created_at: now,
                updated_at: now,
            };
            state.repositories.push(record.clone());
            Ok(record)
        })
    }

    pub fn list_repositories(&self) -> Result<Vec<RepositoryRecord>> {
        self.with_state(|state| Ok(sorted_repositories(state.repositories.clone())))
    }

    pub fn queue_port_scan(
        &self,
        requested_by: Option<&str>,
        request: &PortScanRequest,
    ) -> Result<PortScanRecord> {
        self.with_state_mut(|state| {
            let now = utc_now();
            let record = PortScanRecord {
                id: state.next_port_scan_id(),
                requested_by: requested_by.map(|value| value.to_string()),
                target_range: request.target_range.trim().to_string(),
                ports: request.ports.trim().to_string(),
                schemes: request.schemes,
                tags: request.tags.clone(),
                rate_limit: request.rate_limit,
                worker_pool: request.worker_pool.clone(),
                bootstrap_policy: request.bootstrap_policy.clone(),
                status: RunStatus::Queued,
                started_at: now,
                completed_at: None,
                discovered_endpoints_total: 0,
                imported_targets_total: 0,
                bootstrap_candidates_total: 0,
                queued_run_id: None,
                notes: None,
            };
            state.port_scans.push(StoredPortScan {
                port_scan: record.clone(),
                claimed_by: None,
                claim_expires_at: None,
            });
            Ok(record)
        })
    }

    pub fn list_port_scans(&self, limit: usize) -> Result<Vec<PortScanRecord>> {
        self.with_state(|state| {
            let mut port_scans = state
                .port_scans
                .iter()
                .map(|record| record.port_scan.clone())
                .collect::<Vec<_>>();
            port_scans.sort_by(|left, right| right.id.cmp(&left.id));
            if limit > 0 {
                port_scans.truncate(limit);
            }
            Ok(port_scans)
        })
    }

    pub fn register_worker(
        &self,
        registration: &WorkerRegistration,
        ttl_seconds: u64,
    ) -> Result<WorkerRecord> {
        let worker_id = registration.worker_id.trim();
        if worker_id.is_empty() {
            return Err(anyhow!("worker_id is required"));
        }
        let now = utc_now();
        self.with_state_mut(|state| register_worker_in_state(state, registration, ttl_seconds, now))
    }

    pub fn list_workers(&self) -> Result<Vec<WorkerRecord>> {
        self.with_state(|state| Ok(sorted_workers(state.workers.clone())))
    }

    pub fn get_worker(&self, worker_id: &str) -> Result<Option<WorkerRecord>> {
        let worker_id = worker_id.trim();
        if worker_id.is_empty() {
            return Err(anyhow!("worker_id is required"));
        }
        self.with_state(|state| {
            Ok(state
                .workers
                .iter()
                .find(|worker| worker.worker_id == worker_id)
                .cloned())
        })
    }

    pub fn list_worker_pools(&self) -> Result<Vec<WorkerPoolRecord>> {
        self.with_state(|state| Ok(compute_worker_pool_records(state, utc_now())))
    }

    pub fn update_worker_lifecycle_state(
        &self,
        worker_id: &str,
        lifecycle_state: WorkerLifecycleState,
    ) -> Result<WorkerRecord> {
        let worker_id = worker_id.trim();
        if worker_id.is_empty() {
            return Err(anyhow!(
                "worker_id is required to update worker lifecycle state"
            ));
        }
        self.with_state_mut(|state| {
            update_worker_lifecycle_state_in_state(state, worker_id, lifecycle_state, utc_now())
        })
    }

    pub fn list_worker_enrollment_tokens(&self) -> Result<Vec<WorkerEnrollmentTokenRecord>> {
        self.with_state(|state| {
            Ok(sorted_worker_enrollment_token_records(
                &state.worker_enrollment_tokens,
            ))
        })
    }

    pub fn issue_worker_enrollment_token(
        &self,
        created_by: Option<&str>,
        request: &WorkerEnrollmentTokenIssueRequest,
    ) -> Result<WorkerEnrollmentTokenIssued> {
        let now = utc_now();
        self.with_state_mut(|state| {
            issue_worker_enrollment_token_in_state(state, created_by, request, now)
        })
    }

    pub fn revoke_worker_enrollment_token(
        &self,
        token_id: i64,
    ) -> Result<WorkerEnrollmentTokenRecord> {
        self.with_state_mut(|state| {
            revoke_worker_enrollment_token_in_state(state, token_id, utc_now())
        })
    }

    pub fn list_bootstrap_candidates(&self) -> Result<Vec<WorkerBootstrapCandidateRecord>> {
        self.with_state(|state| {
            Ok(sorted_bootstrap_candidates(
                state.bootstrap_candidates.clone(),
            ))
        })
    }

    pub fn list_bootstrap_jobs(&self) -> Result<Vec<WorkerBootstrapJobRecord>> {
        self.with_state(|state| Ok(sorted_bootstrap_jobs(state.bootstrap_jobs.clone())))
    }

    pub fn create_bootstrap_candidates(
        &self,
        port_scan: &PortScanRecord,
        candidates: &[WorkerBootstrapCandidateInput],
    ) -> Result<Vec<WorkerBootstrapCandidateRecord>> {
        let now = utc_now();
        self.with_state_mut(|state| {
            create_bootstrap_candidates_in_state(state, port_scan, candidates, now)
        })
    }

    pub fn approve_bootstrap_candidate(
        &self,
        candidate_id: i64,
        approved_by: Option<&str>,
        request: &WorkerBootstrapCandidateApprovalRequest,
    ) -> Result<WorkerBootstrapCandidateApproval> {
        let now = utc_now();
        self.with_state_mut(|state| {
            approve_bootstrap_candidate_in_state(state, candidate_id, approved_by, request, now)
        })
    }

    pub fn reject_bootstrap_candidate(
        &self,
        candidate_id: i64,
        request: &WorkerBootstrapCandidateRejectionRequest,
    ) -> Result<WorkerBootstrapCandidateRecord> {
        self.with_state_mut(|state| {
            reject_bootstrap_candidate_in_state(state, candidate_id, request, utc_now())
        })
    }

    pub fn claim_next_pending_bootstrap_job(
        &self,
        worker_id: &str,
        lease_seconds: u64,
    ) -> Result<Option<WorkerBootstrapJobClaim>> {
        let worker_id = worker_id.trim();
        if worker_id.is_empty() {
            return Err(anyhow!("worker_id is required to claim a bootstrap job"));
        }
        let now = utc_now();
        self.with_state_mut(|state| {
            claim_next_pending_bootstrap_job_in_state(state, worker_id, now, lease_seconds)
        })
    }

    pub fn renew_bootstrap_job_claim(
        &self,
        job_id: i64,
        worker_id: &str,
        lease_seconds: u64,
    ) -> Result<()> {
        let now = utc_now();
        self.with_state_mut(|state| {
            let claim_expires_at = lease_expires_at(now, lease_seconds)?;
            let record = state
                .bootstrap_jobs
                .iter()
                .find(|record| record.id == job_id)
                .ok_or_else(|| anyhow!("bootstrap job {job_id} not found"))?;
            if record.claimed_by_worker_id.as_deref() != Some(worker_id) {
                return Err(anyhow!(
                    "bootstrap job {job_id} is not claimed by worker {worker_id}"
                ));
            }
            state.bootstrap_job_claims.insert(
                job_id,
                StoredJobClaim {
                    claimed_by: worker_id.to_string(),
                    claim_expires_at,
                },
            );
            Ok(())
        })
    }

    pub fn mark_bootstrap_job_started_if_owned(
        &self,
        job_id: i64,
        worker_id: &str,
    ) -> Result<Option<WorkerBootstrapJobRecord>> {
        self.with_state_mut(|state| {
            mark_bootstrap_job_started_if_owned_in_state(state, job_id, worker_id, utc_now())
        })
    }

    pub fn complete_bootstrap_job_if_owned(
        &self,
        job_id: i64,
        worker_id: &str,
        notes: Option<&str>,
    ) -> Result<Option<WorkerBootstrapJobRecord>> {
        self.with_state_mut(|state| {
            complete_bootstrap_job_if_owned_in_state(state, job_id, worker_id, notes, utc_now())
        })
    }

    pub fn fail_bootstrap_job_if_owned(
        &self,
        job_id: i64,
        worker_id: &str,
        notes: Option<&str>,
    ) -> Result<Option<WorkerBootstrapJobRecord>> {
        self.with_state_mut(|state| {
            fail_bootstrap_job_if_owned_in_state(state, job_id, worker_id, notes, utc_now())
        })
    }

    pub fn claim_next_pending_port_scan(
        &self,
        worker_id: &str,
        lease_seconds: u64,
    ) -> Result<Option<PortScanRecord>> {
        let worker_id = worker_id.trim();
        if worker_id.is_empty() {
            return Err(anyhow!(
                "worker_id is required to claim a Dragonfly port scan"
            ));
        }
        let now = utc_now();
        self.with_state_mut(|state| {
            claim_next_pending_port_scan_in_state(state, worker_id, now, lease_seconds)
        })
    }

    pub fn renew_port_scan_claim(
        &self,
        port_scan_id: i64,
        worker_id: &str,
        lease_seconds: u64,
    ) -> Result<()> {
        let now = utc_now();
        self.with_state_mut(|state| {
            let claim_expires_at = lease_expires_at(now, lease_seconds)?;
            let record = state
                .port_scans
                .iter_mut()
                .find(|record| record.port_scan.id == port_scan_id)
                .ok_or_else(|| anyhow!("port scan {port_scan_id} not found"))?;
            if record.claimed_by.as_deref() != Some(worker_id) {
                return Err(anyhow!(
                    "port scan {port_scan_id} is not claimed by worker {worker_id}"
                ));
            }
            record.claim_expires_at = Some(claim_expires_at);
            Ok(())
        })
    }

    pub fn mark_port_scan_started_if_queued(
        &self,
        port_scan_id: i64,
    ) -> Result<Option<PortScanRecord>> {
        self.with_state_mut(|state| {
            let record = state
                .port_scans
                .iter_mut()
                .find(|record| record.port_scan.id == port_scan_id)
                .ok_or_else(|| anyhow!("port scan {port_scan_id} not found"))?;
            if !matches!(record.port_scan.status, RunStatus::Queued) {
                return Ok(None);
            }
            record.port_scan.status = RunStatus::InProgress;
            Ok(Some(record.port_scan.clone()))
        })
    }

    pub fn complete_port_scan_if_owned(
        &self,
        port_scan_id: i64,
        worker_id: &str,
        discovered_endpoints_total: u64,
        imported_targets_total: u64,
        queued_run_id: Option<i64>,
        notes: Option<&str>,
    ) -> Result<Option<PortScanRecord>> {
        let now = utc_now();
        self.with_state_mut(|state| {
            let record = state
                .port_scans
                .iter_mut()
                .find(|record| record.port_scan.id == port_scan_id)
                .ok_or_else(|| anyhow!("port scan {port_scan_id} not found"))?;
            if record.claimed_by.as_deref() != Some(worker_id)
                || !record
                    .claim_expires_at
                    .is_some_and(|expires_at| expires_at > now)
            {
                return Ok(None);
            }
            record.port_scan.status = RunStatus::Completed;
            record.port_scan.completed_at = Some(now);
            record.port_scan.discovered_endpoints_total = discovered_endpoints_total;
            record.port_scan.imported_targets_total = imported_targets_total;
            record.port_scan.queued_run_id = queued_run_id;
            if let Some(notes) = notes {
                record.port_scan.notes = Some(notes.to_string());
            }
            clear_port_scan_claim(record);
            Ok(Some(record.port_scan.clone()))
        })
    }

    pub fn fail_port_scan_if_owned(
        &self,
        port_scan_id: i64,
        worker_id: &str,
        notes: Option<&str>,
    ) -> Result<Option<PortScanRecord>> {
        let now = utc_now();
        self.with_state_mut(|state| {
            let record = state
                .port_scans
                .iter_mut()
                .find(|record| record.port_scan.id == port_scan_id)
                .ok_or_else(|| anyhow!("port scan {port_scan_id} not found"))?;
            if record.claimed_by.as_deref() != Some(worker_id)
                || !record
                    .claim_expires_at
                    .is_some_and(|expires_at| expires_at > now)
            {
                return Ok(None);
            }
            record.port_scan.status = RunStatus::Failed;
            record.port_scan.completed_at = Some(now);
            if let Some(notes) = notes {
                record.port_scan.notes = Some(notes.to_string());
            }
            clear_port_scan_claim(record);
            Ok(Some(record.port_scan.clone()))
        })
    }

    pub fn get_repository(&self, repository_id: i64) -> Result<Option<RepositoryRecord>> {
        self.with_state(|state| {
            Ok(state
                .repositories
                .iter()
                .find(|repository| repository.id == repository_id)
                .cloned())
        })
    }

    pub fn load_bin_dataset_status(&self) -> Result<Option<BinDatasetStatus>> {
        let mut connection = self.open_connection()?;
        let raw: Option<String> = connection
            .get(self.bin_dataset_status_key())
            .context("failed to load BIN dataset status")?;
        raw.map(|payload| {
            serde_json::from_str::<BinDatasetStatus>(&payload)
                .context("failed to decode BIN dataset status")
        })
        .transpose()
    }

    pub fn import_bin_dataset(
        &self,
        request: &BinDatasetImportRequest,
    ) -> Result<BinDatasetStatus> {
        let (repository, csv_path) = self.resolve_bin_dataset_source(request)?;
        let records = load_bin_dataset_records_from_csv(&csv_path)?;
        let imported_at = utc_now();
        let status = BinDatasetStatus {
            repository_id: repository.as_ref().map(|record| record.id),
            repository_name: repository.as_ref().map(|record| record.name.clone()),
            github_url: repository.as_ref().map(|record| record.github_url.clone()),
            local_path: repository
                .as_ref()
                .map(|record| record.local_path.clone())
                .or_else(|| {
                    request
                        .local_path
                        .as_ref()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                }),
            csv_path: Some(csv_path.to_string_lossy().into_owned()),
            record_count: records.len(),
            imported_at: Some(imported_at),
        };

        let mut connection = self.open_connection_for_write("importing BIN dataset")?;
        redis::cmd("DEL")
            .arg(self.bin_dataset_records_key())
            .query::<()>(&mut connection)
            .context("failed to clear existing BIN dataset records")?;

        let dataset_key = self.bin_dataset_records_key();
        let mut pipeline = redis::pipe();
        let mut queued = 0usize;
        for record in &records {
            let payload =
                serde_json::to_string(record).context("failed to encode BIN dataset record")?;
            pipeline
                .cmd("HSET")
                .arg(&dataset_key)
                .arg(&record.bin)
                .arg(payload)
                .ignore();
            queued += 1;
            if queued >= 1_000 {
                pipeline
                    .query::<()>(&mut connection)
                    .context("failed to write BIN dataset batch")?;
                pipeline = redis::pipe();
                queued = 0;
            }
        }
        if queued > 0 {
            pipeline
                .query::<()>(&mut connection)
                .context("failed to write final BIN dataset batch")?;
        }

        let status_payload =
            serde_json::to_string(&status).context("failed to encode BIN dataset status")?;
        connection
            .set::<_, _, ()>(self.bin_dataset_status_key(), status_payload)
            .context("failed to persist BIN dataset status")?;
        Ok(status)
    }

    pub fn lookup_bin_metadata(&self, bins: &[String]) -> Result<Vec<BinMetadataRecord>> {
        if bins.is_empty() {
            return Ok(Vec::new());
        }

        let unique_bins = bins
            .iter()
            .map(|value| normalize_bin_key(value))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if unique_bins.is_empty() {
            return Ok(Vec::new());
        }

        let mut connection = self.open_connection()?;
        let dataset_key = self.bin_dataset_records_key();
        let mut records = Vec::new();
        for bin in unique_bins {
            let payload: Option<String> = connection
                .hget(&dataset_key, &bin)
                .with_context(|| format!("failed to read BIN metadata for {bin}"))?;
            let Some(payload) = payload else {
                continue;
            };
            let record = serde_json::from_str::<BinMetadataRecord>(&payload)
                .with_context(|| format!("failed to decode BIN metadata for {bin}"))?;
            records.push(record);
        }
        Ok(records)
    }

    pub fn upsert_schedule(
        &self,
        label: &str,
        interval_seconds: u64,
        enabled: bool,
        requested_by: Option<&str>,
        scope: Option<&RunScope>,
    ) -> Result<RecurringScheduleRecord> {
        let normalized_label = label.trim();
        if normalized_label.is_empty() {
            return Err(anyhow!("schedule label is required"));
        }
        if interval_seconds == 0 {
            return Err(anyhow!(
                "schedule interval_seconds must be greater than zero"
            ));
        }

        let normalized_scope = normalize_run_scope(scope.cloned());
        self.with_state_mut(|state| {
            let now = utc_now();
            if let Some(existing) = state
                .schedules
                .iter_mut()
                .find(|schedule| schedule.label == normalized_label)
            {
                existing.interval_seconds = interval_seconds;
                existing.enabled = enabled;
                if let Some(requested_by) = requested_by {
                    existing.requested_by = Some(requested_by.to_string());
                }
                existing.scope = normalized_scope.clone();
                existing.next_run_at = now;
                existing.last_error = None;
                existing.updated_at = now;
                return Ok(materialize_schedule(existing.clone(), state));
            }

            let schedule = RecurringScheduleRecord {
                id: state.next_schedule_id(),
                label: normalized_label.to_string(),
                interval_seconds,
                enabled,
                requested_by: requested_by.map(|value| value.to_string()),
                scope: normalized_scope.clone(),
                next_run_at: now,
                last_run_at: None,
                last_queued_run_id: None,
                last_queued_run_status: None,
                last_queued_run_started_at: None,
                last_queued_run_completed_at: None,
                last_error: None,
                created_at: now,
                updated_at: now,
            };
            state.schedules.push(schedule.clone());
            Ok(schedule)
        })
    }

    pub fn list_schedules(&self) -> Result<Vec<RecurringScheduleRecord>> {
        self.with_state(|state| {
            let mut schedules = state
                .schedules
                .iter()
                .cloned()
                .map(|schedule| materialize_schedule(schedule, state))
                .collect::<Vec<_>>();
            schedules.sort_by(|left, right| {
                right
                    .enabled
                    .cmp(&left.enabled)
                    .then(left.next_run_at.cmp(&right.next_run_at))
                    .then(left.id.cmp(&right.id))
            });
            Ok(schedules)
        })
    }

    pub fn queue_due_schedule_runs(
        &self,
        limit: usize,
    ) -> Result<Vec<(RecurringScheduleRecord, ScanRunRecord)>> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        self.with_state_mut(|state| {
            let mut queued = Vec::new();
            for _ in 0..limit {
                let mut due_schedules = state
                    .schedules
                    .iter()
                    .filter(|schedule| {
                        schedule.enabled
                            && schedule.next_run_at <= utc_now()
                            && !has_active_run_for_schedule(state, schedule.id)
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                due_schedules.sort_by(|left, right| {
                    left.next_run_at
                        .cmp(&right.next_run_at)
                        .then(left.id.cmp(&right.id))
                });

                let Some(selected_schedule) = due_schedules.into_iter().next() else {
                    break;
                };
                let now = utc_now();
                let next_run_at = schedule_next_run_at(now, selected_schedule.interval_seconds)?;
                let targets = filter_targets_by_scope(
                    state,
                    sorted_targets(enabled_targets(state)),
                    selected_schedule.scope.as_ref(),
                );
                let schedule_index = state
                    .schedules
                    .iter()
                    .position(|schedule| schedule.id == selected_schedule.id)
                    .ok_or_else(|| {
                        anyhow!("schedule {} vanished during queueing", selected_schedule.id)
                    })?;

                if targets.is_empty() {
                    let schedule = &mut state.schedules[schedule_index];
                    let error_message = if selected_schedule.scope.is_some() {
                        "cannot queue scheduled run without enabled targets matching scope"
                    } else {
                        "cannot queue scheduled run without enabled targets"
                    };
                    schedule.next_run_at = next_run_at;
                    schedule.last_error = Some(error_message.to_string());
                    schedule.updated_at = now;
                    continue;
                }

                let requested_by = format!("schedule:{}", selected_schedule.label);
                let run = create_run(
                    state,
                    Some(selected_schedule.id),
                    Some(requested_by),
                    selected_schedule.scope.clone(),
                    &targets,
                    now,
                );
                create_jobs_for_run(state, run.id, &targets);
                refresh_run_totals(state, run.id)?;

                let schedule = &mut state.schedules[schedule_index];
                schedule.last_run_at = Some(now);
                schedule.next_run_at = next_run_at;
                schedule.last_queued_run_id = Some(run.id);
                schedule.last_error = None;
                schedule.updated_at = now;

                queued.push((
                    materialize_schedule(schedule.clone(), state),
                    get_run_record(state, run.id)?,
                ));
            }
            Ok(queued)
        })
    }

    pub fn queue_run(
        &self,
        requested_by: Option<&str>,
        scope: Option<&RunScope>,
    ) -> Result<ScanRunRecord> {
        let normalized_scope = normalize_run_scope(scope.cloned());
        self.with_state_mut(|state| {
            let targets = filter_targets_by_scope(
                state,
                sorted_targets(enabled_targets(state)),
                normalized_scope.as_ref(),
            );
            if targets.is_empty() {
                let error_message = if normalized_scope.is_some() {
                    "cannot queue a run without enabled targets matching scope"
                } else {
                    "cannot queue a run without enabled targets"
                };
                return Err(anyhow!(error_message));
            }
            let now = utc_now();
            let run = create_run(
                state,
                None,
                requested_by.map(|value| value.to_string()),
                normalized_scope.clone(),
                &targets,
                now,
            );
            create_jobs_for_run(state, run.id, &targets);
            refresh_run_totals(state, run.id)?;
            get_run_record(state, run.id)
        })
    }

    pub fn claim_next_runnable_run(
        &self,
        worker_id: &str,
        lease_seconds: u64,
    ) -> Result<Option<ScanRunRecord>> {
        let worker_id = worker_id.trim();
        if worker_id.is_empty() {
            return Err(anyhow!("worker_id is required to claim a Dragonfly run"));
        }

        self.with_state_mut(|state| {
            claim_next_runnable_run_in_state(state, worker_id, utc_now(), lease_seconds)
        })
    }

    pub fn next_runnable_run(&self) -> Result<Option<ScanRunRecord>> {
        self.with_state(|state| {
            let now = utc_now();
            let mut runs = state
                .runs
                .iter()
                .filter(|run| {
                    matches!(run.run.status, RunStatus::Queued | RunStatus::InProgress)
                        && has_runnable_jobs(state, run.run.id)
                        && !run_claim_is_active(run, now)
                })
                .map(|run| run.run.clone())
                .collect::<Vec<_>>();
            runs.sort_by(|left, right| left.id.cmp(&right.id));
            Ok(runs.into_iter().next())
        })
    }

    pub fn next_assistable_run(&self, worker_id: &str) -> Result<Option<ScanRunRecord>> {
        let worker_id = worker_id.trim();
        if worker_id.is_empty() {
            return Err(anyhow!(
                "worker_id is required to list assistable Dragonfly runs"
            ));
        }

        self.with_state(|state| {
            let now = utc_now();
            if !worker_allows_new_runs(state, worker_id, now) {
                return Ok(None);
            }
            let mut runs = state
                .runs
                .iter()
                .filter(|run| {
                    matches!(run.run.status, RunStatus::InProgress)
                        && has_claimable_jobs(state, run.run.id, now)
                        && run_claim_is_active(run, now)
                        && run
                            .claimed_by
                            .as_deref()
                            .is_some_and(|owner| owner != worker_id)
                })
                .map(|run| run.run.clone())
                .collect::<Vec<_>>();
            runs.sort_by(|left, right| left.id.cmp(&right.id));
            Ok(runs.into_iter().next())
        })
    }

    pub fn renew_run_claim(&self, run_id: i64, worker_id: &str, lease_seconds: u64) -> Result<()> {
        let worker_id = worker_id.trim();
        if worker_id.is_empty() {
            return Err(anyhow!(
                "worker_id is required to renew a Dragonfly run claim"
            ));
        }

        self.with_state_mut(|state| {
            let lease_expires_at = lease_expires_at(utc_now(), lease_seconds)?;
            let run = state
                .runs
                .iter_mut()
                .find(|run| run.run.id == run_id)
                .ok_or_else(|| anyhow!("run {run_id} not found"))?;
            if matches!(run.run.status, RunStatus::Completed | RunStatus::Failed) {
                clear_run_claim(run);
                return Ok(());
            }
            match run.claimed_by.as_deref() {
                Some(owner) if owner == worker_id => {
                    run.claim_expires_at = Some(lease_expires_at);
                    Ok(())
                }
                Some(owner) => Err(anyhow!(
                    "run {run_id} is claimed by {owner}, cannot renew for {worker_id}"
                )),
                None => Err(anyhow!(
                    "run {run_id} does not have an active Dragonfly claim"
                )),
            }
        })
    }

    pub fn requeue_in_progress_jobs(&self, run_id: i64) -> Result<()> {
        self.with_state_mut(|state| {
            requeue_in_progress_jobs_in_state(state, run_id)?;
            Ok(())
        })
    }

    pub fn has_incomplete_jobs(&self, run_id: i64) -> Result<bool> {
        self.with_state(|state| Ok(has_runnable_jobs(state, run_id)))
    }

    pub fn mark_run_started(&self, run_id: i64) -> Result<ScanRunRecord> {
        self.with_state_mut(|state| {
            let run = state
                .runs
                .iter_mut()
                .find(|run| run.run.id == run_id)
                .ok_or_else(|| anyhow!("run {run_id} not found"))?;
            run.run.status = RunStatus::InProgress;
            run.run.completed_at = None;
            Ok(run.run.clone())
        })
    }

    pub fn mark_run_started_if_queued(&self, run_id: i64) -> Result<Option<ScanRunRecord>> {
        self.with_state_mut(|state| {
            let run = state
                .runs
                .iter_mut()
                .find(|run| run.run.id == run_id)
                .ok_or_else(|| anyhow!("run {run_id} not found"))?;
            if !matches!(run.run.status, RunStatus::Queued) {
                return Ok(None);
            }
            run.run.status = RunStatus::InProgress;
            run.run.completed_at = None;
            Ok(Some(run.run.clone()))
        })
    }

    pub fn mark_job_started(&self, job_id: i64) -> Result<()> {
        self.with_state_mut(|state| {
            let job = state
                .jobs
                .iter_mut()
                .find(|job| job.id == job_id)
                .ok_or_else(|| anyhow!("job {job_id} not found"))?;
            job.status = JobStatus::InProgress;
            job.started_at = Some(utc_now());
            Ok(())
        })
    }

    pub fn claim_next_pending_job(
        &self,
        run_id: i64,
        worker_id: &str,
        lease_seconds: u64,
    ) -> Result<Option<ScanJobRecord>> {
        let worker_id = worker_id.trim();
        if worker_id.is_empty() {
            return Err(anyhow!("worker_id is required to claim a Dragonfly job"));
        }

        self.with_state_mut(|state| {
            claim_next_pending_job_in_state(state, run_id, worker_id, utc_now(), lease_seconds)
        })
    }

    pub fn renew_job_claim(&self, job_id: i64, worker_id: &str, lease_seconds: u64) -> Result<()> {
        let worker_id = worker_id.trim();
        if worker_id.is_empty() {
            return Err(anyhow!(
                "worker_id is required to renew a Dragonfly job claim"
            ));
        }

        self.with_state_mut(|state| {
            let lease_expires_at = lease_expires_at(utc_now(), lease_seconds)?;
            let job = state
                .jobs
                .iter()
                .find(|job| job.id == job_id)
                .ok_or_else(|| anyhow!("job {job_id} not found"))?;
            if matches!(job.status, JobStatus::Completed | JobStatus::Failed) {
                state.job_claims.remove(&job_id);
                return Ok(());
            }
            match state.job_claims.get_mut(&job_id) {
                Some(claim) if claim.claimed_by == worker_id => {
                    claim.claim_expires_at = lease_expires_at;
                    Ok(())
                }
                Some(claim) => Err(anyhow!(
                    "job {job_id} is claimed by {}, cannot renew for {worker_id}",
                    claim.claimed_by
                )),
                None => Err(anyhow!(
                    "job {job_id} does not have an active Dragonfly claim"
                )),
            }
        })
    }

    pub fn mark_job_finished(
        &self,
        job_id: i64,
        findings_count: u64,
        telemetry: &FetchTelemetry,
        error: Option<&str>,
    ) -> Result<()> {
        self.with_state_mut(|state| {
            finish_job_in_state(state, job_id, findings_count, telemetry, error)?;
            Ok(())
        })
    }

    pub fn mark_job_finished_if_owned(
        &self,
        job_id: i64,
        worker_id: &str,
        findings_count: u64,
        telemetry: &FetchTelemetry,
        error: Option<&str>,
    ) -> Result<bool> {
        let worker_id = worker_id.trim();
        if worker_id.is_empty() {
            return Err(anyhow!("worker_id is required to finish a Dragonfly job"));
        }

        self.with_state_mut(|state| {
            let now = utc_now();
            let Some(job) = state.jobs.iter().find(|job| job.id == job_id) else {
                return Err(anyhow!("job {job_id} not found"));
            };
            if matches!(job.status, JobStatus::Completed | JobStatus::Failed) {
                state.job_claims.remove(&job_id);
                return Ok(false);
            }

            let owns_claim = state
                .job_claims
                .get(&job_id)
                .is_some_and(|claim| claim.claimed_by == worker_id && claim.claim_expires_at > now);
            if !owns_claim {
                return Ok(false);
            }

            finish_job_in_state(state, job_id, findings_count, telemetry, error)?;
            Ok(true)
        })
    }

    pub fn merge_target_discovery_provenance(
        &self,
        target_id: i64,
        discovery_provenance: &[DiscoveryProvenanceRecord],
    ) -> Result<()> {
        if discovery_provenance.is_empty() {
            return Ok(());
        }

        self.with_state_mut(|state| {
            merge_target_discovery_provenance_in_state(state, target_id, discovery_provenance)
        })
    }

    pub fn list_pending_jobs(&self, run_id: i64) -> Result<Vec<ScanJobRecord>> {
        self.with_state(|state| {
            let mut jobs = state
                .jobs
                .iter()
                .filter(|job| job.run_id == run_id && matches!(job.status, JobStatus::Pending))
                .cloned()
                .collect::<Vec<_>>();
            jobs.sort_by(|left, right| left.id.cmp(&right.id));
            Ok(jobs)
        })
    }

    pub fn record_finding(&self, finding: &NewFinding) -> Result<FindingRecord> {
        if let Some(record) = self.record_finding_if_new(finding)? {
            return Ok(record);
        }
        self.with_state(|state| {
            find_existing_finding_in_state(state, finding).ok_or_else(|| {
                anyhow!(
                    "duplicate finding for run {} target {} could not be reloaded",
                    finding.run_id,
                    finding.target_id
                )
            })
        })
    }

    pub fn record_finding_if_new(&self, finding: &NewFinding) -> Result<Option<FindingRecord>> {
        self.with_state_mut(|state| insert_finding_if_new_in_state(state, finding))
    }

    pub fn recent_findings(&self, limit: usize) -> Result<Vec<FindingRecord>> {
        self.search_findings(&FindingsQuery {
            limit: Some(limit),
            ..FindingsQuery::default()
        })
    }

    pub fn search_findings(&self, query: &FindingsQuery) -> Result<Vec<FindingRecord>> {
        self.with_state(|state| Ok(Self::search_findings_in_state(state, query)))
    }

    pub fn search_public_findings(
        &self,
        query: &PublicFindingSearchQuery,
    ) -> Result<Vec<PublicFindingRecord>> {
        self.with_state(|state| Ok(Self::search_public_findings_in_state(state, query)))
    }

    pub fn list_public_finding_moderation_records(
        &self,
    ) -> Result<Vec<PublicFindingModerationRecord>> {
        self.with_state(|state| {
            let mut records = state.public_finding_moderation.clone();
            records.sort_by(|left, right| {
                right
                    .updated_at
                    .cmp(&left.updated_at)
                    .then(right.finding_id.cmp(&left.finding_id))
            });
            Ok(records)
        })
    }

    pub fn moderate_public_finding(
        &self,
        finding_id: i64,
        reviewed_by: Option<&str>,
        request: &PublicFindingModerationRequest,
    ) -> Result<PublicFindingModerationRecord> {
        if finding_id <= 0 {
            return Err(anyhow!("finding_id must be positive"));
        }
        let reviewed_by = reviewed_by
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        self.with_state_mut(|state| {
            upsert_public_finding_moderation_in_state(
                state,
                finding_id,
                reviewed_by.clone(),
                request,
            )
        })
    }

    fn search_findings_in_state(
        state: &DragonflyRuntimeState,
        query: &FindingsQuery,
    ) -> Vec<FindingRecord> {
        let target_tags_by_id = state
            .targets
            .iter()
            .map(|target| (target.id, target.tags.clone()))
            .collect::<HashMap<_, _>>();
        run_findings_query(
            &HybridFindingsRanker,
            state.findings.clone(),
            &target_tags_by_id,
            query,
        )
    }

    fn search_public_findings_in_state(
        state: &DragonflyRuntimeState,
        query: &PublicFindingSearchQuery,
    ) -> Vec<PublicFindingRecord> {
        let query = normalize_public_finding_search_query(query.clone());
        let limit = query.limit.unwrap_or(20);
        let mut records = state
            .public_finding_moderation
            .iter()
            .filter(|record| record.status == PublicFindingStatus::Published)
            .filter_map(|record| {
                let published_at = record.published_at.clone()?;
                if query
                    .severity
                    .as_ref()
                    .is_some_and(|severity| &record.severity != severity)
                {
                    return None;
                }
                if query
                    .detector
                    .as_ref()
                    .is_some_and(|detector| record.detector.to_ascii_lowercase() != *detector)
                {
                    return None;
                }
                if query.path_prefix.as_ref().is_some_and(|path_prefix| {
                    !record.path.to_ascii_lowercase().starts_with(path_prefix)
                }) {
                    return None;
                }
                if query.q.as_ref().is_some_and(|term| {
                    let searchable = format!(
                        "{} {} {} {}",
                        record.detector, record.target_base_url, record.path, record.public_summary
                    )
                    .to_ascii_lowercase();
                    !searchable.contains(term)
                }) {
                    return None;
                }
                Some(PublicFindingRecord {
                    finding_id: record.finding_id,
                    detector: record.detector.clone(),
                    severity: record.severity.clone(),
                    target_base_url: record.target_base_url.clone(),
                    path: record.path.clone(),
                    summary: record.public_summary.clone(),
                    observed_at: record.observed_at,
                    published_at,
                })
            })
            .collect::<Vec<_>>();
        records.sort_by(|left, right| {
            right
                .published_at
                .cmp(&left.published_at)
                .then(right.finding_id.cmp(&left.finding_id))
        });
        records.truncate(limit);
        records
    }

    pub fn list_runs(&self, limit: usize) -> Result<Vec<ScanRunRecord>> {
        self.with_state(|state| {
            let mut runs = state
                .runs
                .iter()
                .map(|run| run.run.clone())
                .collect::<Vec<_>>();
            runs.sort_by(|left, right| right.id.cmp(&left.id));
            runs.truncate(limit);
            Ok(runs)
        })
    }

    pub fn latest_run(&self) -> Result<Option<ScanRunRecord>> {
        self.with_state(|state| {
            Ok(state
                .runs
                .iter()
                .max_by(|left, right| left.run.id.cmp(&right.run.id))
                .map(|run| run.run.clone()))
        })
    }

    pub fn get_run(&self, run_id: i64) -> Result<Option<ScanRunRecord>> {
        self.with_state(|state| {
            Ok(state
                .runs
                .iter()
                .find(|run| run.run.id == run_id)
                .map(|run| run.run.clone()))
        })
    }

    pub fn summary(&self, run_id: i64) -> Result<RunSummary> {
        self.with_state(|state| compute_run_summary(state, run_id))
    }

    pub fn mark_run_finished(&self, run_id: i64, notes: Option<&str>) -> Result<ScanRunRecord> {
        self.with_state_mut(|state| {
            refresh_run_totals(state, run_id)?;
            let summary = compute_run_summary(state, run_id)?;
            let run_job_ids = state
                .jobs
                .iter()
                .filter(|job| job.run_id == run_id)
                .map(|job| job.id)
                .collect::<Vec<_>>();
            let run = state
                .runs
                .iter_mut()
                .find(|run| run.run.id == run_id)
                .ok_or_else(|| anyhow!("run {run_id} not found after completion"))?;
            run.run.status = if summary.errors_total > 0 {
                RunStatus::Failed
            } else {
                RunStatus::Completed
            };
            run.run.completed_at = Some(utc_now());
            if let Some(notes) = notes {
                run.run.notes = Some(notes.to_string());
            }
            clear_run_claim(run);
            for job_id in run_job_ids {
                state.job_claims.remove(&job_id);
            }
            Ok(run.run.clone())
        })
    }

    pub fn mark_run_finished_if_owned(
        &self,
        run_id: i64,
        worker_id: &str,
        notes: Option<&str>,
    ) -> Result<Option<ScanRunRecord>> {
        let worker_id = worker_id.trim();
        if worker_id.is_empty() {
            return Err(anyhow!("worker_id is required to finalize a Dragonfly run"));
        }

        self.with_state_mut(|state| {
            refresh_run_totals(state, run_id)?;
            if has_runnable_jobs(state, run_id) {
                return Ok(None);
            }

            let now = utc_now();
            let summary = compute_run_summary(state, run_id)?;
            let run_job_ids = state
                .jobs
                .iter()
                .filter(|job| job.run_id == run_id)
                .map(|job| job.id)
                .collect::<Vec<_>>();
            let run = state
                .runs
                .iter_mut()
                .find(|run| run.run.id == run_id)
                .ok_or_else(|| anyhow!("run {run_id} not found after completion"))?;
            if matches!(run.run.status, RunStatus::Completed | RunStatus::Failed) {
                return Ok(None);
            }
            let owns_claim = run
                .claimed_by
                .as_deref()
                .is_some_and(|owner| owner == worker_id)
                && run
                    .claim_expires_at
                    .is_some_and(|expires_at| expires_at > now);
            if !owns_claim {
                return Ok(None);
            }
            run.run.status = if summary.errors_total > 0 {
                RunStatus::Failed
            } else {
                RunStatus::Completed
            };
            run.run.completed_at = Some(now);
            if let Some(notes) = notes {
                run.run.notes = Some(notes.to_string());
            }
            clear_run_claim(run);
            for job_id in run_job_ids {
                state.job_claims.remove(&job_id);
            }
            Ok(Some(run.run.clone()))
        })
    }

    pub fn append_event(&self, run_id: Option<i64>, event: &ApiEvent) -> Result<i64> {
        let mut connection = self.open_connection_for_write("appending run event")?;
        self.append_event_to_stream(&mut connection, run_id, event, utc_now())
    }

    pub fn list_events_since(&self, cursor: i64, limit: usize) -> Result<Vec<StoredEvent>> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        let mut connection = self.open_connection()?;
        let start_id = stream_entry_id(cursor.saturating_add(1).max(0));
        let events: StreamRangeReply = connection
            .xrange_count(self.events_key(), start_id.as_str(), "+", limit)
            .context("failed to read Dragonfly event stream")?;
        events
            .ids
            .into_iter()
            .map(stored_event_from_stream_entry)
            .collect()
    }

    pub fn dashboard_snapshot(&self) -> Result<DashboardSnapshot> {
        self.with_state(|state| {
            let latest_run = state
                .runs
                .iter()
                .max_by(|left, right| left.run.id.cmp(&right.run.id))
                .map(|run| run.run.clone());
            let latest_run_id = latest_run.as_ref().map(|run| run.id);
            let latest_summary = latest_run_id
                .map(|run_id| compute_run_summary(state, run_id))
                .transpose()?;
            let latest_failed_targets = latest_run_id
                .map(|run_id| list_failed_targets(state, run_id, 10))
                .transpose()?
                .unwrap_or_default();
            let latest_detector_distribution = latest_run_id
                .map(|run_id| detector_distribution(state, run_id, 10))
                .transpose()?
                .unwrap_or_default();
            let mut recent_runs = state
                .runs
                .iter()
                .map(|run| run.run.clone())
                .collect::<Vec<_>>();
            recent_runs.sort_by(|left, right| right.id.cmp(&left.id));
            recent_runs.truncate(10);

            let mut recent_findings = state.findings.clone();
            recent_findings.sort_by(|left, right| {
                right
                    .discovered_at
                    .cmp(&left.discovered_at)
                    .then(right.id.cmp(&left.id))
            });
            recent_findings.truncate(50);

            let mut schedules = state
                .schedules
                .iter()
                .cloned()
                .map(|schedule| materialize_schedule(schedule, state))
                .collect::<Vec<_>>();
            schedules.sort_by(|left, right| {
                right
                    .enabled
                    .cmp(&left.enabled)
                    .then(left.next_run_at.cmp(&right.next_run_at))
                    .then(left.id.cmp(&right.id))
            });

            let now = utc_now();
            Ok(DashboardSnapshot {
                latest_run,
                latest_summary,
                recent_port_scans: state
                    .port_scans
                    .iter()
                    .map(|record| record.port_scan.clone())
                    .rev()
                    .take(10)
                    .collect(),
                targets: sorted_targets(state.targets.clone()),
                scan_defaults: Default::default(),
                repositories: sorted_repositories(state.repositories.clone()),
                operators: Vec::new(),
                workers: active_worker_records(&state.workers, now),
                worker_pools: compute_worker_pool_records(state, now),
                worker_enrollment_tokens: sorted_worker_enrollment_token_records(
                    &state.worker_enrollment_tokens,
                ),
                bootstrap_candidates: sorted_bootstrap_candidates(
                    state.bootstrap_candidates.clone(),
                ),
                bootstrap_jobs: sorted_bootstrap_jobs(state.bootstrap_jobs.clone()),
                extensions: Vec::new(),
                bin_dataset_status: None,
                recent_findings,
                recent_runs,
                latest_failed_targets,
                latest_detector_distribution,
                schedules,
            })
        })
    }

    pub fn load_scan_settings(&self) -> Result<Option<ScanDefaultsSummary>> {
        self.with_state(|state| Ok(state.scan_settings.clone()))
    }

    pub fn upsert_scan_settings(
        &self,
        settings: &ScanDefaultsSummary,
    ) -> Result<ScanDefaultsSummary> {
        self.with_state_mut(|state| {
            state.scan_settings = Some(settings.clone());
            Ok(settings.clone())
        })
    }

    pub fn create_ownership_claim(
        &self,
        request: &OwnershipClaimRequest,
    ) -> Result<OwnershipClaimRecord> {
        let request = normalize_ownership_claim_request(request)?;
        self.with_state_mut(|state| {
            let now = utc_now();
            let record = OwnershipClaimRecord {
                id: state.next_ownership_claim_id(),
                resource_kind: request.resource_kind,
                resource: request.resource,
                requester_name: request.requester_name,
                requester_email: request.requester_email,
                organization: request.organization,
                verification_method: request.verification_method,
                verification_value: request.verification_value,
                notes: request.notes,
                status: PublicWorkflowStatus::Submitted,
                reviewer_notes: None,
                verification_completed_at: None,
                created_at: now,
                updated_at: now,
            };
            state.ownership_claims.push(record.clone());
            Ok(record)
        })
    }

    pub fn list_ownership_claims(&self) -> Result<Vec<OwnershipClaimRecord>> {
        self.with_state(|state| Ok(sorted_ownership_claims(state.ownership_claims.clone())))
    }

    pub fn update_ownership_claim_status(
        &self,
        claim_id: i64,
        update: &PublicWorkflowStatusUpdate,
    ) -> Result<OwnershipClaimRecord> {
        self.with_state_mut(|state| {
            let update = normalize_public_workflow_status_update(update)?;
            let claim = state
                .ownership_claims
                .iter_mut()
                .find(|claim| claim.id == claim_id)
                .ok_or_else(|| anyhow!("ownership claim {claim_id} not found"))?;
            claim.status = update.status;
            claim.reviewer_notes = update.reviewer_notes;
            claim.updated_at = utc_now();
            if matches!(
                claim.status,
                PublicWorkflowStatus::Verified | PublicWorkflowStatus::Completed
            ) {
                claim.verification_completed_at = Some(claim.updated_at);
            }
            Ok(claim.clone())
        })
    }

    pub fn create_opt_out_request(&self, request: &OptOutRequest) -> Result<OptOutRecord> {
        let request = normalize_opt_out_request(request)?;
        self.with_state_mut(|state| {
            let now = utc_now();
            let record = OptOutRecord {
                id: state.next_opt_out_id(),
                resource_kind: request.resource_kind,
                resource: request.resource,
                requester_name: request.requester_name,
                requester_email: request.requester_email,
                organization: request.organization,
                verification_method: request.verification_method,
                verification_value: request.verification_value,
                justification: request.justification,
                status: PublicWorkflowStatus::Submitted,
                reviewer_notes: None,
                completed_at: None,
                created_at: now,
                updated_at: now,
            };
            state.opt_out_requests.push(record.clone());
            Ok(record)
        })
    }

    pub fn list_opt_out_requests(&self) -> Result<Vec<OptOutRecord>> {
        self.with_state(|state| Ok(sorted_opt_out_requests(state.opt_out_requests.clone())))
    }

    pub fn update_opt_out_status(
        &self,
        opt_out_id: i64,
        update: &PublicWorkflowStatusUpdate,
    ) -> Result<OptOutRecord> {
        self.with_state_mut(|state| {
            let update = normalize_public_workflow_status_update(update)?;
            let opt_out = state
                .opt_out_requests
                .iter_mut()
                .find(|record| record.id == opt_out_id)
                .ok_or_else(|| anyhow!("opt-out request {opt_out_id} not found"))?;
            opt_out.status = update.status;
            opt_out.reviewer_notes = update.reviewer_notes;
            opt_out.updated_at = utc_now();
            if matches!(opt_out.status, PublicWorkflowStatus::Completed) {
                opt_out.completed_at = Some(opt_out.updated_at);
            }
            Ok(opt_out.clone())
        })
    }

    pub fn create_abuse_report(&self, request: &AbuseReportRequest) -> Result<AbuseReportRecord> {
        let request = normalize_abuse_report_request(request)?;
        self.with_state_mut(|state| {
            let now = utc_now();
            let record = AbuseReportRecord {
                id: state.next_abuse_report_id(),
                requester_name: request.requester_name,
                requester_email: request.requester_email,
                organization: request.organization,
                affected_resource: request.affected_resource,
                reason: request.reason,
                urgency: request.urgency,
                evidence: request.evidence,
                status: PublicWorkflowStatus::Submitted,
                reviewer_notes: None,
                resolved_at: None,
                created_at: now,
                updated_at: now,
            };
            state.abuse_reports.push(record.clone());
            Ok(record)
        })
    }

    pub fn list_abuse_reports(&self) -> Result<Vec<AbuseReportRecord>> {
        self.with_state(|state| Ok(sorted_abuse_reports(state.abuse_reports.clone())))
    }

    pub fn update_abuse_report_status(
        &self,
        report_id: i64,
        update: &PublicWorkflowStatusUpdate,
    ) -> Result<AbuseReportRecord> {
        self.with_state_mut(|state| {
            let update = normalize_public_workflow_status_update(update)?;
            let report = state
                .abuse_reports
                .iter_mut()
                .find(|report| report.id == report_id)
                .ok_or_else(|| anyhow!("abuse report {report_id} not found"))?;
            report.status = update.status;
            report.reviewer_notes = update.reviewer_notes;
            report.updated_at = utc_now();
            if matches!(report.status, PublicWorkflowStatus::Completed) {
                report.resolved_at = Some(report.updated_at);
            }
            Ok(report.clone())
        })
    }

    fn open_connection(&self) -> Result<redis::Connection> {
        self.client
            .get_connection()
            .context("failed to open Dragonfly connection")
    }

    fn open_connection_for_write(&self, operation: &str) -> Result<redis::Connection> {
        let mut connection = self
            .open_connection()
            .with_context(|| format!("Dragonfly store is unavailable before {operation}"))?;
        Self::ping_connection(&mut connection)
            .with_context(|| format!("Dragonfly store is unavailable before {operation}"))?;
        Ok(connection)
    }

    fn ping_connection(connection: &mut redis::Connection) -> Result<()> {
        let pong: String = redis::cmd("PING")
            .query(connection)
            .context("failed to ping Dragonfly")?;
        if pong != "PONG" {
            return Err(anyhow!("unexpected Dragonfly PING response: {pong}"));
        }
        Ok(())
    }

    fn try_ping(&self) -> Result<()> {
        let mut connection = self.open_connection()?;
        Self::ping_connection(&mut connection)
    }

    fn namespace_pattern(&self) -> String {
        format!("{}*", self.key_prefix)
    }

    fn state_key(&self) -> String {
        format!("{}runtime_state", self.key_prefix)
    }

    fn lock_key(&self) -> String {
        format!("{}runtime_lock", self.key_prefix)
    }

    fn events_key(&self) -> String {
        format!("{}run_events", self.key_prefix)
    }

    fn event_sequence_key(&self) -> String {
        format!("{}run_events_seq", self.key_prefix)
    }

    fn bin_dataset_records_key(&self) -> String {
        format!("{}bin_dataset_records", self.key_prefix)
    }

    fn bin_dataset_status_key(&self) -> String {
        format!("{}bin_dataset_status", self.key_prefix)
    }

    fn resolve_bin_dataset_source(
        &self,
        request: &BinDatasetImportRequest,
    ) -> Result<(Option<RepositoryRecord>, PathBuf)> {
        if let Some(repository_id) = request.repository_id {
            let repository = self
                .get_repository(repository_id)?
                .ok_or_else(|| anyhow!("repository #{repository_id} was not found"))?;
            let base_path = PathBuf::from(repository.local_path.clone());
            let csv_path = resolve_bin_dataset_csv_path(&base_path, request.csv_path.as_deref());
            if !csv_path.exists() {
                return Err(anyhow!(
                    "BIN dataset CSV {} does not exist",
                    csv_path.display()
                ));
            }
            return Ok((Some(repository), csv_path));
        }

        let local_path = request
            .local_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                anyhow!("repository_id or local_path is required for BIN dataset import")
            })?;
        let base_path = PathBuf::from(local_path);
        let csv_path = resolve_bin_dataset_csv_path(&base_path, request.csv_path.as_deref());
        if !csv_path.exists() {
            return Err(anyhow!(
                "BIN dataset CSV {} does not exist",
                csv_path.display()
            ));
        }
        Ok((None, csv_path))
    }

    fn state_exists(&self, connection: &mut redis::Connection) -> Result<bool> {
        connection
            .exists(self.state_key())
            .context("failed to inspect Dragonfly runtime state key")
    }

    fn ensure_namespace_available_for_bootstrap(
        &self,
        connection: &mut redis::Connection,
    ) -> Result<()> {
        let namespace_keys: Vec<String> = connection
            .keys(self.namespace_pattern())
            .context("failed to inspect Dragonfly namespace before initialization")?;
        let occupied_keys = occupied_namespace_keys(namespace_keys, &self.lock_key());
        if occupied_keys.is_empty() {
            return Ok(());
        }

        let sample_count = occupied_keys.len().min(NAMESPACE_KEY_SAMPLE_LIMIT);
        let sample = occupied_keys[..sample_count].join(", ");
        let overflow = occupied_keys.len().saturating_sub(sample_count);
        let sample_suffix = if overflow > 0 {
            format!(" (+{overflow} more)")
        } else {
            String::new()
        };
        Err(anyhow!(
            "Dragonfly namespace prefix {} already contains data but {} is missing; refusing to initialize into a non-empty namespace. Matching keys: {sample}{sample_suffix}",
            self.key_prefix,
            self.state_key(),
        ))
    }

    fn load_state(&self, connection: &mut redis::Connection) -> Result<DragonflyRuntimeState> {
        let raw: Option<String> = connection
            .get(self.state_key())
            .context("failed to load Dragonfly runtime state")?;
        let mut state = match raw {
            Some(raw) => serde_json::from_str::<DragonflyRuntimeState>(&raw)
                .context("failed to deserialize Dragonfly runtime state")?,
            None => DragonflyRuntimeState::default(),
        };
        state.repair_counters();
        Ok(state)
    }

    fn save_state(
        &self,
        connection: &mut redis::Connection,
        state: &DragonflyRuntimeState,
    ) -> Result<()> {
        let payload =
            serde_json::to_string(state).context("failed to serialize Dragonfly state")?;
        connection
            .set::<_, _, ()>(self.state_key(), payload)
            .context("failed to save Dragonfly runtime state")?;
        Ok(())
    }

    fn acquire_lock(&self, connection: &mut redis::Connection) -> Result<String> {
        let deadline = Instant::now() + Duration::from_millis(self.lock_max_wait_ms);
        let token = format!(
            "{}-{}-{}",
            std::process::id(),
            utc_now().timestamp(),
            utc_now().timestamp_subsec_nanos()
        );

        loop {
            let response: Option<String> = redis::cmd("SET")
                .arg(self.lock_key())
                .arg(&token)
                .arg("NX")
                .arg("PX")
                .arg(self.lock_ttl_ms)
                .query(connection)
                .context("failed to acquire Dragonfly mutation lock")?;
            if response.is_some() {
                return Ok(token);
            }
            if Instant::now() >= deadline {
                return Err(anyhow!(
                    "timed out acquiring Dragonfly mutation lock after {}ms",
                    self.lock_max_wait_ms
                ));
            }
            thread::sleep(Duration::from_millis(self.lock_retry_delay_ms));
        }
    }

    fn release_lock(&self, connection: &mut redis::Connection, token: &str) -> Result<()> {
        Script::new(
            r#"
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
            end
            return 0
            "#,
        )
        .key(self.lock_key())
        .arg(token)
        .invoke::<i32>(connection)
        .context("failed to release Dragonfly mutation lock")?;
        Ok(())
    }

    fn with_state<T, F>(&self, operation: F) -> Result<T>
    where
        F: FnOnce(&DragonflyRuntimeState) -> Result<T>,
    {
        let mut connection = self.open_connection()?;
        let state = self.load_state(&mut connection)?;
        operation(&state)
    }

    fn with_state_mut<T, F>(&self, operation: F) -> Result<T>
    where
        F: FnOnce(&mut DragonflyRuntimeState) -> Result<T>,
    {
        let mut connection = self.open_connection_for_write("writing runtime state")?;
        let token = self.acquire_lock(&mut connection)?;
        let result = (|| {
            let mut state = self.load_state(&mut connection)?;
            self.prepare_state_locked(&mut connection, &mut state)?;
            let value = operation(&mut state)?;
            self.save_state(&mut connection, &state)?;
            Ok(value)
        })();
        let release_result = self.release_lock(&mut connection, &token);
        match (result, release_result) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Err(error), Err(release_error)) => Err(error)
                .with_context(|| format!("also failed to release Dragonfly lock: {release_error}")),
        }
    }

    fn prepare_state_locked(
        &self,
        connection: &mut redis::Connection,
        state: &mut DragonflyRuntimeState,
    ) -> Result<()> {
        if !state.events.is_empty() {
            let mut legacy_events = state.events.clone();
            legacy_events.sort_by(|left, right| left.id.cmp(&right.id));
            for event in &legacy_events {
                self.migrate_legacy_event_to_stream(
                    connection,
                    event.id,
                    event.run_id,
                    &event.payload,
                    event.created_at,
                )?;
            }
            state.events.clear();
        }

        let event_floor = self.ensure_event_sequence_floor(connection, state.next_event_id)?;
        state.next_event_id = state.next_event_id.max(event_floor);
        Ok(())
    }

    fn append_event_to_stream(
        &self,
        connection: &mut redis::Connection,
        run_id: Option<i64>,
        event: &ApiEvent,
        created_at: DateTime<Utc>,
    ) -> Result<i64> {
        let mut resynchronized = false;

        loop {
            let event_id: i64 = connection
                .incr(self.event_sequence_key(), 1)
                .context("failed to allocate Dragonfly event id")?;

            match self.write_stream_event(connection, event_id, run_id, event, created_at) {
                Ok(()) => return Ok(event_id),
                Err(error) if !resynchronized && is_stream_id_conflict_error(&error) => {
                    resynchronized = true;
                    self.ensure_event_sequence_floor(connection, event_id)?;
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn migrate_legacy_event_to_stream(
        &self,
        connection: &mut redis::Connection,
        event_id: i64,
        run_id: Option<i64>,
        event: &ApiEvent,
        created_at: DateTime<Utc>,
    ) -> Result<()> {
        if self.event_exists(connection, event_id)? {
            return Ok(());
        }

        match self.write_stream_event(connection, event_id, run_id, event, created_at) {
            Ok(()) => Ok(()),
            Err(error) if is_stream_id_conflict_error(&error) => {
                let latest_event_id = self.load_latest_stream_event_id(connection)?.unwrap_or(0);
                if latest_event_id >= event_id {
                    tracing::warn!(
                        event_id,
                        latest_event_id,
                        "skipping legacy Dragonfly event older than current stream tail"
                    );
                    return Ok(());
                }
                Err(error)
            }
            Err(error) => Err(error),
        }
    }

    fn write_stream_event(
        &self,
        connection: &mut redis::Connection,
        event_id: i64,
        run_id: Option<i64>,
        event: &ApiEvent,
        created_at: DateTime<Utc>,
    ) -> Result<()> {
        let payload_json =
            serde_json::to_string(event).context("failed to serialize Dragonfly event payload")?;
        let run_id_value = run_id.map(|value| value.to_string()).unwrap_or_default();
        let created_at_value = created_at.to_rfc3339();
        let stream_id = stream_entry_id(event_id);
        let items = [
            ("run_id", run_id_value.as_str()),
            ("created_at", created_at_value.as_str()),
            ("payload_json", payload_json.as_str()),
        ];
        let options = redis::streams::StreamAddOptions::default();
        let _: Option<String> = connection
            .xadd_options(self.events_key(), stream_id.as_str(), &items, &options)
            .with_context(|| format!("failed to append Dragonfly event {event_id}"))?;
        Ok(())
    }

    fn event_exists(&self, connection: &mut redis::Connection, event_id: i64) -> Result<bool> {
        let stream_id = stream_entry_id(event_id);
        let events: StreamRangeReply = connection
            .xrange_count(self.events_key(), stream_id.as_str(), stream_id.as_str(), 1)
            .with_context(|| format!("failed to inspect Dragonfly event {event_id}"))?;
        Ok(events.ids.iter().any(|entry| entry.id == stream_id))
    }

    fn ensure_event_sequence_floor(
        &self,
        connection: &mut redis::Connection,
        requested_floor: i64,
    ) -> Result<i64> {
        let current_floor: Option<i64> = connection
            .get(self.event_sequence_key())
            .context("failed to load Dragonfly event sequence")?;
        let latest_stream_event_id = self.load_latest_stream_event_id(connection)?.unwrap_or(0);
        let desired_floor = requested_floor
            .max(current_floor.unwrap_or(0))
            .max(latest_stream_event_id);

        if current_floor.unwrap_or(0) < desired_floor {
            connection
                .set::<_, _, ()>(self.event_sequence_key(), desired_floor)
                .context("failed to synchronize Dragonfly event sequence")?;
        }

        Ok(desired_floor)
    }

    fn load_latest_stream_event_id(
        &self,
        connection: &mut redis::Connection,
    ) -> Result<Option<i64>> {
        let events: StreamRangeReply = connection
            .xrevrange_count(self.events_key(), "+", "-", 1)
            .context("failed to inspect Dragonfly event stream tail")?;
        events
            .ids
            .into_iter()
            .next()
            .map(|entry| parse_stream_event_id(&entry.id))
            .transpose()
    }
}

fn sorted_workers(mut workers: Vec<WorkerRecord>) -> Vec<WorkerRecord> {
    workers.sort_by(|left, right| {
        right
            .last_seen_at
            .cmp(&left.last_seen_at)
            .then(left.worker_id.cmp(&right.worker_id))
    });
    workers
}

fn sorted_worker_enrollment_token_records(
    tokens: &[StoredWorkerEnrollmentToken],
) -> Vec<WorkerEnrollmentTokenRecord> {
    let mut records = tokens
        .iter()
        .map(|token| token.record.clone())
        .collect::<Vec<_>>();
    records.sort_by(|left, right| right.id.cmp(&left.id));
    records
}

fn compute_worker_pool_records(
    state: &DragonflyRuntimeState,
    now: DateTime<Utc>,
) -> Vec<WorkerPoolRecord> {
    let mut pools = BTreeMap::<String, WorkerPoolRecord>::new();

    for worker in &state.workers {
        let Some(name) = normalize_worker_pool_name(worker.worker_pool.as_deref()) else {
            continue;
        };
        let entry = pools
            .entry(name.clone())
            .or_insert_with(|| WorkerPoolRecord {
                name,
                ..Default::default()
            });
        entry.total_workers += 1;
        if worker_is_online(worker, now) {
            entry.online_workers += 1;
        }
        match worker.lifecycle_state {
            WorkerLifecycleState::Active => entry.active_workers += 1,
            WorkerLifecycleState::Draining => entry.draining_workers += 1,
            WorkerLifecycleState::Disabled => entry.disabled_workers += 1,
            WorkerLifecycleState::Revoked => entry.revoked_workers += 1,
        }
    }

    for token in &state.worker_enrollment_tokens {
        let Some(name) = normalize_worker_pool_name(token.record.worker_pool.as_deref()) else {
            continue;
        };
        if token.record.revoked_at.is_some()
            || token
                .record
                .expires_at
                .is_some_and(|expires_at| expires_at <= now)
        {
            continue;
        }
        let entry = pools
            .entry(name.clone())
            .or_insert_with(|| WorkerPoolRecord {
                name,
                ..Default::default()
            });
        entry.active_enrollment_tokens += 1;
    }

    for candidate in &state.bootstrap_candidates {
        let Some(name) = normalize_worker_pool_name(candidate.worker_pool.as_deref()) else {
            continue;
        };
        let entry = pools
            .entry(name.clone())
            .or_insert_with(|| WorkerPoolRecord {
                name,
                ..Default::default()
            });
        if matches!(
            candidate.status,
            WorkerBootstrapCandidateStatus::PendingApproval
        ) {
            entry.pending_bootstrap_candidates += 1;
        }
    }

    for job in &state.bootstrap_jobs {
        let Some(name) = normalize_worker_pool_name(job.worker_pool.as_deref()) else {
            continue;
        };
        let entry = pools
            .entry(name.clone())
            .or_insert_with(|| WorkerPoolRecord {
                name,
                ..Default::default()
            });
        match job.status {
            WorkerBootstrapJobStatus::Queued => entry.queued_bootstrap_jobs += 1,
            WorkerBootstrapJobStatus::InProgress => entry.in_progress_bootstrap_jobs += 1,
            _ => {}
        }
    }

    for record in &state.port_scans {
        let Some(name) = normalize_worker_pool_name(record.port_scan.worker_pool.as_deref()) else {
            continue;
        };
        let entry = pools
            .entry(name.clone())
            .or_insert_with(|| WorkerPoolRecord {
                name,
                ..Default::default()
            });
        match record.port_scan.status {
            RunStatus::Queued => entry.queued_port_scans += 1,
            RunStatus::InProgress => entry.in_progress_port_scans += 1,
            _ => {}
        }
    }

    pools.into_values().collect()
}

fn sorted_bootstrap_candidates(
    mut candidates: Vec<WorkerBootstrapCandidateRecord>,
) -> Vec<WorkerBootstrapCandidateRecord> {
    candidates.sort_by(|left, right| {
        bootstrap_candidate_status_rank(left.status)
            .cmp(&bootstrap_candidate_status_rank(right.status))
            .then(right.updated_at.cmp(&left.updated_at))
            .then(right.id.cmp(&left.id))
    });
    candidates
}

fn sorted_bootstrap_jobs(mut jobs: Vec<WorkerBootstrapJobRecord>) -> Vec<WorkerBootstrapJobRecord> {
    jobs.sort_by(|left, right| {
        bootstrap_job_status_rank(left.status)
            .cmp(&bootstrap_job_status_rank(right.status))
            .then(right.updated_at.cmp(&left.updated_at))
            .then(right.id.cmp(&left.id))
    });
    jobs
}

fn bootstrap_candidate_status_rank(status: WorkerBootstrapCandidateStatus) -> u8 {
    match status {
        WorkerBootstrapCandidateStatus::PendingApproval => 0,
        WorkerBootstrapCandidateStatus::Approved => 1,
        WorkerBootstrapCandidateStatus::Registered => 2,
        WorkerBootstrapCandidateStatus::Rejected => 3,
        WorkerBootstrapCandidateStatus::Failed => 4,
    }
}

fn bootstrap_job_status_rank(status: WorkerBootstrapJobStatus) -> u8 {
    match status {
        WorkerBootstrapJobStatus::Queued => 0,
        WorkerBootstrapJobStatus::InProgress => 1,
        WorkerBootstrapJobStatus::Failed => 2,
        WorkerBootstrapJobStatus::Completed => 3,
    }
}

fn register_worker_in_state(
    state: &mut DragonflyRuntimeState,
    registration: &WorkerRegistration,
    ttl_seconds: u64,
    now: DateTime<Utc>,
) -> Result<WorkerRecord> {
    let worker_id = registration.worker_id.trim();
    if worker_id.is_empty() {
        return Err(anyhow!("worker_id is required"));
    }

    let expires_at = lease_expires_at(now, ttl_seconds)?;
    let display_name = registration
        .display_name
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let requested_pool = normalize_worker_pool_name(registration.worker_pool.as_deref());
    let requested_tags = normalize_worker_values(&registration.tags);
    let scanner_adapters = normalize_worker_values(&registration.scanner_adapters);
    let provisioners = normalize_worker_values(&registration.provisioners);

    if let Some(index) = state
        .workers
        .iter()
        .position(|worker| worker.worker_id == worker_id)
    {
        let enrollment_token = state.workers[index]
            .enrollment_token_id
            .and_then(|token_id| find_worker_enrollment_token_record(state, token_id));
        if !state.workers[index].lifecycle_state.accepts_heartbeats() {
            return Err(anyhow!("worker {worker_id} has been revoked"));
        }
        validate_worker_registration_capabilities(registration, enrollment_token.as_ref())?;
        let resolved_pool = resolve_worker_pool_for_registration(
            requested_pool,
            Some(&state.workers[index]),
            enrollment_token.as_ref(),
        )?;
        let resolved_tags = merge_worker_tags(requested_tags, enrollment_token.as_ref());

        let existing = &mut state.workers[index];
        existing.display_name = display_name;
        existing.worker_pool = resolved_pool;
        existing.tags = resolved_tags;
        existing.supports_runs = registration.supports_runs;
        existing.supports_port_scans = registration.supports_port_scans;
        existing.supports_bootstrap = registration.supports_bootstrap;
        existing.scanner_adapters = scanner_adapters;
        existing.provisioners = provisioners;
        existing.last_seen_at = now;
        existing.expires_at = expires_at;
        return Ok(existing.clone());
    }

    let enrollment_token = registration
        .enrollment_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("enrollment_token is required when registering a new worker"))?;
    let token_index = find_usable_worker_enrollment_token_index(state, enrollment_token, now)
        .ok_or_else(|| anyhow!("invalid or expired worker enrollment token"))?;
    let token_record = state.worker_enrollment_tokens[token_index].record.clone();
    validate_worker_registration_capabilities(registration, Some(&token_record))?;
    let worker_pool =
        resolve_worker_pool_for_registration(requested_pool, None, Some(&token_record))?;
    let tags = merge_worker_tags(requested_tags, Some(&token_record));
    let record = WorkerRecord {
        worker_id: worker_id.to_string(),
        display_name,
        worker_pool,
        tags,
        supports_runs: registration.supports_runs,
        supports_port_scans: registration.supports_port_scans,
        supports_bootstrap: registration.supports_bootstrap,
        scanner_adapters,
        provisioners,
        lifecycle_state: WorkerLifecycleState::Active,
        enrollment_token_id: Some(token_record.id),
        registered_at: now,
        last_seen_at: now,
        expires_at,
    };
    state.workers.push(record.clone());
    state
        .workers
        .sort_by(|left, right| left.worker_id.cmp(&right.worker_id));
    mark_worker_enrollment_token_used_in_state(state, token_record.id, worker_id, now)?;
    mark_bootstrap_candidate_registered_in_state(state, token_record.id, worker_id, now);
    Ok(record)
}

fn update_worker_lifecycle_state_in_state(
    state: &mut DragonflyRuntimeState,
    worker_id: &str,
    lifecycle_state: WorkerLifecycleState,
    _now: DateTime<Utc>,
) -> Result<WorkerRecord> {
    let worker = state
        .workers
        .iter_mut()
        .find(|worker| worker.worker_id == worker_id)
        .ok_or_else(|| anyhow!("worker {worker_id} not found"))?;
    worker.lifecycle_state = lifecycle_state;
    Ok(worker.clone())
}

fn issue_worker_enrollment_token_in_state(
    state: &mut DragonflyRuntimeState,
    created_by: Option<&str>,
    request: &WorkerEnrollmentTokenIssueRequest,
    now: DateTime<Utc>,
) -> Result<WorkerEnrollmentTokenIssued> {
    let label = request.label.trim();
    if label.is_empty() {
        return Err(anyhow!("worker enrollment token label is required"));
    }
    let token_id = state.next_worker_enrollment_token_id();
    let token = generate_worker_enrollment_token(token_id, label, now)?;
    let record = WorkerEnrollmentTokenRecord {
        id: token_id,
        label: label.to_string(),
        worker_pool: normalize_worker_pool_name(request.worker_pool.as_deref()),
        tags: normalize_worker_values(&request.tags),
        allow_runs: request.allow_runs,
        allow_port_scans: request.allow_port_scans,
        allow_bootstrap: request.allow_bootstrap,
        single_use: request.single_use,
        created_by: created_by
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string()),
        created_at: now,
        expires_at: optional_expires_at(now, request.expires_in_seconds)?,
        revoked_at: None,
        used_by_worker_id: None,
        used_at: None,
    };
    state
        .worker_enrollment_tokens
        .push(StoredWorkerEnrollmentToken {
            record: record.clone(),
            token_hash: hash_worker_enrollment_token(&token),
            token_value: Some(token.clone()),
        });
    state
        .worker_enrollment_tokens
        .sort_by(|left, right| left.record.id.cmp(&right.record.id));
    Ok(WorkerEnrollmentTokenIssued { record, token })
}

fn revoke_worker_enrollment_token_in_state(
    state: &mut DragonflyRuntimeState,
    token_id: i64,
    now: DateTime<Utc>,
) -> Result<WorkerEnrollmentTokenRecord> {
    let token = state
        .worker_enrollment_tokens
        .iter_mut()
        .find(|token| token.record.id == token_id)
        .ok_or_else(|| anyhow!("worker enrollment token {token_id} not found"))?;
    if token.record.revoked_at.is_none() {
        token.record.revoked_at = Some(now);
    }
    token.token_value = None;
    Ok(token.record.clone())
}

fn create_bootstrap_candidates_in_state(
    state: &mut DragonflyRuntimeState,
    port_scan: &PortScanRecord,
    candidates: &[WorkerBootstrapCandidateInput],
    now: DateTime<Utc>,
) -> Result<Vec<WorkerBootstrapCandidateRecord>> {
    if !port_scan.bootstrap_policy.enabled || candidates.is_empty() {
        return Ok(Vec::new());
    }
    if !state
        .port_scans
        .iter()
        .any(|record| record.port_scan.id == port_scan.id)
    {
        return Err(anyhow!("port scan {} not found", port_scan.id));
    }

    let mut created = Vec::new();
    for candidate in candidates {
        let Some(discovered_host) = normalize_discovered_host(&candidate.discovered_host) else {
            continue;
        };
        let discovered_port = candidate.discovered_port;
        let exists = state.bootstrap_candidates.iter().any(|existing| {
            existing.port_scan_id == port_scan.id
                && existing.discovered_port == discovered_port
                && existing
                    .discovered_host
                    .eq_ignore_ascii_case(&discovered_host)
        });
        if exists {
            continue;
        }

        let record = WorkerBootstrapCandidateRecord {
            id: state.next_bootstrap_candidate_id(),
            port_scan_id: port_scan.id,
            requested_by: port_scan.requested_by.clone(),
            discovered_host,
            discovered_port,
            worker_pool: port_scan.bootstrap_policy.worker_pool.clone(),
            tags: port_scan.bootstrap_policy.tags.clone(),
            status: WorkerBootstrapCandidateStatus::PendingApproval,
            approved_by: None,
            enrollment_token_id: None,
            worker_id: None,
            notes: None,
            created_at: now,
            updated_at: now,
        };
        state.bootstrap_candidates.push(record.clone());
        created.push(record);
    }

    let total = state
        .bootstrap_candidates
        .iter()
        .filter(|candidate| candidate.port_scan_id == port_scan.id)
        .count() as u64;
    if let Some(record) = state
        .port_scans
        .iter_mut()
        .find(|record| record.port_scan.id == port_scan.id)
    {
        record.port_scan.bootstrap_candidates_total = total;
    }
    state
        .bootstrap_candidates
        .sort_by(|left, right| left.id.cmp(&right.id));
    Ok(created)
}

fn approve_bootstrap_candidate_in_state(
    state: &mut DragonflyRuntimeState,
    candidate_id: i64,
    approved_by: Option<&str>,
    request: &WorkerBootstrapCandidateApprovalRequest,
    now: DateTime<Utc>,
) -> Result<WorkerBootstrapCandidateApproval> {
    let candidate_index = state
        .bootstrap_candidates
        .iter()
        .position(|candidate| candidate.id == candidate_id)
        .ok_or_else(|| anyhow!("bootstrap candidate {candidate_id} not found"))?;
    let candidate_snapshot = state.bootstrap_candidates[candidate_index].clone();
    if !matches!(
        candidate_snapshot.status,
        WorkerBootstrapCandidateStatus::PendingApproval
    ) {
        return Err(anyhow!(
            "bootstrap candidate {candidate_id} is not pending approval"
        ));
    }

    let worker_pool = normalize_worker_pool_name(request.worker_pool.as_deref())
        .or_else(|| candidate_snapshot.worker_pool.clone());
    let tags = if request.tags.is_empty() {
        candidate_snapshot.tags.clone()
    } else {
        normalize_worker_values(&request.tags)
    };
    let token_request = WorkerEnrollmentTokenIssueRequest {
        label: request
            .label
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .unwrap_or_else(|| bootstrap_candidate_token_label(&candidate_snapshot)),
        worker_pool: worker_pool.clone(),
        tags: tags.clone(),
        allow_runs: request.allow_runs.unwrap_or(true),
        allow_port_scans: request.allow_port_scans.unwrap_or(true),
        allow_bootstrap: request.allow_bootstrap.unwrap_or(false),
        single_use: request.single_use.unwrap_or(true),
        expires_in_seconds: request.expires_in_seconds.or(Some(86_400)),
    };
    let issued = issue_worker_enrollment_token_in_state(state, approved_by, &token_request, now)?;

    let candidate = {
        let candidate = &mut state.bootstrap_candidates[candidate_index];
        candidate.worker_pool = worker_pool;
        candidate.tags = tags;
        candidate.status = WorkerBootstrapCandidateStatus::Approved;
        candidate.approved_by = approved_by
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());
        candidate.enrollment_token_id = Some(issued.record.id);
        candidate.notes = request
            .notes
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());
        candidate.updated_at = now;
        candidate.clone()
    };

    let bootstrap_job = if request.dispatch.is_enabled() {
        Some(create_bootstrap_job_in_state(
            state,
            &candidate,
            approved_by,
            &request.dispatch,
            &issued,
            now,
        )?)
    } else {
        None
    };

    Ok(WorkerBootstrapCandidateApproval {
        candidate,
        token: issued,
        bootstrap_job,
    })
}

fn reject_bootstrap_candidate_in_state(
    state: &mut DragonflyRuntimeState,
    candidate_id: i64,
    request: &WorkerBootstrapCandidateRejectionRequest,
    now: DateTime<Utc>,
) -> Result<WorkerBootstrapCandidateRecord> {
    let candidate_index = state
        .bootstrap_candidates
        .iter()
        .position(|candidate| candidate.id == candidate_id)
        .ok_or_else(|| anyhow!("bootstrap candidate {candidate_id} not found"))?;
    if matches!(
        state.bootstrap_candidates[candidate_index].status,
        WorkerBootstrapCandidateStatus::Registered
    ) {
        return Err(anyhow!(
            "bootstrap candidate {candidate_id} is already registered"
        ));
    }
    if let Some(token_id) = state.bootstrap_candidates[candidate_index].enrollment_token_id {
        let _ = revoke_worker_enrollment_token_in_state(state, token_id, now)?;
    }

    for job in state.bootstrap_jobs.iter_mut().filter(|job| {
        job.candidate_id == candidate_id
            && !matches!(
                job.status,
                WorkerBootstrapJobStatus::Completed | WorkerBootstrapJobStatus::Failed
            )
    }) {
        job.status = WorkerBootstrapJobStatus::Failed;
        job.notes = Some("bootstrap candidate rejected".to_string());
        job.completed_at = Some(now);
        job.updated_at = now;
        job.claimed_by_worker_id = None;
        state.bootstrap_job_claims.remove(&job.id);
    }

    let candidate = &mut state.bootstrap_candidates[candidate_index];
    candidate.status = WorkerBootstrapCandidateStatus::Rejected;
    candidate.notes = request
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    candidate.updated_at = now;
    Ok(candidate.clone())
}

fn create_bootstrap_job_in_state(
    state: &mut DragonflyRuntimeState,
    candidate: &WorkerBootstrapCandidateRecord,
    approved_by: Option<&str>,
    dispatch: &WorkerBootstrapDispatchRequest,
    issued: &WorkerEnrollmentTokenIssued,
    now: DateTime<Utc>,
) -> Result<WorkerBootstrapJobRecord> {
    let provisioner = dispatch
        .provisioner
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow!("bootstrap dispatch provisioner is required when dispatch is enabled")
        })?;
    let record = WorkerBootstrapJobRecord {
        id: state.next_bootstrap_job_id(),
        candidate_id: candidate.id,
        port_scan_id: candidate.port_scan_id,
        requested_by: candidate.requested_by.clone(),
        approved_by: approved_by
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string()),
        discovered_host: candidate.discovered_host.clone(),
        discovered_port: candidate.discovered_port,
        worker_pool: candidate.worker_pool.clone(),
        tags: candidate.tags.clone(),
        provisioner: provisioner.to_string(),
        executor_worker_pool: normalize_worker_pool_name(dispatch.executor_worker_pool.as_deref()),
        executor_tags: normalize_worker_values(&dispatch.executor_tags),
        status: WorkerBootstrapJobStatus::Queued,
        enrollment_token_id: Some(issued.record.id),
        claimed_by_worker_id: None,
        attempt_count: 0,
        started_at: None,
        completed_at: None,
        notes: dispatch
            .notes
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string()),
        created_at: now,
        updated_at: now,
    };
    state.bootstrap_jobs.push(record.clone());
    state
        .bootstrap_jobs
        .sort_by(|left, right| left.id.cmp(&right.id));
    Ok(record)
}

fn claim_next_pending_bootstrap_job_in_state(
    state: &mut DragonflyRuntimeState,
    worker_id: &str,
    now: DateTime<Utc>,
    lease_seconds: u64,
) -> Result<Option<WorkerBootstrapJobClaim>> {
    let Some((worker_pool, worker_tags, provisioners)) =
        claimable_worker_bootstrap_context(state, worker_id, now)
    else {
        return Ok(None);
    };

    let claim_expires_at = lease_expires_at(now, lease_seconds)?;
    let Some(job_id) = state
        .bootstrap_jobs
        .iter()
        .filter(|job| {
            matches!(
                job.status,
                WorkerBootstrapJobStatus::Queued | WorkerBootstrapJobStatus::InProgress
            ) && !bootstrap_job_claim_is_active(state, job.id, now)
                && bootstrap_job_matches_executor(
                    job,
                    worker_pool.as_deref(),
                    &worker_tags,
                    &provisioners,
                )
        })
        .map(|job| job.id)
        .min()
    else {
        return Ok(None);
    };

    let job_index = state
        .bootstrap_jobs
        .iter()
        .position(|job| job.id == job_id)
        .ok_or_else(|| anyhow!("bootstrap job {job_id} not found"))?;
    let job = &mut state.bootstrap_jobs[job_index];
    job.claimed_by_worker_id = Some(worker_id.to_string());
    job.attempt_count += 1;
    job.updated_at = now;
    state.bootstrap_job_claims.insert(
        job_id,
        StoredJobClaim {
            claimed_by: worker_id.to_string(),
            claim_expires_at,
        },
    );

    let candidate = state
        .bootstrap_candidates
        .iter()
        .find(|candidate| candidate.id == job.candidate_id)
        .cloned()
        .ok_or_else(|| anyhow!("bootstrap candidate {} not found", job.candidate_id))?;
    let enrollment_token_id = job
        .enrollment_token_id
        .ok_or_else(|| anyhow!("bootstrap job {job_id} is missing an enrollment token"))?;
    let enrollment_token = state
        .worker_enrollment_tokens
        .iter()
        .find(|token| token.record.id == enrollment_token_id)
        .and_then(|token| token.token_value.clone())
        .ok_or_else(|| {
            anyhow!(
            "bootstrap job {job_id} enrollment token {enrollment_token_id} is no longer available"
        )
        })?;

    Ok(Some(WorkerBootstrapJobClaim {
        job: job.clone(),
        candidate,
        enrollment_token,
    }))
}

fn bootstrap_job_record_index(state: &DragonflyRuntimeState, job_id: i64) -> Option<usize> {
    state
        .bootstrap_jobs
        .iter()
        .position(|record| record.id == job_id)
}

fn mark_bootstrap_job_started_if_owned_in_state(
    state: &mut DragonflyRuntimeState,
    job_id: i64,
    worker_id: &str,
    now: DateTime<Utc>,
) -> Result<Option<WorkerBootstrapJobRecord>> {
    let Some(record_index) = bootstrap_job_record_index(state, job_id) else {
        return Err(anyhow!("bootstrap job {job_id} not found"));
    };
    let claim_is_active = bootstrap_job_claim_is_active(state, job_id, now);
    let owned_by_worker = state.bootstrap_jobs[record_index]
        .claimed_by_worker_id
        .as_deref()
        == Some(worker_id);
    if !owned_by_worker || !claim_is_active {
        return Ok(None);
    }
    if matches!(
        state.bootstrap_jobs[record_index].status,
        WorkerBootstrapJobStatus::Completed | WorkerBootstrapJobStatus::Failed
    ) {
        return Ok(None);
    }
    let record = &mut state.bootstrap_jobs[record_index];
    record.status = WorkerBootstrapJobStatus::InProgress;
    if record.started_at.is_none() {
        record.started_at = Some(now);
    }
    record.updated_at = now;
    Ok(Some(record.clone()))
}

fn complete_bootstrap_job_if_owned_in_state(
    state: &mut DragonflyRuntimeState,
    job_id: i64,
    worker_id: &str,
    notes: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Option<WorkerBootstrapJobRecord>> {
    let Some(record_index) = bootstrap_job_record_index(state, job_id) else {
        return Err(anyhow!("bootstrap job {job_id} not found"));
    };
    let claim_is_active = bootstrap_job_claim_is_active(state, job_id, now);
    let owned_by_worker = state.bootstrap_jobs[record_index]
        .claimed_by_worker_id
        .as_deref()
        == Some(worker_id);
    if !owned_by_worker || !claim_is_active {
        return Ok(None);
    }
    {
        let record = &mut state.bootstrap_jobs[record_index];
        record.status = WorkerBootstrapJobStatus::Completed;
        record.completed_at = Some(now);
        record.updated_at = now;
        record.notes = notes
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .or_else(|| record.notes.clone());
    }
    clear_bootstrap_job_claim(state, job_id);
    Ok(Some(state.bootstrap_jobs[record_index].clone()))
}

fn fail_bootstrap_job_if_owned_in_state(
    state: &mut DragonflyRuntimeState,
    job_id: i64,
    worker_id: &str,
    notes: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Option<WorkerBootstrapJobRecord>> {
    let Some(record_index) = bootstrap_job_record_index(state, job_id) else {
        return Err(anyhow!("bootstrap job {job_id} not found"));
    };
    let claim_is_active = bootstrap_job_claim_is_active(state, job_id, now);
    let owned_by_worker = state.bootstrap_jobs[record_index]
        .claimed_by_worker_id
        .as_deref()
        == Some(worker_id);
    if !owned_by_worker || !claim_is_active {
        return Ok(None);
    }
    {
        let record = &mut state.bootstrap_jobs[record_index];
        record.status = WorkerBootstrapJobStatus::Failed;
        record.completed_at = Some(now);
        record.updated_at = now;
        record.notes = notes
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .or_else(|| record.notes.clone());
    }
    clear_bootstrap_job_claim(state, job_id);
    Ok(Some(state.bootstrap_jobs[record_index].clone()))
}

fn clear_bootstrap_job_claim(state: &mut DragonflyRuntimeState, job_id: i64) {
    state.bootstrap_job_claims.remove(&job_id);
    if let Some(record) = state
        .bootstrap_jobs
        .iter_mut()
        .find(|record| record.id == job_id)
    {
        record.claimed_by_worker_id = None;
    }
}

fn bootstrap_job_claim_is_active(
    state: &DragonflyRuntimeState,
    job_id: i64,
    now: DateTime<Utc>,
) -> bool {
    state
        .bootstrap_job_claims
        .get(&job_id)
        .is_some_and(|claim| claim.claim_expires_at > now)
}

fn claimable_worker_bootstrap_context(
    state: &DragonflyRuntimeState,
    worker_id: &str,
    now: DateTime<Utc>,
) -> Option<(Option<String>, Vec<String>, Vec<String>)> {
    let worker = state
        .workers
        .iter()
        .find(|worker| worker.worker_id == worker_id)?;
    if !worker.supports_bootstrap
        || worker.provisioners.is_empty()
        || !worker.lifecycle_state.allows_new_work()
        || !worker_is_online(worker, now)
    {
        return None;
    }
    Some((
        worker.worker_pool.clone(),
        worker.tags.clone(),
        worker.provisioners.clone(),
    ))
}

fn bootstrap_job_matches_executor(
    job: &WorkerBootstrapJobRecord,
    worker_pool: Option<&str>,
    worker_tags: &[String],
    provisioners: &[String],
) -> bool {
    if let Some(required_pool) = job.executor_worker_pool.as_deref() {
        if worker_pool != Some(required_pool) {
            return false;
        }
    }
    if !job
        .executor_tags
        .iter()
        .all(|tag| worker_tags.iter().any(|worker_tag| worker_tag == tag))
    {
        return false;
    }
    provisioners.iter().any(|value| value == &job.provisioner)
}

fn claim_next_pending_port_scan_in_state(
    state: &mut DragonflyRuntimeState,
    worker_id: &str,
    now: DateTime<Utc>,
    lease_seconds: u64,
) -> Result<Option<PortScanRecord>> {
    let worker_pool = match claimable_worker_port_scan_pool(state, worker_id, now) {
        Some(worker_pool) => worker_pool,
        None => return Ok(None),
    };

    let claim_expires_at = lease_expires_at(now, lease_seconds)?;
    let Some(record) = state
        .port_scans
        .iter_mut()
        .filter(|record| {
            matches!(
                record.port_scan.status,
                RunStatus::Queued | RunStatus::InProgress
            ) && !port_scan_claim_is_active(record, now)
                && port_scan_matches_worker_pool(&record.port_scan, worker_pool.as_deref())
        })
        .min_by_key(|record| record.port_scan.id)
    else {
        return Ok(None);
    };
    record.claimed_by = Some(worker_id.to_string());
    record.claim_expires_at = Some(claim_expires_at);
    Ok(Some(record.port_scan.clone()))
}

fn claimable_worker_port_scan_pool(
    state: &DragonflyRuntimeState,
    worker_id: &str,
    now: DateTime<Utc>,
) -> Option<Option<String>> {
    let worker = state
        .workers
        .iter()
        .find(|worker| worker.worker_id == worker_id)?;
    if !worker.supports_port_scans
        || !worker.lifecycle_state.allows_new_work()
        || !worker_is_online(worker, now)
    {
        return None;
    }
    Some(worker.worker_pool.clone())
}

fn worker_allows_new_runs(
    state: &DragonflyRuntimeState,
    worker_id: &str,
    now: DateTime<Utc>,
) -> bool {
    state.workers.iter().any(|worker| {
        worker.worker_id == worker_id
            && worker.supports_runs
            && worker.lifecycle_state.allows_new_work()
            && worker_is_online(worker, now)
    })
}

fn worker_is_online(worker: &WorkerRecord, now: DateTime<Utc>) -> bool {
    worker.expires_at > now
}

fn port_scan_matches_worker_pool(port_scan: &PortScanRecord, worker_pool: Option<&str>) -> bool {
    match port_scan.worker_pool.as_deref() {
        Some(required_pool) => worker_pool.is_some_and(|pool| pool == required_pool),
        None => true,
    }
}

fn validate_worker_registration_capabilities(
    registration: &WorkerRegistration,
    enrollment_token: Option<&WorkerEnrollmentTokenRecord>,
) -> Result<()> {
    let Some(enrollment_token) = enrollment_token else {
        return Ok(());
    };

    if registration.supports_runs && !enrollment_token.allow_runs {
        return Err(anyhow!(
            "worker enrollment token {} does not permit run execution",
            enrollment_token.id
        ));
    }
    if registration.supports_port_scans && !enrollment_token.allow_port_scans {
        return Err(anyhow!(
            "worker enrollment token {} does not permit port scans",
            enrollment_token.id
        ));
    }
    if registration.supports_bootstrap && !enrollment_token.allow_bootstrap {
        return Err(anyhow!(
            "worker enrollment token {} does not permit bootstrap support",
            enrollment_token.id
        ));
    }
    Ok(())
}

fn resolve_worker_pool_for_registration(
    requested_pool: Option<String>,
    existing_worker: Option<&WorkerRecord>,
    enrollment_token: Option<&WorkerEnrollmentTokenRecord>,
) -> Result<Option<String>> {
    if let Some(token_pool) = enrollment_token.and_then(|token| token.worker_pool.as_ref()) {
        if let Some(requested_pool) = requested_pool.as_deref() {
            if requested_pool != token_pool {
                return Err(anyhow!(
                    "worker enrollment token {} only permits worker_pool {}",
                    enrollment_token.map(|token| token.id).unwrap_or_default(),
                    token_pool
                ));
            }
        }
        return Ok(Some(token_pool.clone()));
    }
    if requested_pool.is_some() {
        return Ok(requested_pool);
    }
    Ok(existing_worker.and_then(|worker| worker.worker_pool.clone()))
}

fn merge_worker_tags(
    mut requested_tags: Vec<String>,
    enrollment_token: Option<&WorkerEnrollmentTokenRecord>,
) -> Vec<String> {
    if let Some(enrollment_token) = enrollment_token {
        for tag in &enrollment_token.tags {
            if !requested_tags.contains(tag) {
                requested_tags.push(tag.clone());
            }
        }
    }
    requested_tags
}

fn normalize_worker_pool_name(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    let normalized = value
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

fn optional_expires_at(
    now: DateTime<Utc>,
    expires_in_seconds: Option<u64>,
) -> Result<Option<DateTime<Utc>>> {
    expires_in_seconds
        .map(|seconds| lease_expires_at(now, seconds))
        .transpose()
}

fn generate_worker_enrollment_token(
    token_id: i64,
    label: &str,
    now: DateTime<Utc>,
) -> Result<String> {
    let mut random = [0u8; 32];
    fs::File::open("/dev/urandom")
        .context("failed to open /dev/urandom for worker enrollment token generation")?
        .read_exact(&mut random)
        .context("failed to read /dev/urandom for worker enrollment token generation")?;
    let mut hasher = Sha256::new();
    hasher.update(random);
    hasher.update(token_id.to_le_bytes());
    hasher.update(label.as_bytes());
    hasher.update(now.timestamp().to_le_bytes());
    hasher.update(now.timestamp_subsec_nanos().to_le_bytes());
    Ok(format!("ewt_{}_{:x}", token_id, hasher.finalize()))
}

fn hash_worker_enrollment_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn find_usable_worker_enrollment_token_index(
    state: &DragonflyRuntimeState,
    token: &str,
    now: DateTime<Utc>,
) -> Option<usize> {
    let token_hash = hash_worker_enrollment_token(token);
    state.worker_enrollment_tokens.iter().position(|stored| {
        worker_enrollment_token_is_usable(&stored.record, &stored.token_hash, &token_hash, now)
    })
}

fn worker_enrollment_token_is_usable(
    record: &WorkerEnrollmentTokenRecord,
    stored_hash: &str,
    presented_hash: &str,
    now: DateTime<Utc>,
) -> bool {
    if stored_hash != presented_hash {
        return false;
    }
    if record.revoked_at.is_some() {
        return false;
    }
    if record
        .expires_at
        .is_some_and(|expires_at| expires_at <= now)
    {
        return false;
    }
    if record.single_use && record.used_by_worker_id.is_some() {
        return false;
    }
    true
}

fn find_worker_enrollment_token_record(
    state: &DragonflyRuntimeState,
    token_id: i64,
) -> Option<WorkerEnrollmentTokenRecord> {
    state
        .worker_enrollment_tokens
        .iter()
        .find(|token| token.record.id == token_id)
        .map(|token| token.record.clone())
}

fn mark_worker_enrollment_token_used_in_state(
    state: &mut DragonflyRuntimeState,
    token_id: i64,
    worker_id: &str,
    now: DateTime<Utc>,
) -> Result<()> {
    let token = state
        .worker_enrollment_tokens
        .iter_mut()
        .find(|token| token.record.id == token_id)
        .ok_or_else(|| anyhow!("worker enrollment token {token_id} not found"))?;
    if token.record.single_use {
        if token.record.used_by_worker_id.is_some() {
            return Err(anyhow!(
                "worker enrollment token {token_id} has already been used"
            ));
        }
        token.record.used_by_worker_id = Some(worker_id.to_string());
        token.record.used_at = Some(now);
        token.token_value = None;
        return Ok(());
    }
    if token.record.used_by_worker_id.is_none() {
        token.record.used_by_worker_id = Some(worker_id.to_string());
        token.record.used_at = Some(now);
    }
    Ok(())
}

fn mark_bootstrap_candidate_registered_in_state(
    state: &mut DragonflyRuntimeState,
    token_id: i64,
    worker_id: &str,
    now: DateTime<Utc>,
) {
    if let Some(candidate) = state.bootstrap_candidates.iter_mut().find(|candidate| {
        candidate.enrollment_token_id == Some(token_id)
            && matches!(candidate.status, WorkerBootstrapCandidateStatus::Approved)
    }) {
        candidate.status = WorkerBootstrapCandidateStatus::Registered;
        candidate.worker_id = Some(worker_id.to_string());
        candidate.updated_at = now;
    }

    let matching_job_ids = state
        .bootstrap_jobs
        .iter()
        .filter(|job| {
            job.enrollment_token_id == Some(token_id)
                && !matches!(
                    job.status,
                    WorkerBootstrapJobStatus::Completed | WorkerBootstrapJobStatus::Failed
                )
        })
        .map(|job| job.id)
        .collect::<Vec<_>>();
    for job_id in matching_job_ids {
        if let Some(job) = state.bootstrap_jobs.iter_mut().find(|job| job.id == job_id) {
            job.status = WorkerBootstrapJobStatus::Completed;
            job.completed_at = Some(now);
            job.updated_at = now;
            job.notes = Some(format!("worker {worker_id} registered successfully"));
            job.claimed_by_worker_id = None;
        }
        state.bootstrap_job_claims.remove(&job_id);
    }
}

fn bootstrap_candidate_token_label(candidate: &WorkerBootstrapCandidateRecord) -> String {
    let mut label = format!(
        "bootstrap-candidate-{}-{}",
        candidate.id, candidate.discovered_host
    );
    if let Some(port) = candidate.discovered_port {
        label.push('-');
        label.push_str(&port.to_string());
    }
    label
}

fn normalize_discovered_host(value: &str) -> Option<String> {
    let candidate = value.trim().to_ascii_lowercase();
    if candidate.is_empty() {
        None
    } else {
        Some(candidate)
    }
}

pub fn build_redis_connection_url(storage: &StorageConfig) -> Result<String> {
    let redis_url = storage
        .redis_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("REDIS_URL is required for Dragonfly storage"))?;
    let protocol = if storage.redis_tls { "rediss" } else { "redis" };

    if redis_url.contains("://") {
        let mut url =
            Url::parse(redis_url).with_context(|| format!("invalid REDIS_URL {redis_url}"))?;
        if let Some(username) = storage
            .redis_username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            url.set_username(username)
                .map_err(|_| anyhow!("invalid REDIS_USERNAME for REDIS_URL"))?;
        }
        if let Some(password) = storage
            .redis_password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            url.set_password(Some(password))
                .map_err(|_| anyhow!("invalid REDIS_PASSWORD for REDIS_URL"))?;
        }
        if url.path().is_empty() || url.path() == "/" {
            url.set_path(&format!("/{}", storage.redis_db));
        }
        url.set_scheme(protocol)
            .map_err(|_| anyhow!("failed to set Redis URL scheme to {protocol}"))?;
        return Ok(url.to_string());
    }

    let username = storage
        .redis_username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("REDIS_USERNAME is required when REDIS_URL is host:port"))?;
    let password = storage
        .redis_password
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("REDIS_PASSWORD is required when REDIS_URL is host:port"))?;
    let parts = redis_url.split(':').collect::<Vec<_>>();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].parse::<u16>().is_err() {
        return Err(anyhow!(
            "invalid REDIS_URL format. Expected host:port, received: {redis_url}"
        ));
    }
    let mut url = Url::parse(&format!(
        "{protocol}://{}:{}/{}",
        parts[0], parts[1], storage.redis_db
    ))
    .with_context(|| format!("invalid REDIS_URL host:port {redis_url}"))?;
    url.set_username(username)
        .map_err(|_| anyhow!("invalid REDIS_USERNAME for REDIS_URL"))?;
    url.set_password(Some(password))
        .map_err(|_| anyhow!("invalid REDIS_PASSWORD for REDIS_URL"))?;
    Ok(url.to_string())
}

fn redact_connection_url(url: &str) -> String {
    match Url::parse(url) {
        Ok(mut parsed) => {
            if parsed.password().is_some() {
                let _ = parsed.set_password(Some("[redacted]"));
            }
            if !parsed.username().is_empty() {
                let _ = parsed.set_username("[redacted]");
            }
            parsed.to_string()
        }
        Err(_) => "redis://[redacted]".to_string(),
    }
}

fn occupied_namespace_keys(namespace_keys: Vec<String>, lock_key: &str) -> Vec<String> {
    let mut occupied_keys = namespace_keys
        .into_iter()
        .filter(|key| key != lock_key)
        .collect::<Vec<_>>();
    occupied_keys.sort();
    occupied_keys
}

fn build_finding_record(
    state: &mut DragonflyRuntimeState,
    finding: &NewFinding,
) -> Result<FindingRecord> {
    let target = state
        .targets
        .iter()
        .find(|target| target.id == finding.target_id)
        .ok_or_else(|| anyhow!("target {} not found for finding", finding.target_id))?
        .clone();
    Ok(FindingRecord {
        id: state.next_finding_id(),
        run_id: finding.run_id,
        target_id: finding.target_id,
        target_label: target.label,
        target_base_url: target.base_url,
        target_strategy: target.strategy,
        discovery_provenance: target
            .discovery_provenance
            .iter()
            .find(|entry| entry.path == finding.path)
            .cloned(),
        detector: finding.detector.clone(),
        severity: finding.severity.clone(),
        path: finding.path.clone(),
        redacted_value: finding.redacted_value.clone(),
        evidence: finding.evidence.clone(),
        fingerprint: finding.fingerprint.clone(),
        discovered_at: utc_now(),
    })
}

fn titleize_detector_name(detector: &str) -> String {
    let words = detector
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut characters = word.chars();
            let Some(first) = characters.next() else {
                return String::new();
            };
            let mut rendered = first.to_ascii_uppercase().to_string();
            rendered.push_str(&characters.as_str().to_ascii_lowercase());
            rendered
        })
        .collect::<Vec<_>>();
    if words.is_empty() {
        detector.to_string()
    } else {
        words.join(" ")
    }
}

fn default_public_finding_summary(finding: &FindingRecord) -> String {
    let severity = titleize_detector_name(finding.severity.as_str());
    let detector = titleize_detector_name(&finding.detector);
    format!(
        "{severity} {detector} exposure observed at {}{}",
        finding.target_base_url, finding.path
    )
}

fn normalize_public_text(value: Option<&str>, max_len: usize) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated = normalized.chars().take(max_len).collect::<String>();
    Some(truncated)
}

fn upsert_public_finding_moderation_in_state(
    state: &mut DragonflyRuntimeState,
    finding_id: i64,
    reviewed_by: Option<String>,
    request: &PublicFindingModerationRequest,
) -> Result<PublicFindingModerationRecord> {
    const MAX_PUBLIC_FINDING_SUMMARY_LENGTH: usize = 280;
    const MAX_PUBLIC_FINDING_REVIEWER_NOTES_LENGTH: usize = 1200;

    let finding = state
        .findings
        .iter()
        .find(|record| record.id == finding_id)
        .cloned()
        .ok_or_else(|| anyhow!("finding {finding_id} not found"))?;
    let now = utc_now();
    let public_summary = normalize_public_text(
        request.public_summary.as_deref(),
        MAX_PUBLIC_FINDING_SUMMARY_LENGTH,
    )
    .unwrap_or_else(|| default_public_finding_summary(&finding));
    let reviewer_notes = normalize_public_text(
        request.reviewer_notes.as_deref(),
        MAX_PUBLIC_FINDING_REVIEWER_NOTES_LENGTH,
    );

    if let Some(existing) = state
        .public_finding_moderation
        .iter_mut()
        .find(|record| record.finding_id == finding_id)
    {
        let was_published = existing.status == PublicFindingStatus::Published;
        existing.detector = finding.detector.clone();
        existing.severity = finding.severity.clone();
        existing.target_base_url = finding.target_base_url.clone();
        existing.path = finding.path.clone();
        existing.observed_at = finding.discovered_at;
        existing.public_summary = public_summary;
        existing.status = request.status;
        existing.reviewed_by = reviewed_by;
        existing.reviewer_notes = reviewer_notes;
        existing.reviewed_at = now;
        existing.updated_at = now;
        if existing.status == PublicFindingStatus::Published && !was_published {
            existing.published_at = Some(now);
        }
        return Ok(existing.clone());
    }

    let record = PublicFindingModerationRecord {
        finding_id,
        detector: finding.detector,
        severity: finding.severity,
        target_base_url: finding.target_base_url,
        path: finding.path,
        public_summary,
        status: request.status,
        reviewed_by,
        reviewer_notes,
        observed_at: finding.discovered_at,
        reviewed_at: now,
        published_at: (request.status == PublicFindingStatus::Published).then_some(now),
        updated_at: now,
    };
    state.public_finding_moderation.push(record.clone());
    Ok(record)
}

fn find_existing_finding_in_state(
    state: &DragonflyRuntimeState,
    finding: &NewFinding,
) -> Option<FindingRecord> {
    state
        .findings
        .iter()
        .find(|record| {
            record.run_id == finding.run_id
                && record.target_id == finding.target_id
                && record.fingerprint == finding.fingerprint
        })
        .cloned()
}

fn insert_finding_if_new_in_state(
    state: &mut DragonflyRuntimeState,
    finding: &NewFinding,
) -> Result<Option<FindingRecord>> {
    if find_existing_finding_in_state(state, finding).is_some() {
        return Ok(None);
    }

    let record = build_finding_record(state, finding)?;
    state.findings.push(record.clone());
    Ok(Some(record))
}

fn finish_job_in_state(
    state: &mut DragonflyRuntimeState,
    job_id: i64,
    findings_count: u64,
    telemetry: &FetchTelemetry,
    error: Option<&str>,
) -> Result<()> {
    let job = state
        .jobs
        .iter_mut()
        .find(|job| job.id == job_id)
        .ok_or_else(|| anyhow!("job {job_id} not found"))?;
    let run_id = job.run_id;
    job.status = if error.is_some() {
        JobStatus::Failed
    } else {
        JobStatus::Completed
    };
    job.completed_at = Some(utc_now());
    job.requests_count = telemetry.request_count;
    job.control_requests_count = telemetry.control_requests;
    job.documents_scanned_count = telemetry.documents_scanned;
    job.non_text_responses_count = telemetry.non_text_responses;
    job.truncated_responses_count = telemetry.truncated_responses;
    job.duplicate_responses_count = telemetry.duplicate_responses;
    job.control_match_responses_count = telemetry.control_match_responses;
    job.request_errors_count = telemetry.request_error_count;
    job.findings_count = findings_count;
    job.coverage_sources = telemetry.coverage_sources.clone();
    sort_coverage_source_stats(&mut job.coverage_sources);
    job.error = error.map(|value| value.to_string());
    state.job_claims.remove(&job_id);
    refresh_run_totals(state, run_id)?;
    Ok(())
}

fn merge_target_discovery_provenance_in_state(
    state: &mut DragonflyRuntimeState,
    target_id: i64,
    discovery_provenance: &[DiscoveryProvenanceRecord],
) -> Result<()> {
    let target = state
        .targets
        .iter_mut()
        .find(|target| target.id == target_id)
        .ok_or_else(|| anyhow!("target {target_id} not found"))?;
    let now = utc_now();
    let mut changed = false;

    for entry in discovery_provenance {
        if entry.path.trim().is_empty() {
            continue;
        }

        if let Some(existing) = target
            .discovery_provenance
            .iter_mut()
            .find(|existing| existing.path == entry.path)
        {
            let first_seen_at = existing.first_seen_at.or(entry.first_seen_at).or(Some(now));
            let prefer_incoming = entry.score > existing.score
                || (entry.score == existing.score && entry.depth < existing.depth);
            if prefer_incoming {
                if existing.source != entry.source {
                    existing.source = entry.source.clone();
                    changed = true;
                }
                if existing.score != entry.score {
                    existing.score = entry.score;
                    changed = true;
                }
                if existing.depth != entry.depth {
                    existing.depth = entry.depth;
                    changed = true;
                }
            }
            if existing.first_seen_at != first_seen_at {
                existing.first_seen_at = first_seen_at;
                changed = true;
            }
            if existing.last_seen_at != Some(now) {
                existing.last_seen_at = Some(now);
                changed = true;
            }
            continue;
        }

        target.discovery_provenance.push(DiscoveryProvenanceRecord {
            path: entry.path.clone(),
            source: entry.source.clone(),
            score: entry.score,
            depth: entry.depth,
            first_seen_at: entry.first_seen_at.or(Some(now)),
            last_seen_at: entry.last_seen_at.or(Some(now)),
        });
        changed = true;
    }

    if changed {
        sort_discovery_provenance(&mut target.discovery_provenance);
        target.updated_at = now;
    }

    Ok(())
}

fn sort_discovery_provenance(discovery_provenance: &mut Vec<DiscoveryProvenanceRecord>) {
    discovery_provenance.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.depth.cmp(&right.depth))
            .then_with(|| left.path.cmp(&right.path))
    });
}

fn sorted_targets(mut targets: Vec<TargetRecord>) -> Vec<TargetRecord> {
    targets.sort_by(|left, right| left.label.cmp(&right.label).then(left.id.cmp(&right.id)));
    targets
}

fn sorted_repositories(mut repositories: Vec<RepositoryRecord>) -> Vec<RepositoryRecord> {
    repositories.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    repositories
}

fn sorted_ownership_claims(mut claims: Vec<OwnershipClaimRecord>) -> Vec<OwnershipClaimRecord> {
    claims.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then(right.id.cmp(&left.id))
    });
    claims
}

fn sorted_opt_out_requests(mut records: Vec<OptOutRecord>) -> Vec<OptOutRecord> {
    records.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then(right.id.cmp(&left.id))
    });
    records
}

fn sorted_abuse_reports(mut reports: Vec<AbuseReportRecord>) -> Vec<AbuseReportRecord> {
    reports.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then(right.id.cmp(&left.id))
    });
    reports
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
}

fn normalize_required_text(value: &str, field_name: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("{field_name} is required"));
    }
    Ok(trimmed.to_string())
}

fn normalize_email_address(value: &str, field_name: &str) -> Result<String> {
    let email = normalize_required_text(value, field_name)?.to_ascii_lowercase();
    if email.contains(char::is_whitespace)
        || !email.contains('@')
        || email.starts_with('@')
        || email.ends_with('@')
    {
        return Err(anyhow!("{field_name} must be a valid email address"));
    }
    Ok(email)
}

fn normalize_domain_resource(value: &str) -> Result<String> {
    let normalized = value.trim().trim_end_matches('.').to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.contains('/')
        || normalized.contains(char::is_whitespace)
        || normalized.starts_with('.')
        || normalized.ends_with('.')
    {
        return Err(anyhow!("resource must be a valid domain or hostname"));
    }
    Ok(normalized)
}

fn normalize_cidr_resource(value: &str) -> Result<String> {
    let trimmed = value.trim();
    let (address, prefix) = trimmed
        .split_once('/')
        .ok_or_else(|| anyhow!("resource must be a valid CIDR"))?;
    let ip: IpAddr = address
        .parse()
        .with_context(|| format!("invalid CIDR base address {address}"))?;
    let prefix: u8 = prefix
        .parse()
        .with_context(|| format!("invalid CIDR prefix {prefix}"))?;
    let max_prefix = match ip {
        IpAddr::V4(_) => 32,
        IpAddr::V6(_) => 128,
    };
    if prefix > max_prefix {
        return Err(anyhow!("CIDR prefix {prefix} is outside the valid range"));
    }
    Ok(format!("{ip}/{prefix}"))
}

fn normalize_public_resource_identifier(kind: PublicResourceKind, value: &str) -> Result<String> {
    match kind {
        PublicResourceKind::Domain => normalize_domain_resource(value),
        PublicResourceKind::Ip => value
            .trim()
            .parse::<IpAddr>()
            .map(|ip| ip.to_string())
            .with_context(|| format!("invalid IP resource {}", value.trim())),
        PublicResourceKind::Cidr => normalize_cidr_resource(value),
    }
}

fn normalize_ownership_claim_request(
    request: &OwnershipClaimRequest,
) -> Result<OwnershipClaimRequest> {
    Ok(OwnershipClaimRequest {
        resource_kind: request.resource_kind,
        resource: normalize_public_resource_identifier(request.resource_kind, &request.resource)?,
        requester_name: normalize_required_text(&request.requester_name, "requester_name")?,
        requester_email: normalize_email_address(&request.requester_email, "requester_email")?,
        organization: normalize_optional_text(request.organization.clone()),
        verification_method: request.verification_method,
        verification_value: normalize_required_text(
            &request.verification_value,
            "verification_value",
        )?,
        notes: normalize_optional_text(request.notes.clone()),
    })
}

fn normalize_opt_out_request(request: &OptOutRequest) -> Result<OptOutRequest> {
    Ok(OptOutRequest {
        resource_kind: request.resource_kind,
        resource: normalize_public_resource_identifier(request.resource_kind, &request.resource)?,
        requester_name: normalize_required_text(&request.requester_name, "requester_name")?,
        requester_email: normalize_email_address(&request.requester_email, "requester_email")?,
        organization: normalize_optional_text(request.organization.clone()),
        verification_method: request.verification_method,
        verification_value: normalize_required_text(
            &request.verification_value,
            "verification_value",
        )?,
        justification: normalize_optional_text(request.justification.clone()),
    })
}

fn normalize_abuse_report_request(request: &AbuseReportRequest) -> Result<AbuseReportRequest> {
    Ok(AbuseReportRequest {
        requester_name: normalize_required_text(&request.requester_name, "requester_name")?,
        requester_email: normalize_email_address(&request.requester_email, "requester_email")?,
        organization: normalize_optional_text(request.organization.clone()),
        affected_resource: normalize_required_text(
            &request.affected_resource,
            "affected_resource",
        )?,
        reason: normalize_required_text(&request.reason, "reason")?,
        urgency: request.urgency.clone(),
        evidence: normalize_optional_text(request.evidence.clone()),
    })
}

fn normalize_public_workflow_status_update(
    update: &PublicWorkflowStatusUpdate,
) -> Result<PublicWorkflowStatusUpdate> {
    Ok(PublicWorkflowStatusUpdate {
        status: update.status,
        reviewer_notes: normalize_optional_text(update.reviewer_notes.clone()),
    })
}

fn normalize_optional_csv_field(value: Option<String>) -> Option<String> {
    value
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
}

fn normalize_bin_key(value: &str) -> String {
    let digits = value
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect::<String>();
    if digits.len() < 6 {
        return String::new();
    }
    digits[..6].to_string()
}

fn bin_metadata_record_from_row(row: BinCsvRow) -> Option<BinMetadataRecord> {
    let bin = normalize_bin_key(&row.bin);
    if bin.is_empty() {
        return None;
    }

    Some(BinMetadataRecord {
        bin,
        brand: normalize_optional_csv_field(row.brand),
        card_type: normalize_optional_csv_field(row.card_type),
        category: normalize_optional_csv_field(row.category),
        issuer: normalize_optional_csv_field(row.issuer),
        issuer_phone: normalize_optional_csv_field(row.issuer_phone),
        issuer_url: normalize_optional_csv_field(row.issuer_url),
        iso_code2: normalize_optional_csv_field(row.iso_code2),
        iso_code3: normalize_optional_csv_field(row.iso_code3),
        country_name: normalize_optional_csv_field(row.country_name),
    })
}

fn load_bin_dataset_records_from_csv(path: &Path) -> Result<Vec<BinMetadataRecord>> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to open BIN dataset CSV {}", path.display()))?;
    let mut lines = raw.lines();
    let header_line = lines
        .next()
        .ok_or_else(|| anyhow!("BIN dataset CSV {} is empty", path.display()))?;
    let headers = parse_csv_line(header_line);
    let header_index = build_csv_header_index(&headers);
    ensure_required_bin_csv_headers(&header_index)?;
    let mut records = Vec::new();
    let mut seen = HashSet::new();

    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let row = parse_bin_csv_row(line, &header_index);
        let Some(record) = bin_metadata_record_from_row(row) else {
            continue;
        };
        if !seen.insert(record.bin.clone()) {
            continue;
        }
        records.push(record);
    }

    records.sort_by(|left, right| left.bin.cmp(&right.bin));
    Ok(records)
}

fn resolve_bin_dataset_csv_path(base_path: &Path, csv_path: Option<&str>) -> PathBuf {
    match csv_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        Some(path) if path.is_absolute() => path,
        Some(path) => base_path.join(path),
        None => base_path.join("bin-list-data.csv"),
    }
}

fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(character) = chars.next() {
        match character {
            '"' => {
                if in_quotes && matches!(chars.peek(), Some('"')) {
                    current.push('"');
                    let _ = chars.next();
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ',' if !in_quotes => {
                fields.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(character),
        }
    }
    fields.push(current.trim().to_string());
    fields
}

fn build_csv_header_index(headers: &[String]) -> HashMap<String, usize> {
    let mut index = HashMap::new();
    for (position, header) in headers.iter().enumerate() {
        let key = header.trim().to_ascii_lowercase();
        if !key.is_empty() {
            index.insert(key, position);
        }
    }
    index
}

fn ensure_required_bin_csv_headers(header_index: &HashMap<String, usize>) -> Result<()> {
    if !header_index.contains_key("bin") {
        return Err(anyhow!("BIN dataset CSV is missing required BIN header"));
    }
    Ok(())
}

fn csv_value_at(
    columns: &[String],
    header_index: &HashMap<String, usize>,
    key: &str,
) -> Option<String> {
    let index = header_index.get(&key.to_ascii_lowercase()).copied()?;
    columns
        .get(index)
        .map(|value| value.trim().trim_matches('"').to_string())
        .filter(|value| !value.is_empty())
}

fn parse_bin_csv_row(line: &str, header_index: &HashMap<String, usize>) -> BinCsvRow {
    let columns = parse_csv_line(line);
    BinCsvRow {
        bin: csv_value_at(&columns, header_index, "BIN").unwrap_or_default(),
        brand: csv_value_at(&columns, header_index, "Brand"),
        card_type: csv_value_at(&columns, header_index, "Type"),
        category: csv_value_at(&columns, header_index, "Category"),
        issuer: csv_value_at(&columns, header_index, "Issuer"),
        issuer_phone: csv_value_at(&columns, header_index, "IssuerPhone"),
        issuer_url: csv_value_at(&columns, header_index, "IssuerUrl"),
        iso_code2: csv_value_at(&columns, header_index, "isoCode2"),
        iso_code3: csv_value_at(&columns, header_index, "isoCode3"),
        country_name: csv_value_at(&columns, header_index, "CountryName"),
    }
}

fn stream_entry_id(event_id: i64) -> String {
    format!("{event_id}-0")
}

fn parse_stream_event_id(stream_id: &str) -> Result<i64> {
    stream_id
        .split_once('-')
        .map(|(prefix, _)| prefix)
        .unwrap_or(stream_id)
        .parse::<i64>()
        .with_context(|| format!("invalid Dragonfly stream event id {stream_id}"))
}

fn stored_event_from_stream_entry(entry: redis::streams::StreamId) -> Result<StoredEvent> {
    let payload_json = entry
        .get::<String>("payload_json")
        .ok_or_else(|| anyhow!("Dragonfly event {} missing payload_json field", entry.id))?;
    let created_at_raw = entry
        .get::<String>("created_at")
        .ok_or_else(|| anyhow!("Dragonfly event {} missing created_at field", entry.id))?;
    let run_id = match entry.get::<String>("run_id") {
        Some(value) if !value.is_empty() => Some(
            value
                .parse::<i64>()
                .with_context(|| format!("invalid run_id in Dragonfly event {}", entry.id))?,
        ),
        _ => None,
    };

    Ok(StoredEvent {
        id: parse_stream_event_id(&entry.id)?,
        run_id,
        payload: serde_json::from_str::<ApiEvent>(&payload_json)
            .with_context(|| format!("failed to deserialize Dragonfly event {}", entry.id))?,
        created_at: DateTime::parse_from_rfc3339(&created_at_raw)
            .with_context(|| format!("invalid created_at in Dragonfly event {}", entry.id))?
            .with_timezone(&Utc),
    })
}

fn is_stream_id_conflict_error(error: &anyhow::Error) -> bool {
    error.to_string().contains("equal or smaller")
}

fn enabled_targets(state: &DragonflyRuntimeState) -> Vec<TargetRecord> {
    state
        .targets
        .iter()
        .filter(|target| target.enabled)
        .cloned()
        .collect()
}

fn filter_targets_by_scope(
    state: &DragonflyRuntimeState,
    targets: Vec<TargetRecord>,
    scope: Option<&RunScope>,
) -> Vec<TargetRecord> {
    let Some(scope) = scope else {
        return targets;
    };

    let failed_target_ids = scope.failed_only.then(|| latest_failed_target_ids(state));

    targets
        .into_iter()
        .filter(|target| target_matches_scope(target, scope, failed_target_ids.as_ref()))
        .collect()
}

fn latest_failed_target_ids(state: &DragonflyRuntimeState) -> HashSet<i64> {
    let mut latest_jobs_by_target = BTreeMap::new();
    for job in state
        .jobs
        .iter()
        .filter(|job| matches!(job.status, JobStatus::Completed | JobStatus::Failed))
    {
        let failed = matches!(job.status, JobStatus::Failed);
        latest_jobs_by_target
            .entry(job.target.id)
            .and_modify(|entry: &mut (i64, bool)| {
                if job.id > entry.0 {
                    *entry = (job.id, failed);
                }
            })
            .or_insert((job.id, failed));
    }

    latest_jobs_by_target
        .into_iter()
        .filter_map(|(target_id, (_, failed))| failed.then_some(target_id))
        .collect()
}

fn target_matches_scope(
    target: &TargetRecord,
    scope: &RunScope,
    failed_target_ids: Option<&HashSet<i64>>,
) -> bool {
    let explicit_matches = if scope.target_ids.is_empty() && scope.tags.is_empty() {
        true
    } else {
        scope.target_ids.contains(&target.id)
            || target
                .tags
                .iter()
                .any(|tag| scope.tags.iter().any(|scope_tag| scope_tag == tag))
    };

    if !explicit_matches {
        return false;
    }

    if !scope.failed_only {
        return true;
    }

    failed_target_ids
        .map(|target_ids| target_ids.contains(&target.id))
        .unwrap_or(false)
}

fn create_run(
    state: &mut DragonflyRuntimeState,
    schedule_id: Option<i64>,
    requested_by: Option<String>,
    scope: Option<RunScope>,
    targets: &[TargetRecord],
    now: DateTime<Utc>,
) -> ScanRunRecord {
    let run = ScanRunRecord {
        id: state.next_run_id(),
        requested_by,
        scope,
        status: RunStatus::Queued,
        started_at: now,
        completed_at: None,
        total_targets: targets.len() as u64,
        completed_targets: 0,
        requests_total: 0,
        control_requests_total: 0,
        documents_scanned_total: 0,
        non_text_responses_total: 0,
        truncated_responses_total: 0,
        duplicate_responses_total: 0,
        control_match_responses_total: 0,
        request_errors_total: 0,
        findings_total: 0,
        errors_total: 0,
        notes: None,
    };
    state.runs.push(StoredRun {
        schedule_id,
        run: run.clone(),
        claimed_by: None,
        claim_expires_at: None,
    });
    run
}

fn create_jobs_for_run(state: &mut DragonflyRuntimeState, run_id: i64, targets: &[TargetRecord]) {
    for target in targets {
        let job_id = state.next_job_id();
        state.jobs.push(ScanJobRecord {
            id: job_id,
            run_id,
            target: target.clone(),
            status: JobStatus::Pending,
            started_at: None,
            completed_at: None,
            requests_count: 0,
            control_requests_count: 0,
            documents_scanned_count: 0,
            non_text_responses_count: 0,
            truncated_responses_count: 0,
            duplicate_responses_count: 0,
            control_match_responses_count: 0,
            request_errors_count: 0,
            findings_count: 0,
            coverage_sources: Vec::new(),
            error: None,
        });
    }
}

fn has_runnable_jobs(state: &DragonflyRuntimeState, run_id: i64) -> bool {
    state.jobs.iter().any(|job| {
        job.run_id == run_id && matches!(job.status, JobStatus::Pending | JobStatus::InProgress)
    })
}

fn has_claimable_jobs(state: &DragonflyRuntimeState, run_id: i64, now: DateTime<Utc>) -> bool {
    state.jobs.iter().any(|job| {
        job.run_id == run_id
            && (matches!(job.status, JobStatus::Pending)
                || (matches!(job.status, JobStatus::InProgress)
                    && !job_claim_is_active(state, job.id, now)))
    })
}

fn requeue_in_progress_jobs_in_state(state: &mut DragonflyRuntimeState, run_id: i64) -> Result<()> {
    let now = utc_now();
    let released_job_ids = state
        .jobs
        .iter()
        .filter(|job| {
            job.run_id == run_id
                && matches!(job.status, JobStatus::InProgress)
                && !job_claim_is_active(state, job.id, now)
        })
        .map(|job| job.id)
        .collect::<Vec<_>>();
    if released_job_ids.is_empty() {
        return Ok(());
    }

    for job_id in &released_job_ids {
        let job = state
            .jobs
            .iter_mut()
            .find(|job| job.id == *job_id)
            .ok_or_else(|| anyhow!("job {job_id} not found during Dragonfly recovery"))?;
        job.status = JobStatus::Pending;
        job.started_at = None;
        job.completed_at = None;
        job.error = None;
    }
    for job_id in released_job_ids {
        state.job_claims.remove(&job_id);
    }
    refresh_run_totals(state, run_id)?;
    Ok(())
}

fn claim_next_pending_job_in_state(
    state: &mut DragonflyRuntimeState,
    run_id: i64,
    worker_id: &str,
    now: DateTime<Utc>,
    lease_seconds: u64,
) -> Result<Option<ScanJobRecord>> {
    let pending_job_id = state
        .jobs
        .iter()
        .filter(|job| {
            job.run_id == run_id
                && matches!(job.status, JobStatus::Pending)
                && !job_claim_is_active(state, job.id, now)
        })
        .map(|job| job.id)
        .min();
    let abandoned_job_id = state
        .jobs
        .iter()
        .filter(|job| {
            job.run_id == run_id
                && matches!(job.status, JobStatus::InProgress)
                && !job_claim_is_active(state, job.id, now)
        })
        .map(|job| job.id)
        .min();
    let job_id = pending_job_id.or(abandoned_job_id);

    let Some(job_id) = job_id else {
        return Ok(None);
    };

    let claim_expires_at = lease_expires_at(now, lease_seconds)?;
    let job = state
        .jobs
        .iter_mut()
        .find(|job| job.id == job_id)
        .ok_or_else(|| anyhow!("job {job_id} not found during Dragonfly claim"))?;
    job.status = JobStatus::InProgress;
    job.started_at = Some(now);
    job.completed_at = None;
    job.error = None;
    state.job_claims.insert(
        job_id,
        StoredJobClaim {
            claimed_by: worker_id.to_string(),
            claim_expires_at,
        },
    );
    Ok(Some(job.clone()))
}

fn claim_next_runnable_run_in_state(
    state: &mut DragonflyRuntimeState,
    worker_id: &str,
    now: DateTime<Utc>,
    lease_seconds: u64,
) -> Result<Option<ScanRunRecord>> {
    if !worker_allows_new_runs(state, worker_id, now) {
        return Ok(None);
    }

    let run_id = state
        .runs
        .iter()
        .filter(|run| {
            matches!(run.run.status, RunStatus::Queued | RunStatus::InProgress)
                && has_runnable_jobs(state, run.run.id)
                && !run_claim_is_active(run, now)
        })
        .map(|run| run.run.id)
        .min();

    let Some(run_id) = run_id else {
        return Ok(None);
    };

    let lease_expires_at = lease_expires_at(now, lease_seconds)?;
    let run = state
        .runs
        .iter_mut()
        .find(|run| run.run.id == run_id)
        .ok_or_else(|| anyhow!("run {run_id} not found during Dragonfly claim"))?;
    run.claimed_by = Some(worker_id.to_string());
    run.claim_expires_at = Some(lease_expires_at);
    Ok(Some(run.run.clone()))
}

fn run_claim_is_active(run: &StoredRun, now: DateTime<Utc>) -> bool {
    run.claimed_by.is_some()
        && run
            .claim_expires_at
            .is_some_and(|expires_at| expires_at > now)
}

fn port_scan_claim_is_active(port_scan: &StoredPortScan, now: DateTime<Utc>) -> bool {
    port_scan.claimed_by.is_some()
        && port_scan
            .claim_expires_at
            .is_some_and(|expires_at| expires_at > now)
}

fn job_claim_is_active(state: &DragonflyRuntimeState, job_id: i64, now: DateTime<Utc>) -> bool {
    state
        .job_claims
        .get(&job_id)
        .is_some_and(|claim| claim.claim_expires_at > now)
}

fn clear_run_claim(run: &mut StoredRun) {
    run.claimed_by = None;
    run.claim_expires_at = None;
}

fn clear_port_scan_claim(port_scan: &mut StoredPortScan) {
    port_scan.claimed_by = None;
    port_scan.claim_expires_at = None;
}

fn normalize_worker_values(values: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let candidate = value.trim().to_ascii_lowercase();
        if !candidate.is_empty() && !normalized.contains(&candidate) {
            normalized.push(candidate);
        }
    }
    normalized
}

fn active_worker_records(workers: &[WorkerRecord], now: DateTime<Utc>) -> Vec<WorkerRecord> {
    workers
        .iter()
        .filter(|worker| worker.expires_at > now)
        .cloned()
        .collect()
}

fn lease_expires_at(now: DateTime<Utc>, lease_seconds: u64) -> Result<DateTime<Utc>> {
    let lease_seconds =
        i64::try_from(lease_seconds).context("run lease exceeds supported range")?;
    Ok(now + ChronoDuration::seconds(lease_seconds))
}

fn has_active_run_for_schedule(state: &DragonflyRuntimeState, schedule_id: i64) -> bool {
    state.runs.iter().any(|run| {
        run.schedule_id == Some(schedule_id)
            && matches!(run.run.status, RunStatus::Queued | RunStatus::InProgress)
    })
}

fn get_run_record(state: &DragonflyRuntimeState, run_id: i64) -> Result<ScanRunRecord> {
    state
        .runs
        .iter()
        .find(|run| run.run.id == run_id)
        .map(|run| run.run.clone())
        .ok_or_else(|| anyhow!("run {run_id} not found"))
}

fn refresh_run_totals(state: &mut DragonflyRuntimeState, run_id: i64) -> Result<()> {
    let jobs = state
        .jobs
        .iter()
        .filter(|job| job.run_id == run_id)
        .cloned()
        .collect::<Vec<_>>();
    let run = state
        .runs
        .iter_mut()
        .find(|run| run.run.id == run_id)
        .ok_or_else(|| anyhow!("run {run_id} not found"))?;
    run.run.total_targets = jobs.len() as u64;
    run.run.completed_targets = jobs
        .iter()
        .filter(|job| matches!(job.status, JobStatus::Completed | JobStatus::Failed))
        .count() as u64;
    run.run.requests_total = jobs.iter().map(|job| job.requests_count).sum();
    run.run.control_requests_total = jobs.iter().map(|job| job.control_requests_count).sum();
    run.run.documents_scanned_total = jobs.iter().map(|job| job.documents_scanned_count).sum();
    run.run.non_text_responses_total = jobs.iter().map(|job| job.non_text_responses_count).sum();
    run.run.truncated_responses_total = jobs.iter().map(|job| job.truncated_responses_count).sum();
    run.run.duplicate_responses_total = jobs.iter().map(|job| job.duplicate_responses_count).sum();
    run.run.control_match_responses_total = jobs
        .iter()
        .map(|job| job.control_match_responses_count)
        .sum();
    run.run.request_errors_total = jobs.iter().map(|job| job.request_errors_count).sum();
    run.run.findings_total = jobs.iter().map(|job| job.findings_count).sum();
    run.run.errors_total = jobs
        .iter()
        .filter(|job| matches!(job.status, JobStatus::Failed))
        .count() as u64;
    Ok(())
}

fn compute_run_summary(state: &DragonflyRuntimeState, run_id: i64) -> Result<RunSummary> {
    let run = state
        .runs
        .iter()
        .find(|run| run.run.id == run_id)
        .map(|run| run.run.clone())
        .ok_or_else(|| anyhow!("run {run_id} not found"))?;
    let jobs = state
        .jobs
        .iter()
        .filter(|job| job.run_id == run_id)
        .cloned()
        .collect::<Vec<_>>();
    let pending_targets = jobs
        .iter()
        .filter(|job| matches!(job.status, JobStatus::Pending))
        .count() as u64;
    let in_progress_targets = jobs
        .iter()
        .filter(|job| matches!(job.status, JobStatus::InProgress))
        .count() as u64;
    let succeeded_targets = jobs
        .iter()
        .filter(|job| matches!(job.status, JobStatus::Completed))
        .count() as u64;
    let failed_targets = jobs
        .iter()
        .filter(|job| matches!(job.status, JobStatus::Failed))
        .count() as u64;
    let mut last_activity_at = Some(run.started_at);
    if let Some(completed_at) = run.completed_at {
        last_activity_at =
            Some(last_activity_at.map_or(completed_at, |value| value.max(completed_at)));
    }
    for job in &jobs {
        if let Some(started_at) = job.started_at {
            last_activity_at =
                Some(last_activity_at.map_or(started_at, |value| value.max(started_at)));
        }
        if let Some(completed_at) = job.completed_at {
            last_activity_at =
                Some(last_activity_at.map_or(completed_at, |value| value.max(completed_at)));
        }
    }
    for finding in state
        .findings
        .iter()
        .filter(|finding| finding.run_id == run_id)
    {
        last_activity_at = Some(last_activity_at.map_or(finding.discovered_at, |value| {
            value.max(finding.discovered_at)
        }));
    }

    let mut coverage_sources = Vec::new();
    for job in &jobs {
        merge_coverage_source_stats(&mut coverage_sources, &job.coverage_sources);
    }
    sort_coverage_source_stats(&mut coverage_sources);

    Ok(RunSummary {
        run_id: run.id,
        status: run.status.clone(),
        total_targets: run.total_targets,
        completed_targets: run.completed_targets,
        requests_total: run.requests_total,
        control_requests_total: run.control_requests_total,
        documents_scanned_total: run.documents_scanned_total,
        non_text_responses_total: run.non_text_responses_total,
        truncated_responses_total: run.truncated_responses_total,
        duplicate_responses_total: run.duplicate_responses_total,
        control_match_responses_total: run.control_match_responses_total,
        request_errors_total: run.request_errors_total,
        findings_total: run.findings_total,
        errors_total: run.errors_total,
        coverage_sources,
        started_at: Some(run.started_at),
        completed_at: run.completed_at,
        progress: RunProgressSnapshot {
            pending_targets,
            in_progress_targets,
            succeeded_targets,
            failed_targets,
            last_activity_at,
            elapsed_seconds: Some(
                run.completed_at
                    .unwrap_or_else(utc_now)
                    .signed_duration_since(run.started_at)
                    .num_seconds()
                    .max(0) as u64,
            ),
        },
    })
}

fn list_failed_targets(
    state: &DragonflyRuntimeState,
    run_id: i64,
    limit: usize,
) -> Result<Vec<FailedTargetRecord>> {
    let mut failed_targets = state
        .jobs
        .iter()
        .filter(|job| job.run_id == run_id && matches!(job.status, JobStatus::Failed))
        .map(|job| FailedTargetRecord {
            job_id: job.id,
            target_id: job.target.id,
            target_label: job.target.label.clone(),
            target_base_url: job.target.base_url.clone(),
            requests_count: job.requests_count,
            findings_count: job.findings_count,
            error: job
                .error
                .clone()
                .unwrap_or_else(|| "job failed".to_string()),
            started_at: job.started_at,
            completed_at: job.completed_at,
        })
        .collect::<Vec<_>>();
    failed_targets.sort_by(|left, right| {
        let left_activity = left
            .completed_at
            .or(left.started_at)
            .unwrap_or_else(utc_now);
        let right_activity = right
            .completed_at
            .or(right.started_at)
            .unwrap_or_else(utc_now);
        right_activity
            .cmp(&left_activity)
            .then(right.job_id.cmp(&left.job_id))
    });
    failed_targets.truncate(limit);
    Ok(failed_targets)
}

fn detector_distribution(
    state: &DragonflyRuntimeState,
    run_id: i64,
    limit: usize,
) -> Result<Vec<DetectorFindingStat>> {
    let mut grouped: BTreeMap<(String, String), (u64, HashSet<i64>)> = BTreeMap::new();
    for finding in state
        .findings
        .iter()
        .filter(|finding| finding.run_id == run_id)
    {
        let key = (
            finding.detector.clone(),
            finding.severity.as_str().to_string(),
        );
        let entry = grouped.entry(key).or_insert_with(|| (0, HashSet::new()));
        entry.0 += 1;
        entry.1.insert(finding.target_id);
    }
    let mut values = grouped
        .into_iter()
        .map(
            |((detector, severity), (findings_total, affected_targets))| -> Result<_> {
                Ok(DetectorFindingStat {
                    detector,
                    severity: severity
                        .parse::<Severity>()
                        .map_err(|error| anyhow!(error))?,
                    findings_total,
                    affected_targets: affected_targets.len() as u64,
                })
            },
        )
        .collect::<Result<Vec<_>>>()?;
    values.sort_by(|left, right| {
        right
            .findings_total
            .cmp(&left.findings_total)
            .then(left.detector.cmp(&right.detector))
    });
    values.truncate(limit);
    Ok(values)
}

fn materialize_schedule(
    mut schedule: RecurringScheduleRecord,
    state: &DragonflyRuntimeState,
) -> RecurringScheduleRecord {
    let Some(run_id) = schedule.last_queued_run_id else {
        schedule.last_queued_run_status = None;
        schedule.last_queued_run_started_at = None;
        schedule.last_queued_run_completed_at = None;
        return schedule;
    };
    if let Some(run) = state.runs.iter().find(|run| run.run.id == run_id) {
        schedule.last_queued_run_status = Some(run.run.status.clone());
        schedule.last_queued_run_started_at = Some(run.run.started_at);
        schedule.last_queued_run_completed_at = run.run.completed_at;
    } else {
        schedule.last_queued_run_status = None;
        schedule.last_queued_run_started_at = None;
        schedule.last_queued_run_completed_at = None;
    }
    schedule
}

fn schedule_next_run_at(now: DateTime<Utc>, interval_seconds: u64) -> Result<DateTime<Utc>> {
    let interval_seconds = i64::try_from(interval_seconds)
        .context("schedule interval_seconds exceeds supported range")?;
    Ok(now + ChronoDuration::seconds(interval_seconds))
}

#[cfg(test)]
mod tests {
    use super::{
        DragonflyAnyScanStore, DragonflyRuntimeState, StoredJobClaim, build_redis_connection_url,
        claim_next_pending_job_in_state, insert_finding_if_new_in_state, lease_expires_at,
        occupied_namespace_keys, requeue_in_progress_jobs_in_state,
    };
    use crate::{
        config::{AppConfig, StorageConfig},
        core::{
            CoverageSourceStat, FetchTelemetry, FindingRecord, FindingsQuery, JobStatus,
            PublicFindingModerationRequest, PublicFindingSearchQuery, PublicFindingStatus,
            RunScope, RunStatus, ScanJobRecord, ScanRunRecord, Severity, TargetDefinition,
            TargetRecord, TargetStrategy, WorkerBootstrapCandidateRecord,
            WorkerBootstrapCandidateStatus, WorkerEnrollmentTokenRecord, WorkerLifecycleState,
            WorkerRecord,
        },
    };
    use anyhow::{Context, Result};
    use chrono::{Duration as ChronoDuration, Utc};

    use redis::Commands;
    use std::{
        env, fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_live_test_prefix(name: &str) -> String {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("anyscan:test:{name}:{timestamp}:")
    }

    struct LiveDragonflyTestContext {
        config: AppConfig,
        config_path: PathBuf,
    }

    impl LiveDragonflyTestContext {
        fn load(name: &str) -> Result<Self> {
            let env_path = env::var("ANYSCAN_LIVE_ANYGPT_API_ENV_FILE")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .parent()
                        .expect("anyscan crate should live under apps/")
                        .join("api")
                        .join(".env")
                });
            if !env_path.exists() {
                return Err(anyhow::anyhow!(
                    "live Dragonfly test requires AnyGPT API env file at {}",
                    env_path.display()
                ));
            }

            let redis_key_prefix = unique_live_test_prefix(name);
            let config_path = env::temp_dir().join(format!(
                "anyscan-live-{name}-{}.toml",
                redis_key_prefix.replace(':', "-")
            ));
            fs::write(
                &config_path,
                format!(
                    "[storage]\nanygpt_api_env_path = {:?}\nredis_key_prefix = {:?}\nredis_startup_wait = false\nredis_startup_timeout_seconds = 3\n",
                    env_path.to_string_lossy(),
                    redis_key_prefix,
                ),
            )
            .with_context(|| {
                format!(
                    "failed to write live Dragonfly test config {}",
                    config_path.display()
                )
            })?;

            let config = AppConfig::load(Some(&config_path))?;
            let context = Self {
                config,
                config_path,
            };
            context.cleanup_namespace()?;
            Ok(context)
        }

        fn cleanup_namespace(&self) -> Result<()> {
            let mut connection = self.redis_connection()?;
            let keys: Vec<String> = connection
                .keys(format!("{}*", self.config.storage.redis_key_prefix))
                .context("failed to query live Dragonfly namespace keys for cleanup")?;
            if keys.is_empty() {
                return Ok(());
            }
            let _: usize = connection
                .del(keys)
                .context("failed to clean up live Dragonfly test namespace")?;
            Ok(())
        }

        fn namespace_keys(&self) -> Result<Vec<String>> {
            let mut connection = self.redis_connection()?;
            let mut keys: Vec<String> = connection
                .keys(format!("{}*", self.config.storage.redis_key_prefix))
                .context("failed to query live Dragonfly namespace keys")?;
            keys.sort();
            Ok(keys)
        }

        fn redis_connection(&self) -> Result<redis::Connection> {
            let connection_url = build_redis_connection_url(&self.config.storage)?;
            let client = redis::Client::open(connection_url.as_str())
                .context("failed to construct live Dragonfly redis client")?;
            client
                .get_connection()
                .context("failed to connect to live Dragonfly test store")
        }
    }

    impl Drop for LiveDragonflyTestContext {
        fn drop(&mut self) {
            let _ = self.cleanup_namespace();
            let _ = fs::remove_file(&self.config_path);
        }
    }

    #[test]
    fn host_port_connection_url_requires_credentials() {
        let storage = StorageConfig {
            redis_url: Some("127.0.0.1:6380".to_string()),
            ..StorageConfig::default()
        };
        let error =
            build_redis_connection_url(&storage).expect_err("credentials should be required");
        assert!(
            error
                .to_string()
                .contains("REDIS_USERNAME is required when REDIS_URL is host:port")
        );
    }

    #[test]
    fn host_port_connection_url_reuses_anygpt_api_style_env_contract() {
        let storage = StorageConfig {
            redis_url: Some("127.0.0.1:6380".to_string()),
            redis_username: Some("default".to_string()),
            redis_password: Some("secret".to_string()),
            redis_db: 1,
            ..StorageConfig::default()
        };
        let url = build_redis_connection_url(&storage).expect("connection URL should build");
        assert_eq!(url, "redis://default:secret@127.0.0.1:6380/1");
    }

    #[test]
    fn full_url_connection_respects_existing_path() {
        let storage = StorageConfig {
            redis_url: Some("redis://127.0.0.1:6380/2".to_string()),
            redis_tls: true,
            ..StorageConfig::default()
        };
        let url = build_redis_connection_url(&storage).expect("full URL should build");
        assert_eq!(url, "rediss://127.0.0.1:6380/2");
    }

    #[test]
    fn write_operations_check_store_availability_before_mutation() {
        let mut config = AppConfig::default();
        config.storage.redis_url = Some("redis://127.0.0.1:1/2".to_string());
        config.storage.redis_startup_wait = false;

        let store = DragonflyAnyScanStore::from_config(&config)
            .expect("Dragonfly store config should build");
        let error = store
            .upsert_target(&TargetDefinition {
                label: "Local test target".to_string(),
                base_url: "http://localhost:8080".to_string(),
                strategy: TargetStrategy::Hybrid,
                paths: vec!["/.env".to_string()],
                tags: vec!["test".to_string()],
                request_profile: None,
                gobuster: Default::default(),
            })
            .expect_err("unavailable Dragonfly should fail before mutating state");
        assert!(
            error
                .to_string()
                .contains("Dragonfly store is unavailable before writing runtime state")
        );
    }

    #[test]
    fn namespace_bootstrap_guard_ignores_lock_key() {
        let occupied = occupied_namespace_keys(
            vec!["anyscan:runtime_lock".to_string()],
            "anyscan:runtime_lock",
        );
        assert!(occupied.is_empty());
    }

    #[test]
    fn namespace_bootstrap_guard_detects_non_lock_keys() {
        let occupied = occupied_namespace_keys(
            vec![
                "anyscan:runtime_lock".to_string(),
                "anyscan:run_events".to_string(),
                "anyscan:run_events_seq".to_string(),
            ],
            "anyscan:runtime_lock",
        );
        assert_eq!(
            occupied,
            vec![
                "anyscan:run_events".to_string(),
                "anyscan:run_events_seq".to_string(),
            ]
        );
    }

    fn sample_target_definition(label: &str, base_url: &str) -> TargetDefinition {
        TargetDefinition {
            label: label.to_string(),
            base_url: base_url.to_string(),
            strategy: TargetStrategy::Hybrid,
            paths: vec!["/.env".to_string()],
            tags: vec!["test".to_string(), "dragonfly".to_string()],
            request_profile: None,
            gobuster: Default::default(),
        }
    }

    #[test]
    #[ignore = "requires live Dragonfly access via AnyGPT API .env"]
    fn live_store_inherits_anygpt_api_env_credentials_into_isolated_namespace() -> Result<()> {
        let context = LiveDragonflyTestContext::load("inherit")?;
        assert!(context.config.storage.redis_url.is_some());
        assert!(context.config.storage.redis_username.is_some());
        assert!(context.config.storage.redis_password.is_some());
        assert!(
            context
                .config
                .storage
                .redis_key_prefix
                .starts_with("anyscan:test:inherit:")
        );

        let store = DragonflyAnyScanStore::from_config(&context.config)?;
        store.initialize()?;
        let created = store.upsert_target(&sample_target_definition(
            "live-dragonfly-inherit",
            "https://live-dragonfly-inherit.example.com",
        ))?;
        let targets = store.list_targets()?;
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].id, created.id);
        assert_eq!(
            targets[0].base_url,
            "https://live-dragonfly-inherit.example.com"
        );

        let keys = context.namespace_keys()?;
        assert!(!keys.is_empty());
        assert!(
            keys.iter()
                .all(|key| key.starts_with(&context.config.storage.redis_key_prefix))
        );
        Ok(())
    }

    #[test]
    #[ignore = "requires live Dragonfly access via AnyGPT API .env"]
    fn live_stores_with_distinct_key_prefixes_remain_isolated() -> Result<()> {
        let primary = LiveDragonflyTestContext::load("isolated-a")?;
        let secondary = LiveDragonflyTestContext::load("isolated-b")?;
        let primary_store = DragonflyAnyScanStore::from_config(&primary.config)?;
        let secondary_store = DragonflyAnyScanStore::from_config(&secondary.config)?;

        primary_store.initialize()?;
        secondary_store.initialize()?;
        primary_store.upsert_target(&sample_target_definition(
            "live-dragonfly-primary",
            "https://live-dragonfly-primary.example.com",
        ))?;

        assert_eq!(primary_store.list_targets()?.len(), 1);
        assert!(secondary_store.list_targets()?.is_empty());

        let primary_keys = primary.namespace_keys()?;
        let secondary_keys = secondary.namespace_keys()?;
        assert!(!primary_keys.is_empty());
        assert!(!secondary_keys.is_empty());
        assert!(
            primary_keys
                .iter()
                .all(|key| key.starts_with(&primary.config.storage.redis_key_prefix))
        );
        assert!(
            secondary_keys
                .iter()
                .all(|key| key.starts_with(&secondary.config.storage.redis_key_prefix))
        );
        assert_ne!(
            primary.config.storage.redis_key_prefix,
            secondary.config.storage.redis_key_prefix
        );
        assert!(
            primary_keys
                .iter()
                .all(|key| !key.starts_with(&secondary.config.storage.redis_key_prefix))
        );
        assert!(
            secondary_keys
                .iter()
                .all(|key| !key.starts_with(&primary.config.storage.redis_key_prefix))
        );
        Ok(())
    }

    fn sample_target(id: i64) -> TargetRecord {
        let now = Utc::now();
        TargetRecord {
            id,
            label: format!("target-{id}"),
            base_url: format!("https://target-{id}.example.com"),
            strategy: TargetStrategy::Hybrid,
            paths: vec!["/.env".to_string()],
            tags: vec!["test".to_string()],
            request_profile: None,
            gobuster: Default::default(),
            discovery_provenance: Vec::new(),
            enabled: true,
            created_at: now,
            updated_at: now,
        }
    }

    fn sample_job(id: i64, run_id: i64, status: JobStatus) -> ScanJobRecord {
        ScanJobRecord {
            id,
            run_id,
            target: sample_target(id),
            status,
            started_at: None,
            completed_at: None,
            requests_count: 0,
            control_requests_count: 0,
            documents_scanned_count: 0,
            non_text_responses_count: 0,
            truncated_responses_count: 0,
            duplicate_responses_count: 0,
            control_match_responses_count: 0,
            request_errors_count: 0,
            findings_count: 0,
            coverage_sources: Vec::new(),
            error: None,
        }
    }

    fn sample_finding(id: i64, run_id: i64, target: &TargetRecord) -> FindingRecord {
        FindingRecord {
            id,
            run_id,
            target_id: target.id,
            target_label: target.label.clone(),
            target_base_url: target.base_url.clone(),
            target_strategy: target.strategy,
            discovery_provenance: None,
            detector: "github_pat".to_string(),
            severity: Severity::Critical,
            path: "/admin/config.json".to_string(),
            redacted_value: "ghp_****prod".to_string(),
            evidence: "prod admin token".to_string(),
            fingerprint: format!("public-fp-{id}"),
            discovered_at: Utc::now(),
        }
    }

    fn sample_run(run_id: i64) -> super::StoredRun {
        let now = Utc::now();
        super::StoredRun {
            schedule_id: None,
            run: ScanRunRecord {
                id: run_id,
                requested_by: Some("test".to_string()),
                scope: None,
                status: RunStatus::InProgress,
                started_at: now,
                completed_at: None,
                total_targets: 0,
                completed_targets: 0,
                requests_total: 0,
                control_requests_total: 0,
                documents_scanned_total: 0,
                non_text_responses_total: 0,
                truncated_responses_total: 0,
                duplicate_responses_total: 0,
                control_match_responses_total: 0,
                request_errors_total: 0,
                findings_total: 0,
                errors_total: 0,
                notes: None,
            },
            claimed_by: None,
            claim_expires_at: None,
        }
    }

    fn sample_worker(
        worker_id: &str,
        worker_pool: &str,
        lifecycle_state: WorkerLifecycleState,
        expires_at: chrono::DateTime<Utc>,
    ) -> WorkerRecord {
        let registered_at = expires_at - ChronoDuration::seconds(60);
        WorkerRecord {
            worker_id: worker_id.to_string(),
            display_name: Some(worker_id.to_string()),
            worker_pool: Some(worker_pool.to_string()),
            tags: vec!["test".to_string()],
            supports_runs: true,
            supports_port_scans: true,
            supports_bootstrap: false,
            scanner_adapters: Vec::new(),
            provisioners: Vec::new(),
            lifecycle_state,
            enrollment_token_id: None,
            registered_at,
            last_seen_at: registered_at,
            expires_at,
        }
    }

    #[test]
    fn compute_worker_pool_records_aggregates_worker_state_and_pending_work() {
        let now = Utc::now();
        let mut state = DragonflyRuntimeState::default();
        state.workers.push(sample_worker(
            "edge-1",
            "edge",
            WorkerLifecycleState::Active,
            now + ChronoDuration::seconds(30),
        ));
        state.workers.push(sample_worker(
            "edge-2",
            "edge",
            WorkerLifecycleState::Draining,
            now - ChronoDuration::seconds(5),
        ));
        state.workers.push(sample_worker(
            "core-1",
            "core",
            WorkerLifecycleState::Disabled,
            now + ChronoDuration::seconds(30),
        ));
        state
            .worker_enrollment_tokens
            .push(super::StoredWorkerEnrollmentToken {
                record: WorkerEnrollmentTokenRecord {
                    id: 1,
                    label: "edge join".to_string(),
                    worker_pool: Some("edge".to_string()),
                    tags: vec!["edge".to_string()],
                    allow_runs: true,
                    allow_port_scans: true,
                    allow_bootstrap: false,
                    single_use: false,
                    created_by: Some("admin".to_string()),
                    created_at: now,
                    expires_at: Some(now + ChronoDuration::seconds(300)),
                    revoked_at: None,
                    used_by_worker_id: None,
                    used_at: None,
                },
                token_hash: "hash".to_string(),
                token_value: None,
            });
        state
            .bootstrap_candidates
            .push(WorkerBootstrapCandidateRecord {
                id: 1,
                port_scan_id: 10,
                requested_by: Some("admin".to_string()),
                discovered_host: "10.0.0.10".to_string(),
                discovered_port: Some(443),
                worker_pool: Some("edge".to_string()),
                tags: vec!["edge".to_string()],
                status: WorkerBootstrapCandidateStatus::PendingApproval,
                approved_by: None,
                enrollment_token_id: None,
                worker_id: None,
                notes: None,
                created_at: now,
                updated_at: now,
            });
        state.port_scans.push(super::StoredPortScan {
            port_scan: crate::core::PortScanRecord {
                id: 1,
                requested_by: Some("admin".to_string()),
                target_range: "10.0.0.0/24".to_string(),
                ports: "80,443".to_string(),
                schemes: Default::default(),
                tags: vec!["edge".to_string()],
                rate_limit: 100,
                worker_pool: Some("edge".to_string()),
                bootstrap_policy: Default::default(),
                status: RunStatus::Queued,
                started_at: now,
                completed_at: None,
                discovered_endpoints_total: 0,
                imported_targets_total: 0,
                bootstrap_candidates_total: 0,
                queued_run_id: None,
                notes: None,
            },
            claimed_by: None,
            claim_expires_at: None,
        });
        state.port_scans.push(super::StoredPortScan {
            port_scan: crate::core::PortScanRecord {
                id: 2,
                requested_by: Some("admin".to_string()),
                target_range: "10.0.1.0/24".to_string(),
                ports: "8443".to_string(),
                schemes: Default::default(),
                tags: vec!["edge".to_string()],
                rate_limit: 100,
                worker_pool: Some("edge".to_string()),
                bootstrap_policy: Default::default(),
                status: RunStatus::InProgress,
                started_at: now,
                completed_at: None,
                discovered_endpoints_total: 0,
                imported_targets_total: 0,
                bootstrap_candidates_total: 0,
                queued_run_id: None,
                notes: None,
            },
            claimed_by: Some("edge-1".to_string()),
            claim_expires_at: Some(now + ChronoDuration::seconds(60)),
        });

        let pools = super::compute_worker_pool_records(&state, now);
        assert_eq!(pools.len(), 2);

        let edge = pools
            .iter()
            .find(|pool| pool.name == "edge")
            .expect("edge pool should be present");
        assert_eq!(edge.total_workers, 2);
        assert_eq!(edge.online_workers, 1);
        assert_eq!(edge.active_workers, 1);
        assert_eq!(edge.draining_workers, 1);
        assert_eq!(edge.active_enrollment_tokens, 1);
        assert_eq!(edge.pending_bootstrap_candidates, 1);
        assert_eq!(edge.queued_port_scans, 1);
        assert_eq!(edge.in_progress_port_scans, 1);

        let core = pools
            .iter()
            .find(|pool| pool.name == "core")
            .expect("core pool should be present");
        assert_eq!(core.total_workers, 1);
        assert_eq!(core.disabled_workers, 1);
    }

    #[test]
    fn create_run_preserves_scope_and_schedule_id() {
        let now = Utc::now();
        let mut state = DragonflyRuntimeState::default();
        let target = sample_target(7);
        let scope = RunScope {
            target_ids: vec![target.id],
            tags: vec!["test".to_string()],
            failed_only: false,
        };

        let run = super::create_run(
            &mut state,
            Some(12),
            Some("tester".to_string()),
            Some(scope.clone()),
            &[target],
            now,
        );

        assert_eq!(run.scope, Some(scope));
        assert_eq!(run.total_targets, 1);
        assert_eq!(state.runs.len(), 1);
        assert_eq!(state.runs[0].schedule_id, Some(12));
        assert_eq!(state.runs[0].run.id, run.id);
    }

    #[test]
    fn filter_targets_by_scope_honors_tags_and_failed_only() {
        let now = Utc::now();
        let mut state = DragonflyRuntimeState::default();
        let mut local = sample_target(1);
        local.tags = vec!["local".to_string()];
        let mut worker = sample_target(2);
        worker.tags = vec!["worker".to_string()];
        state.targets.push(local.clone());
        state.targets.push(worker.clone());
        state.jobs.push(ScanJobRecord {
            id: 1,
            run_id: 77,
            target: worker.clone(),
            status: JobStatus::Failed,
            started_at: Some(now),
            completed_at: Some(now),
            requests_count: 0,
            control_requests_count: 0,
            documents_scanned_count: 0,
            non_text_responses_count: 0,
            truncated_responses_count: 0,
            duplicate_responses_count: 0,
            control_match_responses_count: 0,
            request_errors_count: 0,
            findings_count: 0,
            coverage_sources: Vec::new(),
            error: Some("timeout".to_string()),
        });

        let filtered = super::filter_targets_by_scope(
            &state,
            vec![local, worker.clone()],
            Some(&RunScope {
                target_ids: Vec::new(),
                tags: vec!["worker".to_string()],
                failed_only: true,
            }),
        );

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, worker.id);
    }

    #[test]
    fn search_findings_filters_and_ranks_state_results() {
        let now = Utc::now();
        let mut state = DragonflyRuntimeState::default();
        let mut prod = sample_target(7);
        prod.tags = vec!["prod".to_string(), "edge".to_string()];
        let mut internal = sample_target(8);
        internal.tags = vec!["internal".to_string()];
        state.targets.push(prod.clone());
        state.targets.push(internal.clone());
        state.findings.push(FindingRecord {
            id: 1,
            run_id: 77,
            target_id: internal.id,
            target_label: internal.label.clone(),
            target_base_url: internal.base_url.clone(),
            target_strategy: internal.strategy,
            discovery_provenance: None,
            detector: "aws_access_key".to_string(),
            severity: Severity::High,
            path: "/internal/config.json".to_string(),
            redacted_value: "AKIA****INT".to_string(),
            evidence: "internal worker config".to_string(),
            fingerprint: "search-fp-1".to_string(),
            discovered_at: now,
        });
        state.findings.push(FindingRecord {
            id: 2,
            run_id: 77,
            target_id: prod.id,
            target_label: prod.label.clone(),
            target_base_url: prod.base_url.clone(),
            target_strategy: prod.strategy,
            discovery_provenance: None,
            detector: "github_pat".to_string(),
            severity: Severity::Critical,
            path: "/admin/config.json".to_string(),
            redacted_value: "ghp_****prod".to_string(),
            evidence: "prod admin token".to_string(),
            fingerprint: "search-fp-2".to_string(),
            discovered_at: now,
        });
        state.findings.push(FindingRecord {
            id: 3,
            run_id: 77,
            target_id: prod.id,
            target_label: prod.label.clone(),
            target_base_url: prod.base_url.clone(),
            target_strategy: prod.strategy,
            discovery_provenance: None,
            detector: "stripe_live".to_string(),
            severity: Severity::High,
            path: "/billing.js".to_string(),
            redacted_value: "sk_l****1234".to_string(),
            evidence: "prod billing bundle".to_string(),
            fingerprint: "search-fp-3".to_string(),
            discovered_at: now,
        });

        let filtered = super::DragonflyAnyScanStore::search_findings_in_state(
            &state,
            &FindingsQuery {
                limit: Some(5),
                severity: Some(Severity::Critical),
                detector: Some(" GitHub_PAT ".to_string()),
                path_prefix: Some("admin".to_string()),
                tags: vec![" PROD ".to_string()],
                q: Some("prod admin".to_string()),
                ..FindingsQuery::default()
            },
        );
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, 2);
        assert_eq!(filtered[0].target_id, prod.id);

        let cursor_results = super::DragonflyAnyScanStore::search_findings_in_state(
            &state,
            &FindingsQuery {
                cursor: Some(2),
                limit: Some(10),
                ..FindingsQuery::default()
            },
        );
        assert_eq!(
            cursor_results
                .iter()
                .map(|finding| finding.id)
                .collect::<Vec<_>>(),
            vec![1]
        );
    }

    #[test]
    fn compute_run_summary_aggregates_coverage_sources() -> Result<()> {
        let mut state = DragonflyRuntimeState::default();
        state.runs.push(sample_run(42));
        state.jobs.push(sample_job(1, 42, JobStatus::Pending));
        state.jobs.push(sample_job(2, 42, JobStatus::Pending));

        let telemetry_a = FetchTelemetry {
            request_count: 2,
            documents_scanned: 2,
            coverage_sources: vec![
                CoverageSourceStat {
                    source: "target-seed".to_string(),
                    queued_paths: 1,
                    requested_paths: 1,
                    documents_scanned: 1,
                    discovered_paths: 0,
                    findings_count: 1,
                },
                CoverageSourceStat {
                    source: "html-link".to_string(),
                    queued_paths: 1,
                    requested_paths: 1,
                    documents_scanned: 1,
                    discovered_paths: 1,
                    findings_count: 0,
                },
            ],
            ..FetchTelemetry::default()
        };
        super::finish_job_in_state(&mut state, 1, 1, &telemetry_a, None)?;

        let telemetry_b = FetchTelemetry {
            request_count: 1,
            documents_scanned: 1,
            request_error_count: 1,
            coverage_sources: vec![
                CoverageSourceStat {
                    source: "target-seed".to_string(),
                    queued_paths: 1,
                    requested_paths: 1,
                    documents_scanned: 0,
                    discovered_paths: 0,
                    findings_count: 0,
                },
                CoverageSourceStat {
                    source: "source-map-hint".to_string(),
                    queued_paths: 1,
                    requested_paths: 1,
                    documents_scanned: 1,
                    discovered_paths: 1,
                    findings_count: 2,
                },
            ],
            ..FetchTelemetry::default()
        };
        super::finish_job_in_state(&mut state, 2, 2, &telemetry_b, Some("timeout"))?;

        assert_eq!(state.jobs[0].coverage_sources, telemetry_a.coverage_sources);
        assert_eq!(
            state.jobs[1].coverage_sources.len(),
            telemetry_b.coverage_sources.len()
        );
        assert!(
            state.jobs[1]
                .coverage_sources
                .iter()
                .any(|entry| entry.source == "target-seed" && entry.requested_paths == 1)
        );
        assert!(
            state.jobs[1]
                .coverage_sources
                .iter()
                .any(|entry| entry.source == "source-map-hint" && entry.findings_count == 2)
        );

        let summary = super::compute_run_summary(&state, 42)?;
        assert_eq!(summary.requests_total, 3);
        assert_eq!(summary.documents_scanned_total, 3);
        assert_eq!(summary.findings_total, 3);
        assert_eq!(summary.request_errors_total, 1);
        assert_eq!(summary.errors_total, 1);
        assert_eq!(summary.coverage_sources.len(), 3);

        let target_seed = summary
            .coverage_sources
            .iter()
            .find(|entry| entry.source == "target-seed")
            .expect("target-seed coverage source should be aggregated");
        assert_eq!(target_seed.queued_paths, 2);
        assert_eq!(target_seed.requested_paths, 2);
        assert_eq!(target_seed.documents_scanned, 1);
        assert_eq!(target_seed.findings_count, 1);

        let html_link = summary
            .coverage_sources
            .iter()
            .find(|entry| entry.source == "html-link")
            .expect("html-link coverage source should be aggregated");
        assert_eq!(html_link.queued_paths, 1);
        assert_eq!(html_link.requested_paths, 1);
        assert_eq!(html_link.documents_scanned, 1);
        assert_eq!(html_link.discovered_paths, 1);

        let source_map = summary
            .coverage_sources
            .iter()
            .find(|entry| entry.source == "source-map-hint")
            .expect("source-map-hint coverage source should be aggregated");
        assert_eq!(source_map.queued_paths, 1);
        assert_eq!(source_map.requested_paths, 1);
        assert_eq!(source_map.documents_scanned, 1);
        assert_eq!(source_map.discovered_paths, 1);
        assert_eq!(source_map.findings_count, 2);
        Ok(())
    }

    #[test]
    fn claim_next_pending_job_skips_active_claims() -> Result<()> {
        let now = Utc::now();
        let mut state = DragonflyRuntimeState::default();
        state.jobs.push(sample_job(1, 42, JobStatus::Pending));
        state.jobs.push(sample_job(2, 42, JobStatus::Pending));
        state.job_claims.insert(
            1,
            StoredJobClaim {
                claimed_by: "worker-a".to_string(),
                claim_expires_at: now + ChronoDuration::seconds(60),
            },
        );

        let claimed = claim_next_pending_job_in_state(&mut state, 42, "worker-b", now, 60)?
            .expect("expected a claimable job");

        assert_eq!(claimed.id, 2);
        assert!(matches!(claimed.status, JobStatus::InProgress));
        assert_eq!(
            state
                .job_claims
                .get(&2)
                .map(|claim| claim.claimed_by.as_str()),
            Some("worker-b")
        );
        assert!(matches!(state.jobs[0].status, JobStatus::Pending));
        Ok(())
    }

    #[test]
    fn record_finding_if_new_skips_duplicate_fingerprint() -> Result<()> {
        let mut state = DragonflyRuntimeState::default();
        state.targets.push(sample_target(7));
        let finding = crate::core::NewFinding {
            run_id: 42,
            target_id: 7,
            detector: "dotenv".to_string(),
            severity: crate::core::Severity::High,
            path: "/.env".to_string(),
            redacted_value: "sk-****1234".to_string(),
            evidence: "sk-test-1234".to_string(),
            fingerprint: "fingerprint-1".to_string(),
        };

        let first = insert_finding_if_new_in_state(&mut state, &finding)?;
        let duplicate = insert_finding_if_new_in_state(&mut state, &finding)?;

        assert!(first.is_some());
        assert!(duplicate.is_none());
        assert_eq!(state.findings.len(), 1);
        Ok(())
    }

    #[test]
    fn claim_next_pending_job_recovers_expired_in_progress_job() -> Result<()> {
        let now = Utc::now();
        let mut state = DragonflyRuntimeState::default();
        state.jobs.push(sample_job(1, 42, JobStatus::InProgress));
        state.job_claims.insert(
            1,
            StoredJobClaim {
                claimed_by: "worker-a".to_string(),
                claim_expires_at: now - ChronoDuration::seconds(1),
            },
        );

        let claimed = claim_next_pending_job_in_state(&mut state, 42, "worker-b", now, 60)?
            .expect("expected expired in-progress job to be reclaimed");

        assert_eq!(claimed.id, 1);
        assert!(matches!(claimed.status, JobStatus::InProgress));
        assert_eq!(claimed.started_at, Some(now));
        assert_eq!(
            state
                .job_claims
                .get(&1)
                .map(|claim| claim.claimed_by.as_str()),
            Some("worker-b")
        );
        Ok(())
    }

    #[test]
    fn requeue_in_progress_jobs_only_resets_abandoned_jobs() -> Result<()> {
        let now = Utc::now();
        let mut state = DragonflyRuntimeState::default();
        state.runs.push(sample_run(42));
        state.jobs.push(sample_job(1, 42, JobStatus::InProgress));
        state.jobs.push(sample_job(2, 42, JobStatus::InProgress));
        state.job_claims.insert(
            1,
            StoredJobClaim {
                claimed_by: "worker-a".to_string(),
                claim_expires_at: now + ChronoDuration::seconds(60),
            },
        );
        state.job_claims.insert(
            2,
            StoredJobClaim {
                claimed_by: "worker-b".to_string(),
                claim_expires_at: now - ChronoDuration::seconds(1),
            },
        );

        requeue_in_progress_jobs_in_state(&mut state, 42)?;

        assert!(matches!(state.jobs[0].status, JobStatus::InProgress));
        assert!(state.job_claims.contains_key(&1));
        assert!(matches!(state.jobs[1].status, JobStatus::Pending));
        assert!(!state.job_claims.contains_key(&2));
        Ok(())
    }

    #[test]
    fn public_finding_moderation_controls_public_search_visibility() -> Result<()> {
        let mut state = DragonflyRuntimeState::default();
        let target = sample_target(9);
        let finding = sample_finding(1, 77, &target);
        state.targets.push(target);
        state.findings.push(finding.clone());

        let published = super::upsert_public_finding_moderation_in_state(
            &mut state,
            finding.id,
            Some("analyst-a".to_string()),
            &PublicFindingModerationRequest {
                status: PublicFindingStatus::Published,
                public_summary: Some("  Public admin token exposure  ".to_string()),
                reviewer_notes: Some("  Coordinate disclosure with owner.  ".to_string()),
            },
        )?;
        let first_published_at = published
            .published_at
            .expect("published findings should record a publication timestamp");
        assert_eq!(published.reviewed_by.as_deref(), Some("analyst-a"));
        assert_eq!(published.public_summary, "Public admin token exposure");
        assert_eq!(
            published.reviewer_notes.as_deref(),
            Some("Coordinate disclosure with owner.")
        );

        let visible = DragonflyAnyScanStore::search_public_findings_in_state(
            &state,
            &PublicFindingSearchQuery {
                limit: Some(10),
                detector: Some(" GitHub_PAT ".to_string()),
                path_prefix: Some("admin".to_string()),
                q: Some(" public admin ".to_string()),
                ..PublicFindingSearchQuery::default()
            },
        );
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].finding_id, finding.id);
        assert_eq!(visible[0].summary, "Public admin token exposure");

        let suppressed = super::upsert_public_finding_moderation_in_state(
            &mut state,
            finding.id,
            Some("analyst-b".to_string()),
            &PublicFindingModerationRequest {
                status: PublicFindingStatus::Suppressed,
                public_summary: Some("Suppressed from disclosure".to_string()),
                reviewer_notes: Some("Owner already remediated.".to_string()),
            },
        )?;
        assert_eq!(suppressed.status, PublicFindingStatus::Suppressed);
        assert_eq!(suppressed.reviewed_by.as_deref(), Some("analyst-b"));
        assert_eq!(
            suppressed.reviewer_notes.as_deref(),
            Some("Owner already remediated.")
        );
        assert_eq!(suppressed.published_at, Some(first_published_at));

        let hidden = DragonflyAnyScanStore::search_public_findings_in_state(
            &state,
            &PublicFindingSearchQuery::default(),
        );
        assert!(hidden.is_empty());
        Ok(())
    }

    #[test]
    fn public_finding_moderation_clears_reviewer_notes_and_restores_default_summary() -> Result<()>
    {
        let mut state = DragonflyRuntimeState::default();
        let target = sample_target(10);
        let finding = sample_finding(2, 88, &target);
        state.targets.push(target);
        state.findings.push(finding.clone());

        super::upsert_public_finding_moderation_in_state(
            &mut state,
            finding.id,
            Some("analyst-a".to_string()),
            &PublicFindingModerationRequest {
                status: PublicFindingStatus::Published,
                public_summary: Some("Custom summary".to_string()),
                reviewer_notes: Some("Private context".to_string()),
            },
        )?;

        let updated = super::upsert_public_finding_moderation_in_state(
            &mut state,
            finding.id,
            Some("analyst-c".to_string()),
            &PublicFindingModerationRequest {
                status: PublicFindingStatus::Published,
                public_summary: Some("   ".to_string()),
                reviewer_notes: Some("   ".to_string()),
            },
        )?;

        assert_eq!(updated.reviewed_by.as_deref(), Some("analyst-c"));
        assert_eq!(updated.reviewer_notes, None);
        assert_eq!(
            updated.public_summary,
            super::default_public_finding_summary(&finding)
        );
        assert!(updated.published_at.is_some());
        Ok(())
    }

    #[test]
    fn lease_expires_at_advances_timestamp() -> Result<()> {
        let now = Utc::now();
        let expires_at = lease_expires_at(now, 30)?;
        assert_eq!(expires_at, now + ChronoDuration::seconds(30));
        Ok(())
    }
}

use std::{collections::HashMap, path::Path};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const DEFAULT_FINDINGS_QUERY_LIMIT: usize = 50;
pub const MAX_FINDINGS_QUERY_LIMIT: usize = 250;
const DEFAULT_PUBLIC_FINDINGS_QUERY_LIMIT: usize = 20;
const MAX_PUBLIC_FINDINGS_QUERY_LIMIT: usize = 100;
pub const DEFAULT_BIN_LOOKUP_LIMIT: usize = 100;
pub const MAX_BIN_LOOKUP_LIMIT: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Low,
    Medium,
    High,
    Critical,
}

impl Severity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Low => "low",
            Severity::Medium => "medium",
            Severity::High => "high",
            Severity::Critical => "critical",
        }
    }
}

impl Default for Severity {
    fn default() -> Self {
        Self::Low
    }
}

impl std::str::FromStr for Severity {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "info" => Ok(Self::Info),
            "low" => Ok(Self::Low),
            "medium" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            "critical" => Ok(Self::Critical),
            other => Err(format!("unknown severity: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    InProgress,
    Completed,
    Failed,
}

impl RunStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::InProgress => "in_progress",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
        }
    }
}

impl Default for RunStatus {
    fn default() -> Self {
        Self::Queued
    }
}

impl std::str::FromStr for RunStatus {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "queued" => Ok(Self::Queued),
            "in_progress" => Ok(Self::InProgress),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            other => Err(format!("unknown run status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

impl JobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobStatus::Pending => "pending",
            JobStatus::InProgress => "in_progress",
            JobStatus::Completed => "completed",
            JobStatus::Failed => "failed",
        }
    }
}

impl Default for JobStatus {
    fn default() -> Self {
        Self::Pending
    }
}

impl std::str::FromStr for JobStatus {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "pending" => Ok(Self::Pending),
            "in_progress" => Ok(Self::InProgress),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            other => Err(format!("unknown job status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum OperatorRole {
    Admin,
    Analyst,
    Operator,
    Viewer,
    Automation,
}

impl OperatorRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            OperatorRole::Admin => "admin",
            OperatorRole::Analyst => "analyst",
            OperatorRole::Operator => "operator",
            OperatorRole::Viewer => "viewer",
            OperatorRole::Automation => "automation",
        }
    }

    pub fn can_write(&self) -> bool {
        !matches!(self, OperatorRole::Viewer)
    }

    pub fn can_manage_settings(&self) -> bool {
        matches!(self, OperatorRole::Admin)
    }

    pub fn can_manage_operators(&self) -> bool {
        matches!(self, OperatorRole::Admin)
    }

    pub fn can_manage_workers(&self) -> bool {
        matches!(self, OperatorRole::Admin | OperatorRole::Automation)
    }

    pub fn can_approve_bootstrap_candidates(&self) -> bool {
        matches!(self, OperatorRole::Admin | OperatorRole::Automation)
    }

    pub fn can_moderate_public_findings(&self) -> bool {
        matches!(self, OperatorRole::Admin | OperatorRole::Analyst)
    }
}

impl Default for OperatorRole {
    fn default() -> Self {
        Self::Admin
    }
}

impl std::str::FromStr for OperatorRole {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "admin" => Ok(Self::Admin),
            "analyst" => Ok(Self::Analyst),
            "operator" => Ok(Self::Operator),
            "viewer" => Ok(Self::Viewer),
            "automation" => Ok(Self::Automation),
            other => Err(format!("unknown operator role: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OperatorRecord {
    pub username: String,
    #[serde(default)]
    pub role: OperatorRole,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TargetStrategy {
    Manual,
    Hybrid,
    Auto,
}

impl TargetStrategy {
    pub fn as_str(&self) -> &'static str {
        match self {
            TargetStrategy::Manual => "manual",
            TargetStrategy::Hybrid => "hybrid",
            TargetStrategy::Auto => "auto",
        }
    }

    pub fn allows_live_discovery(&self) -> bool {
        !matches!(self, TargetStrategy::Manual)
    }

    pub fn uses_persisted_discovery(&self) -> bool {
        matches!(self, TargetStrategy::Auto)
    }
}

impl Default for TargetStrategy {
    fn default() -> Self {
        Self::Hybrid
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct RunScope {
    #[serde(default)]
    pub target_ids: Vec<i64>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub failed_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct DiscoveryProvenanceRecord {
    pub path: String,
    pub source: String,
    pub score: u16,
    pub depth: u8,
    #[serde(default)]
    pub first_seen_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct GobusterTargetConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub wordlist: Vec<String>,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub add_slash: bool,
    #[serde(default)]
    pub discover_backup: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct TargetDefinition {
    pub label: String,
    pub base_url: String,
    #[serde(default)]
    pub strategy: TargetStrategy,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub request_profile: Option<String>,
    #[serde(default)]
    pub gobuster: GobusterTargetConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct RepositoryDefinition {
    pub name: String,
    pub github_url: String,
    pub local_path: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub related_target_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TargetRecord {
    pub id: i64,
    pub label: String,
    pub base_url: String,
    #[serde(default)]
    pub strategy: TargetStrategy,
    pub paths: Vec<String>,
    pub tags: Vec<String>,
    #[serde(default)]
    pub request_profile: Option<String>,
    #[serde(default)]
    pub gobuster: GobusterTargetConfig,
    #[serde(default)]
    pub discovery_provenance: Vec<DiscoveryProvenanceRecord>,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepositoryRecord {
    pub id: i64,
    pub name: String,
    pub github_url: String,
    pub local_path: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub related_target_ids: Vec<i64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PublicResourceKind {
    Domain,
    Ip,
    Cidr,
}

impl Default for PublicResourceKind {
    fn default() -> Self {
        Self::Domain
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerificationMethod {
    DnsTxt,
    Email,
    HttpFile,
    ManualReview,
}

impl Default for VerificationMethod {
    fn default() -> Self {
        Self::DnsTxt
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PublicWorkflowStatus {
    Submitted,
    UnderReview,
    Verified,
    Completed,
    Rejected,
}

impl Default for PublicWorkflowStatus {
    fn default() -> Self {
        Self::Submitted
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct OwnershipClaimRequest {
    #[serde(default)]
    pub resource_kind: PublicResourceKind,
    pub resource: String,
    pub requester_name: String,
    pub requester_email: String,
    #[serde(default)]
    pub organization: Option<String>,
    #[serde(default)]
    pub verification_method: VerificationMethod,
    pub verification_value: String,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OwnershipClaimRecord {
    pub id: i64,
    pub resource_kind: PublicResourceKind,
    pub resource: String,
    pub requester_name: String,
    pub requester_email: String,
    #[serde(default)]
    pub organization: Option<String>,
    pub verification_method: VerificationMethod,
    pub verification_value: String,
    #[serde(default)]
    pub notes: Option<String>,
    pub status: PublicWorkflowStatus,
    #[serde(default)]
    pub reviewer_notes: Option<String>,
    #[serde(default)]
    pub verification_summary: Option<String>,
    #[serde(default)]
    pub verification_attempted_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub verification_completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct OptOutRequest {
    #[serde(default)]
    pub resource_kind: PublicResourceKind,
    pub resource: String,
    pub requester_name: String,
    pub requester_email: String,
    #[serde(default)]
    pub organization: Option<String>,
    #[serde(default)]
    pub verification_method: VerificationMethod,
    pub verification_value: String,
    #[serde(default)]
    pub justification: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OptOutRecord {
    pub id: i64,
    pub resource_kind: PublicResourceKind,
    pub resource: String,
    pub requester_name: String,
    pub requester_email: String,
    #[serde(default)]
    pub organization: Option<String>,
    pub verification_method: VerificationMethod,
    pub verification_value: String,
    #[serde(default)]
    pub justification: Option<String>,
    pub status: PublicWorkflowStatus,
    #[serde(default)]
    pub reviewer_notes: Option<String>,
    #[serde(default)]
    pub verification_summary: Option<String>,
    #[serde(default)]
    pub verification_attempted_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub verification_completed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct AbuseReportRequest {
    pub requester_name: String,
    pub requester_email: String,
    #[serde(default)]
    pub organization: Option<String>,
    pub affected_resource: String,
    pub reason: String,
    #[serde(default)]
    pub urgency: Severity,
    #[serde(default)]
    pub evidence: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AbuseReportRecord {
    pub id: i64,
    pub requester_name: String,
    pub requester_email: String,
    #[serde(default)]
    pub organization: Option<String>,
    pub affected_resource: String,
    pub reason: String,
    pub urgency: Severity,
    #[serde(default)]
    pub evidence: Option<String>,
    pub status: PublicWorkflowStatus,
    #[serde(default)]
    pub reviewer_notes: Option<String>,
    #[serde(default)]
    pub resolved_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct PublicWorkflowStatusUpdate {
    #[serde(default)]
    pub status: PublicWorkflowStatus,
    #[serde(default)]
    pub reviewer_notes: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PublicWorkflowKind {
    OwnershipClaim,
    OptOut,
    AbuseReport,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PublicFindingStatus {
    Published,
    Suppressed,
}

impl Default for PublicFindingStatus {
    fn default() -> Self {
        Self::Published
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct PublicFindingModerationRequest {
    #[serde(default)]
    pub status: PublicFindingStatus,
    #[serde(default)]
    pub public_summary: Option<String>,
    #[serde(default)]
    pub reviewer_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicFindingModerationRecord {
    pub finding_id: i64,
    pub detector: String,
    pub severity: Severity,
    pub target_base_url: String,
    pub path: String,
    pub public_summary: String,
    pub status: PublicFindingStatus,
    #[serde(default)]
    pub reviewed_by: Option<String>,
    #[serde(default)]
    pub reviewer_notes: Option<String>,
    pub observed_at: DateTime<Utc>,
    pub reviewed_at: DateTime<Utc>,
    #[serde(default)]
    pub published_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicFindingRecord {
    pub finding_id: i64,
    pub detector: String,
    pub severity: Severity,
    pub target_base_url: String,
    pub path: String,
    pub summary: String,
    pub observed_at: DateTime<Utc>,
    pub published_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct PublicFindingSearchQuery {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub severity: Option<Severity>,
    #[serde(default)]
    pub detector: Option<String>,
    #[serde(default)]
    pub path_prefix: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum WorkerLifecycleState {
    Active,
    Draining,
    Disabled,
    Revoked,
}

impl WorkerLifecycleState {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkerLifecycleState::Active => "active",
            WorkerLifecycleState::Draining => "draining",
            WorkerLifecycleState::Disabled => "disabled",
            WorkerLifecycleState::Revoked => "revoked",
        }
    }

    pub fn allows_new_work(&self) -> bool {
        matches!(self, WorkerLifecycleState::Active)
    }

    pub fn accepts_heartbeats(&self) -> bool {
        !matches!(self, WorkerLifecycleState::Revoked)
    }
}

impl Default for WorkerLifecycleState {
    fn default() -> Self {
        Self::Active
    }
}

impl std::str::FromStr for WorkerLifecycleState {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "active" => Ok(Self::Active),
            "draining" => Ok(Self::Draining),
            "disabled" => Ok(Self::Disabled),
            "revoked" => Ok(Self::Revoked),
            other => Err(format!("unknown worker lifecycle state: {other}")),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerRegistration {
    pub worker_id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub worker_pool: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub supports_runs: bool,
    #[serde(default)]
    pub supports_port_scans: bool,
    #[serde(default)]
    pub supports_bootstrap: bool,
    #[serde(default)]
    pub scanner_adapters: Vec<String>,
    #[serde(default)]
    pub provisioners: Vec<String>,
    #[serde(default)]
    pub enrollment_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerRecord {
    pub worker_id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub worker_pool: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub supports_runs: bool,
    #[serde(default)]
    pub supports_port_scans: bool,
    #[serde(default)]
    pub supports_bootstrap: bool,
    #[serde(default)]
    pub scanner_adapters: Vec<String>,
    #[serde(default)]
    pub provisioners: Vec<String>,
    #[serde(default)]
    pub lifecycle_state: WorkerLifecycleState,
    #[serde(default)]
    pub enrollment_token_id: Option<i64>,
    pub registered_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerPoolRecord {
    pub name: String,
    #[serde(default)]
    pub total_workers: u64,
    #[serde(default)]
    pub online_workers: u64,
    #[serde(default)]
    pub active_workers: u64,
    #[serde(default)]
    pub draining_workers: u64,
    #[serde(default)]
    pub disabled_workers: u64,
    #[serde(default)]
    pub revoked_workers: u64,
    #[serde(default)]
    pub active_enrollment_tokens: u64,
    #[serde(default)]
    pub pending_bootstrap_candidates: u64,
    #[serde(default)]
    pub queued_bootstrap_jobs: u64,
    #[serde(default)]
    pub in_progress_bootstrap_jobs: u64,
    #[serde(default)]
    pub queued_port_scans: u64,
    #[serde(default)]
    pub in_progress_port_scans: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerEnrollmentTokenRecord {
    pub id: i64,
    pub label: String,
    #[serde(default)]
    pub worker_pool: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub allow_runs: bool,
    #[serde(default)]
    pub allow_port_scans: bool,
    #[serde(default)]
    pub allow_bootstrap: bool,
    #[serde(default)]
    pub single_use: bool,
    pub created_by: Option<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub revoked_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub used_by_worker_id: Option<String>,
    #[serde(default)]
    pub used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerEnrollmentTokenIssued {
    pub record: WorkerEnrollmentTokenRecord,
    pub token: String,
}

pub type WorkerEnrollmentTokenRequest = WorkerEnrollmentTokenIssueRequest;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerBootstrapCandidateRequest {
    pub discovered_host: String,
    #[serde(default)]
    pub discovered_port: Option<u16>,
    #[serde(default)]
    pub worker_pool: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerBootstrapDispatchRequest {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub provisioner: Option<String>,
    #[serde(default)]
    pub executor_worker_pool: Option<String>,
    #[serde(default)]
    pub executor_tags: Vec<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

impl WorkerBootstrapDispatchRequest {
    pub fn is_enabled(&self) -> bool {
        self.enabled
            || self
                .provisioner
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerBootstrapCandidateApprovalRequest {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub worker_pool: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub allow_runs: Option<bool>,
    #[serde(default)]
    pub allow_port_scans: Option<bool>,
    #[serde(default)]
    pub allow_bootstrap: Option<bool>,
    #[serde(default)]
    pub single_use: Option<bool>,
    #[serde(default)]
    pub expires_in_seconds: Option<u64>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub dispatch: WorkerBootstrapDispatchRequest,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerBootstrapCandidateRejectionRequest {
    #[serde(default)]
    pub notes: Option<String>,
}

pub type WorkerBootstrapCandidateApprovalOutcome = WorkerBootstrapCandidateApproval;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkerBootstrapCandidateStatus {
    PendingApproval,
    Approved,
    Rejected,
    Registered,
    Failed,
}

impl Default for WorkerBootstrapCandidateStatus {
    fn default() -> Self {
        Self::PendingApproval
    }
}

impl WorkerBootstrapCandidateStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkerBootstrapCandidateStatus::PendingApproval => "pending_approval",
            WorkerBootstrapCandidateStatus::Approved => "approved",
            WorkerBootstrapCandidateStatus::Rejected => "rejected",
            WorkerBootstrapCandidateStatus::Registered => "registered",
            WorkerBootstrapCandidateStatus::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerBootstrapCandidateRecord {
    pub id: i64,
    pub port_scan_id: i64,
    pub requested_by: Option<String>,
    pub discovered_host: String,
    #[serde(default)]
    pub discovered_port: Option<u16>,
    #[serde(default)]
    pub worker_pool: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub status: WorkerBootstrapCandidateStatus,
    #[serde(default)]
    pub approved_by: Option<String>,
    #[serde(default)]
    pub enrollment_token_id: Option<i64>,
    #[serde(default)]
    pub worker_id: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerBootstrapCandidateInput {
    pub discovered_host: String,
    #[serde(default)]
    pub discovered_port: Option<u16>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkerBootstrapJobStatus {
    Queued,
    InProgress,
    Completed,
    Failed,
}

impl Default for WorkerBootstrapJobStatus {
    fn default() -> Self {
        Self::Queued
    }
}

impl WorkerBootstrapJobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkerBootstrapJobStatus::Queued => "queued",
            WorkerBootstrapJobStatus::InProgress => "in_progress",
            WorkerBootstrapJobStatus::Completed => "completed",
            WorkerBootstrapJobStatus::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerBootstrapJobRecord {
    pub id: i64,
    pub candidate_id: i64,
    pub port_scan_id: i64,
    pub requested_by: Option<String>,
    pub approved_by: Option<String>,
    pub discovered_host: String,
    #[serde(default)]
    pub discovered_port: Option<u16>,
    #[serde(default)]
    pub worker_pool: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub provisioner: String,
    #[serde(default)]
    pub executor_worker_pool: Option<String>,
    #[serde(default)]
    pub executor_tags: Vec<String>,
    #[serde(default)]
    pub status: WorkerBootstrapJobStatus,
    #[serde(default)]
    pub enrollment_token_id: Option<i64>,
    #[serde(default)]
    pub claimed_by_worker_id: Option<String>,
    #[serde(default)]
    pub attempt_count: u64,
    #[serde(default)]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerBootstrapJobClaim {
    pub job: WorkerBootstrapJobRecord,
    pub candidate: WorkerBootstrapCandidateRecord,
    pub enrollment_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerBootstrapCandidateApproval {
    pub candidate: WorkerBootstrapCandidateRecord,
    pub token: WorkerEnrollmentTokenIssued,
    #[serde(default)]
    pub bootstrap_job: Option<WorkerBootstrapJobRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct WorkerLifecycleUpdateRequest {
    #[serde(default)]
    pub lifecycle_state: WorkerLifecycleState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerEnrollmentTokenIssueRequest {
    pub label: String,
    #[serde(default)]
    pub worker_pool: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_worker_enrollment_token_allow_runs")]
    pub allow_runs: bool,
    #[serde(default = "default_worker_enrollment_token_allow_port_scans")]
    pub allow_port_scans: bool,
    #[serde(default)]
    pub allow_bootstrap: bool,
    #[serde(default)]
    pub single_use: bool,
    #[serde(default)]
    pub expires_in_seconds: Option<u64>,
}

impl Default for WorkerEnrollmentTokenIssueRequest {
    fn default() -> Self {
        Self {
            label: String::new(),
            worker_pool: None,
            tags: Vec::new(),
            allow_runs: default_worker_enrollment_token_allow_runs(),
            allow_port_scans: default_worker_enrollment_token_allow_port_scans(),
            allow_bootstrap: false,
            single_use: false,
            expires_in_seconds: None,
        }
    }
}

pub type WorkerBootstrapCandidateRejectRequest = WorkerBootstrapCandidateRejectionRequest;

fn default_worker_enrollment_token_allow_runs() -> bool {
    true
}

fn default_worker_enrollment_token_allow_port_scans() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionKind {
    DetectorPack,
    Importer,
    ScannerAdapter,
    Provisioner,
    Enricher,
}

impl ExtensionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ExtensionKind::DetectorPack => "detector_pack",
            ExtensionKind::Importer => "importer",
            ExtensionKind::ScannerAdapter => "scanner_adapter",
            ExtensionKind::Provisioner => "provisioner",
            ExtensionKind::Enricher => "enricher",
        }
    }
}

impl Default for ExtensionKind {
    fn default() -> Self {
        Self::DetectorPack
    }
}

impl std::str::FromStr for ExtensionKind {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "detector_pack" => Ok(Self::DetectorPack),
            "importer" => Ok(Self::Importer),
            "scanner_adapter" => Ok(Self::ScannerAdapter),
            "provisioner" => Ok(Self::Provisioner),
            "enricher" => Ok(Self::Enricher),
            other => Err(format!("unknown extension kind: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtensionManifest {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub kind: ExtensionKind,
    #[serde(default = "default_extension_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub output_format: Option<String>,
    #[serde(default)]
    pub source_path: Option<String>,
}

impl ExtensionManifest {
    pub fn is_detector_pack(&self) -> bool {
        self.enabled && self.kind == ExtensionKind::DetectorPack
    }

    pub fn is_importer(&self) -> bool {
        self.enabled && self.kind == ExtensionKind::Importer
    }

    pub fn is_scanner_adapter(&self) -> bool {
        self.enabled && self.kind == ExtensionKind::ScannerAdapter
    }

    pub fn is_provisioner(&self) -> bool {
        self.enabled && self.kind == ExtensionKind::Provisioner
    }

    pub fn resolved_command(&self) -> Option<String> {
        let command = self.command.as_deref()?.trim();
        if command.is_empty() {
            return None;
        }
        if Path::new(command).is_absolute() || !command.contains(std::path::MAIN_SEPARATOR) {
            return Some(command.to_string());
        }
        let Some(source_path) = self.source_path.as_deref() else {
            return Some(command.to_string());
        };
        let Some(parent) = Path::new(source_path).parent() else {
            return Some(command.to_string());
        };
        Some(parent.join(command).to_string_lossy().into_owned())
    }

    pub fn output_format(&self) -> &str {
        self.output_format.as_deref().unwrap_or(match self.kind {
            ExtensionKind::DetectorPack => "finding_json_lines",
            ExtensionKind::Importer => "target_json_lines",
            ExtensionKind::ScannerAdapter => "endpoint_lines",
            ExtensionKind::Provisioner => "text",
            ExtensionKind::Enricher => "json_lines",
        })
    }
}

fn default_extension_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PortScanSchemePolicy {
    Auto,
    Http,
    Https,
    Both,
}

impl PortScanSchemePolicy {
    pub fn as_str(&self) -> &'static str {
        match self {
            PortScanSchemePolicy::Auto => "auto",
            PortScanSchemePolicy::Http => "http",
            PortScanSchemePolicy::Https => "https",
            PortScanSchemePolicy::Both => "both",
        }
    }
}

impl Default for PortScanSchemePolicy {
    fn default() -> Self {
        Self::Auto
    }
}

impl std::str::FromStr for PortScanSchemePolicy {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "auto" => Ok(Self::Auto),
            "http" => Ok(Self::Http),
            "https" => Ok(Self::Https),
            "both" => Ok(Self::Both),
            other => Err(format!("unknown port scan scheme policy: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct BinDatasetImportRequest {
    #[serde(default)]
    pub repository_id: Option<i64>,
    #[serde(default)]
    pub local_path: Option<String>,
    #[serde(default)]
    pub csv_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct BinDatasetStatus {
    #[serde(default)]
    pub repository_id: Option<i64>,
    #[serde(default)]
    pub repository_name: Option<String>,
    #[serde(default)]
    pub github_url: Option<String>,
    #[serde(default)]
    pub local_path: Option<String>,
    #[serde(default)]
    pub csv_path: Option<String>,
    #[serde(default)]
    pub record_count: usize,
    #[serde(default)]
    pub imported_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct BinMetadataRecord {
    pub bin: String,
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub card_type: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub issuer: Option<String>,
    #[serde(default)]
    pub issuer_phone: Option<String>,
    #[serde(default)]
    pub issuer_url: Option<String>,
    #[serde(default)]
    pub iso_code2: Option<String>,
    #[serde(default)]
    pub iso_code3: Option<String>,
    #[serde(default)]
    pub country_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct BinLookupRequest {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BinLookupLinePreview {
    pub line_number: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BinLookupMatch {
    pub bin: String,
    pub occurrences: usize,
    #[serde(default)]
    pub line_numbers: Vec<usize>,
    #[serde(default)]
    pub line_previews: Vec<BinLookupLinePreview>,
    #[serde(default)]
    pub metadata: Option<BinMetadataRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct BinLookupResponse {
    #[serde(default)]
    pub dataset: Option<BinDatasetStatus>,
    #[serde(default)]
    pub processed_lines: usize,
    #[serde(default)]
    pub matched_lines: usize,
    #[serde(default)]
    pub unique_bins: usize,
    #[serde(default)]
    pub matches: Vec<BinLookupMatch>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinLookupCandidate {
    pub bin: String,
    pub line_number: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerBootstrapPolicy {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub worker_pool: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

impl Default for WorkerBootstrapPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            worker_pool: None,
            tags: Vec::new(),
        }
    }
}

impl WorkerBootstrapPolicy {
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct PortScanRequest {
    pub target_range: String,
    pub ports: String,
    #[serde(default)]
    pub schemes: PortScanSchemePolicy,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub rate_limit: u64,
    #[serde(default)]
    pub worker_pool: Option<String>,
    #[serde(default)]
    pub bootstrap_policy: WorkerBootstrapPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PortScanRecord {
    pub id: i64,
    pub requested_by: Option<String>,
    pub target_range: String,
    pub ports: String,
    #[serde(default)]
    pub schemes: PortScanSchemePolicy,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub rate_limit: u64,
    #[serde(default)]
    pub worker_pool: Option<String>,
    #[serde(default)]
    pub bootstrap_policy: WorkerBootstrapPolicy,
    pub status: RunStatus,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub discovered_endpoints_total: u64,
    #[serde(default)]
    pub imported_targets_total: u64,
    #[serde(default)]
    pub bootstrap_candidates_total: u64,
    #[serde(default)]
    pub queued_run_id: Option<i64>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScanRunRecord {
    pub id: i64,
    pub requested_by: Option<String>,
    #[serde(default)]
    pub scope: Option<RunScope>,
    pub status: RunStatus,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub total_targets: u64,
    pub completed_targets: u64,
    pub requests_total: u64,
    #[serde(default)]
    pub control_requests_total: u64,
    #[serde(default)]
    pub documents_scanned_total: u64,
    #[serde(default)]
    pub non_text_responses_total: u64,
    #[serde(default)]
    pub truncated_responses_total: u64,
    #[serde(default)]
    pub duplicate_responses_total: u64,
    #[serde(default)]
    pub control_match_responses_total: u64,
    #[serde(default)]
    pub request_errors_total: u64,
    pub findings_total: u64,
    pub errors_total: u64,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScanJobRecord {
    pub id: i64,
    pub run_id: i64,
    pub target: TargetRecord,
    pub status: JobStatus,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub requests_count: u64,
    #[serde(default)]
    pub control_requests_count: u64,
    #[serde(default)]
    pub documents_scanned_count: u64,
    #[serde(default)]
    pub non_text_responses_count: u64,
    #[serde(default)]
    pub truncated_responses_count: u64,
    #[serde(default)]
    pub duplicate_responses_count: u64,
    #[serde(default)]
    pub control_match_responses_count: u64,
    #[serde(default)]
    pub request_errors_count: u64,
    pub findings_count: u64,
    #[serde(default)]
    pub coverage_sources: Vec<CoverageSourceStat>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FindingRecord {
    pub id: i64,
    pub run_id: i64,
    pub target_id: i64,
    pub target_label: String,
    pub target_base_url: String,
    #[serde(default)]
    pub target_strategy: TargetStrategy,
    #[serde(default)]
    pub discovery_provenance: Option<DiscoveryProvenanceRecord>,
    pub detector: String,
    pub severity: Severity,
    pub path: String,
    pub redacted_value: String,
    pub evidence: String,
    pub fingerprint: String,
    pub discovered_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CoverageSourceStat {
    pub source: String,
    #[serde(default)]
    pub queued_paths: u64,
    #[serde(default)]
    pub requested_paths: u64,
    #[serde(default)]
    pub documents_scanned: u64,
    #[serde(default)]
    pub discovered_paths: u64,
    #[serde(default)]
    pub findings_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FindingCandidate {
    pub detector: String,
    pub severity: Severity,
    pub path: String,
    pub redacted_value: String,
    pub evidence: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NewFinding {
    pub run_id: i64,
    pub target_id: i64,
    pub detector: String,
    pub severity: Severity,
    pub path: String,
    pub redacted_value: String,
    pub evidence: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FindingsQuery {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub cursor: Option<i64>,
    #[serde(default)]
    pub run_id: Option<i64>,
    #[serde(default)]
    pub target_id: Option<i64>,
    #[serde(default)]
    pub severity: Option<Severity>,
    #[serde(default)]
    pub detector: Option<String>,
    #[serde(default)]
    pub path_prefix: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub q: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct FetchTelemetry {
    #[serde(default)]
    pub request_count: u64,
    #[serde(default)]
    pub control_requests: u64,
    #[serde(default)]
    pub documents_scanned: u64,
    #[serde(default)]
    pub non_text_responses: u64,
    #[serde(default)]
    pub truncated_responses: u64,
    #[serde(default)]
    pub duplicate_responses: u64,
    #[serde(default)]
    pub control_match_responses: u64,
    #[serde(default)]
    pub request_error_count: u64,
    #[serde(default)]
    pub coverage_sources: Vec<CoverageSourceStat>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct RunProgressSnapshot {
    #[serde(default)]
    pub pending_targets: u64,
    #[serde(default)]
    pub in_progress_targets: u64,
    #[serde(default)]
    pub succeeded_targets: u64,
    #[serde(default)]
    pub failed_targets: u64,
    pub last_activity_at: Option<DateTime<Utc>>,
    pub elapsed_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct RunSummary {
    pub run_id: i64,
    pub status: RunStatus,
    pub total_targets: u64,
    pub completed_targets: u64,
    pub requests_total: u64,
    #[serde(default)]
    pub control_requests_total: u64,
    #[serde(default)]
    pub documents_scanned_total: u64,
    #[serde(default)]
    pub non_text_responses_total: u64,
    #[serde(default)]
    pub truncated_responses_total: u64,
    #[serde(default)]
    pub duplicate_responses_total: u64,
    #[serde(default)]
    pub control_match_responses_total: u64,
    #[serde(default)]
    pub request_errors_total: u64,
    pub findings_total: u64,
    pub errors_total: u64,
    #[serde(default)]
    pub coverage_sources: Vec<CoverageSourceStat>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub progress: RunProgressSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FailedTargetRecord {
    pub job_id: i64,
    pub target_id: i64,
    pub target_label: String,
    pub target_base_url: String,
    pub requests_count: u64,
    pub findings_count: u64,
    pub error: String,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DetectorFindingStat {
    pub detector: String,
    pub severity: Severity,
    pub findings_total: u64,
    pub affected_targets: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecurringScheduleRecord {
    pub id: i64,
    pub label: String,
    pub interval_seconds: u64,
    pub enabled: bool,
    pub requested_by: Option<String>,
    #[serde(default)]
    pub scope: Option<RunScope>,
    pub next_run_at: DateTime<Utc>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub last_queued_run_id: Option<i64>,
    pub last_queued_run_status: Option<RunStatus>,
    pub last_queued_run_started_at: Option<DateTime<Utc>>,
    pub last_queued_run_completed_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredEvent {
    pub id: i64,
    pub run_id: Option<i64>,
    pub payload: ApiEvent,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ApiEvent {
    PortScanQueued {
        port_scan: PortScanRecord,
    },
    PortScanStarted {
        port_scan: PortScanRecord,
    },
    PortScanCompleted {
        port_scan: PortScanRecord,
        queued_run: Option<ScanRunRecord>,
        summary: Option<RunSummary>,
    },
    PortScanFailed {
        port_scan: PortScanRecord,
        error: String,
    },
    PublicWorkflowRecorded {
        workflow: PublicWorkflowKind,
        record_id: i64,
        resource: String,
        status: PublicWorkflowStatus,
    },
    WorkerStateChanged {
        worker: WorkerRecord,
    },
    WorkerEnrollmentTokenIssued {
        token: WorkerEnrollmentTokenRecord,
    },
    WorkerEnrollmentTokenRevoked {
        token: WorkerEnrollmentTokenRecord,
    },
    WorkerBootstrapCandidateCreated {
        candidate: WorkerBootstrapCandidateRecord,
    },
    WorkerBootstrapCandidateApproved {
        candidate: WorkerBootstrapCandidateRecord,
        token: WorkerEnrollmentTokenRecord,
    },
    WorkerBootstrapCandidateRejected {
        candidate: WorkerBootstrapCandidateRecord,
    },
    WorkerBootstrapJobQueued {
        job: WorkerBootstrapJobRecord,
    },
    WorkerBootstrapJobStarted {
        job: WorkerBootstrapJobRecord,
    },
    WorkerBootstrapJobCompleted {
        job: WorkerBootstrapJobRecord,
    },
    WorkerBootstrapJobFailed {
        job: WorkerBootstrapJobRecord,
        error: String,
    },
    RunQueued {
        run: ScanRunRecord,
        summary: RunSummary,
    },
    RunStarted {
        run: ScanRunRecord,
        summary: RunSummary,
    },
    StatsUpdated {
        run_id: i64,
        summary: RunSummary,
    },
    FindingRecorded {
        finding: FindingRecord,
    },
    PublicFindingModerated {
        finding: PublicFindingModerationRecord,
    },
    RunCompleted {
        run: ScanRunRecord,
        summary: RunSummary,
    },
    RunFailed {
        run: ScanRunRecord,
        summary: RunSummary,
        error: String,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DashboardSnapshot {
    pub latest_run: Option<ScanRunRecord>,
    pub latest_summary: Option<RunSummary>,
    #[serde(default)]
    pub recent_port_scans: Vec<PortScanRecord>,
    pub targets: Vec<TargetRecord>,
    #[serde(default)]
    pub scan_defaults: ScanDefaultsSummary,
    #[serde(default)]
    pub repositories: Vec<RepositoryRecord>,
    #[serde(default)]
    pub operators: Vec<OperatorRecord>,
    #[serde(default)]
    pub workers: Vec<WorkerRecord>,
    #[serde(default)]
    pub worker_pools: Vec<WorkerPoolRecord>,
    #[serde(default)]
    pub worker_enrollment_tokens: Vec<WorkerEnrollmentTokenRecord>,
    #[serde(default)]
    pub bootstrap_candidates: Vec<WorkerBootstrapCandidateRecord>,
    #[serde(default)]
    pub bootstrap_jobs: Vec<WorkerBootstrapJobRecord>,
    #[serde(default)]
    pub extensions: Vec<ExtensionManifest>,
    #[serde(default)]
    pub bin_dataset_status: Option<BinDatasetStatus>,
    pub recent_findings: Vec<FindingRecord>,
    pub recent_runs: Vec<ScanRunRecord>,
    #[serde(default)]
    pub latest_failed_targets: Vec<FailedTargetRecord>,
    #[serde(default)]
    pub latest_detector_distribution: Vec<DetectorFindingStat>,
    #[serde(default)]
    pub schedules: Vec<RecurringScheduleRecord>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScanDefaultsSummary {
    #[serde(default)]
    pub concurrency: usize,
    #[serde(default)]
    pub request_timeout_secs: u64,
    #[serde(default)]
    pub max_response_bytes: usize,
    #[serde(default)]
    pub max_paths_per_target: usize,
    #[serde(default)]
    pub max_parallel_paths_per_target: usize,
    #[serde(default)]
    pub max_concurrent_requests_per_host: usize,
    #[serde(default)]
    pub enable_path_discovery: bool,
    #[serde(default)]
    pub max_discovered_paths_per_target: usize,
    #[serde(default)]
    pub host_backoff_initial_ms: u64,
    #[serde(default)]
    pub host_backoff_max_ms: u64,
    #[serde(default)]
    pub poll_interval_seconds: u64,
    #[serde(default)]
    pub allow_invalid_tls: bool,
    #[serde(default)]
    pub directory_probing_enabled: bool,
    #[serde(default)]
    pub directory_probing_wordlist_count: usize,
    #[serde(default)]
    pub directory_probing_wordlist: Vec<String>,
    #[serde(default)]
    pub directory_probing_extensions: Vec<String>,
    #[serde(default)]
    pub directory_probing_add_slash: bool,
    #[serde(default)]
    pub directory_probing_discover_backup: bool,
}

pub fn merge_coverage_source_stat(
    stats: &mut Vec<CoverageSourceStat>,
    source: &str,
    queued_paths: u64,
    requested_paths: u64,
    documents_scanned: u64,
    discovered_paths: u64,
    findings_count: u64,
) {
    let source = source.trim();
    if source.is_empty() {
        return;
    }
    if queued_paths == 0
        && requested_paths == 0
        && documents_scanned == 0
        && discovered_paths == 0
        && findings_count == 0
    {
        return;
    }

    if let Some(existing) = stats.iter_mut().find(|entry| entry.source == source) {
        existing.queued_paths += queued_paths;
        existing.requested_paths += requested_paths;
        existing.documents_scanned += documents_scanned;
        existing.discovered_paths += discovered_paths;
        existing.findings_count += findings_count;
        return;
    }

    stats.push(CoverageSourceStat {
        source: source.to_string(),
        queued_paths,
        requested_paths,
        documents_scanned,
        discovered_paths,
        findings_count,
    });
}

pub fn merge_coverage_source_stats(
    target: &mut Vec<CoverageSourceStat>,
    delta: &[CoverageSourceStat],
) {
    for entry in delta {
        merge_coverage_source_stat(
            target,
            &entry.source,
            entry.queued_paths,
            entry.requested_paths,
            entry.documents_scanned,
            entry.discovered_paths,
            entry.findings_count,
        );
    }
}

pub fn sort_coverage_source_stats(stats: &mut Vec<CoverageSourceStat>) {
    stats.sort_by(|left, right| {
        right
            .findings_count
            .cmp(&left.findings_count)
            .then_with(|| right.documents_scanned.cmp(&left.documents_scanned))
            .then_with(|| right.discovered_paths.cmp(&left.discovered_paths))
            .then_with(|| right.requested_paths.cmp(&left.requested_paths))
            .then_with(|| right.queued_paths.cmp(&left.queued_paths))
            .then_with(|| left.source.cmp(&right.source))
    });
}

pub trait FindingsRanker {
    fn score(
        &self,
        finding: &FindingRecord,
        target_tags: &[String],
        query: &FindingsQuery,
    ) -> Option<u64>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct HybridFindingsRanker;

pub fn sanitize_paths(paths: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();

    for path in paths {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }

        let candidate = if trimmed.starts_with('/') {
            trimmed.to_string()
        } else {
            format!("/{trimmed}")
        };

        if !normalized.contains(&candidate) {
            normalized.push(candidate);
        }
    }

    normalized
}

pub fn normalized_findings_query_limit(limit: Option<usize>) -> usize {
    match limit.unwrap_or(DEFAULT_FINDINGS_QUERY_LIMIT) {
        0 => DEFAULT_FINDINGS_QUERY_LIMIT,
        value => value.min(MAX_FINDINGS_QUERY_LIMIT),
    }
}

pub fn normalized_bin_lookup_limit(limit: Option<usize>) -> usize {
    match limit.unwrap_or(DEFAULT_BIN_LOOKUP_LIMIT) {
        0 => DEFAULT_BIN_LOOKUP_LIMIT,
        value => value.min(MAX_BIN_LOOKUP_LIMIT),
    }
}

pub fn normalized_public_finding_search_limit(limit: Option<usize>) -> usize {
    match limit.unwrap_or(DEFAULT_PUBLIC_FINDINGS_QUERY_LIMIT) {
        0 => DEFAULT_PUBLIC_FINDINGS_QUERY_LIMIT,
        value => value.min(MAX_PUBLIC_FINDINGS_QUERY_LIMIT),
    }
}

fn normalize_bin_lookup_line(raw_line: &str) -> &str {
    let line = raw_line.trim();
    let Some((prefix, remainder)) = line.split_once(':') else {
        return line;
    };
    let prefix = prefix.trim();
    let remainder = remainder.trim();
    if prefix.is_empty()
        || remainder.is_empty()
        || prefix.chars().any(|character| character.is_ascii_digit())
        || !prefix
            .chars()
            .any(|character| character.is_ascii_alphabetic())
    {
        return line;
    }
    remainder
}

pub fn bin_lookup_line_preview(raw_line: &str) -> String {
    raw_line.to_string()
}

pub fn parse_bin_lookup_candidates(text: &str) -> Vec<BinLookupCandidate> {
    let mut candidates = Vec::new();

    for (index, raw_line) in text.lines().enumerate() {
        let line = normalize_bin_lookup_line(raw_line);
        if line.is_empty() {
            continue;
        }
        if line
            .chars()
            .any(|character| character.is_ascii_alphabetic())
        {
            continue;
        }
        if !line.chars().all(|character| {
            character.is_ascii_digit()
                || matches!(character, ' ' | '\t' | '|' | ':' | ';' | ',' | '-' | '/')
        }) {
            continue;
        }

        let groups = line
            .split(|character: char| !character.is_ascii_digit())
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        if groups.is_empty() {
            continue;
        }

        let mut leading_digits = String::new();
        for group in groups {
            leading_digits.push_str(group);
            if (13..=19).contains(&leading_digits.len()) {
                candidates.push(BinLookupCandidate {
                    bin: leading_digits[..6].to_string(),
                    line_number: index + 1,
                });
                break;
            }
            if leading_digits.len() > 19 {
                break;
            }
        }
    }

    candidates
}

pub fn normalize_findings_query(mut query: FindingsQuery) -> FindingsQuery {
    query.limit = Some(normalized_findings_query_limit(query.limit));
    query.cursor = query.cursor.filter(|cursor| *cursor > 0);
    query.run_id = query.run_id.filter(|run_id| *run_id > 0);
    query.target_id = query.target_id.filter(|target_id| *target_id > 0);
    query.detector = query
        .detector
        .take()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    query.path_prefix = query
        .path_prefix
        .take()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.starts_with('/') {
                value
            } else {
                format!("/{value}")
            }
        });
    query.q = query
        .q
        .take()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    let mut tags = Vec::new();
    for tag in query.tags.drain(..) {
        let trimmed = tag.trim().to_ascii_lowercase();
        if !trimmed.is_empty() && !tags.contains(&trimmed) {
            tags.push(trimmed);
        }
    }
    query.tags = tags;
    query
}

pub fn normalize_public_finding_search_query(
    mut query: PublicFindingSearchQuery,
) -> PublicFindingSearchQuery {
    query.limit = Some(normalized_public_finding_search_limit(query.limit));
    query.detector = query
        .detector
        .take()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    query.path_prefix = query
        .path_prefix
        .take()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.starts_with('/') {
                value
            } else {
                format!("/{value}")
            }
        });
    query.q = query
        .q
        .take()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    query
}

pub fn finding_query_score<R: FindingsRanker>(
    ranker: &R,
    finding: &FindingRecord,
    target_tags: &[String],
    query: &FindingsQuery,
) -> Option<u64> {
    if query.cursor.is_some_and(|cursor| finding.id >= cursor) {
        return None;
    }
    if query.run_id.is_some_and(|run_id| finding.run_id != run_id) {
        return None;
    }
    if query
        .target_id
        .is_some_and(|target_id| finding.target_id != target_id)
    {
        return None;
    }
    if query
        .severity
        .as_ref()
        .is_some_and(|severity| finding.severity != *severity)
    {
        return None;
    }
    if query
        .detector
        .as_deref()
        .is_some_and(|detector| !finding.detector.eq_ignore_ascii_case(detector))
    {
        return None;
    }
    if query
        .path_prefix
        .as_deref()
        .is_some_and(|path_prefix| !finding.path.to_ascii_lowercase().starts_with(path_prefix))
    {
        return None;
    }
    if !query.tags.is_empty()
        && !target_tags
            .iter()
            .any(|tag| query.tags.iter().any(|query_tag| query_tag == tag))
    {
        return None;
    }

    ranker.score(finding, target_tags, query)
}

pub fn run_findings_query<R: FindingsRanker>(
    ranker: &R,
    findings: impl IntoIterator<Item = FindingRecord>,
    target_tags_by_id: &HashMap<i64, Vec<String>>,
    query: &FindingsQuery,
) -> Vec<FindingRecord> {
    let query = normalize_findings_query(query.clone());
    let mut ranked = findings
        .into_iter()
        .filter_map(|finding| {
            let target_tags = target_tags_by_id
                .get(&finding.target_id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            finding_query_score(ranker, &finding, target_tags, &query).map(|score| (score, finding))
        })
        .collect::<Vec<_>>();

    ranked.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then(right.discovered_at.cmp(&left.discovered_at))
            .then(right.id.cmp(&left.id))
    });
    ranked.truncate(query.limit.unwrap_or(DEFAULT_FINDINGS_QUERY_LIMIT));
    ranked.into_iter().map(|(_, finding)| finding).collect()
}

impl FindingsRanker for HybridFindingsRanker {
    fn score(
        &self,
        finding: &FindingRecord,
        target_tags: &[String],
        query: &FindingsQuery,
    ) -> Option<u64> {
        let Some(search_terms) = normalized_search_terms(query.q.as_deref()) else {
            return Some(0);
        };

        let detector = finding.detector.to_ascii_lowercase();
        let target_label = finding.target_label.to_ascii_lowercase();
        let target_base_url = finding.target_base_url.to_ascii_lowercase();
        let path = finding.path.to_ascii_lowercase();
        let redacted_value = finding.redacted_value.to_ascii_lowercase();
        let evidence = finding.evidence.to_ascii_lowercase();
        let severity = finding.severity.as_str().to_string();
        let tags = target_tags
            .iter()
            .map(|tag| tag.to_ascii_lowercase())
            .collect::<Vec<_>>();
        let searchable_blob = [
            detector.as_str(),
            target_label.as_str(),
            target_base_url.as_str(),
            path.as_str(),
            redacted_value.as_str(),
            evidence.as_str(),
            severity.as_str(),
            &tags.join(" "),
        ]
        .join("\n");

        if !search_terms
            .iter()
            .all(|term| searchable_blob.contains(term.as_str()))
        {
            return None;
        }

        let mut score = 0u64;
        for term in search_terms {
            score += score_search_term(term.as_str(), &detector, 140, 70);
            score += score_search_term(term.as_str(), &path, 120, 50);
            score += score_search_term(term.as_str(), &target_label, 100, 45);
            score += score_search_term(term.as_str(), &target_base_url, 80, 35);
            score += score_search_term(term.as_str(), &redacted_value, 70, 30);
            score += score_search_term(term.as_str(), &evidence, 60, 25);
            score += score_search_term(term.as_str(), &severity, 40, 20);
            score += tags
                .iter()
                .map(|tag| score_search_term(term.as_str(), tag, 50, 20))
                .sum::<u64>();
        }

        Some(score.max(1))
    }
}

fn normalized_search_terms(query: Option<&str>) -> Option<Vec<String>> {
    let terms = query?
        .split_whitespace()
        .map(|term| term.trim().to_ascii_lowercase())
        .filter(|term| !term.is_empty())
        .collect::<Vec<_>>();

    if terms.is_empty() {
        None
    } else {
        Some(terms)
    }
}

fn score_search_term(term: &str, haystack: &str, exact_weight: u64, contains_weight: u64) -> u64 {
    if haystack == term {
        exact_weight
    } else if haystack.starts_with(term) {
        exact_weight.saturating_sub(10)
    } else if haystack.contains(term) {
        contains_weight
    } else {
        0
    }
}

pub fn normalize_request_profile_name(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

pub fn normalize_run_scope(scope: Option<RunScope>) -> Option<RunScope> {
    let Some(mut scope) = scope else {
        return None;
    };

    let mut target_ids = Vec::new();
    for target_id in scope.target_ids.drain(..) {
        if target_id > 0 && !target_ids.contains(&target_id) {
            target_ids.push(target_id);
        }
    }

    let mut tags = Vec::new();
    for tag in scope.tags.drain(..) {
        let trimmed = tag.trim().to_ascii_lowercase();
        if !trimmed.is_empty() && !tags.contains(&trimmed) {
            tags.push(trimmed);
        }
    }

    if target_ids.is_empty() && tags.is_empty() && !scope.failed_only {
        return None;
    }

    Some(RunScope {
        target_ids,
        tags,
        failed_only: scope.failed_only,
    })
}

pub fn redact_secret(secret: &str) -> String {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return "[redacted]".to_string();
    }

    if trimmed.len() <= 8 {
        return format!("{}****", &trimmed[..trimmed.len().min(2)]);
    }

    let prefix = &trimmed[..4.min(trimmed.len())];
    let suffix = &trimmed[trimmed.len().saturating_sub(4)..];
    format!("{prefix}****{suffix}")
}

pub fn utc_now() -> DateTime<Utc> {
    Utc::now()
}

#[cfg(test)]
mod tests {
    use super::{
        bin_lookup_line_preview, finding_query_score, normalize_findings_query,
        normalize_request_profile_name, normalize_run_scope, parse_bin_lookup_candidates,
        redact_secret, sanitize_paths, ExtensionKind, ExtensionManifest, FindingRecord,
        FindingsQuery, HybridFindingsRanker, RunScope, Severity, TargetStrategy,
    };
    use chrono::Utc;

    #[test]
    fn path_normalization_is_stable() {
        let paths = vec![
            "/.env".to_string(),
            "config.json".to_string(),
            "/.env".to_string(),
            "   ".to_string(),
        ];

        let normalized = sanitize_paths(&paths);
        assert_eq!(normalized, vec!["/.env", "/config.json"]);
    }

    #[test]
    fn redaction_keeps_only_edges() {
        assert_eq!(redact_secret("sk_live_1234567890"), "sk_l****7890");
        assert_eq!(redact_secret("abcd"), "ab****");
    }

    #[test]
    fn run_scope_normalization_deduplicates_values() {
        let normalized = normalize_run_scope(Some(RunScope {
            target_ids: vec![4, 0, 4, 7],
            tags: vec![" Prod ".to_string(), "prod".to_string(), "api".to_string()],
            failed_only: true,
        }))
        .expect("scope should be retained");

        assert_eq!(normalized.target_ids, vec![4, 7]);
        assert_eq!(normalized.tags, vec!["prod", "api"]);
        assert!(normalized.failed_only);
    }

    #[test]
    fn request_profile_name_normalization_rejects_blank_values() {
        assert_eq!(
            normalize_request_profile_name(Some("  API-ADMIN  ".to_string())),
            Some("api-admin".to_string())
        );
        assert_eq!(
            normalize_request_profile_name(Some("   ".to_string())),
            None
        );
        assert_eq!(normalize_request_profile_name(None), None);
    }

    #[test]
    fn extension_manifest_resolves_relative_command_against_manifest_path() {
        let manifest = ExtensionManifest {
            name: "scanner".to_string(),
            version: "0.1.0".to_string(),
            kind: ExtensionKind::ScannerAdapter,
            enabled: true,
            description: None,
            command: Some("./adapter.py".to_string()),
            args: Vec::new(),
            tags: Vec::new(),
            output_format: None,
            source_path: Some("/opt/anyscan/vulnscanner-zmap-adapter.json".to_string()),
        };

        assert_eq!(
            manifest.resolved_command(),
            Some("/opt/anyscan/./adapter.py".to_string())
        );
    }

    #[test]
    fn extension_manifest_keeps_bare_command_names_unmodified() {
        let manifest = ExtensionManifest {
            name: "scanner".to_string(),
            version: "0.1.0".to_string(),
            kind: ExtensionKind::ScannerAdapter,
            enabled: true,
            description: None,
            command: Some("python3".to_string()),
            args: Vec::new(),
            tags: Vec::new(),
            output_format: None,
            source_path: Some("/opt/anyscan/vulnscanner-zmap-adapter.json".to_string()),
        };

        assert_eq!(manifest.resolved_command(), Some("python3".to_string()));
    }

    #[test]
    fn bin_lookup_line_preview_preserves_original_line() {
        let preview = bin_lookup_line_preview("Card: 4640182140904099|08|27|371");
        assert_eq!(preview, "Card: 4640182140904099|08|27|371");
    }

    #[test]
    fn bin_lookup_candidates_ignore_textual_noise_and_keep_only_bin() {
        let input =
            "4640182140904099|08|27|371\nResponse: Thank You 17.92\n4111 1111 1111 1111 12 25 123";
        let candidates = parse_bin_lookup_candidates(input);

        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].bin, "464018");
        assert_eq!(candidates[0].line_number, 1);
        assert_eq!(candidates[1].bin, "411111");
        assert_eq!(candidates[1].line_number, 3);
    }

    #[test]
    fn bin_lookup_candidates_accept_labeled_card_lines() {
        let input = "Card: 4640182140904099|08|27|371\nResponse: Thank You 17.92\nGateway: Stripe Card Payments\nPrice: 17.92";
        let candidates = parse_bin_lookup_candidates(input);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].bin, "464018");
        assert_eq!(candidates[0].line_number, 1);
    }

    #[test]
    fn findings_query_normalization_clamps_and_sanitizes_values() {
        let query = normalize_findings_query(FindingsQuery {
            limit: Some(0),
            cursor: Some(-1),
            run_id: Some(12),
            target_id: Some(0),
            severity: Some(Severity::High),
            detector: Some("  Aws_Access_Key  ".to_string()),
            path_prefix: Some(" config".to_string()),
            tags: vec![
                " Prod ".to_string(),
                "prod".to_string(),
                " api ".to_string(),
            ],
            q: Some("  runtime config  ".to_string()),
        });

        assert_eq!(query.limit, Some(50));
        assert_eq!(query.cursor, None);
        assert_eq!(query.run_id, Some(12));
        assert_eq!(query.target_id, None);
        assert_eq!(query.detector, Some("aws_access_key".to_string()));
        assert_eq!(query.path_prefix, Some("/config".to_string()));
        assert_eq!(query.tags, vec!["prod".to_string(), "api".to_string()]);
        assert_eq!(query.q, Some("runtime config".to_string()));
    }

    #[test]
    fn hybrid_findings_ranker_matches_redacted_fields_only() {
        let finding = FindingRecord {
            id: 7,
            run_id: 22,
            target_id: 9,
            target_label: "Prod API".to_string(),
            target_base_url: "https://api.example.com".to_string(),
            target_strategy: TargetStrategy::Hybrid,
            discovery_provenance: None,
            detector: "aws_access_key".to_string(),
            severity: Severity::High,
            path: "/runtime-config.json".to_string(),
            redacted_value: "AKIA****TEST".to_string(),
            evidence: "Runtime config references AWS credentials".to_string(),
            fingerprint: "fp-1".to_string(),
            discovered_at: Utc::now(),
        };
        let query = normalize_findings_query(FindingsQuery {
            q: Some("runtime config".to_string()),
            tags: vec!["prod".to_string()],
            ..FindingsQuery::default()
        });

        let score = finding_query_score(
            &HybridFindingsRanker,
            &finding,
            &["prod".to_string(), "api".to_string()],
            &query,
        )
        .expect("query should match searchable redacted fields");

        assert!(score > 0);
        let misses = finding_query_score(
            &HybridFindingsRanker,
            &finding,
            &["prod".to_string()],
            &normalize_findings_query(FindingsQuery {
                q: Some("rawsecretvalue".to_string()),
                ..FindingsQuery::default()
            }),
        );
        assert!(misses.is_none());
    }
}

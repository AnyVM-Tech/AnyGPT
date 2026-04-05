use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ApprovedResource {
    pub id: String,
    pub label: String,
    pub resource_type: String,
    pub target: String,
    #[serde(default)]
    pub owner_contact: String,
    #[serde(default)]
    pub scan_policy: String,
    #[serde(default)]
    pub approved_by: String,
    #[serde(default)]
    pub approval_reference: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub owner: String,
    pub authorization_state: String,
    #[serde(default)]
    pub authorization_basis: String,
    #[serde(default)]
    pub authorization_reference: String,
    #[serde(default)]
    pub resource_scope: String,
    pub last_verified_at: String,
    pub exposure_risk: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub approved_resources: Vec<ApprovedResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Finding {
    pub id: String,
    pub asset_id: String,
    pub title: String,
    pub severity: String,
    pub status: String,
    pub source: String,
    pub evidence_url: Option<String>,
    pub needs_disclosure: bool,
    pub needs_owner_confirmation: bool,
    #[serde(default)]
    pub report_status: String,
    #[serde(default)]
    pub visibility: String,
    #[serde(default)]
    pub grace_period_days: u16,
    pub summary: String,
    #[serde(default)]
    pub related_intelligence_ids: Vec<String>,
    #[serde(default)]
    pub recommended_method_ids: Vec<String>,
    #[serde(default)]
    pub evidence_summary: String,
    #[serde(default)]
    pub remediation_owner: String,
    #[serde(default)]
    pub recipient_contacts: Vec<String>,
    #[serde(default)]
    pub escalation_targets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ComplianceSource {
    pub id: String,
    pub title: String,
    pub category: String,
    pub url: String,
    pub requirement: String,
    pub product_response: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TestingMethodology {
    pub id: String,
    pub title: String,
    pub category: String,
    pub safety_posture: String,
    pub objective: String,
    pub operator_steps: Vec<String>,
    pub evidence_outputs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct VulnerabilityIntelligence {
    pub id: String,
    pub cve_id: String,
    pub title: String,
    pub source_catalog: String,
    pub vendor: String,
    pub product: String,
    pub weakness: String,
    pub risk_signal: String,
    pub public_reference_url: String,
    pub remediation_focus: String,
    pub testing_method_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ResearchRecommendation {
    pub id: String,
    pub title: String,
    pub priority: String,
    pub rationale: String,
    #[serde(default)]
    pub suggested_paths: Vec<String>,
    #[serde(default)]
    pub supporting_video_ids: Vec<String>,
    #[serde(default)]
    pub supporting_page_ids: Vec<String>,
    #[serde(default)]
    pub supporting_item_ids: Vec<String>,
    #[serde(default)]
    pub supporting_source_types: Vec<String>,
    #[serde(default)]
    pub suggested_paths_by_source: BTreeMap<String, Vec<String>>,
    pub signal_count: usize,
    #[serde(default)]
    pub weighted_signal_score: f64,
    #[serde(default)]
    pub source_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct YouTubeResearchVideo {
    pub video_id: String,
    pub video_url: String,
    pub title: String,
    #[serde(default)]
    pub published_at: String,
    pub duration_seconds: Option<u64>,
    #[serde(default)]
    pub duration_text: String,
    pub view_count: Option<u64>,
    #[serde(default)]
    pub transcript_status: String,
    #[serde(default)]
    pub transcript_source: String,
    #[serde(default)]
    pub transcript_language: String,
    pub transcript_word_count: usize,
    #[serde(default)]
    pub retry_attempt_count: usize,
    #[serde(default)]
    pub retry_backoff_seconds: f64,
    #[serde(default)]
    pub retry_recovered: bool,
    #[serde(default)]
    pub transcript_cache_hit: bool,
    #[serde(default)]
    pub implementation_signals: Vec<String>,
    #[serde(default)]
    pub implementation_notes: Vec<String>,
    #[serde(default)]
    pub evidence_snippets: Vec<String>,
    #[serde(default)]
    pub transcript_excerpt: String,
    #[serde(default)]
    pub error_summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct YouTubeResearchLane {
    pub source_name: String,
    pub channel_title: String,
    #[serde(default)]
    pub channel_id: String,
    pub channel_url: String,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub model_name: String,
    pub total_video_count: usize,
    pub transcribed_video_count: usize,
    pub failed_video_count: usize,
    #[serde(default)]
    pub restored_at: String,
    #[serde(default)]
    pub restored_reason: String,
    #[serde(default)]
    pub last_attempt: Value,
    #[serde(default)]
    pub recommendations: Vec<ResearchRecommendation>,
    #[serde(default)]
    pub videos: Vec<YouTubeResearchVideo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WebsiteResearchPage {
    pub page_id: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub fetch_status: String,
    #[serde(default)]
    pub final_url: String,
    pub http_status: Option<u16>,
    pub text_word_count: usize,
    #[serde(default)]
    pub importance_score: f64,
    #[serde(default)]
    pub implementation_signals: Vec<String>,
    #[serde(default)]
    pub implementation_notes: Vec<String>,
    #[serde(default)]
    pub evidence_snippets: Vec<String>,
    #[serde(default)]
    pub page_excerpt: String,
    #[serde(default)]
    pub error_summary: String,
    #[serde(default)]
    pub crawl_depth: usize,
    #[serde(default)]
    pub discovered_from_page_id: String,
    #[serde(default)]
    pub seed_target_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WebsiteResearchLane {
    pub source_name: String,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub importance_legend: BTreeMap<String, f64>,
    #[serde(default)]
    pub weighted_score_description: String,
    pub target_count: usize,
    #[serde(default)]
    pub page_count: usize,
    #[serde(default)]
    pub discovered_page_count: usize,
    pub ingested_page_count: usize,
    pub failed_page_count: usize,
    #[serde(default)]
    pub restored_at: String,
    #[serde(default)]
    pub restored_reason: String,
    #[serde(default)]
    pub last_attempt: Value,
    #[serde(default)]
    pub recommendations: Vec<ResearchRecommendation>,
    #[serde(default)]
    pub pages: Vec<WebsiteResearchPage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ImplementationLaneCoverage {
    pub youtube_video_count: usize,
    pub youtube_transcribed_video_count: usize,
    pub youtube_failed_video_count: usize,
    #[serde(default)]
    pub website_target_count: usize,
    pub website_page_count: usize,
    #[serde(default)]
    pub website_discovered_page_count: usize,
    pub website_ingested_page_count: usize,
    pub website_failed_page_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ImplementationResearchLane {
    pub source_name: String,
    #[serde(default)]
    pub generated_at: String,
    pub status: String,
    #[serde(default)]
    pub importance_legend: BTreeMap<String, f64>,
    #[serde(default)]
    pub weighted_score_description: String,
    #[serde(default)]
    pub restored_at: String,
    #[serde(default)]
    pub restored_reason: String,
    #[serde(default)]
    pub last_attempt: Value,
    pub coverage: ImplementationLaneCoverage,
    #[serde(default)]
    pub recommendations: Vec<ResearchRecommendation>,
}

fn default_last_attempt() -> Value {
    Value::Object(Default::default())
}

fn default_importance_legend() -> BTreeMap<String, f64> {
    BTreeMap::from([
        ("article".to_string(), 1.0),
        ("blog_index".to_string(), 0.5),
        ("category_archive".to_string(), 0.4),
        ("default".to_string(), 0.5),
        ("discovered_internal_link".to_string(), 0.6),
        ("landing_page".to_string(), 0.8),
    ])
}

fn default_weighted_score_description() -> String {
    "Weighted recommendation score favors richer source pages over aggregate or navigational ones.".to_string()
}

impl Default for YouTubeResearchLane {
    fn default() -> Self {
        Self {
            source_name: "YouTube transcript research lane".to_string(),
            channel_title: String::new(),
            channel_id: String::new(),
            channel_url: "https://www.youtube.com/@TheAIAutomators/videos".to_string(),
            generated_at: String::new(),
            model_name: String::new(),
            total_video_count: 0,
            transcribed_video_count: 0,
            failed_video_count: 0,
            restored_at: String::new(),
            restored_reason: String::new(),
            last_attempt: default_last_attempt(),
            recommendations: Vec::new(),
            videos: Vec::new(),
        }
    }
}

impl Default for WebsiteResearchLane {
    fn default() -> Self {
        Self {
            source_name: "Website text research lane".to_string(),
            generated_at: String::new(),
            importance_legend: default_importance_legend(),
            weighted_score_description: default_weighted_score_description(),
            target_count: 0,
            page_count: 0,
            discovered_page_count: 0,
            ingested_page_count: 0,
            failed_page_count: 0,
            restored_at: String::new(),
            restored_reason: String::new(),
            last_attempt: default_last_attempt(),
            recommendations: Vec::new(),
            pages: Vec::new(),
        }
    }
}

impl Default for ImplementationLaneCoverage {
    fn default() -> Self {
        Self {
            youtube_video_count: 0,
            youtube_transcribed_video_count: 0,
            youtube_failed_video_count: 0,
            website_target_count: 0,
            website_page_count: 0,
            website_discovered_page_count: 0,
            website_ingested_page_count: 0,
            website_failed_page_count: 0,
        }
    }
}

impl Default for ImplementationResearchLane {
    fn default() -> Self {
        Self {
            source_name: "Unified implementation research lane".to_string(),
            generated_at: String::new(),
            status: "not_generated".to_string(),
            importance_legend: default_importance_legend(),
            weighted_score_description: default_weighted_score_description(),
            restored_at: String::new(),
            restored_reason: String::new(),
            last_attempt: default_last_attempt(),
            coverage: ImplementationLaneCoverage::default(),
            recommendations: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DashboardSummary {
    pub product_name: String,
    pub authorized_assets_only: bool,
    pub asset_count: usize,
    pub findings_open: usize,
    pub disclosure_queue: usize,
    pub critical_findings: usize,
    pub compliance_sources: usize,
    pub testing_methodologies: usize,
    pub vulnerability_intelligence_items: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ProductBrief {
    pub name: String,
    pub positioning: String,
    pub guardrails: Vec<String>,
    pub next_steps: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ApprovedAssetResource {
    pub asset_id: String,
    pub asset_name: String,
    pub authorization_state: String,
    pub authorization_basis: String,
    pub resource_scope: String,
    pub resource: ApprovedResource,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SecurityTxtSummary {
    pub status: String,
    pub fetched_from: String,
    pub contact: String,
    pub policy: String,
    pub expires: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ApprovedResourceScanResult {
    pub asset_id: String,
    pub asset_name: String,
    pub authorization_state: String,
    pub authorization_basis: String,
    pub approval_reference: String,
    pub resource_scope: String,
    pub resource: ApprovedResource,
    pub checked_at: String,
    pub reachability: String,
    pub resolved_ips: Vec<String>,
    pub final_url: String,
    pub http_status: Option<u16>,
    pub page_title: String,
    pub server_header: String,
    pub security_txt: Option<SecurityTxtSummary>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct FindingAssetContext {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub authorization_state: String,
    pub authorization_basis: String,
    pub authorization_reference: String,
    pub resource_scope: String,
    pub exposure_risk: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct EnrichedFinding {
    pub id: String,
    pub asset_id: String,
    pub title: String,
    pub severity: String,
    pub status: String,
    pub source: String,
    pub evidence_url: Option<String>,
    pub needs_disclosure: bool,
    pub needs_owner_confirmation: bool,
    pub report_status: String,
    pub visibility: String,
    pub grace_period_days: u16,
    pub summary: String,
    pub evidence_summary: String,
    pub remediation_owner: String,
    pub recipient_contacts: Vec<String>,
    pub escalation_targets: Vec<String>,
    pub asset: Option<FindingAssetContext>,
    pub related_intelligence: Vec<VulnerabilityIntelligence>,
    pub recommended_methods: Vec<TestingMethodology>,
}

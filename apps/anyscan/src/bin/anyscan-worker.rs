use std::{
    collections::HashSet,
    env, fs,
    io::Write,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    process::{Command as ProcessCommand, Stdio},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use anyscan::{
    config::{parse_port_scan_ports, AppConfig},
    core::{
        merge_coverage_source_stat, normalize_run_scope, ApiEvent, DiscoveryProvenanceRecord,
        ExtensionManifest, FetchTelemetry, NewFinding, PortScanRecord, PortScanSchemePolicy,
        RunScope, RunStatus, RunSummary, ScanJobRecord, ScanRunRecord, TargetDefinition,
        WorkerBootstrapCandidateInput, WorkerBootstrapCandidateRecord, WorkerBootstrapJobClaim,
        WorkerBootstrapJobRecord, WorkerRegistration,
    },
    detectors::DetectorEngine,
    fetcher::{Fetcher, TargetFetchReport},
    ops::init_tracing,
    store::AnyScanStore,
};
use futures::stream::{self, StreamExt};
use serde::Serialize;
use tokio::sync::oneshot;
use tracing::{error, info};

#[derive(Debug, Parser)]
struct Cli {
    #[arg(long, env = "ANYSCAN_CONFIG")]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    Seed,
    Queue {
        #[arg(long, default_value = "worker")]
        requested_by: String,
        #[arg(long = "target-id")]
        target_ids: Vec<i64>,
        #[arg(long = "tag")]
        tags: Vec<String>,
        #[arg(long)]
        failed_only: bool,
    },
    Once,
    Daemon,
}

#[derive(Debug, Clone)]
struct WorkerRuntime {
    registration: WorkerRegistration,
    scanner_adapters: Vec<ExtensionManifest>,
    importers: Vec<ExtensionManifest>,
    provisioners: Vec<ExtensionManifest>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
struct DiscoveredEndpoint {
    host: String,
    port: u16,
}

#[derive(Debug)]
struct ScannerExecutionResult {
    discovered_endpoints: Vec<DiscoveredEndpoint>,
    notes: Vec<String>,
}

#[derive(Debug)]
struct ImportedTargetsResult {
    target_ids: Vec<i64>,
    notes: Vec<String>,
}

#[derive(Debug)]
struct QueuedFollowOnRun {
    run: ScanRunRecord,
    summary: RunSummary,
}

#[derive(Debug, Serialize)]
struct ScannerAdapterInvocation<'a> {
    port_scan_id: i64,
    target_range: &'a str,
    ports: &'a str,
    schemes: &'a str,
    rate_limit: u64,
    requested_by: Option<&'a str>,
    tags: &'a [String],
    adapter_name: &'a str,
}

#[derive(Debug, Serialize)]
struct ImporterInvocation<'a> {
    importer_name: &'a str,
    port_scan: &'a PortScanRecord,
    discovered_endpoints: &'a [DiscoveredEndpoint],
}

#[derive(Debug, Serialize)]
struct ProvisionerInvocation<'a> {
    provisioner_name: &'a str,
    executor_worker_id: &'a str,
    job: &'a WorkerBootstrapJobRecord,
    candidate: &'a WorkerBootstrapCandidateRecord,
    enrollment_token: &'a str,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let config = AppConfig::load(cli.config.as_deref())?;
    init_tracing("anyscan-worker");

    let store = AnyScanStore::from_config(&config)?;
    store.initialize()?;
    seed_bootstrap_inventory(&store, &config)?;

    let detectors = DetectorEngine::from_config(&config)?;
    let worker_id = build_worker_id();
    let worker_runtime = build_worker_runtime(&config, &worker_id)?;

    match cli.command.unwrap_or(Command::Daemon) {
        Command::Seed => {
            info!("seeded bootstrap inventory");
        }
        Command::Queue {
            requested_by,
            target_ids,
            tags,
            failed_only,
        } => {
            let scope = normalize_run_scope(Some(RunScope {
                target_ids,
                tags,
                failed_only,
            }));
            queue_run_with_event(&store, &requested_by, scope.as_ref())?;
            info!(requested_by = %requested_by, has_scope = scope.is_some(), "queued run");
        }
        Command::Once => {
            run_once(&config, &worker_id, store, detectors, &worker_runtime).await?;
        }
        Command::Daemon => {
            run_daemon(config, worker_id, store, detectors, worker_runtime).await?;
        }
    }

    Ok(())
}

async fn run_daemon(
    config: AppConfig,
    worker_id: String,
    store: AnyScanStore,
    detectors: DetectorEngine,
    worker_runtime: WorkerRuntime,
) -> Result<()> {
    let worker_registration_ttl = worker_registration_ttl_seconds(&config);
    register_worker_or_bail(
        &store,
        &worker_runtime.registration,
        worker_registration_ttl,
    )?;
    let (registration_shutdown_tx, registration_shutdown_rx) = oneshot::channel();
    let registration_handle = tokio::spawn(worker_registration_heartbeat(
        store.clone(),
        worker_runtime.registration.clone(),
        worker_registration_ttl,
        registration_shutdown_rx,
    ));

    let daemon_result = async {
        loop {
            if let Err(error) = seed_bootstrap_inventory(&store, &config) {
                error!(%error, "failed to seed bootstrap inventory");
            }
            if let Err(error) = queue_due_schedules_with_events(&store, 10) {
                error!(%error, "failed to queue due schedules");
            }

            if let Some(run) =
                store.claim_next_runnable_run(&worker_id, config.storage.redis_run_lease_seconds)?
            {
                info!(run_id = run.id, worker_id = %worker_id, "claimed runnable run");
                process_run(&config, &worker_id, &store, detectors.clone(), run.id).await?;
                continue;
            }

            if worker_runtime.registration.supports_bootstrap {
                if let Some(bootstrap_job) = store.claim_next_pending_bootstrap_job(
                    &worker_id,
                    config.storage.redis_run_lease_seconds,
                )? {
                    info!(
                        bootstrap_job_id = bootstrap_job.job.id,
                        worker_id = %worker_id,
                        provisioner = %bootstrap_job.job.provisioner,
                        provisioner_count = worker_runtime.provisioners.len(),
                        "claimed bootstrap job"
                    );
                    process_bootstrap_job(
                        &config,
                        &worker_runtime,
                        &worker_id,
                        &store,
                        bootstrap_job,
                    )
                    .await?;
                    continue;
                }
            }

            if worker_runtime.registration.supports_port_scans {
                if let Some(port_scan) = store.claim_next_pending_port_scan(
                    &worker_id,
                    config.storage.redis_run_lease_seconds,
                )? {
                    info!(
                        port_scan_id = port_scan.id,
                        worker_id = %worker_id,
                        adapter_count = worker_runtime.scanner_adapters.len(),
                        "claimed port scan"
                    );
                    process_port_scan(&config, &worker_runtime, &worker_id, &store, port_scan)
                        .await?;
                    continue;
                }
            }

            if let Some(run) = store.next_assistable_run(&worker_id)? {
                info!(run_id = run.id, worker_id = %worker_id, "assisting active run");
                assist_run(&config, &worker_id, &store, detectors.clone(), run.id).await?;
                continue;
            }

            let effective_config = load_effective_runtime_config(&config, &store)?;
            tokio::time::sleep(Duration::from_secs(
                effective_config.scan.poll_interval_seconds,
            ))
            .await;
        }
    }
    .await;

    let _ = registration_shutdown_tx.send(());
    let _ = registration_handle.await;
    daemon_result
}

async fn run_once(
    config: &AppConfig,
    worker_id: &str,
    store: AnyScanStore,
    detectors: DetectorEngine,
    worker_runtime: &WorkerRuntime,
) -> Result<()> {
    let worker_registration_ttl = worker_registration_ttl_seconds(config);
    register_worker_or_bail(
        &store,
        &worker_runtime.registration,
        worker_registration_ttl,
    )?;
    let (registration_shutdown_tx, registration_shutdown_rx) = oneshot::channel();
    let registration_handle = tokio::spawn(worker_registration_heartbeat(
        store.clone(),
        worker_runtime.registration.clone(),
        worker_registration_ttl,
        registration_shutdown_rx,
    ));

    let once_result = async {
        queue_due_schedules_with_events(&store, 10)?;
        let run_id = if let Some(run) =
            store.claim_next_runnable_run(worker_id, config.storage.redis_run_lease_seconds)?
        {
            run.id
        } else {
            if worker_runtime.registration.supports_bootstrap {
                if let Some(bootstrap_job) = store.claim_next_pending_bootstrap_job(
                    worker_id,
                    config.storage.redis_run_lease_seconds,
                )? {
                    process_bootstrap_job(config, worker_runtime, worker_id, &store, bootstrap_job)
                        .await?;
                    return Ok(());
                }
            }
            if worker_runtime.registration.supports_port_scans {
                if let Some(port_scan) = store.claim_next_pending_port_scan(
                    worker_id,
                    config.storage.redis_run_lease_seconds,
                )? {
                    process_port_scan(config, worker_runtime, worker_id, &store, port_scan).await?;
                    return Ok(());
                }
            }
            if let Some(run) = store.next_assistable_run(worker_id)? {
                assist_run(config, worker_id, &store, detectors, run.id).await?;
                return Ok(());
            }
            queue_run_with_event(&store, "worker-once", None)?;
            store
                .claim_next_runnable_run(worker_id, config.storage.redis_run_lease_seconds)?
                .map(|run| run.id)
                .ok_or_else(|| anyhow!("queued run could not be claimed by {worker_id}"))?
        };

        process_run(config, worker_id, &store, detectors, run_id).await
    }
    .await;

    let _ = registration_shutdown_tx.send(());
    let _ = registration_handle.await;
    once_result
}

async fn process_run(
    config: &AppConfig,
    worker_id: &str,
    store: &AnyScanStore,
    detectors: DetectorEngine,
    run_id: i64,
) -> Result<()> {
    let (claim_shutdown_tx, claim_shutdown_rx) = oneshot::channel();
    let heartbeat_store = store.clone();
    let heartbeat_worker_id = worker_id.to_string();
    let lease_seconds = config.storage.redis_run_lease_seconds;
    let heartbeat_handle = tokio::spawn(async move {
        run_claim_heartbeat(
            heartbeat_store,
            heartbeat_worker_id,
            run_id,
            lease_seconds,
            claim_shutdown_rx,
        )
        .await
    });

    let run_result = async {
        store.requeue_in_progress_jobs(run_id)?;
        if let Some(run) = store.mark_run_started_if_queued(run_id)? {
            let summary = store.summary(run_id)?;
            store.append_event(
                Some(run_id),
                &ApiEvent::RunStarted {
                    run,
                    summary: summary.clone(),
                },
            )?;
        }

        let mut notes =
            process_claimed_jobs(config, worker_id, store, detectors.clone(), run_id).await?;
        while store.has_incomplete_jobs(run_id)? {
            let mut recovery_notes =
                process_claimed_jobs(config, worker_id, store, detectors.clone(), run_id).await?;
            notes.append(&mut recovery_notes);
            if store.has_incomplete_jobs(run_id)? {
                tokio::time::sleep(run_completion_poll_interval(
                    config.storage.redis_run_lease_seconds,
                ))
                .await;
            }
        }

        let notes_text = if notes.is_empty() {
            None
        } else {
            Some(notes.join(" | "))
        };
        let Some(completed_run) =
            store.mark_run_finished_if_owned(run_id, worker_id, notes_text.as_deref())?
        else {
            if let Some(existing_run) = store.get_run(run_id)? {
                if matches!(
                    existing_run.status,
                    RunStatus::Completed | RunStatus::Failed
                ) {
                    return Ok(());
                }
            }
            return Err(anyhow!(
                "run {run_id} is no longer owned by worker {worker_id} for finalization"
            ));
        };
        let completed_summary = store.summary(run_id)?;

        match completed_run.status {
            RunStatus::Completed => {
                store.append_event(
                    Some(run_id),
                    &ApiEvent::RunCompleted {
                        run: completed_run,
                        summary: completed_summary,
                    },
                )?;
            }
            RunStatus::Failed => {
                store.append_event(
                    Some(run_id),
                    &ApiEvent::RunFailed {
                        run: completed_run,
                        summary: completed_summary,
                        error: notes_text.unwrap_or_else(|| "one or more jobs failed".to_string()),
                    },
                )?;
            }
            RunStatus::Queued | RunStatus::InProgress => {}
        }

        Ok(())
    }
    .await;

    let _ = claim_shutdown_tx.send(());
    let heartbeat_result = match heartbeat_handle.await {
        Ok(result) => result,
        Err(error) => Err(anyhow!("run claim heartbeat task failed: {error}")),
    };

    match (run_result, heartbeat_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Err(error), Err(heartbeat_error)) => Err(error).context(format!(
            "run claim heartbeat also failed: {heartbeat_error}"
        )),
    }
}

async fn assist_run(
    config: &AppConfig,
    worker_id: &str,
    store: &AnyScanStore,
    detectors: DetectorEngine,
    run_id: i64,
) -> Result<()> {
    let notes = process_claimed_jobs(config, worker_id, store, detectors, run_id).await?;
    for note in notes {
        error!(run_id, worker_id = %worker_id, error = %note, "job processing failed while assisting run");
    }
    Ok(())
}

async fn process_claimed_jobs(
    config: &AppConfig,
    worker_id: &str,
    store: &AnyScanStore,
    detectors: DetectorEngine,
    run_id: i64,
) -> Result<Vec<String>> {
    let effective_config = load_effective_runtime_config(config, store)?;
    let fetcher = Arc::new(Fetcher::new(&effective_config)?);
    let worker_concurrency = effective_config.scan.concurrency.max(1);
    let job_claim_lease_seconds = config.storage.redis_run_lease_seconds;
    let shared_store = Arc::new(store.clone());

    let task_results = stream::iter(0..worker_concurrency)
        .map(|_| {
            let store = shared_store.clone();
            let fetcher = fetcher.clone();
            let detectors = detectors.clone();
            let worker_id = worker_id.to_string();
            async move {
                claim_jobs_for_run(
                    store,
                    fetcher,
                    detectors,
                    run_id,
                    worker_id,
                    job_claim_lease_seconds,
                )
                .await
            }
        })
        .buffer_unordered(worker_concurrency)
        .collect::<Vec<_>>()
        .await;

    let mut notes = Vec::new();
    for result in task_results {
        match result {
            Ok(mut task_notes) => notes.append(&mut task_notes),
            Err(error) => notes.push(error.to_string()),
        }
    }
    Ok(notes)
}

async fn claim_jobs_for_run(
    store: Arc<AnyScanStore>,
    fetcher: Arc<Fetcher>,
    detectors: DetectorEngine,
    run_id: i64,
    worker_id: String,
    lease_seconds: u64,
) -> Result<Vec<String>> {
    let mut notes = Vec::new();
    loop {
        let Some(job) = store.claim_next_pending_job(run_id, &worker_id, lease_seconds)? else {
            break;
        };
        info!(run_id, job_id = job.id, worker_id = %worker_id, "claimed pending job");
        if let Err(error) = process_job(
            store.clone(),
            fetcher.clone(),
            detectors.clone(),
            worker_id.clone(),
            lease_seconds,
            job,
        )
        .await
        {
            notes.push(error.to_string());
        }
    }
    Ok(notes)
}

async fn process_job(
    store: Arc<AnyScanStore>,
    fetcher: Arc<Fetcher>,
    detectors: DetectorEngine,
    worker_id: String,
    lease_seconds: u64,
    job: ScanJobRecord,
) -> Result<()> {
    let (claim_shutdown_tx, claim_shutdown_rx) = oneshot::channel();
    let heartbeat_store = store.as_ref().clone();
    let heartbeat_worker_id = worker_id.clone();
    let job_id = job.id;
    let heartbeat_handle = tokio::spawn(async move {
        job_claim_heartbeat(
            heartbeat_store,
            heartbeat_worker_id,
            job_id,
            lease_seconds,
            claim_shutdown_rx,
        )
        .await
    });

    let outcome = async {
        let (findings_count, telemetry, terminal_error, fetch_error) = match fetcher
            .fetch_target(&job.target)
            .await
        {
            Ok(report) => {
                let TargetFetchReport {
                    documents,
                    discovered_paths,
                    mut telemetry,
                    errors,
                } = report;
                let mut findings_count = 0u64;
                let discovery_provenance = discovered_paths
                    .iter()
                    .map(|discovered_path| DiscoveryProvenanceRecord {
                        path: discovered_path.path.clone(),
                        source: discovered_path.source.clone(),
                        score: discovered_path.score,
                        depth: discovered_path.depth,
                        first_seen_at: None,
                        last_seen_at: None,
                    })
                    .collect::<Vec<_>>();
                if !discovery_provenance.is_empty() {
                    store
                        .merge_target_discovery_provenance(job.target.id, &discovery_provenance)?;
                }

                for document in &documents {
                    let matches = if detectors.has_external_packs() {
                        let detectors = detectors.clone();
                        let document = document.clone();
                        tokio::task::spawn_blocking(move || detectors.scan_document(&document))
                            .await
                            .map_err(|error| anyhow!("detector task failed: {error}"))?
                    } else {
                        detectors.scan_document(document)
                    };
                    for finding in matches {
                        if let Some(record) = store.record_finding_if_new(&NewFinding {
                            run_id: job.run_id,
                            target_id: job.target.id,
                            detector: finding.detector,
                            severity: finding.severity,
                            path: finding.path,
                            redacted_value: finding.redacted_value,
                            evidence: finding.evidence,
                            fingerprint: finding.fingerprint,
                        })? {
                            findings_count += 1;
                            merge_coverage_source_stat(
                                &mut telemetry.coverage_sources,
                                &document.coverage_source,
                                0,
                                0,
                                0,
                                0,
                                1,
                            );
                            store.append_event(
                                Some(job.run_id),
                                &ApiEvent::FindingRecorded { finding: record },
                            )?;
                        }
                    }
                }

                let terminal_error = if documents.is_empty() && !errors.is_empty() {
                    Some(errors.join(" | "))
                } else {
                    None
                };
                (findings_count, telemetry, terminal_error, None)
            }
            Err(error) => {
                let error_message = error.to_string();
                (
                    0,
                    FetchTelemetry::default(),
                    Some(error_message.clone()),
                    Some(error_message),
                )
            }
        };

        let completion_applied = store.mark_job_finished_if_owned(
            job.id,
            &worker_id,
            findings_count,
            &telemetry,
            terminal_error.as_deref(),
        )?;
        if !completion_applied {
            return Err(anyhow!(
                "job {} is no longer claimed by worker {} during completion",
                job.id,
                worker_id
            ));
        }

        let summary = store.summary(job.run_id)?;
        store.append_event(
            Some(job.run_id),
            &ApiEvent::StatsUpdated {
                run_id: job.run_id,
                summary,
            },
        )?;

        match fetch_error {
            Some(error) => Err(anyhow!(error)),
            None => Ok(()),
        }
    }
    .await;

    let _ = claim_shutdown_tx.send(());
    let heartbeat_result = match heartbeat_handle.await {
        Ok(result) => result,
        Err(error) => Err(anyhow!("job claim heartbeat task failed: {error}")),
    };

    match (outcome, heartbeat_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Err(error), Err(heartbeat_error)) => Err(error).context(format!(
            "job claim heartbeat also failed: {heartbeat_error}"
        )),
    }
}

async fn process_port_scan(
    config: &AppConfig,
    worker_runtime: &WorkerRuntime,
    worker_id: &str,
    store: &AnyScanStore,
    port_scan: PortScanRecord,
) -> Result<()> {
    let (claim_shutdown_tx, claim_shutdown_rx) = oneshot::channel();
    let heartbeat_store = store.clone();
    let heartbeat_worker_id = worker_id.to_string();
    let lease_seconds = config.storage.redis_run_lease_seconds;
    let port_scan_id = port_scan.id;
    let heartbeat_handle = tokio::spawn(async move {
        port_scan_claim_heartbeat(
            heartbeat_store,
            heartbeat_worker_id,
            port_scan_id,
            lease_seconds,
            claim_shutdown_rx,
        )
        .await
    });

    let outcome: Result<()> = async {
        if let Some(started) = store.mark_port_scan_started_if_queued(port_scan.id)? {
            store.append_event(None, &ApiEvent::PortScanStarted { port_scan: started })?;
        }

        let execution =
            execute_scanner_adapter(&port_scan, &worker_runtime.scanner_adapters).await?;
        let mut bootstrap_notes = create_bootstrap_candidates_for_port_scan(
            config,
            store,
            &port_scan,
            &execution.discovered_endpoints,
        )?;
        let imported = import_port_scan_targets(
            config,
            store,
            &port_scan,
            &execution.discovered_endpoints,
            &worker_runtime.importers,
        )?;
        let follow_on = queue_follow_on_run_for_targets(
            store,
            port_scan
                .requested_by
                .as_deref()
                .unwrap_or("port-scan-worker"),
            &imported.target_ids,
        )?;

        let mut notes = execution.notes;
        notes.append(&mut bootstrap_notes);
        notes.extend(imported.notes);
        if let Some(queued_run) = &follow_on {
            notes.push(format!(
                "queued follow-on run {} for {} target(s)",
                queued_run.run.id,
                imported.target_ids.len()
            ));
        }
        let notes = notes
            .into_iter()
            .filter(|note| !note.trim().is_empty())
            .collect::<Vec<_>>();
        let notes_text = join_notes(&notes);

        let completed = store
            .complete_port_scan_if_owned(
                port_scan.id,
                worker_id,
                execution.discovered_endpoints.len() as u64,
                imported.target_ids.len() as u64,
                follow_on.as_ref().map(|item| item.run.id),
                notes_text.as_deref(),
            )?
            .ok_or_else(|| {
                anyhow!(
                    "port scan {} is no longer claimed by worker {} during completion",
                    port_scan.id,
                    worker_id
                )
            })?;

        store.append_event(
            None,
            &ApiEvent::PortScanCompleted {
                port_scan: completed,
                queued_run: follow_on.as_ref().map(|item| item.run.clone()),
                summary: follow_on.as_ref().map(|item| item.summary.clone()),
            },
        )?;

        Ok(())
    }
    .await;

    if let Err(error) = &outcome {
        let error_message = error.to_string();
        if let Some(failed) =
            store.fail_port_scan_if_owned(port_scan.id, worker_id, Some(&error_message))?
        {
            store.append_event(
                None,
                &ApiEvent::PortScanFailed {
                    port_scan: failed,
                    error: error_message,
                },
            )?;
        }
    }

    let _ = claim_shutdown_tx.send(());
    let heartbeat_result = match heartbeat_handle.await {
        Ok(result) => result,
        Err(error) => Err(anyhow!("port scan claim heartbeat task failed: {error}")),
    };

    match (outcome, heartbeat_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Err(error), Err(heartbeat_error)) => Err(error).context(format!(
            "port scan claim heartbeat also failed: {heartbeat_error}"
        )),
    }
}

async fn process_bootstrap_job(
    config: &AppConfig,
    worker_runtime: &WorkerRuntime,
    worker_id: &str,
    store: &AnyScanStore,
    bootstrap_job: WorkerBootstrapJobClaim,
) -> Result<()> {
    let (claim_shutdown_tx, claim_shutdown_rx) = oneshot::channel();
    let heartbeat_store = store.clone();
    let heartbeat_worker_id = worker_id.to_string();
    let lease_seconds = config.storage.redis_run_lease_seconds;
    let bootstrap_job_id = bootstrap_job.job.id;
    let heartbeat_handle = tokio::spawn(async move {
        bootstrap_job_claim_heartbeat(
            heartbeat_store,
            heartbeat_worker_id,
            bootstrap_job_id,
            lease_seconds,
            claim_shutdown_rx,
        )
        .await
    });

    let outcome: Result<()> = async {
        let started = store
            .mark_bootstrap_job_started_if_owned(bootstrap_job.job.id, worker_id)?
            .ok_or_else(|| {
                anyhow!(
                    "bootstrap job {} is no longer claimed by worker {} during start",
                    bootstrap_job.job.id,
                    worker_id
                )
            })?;
        store.append_event(None, &ApiEvent::WorkerBootstrapJobStarted { job: started })?;

        let mut notes = bootstrap_job
            .job
            .notes
            .clone()
            .into_iter()
            .filter(|note| !note.trim().is_empty())
            .collect::<Vec<_>>();
        let mut execution_notes =
            execute_bootstrap_provisioner(&bootstrap_job, worker_id, &worker_runtime.provisioners)
                .await?;
        notes.append(&mut execution_notes);
        let notes_text = join_notes(&notes);

        let completed = store
            .complete_bootstrap_job_if_owned(
                bootstrap_job.job.id,
                worker_id,
                notes_text.as_deref(),
            )?
            .ok_or_else(|| {
                anyhow!(
                    "bootstrap job {} is no longer claimed by worker {} during completion",
                    bootstrap_job.job.id,
                    worker_id
                )
            })?;
        store.append_event(
            None,
            &ApiEvent::WorkerBootstrapJobCompleted { job: completed },
        )?;

        Ok(())
    }
    .await;

    if let Err(error) = &outcome {
        let error_message = error.to_string();
        let mut notes = bootstrap_job
            .job
            .notes
            .clone()
            .into_iter()
            .filter(|note| !note.trim().is_empty())
            .collect::<Vec<_>>();
        notes.push(error_message.clone());
        let notes_text = join_notes(&notes);
        if let Some(failed) = store.fail_bootstrap_job_if_owned(
            bootstrap_job.job.id,
            worker_id,
            notes_text.as_deref(),
        )? {
            store.append_event(
                None,
                &ApiEvent::WorkerBootstrapJobFailed {
                    job: failed,
                    error: error_message,
                },
            )?;
        }
    }

    let _ = claim_shutdown_tx.send(());
    let heartbeat_result = match heartbeat_handle.await {
        Ok(result) => result,
        Err(error) => Err(anyhow!(
            "bootstrap job claim heartbeat task failed: {error}"
        )),
    };

    match (outcome, heartbeat_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Err(error), Err(heartbeat_error)) => Err(error).context(format!(
            "bootstrap job claim heartbeat also failed: {heartbeat_error}"
        )),
    }
}

async fn execute_bootstrap_provisioner(
    bootstrap_job: &WorkerBootstrapJobClaim,
    worker_id: &str,
    provisioners: &[ExtensionManifest],
) -> Result<Vec<String>> {
    let provisioner = select_bootstrap_provisioner(provisioners, bootstrap_job)?;
    let command = provisioner
        .resolved_command()
        .ok_or_else(|| anyhow!("provisioner {} is missing a command", provisioner.name))?;
    let rendered_command = render_bootstrap_template(&command, bootstrap_job, provisioner);
    let rendered_args = provisioner
        .args
        .iter()
        .map(|arg| render_bootstrap_template(arg, bootstrap_job, provisioner))
        .collect::<Vec<_>>();
    let invocation = serde_json::to_vec(&ProvisionerInvocation {
        provisioner_name: &provisioner.name,
        executor_worker_id: worker_id,
        job: &bootstrap_job.job,
        candidate: &bootstrap_job.candidate,
        enrollment_token: &bootstrap_job.enrollment_token,
    })
    .context("failed to serialize bootstrap provisioner invocation")?;
    let provisioner_name = provisioner.name.clone();

    let output = tokio::task::spawn_blocking(move || {
        run_bootstrap_provisioner_process(rendered_command, rendered_args, invocation)
    })
    .await
    .map_err(|error| anyhow!("bootstrap provisioner task failed: {error}"))??;

    let status = output.status;
    if !status.success() {
        let status_label = status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_string());
        return Err(anyhow!(
            "bootstrap provisioner {} exited with status {}",
            provisioner_name,
            status_label
        ));
    }

    Ok(vec![format!(
        "provisioner {} completed on worker {}",
        provisioner_name, worker_id
    )])
}

fn run_bootstrap_provisioner_process(
    command: String,
    args: Vec<String>,
    invocation: Vec<u8>,
) -> Result<std::process::Output> {
    let mut child = ProcessCommand::new(&command)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to spawn bootstrap provisioner command {command}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&invocation)
            .context("failed to write bootstrap provisioner invocation")?;
    }

    child
        .wait_with_output()
        .context("failed to wait for bootstrap provisioner command")
}

fn select_bootstrap_provisioner<'a>(
    provisioners: &'a [ExtensionManifest],
    bootstrap_job: &WorkerBootstrapJobClaim,
) -> Result<&'a ExtensionManifest> {
    provisioners
        .iter()
        .find(|provisioner| {
            provisioner
                .name
                .eq_ignore_ascii_case(&bootstrap_job.job.provisioner)
        })
        .ok_or_else(|| {
            anyhow!(
                "bootstrap provisioner {} is not registered on this worker",
                bootstrap_job.job.provisioner
            )
        })
}

async fn execute_scanner_adapter(
    port_scan: &PortScanRecord,
    scanner_adapters: &[ExtensionManifest],
) -> Result<ScannerExecutionResult> {
    let adapter = select_scanner_adapter(scanner_adapters, port_scan)?;
    let command = adapter
        .resolved_command()
        .ok_or_else(|| anyhow!("scanner adapter {} is missing a command", adapter.name))?;
    let output_path = build_scanner_output_path(&adapter.name, port_scan.id);
    let rendered_command =
        render_scanner_template(&command, port_scan, Some(&output_path), adapter);
    let rendered_args = adapter
        .args
        .iter()
        .map(|value| render_scanner_template(value, port_scan, Some(&output_path), adapter))
        .collect::<Vec<_>>();
    let invocation = serde_json::to_vec(&ScannerAdapterInvocation {
        port_scan_id: port_scan.id,
        target_range: &port_scan.target_range,
        ports: &port_scan.ports,
        schemes: port_scan.schemes.as_str(),
        rate_limit: port_scan.rate_limit,
        requested_by: port_scan.requested_by.as_deref(),
        tags: &port_scan.tags,
        adapter_name: &adapter.name,
    })
    .context("failed to serialize scanner adapter invocation")?;
    let adapter_name = adapter.name.clone();
    let output_format = adapter.output_format().to_string();
    let output_path_for_process = output_path.clone();

    let output = tokio::task::spawn_blocking(move || {
        run_scanner_process(
            rendered_command,
            rendered_args,
            invocation,
            output_path_for_process,
        )
    })
    .await
    .map_err(|error| anyhow!("scanner adapter task failed: {error}"))??;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let status = output.status;
    if !status.success() {
        let status_label = status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_string());
        let stderr = stderr.trim();
        let detail = if stderr.is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.to_string()
        };
        return Err(anyhow!(
            "scanner adapter {} exited with status {}{}",
            adapter_name,
            status_label,
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ));
    }

    let raw_output = if output_path.exists() {
        let contents = fs::read_to_string(&output_path).with_context(|| {
            format!(
                "failed to read scanner adapter output file {}",
                output_path.display()
            )
        })?;
        let _ = fs::remove_file(&output_path);
        if contents.trim().is_empty() {
            stdout
        } else {
            contents
        }
    } else {
        stdout
    };
    let discovered_endpoints = parse_scanner_output(&raw_output, &port_scan.ports, &output_format)?;
    let mut notes = vec![format!(
        "adapter {} reported {} discovered endpoint(s)",
        adapter_name,
        discovered_endpoints.len()
    )];
    if !stderr.trim().is_empty() {
        notes.push(format!(
            "adapter stderr: {}",
            truncate_note(stderr.trim(), 240)
        ));
    }

    Ok(ScannerExecutionResult {
        discovered_endpoints,
        notes,
    })
}

fn run_scanner_process(
    command: String,
    args: Vec<String>,
    invocation: Vec<u8>,
    output_path: PathBuf,
) -> Result<std::process::Output> {
    let mut child = ProcessCommand::new(&command)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to spawn scanner adapter command {command}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&invocation)
            .context("failed to write scanner adapter invocation")?;
    }

    let output = child
        .wait_with_output()
        .context("failed to wait for scanner adapter command")?;

    if output_path.exists() && output.stdout.is_empty() {
        return Ok(output);
    }

    Ok(output)
}

fn select_scanner_adapter<'a>(
    scanner_adapters: &'a [ExtensionManifest],
    port_scan: &PortScanRecord,
) -> Result<&'a ExtensionManifest> {
    if scanner_adapters.is_empty() {
        return Err(anyhow!(
            "no enabled scanner_adapter extensions are configured for port scan {}",
            port_scan.id
        ));
    }

    if let Some(requested_adapter) = port_scan.tags.iter().find_map(|tag| {
        tag.strip_prefix("adapter:")
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }) {
        return scanner_adapters
            .iter()
            .find(|adapter| adapter.name.eq_ignore_ascii_case(requested_adapter))
            .ok_or_else(|| {
                anyhow!(
                    "requested scanner adapter {} is not registered on this worker",
                    requested_adapter
                )
            });
    }

    let mut tag_matches = scanner_adapters
        .iter()
        .filter(|adapter| {
            !adapter.tags.is_empty()
                && adapter.tags.iter().any(|tag| {
                    port_scan
                        .tags
                        .iter()
                        .any(|scan_tag| scan_tag.eq_ignore_ascii_case(tag))
                })
        })
        .collect::<Vec<_>>();
    if tag_matches.len() == 1 {
        return Ok(tag_matches.remove(0));
    }
    if tag_matches.len() > 1 {
        let candidates = tag_matches
            .into_iter()
            .map(|adapter| adapter.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(anyhow!(
            "multiple scanner adapters matched port scan tags: {candidates}"
        ));
    }

    scanner_adapters
        .first()
        .ok_or_else(|| anyhow!("scanner adapter list unexpectedly empty"))
}

fn render_bootstrap_template(
    template: &str,
    bootstrap_job: &WorkerBootstrapJobClaim,
    provisioner: &ExtensionManifest,
) -> String {
    let mut rendered = template.to_string();
    let job_id = bootstrap_job.job.id.to_string();
    let candidate_id = bootstrap_job.job.candidate_id.to_string();
    let discovered_port = bootstrap_job
        .job
        .discovered_port
        .map(|value| value.to_string())
        .unwrap_or_default();
    let worker_pool = bootstrap_job.job.worker_pool.clone().unwrap_or_default();
    let tag_csv = bootstrap_job.job.tags.join(",");
    let executor_worker_pool = bootstrap_job
        .job
        .executor_worker_pool
        .clone()
        .unwrap_or_default();
    let executor_tag_csv = bootstrap_job.job.executor_tags.join(",");
    let enrollment_token_id = bootstrap_job
        .job
        .enrollment_token_id
        .map(|value| value.to_string())
        .unwrap_or_default();

    for (needle, value) in [
        ("{{job_id}}", job_id.as_str()),
        ("{{candidate_id}}", candidate_id.as_str()),
        (
            "{{discovered_host}}",
            bootstrap_job.job.discovered_host.as_str(),
        ),
        ("{{discovered_port}}", discovered_port.as_str()),
        ("{{worker_pool}}", worker_pool.as_str()),
        ("{{tag_csv}}", tag_csv.as_str()),
        ("{{provisioner_name}}", provisioner.name.as_str()),
        ("{{executor_worker_pool}}", executor_worker_pool.as_str()),
        ("{{executor_tag_csv}}", executor_tag_csv.as_str()),
        ("{{enrollment_token_id}}", enrollment_token_id.as_str()),
    ] {
        rendered = rendered.replace(needle, value);
    }

    rendered
}

fn render_scanner_template(
    template: &str,
    port_scan: &PortScanRecord,
    output_path: Option<&Path>,
    adapter: &ExtensionManifest,
) -> String {
    let mut rendered = template.to_string();
    let tags_csv = port_scan.tags.join(",");
    let rate_limit = port_scan.rate_limit.to_string();
    let port_scan_id = port_scan.id.to_string();
    let output_path = output_path
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();

    for (needle, value) in [
        ("{{target_range}}", port_scan.target_range.as_str()),
        ("{{ports}}", port_scan.ports.as_str()),
        ("{{schemes}}", port_scan.schemes.as_str()),
        (
            "{{requested_by}}",
            port_scan.requested_by.as_deref().unwrap_or(""),
        ),
        ("{{tag_csv}}", tags_csv.as_str()),
        ("{{adapter_name}}", adapter.name.as_str()),
        ("{{rate_limit}}", rate_limit.as_str()),
        ("{{port_scan_id}}", port_scan_id.as_str()),
        ("{{output_path}}", output_path.as_str()),
    ] {
        rendered = rendered.replace(needle, value);
    }
    rendered
}

fn build_scanner_output_path(adapter_name: &str, port_scan_id: i64) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let safe_name = adapter_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    env::temp_dir().join(format!(
        "anyscan-{}-{}-{}.out",
        safe_name, port_scan_id, timestamp
    ))
}

fn parse_scanner_output(
    output: &str,
    requested_ports: &str,
    output_format: &str,
) -> Result<Vec<DiscoveredEndpoint>> {
    match output_format {
        "endpoint_lines" => parse_endpoint_lines(output, requested_ports),
        "json_lines" => parse_json_endpoint_lines(output, requested_ports),
        other => Err(anyhow!(
            "unsupported scanner adapter output format {}",
            other
        )),
    }
}

fn parse_endpoint_lines(output: &str, requested_ports: &str) -> Result<Vec<DiscoveredEndpoint>> {
    let fallback_port = single_requested_port(requested_ports)?;
    let mut discovered = Vec::new();
    let mut seen = HashSet::new();

    for line in output.lines() {
        let token = line.trim();
        if token.is_empty() || token.starts_with('#') {
            continue;
        }
        let Some(endpoint) = parse_endpoint_token(token, fallback_port)? else {
            continue;
        };
        if seen.insert((endpoint.host.clone(), endpoint.port)) {
            discovered.push(endpoint);
        }
    }

    Ok(discovered)
}

fn parse_json_endpoint_lines(
    output: &str,
    requested_ports: &str,
) -> Result<Vec<DiscoveredEndpoint>> {
    let fallback_port = single_requested_port(requested_ports)?;
    let mut discovered = Vec::new();
    let mut seen = HashSet::new();

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(line)
            .with_context(|| format!("invalid scanner adapter json line: {line}"))?;
        let host = value
            .get("host")
            .and_then(|value| value.as_str())
            .or_else(|| value.get("ip").and_then(|value| value.as_str()))
            .or_else(|| value.get("address").and_then(|value| value.as_str()))
            .ok_or_else(|| anyhow!("scanner adapter json line is missing host/ip/address"))?;
        let port = value
            .get("port")
            .and_then(|value| value.as_u64())
            .map(|value| value as u16)
            .or(fallback_port)
            .ok_or_else(|| anyhow!("scanner adapter json line is missing port"))?;
        let endpoint = DiscoveredEndpoint {
            host: host.to_string(),
            port,
        };
        if seen.insert((endpoint.host.clone(), endpoint.port)) {
            discovered.push(endpoint);
        }
    }

    Ok(discovered)
}

fn parse_endpoint_token(
    token: &str,
    fallback_port: Option<u16>,
) -> Result<Option<DiscoveredEndpoint>> {
    let token = token
        .split_whitespace()
        .next()
        .map(str::trim)
        .unwrap_or_default();
    if token.is_empty() {
        return Ok(None);
    }

    if let Ok(address) = token.parse::<SocketAddr>() {
        return Ok(Some(DiscoveredEndpoint {
            host: address.ip().to_string(),
            port: address.port(),
        }));
    }

    if let Ok(ip) = token.parse::<IpAddr>() {
        let port = fallback_port.ok_or_else(|| {
            anyhow!(
                "scanner adapter output line {} is missing a port and multiple ports were requested",
                token
            )
        })?;
        return Ok(Some(DiscoveredEndpoint {
            host: ip.to_string(),
            port,
        }));
    }

    if token.matches(':').count() == 1 {
        let (host, port) = token
            .rsplit_once(':')
            .ok_or_else(|| anyhow!("invalid scanner adapter endpoint {}", token))?;
        let port = port
            .parse::<u16>()
            .with_context(|| format!("invalid scanner adapter port in {}", token))?;
        return Ok(Some(DiscoveredEndpoint {
            host: host.trim().to_string(),
            port,
        }));
    }

    let port = fallback_port.ok_or_else(|| {
        anyhow!(
            "scanner adapter output line {} is missing a port and multiple ports were requested",
            token
        )
    })?;
    Ok(Some(DiscoveredEndpoint {
        host: token.to_string(),
        port,
    }))
}

fn single_requested_port(requested_ports: &str) -> Result<Option<u16>> {
    let ports = parse_port_scan_ports(requested_ports)?;
    Ok((ports.len() == 1).then_some(ports[0]))
}

fn import_port_scan_targets(
    config: &AppConfig,
    store: &AnyScanStore,
    port_scan: &PortScanRecord,
    discovered_endpoints: &[DiscoveredEndpoint],
    importers: &[ExtensionManifest],
) -> Result<ImportedTargetsResult> {
    let generated_targets = if importers.is_empty() {
        build_builtin_import_targets(port_scan, discovered_endpoints)
    } else {
        run_importers(port_scan, discovered_endpoints, importers)?
    };

    let mut target_ids = Vec::new();
    let mut notes = Vec::new();
    let mut normalized_targets = HashSet::new();
    let target_tags = normalized_port_scan_tags(&port_scan.tags);

    for generated_target in generated_targets {
        let generated_target = merge_imported_target_definition(generated_target, &target_tags);
        let target = config.normalize_target_definition(generated_target)?;
        if !normalized_targets.insert(target.base_url.clone()) {
            continue;
        }
        let record = store.upsert_target(&target)?;
        target_ids.push(record.id);
    }

    target_ids.sort_unstable();
    target_ids.dedup();
    notes.push(format!(
        "normalized {} target(s) from {} discovered endpoint(s)",
        target_ids.len(),
        discovered_endpoints.len()
    ));
    if !importers.is_empty() {
        notes.push(format!("applied {} importer extension(s)", importers.len()));
    }

    Ok(ImportedTargetsResult { target_ids, notes })
}

fn build_builtin_import_targets(
    port_scan: &PortScanRecord,
    discovered_endpoints: &[DiscoveredEndpoint],
) -> Vec<TargetDefinition> {
    let mut targets = Vec::new();
    let mut seen = HashSet::new();

    for endpoint in discovered_endpoints {
        for scheme in schemes_for_port_scan(port_scan.schemes, endpoint.port) {
            let base_url = format_target_base_url(&endpoint.host, endpoint.port, scheme);
            if !seen.insert(base_url.clone()) {
                continue;
            }
            targets.push(TargetDefinition {
                label: base_url.clone(),
                base_url,
                ..TargetDefinition::default()
            });
        }
    }

    targets
}

fn run_importers(
    port_scan: &PortScanRecord,
    discovered_endpoints: &[DiscoveredEndpoint],
    importers: &[ExtensionManifest],
) -> Result<Vec<TargetDefinition>> {
    let mut targets = Vec::new();
    for importer in importers {
        let mut importer_targets = run_importer(port_scan, discovered_endpoints, importer)?;
        targets.append(&mut importer_targets);
    }
    Ok(targets)
}

fn run_importer(
    port_scan: &PortScanRecord,
    discovered_endpoints: &[DiscoveredEndpoint],
    importer: &ExtensionManifest,
) -> Result<Vec<TargetDefinition>> {
    let command = importer
        .resolved_command()
        .ok_or_else(|| anyhow!("importer {} is missing a command", importer.name))?;
    let invocation = serde_json::to_vec(&ImporterInvocation {
        importer_name: &importer.name,
        port_scan,
        discovered_endpoints,
    })
    .context("failed to serialize importer invocation")?;

    let mut child = ProcessCommand::new(&command)
        .args(&importer.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to spawn importer {}", importer.name))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&invocation)
            .with_context(|| format!("failed to write importer input for {}", importer.name))?;
    }

    let output = child
        .wait_with_output()
        .with_context(|| format!("failed to wait for importer {}", importer.name))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!(
            "importer {} exited unsuccessfully{}",
            importer.name,
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    parse_importer_output(&stdout, importer)
}

fn parse_importer_output(
    output: &str,
    importer: &ExtensionManifest,
) -> Result<Vec<TargetDefinition>> {
    match importer.output_format() {
        "target_json_lines" => parse_target_json_lines(output),
        "target_url_lines" => parse_target_url_lines(output),
        other => Err(anyhow!(
            "importer {} uses unsupported output format {}",
            importer.name,
            other
        )),
    }
}

fn parse_target_json_lines(output: &str) -> Result<Vec<TargetDefinition>> {
    let mut targets = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let target: TargetDefinition = serde_json::from_str(line)
            .with_context(|| format!("invalid importer target JSON line: {line}"))?;
        targets.push(target);
    }
    Ok(targets)
}

fn parse_target_url_lines(output: &str) -> Result<Vec<TargetDefinition>> {
    let mut targets = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        targets.push(TargetDefinition {
            label: line.to_string(),
            base_url: line.to_string(),
            ..TargetDefinition::default()
        });
    }
    Ok(targets)
}

fn merge_imported_target_definition(
    mut target: TargetDefinition,
    inherited_tags: &[String],
) -> TargetDefinition {
    if target.label.trim().is_empty() {
        target.label = target.base_url.trim().to_string();
    }
    if !inherited_tags.is_empty() {
        for tag in inherited_tags {
            if !target
                .tags
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(tag))
            {
                target.tags.push(tag.clone());
            }
        }
    }
    target
}

fn normalized_port_scan_tags(tags: &[String]) -> Vec<String> {
    let mut normalized: Vec<String> = Vec::new();
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() || trimmed.starts_with("adapter:") {
            continue;
        }
        if !normalized
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(trimmed))
        {
            normalized.push(trimmed.to_string());
        }
    }
    normalized
}

fn schemes_for_port_scan(policy: PortScanSchemePolicy, port: u16) -> Vec<&'static str> {
    match policy {
        PortScanSchemePolicy::Http => vec!["http"],
        PortScanSchemePolicy::Https => vec!["https"],
        PortScanSchemePolicy::Both => vec!["http", "https"],
        PortScanSchemePolicy::Auto => {
            if matches!(port, 443 | 8443 | 9443 | 10443) {
                vec!["https"]
            } else {
                vec!["http"]
            }
        }
    }
}

fn format_target_base_url(host: &str, port: u16, scheme: &str) -> String {
    let host = match host.parse::<IpAddr>() {
        Ok(IpAddr::V6(_)) if !host.starts_with('[') => format!("[{host}]"),
        _ => host.to_string(),
    };
    format!("{scheme}://{host}:{port}")
}

fn queue_follow_on_run_for_targets(
    store: &AnyScanStore,
    requested_by: &str,
    target_ids: &[i64],
) -> Result<Option<QueuedFollowOnRun>> {
    if target_ids.is_empty() {
        return Ok(None);
    }

    let scope = normalize_run_scope(Some(RunScope {
        target_ids: target_ids.to_vec(),
        tags: Vec::new(),
        failed_only: false,
    }));
    let run = queue_run_with_event(store, requested_by, scope.as_ref())?;
    let summary = store.summary(run.id)?;
    Ok(Some(QueuedFollowOnRun { run, summary }))
}

fn join_notes(notes: &[String]) -> Option<String> {
    if notes.is_empty() {
        None
    } else {
        Some(notes.join(" | "))
    }
}

fn truncate_note(value: &str, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        value.to_string()
    } else {
        let prefix = value
            .chars()
            .take(max_len.saturating_sub(3))
            .collect::<String>();
        format!("{}...", prefix)
    }
}

async fn port_scan_claim_heartbeat(
    store: AnyScanStore,
    worker_id: String,
    port_scan_id: i64,
    lease_seconds: u64,
    mut shutdown: oneshot::Receiver<()>,
) -> Result<()> {
    let interval = run_claim_heartbeat_interval(lease_seconds);
    loop {
        tokio::select! {
            _ = &mut shutdown => return Ok(()),
            _ = tokio::time::sleep(interval) => {
                store.renew_port_scan_claim(port_scan_id, &worker_id, lease_seconds)?;
            }
        }
    }
}

async fn bootstrap_job_claim_heartbeat(
    store: AnyScanStore,
    worker_id: String,
    bootstrap_job_id: i64,
    lease_seconds: u64,
    mut shutdown: oneshot::Receiver<()>,
) -> Result<()> {
    let interval = run_claim_heartbeat_interval(lease_seconds);
    loop {
        tokio::select! {
            _ = &mut shutdown => return Ok(()),
            _ = tokio::time::sleep(interval) => {
                store.renew_bootstrap_job_claim(bootstrap_job_id, &worker_id, lease_seconds)?;
            }
        }
    }
}

async fn job_claim_heartbeat(
    store: AnyScanStore,
    worker_id: String,
    job_id: i64,
    lease_seconds: u64,
    mut shutdown: oneshot::Receiver<()>,
) -> Result<()> {
    let interval = run_claim_heartbeat_interval(lease_seconds);
    loop {
        tokio::select! {
            _ = &mut shutdown => return Ok(()),
            _ = tokio::time::sleep(interval) => {
                store.renew_job_claim(job_id, &worker_id, lease_seconds)?;
            }
        }
    }
}

async fn run_claim_heartbeat(
    store: AnyScanStore,
    worker_id: String,
    run_id: i64,
    lease_seconds: u64,
    mut shutdown: oneshot::Receiver<()>,
) -> Result<()> {
    let interval = run_claim_heartbeat_interval(lease_seconds);
    loop {
        tokio::select! {
            _ = &mut shutdown => return Ok(()),
            _ = tokio::time::sleep(interval) => {
                store.renew_run_claim(run_id, &worker_id, lease_seconds)?;
            }
        }
    }
}

fn run_claim_heartbeat_interval(lease_seconds: u64) -> Duration {
    Duration::from_secs(lease_seconds.saturating_div(3).max(1))
}

fn run_completion_poll_interval(lease_seconds: u64) -> Duration {
    Duration::from_secs(lease_seconds.saturating_div(6).max(1))
}

fn create_bootstrap_candidates_for_port_scan(
    config: &AppConfig,
    store: &AnyScanStore,
    port_scan: &PortScanRecord,
    discovered_endpoints: &[DiscoveredEndpoint],
) -> Result<Vec<String>> {
    if !port_scan.bootstrap_policy.is_enabled() || discovered_endpoints.is_empty() {
        return Ok(Vec::new());
    }

    let mut candidate_inputs = Vec::new();
    let mut skipped_outside_inventory = 0usize;
    for endpoint in discovered_endpoints {
        if !config.host_is_allowed(&endpoint.host) {
            skipped_outside_inventory += 1;
            continue;
        }
        candidate_inputs.push(WorkerBootstrapCandidateInput {
            discovered_host: endpoint.host.clone(),
            discovered_port: Some(endpoint.port),
        });
    }

    let created = store.create_bootstrap_candidates(port_scan, &candidate_inputs)?;
    for candidate in &created {
        store.append_event(
            None,
            &ApiEvent::WorkerBootstrapCandidateCreated {
                candidate: candidate.clone(),
            },
        )?;
    }

    let mut notes = Vec::new();
    if !created.is_empty() {
        notes.push(format!("queued {} bootstrap candidate(s)", created.len()));
    }
    if skipped_outside_inventory > 0 {
        notes.push(format!(
            "skipped {} discovered endpoint(s) outside approved inventory for bootstrap candidates",
            skipped_outside_inventory
        ));
    }
    Ok(notes)
}

fn register_worker_or_bail(
    store: &AnyScanStore,
    registration: &WorkerRegistration,
    ttl_seconds: u64,
) -> Result<()> {
    store
        .register_worker(registration, ttl_seconds)
        .with_context(|| format!("failed to register worker {}", registration.worker_id))?;
    Ok(())
}

fn build_worker_runtime(config: &AppConfig, worker_id: &str) -> Result<WorkerRuntime> {
    let manifests = config.enabled_extension_manifests()?;
    let scanner_adapters = manifests
        .iter()
        .filter(|manifest| manifest.is_scanner_adapter())
        .cloned()
        .collect::<Vec<_>>();
    let importers = manifests
        .iter()
        .filter(|manifest| manifest.is_importer())
        .cloned()
        .collect::<Vec<_>>();
    let provisioners = manifests
        .iter()
        .filter(|manifest| manifest.is_provisioner())
        .cloned()
        .collect::<Vec<_>>();
    let display_name = env::var("ANYSCAN_WORKER_NAME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            env::var("HOSTNAME")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        });
    let worker_pool = resolve_optional_env("ANYSCAN_WORKER_POOL");
    let enrollment_token = resolve_optional_env("ANYSCAN_WORKER_TOKEN")
        .or_else(|| resolve_optional_env("ANYSCAN_WORKER_ENROLLMENT_TOKEN"));
    let tags = resolve_worker_tags();
    let supports_bootstrap = resolve_worker_bootstrap_support() && !provisioners.is_empty();
    let registration = WorkerRegistration {
        worker_id: worker_id.to_string(),
        display_name,
        worker_pool,
        tags,
        supports_runs: true,
        supports_port_scans: !scanner_adapters.is_empty(),
        supports_bootstrap,
        scanner_adapters: scanner_adapters
            .iter()
            .map(|adapter| adapter.name.clone())
            .collect(),
        provisioners: provisioners
            .iter()
            .map(|provisioner| provisioner.name.clone())
            .collect(),
        enrollment_token,
    };

    Ok(WorkerRuntime {
        registration,
        scanner_adapters,
        importers,
        provisioners,
    })
}

fn resolve_worker_tags() -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    if let Ok(raw_tags) = env::var("ANYSCAN_WORKER_TAGS") {
        for tag in raw_tags.split(',') {
            let trimmed = tag.trim();
            if trimmed.is_empty() {
                continue;
            }
            if !tags
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(trimmed))
            {
                tags.push(trimmed.to_string());
            }
        }
    }
    tags
}

fn resolve_optional_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_worker_bootstrap_support() -> bool {
    resolve_bool_env("ANYSCAN_WORKER_SUPPORTS_BOOTSTRAP")
        .or_else(|| resolve_bool_env("ANYSCAN_WORKER_ENABLE_BOOTSTRAP"))
        .unwrap_or(false)
}

fn resolve_bool_env(name: &str) -> Option<bool> {
    let value = resolve_optional_env(name)?;
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn worker_registration_ttl_seconds(config: &AppConfig) -> u64 {
    config
        .storage
        .redis_run_lease_seconds
        .saturating_mul(4)
        .max(config.scan.poll_interval_seconds.saturating_mul(2))
        .max(30)
}

async fn worker_registration_heartbeat(
    store: AnyScanStore,
    registration: WorkerRegistration,
    ttl_seconds: u64,
    mut shutdown: oneshot::Receiver<()>,
) {
    let interval = Duration::from_secs(ttl_seconds.saturating_div(3).max(5));
    loop {
        if let Err(error) = store.register_worker(&registration, ttl_seconds) {
            error!(worker_id = %registration.worker_id, %error, "failed to register worker");
        }

        tokio::select! {
            _ = &mut shutdown => return,
            _ = tokio::time::sleep(interval) => {}
        }
    }
}

fn build_worker_id() -> String {
    if let Some(worker_id) = resolve_optional_env("ANYSCAN_WORKER_ID") {
        return worker_id;
    }
    env::var("HOSTNAME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("anyscan-worker-{}", std::process::id()))
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

fn queue_due_schedules_with_events(store: &AnyScanStore, limit: usize) -> Result<()> {
    for (schedule, run) in store.queue_due_schedule_runs(limit)? {
        let summary = store.summary(run.id)?;
        store.append_event(
            Some(run.id),
            &ApiEvent::RunQueued {
                run: run.clone(),
                summary,
            },
        )?;
        info!(
            schedule = %schedule.label,
            run_id = run.id,
            "queued recurring schedule run"
        );
    }
    Ok(())
}

fn queue_run_with_event(
    store: &AnyScanStore,
    requested_by: &str,
    scope: Option<&RunScope>,
) -> Result<ScanRunRecord> {
    let run = store.queue_run(Some(requested_by), scope)?;
    let summary = store.summary(run.id)?;
    store.append_event(
        Some(run.id),
        &ApiEvent::RunQueued {
            run: run.clone(),
            summary,
        },
    )?;
    Ok(run)
}

fn load_effective_runtime_config(
    base_config: &AppConfig,
    store: &AnyScanStore,
) -> Result<AppConfig> {
    let Some(scan_settings) = store.load_scan_settings()? else {
        return Ok(base_config.clone());
    };
    base_config.with_scan_defaults_summary(&scan_settings)
}

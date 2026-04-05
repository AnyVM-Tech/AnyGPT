async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status}`);
  }
  return response.json();
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return escapeHtml(parsed.href);
    }
  } catch {
    // not a valid URL
  }
  return '#';
}

function renderMetrics(summary) {
  const metrics = [
    ['Authorized assets only', summary.authorized_assets_only ? 'Yes' : 'No'],
    ['Tracked assets', String(summary.asset_count)],
    ['Open findings', String(summary.findings_open)],
    ['Critical findings', String(summary.critical_findings)],
    ['Disclosure queue', String(summary.disclosure_queue)],
    ['Compliance sources', String(summary.compliance_sources)],
    ['Testing methods', String(summary.testing_methodologies)],
    ['Intel records', String(summary.vulnerability_intelligence_items)],
  ];

  return metrics.map(([label, value]) => `
    <article class="metric">
      <span class="metric-label">${label}</span>
      <strong class="metric-value">${value}</strong>
    </article>
  `).join('');
}

function renderAssets(assets) {
  return `
    <ul class="list">
      ${assets.map((asset) => `
        <li class="card">
          <div class="card-row">
            <strong>${escapeHtml(asset.name)}</strong>
            <span class="pill pill-${escapeHtml(asset.authorization_state)}">${escapeHtml(asset.authorization_state)}</span>
          </div>
          <p>${escapeHtml(asset.kind)} · ${escapeHtml(asset.owner)}</p>
          ${asset.resource_scope ? `<p class="detail"><strong>Scope:</strong> ${escapeHtml(asset.resource_scope)}</p>` : ''}
          ${asset.authorization_basis ? `<p class="detail"><strong>Authorization basis:</strong> ${escapeHtml(asset.authorization_basis)}</p>` : ''}
          ${asset.authorization_reference ? `<p class="detail"><strong>Authorization proof:</strong> ${escapeHtml(asset.authorization_reference)}</p>` : ''}
          <p class="muted">${escapeHtml(asset.notes)}</p>
        </li>
      `).join('')}
    </ul>
  `;
}

function renderApprovedResources(resources) {
  return `
    <ul class="list">
      ${resources.map((item) => `
        <li class="card">
          <div class="card-row">
            <strong>${escapeHtml(item.resource.label)}</strong>
            <span class="pill pill-${escapeHtml(item.authorization_state)}">${escapeHtml(item.authorization_state)}</span>
          </div>
          <p>${escapeHtml(item.asset_name)} · ${escapeHtml(item.resource.resource_type)}</p>
          <p class="detail"><strong>Target:</strong> ${escapeHtml(item.resource.target)}</p>
          <p class="detail"><strong>Owner contact:</strong> ${escapeHtml(item.resource.owner_contact) || 'n/a'}</p>
          <p class="detail"><strong>Approval:</strong> ${escapeHtml(item.resource.approved_by) || 'n/a'} · ${escapeHtml(item.resource.approval_reference) || 'n/a'}</p>
          <p class="muted">${escapeHtml(item.resource.notes || item.authorization_basis)}</p>
        </li>
      `).join('')}
    </ul>
  `;
}

function renderFindings(findings) {
  return `
    <ul class="list">
      ${findings.map((finding) => `
        <li class="card">
          <div class="card-row">
            <strong>${escapeHtml(finding.title)}</strong>
            <span class="pill pill-${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</span>
          </div>
          <p>${escapeHtml(finding.source)} · ${escapeHtml(finding.status)}${finding.asset ? ` · ${escapeHtml(finding.asset.name)}` : ''}</p>
          <p class="muted">${escapeHtml(finding.summary)}</p>
          ${finding.report_status ? `<p class="detail"><strong>Report status:</strong> ${escapeHtml(finding.report_status)}</p>` : ''}
          ${finding.visibility ? `<p class="detail"><strong>Visibility:</strong> ${escapeHtml(finding.visibility)}${finding.grace_period_days ? ` · <strong>Grace window:</strong> ${escapeHtml(finding.grace_period_days)} day(s)` : ''}</p>` : ''}
          ${finding.evidence_summary ? `<p class="detail"><strong>Evidence:</strong> ${escapeHtml(finding.evidence_summary)}</p>` : ''}
          ${finding.remediation_owner ? `<p class="detail"><strong>Owner:</strong> ${escapeHtml(finding.remediation_owner)}</p>` : ''}
          ${finding.asset ? `<p class="detail"><strong>Authorization:</strong> ${escapeHtml(finding.asset.authorization_state)} · <strong>Risk:</strong> ${escapeHtml(finding.asset.exposure_risk)}</p>` : ''}
          ${finding.asset?.authorization_basis ? `<p class="detail"><strong>Basis:</strong> ${escapeHtml(finding.asset.authorization_basis)}</p>` : ''}
          ${finding.asset?.authorization_reference ? `<p class="detail"><strong>Proof:</strong> ${escapeHtml(finding.asset.authorization_reference)}</p>` : ''}
          ${finding.asset?.resource_scope ? `<p class="detail"><strong>Resource scope:</strong> ${escapeHtml(finding.asset.resource_scope)}</p>` : ''}
          <p class="meta">
            ${finding.needs_owner_confirmation ? 'Owner confirmation required' : 'Owner confirmed'}
            ·
            ${finding.needs_disclosure ? 'Disclosure queue' : 'No disclosure packet yet'}
          </p>
          ${finding.recipient_contacts?.length ? `<p class="detail"><strong>Recipients:</strong> ${finding.recipient_contacts.map(escapeHtml).join(', ')}</p>` : ''}
          ${finding.escalation_targets?.length ? `<p class="detail"><strong>Escalation:</strong> ${finding.escalation_targets.map(escapeHtml).join(', ')}</p>` : ''}
          ${finding.related_intelligence?.length ? `
            <div class="tag-row">
              ${finding.related_intelligence
                .map((item) => `<span class="tag tag-critical">${escapeHtml(item.cve_id)}</span>`)
                .join('')}
            </div>
          ` : ''}
          ${finding.recommended_methods?.length ? `
            <div class="tag-row">
              ${finding.recommended_methods
                .map((item) => `<span class="tag">${escapeHtml(item.title)}</span>`)
                .join('')}
            </div>
          ` : ''}
        </li>
      `).join('')}
    </ul>
  `;
}

function renderSources(sources) {
  return `
    <ul class="list">
      ${sources.map((source) => `
        <li class="card">
          <div class="card-row">
            <strong>${escapeHtml(source.title)}</strong>
            <span class="pill pill-generic">${escapeHtml(source.category)}</span>
          </div>
          <p class="muted">${escapeHtml(source.requirement)}</p>
          <p>${escapeHtml(source.product_response)}</p>
          <a href="${safeHref(source.url)}" target="_blank" rel="noreferrer">Open source</a>
        </li>
      `).join('')}
    </ul>
  `;
}

function renderTestingMethodologies(methods) {
  return `
    <ul class="list">
      ${methods.map((method) => `
        <li class="card">
          <div class="card-row">
            <strong>${escapeHtml(method.title)}</strong>
            <span class="pill pill-generic">${escapeHtml(method.category)}</span>
          </div>
          <p class="muted">${escapeHtml(method.objective)}</p>
          <p><strong>Safety posture:</strong> ${escapeHtml(method.safety_posture)}</p>
          <p><strong>Evidence:</strong> ${method.evidence_outputs.map(escapeHtml).join(', ')}</p>
        </li>
      `).join('')}
    </ul>
  `;
}

function renderVulnerabilityIntelligence(items) {
  return `
    <ul class="list">
      ${items.map((item) => `
        <li class="card">
          <div class="card-row">
            <strong>${escapeHtml(item.cve_id)}</strong>
            <span class="pill pill-${item.risk_signal === 'known-exploited' ? 'critical' : 'medium'}">${escapeHtml(item.source_catalog)}</span>
          </div>
          <p>${escapeHtml(item.title)}</p>
          <p class="muted">${escapeHtml(item.vendor)} · ${escapeHtml(item.product)} · ${escapeHtml(item.weakness)}</p>
          <p>${escapeHtml(item.remediation_focus)}</p>
          <a href="${safeHref(item.public_reference_url)}" target="_blank" rel="noreferrer">Open reference</a>
        </li>
      `).join('')}
    </ul>
  `;
}

function renderProductBrief(productBrief) {
  return `
    <section class="panel product-brief">
      <header>
        <h2>${escapeHtml(productBrief.name)}</h2>
        <p>${escapeHtml(productBrief.positioning)}</p>
      </header>
      <div class="panel-grid">
        <section>
          <h3>Guardrails</h3>
          <ul class="list">
            ${productBrief.guardrails.map((item) => `<li class="card"><p>${escapeHtml(item)}</p></li>`).join('')}
          </ul>
        </section>
        <section>
          <h3>Next Steps</h3>
          <ul class="list">
            ${productBrief.next_steps.map((item) => `<li class="card"><p>${escapeHtml(item)}</p></li>`).join('')}
          </ul>
        </section>
      </div>
    </section>
  `;
}

function renderApprovedScanResults(results) {
  return `
    <ul class="list">
      ${results.map((result) => `
        <li class="card">
          <div class="card-row">
            <strong>${escapeHtml(result.resource.label)}</strong>
            <span class="pill pill-generic">${escapeHtml(result.reachability)}</span>
          </div>
          <p>${escapeHtml(result.asset_name)} · ${escapeHtml(result.resource.target)}</p>
          <p class="detail"><strong>Checked:</strong> ${escapeHtml(result.checked_at)}</p>
          ${result.final_url ? `<p class="detail"><strong>Final URL:</strong> ${escapeHtml(result.final_url)}</p>` : ''}
          ${result.http_status ? `<p class="detail"><strong>HTTP status:</strong> ${escapeHtml(result.http_status)}</p>` : ''}
          ${result.page_title ? `<p class="detail"><strong>Page title:</strong> ${escapeHtml(result.page_title)}</p>` : ''}
          ${result.server_header ? `<p class="detail"><strong>Server:</strong> ${escapeHtml(result.server_header)}</p>` : ''}
          ${result.resolved_ips?.length ? `<p class="detail"><strong>Resolved IPs:</strong> ${result.resolved_ips.map(escapeHtml).join(', ')}</p>` : ''}
          ${result.security_txt ? `<p class="detail"><strong>security.txt:</strong> ${escapeHtml(result.security_txt.status)}${result.security_txt.contact ? ` · ${escapeHtml(result.security_txt.contact)}` : ''}</p>` : ''}
          ${result.notes?.length ? `<p class="muted">${result.notes.map(escapeHtml).join(' | ')}</p>` : ''}
        </li>
      `).join('')}
    </ul>
  `;
}

function recommendationSupportCount(recommendation) {
  const sourceSpecific = [
    ...(recommendation.supporting_item_ids || []),
    ...(recommendation.supporting_video_ids || []),
    ...(recommendation.supporting_page_ids || []),
  ];
  return new Set(sourceSpecific).size;
}

function renderRestoreNotice(lane) {
  if (!lane?.restored_reason) {
    return '';
  }

  const lastAttempt = lane?.last_attempt && typeof lane.last_attempt === 'object'
    ? lane.last_attempt
    : null;

  const attemptBits = [];
  if (lastAttempt?.generated_at) attemptBits.push(`Attempted ${escapeHtml(lastAttempt.generated_at)}`);
  if (lastAttempt?.status) attemptBits.push(`status ${escapeHtml(lastAttempt.status)}`);
  if (typeof lastAttempt?.transcribed_video_count === 'number') attemptBits.push(`${lastAttempt.transcribed_video_count} transcribed`);
  if (typeof lastAttempt?.ingested_page_count === 'number') attemptBits.push(`${lastAttempt.ingested_page_count} ingested`);

  return `
    <div class="card">
      <div class="card-row">
        <strong>Last Good Snapshot Restored</strong>
        <span class="pill pill-generic">rollback</span>
      </div>
      ${lane?.restored_at ? `<p class="detail"><strong>Restored at:</strong> ${escapeHtml(lane.restored_at)}</p>` : ''}
      <p class="muted">${escapeHtml(lane.restored_reason)}</p>
      ${attemptBits.length ? `<p class="detail"><strong>Last attempt:</strong> ${attemptBits.join(' · ')}</p>` : ''}
    </div>
  `;
}

function renderSuggestedPathsBySource(recommendation) {
  const mapping = recommendation?.suggested_paths_by_source;
  if (!mapping || typeof mapping !== 'object') {
    return '';
  }

  const entries = Object.entries(mapping).filter(([, paths]) => Array.isArray(paths) && paths.length > 0);
  if (!entries.length) {
    return '';
  }

  return entries.map(([source, paths]) => `
    <p class="detail"><strong>${escapeHtml(source)} paths:</strong> ${paths.map(escapeHtml).join(', ')}</p>
  `).join('');
}

function renderRankingLegend(lane) {
  const legend = lane?.importance_legend && typeof lane.importance_legend === 'object'
    ? lane.importance_legend
    : {};
  const parts = [
    ['article', legend.article],
    ['landing page', legend.landing_page],
    ['discovered internal page', legend.discovered_internal_link],
    ['blog index', legend.blog_index],
    ['category archive', legend.category_archive],
  ].filter(([, value]) => typeof value === 'number');
  const weightText = parts.length
    ? parts.map(([label, value]) => `${label} ${Number(value).toFixed(1)}`).join(' · ')
    : 'article 1.0 · landing page 0.8 · discovered internal page 0.6 · blog index 0.5 · category archive 0.4';
  const scoreDescription = lane?.weighted_score_description || 'Weighted recommendation score favors richer source pages over aggregate or navigational ones.';

  return `
    <div class="card">
      <div class="card-row">
        <strong>Ranking Legend</strong>
        <span class="pill pill-generic">weights</span>
      </div>
      <p class="muted">${escapeHtml(scoreDescription)}</p>
      <p class="detail"><strong>Page importance:</strong> ${weightText}</p>
      <p class="detail"><strong>Weighted score:</strong> merged recommendation strength after applying the page importance weights above.</p>
    </div>
  `;
}

function renderYoutubeAcquisitionDetail(video) {
  if (video?.transcript_cache_hit) {
    if (video?.retry_recovered) {
      return `cache hit · originally recovered after ${video.retry_attempt_count} attempts (${Number(video.retry_backoff_seconds || 0).toFixed(1)}s backoff)`;
    }
    if (typeof video?.retry_attempt_count === 'number' && video.retry_attempt_count > 0) {
      return `cache hit · originally first try (${video.retry_attempt_count} attempt)`;
    }
    return 'cache hit';
  }
  if (video?.retry_recovered) {
    return `recovered after ${video.retry_attempt_count} attempts (${Number(video.retry_backoff_seconds || 0).toFixed(1)}s backoff)`;
  }
  if (typeof video?.retry_attempt_count === 'number' && video.retry_attempt_count > 0) {
    return `first try (${video.retry_attempt_count} attempt)`;
  }
  if (video?.transcript_status === 'failed') {
    return 'failed before transcript capture';
  }
  return '';
}

function renderRecommendationCards(recommendations) {
  return `
    <ul class="list">
      ${recommendations.map((recommendation) => `
        <li class="card">
          <div class="card-row">
            <strong>${escapeHtml(recommendation.title)}</strong>
            <span class="pill pill-${escapeHtml(recommendation.priority || 'generic')}">${escapeHtml(recommendation.priority || 'info')}</span>
          </div>
          <p>${escapeHtml(recommendation.rationale)}</p>
          <p class="detail"><strong>Signals:</strong> ${recommendation.signal_count}</p>
          ${typeof recommendation.weighted_signal_score === 'number' && recommendation.weighted_signal_score > 0 ? `<p class="detail"><strong>Weighted score:</strong> ${recommendation.weighted_signal_score.toFixed(1)}</p>` : ''}
          ${recommendation.source_count ? `<p class="detail"><strong>Sources:</strong> ${recommendation.source_count}</p>` : ''}
          ${recommendation.suggested_paths?.length ? `<p class="detail"><strong>Suggested paths:</strong> ${recommendation.suggested_paths.map(escapeHtml).join(', ')}</p>` : ''}
          ${renderSuggestedPathsBySource(recommendation)}
          ${recommendation.supporting_source_types?.length ? `<p class="muted">Backed by ${recommendation.supporting_source_types.map(escapeHtml).join(', ')}.</p>` : ''}
          ${recommendationSupportCount(recommendation) ? `<p class="muted">Linked items: ${recommendationSupportCount(recommendation)}</p>` : ''}
        </li>
      `).join('')}
    </ul>
  `;
}

function renderImplementationLane(lane) {
  const coverage = lane?.coverage || {};
  const recommendations = lane?.recommendations || [];
  const metrics = [
    ['Status', lane?.status || 'unknown'],
    ['Website targets', String(coverage.website_target_count || 0)],
    ['Website pages', String(coverage.website_page_count || 0)],
    ['Website discovered', String(coverage.website_discovered_page_count || 0)],
    ['Website ingested', String(coverage.website_ingested_page_count || 0)],
    ['YouTube videos', String(coverage.youtube_video_count || 0)],
    ['YouTube transcribed', String(coverage.youtube_transcribed_video_count || 0)],
  ];

  return `
    ${renderRestoreNotice(lane)}
    ${renderRankingLegend(lane)}
    <div class="metrics compact-metrics">
      ${metrics.map(([label, value]) => `
        <article class="metric">
          <span class="metric-label">${label}</span>
          <strong class="metric-value">${value}</strong>
        </article>
      `).join('')}
    </div>
    ${lane?.generated_at ? `<p class="muted">Generated ${escapeHtml(lane.generated_at)}</p>` : ''}
    ${recommendations.length ? renderRecommendationCards(recommendations) : `
      <div class="card">
        <p class="muted">No merged implementation recommendations are available yet. Run <code>bash apps/exposure-studio/run.sh implementation-lane</code>.</p>
      </div>
    `}
  `;
}

function renderWebsiteLanePages(lane) {
  const pages = lane?.pages || [];
  if (!pages.length) {
    return `
      <div class="card">
        <p class="muted">No website research documents have been indexed yet. Run <code>bash apps/exposure-studio/run.sh website-lane</code>.</p>
      </div>
    `;
  }

  return `
    ${renderRestoreNotice(lane)}
    ${renderRankingLegend(lane)}
    <p class="muted">
      ${lane?.generated_at ? `Generated ${escapeHtml(lane.generated_at)} · ` : ''}
      ${typeof lane?.target_count === 'number' ? `${lane.target_count} targets` : ''}
      ${typeof lane?.page_count === 'number' ? ` · ${lane.page_count} pages` : ''}
      ${typeof lane?.discovered_page_count === 'number' ? ` · ${lane.discovered_page_count} discovered` : ''}
    </p>
    <ul class="list">
      ${pages.slice(0, 12).map((page) => `
        <li class="card">
          <div class="card-row">
            <strong>${escapeHtml(page.title)}</strong>
            <span class="pill pill-${page.fetch_status === 'ok' ? 'owned' : 'high'}">${escapeHtml(page.fetch_status)}</span>
          </div>
          <p>${escapeHtml(page.category || 'website')}${page.http_status ? ` · HTTP ${escapeHtml(page.http_status)}` : ''}${page.text_word_count ? ` · ${page.text_word_count} words` : ''}${typeof page.crawl_depth === 'number' ? ` · depth ${page.crawl_depth}` : ''}</p>
          ${typeof page.importance_score === 'number' && page.importance_score > 0 ? `<p class="detail"><strong>Importance:</strong> ${page.importance_score.toFixed(1)}</p>` : ''}
          ${page.discovered_from_page_id ? `<p class="detail"><strong>Discovered from:</strong> ${escapeHtml(page.discovered_from_page_id)}</p>` : `<p class="detail"><strong>Seed target:</strong> ${escapeHtml(page.seed_target_id || page.page_id)}</p>`}
          ${page.implementation_notes?.length ? `<p class="detail"><strong>Implementation notes:</strong> ${page.implementation_notes.map(escapeHtml).join(' | ')}</p>` : ''}
          ${page.evidence_snippets?.length ? `<p class="muted">${page.evidence_snippets.map(escapeHtml).join(' | ')}</p>` : ''}
          ${page.error_summary ? `<p class="muted">${escapeHtml(page.error_summary)}</p>` : ''}
          ${page.implementation_signals?.length ? `
            <div class="tag-row">
              ${page.implementation_signals.map((signal) => `<span class="tag">${escapeHtml(signal)}</span>`).join('')}
            </div>
          ` : ''}
          ${page.url ? `<a href="${safeHref(page.url)}" target="_blank" rel="noreferrer">Open page</a>` : ''}
        </li>
      `).join('')}
    </ul>
  `;
}

function renderYouTubeLaneRecommendations(lane) {
  const recommendations = lane?.recommendations || [];
  const blockedHint = typeof lane?.failed_video_count === 'number'
    && lane.failed_video_count > 0
    && lane.transcribed_video_count === 0
    ? `
      <div class="card">
        <p class="muted">
          Transcript acquisition is currently blocked on this machine. Configure
          <code>YOUTUBE_LANE_COOKIES_FILE</code> or <code>YOUTUBE_LANE_PROXY</code>, run
          <code>bash apps/exposure-studio/run.sh youtube-lane doctor</code>, then rerun
          <code>bash apps/exposure-studio/run.sh youtube-lane</code>.
        </p>
      </div>
    `
    : '';
  if (!recommendations.length) {
    return `
      ${blockedHint}
      <div class="card">
        <p class="muted">No transcript-backed lane output has been generated yet. Run the youtube lane refresh command to populate this panel.</p>
      </div>
    `;
  }

  const meta = [
    lane?.generated_at ? `Generated ${escapeHtml(lane.generated_at)}` : '',
    lane?.model_name ? `Model ${escapeHtml(lane.model_name)}` : '',
    typeof lane?.transcribed_video_count === 'number' ? `${lane.transcribed_video_count} transcribed` : '',
  ].filter(Boolean);

  return `
    ${blockedHint}
    ${renderRestoreNotice(lane)}
    ${meta.length ? `<p class="muted">${meta.join(' · ')}</p>` : ''}
    ${renderRecommendationCards(recommendations)}
  `;
}

function renderYouTubeLaneVideos(lane) {
  const videos = lane?.videos || [];
  if (!videos.length) {
    return `
      <div class="card">
        <p class="muted">No transcript-backed videos have been indexed yet.</p>
      </div>
    `;
  }

  return `
    <ul class="list">
      ${videos.slice(0, 12).map((video) => `
        <li class="card">
          <div class="card-row">
            <strong>${escapeHtml(video.title)}</strong>
            <span class="pill pill-${video.transcript_status === 'complete' ? 'owned' : 'high'}">${escapeHtml(video.transcript_status)}</span>
          </div>
          <p>${escapeHtml(video.published_at || 'unknown publish date')}${video.duration_text ? ` · ${escapeHtml(video.duration_text)}` : ''}${video.transcript_language ? ` · ${escapeHtml(video.transcript_language)}` : ''}${video.transcript_source ? ` · ${escapeHtml(video.transcript_source)}` : ''}</p>
          <p class="detail"><strong>Transcript words:</strong> ${video.transcript_word_count}</p>
          ${renderYoutubeAcquisitionDetail(video) ? `<p class="detail"><strong>Acquisition:</strong> ${renderYoutubeAcquisitionDetail(video)}</p>` : ''}
          ${video.implementation_notes?.length ? `<p class="detail"><strong>Implementation notes:</strong> ${video.implementation_notes.map(escapeHtml).join(' | ')}</p>` : ''}
          ${video.evidence_snippets?.length ? `<p class="muted">${video.evidence_snippets.map(escapeHtml).join(' | ')}</p>` : ''}
          ${video.error_summary ? `<p class="muted">${escapeHtml(video.error_summary)}</p>` : ''}
          ${video.implementation_signals?.length ? `
            <div class="tag-row">
              ${video.implementation_signals.map((signal) => `<span class="tag">${escapeHtml(signal)}</span>`).join('')}
            </div>
          ` : ''}
          ${video.video_url ? `<a href="${safeHref(video.video_url)}" target="_blank" rel="noreferrer">Open video</a>` : ''}
        </li>
      `).join('')}
    </ul>
  `;
}

function renderWorkflowHighlights(assets, findings) {
  const ownedAssets = assets.filter((asset) => asset.authorization_state === 'owned').length;
  const delegatedAssets = assets.filter((asset) => asset.authorization_state === 'delegated').length;
  const ownerConfirmationQueue = findings.filter((finding) => finding.needs_owner_confirmation).length;
  const disclosureQueue = findings.filter((finding) => finding.needs_disclosure).length;
  const metrics = [
    ['Owned assets', String(ownedAssets)],
    ['Delegated assets', String(delegatedAssets)],
    ['Owner confirmations', String(ownerConfirmationQueue)],
    ['Disclosure-ready findings', String(disclosureQueue)],
  ];

  return `
    <section class="panel workflow-highlights">
      <header>
        <h2>Workflow Highlights</h2>
        <p>What the team should verify next in the authorized exposure workflow.</p>
      </header>
      <div class="metrics compact-metrics">
        ${metrics.map(([label, value]) => `
          <article class="metric">
            <span class="metric-label">${label}</span>
            <strong class="metric-value">${value}</strong>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function renderOperatorChecklist(summary, findings, methods, intel) {
  const disclosureQueue = findings.filter((finding) => finding.needs_disclosure).length;
  const ownerConfirmations = findings.filter((finding) => finding.needs_owner_confirmation).length;
  const checklist = [
    ['Triage critical findings', summary.critical_findings > 0 ? `${summary.critical_findings} critical finding(s) need remediation sequencing.` : 'No critical findings are currently open.'],
    ['Prepare disclosure packets', disclosureQueue > 0 ? `${disclosureQueue} finding(s) are marked for disclosure-safe follow-up.` : 'No disclosure packets are currently required.'],
    ['Confirm asset ownership', ownerConfirmations > 0 ? `${ownerConfirmations} finding(s) still need owner confirmation before escalation.` : 'All current findings have an assigned owner confirmation state.'],
    ['Validate testing coverage', methods.length > 0 ? `${methods.length} approved testing methodology record(s) are available for safe verification.` : 'Testing methodology coverage still needs to be documented.'],
    ['Track public intelligence', intel.length > 0 ? `${intel.length} vulnerability intelligence record(s) are linked for remediation context.` : 'No public vulnerability intelligence has been linked yet.'],
  ];

  return `
    <section class="panel operator-checklist">
      <header>
        <h2>Operator Checklist</h2>
        <p>Concrete next actions for asset owners, remediation leads, and disclosure coordinators.</p>
      </header>
      <ul class="list">
        ${checklist.map(([title, detail]) => `
          <li class="card">
            <div class="card-row">
              <strong>${title}</strong>
              <span class="pill pill-generic">action</span>
            </div>
            <p>${detail}</p>
          </li>
        `).join('')}
      </ul>
    </section>
  `;
}

async function boot() {
  const [summary, assets, findings, enrichedFindings, sources, methods, intel, productBrief, approvedResources, approvedScanResults, websiteLane, youtubeLane, implementationLane] = await Promise.all([
    loadJson('/api/summary'),
    loadJson('/api/assets'),
    loadJson('/api/findings'),
    loadJson('/api/findings/enriched'),
    loadJson('/api/compliance/sources'),
    loadJson('/api/testing-methodologies'),
    loadJson('/api/vulnerability-intelligence'),
    loadJson('/api/product-brief'),
    loadJson('/api/assets/approved-resources'),
    loadJson('/api/scans/approved'),
    loadJson('/api/research/website-lane'),
    loadJson('/api/research/youtube-lane'),
    loadJson('/api/research/implementation-lane'),
  ]);

  document.getElementById('metrics').innerHTML = renderMetrics(summary);
  document.getElementById('assets').innerHTML = renderAssets(assets);
  document.getElementById('findings').innerHTML = renderFindings(enrichedFindings);
  document.getElementById('approved-resources').innerHTML = renderApprovedResources(approvedResources);
  document.getElementById('approved-scan-results').innerHTML = renderApprovedScanResults(approvedScanResults);
  document.getElementById('sources').innerHTML = renderSources(sources);
  document.getElementById('methods').innerHTML = renderTestingMethodologies(methods);
  document.getElementById('intel').innerHTML = renderVulnerabilityIntelligence(intel);
  document.getElementById('implementation-lane').innerHTML = renderImplementationLane(implementationLane);
  document.getElementById('website-lane-pages').innerHTML = renderWebsiteLanePages(websiteLane);
  document.getElementById('youtube-lane-recommendations').innerHTML = renderYouTubeLaneRecommendations(youtubeLane);
  document.getElementById('youtube-lane-videos').innerHTML = renderYouTubeLaneVideos(youtubeLane);

  const hero = document.querySelector('.hero');
  if (hero && !document.querySelector('.product-brief')) {
    hero.insertAdjacentHTML('afterend', renderProductBrief(productBrief));
    hero.insertAdjacentHTML('afterend', renderWorkflowHighlights(assets, findings));
    hero.insertAdjacentHTML('afterend', renderOperatorChecklist(summary, findings, methods, intel));
  }
}

boot().catch((error) => {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="error-banner">Failed to load SurfaceScope demo data: ${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`,
  );
});

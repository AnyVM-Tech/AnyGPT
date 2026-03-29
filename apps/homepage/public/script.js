/**
 * AnyGPT Homepage — Keycloak SSO check & dynamic auth buttons
 *
 * Uses keycloak-js to silently check if the user has an active Keycloak session.
 * Based on the result, renders either Login/Sign Up buttons or a Dashboard button.
 */

const KEYCLOAK_URL = 'https://auth.anyvm.tech';
const KEYCLOAK_REALM = 'anyvm';
const KEYCLOAK_CLIENT_ID = 'AnyGPT';
const DASHBOARD_URL = '/c/new';   // LibreChat new-chat page
const LOGIN_URL = '/login';        // LibreChat login (has Keycloak button)
const DOCS_URL = '/openapi.json';
const LIVE_METRICS_URL = '/api/live-metrics';
const LIVE_METRICS_REFRESH_MS = 30_000;
const LIVE_METRICS_REDUCED_MOTION_REFRESH_MS = 60_000;
const LIVE_METRICS_REQUEST_TIMEOUT_MS = 8_000;
const THEME_COLOR_DEFAULT = '#041140';
const THEME_COLOR_HERO = '#010827';
const DEFAULT_PAGE_TITLE = 'AnyGPT — Unified AI Workspace';
const AUTHENTICATED_PAGE_TITLE = 'AnyGPT Workspace';
const HIDDEN_PAGE_TITLE = 'AnyGPT — Come back to your workspace';
const DASHBOARD_STORAGE_KEYS = ['anygpt:last-dashboard-url', 'librechat:last-dashboard-url'];
const DARK_COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)';
let liveMetricsRequestInFlight = false;
let liveMetricsPollHandle = null;
let liveMetricsVisibilityBound = false;
let liveMetricsNetworkBound = false;
let liveMetricsPageLifecycleBound = false;
let liveMetricsMotionBound = false;
let liveMetricsAbortController = null;
let liveMetricsMotionQuery = null;
let themeColorObserver = null;
let colorSchemeThemeColorBound = false;
let colorSchemeThemeQuery = null;
let pageVisibilityTitleBound = false;
let currentPageTitleBase = DEFAULT_PAGE_TITLE;

function browserIsOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function updatePageTitle() {
  if (typeof document === 'undefined') return;
  document.title = document.visibilityState === 'hidden'
    ? HIDDEN_PAGE_TITLE
    : currentPageTitleBase;
}

function setPageTitleBase(title) {
  currentPageTitleBase = title || DEFAULT_PAGE_TITLE;
  updatePageTitle();
}

function bindPageTitleVisibilityHandling() {
  if (typeof document === 'undefined' || pageVisibilityTitleBound) {
    return;
  }

  document.addEventListener('visibilitychange', () => {
    updatePageTitle();
  });
  pageVisibilityTitleBound = true;
}

function canPollLiveMetrics() {
  const pageVisible = typeof document === 'undefined' || document.visibilityState === 'visible';
  const networkAvailable = typeof navigator === 'undefined' || navigator.onLine !== false;
  return pageVisible && networkAvailable;
}

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function getLiveMetricsRefreshMs() {
  return prefersReducedMotion()
    ? LIVE_METRICS_REDUCED_MOTION_REFRESH_MS
    : LIVE_METRICS_REFRESH_MS;
}

function restartLiveMetricsPolling({ immediate = false } = {}) {
  if (liveMetricsPollHandle) {
    clearTimeout(liveMetricsPollHandle);
    liveMetricsPollHandle = null;
  }

  if (!canPollLiveMetrics()) {
    if (liveMetricsAbortController) {
      liveMetricsAbortController.abort();
      liveMetricsAbortController = null;
    }
    liveMetricsRequestInFlight = false;
    return;
  }

  if (immediate) {
    void refreshLiveMetrics();
    return;
  }

  liveMetricsPollHandle = window.setTimeout(() => {
    liveMetricsPollHandle = null;
    void refreshLiveMetrics();
  }, getLiveMetricsRefreshMs());
}

function bindLiveMetricsVisibilityHandling() {
  if (typeof document !== 'undefined' && !liveMetricsVisibilityBound) {
    document.addEventListener('visibilitychange', () => {
      restartLiveMetricsPolling({ immediate: document.visibilityState === 'visible' });
    });
    liveMetricsVisibilityBound = true;
  }

  if (typeof window !== 'undefined' && !liveMetricsNetworkBound) {
    window.addEventListener('online', () => {
      restartLiveMetricsPolling({ immediate: true });
    });
    window.addEventListener('offline', () => {
      restartLiveMetricsPolling({ immediate: false });
    });
    liveMetricsNetworkBound = true;
  }
}

function formatMetricCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
  }).format(num);
}

function formatCompactMetric(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';

  if (Math.abs(num) < 1000) {
    return formatMetricCount(num);
  }

  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(num);
}

function setLiveMetric(name, text, title = '') {
  const el = document.querySelector(`[data-live-metric="${name}"]`);
  if (!el) return;

  el.textContent = text;
  if (title) {
    el.title = title;
  }
}

function renderLiveMetrics(metrics) {
  const modelCount = Number(metrics?.modelCount) || 0;
  const providerTotal = Number(metrics?.providerTotal) || 0;
  const multimodalCount = Number(metrics?.multimodalCount) || 0;
  const toolCallingCount = Number(metrics?.toolCallingCount) || 0;
  const requestCount = Number(metrics?.requestCount) || 0;
  const tokenUsage = Number(metrics?.tokenUsage) || 0;
  const maxProviders = Number(metrics?.maxProviders) || 0;

  setLiveMetric('modelCount', formatMetricCount(modelCount), `${formatMetricCount(modelCount)} live models`);
  setLiveMetric('providerTotal', formatMetricCount(providerTotal), `${formatMetricCount(providerTotal)} total providers`);
  setLiveMetric('multimodalCount', formatMetricCount(multimodalCount), `${formatMetricCount(multimodalCount)} multimodal-ready models`);
  setLiveMetric('toolCallingCount', formatMetricCount(toolCallingCount), `${formatMetricCount(toolCallingCount)} tool-calling models`);
  setLiveMetric('requestCount', formatCompactMetric(requestCount), `${formatMetricCount(requestCount)} total requests served`);
  setLiveMetric('tokenUsage', formatCompactMetric(tokenUsage), `${formatMetricCount(tokenUsage)} tokens processed`);

  const pulseEl = document.querySelector('[data-live-pulse]');
  if (pulseEl) {
    pulseEl.textContent = maxProviders
      ? `${formatMetricCount(maxProviders)} routes/model`
      : 'Live catalog sync';
  }

  const footnoteEl = document.querySelector('[data-live-footnote]');
  if (footnoteEl) {
    const refreshedAt = metrics?.refreshedAt ? new Date(metrics.refreshedAt) : null;
    const refreshedLabel = refreshedAt && !Number.isNaN(refreshedAt.getTime())
      ? ` Updated ${refreshedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
      : '';
    footnoteEl.textContent = `Live model and usage counters refresh every 30s.${refreshedLabel}`;
  }
}

async function initLiveMetrics() {
  if (liveMetricsRequestInFlight) return;
  liveMetricsRequestInFlight = true;

  try {
    const response = await fetch(LIVE_METRICS_URL, {
      cache: 'no-store',
      headers: {
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Live metrics request failed with status ${response.status}`);
    }

    const metrics = await response.json();
    renderLiveMetrics(metrics);
  } catch (err) {
    console.warn('[AnyGPT Homepage] Live metrics fetch failed:', err);
  } finally {
    liveMetricsRequestInFlight = false;
  }
}

function startLiveMetricsPolling() {
  initLiveMetrics();

  if (liveMetricsPollHandle !== null) {
    return;
  }

  restartLiveMetricsPolling();
}

// Button templates
function loginButtons() {
  return `
    <a href="${LOGIN_URL}" class="btn btn-primary">
      Get Started
    </a>
    <a href="#api" class="btn btn-secondary">
      View API Example
    </a>
  `;
}

function dashboardButtons(name) {
  const greeting = name ? `Welcome, ${name}` : 'Welcome back';
  return `
    <a href="${DASHBOARD_URL}" class="btn btn-primary">
      Open Dashboard →
    </a>
    <span class="welcome-pill">${greeting}</span>
  `;
}

function navLoginButtons() {
  return `
    <a href="${DOCS_URL}" target="_blank" rel="noreferrer" class="btn btn-secondary btn-compact hidden md:inline-flex">API Docs</a>
    <a href="${LOGIN_URL}" class="btn btn-primary btn-compact">Login</a>
  `;
}

function navDashboardButtons(name) {
  return `
    <span class="hidden xl:inline nav-name">${name || 'Workspace'}</span>
    <a href="${DOCS_URL}" target="_blank" rel="noreferrer" class="btn btn-secondary btn-compact hidden md:inline-flex">API Docs</a>
    <a href="${DASHBOARD_URL}" class="btn btn-primary btn-compact">Dashboard</a>
  `;
}

function ctaLoginButtons() {
  return `
    <a href="${LOGIN_URL}" class="btn btn-primary">
      Get Started Free
    </a>
    <a href="${DOCS_URL}" target="_blank" rel="noreferrer" class="btn btn-secondary">
      API Docs
    </a>
  `;
}

function ctaDashboardButtons() {
  return `
    <a href="${DASHBOARD_URL}" class="btn btn-primary">
      Open Dashboard →
    </a>
    <a href="${DOCS_URL}" target="_blank" rel="noreferrer" class="btn btn-secondary">
      API Docs
    </a>
  `;
}

// Render auth state into all button containers
function render(authenticated, name) {
  const navEl = document.getElementById('nav-actions');
  const heroEl = document.getElementById('hero-actions');
  const ctaEl = document.getElementById('cta-actions');

  if (authenticated) {
    if (navEl) navEl.innerHTML = navDashboardButtons(name);
    if (heroEl) heroEl.innerHTML = dashboardButtons(name);
    if (ctaEl) ctaEl.innerHTML = ctaDashboardButtons();
  } else {
    if (navEl) navEl.innerHTML = navLoginButtons();
    if (heroEl) heroEl.innerHTML = loginButtons();
    if (ctaEl) ctaEl.innerHTML = ctaLoginButtons();
  }
}

// Initialize Keycloak and check SSO
async function init() {
  // Show login buttons as default (fast render, no flash)
  render(false, null);
  startLiveMetricsPolling();

  try {
    const keycloak = new Keycloak({
      url: KEYCLOAK_URL,
      realm: KEYCLOAK_REALM,
      clientId: KEYCLOAK_CLIENT_ID,
    });

    const authenticated = await keycloak.init({
      onLoad: 'check-sso',
      silentCheckSsoRedirectUri: window.location.origin + '/silent-check-sso.html',
      checkLoginIframe: false,
    });

    if (authenticated && keycloak.tokenParsed) {
      const profileName = keycloak.tokenParsed.name
        || keycloak.tokenParsed.preferred_username
        || keycloak.tokenParsed.given_name
        || null;
      render(true, profileName);
      return;
    }
  } catch (err) {
    // SSO check failed (e.g., Keycloak unreachable) — keep login buttons
    console.warn('[AnyGPT Homepage] Keycloak SSO check failed:', err);
  }
}

// Run when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

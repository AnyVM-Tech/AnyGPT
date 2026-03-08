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
      // Auto-redirect authenticated users to the dashboard
      // (covers post-Keycloak-login redirect back to /)
      window.location.href = DASHBOARD_URL;
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

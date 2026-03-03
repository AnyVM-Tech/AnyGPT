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

// Button templates
function loginButtons() {
  return `
    <a href="${LOGIN_URL}" class="btn-gradient inline-flex items-center px-8 py-3.5 rounded-xl text-white font-semibold text-base transition-all hover:-translate-y-0.5">
      Get Started
    </a>
    <a href="#features" class="inline-flex items-center px-6 py-3.5 rounded-xl text-gray-300 font-medium text-base transition-all hover:bg-white/5">
      Learn More ↓
    </a>
  `;
}

function dashboardButtons(name) {
  const greeting = name ? `Welcome, ${name}` : 'Welcome back';
  return `
    <a href="${DASHBOARD_URL}" class="btn-gradient inline-flex items-center px-8 py-3.5 rounded-xl text-white font-semibold text-base transition-all hover:-translate-y-0.5">
      Open Dashboard →
    </a>
    <span class="text-gray-400 text-sm">${greeting}</span>
  `;
}

function navLoginButtons() {
  return `
    <a href="#features" class="hidden sm:inline-flex items-center px-4 py-2 rounded-lg text-brand text-sm font-medium transition-all hover:bg-brand/10">Features</a>
    <a href="#models" class="hidden sm:inline-flex items-center px-4 py-2 rounded-lg text-brand text-sm font-medium transition-all hover:bg-brand/10">Models</a>
    <a href="${LOGIN_URL}" class="btn-gradient inline-flex items-center px-5 py-2 rounded-lg text-white text-sm font-semibold transition-all">Login</a>
  `;
}

function navDashboardButtons(name) {
  return `
    <span class="hidden sm:inline text-gray-400 text-sm">${name || ''}</span>
    <a href="${DASHBOARD_URL}" class="btn-gradient inline-flex items-center px-5 py-2 rounded-lg text-white text-sm font-semibold transition-all">Dashboard</a>
  `;
}

function ctaLoginButtons() {
  return `
    <a href="${LOGIN_URL}" class="btn-gradient inline-flex items-center px-8 py-3.5 rounded-xl text-white font-semibold text-base transition-all hover:-translate-y-0.5">
      Get Started Free
    </a>
  `;
}

function ctaDashboardButtons() {
  return `
    <a href="${DASHBOARD_URL}" class="btn-gradient inline-flex items-center px-8 py-3.5 rounded-xl text-white font-semibold text-base transition-all hover:-translate-y-0.5">
      Open Dashboard →
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

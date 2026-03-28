import express from 'express';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import rateLimit from 'express-rate-limit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file (no dotenv dependency needed)
try {
  const envPath = path.join(__dirname, '.env');
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && !process.env[key]) {
      process.env[key] = rest.join('=');
    }
  }
} catch { /* no .env file */ }
const PORT = process.env.HOMEPAGE_PORT || 3091;
const HOST = process.env.HOMEPAGE_HOST || '0.0.0.0';
const ANYGPT_API_BASE_URL = (process.env.ANYGPT_API_BASE_URL || 'https://gpt.anyvm.tech').replace(/\/$/, '');
const LIVE_METRICS_REFRESH_MS = 30_000;
const ANYGPT_KEYS_PATH = path.resolve(__dirname, '../api/keys.json');
const ANYGPT_PROVIDERS_PATH = path.resolve(__dirname, '../api/providers.json');

function loadJsonFile(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadUsageMetrics() {
  const keys = loadJsonFile(ANYGPT_KEYS_PATH, {});
  const providers = loadJsonFile(ANYGPT_PROVIDERS_PATH, []);
  const users = Object.values(keys || {});
  const providerEntries = Array.isArray(providers) ? providers : [];

  const usageTotals = users.reduce((totals, user) => {
    totals.requestCount += Number(user?.requestCount) || 0;
    totals.tokenUsage += Number(user?.tokenUsage) || 0;
    return totals;
  }, {
    requestCount: 0,
    tokenUsage: 0,
  });

  return {
    requestCount: usageTotals.requestCount,
    tokenUsage: usageTotals.tokenUsage,
    providerTotal: providerEntries.length,
    providerEnabled: providerEntries.filter((provider) => !provider?.disabled).length,
  };
}

function buildLiveMetrics(payload, usageMetrics) {
  const models = Array.isArray(payload?.data) ? payload.data : [];
  const owners = new Set();
  let multimodalCount = 0;
  let toolCallingCount = 0;
  let maxProviders = 0;

  for (const model of models) {
    if (!model || typeof model !== 'object') continue;

    if (typeof model.owned_by === 'string' && model.owned_by) {
      owners.add(model.owned_by);
    }

    const providerCount = Number(model.providers) || 0;
    if (providerCount > maxProviders) {
      maxProviders = providerCount;
    }

    const capabilities = new Set(Array.isArray(model.capabilities) ? model.capabilities : []);
    if (capabilities.has('tool_calling')) {
      toolCallingCount += 1;
    }

    if (
      capabilities.has('image_input') ||
      capabilities.has('image_output') ||
      capabilities.has('audio_input') ||
      capabilities.has('audio_output')
    ) {
      multimodalCount += 1;
    }
  }

  return {
    refreshedAt: new Date().toISOString(),
    refreshIntervalMs: LIVE_METRICS_REFRESH_MS,
    source: `${ANYGPT_API_BASE_URL}/v1/models`,
    modelCount: models.length,
    ownerCount: owners.size,
    multimodalCount,
    toolCallingCount,
    maxProviders,
    providerTotal: Number(usageMetrics?.providerTotal) || 0,
    providerEnabled: Number(usageMetrics?.providerEnabled) || 0,
    requestCount: Number(usageMetrics?.requestCount) || 0,
    tokenUsage: Number(usageMetrics?.tokenUsage) || 0,
  };
}

// Kill any stale process on our port
try {
  const pid = execSync(`lsof -ti :${PORT}`, { encoding: 'utf8' }).trim();
  if (pid) {
    console.log(`Killing stale process on port ${PORT} (PID: ${pid})`);
    execSync(`kill -9 ${pid}`);
  }
} catch { /* no process on port */ }

const app = express();

// Homepage runs behind a reverse proxy in production.
// Trust the first proxy hop so rate limiting can safely use X-Forwarded-For.
app.set('trust proxy', 1);

const spaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 SPA requests per windowMs
});

app.get('/api/live-metrics', spaLimiter, async (_req, res) => {
  try {
    const [upstream, usageMetrics] = await Promise.all([
      fetch(`${ANYGPT_API_BASE_URL}/v1/models`, {
        headers: {
          accept: 'application/json',
        },
      }),
      Promise.resolve(loadUsageMetrics()),
    ]);

    if (!upstream.ok) {
      res.status(502).json({
        error: 'Bad Gateway',
        reference: `AnyGPT API returned status ${upstream.status}.`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const payload = await upstream.json();
    res.json(buildLiveMetrics(payload, usageMetrics));
  } catch (error) {
    console.error('Failed to load live homepage metrics:', error);
    res.status(502).json({
      error: 'Bad Gateway',
      reference: 'Failed to load live AnyGPT metrics.',
      timestamp: new Date().toISOString(),
    });
  }
});

const publicDir = path.join(__dirname, 'public');
const iconCandidates = [
  { filePath: path.join(publicDir, 'favicon.ico'), contentType: 'image/x-icon' },
  { filePath: path.join(publicDir, 'apple-touch-icon.png'), contentType: 'image/png' },
  { filePath: path.join(publicDir, 'icon.png'), contentType: 'image/png' },
  { filePath: path.join(publicDir, 'favicon.png'), contentType: 'image/png' },
  { filePath: path.join(publicDir, 'AnyGPT.png'), contentType: 'image/png' },
  { filePath: path.join(publicDir, 'favicon.svg'), contentType: 'image/svg+xml' },
];
const fallbackFaviconSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="AnyGPT favicon">
  <defs>
    <linearGradient id="anygpt-favicon-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00e7ff"/>
      <stop offset="100%" stop-color="#d100ff"/>
    </linearGradient>
  </defs>
  <rect x="6" y="6" width="52" height="52" rx="16" fill="#02081e"/>
  <rect x="8" y="8" width="48" height="48" rx="14" fill="url(#anygpt-favicon-gradient)" opacity="0.18"/>
  <path d="M32 16 18 24v16l14 8 14-8V24l-14-8Zm0 6.2 8.5 4.8v9.9L32 41.8l-8.5-4.9V27l8.5-4.8Z" fill="url(#anygpt-favicon-gradient)"/>
  <circle cx="32" cy="32" r="4.5" fill="#f8fafc"/>
</svg>`;

function sendHomepageIcon(res, preferredContentType = null) {
  const icon = iconCandidates.find(({ filePath, contentType }) => {
    if (!existsSync(filePath)) return false;
    return !preferredContentType || contentType === preferredContentType;
  }) || iconCandidates.find(({ filePath }) => existsSync(filePath));

  res.set('Cache-Control', 'public, max-age=86400, immutable');

  if (!icon) {
    res.type('image/svg+xml').status(200).send(fallbackFaviconSvg);
    return;
  }

  res.sendFile(icon.filePath, {
    headers: {
      'Content-Type': icon.contentType,
    },
  }, (error) => {
    if (!error || res.headersSent) return;
    res.type('image/svg+xml').status(200).send(fallbackFaviconSvg);
  });
}

app.get([
  '/favicon.ico',
  '/favicon.ico.png',
  '/favicon-16x16.ico',
  '/favicon-32x32.ico',
], (_req, res) => {
  const hasIcoFavicon = iconCandidates.some(({ filePath, contentType }) => (
    contentType === 'image/x-icon' && existsSync(filePath)
  ));

  if (!hasIcoFavicon) {
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.type('image/svg+xml').status(200).send(fallbackFaviconSvg);
    return;
  }

  sendHomepageIcon(res, 'image/x-icon');
});

app.get([
  '/favicon.ico',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
], (_req, res) => {
  const preferredContentType = _req.path.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
  sendHomepageIcon(res, preferredContentType);
});
app.get([
  '/site.webmanifest',
  '/manifest.webmanifest',
], (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  res.type('application/manifest+json').status(200).send({
    name: 'AnyGPT',
    short_name: 'AnyGPT',
    start_url: '/',
    display: 'standalone',
    background_color: '#010827',
    theme_color: '#041140',
    icons: [
      {
        src: '/favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  });
});

app.get('/browserconfig.xml', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  res.type('application/xml').status(200).send(`<?xml version="1.0" encoding="utf-8"?>
<browserconfig>
  <msapplication>
    <tile>
      <square150x150logo src="/favicon.svg"/>
      <TileColor>#041140</TileColor>
    </tile>
  </msapplication>
</browserconfig>`);
});

app.get('/robots.txt', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('text/plain').status(200).send([
    'User-agent: *',
    'Allow: /',
    'Sitemap: /sitemap.xml',
  ].join('\n'));
});

app.get('/sitemap.xml', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${ANYGPT_API_BASE_URL}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`);
});

app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — serve index.html for any unmatched route
app.get('*', spaLimiter, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`AnyGPT Homepage running on http://${HOST}:${PORT}`);
});

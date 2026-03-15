import express from 'express';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — serve index.html for any unmatched route
app.get('*', spaLimiter, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`AnyGPT Homepage running on http://${HOST}:${PORT}`);
});

import express from 'express';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

// Kill any stale process on our port
try {
  const pid = execSync(`lsof -ti :${PORT}`, { encoding: 'utf8' }).trim();
  if (pid) {
    console.log(`Killing stale process on port ${PORT} (PID: ${pid})`);
    execSync(`kill -9 ${pid}`);
  }
} catch { /* no process on port */ }

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — serve index.html for any unmatched route
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`AnyGPT Homepage running on http://${HOST}:${PORT}`);
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const homepageDir = path.dirname(fileURLToPath(import.meta.url));
const servePath = path.join(homepageDir, 'serve.js');
const bunWrapperPath = path.resolve(homepageDir, '../../bun.sh');

function collectOutput(child) {
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  return () => output;
}

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Process ${child.pid} did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function startUnrelatedListener() {
  const script = `
    const http = require('node:http');
    const server = http.createServer((_request, response) => response.end('unrelated-listener-alive'));
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Listener did not report its port.')), 5_000);
    child.once('error', reject);
    child.stdout.once('data', (chunk) => {
      clearTimeout(timeout);
      const parsedPort = Number(String(chunk).trim());
      if (!Number.isInteger(parsedPort)) {
        reject(new Error(`Invalid listener port; stderr: ${stderr}`));
        return;
      }
      resolve(parsedPort);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Listener exited early (${code ?? signal}); stderr: ${stderr}`));
    });
  });

  return { child, port };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitForExit(child);
}

async function testOccupiedPortIsNotKilled() {
  const listener = await startUnrelatedListener();
  try {
    const homepage = spawn('bash', [bunWrapperPath, 'run', servePath], {
      cwd: homepageDir,
      env: {
        ...process.env,
        HOMEPAGE_HOST: '127.0.0.1',
        HOMEPAGE_PORT: String(listener.port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const homepageOutput = collectOutput(homepage);
    const result = await waitForExit(homepage);

    assert.notEqual(result.code, 0, `Homepage unexpectedly succeeded:\n${homepageOutput()}`);
    assert.match(homepageOutput(), /already in use/i);
    assert.match(homepageOutput(), /existing listener was left untouched/i);

    const response = await fetch(`http://127.0.0.1:${listener.port}`);
    assert.equal(await response.text(), 'unrelated-listener-alive');
    assert.equal(listener.child.exitCode, null, 'Homepage terminated the unrelated listener.');
  } finally {
    await stopChild(listener.child);
  }
}

async function testUnsafePortIsRejectedWithoutShellExecution() {
  const markerPath = path.join(
    tmpdir(),
    `anygpt-homepage-port-injection-${process.pid}-${Date.now()}`,
  );
  const homepage = spawn('bash', [bunWrapperPath, 'run', servePath], {
    cwd: homepageDir,
    env: {
      ...process.env,
      HOMEPAGE_PORT: `3091;touch ${markerPath}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const homepageOutput = collectOutput(homepage);
  const result = await waitForExit(homepage);

  assert.notEqual(result.code, 0, `Homepage unexpectedly accepted an unsafe port:\n${homepageOutput()}`);
  assert.match(homepageOutput(), /HOMEPAGE_PORT must be an integer between 1 and 65535/);
  assert.equal(existsSync(markerPath), false, 'Unsafe HOMEPAGE_PORT was executed by a shell.');
}

await testOccupiedPortIsNotKilled();
await testUnsafePortIsRejectedWithoutShellExecution();
console.log('Homepage port-safety tests passed.');

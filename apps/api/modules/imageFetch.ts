import dns from 'node:dns/promises';
import net from 'node:net';
import { detectMimeTypeFromBuffer } from './mediaParsing.js';

export type ImageFetchConfig = {
  allowedHosts?: string[] | null;
  allowedProtocols: string[];
  allowPrivate: boolean;
  forwardAuth: boolean;
  userAgent?: string;
  referer?: string;
  timeoutMs: number;
  maxRedirects: number;
  maxBytes: number;
  logSensitivePayloads: boolean;
};

function summarizeUrlForLog(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const host = u.host || u.hostname;
    const path = u.pathname || '/';
    return `${u.protocol}//${host}${path}`;
  } catch {
    return rawUrl.slice(0, 120);
  }
}

function hostMatchesAllowlist(host: string, allowedHosts?: string[] | null): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  const needle = host.toLowerCase();
  return allowedHosts.some((entry) => {
    const allowed = entry.toLowerCase();
    if (!allowed) return false;
    if (allowed.startsWith('.')) {
      const suffix = allowed.slice(1);
      return needle === suffix || needle.endsWith(`.${suffix}`);
    }
    return needle === allowed;
  });
}

function isLocalHostname(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local');
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b, c] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fe80:') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('ff')) return true;
  if (normalized.startsWith('2001:db8')) return true;
  if (normalized.startsWith('::ffff:')) {
    const ipv4 = normalized.slice('::ffff:'.length);
    if (ipv4) return isPrivateIpv4(ipv4);
  }
  return false;
}

function isPrivateIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return false;
}

async function resolveHostAddresses(host: string): Promise<string[]> {
  try {
    const results = await dns.lookup(host, { all: true, verbatim: true });
    return results.map((entry) => entry.address).filter(Boolean);
  } catch {
    return [];
  }
}

async function validateImageFetchUrl(rawUrl: string, config: ImageFetchConfig): Promise<{ ok: boolean; reason?: string; parsed?: URL }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  const protocol = parsed.protocol.replace(':', '').toLowerCase();
  if (!config.allowedProtocols.includes(protocol)) {
    return { ok: false, reason: 'protocol_not_allowed' };
  }

  const hostname = parsed.hostname;
  if (!hostname) return { ok: false, reason: 'missing_host' };
  if (!hostMatchesAllowlist(hostname, config.allowedHosts)) return { ok: false, reason: 'host_not_allowed' };

  if (!config.allowPrivate) {
    if (isLocalHostname(hostname)) return { ok: false, reason: 'local_hostname' };
    const directIpType = net.isIP(hostname);
    if (directIpType) {
      if (isPrivateIp(hostname)) return { ok: false, reason: 'private_ip' };
    } else {
      const addresses = await resolveHostAddresses(hostname);
      if (addresses.length === 0) return { ok: false, reason: 'dns_failed' };
      if (addresses.some((addr) => isPrivateIp(addr))) return { ok: false, reason: 'private_ip' };
    }
  }

  return { ok: true, parsed };
}

async function readResponseBodyWithLimit(
  response: globalThis.Response,
  maxBytes: number,
  controller?: AbortController
): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (maxBytes > 0 && contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller?.abort(new Error('Image exceeds max size.'));
      throw new Error('Image exceeds max size.');
    }
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (maxBytes > 0 && total > maxBytes) {
      try { await reader.cancel(); } catch {}
      controller?.abort(new Error('Image exceeds max size.'));
      throw new Error('Image exceeds max size.');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function fetchImageAsDataUrl(
  imageUrl: string,
  authHeader: string | undefined,
  refererOverride: string | undefined,
  config: ImageFetchConfig
): Promise<{ dataUrl: string; contentType: string; bytes: number } | null> {
  const validation = await validateImageFetchUrl(imageUrl, config);
  if (!validation.ok || !validation.parsed) {
    console.warn(`[ImageProxy] Skipping image fetch (${validation.reason || 'blocked'}): ${summarizeUrlForLog(imageUrl)}`);
    return null;
  }

  const initialHost = validation.parsed.hostname.toLowerCase();
  let currentUrl = validation.parsed.toString();
  const controller = new AbortController();
  const timeoutId = config.timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error('Image fetch timed out.')), config.timeoutMs)
    : null;

  try {
    for (let hop = 0; hop <= config.maxRedirects; hop++) {
      const currentValidation = hop === 0 ? validation : await validateImageFetchUrl(currentUrl, config);
      if (!currentValidation.ok || !currentValidation.parsed) {
        console.warn(`[ImageProxy] Redirect blocked (${currentValidation.reason || 'blocked'}): ${summarizeUrlForLog(currentUrl)}`);
        return null;
      }

      const headers: Record<string, string> = {};
      const currentHost = currentValidation.parsed.hostname.toLowerCase();
      if (config.userAgent) headers['User-Agent'] = config.userAgent;
      const effectiveReferer = refererOverride || config.referer;
      if (effectiveReferer) headers['Referer'] = effectiveReferer;
      if (config.forwardAuth && authHeader && currentHost === initialHost) {
        headers['Authorization'] = authHeader;
      }

      if (config.logSensitivePayloads) {
        console.log(`[ImageProxy] Fetching image from URL: ${currentUrl}`);
      } else {
        console.log(`[ImageProxy] Fetching image from host: ${currentHost}`);
      }

      const res = await fetch(currentUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          console.warn(`[ImageProxy] Redirect without location header from ${summarizeUrlForLog(currentUrl)}`);
          return null;
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!res.ok) {
        console.warn(`[ImageProxy] Failed to fetch image: ${res.status} ${res.statusText}`);
        return null;
      }

      const buffer = await readResponseBodyWithLimit(res, config.maxBytes, controller);
      const contentType = res.headers.get('content-type') || detectMimeTypeFromBuffer(buffer) || 'image/jpeg';
      const base64 = buffer.toString('base64');
      return {
        dataUrl: `data:${contentType};base64,${base64}`,
        contentType,
        bytes: buffer.length,
      };
    }

    console.warn(`[ImageProxy] Too many redirects for ${summarizeUrlForLog(imageUrl)}`);
    return null;
  } catch (err: any) {
    if (controller.signal.aborted) {
      console.warn(`[ImageProxy] Aborted fetch for ${summarizeUrlForLog(imageUrl)}: ${err?.message || 'aborted'}`);
    } else {
      console.error('[ImageProxy] Error fetching image:', err);
    }
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function inlineImageUrls(
  messages: any[],
  authHeader: string | undefined,
  refererOverride: string | undefined,
  config: ImageFetchConfig
): Promise<void> {
  if (!messages || !Array.isArray(messages)) return;

  const fetchJobs: Array<{ part: any; url: string }> = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && part.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('http')) {
          fetchJobs.push({ part, url: part.image_url.url });
        }
      }
    }
  }
  if (fetchJobs.length === 0) return;

  const results = await Promise.allSettled(
    fetchJobs.map(async (job) => {
      const result = await fetchImageAsDataUrl(job.url, authHeader, refererOverride, config);
      return { part: job.part, result };
    })
  );

  for (const settled of results) {
    if (settled.status !== 'fulfilled') continue;
    const { part, result } = settled.value;
    if (!result) continue;
    part.image_url.url = result.dataUrl;
  }
}

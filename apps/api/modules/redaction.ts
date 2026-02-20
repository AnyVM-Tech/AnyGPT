import crypto from 'crypto';

const DEFAULT_HASH_SECRET = process.env.API_KEY_HASH_SECRET || 'anygpt-api';

export function redactToken(value?: string | null, visiblePrefix = 4, visibleSuffix = 4): string | null {
  if (!value) return null;
  const token = String(value);
  if (token.length <= visiblePrefix + visibleSuffix) {
    return '*'.repeat(Math.max(token.length, 4));
  }
  return `${token.slice(0, visiblePrefix)}...${token.slice(-visibleSuffix)}`;
}

export function redactAuthorizationHeader(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^Bearer\s+/i.test(trimmed)) {
    const token = trimmed.replace(/^Bearer\s+/i, '');
    return `Bearer ${redactToken(token)}`;
  }
  return redactToken(trimmed);
}

export function hashToken(value: string, secret: string = DEFAULT_HASH_SECRET): string {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

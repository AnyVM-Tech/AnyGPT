const URL_TEXT_PATTERN = /https?:\/\/[^\s<>"'`)\]}>,]+/gi;

function normalizeHostname(value: string): string {
  return String(value || '').trim().replace(/\.+$/, '').toLowerCase();
}

function toExpectedHostnames(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : [value])
    .map((entry) => normalizeHostname(entry))
    .filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hostnameMatches(
  value: string | null | undefined,
  expectedHosts: string | string[],
): boolean {
  const actual = normalizeHostname(value || '');
  if (!actual) return false;
  return toExpectedHostnames(expectedHosts).some(
    (expected) => actual === expected || actual.endsWith(`.${expected}`),
  );
}

export function urlHasExpectedHostname(
  urlText: string | null | undefined,
  expectedHosts: string | string[],
): boolean {
  const value = String(urlText || '').trim();
  if (!value) return false;
  try {
    return hostnameMatches(new URL(value).hostname, expectedHosts);
  } catch {
    return false;
  }
}

export function textContainsHostnameToken(
  text: string | null | undefined,
  expectedHosts: string | string[],
): boolean {
  const value = String(text || '').toLowerCase();
  if (!value) return false;
  return toExpectedHostnames(expectedHosts).some((expected) => {
    const pattern = new RegExp(
      `(?:^|[^a-z0-9.-])${escapeRegExp(expected)}(?=$|[^a-z0-9.-])`,
      'i',
    );
    return pattern.test(value);
  });
}

export function textContainsUrlWithHostname(
  text: string | null | undefined,
  expectedHosts: string | string[],
): boolean {
  const value = String(text || '');
  if (!value) return false;
  const matches = value.match(URL_TEXT_PATTERN);
  if (!matches) return false;
  return matches.some((candidate) =>
    urlHasExpectedHostname(candidate, expectedHosts),
  );
}

export function textMentionsHostname(
  text: string | null | undefined,
  expectedHosts: string | string[],
): boolean {
  return (
    textContainsUrlWithHostname(text, expectedHosts) ||
    textContainsHostnameToken(text, expectedHosts)
  );
}

export function containsOpenAiApiKeyHelpLink(
  text: string | null | undefined,
): boolean {
  const normalized = String(text || '').toLowerCase();
  return (
    normalized.includes('you can find your api key at') &&
    textMentionsHostname(normalized, 'platform.openai.com')
  );
}

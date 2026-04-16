#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

type SearchSourceKind = 'web' | 'docs' | 'github' | 'youtube' | 'papers';

type SearchResult = {
  title: string;
  url: string;
  description: string;
  source: string;
  sourceKind: SearchSourceKind;
};

const SEARCH_SOURCE_SITE_FILTERS: Record<Exclude<SearchSourceKind, 'web'>, string[]> = {
  docs: [
    'docs.rs',
    'tokio.rs',
    'crates.io',
    'readthedocs.io',
    'developer.mozilla.org',
    'modelcontextprotocol.io',
    'temporal.io',
    'qdrant.tech',
    'platform.openai.com',
    'openrouter.ai',
    'docs.anthropic.com',
    'ai.google.dev',
    'developers.google.com',
    'postman.com',
    'docs.redis.com',
    'redis.io',
    'pypi.org',
    'langchain.com',
    'langchain.dev',
    'rust-embedded.org',
    'python-requests.org',
  ],
  github: ['github.com'],
  youtube: ['youtube.com', 'youtu.be'],
  papers: ['arxiv.org', 'paperswithcode.com', 'dl.acm.org', 'ieeexplore.ieee.org'],
};

const SEARCH_PROVIDER = String(process.env.SEARCH_PROVIDER || 'auto').trim().toLowerCase() || 'auto';
const SEARCH_RESULT_LIMIT = Math.max(1, Math.min(10, Number.parseInt(String(process.env.SEARCH_RESULT_LIMIT || '5'), 10) || 5));
const SEARCH_TIMEOUT_MS = Math.max(1_000, Number.parseInt(String(process.env.SEARCH_TIMEOUT_MS || '15000'), 10) || 15_000);
const SEARXNG_BASE_URL = String(
  process.env.SEARXNG_BASE_URL
  || process.env.SEARXNG_URL
  || '',
).trim();
const SEARXNG_ENGINES = String(process.env.SEARXNG_ENGINES || '').trim();

function decodeHtmlEntities(value: string): string {
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const normalized = String(entity || '').toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos' || normalized === '#39') return "'";
    if (normalized === 'nbsp') return ' ';
    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(
    String(value || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function truncateText(value: string, maxChars: number): string {
  const normalized = String(value || '').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function queryHasExplicitSiteConstraint(query: string): boolean {
  return /(^|\s)site:[^\s]+/i.test(String(query || ''));
}

function buildScopedSearchQuery(query: string, sourceKind: SearchSourceKind): string {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery || sourceKind === 'web' || queryHasExplicitSiteConstraint(normalizedQuery)) {
    return normalizedQuery;
  }

  const siteFilters = SEARCH_SOURCE_SITE_FILTERS[sourceKind];
  if (!siteFilters || siteFilters.length === 0) return normalizedQuery;
  if (siteFilters.length === 1) {
    return `${normalizedQuery} site:${siteFilters[0]}`.trim();
  }

  return `${normalizedQuery} (${siteFilters.map((site) => `site:${site}`).join(' OR ')})`.trim();
}

function normalizeUrl(rawUrl: string): string {
  const decodedValue = decodeHtmlEntities(String(rawUrl || '').trim());
  if (!decodedValue) return '';
  const value = decodedValue.startsWith('//')
    ? `https:${decodedValue}`
    : decodedValue;

  try {
    const parsed = new URL(value, 'https://duckduckgo.com');
    const redirected = parsed.searchParams.get('uddg');
    if (redirected) {
      return new URL(decodeURIComponent(redirected)).toString();
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number = SEARCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'user-agent': 'AnyGPT-MCP-Search/1.0 (+https://anygpt.anyvm.tech)',
        'accept-language': 'en-US,en;q=0.9',
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.trim().toLowerCase();
  } catch {
    return '';
  }
}

function sourceKindAllowsHostname(sourceKind: SearchSourceKind, hostname: string): boolean {
  if (sourceKind === 'web') return true;
  const normalizedHostname = String(hostname || '').trim().toLowerCase();
  if (!normalizedHostname) return false;
  const allowedHosts = SEARCH_SOURCE_SITE_FILTERS[sourceKind];
  if (!allowedHosts || allowedHosts.length === 0) return true;
  return allowedHosts.some((allowedHost) => normalizedHostname === allowedHost || normalizedHostname.endsWith(`.${allowedHost}`));
}

function filterResultsBySourceKind(results: SearchResult[], sourceKind: SearchSourceKind): SearchResult[] {
  if (sourceKind === 'web') return results;
  return results.filter((result) => sourceKindAllowsHostname(sourceKind, normalizeHostname(result.url)));
}

function dedupeResults(results: SearchResult[], limit: number, sourceKind: SearchSourceKind = 'web'): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];

  for (const result of filterResultsBySourceKind(results, sourceKind)) {
    const key = `${result.url}::${result.title}`.trim();
    if (!result.url || !result.title || seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
    if (deduped.length >= limit) break;
  }

  return deduped;
}

async function searchSearxng(query: string, limit: number, sourceKind: SearchSourceKind = 'web'): Promise<SearchResult[]> {
  if (!SEARXNG_BASE_URL) return [];

  const scopedQuery = buildScopedSearchQuery(query, sourceKind);
  const baseSearchUrl = new URL('/search', SEARXNG_BASE_URL);
  baseSearchUrl.searchParams.set('q', scopedQuery);
  baseSearchUrl.searchParams.set('language', 'en-US');
  baseSearchUrl.searchParams.set('safesearch', '1');
  if (SEARXNG_ENGINES) {
    baseSearchUrl.searchParams.set('engines', SEARXNG_ENGINES);
  }

  const jsonUrl = new URL(baseSearchUrl);
  jsonUrl.searchParams.set('format', 'json');

  try {
    const response = await fetchWithTimeout(jsonUrl.toString());
    if (!response.ok) {
      throw new Error(`SearxNG JSON search failed with status ${response.status}`);
    }

    const payload = await response.json() as Record<string, any>;
    const rawResults = Array.isArray(payload.results) ? payload.results : [];
    const parsedResults = dedupeResults(
      rawResults.map((entry) => ({
        title: stripHtml(String(entry?.title || '')),
        url: normalizeUrl(String(entry?.url || '')),
        description: truncateText(stripHtml(String(entry?.content || '')), 320),
        source: String(entry?.engine || 'searxng').trim() || 'searxng',
        sourceKind,
      })),
      limit,
      sourceKind,
    );
    if (parsedResults.length > 0) {
      return parsedResults;
    }
  } catch {
    // Fall through to the HTML result page when the JSON endpoint is disabled.
  }

  const response = await fetchWithTimeout(baseSearchUrl.toString(), {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      referer: new URL('/preferences', SEARXNG_BASE_URL).toString(),
    },
  });
  if (!response.ok) {
    throw new Error(`SearxNG HTML search failed with status ${response.status}`);
  }

  const html = await response.text();
  const articlePattern = /<article[^>]*class="result[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  const results: SearchResult[] = [];

  for (const match of html.matchAll(articlePattern)) {
    const articleHtml = match[1];
    const hrefMatch = articleHtml.match(/<a[^>]*class="url_header"[^>]*href="([^"]+)"/i)
      || articleHtml.match(/<h3>\s*<a[^>]*href="([^"]+)"/i);
    const titleMatch = articleHtml.match(/<h3>\s*<a[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/i);
    const descriptionMatch = articleHtml.match(/<p[^>]*class="content"[^>]*>([\s\S]*?)<\/p>/i);
    const engineMatches = Array.from(articleHtml.matchAll(/<div[^>]*class="engines"[\s\S]*?<span>(.*?)<\/span>/gi));

    results.push({
      title: stripHtml(titleMatch?.[1] || ''),
      url: normalizeUrl(hrefMatch?.[1] || ''),
      description: truncateText(stripHtml(descriptionMatch?.[1] || ''), 320),
      source: engineMatches.length > 0
        ? engineMatches.map((entry) => stripHtml(entry[1])).filter(Boolean).join(',')
        : 'searxng',
      sourceKind,
    });
  }

  return dedupeResults(results, limit, sourceKind);
}

async function runSearxngOnlySearch(query: string, limit: number, sourceKind: SearchSourceKind = 'web'): Promise<{ provider: string; results: SearchResult[] }> {
  if (!SEARXNG_BASE_URL) {
    throw new Error('SearXNG search is unavailable because SEARXNG_BASE_URL is not configured.');
  }

  const results = await searchSearxng(query, limit, sourceKind);
  return {
    provider: 'searxng',
    results,
  };
}

async function searchDuckDuckGoHtml(query: string, limit: number, sourceKind: SearchSourceKind = 'web'): Promise<SearchResult[]> {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', buildScopedSearchQuery(query, sourceKind));
  url.searchParams.set('kl', 'us-en');

  const response = await fetchWithTimeout(url.toString());
  if (!response.ok) {
    throw new Error(`DuckDuckGo HTML search failed with status ${response.status}`);
  }

  const html = await response.text();
  const anchorPattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const anchors = Array.from(html.matchAll(anchorPattern));
  const results: SearchResult[] = [];

  for (let index = 0; index < anchors.length; index += 1) {
    const match = anchors[index];
    const href = normalizeUrl(match[1]);
    const title = stripHtml(match[2]);
    const nextStart = match.index ?? 0;
    const nextAnchorIndex = anchors[index + 1]?.index ?? Math.min(html.length, nextStart + 3_000);
    const section = html.slice(nextStart, nextAnchorIndex);
    const snippetMatch = section.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    const description = truncateText(stripHtml((snippetMatch?.[1] || snippetMatch?.[2] || '').trim()), 320);

    results.push({
      title,
      url: href,
      description,
      source: 'duckduckgo',
      sourceKind,
    });
  }

  return dedupeResults(results, limit, sourceKind);
}

function collectDuckDuckGoTopicResults(topicEntries: unknown[], results: SearchResult[], sourceKind: SearchSourceKind = 'web'): void {
  for (const entry of topicEntries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, any>;

    if (Array.isArray(record.Topics)) {
      collectDuckDuckGoTopicResults(record.Topics, results, sourceKind);
      continue;
    }

    const url = normalizeUrl(String(record.FirstURL || ''));
    const text = stripHtml(String(record.Text || ''));
    if (!url || !text) continue;

    const [title, ...rest] = text.split(' - ');
    results.push({
      title: title.trim() || text,
      url,
      description: truncateText(rest.join(' - ').trim() || text, 320),
      source: 'duckduckgo',
      sourceKind,
    });
  }
}

async function searchDuckDuckGoInstantAnswer(query: string, limit: number, sourceKind: SearchSourceKind = 'web'): Promise<SearchResult[]> {
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', buildScopedSearchQuery(query, sourceKind));
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_redirect', '1');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');

  const response = await fetchWithTimeout(url.toString());
  if (!response.ok) {
    throw new Error(`DuckDuckGo instant-answer search failed with status ${response.status}`);
  }

  const payload = await response.json() as Record<string, any>;
  const results: SearchResult[] = [];

  const abstractUrl = normalizeUrl(String(payload.AbstractURL || ''));
  const abstractText = stripHtml(String(payload.AbstractText || ''));
  if (abstractUrl && abstractText) {
    results.push({
      title: stripHtml(String(payload.Heading || abstractText.split(' - ')[0] || 'DuckDuckGo Result')),
      url: abstractUrl,
      description: truncateText(abstractText, 320),
      source: 'duckduckgo',
      sourceKind,
    });
  }

  collectDuckDuckGoTopicResults(Array.isArray(payload.RelatedTopics) ? payload.RelatedTopics : [], results, sourceKind);
  return dedupeResults(results, limit, sourceKind);
}

async function runSearch(query: string, options?: { local?: boolean; location?: string; count?: number; sourceKind?: SearchSourceKind }): Promise<{ provider: string; results: SearchResult[] }> {
  const limit = Math.max(1, Math.min(10, options?.count || SEARCH_RESULT_LIMIT));
  const sourceKind = options?.sourceKind || 'web';
  const normalizedQuery = [
    query,
    options?.local && options?.location ? `near ${options.location}` : '',
  ].filter(Boolean).join(' ').trim();
  if (!normalizedQuery) {
    throw new Error('A non-empty search query is required.');
  }

  const preferredProvider = SEARCH_PROVIDER === 'searxng' || SEARCH_PROVIDER === 'duckduckgo'
    ? SEARCH_PROVIDER
    : 'auto';

  const errors: string[] = [];

  if (preferredProvider !== 'duckduckgo' && SEARXNG_BASE_URL) {
    try {
      const results = await searchSearxng(normalizedQuery, limit, sourceKind);
      if (results.length > 0 || preferredProvider === 'searxng') {
        return { provider: 'searxng', results };
      }
    } catch (error: any) {
      errors.push(`SearxNG: ${String(error?.message || error)}`);
      if (preferredProvider === 'searxng') {
        throw new Error(errors.join(' | '));
      }
    }
  }

  try {
    const htmlResults = await searchDuckDuckGoHtml(normalizedQuery, limit, sourceKind);
    if (htmlResults.length > 0) {
      return { provider: 'duckduckgo', results: htmlResults };
    }
  } catch (error: any) {
    errors.push(`DuckDuckGo HTML: ${String(error?.message || error)}`);
  }

  try {
    const instantAnswerResults = await searchDuckDuckGoInstantAnswer(normalizedQuery, limit, sourceKind);
    if (instantAnswerResults.length > 0) {
      return { provider: 'duckduckgo', results: instantAnswerResults };
    }
  } catch (error: any) {
    errors.push(`DuckDuckGo API: ${String(error?.message || error)}`);
  }

  if (errors.length > 0) {
    throw new Error(`Search failed. ${errors.join(' | ')}`);
  }

  return { provider: preferredProvider === 'searxng' ? 'searxng' : 'duckduckgo', results: [] };
}

const SearchSourceKindSchema = z.enum(['web', 'docs', 'github', 'youtube', 'papers']);
const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string(),
  source: z.string(),
  sourceKind: SearchSourceKindSchema,
});

function formatResults(query: string, provider: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No results found for "${query}" via ${provider}.`;
  }

  return results.map((result) => [
    `Title: ${result.title}`,
    `Description: ${result.description || 'No description available.'}`,
    `URL: ${result.url}`,
  ].join('\n')).join('\n\n');
}

const server = new McpServer({
  name: 'anygpt-search-fallback',
  version: '1.0.0',
});

function registerSearchTool(input: {
  name: string;
  description: string;
  sourceKind?: SearchSourceKind;
  local?: boolean;
  searxngOnly?: boolean;
}): void {
  server.registerTool(input.name, {
    description: input.description,
    inputSchema: {
      query: z.string().min(1).describe('The search query to run.'),
      ...(input.local
        ? { location: z.string().optional().describe('Optional location hint, such as a city or neighborhood.') }
        : {}),
      count: z.number().int().min(1).max(10).optional().describe('Maximum number of results to return.'),
    },
    outputSchema: {
      provider: z.string(),
      results: z.array(SearchResultSchema),
    },
  }, async ({ query, location, count }) => {
    const sourceKind = input.sourceKind || 'web';
    const limit = Math.max(1, Math.min(10, count || SEARCH_RESULT_LIMIT));
    const queryLabel = input.local && location
      ? `${query} near ${location}`
      : query;
    const { provider, results } = input.searxngOnly
      ? await runSearxngOnlySearch(queryLabel, limit, sourceKind)
      : input.local
      ? await runSearch(query, {
          local: true,
          location,
          count,
          sourceKind,
        })
      : await runSearch(query, {
          count,
          sourceKind,
        });
    return {
      content: [
        {
          type: 'text',
          text: formatResults(queryLabel, provider, results),
        },
      ],
      structuredContent: {
        provider,
        results,
      },
    };
  });
}

registerSearchTool({
  name: 'brave_web_search',
  description: 'Search the web using a local SearxNG instance when configured, otherwise DuckDuckGo as a no-key fallback.',
});

registerSearchTool({
  name: 'searxng_web_search',
  description: 'Search the web using the configured local SearXNG instance only. This tool does not fall back to other providers.',
  searxngOnly: true,
});

registerSearchTool({
  name: 'brave_docs_search',
  description: 'Search official docs and package documentation using the same no-key fallback backend, preserving a docs source kind for downstream ranking.',
  sourceKind: 'docs',
});

registerSearchTool({
  name: 'brave_github_search',
  description: 'Search GitHub repositories, examples, issues, and discussions using the same no-key fallback backend, preserving a github source kind for downstream ranking.',
  sourceKind: 'github',
});

registerSearchTool({
  name: 'brave_youtube_search',
  description: 'Search YouTube technical walkthroughs and implementation videos using the same no-key fallback backend, preserving a youtube source kind for downstream ranking.',
  sourceKind: 'youtube',
});

registerSearchTool({
  name: 'brave_papers_search',
  description: 'Search papers and spec-like sources such as arXiv or Papers With Code using the same no-key fallback backend, preserving a papers source kind for downstream ranking.',
  sourceKind: 'papers',
});

registerSearchTool({
  name: 'brave_local_search',
  description: 'Run a location-biased search using the same no-key fallback backend as brave_web_search.',
  local: true,
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AnyGPT fallback search MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fallback search MCP server error:', error);
  process.exit(1);
});

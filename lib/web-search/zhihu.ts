/**
 * Zhihu Global Search (全网搜索)
 *
 * GET https://developer.zhihu.com/api/v1/content/global_search
 * Auth: Bearer access secret + X-Request-Timestamp (unix seconds).
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';
import type { ZhihuSearchDB } from './types';

const ZHIHU_DEFAULT_BASE_URL = 'https://developer.zhihu.com';
const ZHIHU_ENDPOINT_PATH = '/api/v1/content/global_search';
const ZHIHU_MAX_RESULTS = 20;
const ZHIHU_DEFAULT_RESULTS = 10;

export function buildZhihuSearchUrl(baseUrl?: string): string {
  const trimmed = (baseUrl || ZHIHU_DEFAULT_BASE_URL).replace(/\/$/, '');
  if (trimmed.endsWith(ZHIHU_ENDPOINT_PATH)) return trimmed;
  if (trimmed.endsWith('/api/v1/content')) return `${trimmed}/global_search`;
  if (trimmed.endsWith('/api/v1')) return `${trimmed}/content/global_search`;
  return `${trimmed}${ZHIHU_ENDPOINT_PATH}`;
}

function clampCount(maxResults: number): number {
  return Math.min(Math.max(Math.floor(maxResults), 1), ZHIHU_MAX_RESULTS);
}

export function stripZhihuHighlight(text: string): string {
  return text.replace(/<\/?em>/gi, '');
}

function authorityScore(level?: string): number {
  const n = Number.parseInt(level ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 4) / 4;
}

function formatZhihuError(status: number, statusText: string, errorText: string): string {
  if (!errorText) return `Zhihu Global Search API error (${status}): ${statusText}`;
  try {
    const parsed = JSON.parse(errorText) as { Code?: number | string; Message?: string };
    const code = parsed.Code ?? status;
    const message = parsed.Message || statusText;
    return `Zhihu Global Search API error (${code}): ${message}`;
  } catch {
    return `Zhihu Global Search API error (${status}): ${errorText}`;
  }
}

interface ZhihuCommentInfo {
  Content?: string;
}

interface ZhihuSearchItem {
  Title?: string;
  ContentType?: string;
  ContentID?: string;
  ContentText?: string;
  Url?: string;
  CommentCount?: number;
  VoteUpCount?: number;
  AuthorName?: string;
  EditTime?: number;
  CommentInfoList?: ZhihuCommentInfo[];
  AuthorityLevel?: string;
}

interface ZhihuSearchResponse {
  Code?: number | string;
  Message?: string;
  Data?: {
    HasMore?: boolean;
    Items?: ZhihuSearchItem[];
  };
}

/**
 * Search the open web via Zhihu's global_search API and return structured results.
 */
export async function searchWithZhihu(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
  baseUrl?: string;
  filter?: string;
  searchDB?: ZhihuSearchDB;
}): Promise<WebSearchResult> {
  const { query, apiKey, maxResults = ZHIHU_DEFAULT_RESULTS, baseUrl, filter, searchDB } = params;
  const startedAt = Date.now();

  const searchParams = new URLSearchParams();
  searchParams.set('Query', query);
  searchParams.set('Count', String(clampCount(maxResults)));
  const trimmedFilter = filter?.trim();
  if (trimmedFilter) searchParams.set('Filter', trimmedFilter);
  if (searchDB && searchDB !== 'all') searchParams.set('SearchDB', searchDB);

  const url = `${buildZhihuSearchUrl(baseUrl)}?${searchParams.toString()}`;
  const res = await proxyFetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
    },
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(formatZhihuError(res.status, res.statusText, errorText));
  }

  const raw = (await res.json()) as ZhihuSearchResponse;
  if (raw.Code !== undefined && String(raw.Code) !== '0') {
    throw new Error(
      `Zhihu Global Search API error (${raw.Code}): ${raw.Message || 'Request failed'}`,
    );
  }

  const items = raw.Data?.Items ?? [];
  const sources: WebSearchSource[] = items
    .filter((item): item is ZhihuSearchItem & { Url: string } => Boolean(item.Url))
    .map((item) => {
      const comments = (item.CommentInfoList ?? [])
        .map((comment) => comment.Content?.trim())
        .filter((content): content is string => Boolean(content));
      const body = stripZhihuHighlight(item.ContentText || '');
      const content = comments.length > 0 ? `${body}\nComments: ${comments.join(' | ')}` : body;
      return {
        title: item.Title || item.Url,
        url: item.Url,
        content,
        score: authorityScore(item.AuthorityLevel),
      };
    });

  return {
    answer: '',
    sources,
    query,
    responseTime: (Date.now() - startedAt) / 1000,
  };
}

import {
  resolveServerWebSearchProviderId,
  resolveWebSearchApiKey,
  resolveWebSearchBaseUrl,
} from '@/lib/server/provider-config';
import { isWebSearchProviderId, WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import {
  isZhihuSearchDB,
  type WebSearchProviderId,
  type ZhihuSearchDB,
} from '@/lib/web-search/types';

const OFFICIAL_CLIENT_BASE_URLS: Record<WebSearchProviderId, string[]> = {
  zhihu: [
    'https://developer.zhihu.com',
    'https://developer.zhihu.com/api/v1',
    'https://developer.zhihu.com/api/v1/content',
    'https://developer.zhihu.com/api/v1/content/global_search',
  ],
};

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function resolveSafeClientWebSearchBaseUrl(
  providerId: WebSearchProviderId,
  clientBaseUrl?: string,
): string | undefined {
  const trimmed = clientBaseUrl?.trim();
  if (!trimmed) return undefined;

  const provider = WEB_SEARCH_PROVIDERS[providerId];
  const allowedUrls = OFFICIAL_CLIENT_BASE_URLS[providerId];
  if (!provider || !allowedUrls) {
    throw new Error('Unsupported web search base URL');
  }

  let normalized: string;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Invalid protocol');
    }
    normalized = normalizeBaseUrl(parsed.toString());
  } catch {
    throw new Error(`Unsupported ${provider.name} base URL`);
  }

  const allowed = allowedUrls.map(normalizeBaseUrl);
  if (!allowed.includes(normalized)) {
    throw new Error(`Unsupported ${provider.name} base URL`);
  }
  return normalized;
}

export function resolveWebSearchRouteBaseUrl(
  providerId: WebSearchProviderId,
  clientBaseUrl?: string,
): string | undefined {
  const safeClientBaseUrl = resolveSafeClientWebSearchBaseUrl(providerId, clientBaseUrl);
  return resolveWebSearchBaseUrl(providerId, safeClientBaseUrl);
}

export function resolveClassroomWebSearchConfig(input: {
  webSearchProviderId?: WebSearchProviderId;
  webSearchApiKey?: string;
  zhihuFilter?: string;
  zhihuSearchDB?: ZhihuSearchDB;
}):
  | {
      providerId: WebSearchProviderId;
      apiKey: string;
      baseUrl?: string;
      zhihuFilter?: string;
      zhihuSearchDB?: ZhihuSearchDB;
    }
  | undefined {
  const requestedProviderId = isWebSearchProviderId(input.webSearchProviderId)
    ? input.webSearchProviderId
    : undefined;
  const serverProviderId = resolveServerWebSearchProviderId();
  const providerId =
    requestedProviderId ?? (isWebSearchProviderId(serverProviderId) ? serverProviderId : undefined);
  if (!providerId) return undefined;

  const provider = WEB_SEARCH_PROVIDERS[providerId];
  if (!provider) return undefined;
  const apiKey = resolveWebSearchApiKey(providerId, input.webSearchApiKey);
  if (provider.requiresApiKey && !apiKey) return undefined;

  const baseUrl = resolveWebSearchBaseUrl(providerId);
  if (provider.requiresBaseUrl && !baseUrl) return undefined;

  return {
    providerId,
    apiKey,
    baseUrl,
    ...(input.zhihuFilter?.trim() ? { zhihuFilter: input.zhihuFilter.trim() } : {}),
    ...(isZhihuSearchDB(input.zhihuSearchDB) ? { zhihuSearchDB: input.zhihuSearchDB } : {}),
  };
}

/**
 * Web Search API
 *
 * POST /api/web-search
 * Simple JSON request/response using the configured web search provider.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { formatSearchResultsAsContext, searchWeb } from '@/lib/web-search';
import {
  isServerConfiguredProvider,
  resolveServerWebSearchProviderId,
  resolveWebSearchApiKey,
} from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  buildSearchQuery,
  SEARCH_QUERY_REWRITE_EXCERPT_LENGTH,
} from '@/lib/server/search-query-builder';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import { isWebSearchProviderId, WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import {
  isZhihuSearchDB,
  type WebSearchProviderId,
  type ZhihuSearchDB,
} from '@/lib/web-search/types';
import { resolveWebSearchRouteBaseUrl } from '@/lib/server/web-search-config';

const log = createLogger('WebSearch');

export async function POST(req: NextRequest) {
  let query: string | undefined;
  try {
    const body = await req.json();
    const {
      query: requestQuery,
      pdfText,
      providerId: requestProviderId,
      apiKey: bodyApiKey,
      baseUrl: bodyBaseUrl,
      zhihuFilter,
      zhihuSearchDB,
    } = body as {
      query?: string;
      pdfText?: string;
      providerId?: WebSearchProviderId;
      apiKey?: string;
      baseUrl?: string;
      zhihuFilter?: string;
      zhihuSearchDB?: ZhihuSearchDB;
    };
    query = requestQuery;

    if (!query || !query.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'query is required');
    }

    const requestedProviderId = isWebSearchProviderId(requestProviderId)
      ? requestProviderId
      : undefined;
    const serverProviderIdRaw = resolveServerWebSearchProviderId();
    const serverProviderId = isWebSearchProviderId(serverProviderIdRaw)
      ? serverProviderIdRaw
      : undefined;
    let providerId: WebSearchProviderId = requestedProviderId ?? serverProviderId ?? 'zhihu';

    // Prefer the operator's server-configured Zhihu backend over a stale client id.
    if (
      serverProviderId &&
      isServerConfiguredProvider('webSearch', serverProviderId) &&
      providerId !== serverProviderId &&
      !isServerConfiguredProvider('webSearch', providerId)
    ) {
      log.info(
        `Using server-configured web search provider "${serverProviderId}" instead of "${providerId}"`,
      );
      providerId = serverProviderId;
    }

    const provider = WEB_SEARCH_PROVIDERS[providerId];
    if (!provider) {
      return apiError('INVALID_REQUEST', 400, 'Unsupported web search provider');
    }
    // Managed providers are admin-owned: ignore (don't reject) any client-sent
    // key/baseUrl. The server config is authoritative, so a stale client base
    // URL is dropped rather than failing the request.
    const managed = isServerConfiguredProvider('webSearch', providerId);
    const clientApiKey = managed ? undefined : bodyApiKey;
    const clientBaseUrl = managed ? undefined : bodyBaseUrl;
    const apiKey = resolveWebSearchApiKey(providerId, clientApiKey);
    if (provider.requiresApiKey && !apiKey) {
      return apiError(
        'MISSING_API_KEY',
        400,
        `${provider.name} API key is not configured. Set it in Settings -> Web Search or configure ${getWebSearchEnvKey()} on the server.`,
      );
    }
    let baseUrl: string | undefined;
    try {
      baseUrl = resolveWebSearchRouteBaseUrl(providerId, clientBaseUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid web search base URL';
      return apiError('INVALID_REQUEST', 400, message);
    }
    if (provider.requiresBaseUrl && !baseUrl) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        `${provider.name} base URL is not configured. Set ZHIHU_API_KEY on the server or configure the base URL in Settings -> Web Search.`,
      );
    }

    // Clamp rewrite input at the route boundary; framework body limits still apply to total request size.
    const boundedPdfText = pdfText?.slice(0, SEARCH_QUERY_REWRITE_EXCERPT_LENGTH);

    let aiCall: AICallFn | undefined;
    try {
      const { model: languageModel, thinkingConfig } = await resolveModelFromRequest(
        req,
        body,
        'web-search-query-rewrite',
      );
      aiCall = async (systemPrompt, userPrompt) => {
        const result = await callLLM(
          {
            model: languageModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            maxOutputTokens: 256,
          },
          'web-search-query-rewrite',
          undefined,
          thinkingConfig,
        );
        return result.text;
      };
    } catch (error) {
      log.warn('Search query rewrite model unavailable, falling back to raw requirement:', error);
    }

    const searchQuery = await buildSearchQuery(query, boundedPdfText, aiCall);

    log.info('Running web search API request', {
      hasPdfContext: searchQuery.hasPdfContext,
      rawRequirementLength: searchQuery.rawRequirementLength,
      rewriteAttempted: searchQuery.rewriteAttempted,
      finalQueryLength: searchQuery.finalQueryLength,
    });

    const result = await searchWeb({
      providerId,
      query: searchQuery.query,
      apiKey,
      baseUrl,
      ...(zhihuFilter?.trim() ? { zhihuFilter: zhihuFilter.trim() } : {}),
      ...(isZhihuSearchDB(zhihuSearchDB) ? { zhihuSearchDB } : {}),
    });
    const context = formatSearchResultsAsContext(result);

    return apiSuccess({
      answer: result.answer,
      sources: result.sources,
      context,
      query: result.query,
      responseTime: result.responseTime,
    });
  } catch (err) {
    log.error(`Web search failed [query="${query?.substring(0, 60) ?? 'unknown'}"]:`, err);
    const message = err instanceof Error ? err.message : 'Web search failed';
    return apiError('INTERNAL_ERROR', 500, message);
  }
}

function getWebSearchEnvKey(): string {
  return 'ZHIHU_API_KEY';
}

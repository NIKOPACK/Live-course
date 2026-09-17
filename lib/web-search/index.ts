import { searchWithZhihu } from './zhihu';
import type { WebSearchResult } from '@/lib/types/web-search';
import type { WebSearchProviderId, ZhihuSearchDB } from './types';

export { formatSearchResultsAsContext } from './format';

export async function searchWeb(params: {
  providerId: WebSearchProviderId;
  query: string;
  apiKey?: string;
  maxResults?: number;
  baseUrl?: string;
  zhihuFilter?: string;
  zhihuSearchDB?: ZhihuSearchDB;
}): Promise<WebSearchResult> {
  const {
    providerId,
    query,
    apiKey = '',
    maxResults,
    baseUrl,
    zhihuFilter,
    zhihuSearchDB,
  } = params;

  switch (providerId) {
    case 'zhihu':
      return searchWithZhihu({
        query,
        apiKey,
        maxResults,
        baseUrl,
        filter: zhihuFilter,
        searchDB: zhihuSearchDB,
      });
    default: {
      const exhaustive: never = providerId;
      throw new Error(`Unsupported web search provider: ${exhaustive}`);
    }
  }
}

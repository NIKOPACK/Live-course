/**
 * Web Search Provider Type Definitions
 */

/**
 * Web Search Provider IDs
 *
 * The product uses Zhihu Global Search (全网搜索) exclusively; the registry
 * intentionally contains no alternatives (docs/spec/02「设置」: web search is
 * an optional toggle, not a provider ecosystem).
 */
export type WebSearchProviderId = 'zhihu';

/** Zhihu global_search index selection. */
export type ZhihuSearchDB = 'all' | 'realtime' | 'static';

export const ZHIHU_SEARCH_DBS: readonly ZhihuSearchDB[] = ['all', 'realtime', 'static'];

export function isZhihuSearchDB(value: unknown): value is ZhihuSearchDB {
  return value === 'all' || value === 'realtime' || value === 'static';
}

/**
 * Web Search Provider Configuration
 */
export interface WebSearchProviderConfig {
  id: WebSearchProviderId;
  name: string;
  requiresApiKey: boolean;
  /** Self-hosted instances need an explicit base URL (no public default). */
  requiresBaseUrl?: boolean;
  defaultBaseUrl?: string;
  endpointPath: string;
  icon?: string;
}

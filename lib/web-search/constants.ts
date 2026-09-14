/**
 * Web Search Provider Constants
 *
 * Zhihu Global Search (全网搜索) is the only web search provider.
 */

import type { WebSearchProviderId, WebSearchProviderConfig } from './types';

/**
 * Web Search Provider Registry
 */
export const WEB_SEARCH_PROVIDERS: Record<WebSearchProviderId, WebSearchProviderConfig> = {
  zhihu: {
    id: 'zhihu',
    name: 'Zhihu Global Search',
    requiresApiKey: true,
    defaultBaseUrl: 'https://developer.zhihu.com',
    endpointPath: '/api/v1/content/global_search',
    icon: '/logos/zhihu.svg',
  },
};

/** True only for ids still in the Zhihu-only registry (drops yaml/client leftovers). */
export function isWebSearchProviderId(id: unknown): id is WebSearchProviderId {
  return typeof id === 'string' && id in WEB_SEARCH_PROVIDERS;
}

export function isWebSearchProviderConfigured(
  provider: WebSearchProviderConfig,
  cfg?: { apiKey?: string; baseUrl?: string; isServerConfigured?: boolean },
): boolean {
  if (cfg?.isServerConfigured) return true;
  if (provider.requiresApiKey) return !!cfg?.apiKey;
  if (provider.requiresBaseUrl) return !!cfg?.baseUrl;
  return true;
}

function isWebSearchConfigUsable(
  providerId: WebSearchProviderId,
  cfg?: {
    apiKey?: string;
    baseUrl?: string;
    isServerConfigured?: boolean;
    requiresApiKey?: boolean;
  },
): boolean {
  if (!cfg) return false;
  if (cfg.isServerConfigured) return true;

  const provider = WEB_SEARCH_PROVIDERS[providerId];
  if (!provider) return false;
  const requiresApiKey = cfg.requiresApiKey ?? provider.requiresApiKey;
  if (!requiresApiKey) {
    if (provider.requiresBaseUrl) return !!cfg.baseUrl;
    return true;
  }
  return !!cfg.apiKey;
}

/** Server-managed providers first, then other usable client providers. */
export function buildWebSearchFallbackOrder(
  config: Partial<
    Record<
      WebSearchProviderId,
      { apiKey?: string; baseUrl?: string; isServerConfigured?: boolean; requiresApiKey?: boolean }
    >
  >,
): WebSearchProviderId[] {
  const ids = Object.keys(WEB_SEARCH_PROVIDERS) as WebSearchProviderId[];
  const serverManaged = ids.filter(
    (id) => isWebSearchConfigUsable(id, config[id]) && config[id]?.isServerConfigured,
  );
  const clientUsable = ids.filter(
    (id) => isWebSearchConfigUsable(id, config[id]) && !config[id]?.isServerConfigured,
  );
  return [...serverManaged, ...clientUsable];
}

export function getWebSearchProviderDisplayName(
  providerId: WebSearchProviderId,
  t?: (key: string) => string,
): string {
  const provider = WEB_SEARCH_PROVIDERS[providerId];
  if (!provider) return providerId;

  if (t) {
    const key = `settings.providerNames.${providerId}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }

  return provider.name;
}

/**
 * Get all available web search providers
 */
export function getAllWebSearchProviders(): WebSearchProviderConfig[] {
  return Object.values(WEB_SEARCH_PROVIDERS);
}

/** Generation runs web search only when the settings switch is on and the selected provider is usable. */
export function shouldRunGenerationWebSearch(settings: {
  webSearchEnabled?: boolean;
  webSearchProviderId: WebSearchProviderId;
  webSearchProvidersConfig: Partial<
    Record<
      WebSearchProviderId,
      { apiKey?: string; baseUrl?: string; isServerConfigured?: boolean; requiresApiKey?: boolean }
    >
  >;
}): boolean {
  if (!settings.webSearchEnabled) return false;
  const provider = WEB_SEARCH_PROVIDERS[settings.webSearchProviderId];
  if (!provider) return false;
  return isWebSearchProviderConfigured(
    provider,
    settings.webSearchProvidersConfig[settings.webSearchProviderId],
  );
}

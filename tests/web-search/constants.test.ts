import { describe, expect, it } from 'vitest';
import {
  getAllWebSearchProviders,
  getWebSearchProviderDisplayName,
  WEB_SEARCH_PROVIDERS,
  buildWebSearchFallbackOrder,
  isWebSearchProviderId,
  shouldRunGenerationWebSearch,
} from '@/lib/web-search/constants';

describe('web search provider constants', () => {
  it('registers Zhihu Global Search as the only web search provider', () => {
    expect(Object.keys(WEB_SEARCH_PROVIDERS)).toEqual(['zhihu']);
    expect(WEB_SEARCH_PROVIDERS.zhihu).toMatchObject({
      id: 'zhihu',
      name: 'Zhihu Global Search',
      requiresApiKey: true,
      defaultBaseUrl: 'https://developer.zhihu.com',
      endpointPath: '/api/v1/content/global_search',
    });
    expect(getAllWebSearchProviders().map((provider) => provider.id)).toEqual(['zhihu']);
  });

  it('uses translated provider names when available', () => {
    const t = (key: string) => (key === 'settings.providerNames.zhihu' ? '知乎全网搜索' : key);

    expect(getWebSearchProviderDisplayName('zhihu', t)).toBe('知乎全网搜索');
  });

  it('falls back to provider metadata name when no translation exists', () => {
    const t = (key: string) => key;

    expect(getWebSearchProviderDisplayName('zhihu', t)).toBe('Zhihu Global Search');
  });

  it('prioritizes the server-managed provider in fallback order', () => {
    expect(
      buildWebSearchFallbackOrder({
        zhihu: { apiKey: '', requiresApiKey: true, isServerConfigured: true },
      }),
    ).toEqual(['zhihu']);
    // Unconfigured Zhihu (key required, none set) is not usable.
    expect(
      buildWebSearchFallbackOrder({ zhihu: { apiKey: '', requiresApiKey: true } }),
    ).toEqual([]);
  });

  it('runs generation web search only when the switch is on and the selected provider is configured', () => {
    expect(
      shouldRunGenerationWebSearch({
        webSearchEnabled: false,
        webSearchProviderId: 'zhihu',
        webSearchProvidersConfig: { zhihu: { apiKey: 'secret', requiresApiKey: true } },
      }),
    ).toBe(false);
    expect(
      shouldRunGenerationWebSearch({
        webSearchEnabled: true,
        webSearchProviderId: 'zhihu',
        webSearchProvidersConfig: { zhihu: { apiKey: '', requiresApiKey: true } },
      }),
    ).toBe(false);
    expect(
      shouldRunGenerationWebSearch({
        webSearchEnabled: true,
        webSearchProviderId: 'zhihu',
        webSearchProvidersConfig: { zhihu: { apiKey: 'secret', requiresApiKey: true } },
      }),
    ).toBe(true);
  });

  it('treats removed provider ids as unknown and does not crash', () => {
    expect(isWebSearchProviderId('zhihu')).toBe(true);
    expect(isWebSearchProviderId('tavily')).toBe(false);
    expect(isWebSearchProviderId('bocha')).toBe(false);
    expect(isWebSearchProviderId('brave')).toBe(false);
    expect(
      shouldRunGenerationWebSearch({
        webSearchEnabled: true,
        webSearchProviderId: 'tavily' as never,
        webSearchProvidersConfig: { tavily: { apiKey: 'secret' } } as never,
      }),
    ).toBe(false);
  });
});

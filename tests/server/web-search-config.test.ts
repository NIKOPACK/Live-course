import { describe, expect, it, vi, beforeEach } from 'vitest';

// Web search is Zhihu-only (知乎全网搜索); these tests pin the remaining
// surface: the client base-URL allowlist, classroom config resolution, and
// the fate of stale provider ids persisted before the cleanup.
describe('server web search config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete process.env.ZHIHU_API_KEY;
    delete process.env.ZHIHU_BASE_URL;
  });

  it('allows official Zhihu client base URLs and rejects others', async () => {
    const { resolveSafeClientWebSearchBaseUrl } = await import('@/lib/server/web-search-config');

    expect(
      resolveSafeClientWebSearchBaseUrl(
        'zhihu',
        'https://developer.zhihu.com/api/v1/content/global_search',
      ),
    ).toBe('https://developer.zhihu.com/api/v1/content/global_search');
    expect(() => resolveSafeClientWebSearchBaseUrl('zhihu', 'https://evil.example.com/v1')).toThrow(
      'Unsupported Zhihu Global Search base URL',
    );
  });

  it('rejects SSRF-style Zhihu base URLs', async () => {
    const { resolveSafeClientWebSearchBaseUrl } = await import('@/lib/server/web-search-config');

    expect(() =>
      resolveSafeClientWebSearchBaseUrl('zhihu', 'http://127.0.0.1:3000/internal'),
    ).toThrow('Unsupported Zhihu Global Search base URL');
    expect(() => resolveSafeClientWebSearchBaseUrl('zhihu', 'not-a-url')).toThrow(
      'Unsupported Zhihu Global Search base URL',
    );
  });

  it('rejects leftover provider ids instead of indexing a missing allowlist', async () => {
    const { resolveSafeClientWebSearchBaseUrl } = await import('@/lib/server/web-search-config');

    expect(() =>
      resolveSafeClientWebSearchBaseUrl('tavily' as never, 'https://api.tavily.com'),
    ).toThrow('Unsupported web search base URL');
  });

  it('resolves classroom web search config from the client key', async () => {
    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(
      resolveClassroomWebSearchConfig({
        webSearchProviderId: 'zhihu',
        webSearchApiKey: 'zhihu-client-key',
      }),
    ).toEqual({
      providerId: 'zhihu',
      apiKey: 'zhihu-client-key',
      baseUrl: undefined,
    });
  });

  it('uses the server key/base URL for classroom web search when configured', async () => {
    vi.stubEnv('ZHIHU_API_KEY', 'zhihu-server-key');
    vi.stubEnv('ZHIHU_BASE_URL', 'https://developer.zhihu.com/api/v1');

    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(resolveClassroomWebSearchConfig({ webSearchProviderId: 'zhihu' })).toEqual({
      providerId: 'zhihu',
      apiKey: 'zhihu-server-key',
      baseUrl: 'https://developer.zhihu.com/api/v1',
    });
  });

  it('keeps Zhihu filter and searchDB in classroom web search config', async () => {
    vi.stubEnv('ZHIHU_API_KEY', 'zhihu-server-key');

    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(
      resolveClassroomWebSearchConfig({
        webSearchProviderId: 'zhihu',
        zhihuFilter: 'host=="example.com"',
        zhihuSearchDB: 'static',
      }),
    ).toEqual({
      providerId: 'zhihu',
      apiKey: 'zhihu-server-key',
      baseUrl: undefined,
      zhihuFilter: 'host=="example.com"',
      zhihuSearchDB: 'static',
    });
  });

  it('drops invalid Zhihu filter/searchDB instead of forwarding them', async () => {
    vi.stubEnv('ZHIHU_API_KEY', 'zhihu-server-key');

    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(
      resolveClassroomWebSearchConfig({
        webSearchProviderId: 'zhihu',
        zhihuFilter: '   ',
        zhihuSearchDB: 'bogus' as never,
      }),
    ).toEqual({
      providerId: 'zhihu',
      apiKey: 'zhihu-server-key',
      baseUrl: undefined,
    });
  });

  it('requires an API key for Zhihu classroom config', async () => {
    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(resolveClassroomWebSearchConfig({ webSearchProviderId: 'zhihu' })).toBeUndefined();
  });

  it('treats removed provider ids as unknown and falls back to the server provider', async () => {
    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    // No server key: nothing usable.
    expect(
      resolveClassroomWebSearchConfig({ webSearchProviderId: 'tavily' as never }),
    ).toBeUndefined();

    vi.stubEnv('ZHIHU_API_KEY', 'zhihu-server-key');
    vi.resetModules();
    const reloaded = await import('@/lib/server/web-search-config');
    expect(
      reloaded.resolveClassroomWebSearchConfig({ webSearchProviderId: 'tavily' as never }),
    ).toEqual({
      providerId: 'zhihu',
      apiKey: 'zhihu-server-key',
      baseUrl: undefined,
    });
  });
});

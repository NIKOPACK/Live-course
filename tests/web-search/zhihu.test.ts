import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

import {
  buildZhihuSearchUrl,
  searchWithZhihu,
  stripZhihuHighlight,
  ZHIHU_SEARCH_TIMEOUT_MS,
} from '@/lib/web-search/zhihu';

const SAMPLE_ITEM = {
  Title: 'ChatGPT现在还值得开会员吗？',
  ContentType: 'Answer',
  ContentID: '1903044959663284716',
  ContentText: '首先要澄清一个常见误解：ChatGPT的免费版和付费版使用的是<em>不同模型</em>。',
  Url: 'https://www.zhihu.com/answer/1903044959663284716?utm_medium=openapi_platform',
  CommentCount: 22,
  VoteUpCount: 18,
  AuthorName: '时光纪',
  EditTime: 1748355858,
  CommentInfoList: [{ Content: '免费版现在也可以用gpt4o啊' }],
  AuthorityLevel: '2',
};

describe('searchWithZhihu', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls Zhihu global_search with Bearer auth, timestamp, and PascalCase query params', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          Code: 0,
          Message: 'success',
          Data: { HasMore: false, Items: [SAMPLE_ITEM] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await searchWithZhihu({
      query: '怎么理解rave文化',
      apiKey: 'zhihu-secret',
      maxResults: 5,
      filter: 'host=="example.com" AND publish_time>=1778494631',
      searchDB: 'realtime',
    });

    expect(proxyFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = proxyFetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://developer.zhihu.com/api/v1/content/global_search',
    );
    expect(parsed.searchParams.get('Query')).toBe('怎么理解rave文化');
    expect(parsed.searchParams.get('Count')).toBe('5');
    expect(parsed.searchParams.get('Filter')).toBe(
      'host=="example.com" AND publish_time>=1778494631',
    );
    expect(parsed.searchParams.get('SearchDB')).toBe('realtime');
    expect(init.method).toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer zhihu-secret',
      'X-Request-Timestamp': String(Math.floor(Date.parse('2026-09-14T00:00:00Z') / 1000)),
    });
    expect(result.answer).toBe('');
    expect(result.query).toBe('怎么理解rave文化');
    expect(result.sources).toEqual([
      {
        title: 'ChatGPT现在还值得开会员吗？',
        url: 'https://www.zhihu.com/answer/1903044959663284716?utm_medium=openapi_platform',
        content:
          '首先要澄清一个常见误解：ChatGPT的免费版和付费版使用的是不同模型。\nComments: 免费版现在也可以用gpt4o啊',
        score: 0.5,
      },
    ]);
  });

  it('omits default SearchDB=all and empty Filter, and clamps Count to 20', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Code: 0, Data: { Items: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await searchWithZhihu({
      query: 'q',
      apiKey: 'key',
      maxResults: 100,
      filter: '  ',
      searchDB: 'all',
    });

    const parsed = new URL(proxyFetchMock.mock.calls[0][0] as string);
    expect(parsed.searchParams.get('Count')).toBe('20');
    expect(parsed.searchParams.get('Filter')).toBeNull();
    expect(parsed.searchParams.get('SearchDB')).toBeNull();
  });

  it('supports custom base URLs ending at host, /api/v1, /api/v1/content, or the full path', async () => {
    proxyFetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ Code: 0, Data: { Items: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await searchWithZhihu({ query: 'q', apiKey: 'key', baseUrl: 'https://proxy.example.com' });
    await searchWithZhihu({
      query: 'q',
      apiKey: 'key',
      baseUrl: 'https://proxy.example.com/api/v1',
    });
    await searchWithZhihu({
      query: 'q',
      apiKey: 'key',
      baseUrl: 'https://proxy.example.com/api/v1/content',
    });
    await searchWithZhihu({
      query: 'q',
      apiKey: 'key',
      baseUrl: 'https://proxy.example.com/api/v1/content/global_search',
    });

    expect(proxyFetchMock.mock.calls.map((call) => new URL(call[0] as string).pathname)).toEqual([
      '/api/v1/content/global_search',
      '/api/v1/content/global_search',
      '/api/v1/content/global_search',
      '/api/v1/content/global_search',
    ]);
  });

  it('throws when HTTP status is not ok', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Code: 401, Message: 'invalid secret' }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(searchWithZhihu({ query: 'q', apiKey: 'bad' })).rejects.toThrow(
      'Zhihu Global Search API error (401): invalid secret',
    );
  });

  it('throws when Code is not 0 even if HTTP is 200', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Code: 1001, Message: 'quota exceeded' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(searchWithZhihu({ query: 'q', apiKey: 'key' })).rejects.toThrow(
      'Zhihu Global Search API error (1001): quota exceeded',
    );
  });

  it('times out a hung Zhihu request instead of blocking generation', async () => {
    proxyFetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    const pending = expect(searchWithZhihu({ query: 'solidity', apiKey: 'key' })).rejects.toThrow(
      `timed out after ${ZHIHU_SEARCH_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(ZHIHU_SEARCH_TIMEOUT_MS);
    await pending;
  });
});

describe('zhihu helpers', () => {
  it('strips highlight tags from ContentText', () => {
    expect(stripZhihuHighlight('使用的是<em>不同模型</em>')).toBe('使用的是不同模型');
  });

  it('builds the official endpoint from the default host', () => {
    expect(buildZhihuSearchUrl()).toBe('https://developer.zhihu.com/api/v1/content/global_search');
  });
});

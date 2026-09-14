import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchWithZhihuMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/web-search/zhihu', () => ({
  searchWithZhihu: searchWithZhihuMock,
}));

import { searchWeb } from '@/lib/web-search';

describe('searchWeb', () => {
  beforeEach(() => {
    searchWithZhihuMock.mockReset();
  });

  it('dispatches Zhihu provider requests with filter and searchDB', async () => {
    searchWithZhihuMock.mockResolvedValueOnce({
      answer: '',
      sources: [],
      query: 'q',
      responseTime: 0.7,
    });

    await expect(
      searchWeb({
        providerId: 'zhihu',
        query: 'q',
        apiKey: 'zhihu-secret',
        maxResults: 8,
        baseUrl: 'https://developer.zhihu.com',
        zhihuFilter: 'host=="example.com"',
        zhihuSearchDB: 'static',
      }),
    ).resolves.toEqual({
      answer: '',
      sources: [],
      query: 'q',
      responseTime: 0.7,
    });
    expect(searchWithZhihuMock).toHaveBeenCalledWith({
      query: 'q',
      apiKey: 'zhihu-secret',
      maxResults: 8,
      baseUrl: 'https://developer.zhihu.com',
      filter: 'host=="example.com"',
      searchDB: 'static',
    });
  });

  it('dispatches Zhihu requests with defaults when optional params are omitted', async () => {
    searchWithZhihuMock.mockResolvedValueOnce({
      answer: 'a',
      sources: [],
      query: 'q',
      responseTime: 0.1,
    });

    await searchWeb({ providerId: 'zhihu', query: 'q' });
    expect(searchWithZhihuMock).toHaveBeenCalledWith({
      query: 'q',
      apiKey: '',
      maxResults: undefined,
      baseUrl: undefined,
      filter: undefined,
      searchDB: undefined,
    });
  });
});

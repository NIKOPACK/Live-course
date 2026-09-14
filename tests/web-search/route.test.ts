import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  searchWeb: vi.fn(),
  formatSearchResultsAsContext: vi.fn(() => 'formatted context'),
  resolveModelFromRequest: vi.fn(),
}));

vi.mock('@/lib/web-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/web-search')>();
  return {
    ...actual,
    searchWeb: mocks.searchWeb,
    formatSearchResultsAsContext: mocks.formatSearchResultsAsContext,
  };
});

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));

vi.mock('@/lib/ai/llm', () => ({
  callLLM: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function postWebSearch(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/web-search/route');
  const request = new Request('http://localhost/api/web-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

// Web search is Zhihu-only (知乎全网搜索).
describe('POST /api/web-search', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete process.env.ZHIHU_API_KEY;
    delete process.env.ZHIHU_BASE_URL;
    mocks.searchWeb.mockReset();
    mocks.formatSearchResultsAsContext.mockClear();
    mocks.resolveModelFromRequest.mockReset();
    mocks.resolveModelFromRequest.mockRejectedValue(new Error('model unavailable'));
    mocks.searchWeb.mockResolvedValue({
      answer: '',
      sources: [],
      query: 'test query',
      responseTime: 0.1,
    });
  });

  it('rejects client-controlled base URLs outside the Zhihu allowlist (unmanaged provider)', async () => {
    // No server config ⇒ unmanaged ⇒ the client base URL is actually used, so it
    // must be validated against the allowlist.
    const res = await postWebSearch({
      query: 'test query',
      providerId: 'zhihu',
      apiKey: 'zhihu-client-key',
      baseUrl: 'http://127.0.0.1:3000/internal',
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });

  it('ignores a client base URL for a managed (server-configured) provider', async () => {
    vi.stubEnv('ZHIHU_API_KEY', 'zhihu-server-key');

    // A managed provider is admin-owned: the client base URL (even an invalid
    // one) is dropped rather than rejected, and the server config is used.
    const res = await postWebSearch({
      query: 'test query',
      providerId: 'zhihu',
      apiKey: 'zhihu-client-key',
      baseUrl: 'http://127.0.0.1:3000/internal',
    });

    expect(res.status).toBe(200);
    expect(mocks.searchWeb).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'zhihu',
        apiKey: 'zhihu-server-key',
      }),
    );
  });

  it('uses server-configured base URL when no client base URL is supplied', async () => {
    vi.stubEnv('ZHIHU_API_KEY', 'zhihu-server-key');
    vi.stubEnv('ZHIHU_BASE_URL', 'https://developer.zhihu.com/api/v1');

    const res = await postWebSearch({
      query: 'test query',
      providerId: 'zhihu',
    });

    expect(res.status).toBe(200);
    expect(mocks.searchWeb).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'zhihu',
        apiKey: 'zhihu-server-key',
        baseUrl: 'https://developer.zhihu.com/api/v1',
      }),
    );
  });

  it('routes Zhihu global search through the dispatcher with filter and searchDB', async () => {
    vi.stubEnv('ZHIHU_API_KEY', 'zhihu-server-key');
    vi.stubEnv('ZHIHU_BASE_URL', 'https://developer.zhihu.com');

    const res = await postWebSearch({
      query: 'test query',
      providerId: 'zhihu',
      zhihuFilter: 'host=="example.com"',
      zhihuSearchDB: 'realtime',
    });

    expect(res.status).toBe(200);
    expect(mocks.searchWeb).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'zhihu',
        apiKey: 'zhihu-server-key',
        baseUrl: 'https://developer.zhihu.com',
        zhihuFilter: 'host=="example.com"',
        zhihuSearchDB: 'realtime',
      }),
    );
  });

  it('rejects Zhihu requests without an API key, naming the env var', async () => {
    const res = await postWebSearch({
      query: 'test query',
      providerId: 'zhihu',
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(JSON.stringify(data)).toContain('ZHIHU_API_KEY');
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });

  it('treats removed provider ids as unknown and falls back to Zhihu with the client key', async () => {
    const res = await postWebSearch({
      query: 'test query',
      providerId: 'bocha',
      apiKey: 'leftover-client-key',
    });

    expect(res.status).toBe(200);
    expect(mocks.searchWeb).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'zhihu',
        apiKey: 'leftover-client-key',
      }),
    );
  });

  it('prefers the server-configured Zhihu backend over a stale client provider id', async () => {
    vi.stubEnv('ZHIHU_API_KEY', 'zhihu-server-key');

    const res = await postWebSearch({
      query: 'test query',
      providerId: 'tavily',
      apiKey: 'stale-client-key',
    });

    expect(res.status).toBe(200);
    expect(mocks.searchWeb).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'zhihu',
        apiKey: 'zhihu-server-key',
      }),
    );
  });

  it('requires query', async () => {
    const res = await postWebSearch({ providerId: 'zhihu', apiKey: 'k' });
    expect(res.status).toBe(400);
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });
});

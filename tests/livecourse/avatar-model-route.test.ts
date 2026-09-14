import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const AIRI_SAMPLE_MODEL_URL =
  'https://dist.ayaka.moe/vrm-models/VRoid-Hub/AvatarSample-A/AvatarSample_A.vrm';

let cacheDir: string;
const previousCachePath = process.env.LIVECOURSE_AVATAR_CACHE_PATH;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'livecourse-avatar-'));
  process.env.LIVECOURSE_AVATAR_CACHE_PATH = path.join(cacheDir, 'AvatarSample_A.vrm');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (previousCachePath === undefined) delete process.env.LIVECOURSE_AVATAR_CACHE_PATH;
  else process.env.LIVECOURSE_AVATAR_CACHE_PATH = previousCachePath;
  await rm(cacheDir, { recursive: true, force: true });
});

describe('GET /api/livecourse/avatar/model', () => {
  it('streams only the fixed AIRI sample model with cache and content headers', async () => {
    vi.resetModules();
    const { GET } = await import('@/app/api/livecourse/avatar/model/route');
    const fetchMock = vi.fn(
      async () =>
        new Response(Uint8Array.from([0x67, 0x6c, 0x54, 0x46]), {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': '4',
            ETag: '"avatar-v1"',
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET();

    expect(fetchMock).toHaveBeenCalledWith(
      AIRI_SAMPLE_MODEL_URL,
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(response.headers.get('Cache-Control')).toContain('s-maxage=604800');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      Uint8Array.from([0x67, 0x6c, 0x54, 0x46]),
    );
  });

  it('returns an explicit uncached 502 when the model source fails', async () => {
    vi.resetModules();
    const { GET } = await import('@/app/api/livecourse/avatar/model/route');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('missing', { status: 404 })),
    );

    const response = await GET();

    expect(response.status).toBe(502);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'AVATAR_MODEL_UPSTREAM_ERROR',
        message: 'The 3D teacher model is unavailable',
      },
    });
  });

  it('serves subsequent requests from the in-process cache without re-fetching', async () => {
    vi.resetModules();
    const { GET } = await import('@/app/api/livecourse/avatar/model/route');
    const fetchMock = vi.fn(
      async () =>
        new Response(Uint8Array.from([0x67, 0x6c, 0x54, 0x46]), {
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = await GET();
    expect(first.status).toBe(200);
    const second = await GET();
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(
      Uint8Array.from([0x67, 0x6c, 0x54, 0x46]),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries the upstream on the next request after a failed fetch (no permanent cache poisoning)', async () => {
    vi.resetModules();
    const { GET } = await import('@/app/api/livecourse/avatar/model/route');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(Uint8Array.from([0x67, 0x6c, 0x54, 0x46]), {
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const first = await GET();
    expect(first.status).toBe(502);
    const second = await GET();
    expect(second.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves from the disk cache after a process restart without re-fetching upstream', async () => {
    vi.resetModules();
    const { GET } = await import('@/app/api/livecourse/avatar/model/route');
    const fetchMock = vi.fn(
      async () =>
        new Response(Uint8Array.from([0x67, 0x6c, 0x54, 0x46]), {
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = await GET();
    expect(first.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(readFile(process.env.LIVECOURSE_AVATAR_CACHE_PATH!)).resolves.toEqual(
      Buffer.from([0x67, 0x6c, 0x54, 0x46]),
    );

    vi.resetModules();
    const { GET: GETAfterRestart } = await import('@/app/api/livecourse/avatar/model/route');
    const fetchAfterRestart = vi.fn();
    vi.stubGlobal('fetch', fetchAfterRestart);

    const second = await GETAfterRestart();
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(
      Uint8Array.from([0x67, 0x6c, 0x54, 0x46]),
    );
    expect(fetchAfterRestart).not.toHaveBeenCalled();
  });
});

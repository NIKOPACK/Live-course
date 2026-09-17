import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withAssetUrl: vi.fn(),
}));

vi.mock('@/lib/media/use-asset-url', () => ({
  withAssetUrl: mocks.withAssetUrl,
}));
vi.mock('@/lib/document-store', () => ({
  accessDocument: vi.fn(),
  getDocumentStore: vi.fn(),
  getLegacyDocumentStore: vi.fn(),
}));
vi.mock('@/lib/utils/database', () => ({
  db: { mediaFiles: { where: () => ({ equals: () => ({ toArray: async () => [] }) }) } },
}));

import { resolveCourseCoverUrls, revokeCourseCoverUrls } from '@/lib/utils/stage-storage';

describe('resolveCourseCoverUrls', () => {
  beforeEach(() => {
    mocks.withAssetUrl.mockReset();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:cover-asset'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses concrete URLs as-is and resolves pool ids to object URLs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }),
      })),
    );
    mocks.withAssetUrl.mockImplementation(
      async (_ref: string, fn: (url: string | null) => unknown) => fn('blob:pool'),
    );

    const urls = await resolveCourseCoverUrls([
      { id: 'a', coverAssetId: '/api/classroom-media/a/media/course_cover.png' },
      { id: 'b', coverAssetId: 'asset-cover' },
      { id: 'c' },
    ]);

    expect(urls.a).toBe('/api/classroom-media/a/media/course_cover.png');
    expect(urls.b).toBe('blob:cover-asset');
    expect(urls.c).toBeUndefined();
  });

  it('revokes blob object URLs', () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: revoke });
    revokeCourseCoverUrls({ a: 'blob:one', b: '/api/classroom-media/x' });
    expect(revoke).toHaveBeenCalledWith('blob:one');
    expect(revoke).not.toHaveBeenCalledWith('/api/classroom-media/x');
  });
});

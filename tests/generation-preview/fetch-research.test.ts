import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGenerationResearch } from '@/app/generation-preview/fetch-research';

describe('fetchGenerationResearch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns sources from a successful search', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          context: 'ctx',
          sources: [{ title: 'Solidity', url: 'https://example.com' }],
        }),
      }),
    );

    await expect(
      fetchGenerationResearch({ query: 'solidity' }, { 'Content-Type': 'application/json' }),
    ).resolves.toEqual({
      ok: true,
      researchContext: 'ctx',
      researchSources: [{ title: 'Solidity', url: 'https://example.com' }],
    });
  });

  it('continues classroom generation when search fails or hangs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(
      fetchGenerationResearch({ query: 'solidity' }, { 'Content-Type': 'application/json' }),
    ).resolves.toEqual({
      ok: false,
      researchContext: '',
      researchSources: [],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Zhihu Global Search timed out' }),
      }),
    );
    await expect(
      fetchGenerationResearch({ query: 'solidity' }, { 'Content-Type': 'application/json' }),
    ).resolves.toEqual({
      ok: false,
      researchContext: '',
      researchSources: [],
    });
  });
});

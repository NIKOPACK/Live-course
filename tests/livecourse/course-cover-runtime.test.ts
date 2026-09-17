import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LessonPlan } from '@/lib/livecourse/domain/schemas';
import type { Stage } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  putAsset: vi.fn(),
  markDirty: vi.fn(),
  settings: {
    imageGenerationEnabled: true,
    imageProviderId: 'openai-image',
    imageModelId: 'gpt-image-2',
    imageProvidersConfig: { 'openai-image': { apiKey: 'k', baseUrl: '' } },
  },
  stageState: {
    stage: {
      id: 'stage-1',
      name: '傅里叶变换入门',
      createdAt: 1,
      updatedAt: 1,
      languageDirective: '简体中文',
    } as Stage,
    lessonPlan: {
      presentation: {
        mode: 'html' as const,
        visualStyle: 'Warm paper and teal diagrams.',
        coverPrompt: 'A 16:9 teal waveform over warm paper.',
      },
    } as Pick<LessonPlan, 'presentation'>,
  },
}));

vi.mock('@/lib/media/asset-pool', () => ({ putAsset: mocks.putAsset }));
vi.mock('@/lib/store/stage', () => ({
  markStagePersistenceDirty: mocks.markDirty,
  useStageStore: {
    getState: () => mocks.stageState,
    setState: (partial: { stage: Stage }) => {
      mocks.stageState.stage = partial.stage;
    },
  },
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: () => mocks.settings },
}));
vi.mock('@/lib/utils/deleted-stages', () => ({
  isStageWriteStale: () => false,
  stageDeletionEpoch: () => 0,
}));

import { generateAndPersistCourseCover } from '@/lib/livecourse/lesson/course-cover-runtime';

describe('generateAndPersistCourseCover', () => {
  beforeEach(() => {
    mocks.putAsset.mockReset().mockResolvedValue('asset-cover');
    mocks.markDirty.mockReset();
    mocks.settings.imageGenerationEnabled = true;
    mocks.stageState.stage = {
      id: 'stage-1',
      name: '傅里叶变换入门',
      createdAt: 1,
      updatedAt: 1,
      languageDirective: '简体中文',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url === '/api/generate/image') {
          return new Response(
            JSON.stringify({ success: true, result: { base64: btoa('cover') } }),
            { status: 200 },
          );
        }
        if (url.startsWith('data:')) {
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'Content-Type': 'image/png' },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores the generated cover on the stage', async () => {
    await generateAndPersistCourseCover({ stageId: 'stage-1' });
    expect(mocks.putAsset).toHaveBeenCalledOnce();
    expect(mocks.stageState.stage.coverAssetId).toBe('asset-cover');
    expect(mocks.stageState.stage.coverPrompt).toContain('teal waveform');
    expect(mocks.markDirty).toHaveBeenCalledWith([{ kind: 'stage' }]);
  });

  it('skips when image generation is disabled', async () => {
    mocks.settings.imageGenerationEnabled = false;
    await generateAndPersistCourseCover({ stageId: 'stage-1' });
    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not block when the image API fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: false, error: 'boom' }), { status: 500 }),
      ),
    );
    await expect(generateAndPersistCourseCover({ stageId: 'stage-1' })).rejects.toThrow(/boom|500/);
    expect(mocks.stageState.stage.coverAssetId).toBeUndefined();
  });
});

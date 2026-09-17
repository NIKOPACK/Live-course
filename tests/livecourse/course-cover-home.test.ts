// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listStages: vi.fn(),
  resolveCourseCoverUrls: vi.fn(),
  getFirstSlideByStages: vi.fn(),
  settings: {
    providerId: 'local',
    modelId: 'local-model',
    pdfProviderId: 'plain-text',
    providersConfig: {
      local: { name: 'Local', isServerConfigured: true, models: [{ id: 'local-model' }] },
    },
  },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: Object.assign(
    (select: (state: typeof mocks.settings) => unknown) => select(mocks.settings),
    { persist: { hasHydrated: () => true }, getState: () => mocks.settings },
  ),
}));
vi.mock('@/lib/store/user-profile', () => ({ useUserProfileStore: { getState: () => ({}) } }));
vi.mock('@/lib/utils/image-storage', () => ({
  storeDocumentBlob: vi.fn(),
  deleteDocumentBlob: vi.fn(),
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  listStages: mocks.listStages,
  getFirstSlideByStages: mocks.getFirstSlideByStages,
  loadStageData: async () => null,
  resolveCourseCoverUrls: mocks.resolveCourseCoverUrls,
  revokeCourseCoverUrls: vi.fn(),
  revokeThumbnailSlideMediaUrls: vi.fn(),
}));
vi.mock('@/lib/store/media-generation', () => ({
  useMediaGenerationStore: { getState: () => ({ revokeObjectUrls: vi.fn() }), setState: vi.fn() },
}));
vi.mock('@/lib/import/use-import-classroom', () => ({
  useImportClassroom: () => ({ importing: false }),
}));
vi.mock('@/lib/import/use-import-pptx', () => ({ useImportPptx: () => ({ importing: false }) }));
vi.mock('@/components/settings', () => ({ SettingsDialog: () => null }));
vi.mock('@/components/language-switcher', () => ({ LanguageSwitcher: () => null }));
vi.mock('@/components/audio/speech-button', () => ({ SpeechButton: () => null }));
vi.mock('@/components/slide-renderer/SlideThumbnail', () => ({ SlideThumbnail: () => null }));
vi.mock('@/components/livecourse/CourseEntryDialog', () => ({ CourseEntryDialog: () => null }));
vi.mock('@/lib/livecourse/session/course-state-repository', () => ({
  createCourseStateRepository: vi.fn(),
}));
vi.mock('@/lib/runtime/store', () => ({ getRuntimeStore: vi.fn() }));
vi.mock('@/lib/runtime/learner-key', () => ({ getLearnerKey: vi.fn() }));

import Page from '@/app/page';

describe('homepage course cover', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    mocks.listStages.mockReset().mockResolvedValue([
      {
        id: 'stage-1',
        name: '408操作系统核心考点精讲',
        sceneCount: 11,
        createdAt: 1,
        updatedAt: Date.now(),
        coverAssetId: 'asset-cover',
      },
    ]);
    mocks.getFirstSlideByStages.mockReset().mockResolvedValue({});
    mocks.resolveCourseCoverUrls.mockReset().mockResolvedValue({
      'stage-1': 'blob:cover',
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders the generated cover in the recent-course thumbnail slot', async () => {
    await act(async () => {
      root!.render(createElement(Page));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const cover = container.querySelector('[data-testid="course-cover"]');
    expect(cover).toBeTruthy();
    expect(cover?.getAttribute('src')).toBe('blob:cover');
  });
});

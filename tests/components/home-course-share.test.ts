// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listStages: vi.fn(),
  deleteUserClassroom: vi.fn(),
  createCourseShare: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  settings: {
    providerId: 'local',
    modelId: 'local-model',
    pdfProviderId: 'plain-text',
    providersConfig: {
      local: { name: 'Local', isServerConfigured: true, models: [{ id: 'local-model' }] },
    },
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${options.name}` : key,
  }),
}));
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
  getFirstSlideByStages: async () => ({}),
  loadStageData: async () => null,
  resolveCourseCoverUrls: async () => ({}),
  revokeCourseCoverUrls: vi.fn(),
  revokeThumbnailSlideMediaUrls: vi.fn(),
}));
vi.mock('@/lib/classroom/delete-user-classroom', () => ({
  deleteUserClassroom: mocks.deleteUserClassroom,
}));
vi.mock('@/lib/livecourse/share', () => ({
  createCourseShare: mocks.createCourseShare,
  clearShareRedeemRegistration: vi.fn(),
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

const completeStage = {
  id: 'stage-1',
  name: '傅里叶变换入门',
  sceneCount: 3,
  createdAt: 1,
  updatedAt: 1,
  generationComplete: true,
};

describe('homepage course share', () => {
  let container: HTMLDivElement;
  let root: Root;

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
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.listStages.mockResolvedValue([completeStage]);
    mocks.createCourseShare.mockResolvedValue({
      token: 'tok1234567890abcd',
      url: 'http://localhost/share/tok1234567890abcd',
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function renderHome() {
    await act(async () => {
      root.render(createElement(Page));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('shows a share column for generationComplete courses', async () => {
    await renderHome();
    expect(container.querySelector('[data-testid="share-course"]')).not.toBeNull();
  });

  it('ignores a second share click while the first request is in flight', async () => {
    let finish: ((value: { token: string; url: string }) => void) | undefined;
    mocks.createCourseShare.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await renderHome();
    const share = container.querySelector<HTMLButtonElement>('[data-testid="share-course"]')!;
    await act(async () => {
      share.click();
      share.click();
      await Promise.resolve();
    });
    expect(mocks.createCourseShare).toHaveBeenCalledTimes(1);
    expect(share.disabled).toBe(true);
    await act(async () => {
      finish?.({ token: 'tok1234567890abcd', url: 'http://localhost/share/tok1234567890abcd' });
      await Promise.resolve();
    });
  });

  it('hides share for incomplete, missing flag, showcase, and generating cards', async () => {
    mocks.listStages.mockResolvedValue([
      { ...completeStage, id: 'stage-incomplete', generationComplete: false },
      { ...completeStage, id: 'stage-missing', generationComplete: undefined },
      { ...completeStage, id: 'fourier-intro' },
    ]);
    await renderHome();
    expect(container.querySelectorAll('[data-testid="share-course"]')).toHaveLength(0);
  });
});

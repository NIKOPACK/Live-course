// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listStages: vi.fn(),
  deleteUserClassroom: vi.fn(),
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

const STAGE = {
  id: 'stage-1',
  name: '傅里叶变换入门',
  sceneCount: 3,
  createdAt: 1,
  updatedAt: Date.now(),
};

describe('homepage course delete', () => {
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
    mocks.listStages.mockReset().mockResolvedValue([STAGE]);
    mocks.deleteUserClassroom.mockReset().mockResolvedValue(undefined);
    mocks.push.mockReset();
    mocks.replace.mockReset();
    sessionStorage.clear();
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

  async function renderHome() {
    await act(async () => {
      root!.render(createElement(Page));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function click(element: Element) {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('opens a confirm dialog and cancel leaves the card and does not delete', async () => {
    await renderHome();
    expect(container.textContent).toContain('傅里叶变换入门');
    const deleteButton = container.querySelector('[data-testid="delete-course"]');
    expect(deleteButton).toBeTruthy();
    await click(deleteButton!);
    expect(document.body.textContent).toContain('home.deleteCourseTitle');
    await click(document.querySelector('[data-testid="delete-course-cancel"]')!);
    expect(mocks.deleteUserClassroom).not.toHaveBeenCalled();
    expect(container.textContent).toContain('傅里叶变换入门');
  });

  it('removes the card after confirm without flashing the whole shelf', async () => {
    await renderHome();
    await click(container.querySelector('[data-testid="delete-course"]')!);
    await click(document.querySelector('[data-testid="delete-course-confirm"]')!);
    expect(mocks.deleteUserClassroom).toHaveBeenCalledExactlyOnceWith('stage-1');
    expect(container.textContent).not.toContain('傅里叶变换入门');
    expect(container.textContent).toContain('home.recentEmpty');
    expect(container.textContent).not.toContain('home.loadingClassrooms');
  });

  it('does not open the course when the delete control is clicked', async () => {
    await renderHome();
    await click(container.querySelector('[data-testid="delete-course"]')!);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('keeps the card and dialog open when delete fails', async () => {
    mocks.deleteUserClassroom.mockRejectedValueOnce(new Error('DELETE /api/classroom failed: 500'));
    await renderHome();
    await click(container.querySelector('[data-testid="delete-course"]')!);
    await click(document.querySelector('[data-testid="delete-course-confirm"]')!);
    expect(container.textContent).toContain('傅里叶变换入门');
    expect(document.body.textContent).toContain('home.deleteCourseFailed');
    expect(document.querySelector('[data-testid="delete-course-confirm"]')).toBeTruthy();
  });

  it('clears a matching generation session so a preparing card cannot return', async () => {
    sessionStorage.setItem(
      'generationSession',
      JSON.stringify({
        sessionId: 'sess-1',
        stageId: 'stage-1',
        courseId: 'course-1',
        lessonId: 'lesson-1',
        currentStep: 'generating',
        requirements: { requirement: '傅里叶变换入门' },
      }),
    );
    await renderHome();
    await click(container.querySelector('[data-testid="delete-course"]')!);
    await click(document.querySelector('[data-testid="delete-course-confirm"]')!);
    expect(sessionStorage.getItem('generationSession')).toBeNull();
  });

  it('does not render delete on the showcase classroom', async () => {
    mocks.listStages.mockResolvedValueOnce([
      { ...STAGE, id: 'fourier-intro', name: '傅里叶变换直观入门' },
    ]);
    await renderHome();
    expect(container.textContent).toContain('傅里叶变换直观入门');
    expect(container.querySelector('[data-testid="delete-course"]')).toBeNull();
  });
});

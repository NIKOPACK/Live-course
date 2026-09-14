// @vitest-environment jsdom

import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  archiveLoad: vi.fn(),
  finalizeSession: vi.fn(),
  providerRender: vi.fn(),
  providerUnmount: vi.fn(),
  readContext: vi.fn(),
  stageRender: vi.fn(),
  generateRemaining: vi.fn(),
  generateMedia: vi.fn(),
  markGenerationCompleteIfDone: vi.fn(),
  stop: vi.fn(),
  retrySingleOutline: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  loadFromStorage: vi.fn(),
  onReplayEnd: null as (() => void) | null,
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'stage-1' }),
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/hooks/use-theme', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/lib/contexts/media-stage-context', () => ({
  MediaStageProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/lib/store', () => {
  const state = {
    stage: { id: 'stage-1', name: 'Course' },
    coursePlan: null,
    scenes: [],
    outlines: [{ id: 'pending', order: 0 }],
    generationComplete: false,
    markGenerationCompleteIfDone: mocks.markGenerationCompleteIfDone,
    loadFromStorage: mocks.loadFromStorage,
  };
  return {
    useStageStore: Object.assign(
      (selector?: (value: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state },
    ),
  };
});
vi.mock('@/lib/store/stage', () => ({
  claimStageSceneLoadToken: () => 1,
  isCurrentStageSceneLoadToken: () => true,
}));
vi.mock('@/lib/store/settings', () => ({ useSettingsStore: { getState: () => ({}) } }));
vi.mock('@/lib/store/media-generation', () => ({
  useMediaGenerationStore: {
    getState: () => ({ revokeObjectUrls: vi.fn() }),
    setState: vi.fn(),
  },
}));
vi.mock('@/lib/store/whiteboard-history', () => ({
  useWhiteboardHistoryStore: { getState: () => ({ clearHistory: vi.fn() }) },
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({}) },
}));
vi.mock('@/lib/utils/image-storage', () => ({ loadImageMapping: vi.fn(async () => ({})) }));
vi.mock('@/lib/media/media-orchestrator', () => ({
  generateMediaForOutlines: mocks.generateMedia,
}));
vi.mock('@/lib/hooks/use-scene-generator', () => ({
  useSceneGenerator: () => ({
    generateRemaining: mocks.generateRemaining,
    retrySingleOutline: mocks.retrySingleOutline,
    stop: mocks.stop,
  }),
}));
vi.mock('@/lib/classroom/load-classroom', () => ({
  defaultClassroomLoadDeps: {},
  applyClassroomStageAndScenes: vi.fn(),
  runClassroomLoad: async ({ setLoading }: { setLoading: (value: boolean) => void }) =>
    setLoading(false),
}));
vi.mock('@/lib/runtime/learner-key', () => ({ getLearnerKey: async () => 'learner-1' }));
vi.mock('@/lib/runtime/store', () => ({ getRuntimeStore: () => ({}) }));
vi.mock('@/lib/livecourse/session/course-state-repository', () => ({
  createCourseStateRepository: () => ({ load: mocks.archiveLoad }),
}));
vi.mock('@/lib/livecourse/session/context', () => ({
  LiveCourseSessionProvider: ({ children }: { children: ReactNode }) => {
    mocks.providerRender();
    useEffect(
      () => () => {
        mocks.providerUnmount();
      },
      [],
    );
    return children;
  },
  useLiveCourseSession: () => {
    mocks.readContext();
    return {
      status: 'ready',
      classroomState: 'finalizing',
      finalizeSession: mocks.finalizeSession,
    };
  },
}));
vi.mock('@/components/stage', () => ({
  Stage: (props: { presentationOnly?: boolean }) => {
    mocks.stageRender(props);
    return createElement('div', {
      'data-testid': props.presentationOnly ? 'replay-stage' : 'teaching-stage',
    });
  },
}));
vi.mock('@/components/livecourse/ReplayPresentationBoundary', () => ({
  ReplayPresentationBoundary: ({ children }: { children: (ports: object) => ReactNode }) =>
    children({ presentationStore: {}, replayBridge: {} }),
}));
vi.mock('@/components/livecourse/LiveCourseReplayHost', () => ({
  LiveCourseReplayHost: ({ onEnd }: { onEnd: () => void }) => {
    mocks.onReplayEnd = onEnd;
    return null;
  },
}));

import ClassroomDetailPage from '@/app/classroom/[id]/page';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Page lifecycle tests must not access the network');
    }),
  );
  window.history.replaceState({}, '', '/classroom/stage-1');
  sessionStorage.clear();
  mocks.archiveLoad.mockResolvedValue({ lifecycle: { status: 'archived' } });
  mocks.onReplayEnd = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function renderPage() {
  await act(async () => root.render(createElement(ClassroomDetailPage)));
}
function expectPostOnly() {
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'livecourse.postClassTitle',
  );
  expect(container.querySelector('[data-testid="teaching-stage"]')).toBeNull();
  expect(mocks.generateRemaining).not.toHaveBeenCalled();
  expect(mocks.generateMedia).not.toHaveBeenCalled();
  expect(mocks.markGenerationCompleteIfDone).not.toHaveBeenCalled();
}

describe('classroom page post-class ownership', () => {
  it('waits for the archive read, then mounts post choices without a teaching provider, stage or generation', async () => {
    let resolve!: (value: object) => void;
    mocks.archiveLoad.mockReturnValue(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    await renderPage();
    expect(mocks.providerRender).not.toHaveBeenCalled();
    expect(mocks.stageRender).not.toHaveBeenCalled();
    expect(mocks.generateRemaining).not.toHaveBeenCalled();
    await act(async () => resolve({ lifecycle: { status: 'archived' } }));
    expectPostOnly();
    expect(mocks.providerRender).not.toHaveBeenCalled();
    expect(mocks.readContext).not.toHaveBeenCalled();
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
  });

  it('returns from post replay without reintroducing the teaching provider or stage', async () => {
    await renderPage();
    const replay = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'livecourse.replay',
    );
    if (!replay) throw new Error('Replay choice missing');
    await act(async () => replay.click());
    expect(container.querySelector('[data-testid="replay-stage"]')).not.toBeNull();
    await act(async () => mocks.onReplayEnd?.());
    expectPostOnly();
    expect(mocks.stageRender.mock.calls.every(([props]) => props.presentationOnly === true)).toBe(
      true,
    );
    expect(mocks.providerRender).not.toHaveBeenCalled();
    expect(mocks.readContext).not.toHaveBeenCalled();
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
  });

  it('unmounts teaching only after finalization succeeds and does not hydrate again in post', async () => {
    mocks.archiveLoad.mockResolvedValue({ lifecycle: { status: 'in_progress' } });
    let resolve!: () => void;
    mocks.finalizeSession.mockReturnValue(
      new Promise<void>((yes) => {
        resolve = yes;
      }),
    );
    await renderPage();
    expect(container.querySelector('[data-testid="teaching-stage"]')).not.toBeNull();
    expect(mocks.finalizeSession).toHaveBeenCalledOnce();
    expect(mocks.providerUnmount).not.toHaveBeenCalled();
    const providerRenders = mocks.providerRender.mock.calls.length;
    const archiveReads = mocks.archiveLoad.mock.calls.length;
    await act(async () => resolve());
    expect(container.querySelector('[data-testid="teaching-stage"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'livecourse.postClassTitle',
    );
    expect(mocks.providerUnmount).toHaveBeenCalledOnce();
    expect(mocks.providerRender).toHaveBeenCalledTimes(providerRenders);
    expect(mocks.archiveLoad).toHaveBeenCalledTimes(archiveReads);
    expect(mocks.finalizeSession).toHaveBeenCalledOnce();
  });
});

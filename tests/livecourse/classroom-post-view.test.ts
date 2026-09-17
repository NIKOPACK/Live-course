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
  loadOptions: vi.fn(),
  getSession: vi.fn(),
  search: '',
  onReplayEnd: null as (() => void) | null,
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'stage-1' }),
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(mocks.search),
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
  runClassroomLoad: async (options: {
    setLoading: (value: boolean) => void;
    readOnly: boolean;
  }) => {
    mocks.loadOptions(options);
    options.setLoading(false);
  },
}));
vi.mock('@/lib/runtime/learner-key', () => ({ getLearnerKey: async () => 'learner-1' }));
vi.mock('@/lib/runtime/store', () => ({
  getRuntimeStore: () => ({ getSession: mocks.getSession }),
}));
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
  mocks.search = '';
  sessionStorage.clear();
  mocks.archiveLoad.mockResolvedValue({
    stageId: 'stage-1',
    learnerId: 'learner-1',
    courseId: 'stage-1',
    lessonId: 'stage-1',
    idempotencyKey: 'finalize:livecourse-actions:stage-1:learner-1:stage-1:stage-1',
    lifecycle: { status: 'archived' },
  });
  mocks.getSession.mockResolvedValue(undefined);
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
  it.each([undefined, 'pending', 'memory-finalized'] as const)(
    'recovers %s archives with remaining W2 without mounting teaching or replay',
    async (phase) => {
      const key = 'finalize:livecourse-actions:stage-1:learner-1:stage-1:stage-1';
      mocks.archiveLoad.mockResolvedValue({
        stageId: 'stage-1',
        learnerId: 'learner-1',
        courseId: 'stage-1',
        lessonId: 'stage-1',
        idempotencyKey: key,
        lifecycle: {
          status: 'archived',
          ...(phase ? { finalization: { version: 1, idempotencyKey: key, phase } } : {}),
        },
      });
      mocks.search = '';
      mocks.getSession.mockImplementation(async (id: string) =>
        id.startsWith('livecourse-working-memory:')
          ? { id, kind: 'livecourseWorkingMemory', stageId: 'stage-1', learnerKey: 'learner-1' }
          : undefined,
      );
      let finish!: () => void;
      mocks.finalizeSession.mockReturnValue(
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      );
      await renderPage();
      expect(mocks.finalizeSession).toHaveBeenCalledOnce();
      expect(container.querySelector('[data-testid="teaching-stage"]')).toBeNull();
      expect(container.querySelector('[data-testid="replay-stage"]')).toBeNull();
      expect(mocks.getSession.mock.calls.every(([id]) => !id.includes(':replay:'))).toBe(true);
      await act(async () => finish());
      expectPostOnly();
    },
  );

  it('fails closed when an old archive cannot identify the original teaching W', async () => {
    mocks.archiveLoad.mockResolvedValue({
      stageId: 'stage-1',
      learnerId: 'learner-1',
      courseId: 'stage-1',
      lessonId: 'stage-1',
      idempotencyKey: 'unidentified-legacy-writer',
      lifecycle: { status: 'archived' },
    });
    await renderPage();
    expect(container.textContent).toContain('already archived by an unknown writer');
    expect(mocks.providerRender).not.toHaveBeenCalled();
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
  });

  it.each(['home', 'post'])('never turns a %s replay entry into archive recovery', async (from) => {
    mocks.finalizeSession.mockResolvedValue(undefined);
    const key = 'finalize:livecourse-actions:stage-1:learner-1:stage-1:stage-1';
    mocks.search = `replay=1&from=${from}`;
    mocks.archiveLoad.mockResolvedValue({
      stageId: 'stage-1',
      learnerId: 'learner-1',
      courseId: 'stage-1',
      lessonId: 'stage-1',
      idempotencyKey: key,
      lifecycle: {
        status: 'archived',
        finalization: { version: 1, idempotencyKey: key, phase: 'pending' },
      },
    });
    mocks.getSession.mockImplementation(async (id: string) =>
      id.startsWith('livecourse-working-memory:')
        ? { id, kind: 'livecourseWorkingMemory', stageId: 'stage-1', learnerKey: 'learner-1' }
        : undefined,
    );
    await renderPage();
    expect(mocks.providerRender).not.toHaveBeenCalled();
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="teaching-stage"]')).toBeNull();
    expect(mocks.loadOptions.mock.calls[0][0].readOnly).toBe(true);
  });

  it.each(['choices', 'home', 'post'])('completed %s is read-only', async (entry) => {
    mocks.search = entry === 'choices' ? '' : `replay=1&from=${entry}`;
    const key = 'finalize:livecourse-actions:stage-1:learner-1:stage-1:stage-1';
    mocks.archiveLoad.mockResolvedValue({
      stageId: 'stage-1',
      learnerId: 'learner-1',
      courseId: 'stage-1',
      lessonId: 'stage-1',
      idempotencyKey: `${key}:memory-finalized`,
      lifecycle: {
        status: 'archived',
        finalization: { version: 1, idempotencyKey: key, phase: 'memory-finalized' },
      },
    });
    await renderPage();
    if (entry === 'choices') expectPostOnly();
    else expect(container.querySelector('[data-testid="replay-stage"]')).not.toBeNull();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(mocks.providerRender).not.toHaveBeenCalled();
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
  });

  it('keeps failed W cleanup verification retryable without exposing post', async () => {
    mocks.getSession.mockRejectedValue(new Error('W read unavailable'));
    await renderPage();
    expect(container.textContent).toContain('W read unavailable');
    expect(mocks.providerRender).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('livecourse.postClassTitle');
    expect(
      [...container.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('retry'),
      ),
    ).toBe(true);
  });

  it('uses reactive router replay parameters even before window history updates', async () => {
    await renderPage();
    expectPostOnly();
    mocks.search = 'replay=1&from=home';
    await renderPage();
    expect(container.querySelector('[data-testid="replay-stage"]')).not.toBeNull();
    expect(mocks.loadOptions.mock.calls.at(-1)?.[0].readOnly).toBe(true);
    expect(mocks.providerRender).not.toHaveBeenCalled();
    await act(async () => mocks.onReplayEnd?.());
    expect(mocks.push).toHaveBeenLastCalledWith('/?course=stage-1');
  });

  it('loads a direct replay route read-only before the first document request', async () => {
    mocks.search = 'replay=1&from=post';
    await renderPage();
    expect(mocks.loadOptions).toHaveBeenCalledOnce();
    expect(mocks.loadOptions.mock.calls[0][0].readOnly).toBe(true);
    expect(container.querySelector('[data-testid="replay-stage"]')).not.toBeNull();
    await act(async () => mocks.onReplayEnd?.());
    expectPostOnly();
    expect(mocks.push).not.toHaveBeenCalled();
  });

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
    await act(async () =>
      resolve({
        stageId: 'stage-1',
        learnerId: 'learner-1',
        courseId: 'stage-1',
        lessonId: 'stage-1',
        idempotencyKey: 'finalize:livecourse-actions:stage-1:learner-1:stage-1:stage-1',
        lifecycle: { status: 'archived' },
      }),
    );
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

  it('keeps the recovery provider without a teaching stage until finalization succeeds', async () => {
    mocks.archiveLoad.mockResolvedValue({ lifecycle: { status: 'in_progress' } });
    let resolve!: () => void;
    mocks.finalizeSession.mockReturnValue(
      new Promise<void>((yes) => {
        resolve = yes;
      }),
    );
    await renderPage();
    expect(container.querySelector('[data-testid="teaching-stage"]')).toBeNull();
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

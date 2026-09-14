// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type FakeController = {
    state: 'loading' | 'playing' | 'paused' | 'failed' | 'ended';
    position: string | null;
    start: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    getState: ReturnType<typeof vi.fn>;
    getPosition: ReturnType<typeof vi.fn>;
    notifyPlaybackFailure: ReturnType<typeof vi.fn>;
    hasPendingReplayAction: ReturnType<typeof vi.fn>;
    getRange: ReturnType<typeof vi.fn>;
    advanceResult: ReturnType<typeof vi.fn>;
    navigate: ReturnType<typeof vi.fn>;
  };

  const controllers: FakeController[] = [];
  const repositories: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const presentationRestore = vi.fn();
  const lifecycleEvents: string[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  let failNextStart = false;
  const getLearnerKey = vi.fn(async () => 'learner-1');
  const startRepository = vi.fn((..._args: unknown[]) => {
    lifecycleEvents.push('repository:create');
    const repository = { destroy: vi.fn(async () => undefined) };
    repositories.push(repository);
    return repository;
  });
  const startController = vi.fn((..._args: unknown[]) => {
    const controller = {} as FakeController;
    controller.state = 'loading';
    controller.position = null;
    controller.start = vi.fn(async () => {
      if (failNextStart) {
        failNextStart = false;
        throw new Error('replacement start failed');
      }
      controller.state = 'playing';
      controller.position = 'node:a';
      return {
        state: 'playing',
        range: ['node:a'],
        position: 'node:a',
        resumed: false,
      };
    });
    controller.end = vi.fn(async () => {
      controller.state = 'ended';
      return 'ended';
    });
    controller.getState = vi.fn(() => controller.state);
    controller.getPosition = vi.fn(async () => controller.position);
    controller.notifyPlaybackFailure = vi.fn(async () => {
      controller.state = 'failed';
      return 'failed';
    });
    controller.hasPendingReplayAction = vi.fn(() => false);
    controller.getRange = vi.fn(() => ['node:a']);
    controller.advanceResult = vi.fn(async () => ({
      status: 'at-end',
      position: controller.position,
    }));
    controller.navigate = vi.fn(async (nodeId: string) => {
      controller.position = nodeId;
      return { advanced: true, ended: false };
    });
    controllers.push(controller);
    return controller;
  });

  return {
    controllers,
    repositories,
    presentationRestore,
    lifecycleEvents,
    logger,
    failNextStart: () => {
      failNextStart = true;
    },
    getLearnerKey,
    startRepository,
    startController,
  };
});

vi.mock('@/components/ui/button', () => ({
  Button: (props: Record<string, unknown>) => createElement('button', props),
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => mocks.logger,
}));

vi.mock('@/lib/runtime/learner-key', () => ({
  getLearnerKey: mocks.getLearnerKey,
}));

vi.mock('@/lib/runtime/store', () => ({
  getRuntimeStore: () => ({}),
}));

vi.mock('@/lib/store', () => ({
  useStageStore: {
    getState: () => ({ stage: { id: 'stage-1' }, scenes: [], lessonPlan: null }),
  },
}));

vi.mock('@/lib/livecourse/session/action-repository', () => ({
  createTeachingActionRepository: mocks.startRepository,
}));

vi.mock('@/lib/livecourse/session/course-state-repository', () => ({
  createCourseStateRepository: () => ({
    load: vi.fn(async () => ({
      courseId: 'course-1',
      lessonId: 'lesson-1',
      completedNodeIds: ['node:a'],
      status: 'completed',
    })),
  }),
}));

vi.mock('@/lib/livecourse/session/context', () => ({
  createTeachingPresentationApplier: () => vi.fn(() => ({ success: true })),
  resolveLessonPlan: () => null,
}));

vi.mock('@/lib/livecourse/session/replay-playback-control', () => ({
  pauseReplayPlayback: vi.fn(),
  resumeReplayPlayback: vi.fn(),
  retryReplayPlayback: vi.fn(),
}));

vi.mock('@/lib/livecourse/session/controller', () => ({
  ClassroomPresentationCommitError: class ClassroomPresentationCommitError extends Error {},
  ReplayAppendUncertaintyError: class ReplayAppendUncertaintyError extends Error {},
  createReplaySessionController: mocks.startController,
}));

import { LiveCourseReplayHost } from '@/components/livecourse/LiveCourseReplayHost';

type Controls = {
  start: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

function controls(overrides: Partial<Controls> = {}): Controls {
  return {
    start: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    ...overrides,
  };
}

function presentationStore(onRestore: () => void = mocks.presentationRestore) {
  return {
    getState: vi.fn(() => ({ stage: null, scenes: [], currentSceneId: null, mode: 'play' })),
    setState: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    presentation: {
      restore: vi.fn(() => {
        mocks.lifecycleEvents.push('presentation:restore');
        onRestore();
      }),
      isDisposed: vi.fn(() => false),
    },
  } as never;
}

function bridge(initialControls?: Controls) {
  return {
    engineControls: initialControls,
  } as {
    engineControls?: Controls;
    complete?: () => void;
    reportPlaybackFailure?: (generation: number, cause?: unknown) => Promise<void>;
  };
}

let mounted: { root: Root; container: HTMLDivElement } | null = null;

async function render(node: ReturnType<typeof createElement>): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(node);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  });
}

function hostProps(
  replayBridge: ReturnType<typeof bridge>,
  store: ReturnType<typeof presentationStore> = presentationStore(),
) {
  return {
    courseId: 'course-1',
    lessonId: 'lesson-1',
    presentationStore: store,
    // The fake port intentionally uses Vitest mocks for imperative methods;
    // the runtime shape is the same as ReplayPresentationBridge.
    replayBridge: replayBridge as never,
    onEnd: vi.fn(),
    onAbort: vi.fn(),
  };
}

beforeEach(() => {
  mocks.controllers.length = 0;
  mocks.repositories.length = 0;
  mocks.presentationRestore.mockClear();
  mocks.lifecycleEvents.length = 0;
  mocks.logger.error.mockReset();
  mocks.logger.warn.mockReset();
  mocks.getLearnerKey.mockClear();
  mocks.startRepository.mockClear();
  mocks.startController.mockClear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (mounted) {
    await act(async () => {
      mounted?.root.unmount();
      await Promise.resolve();
    });
    await flush();
    mounted.container.remove();
    mounted = null;
  }
  vi.clearAllMocks();
});

describe('LiveCourseReplayHost lifecycle boundaries', () => {
  it('does not create or destroy a second replay W during StrictMode synthetic cleanup', async () => {
    const replayBridge = bridge(controls());
    await render(
      createElement(StrictMode, null, createElement(LiveCourseReplayHost, hostProps(replayBridge))),
    );
    await flush();

    expect(mocks.startRepository).toHaveBeenCalledTimes(1);
    expect(mocks.startController).toHaveBeenCalledTimes(1);
    expect(mocks.controllers[0]?.end).not.toHaveBeenCalled();
  });

  it('uses the current engine control port when ending after a port remount', async () => {
    const first = controls();
    const second = controls();
    const replayBridge = bridge(first);
    await render(createElement(LiveCourseReplayHost, hostProps(replayBridge)));
    await flush();

    replayBridge.engineControls = second;
    await act(async () => {
      replayBridge.complete?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(first.stop).not.toHaveBeenCalled();
    expect(second.stop).toHaveBeenCalledTimes(1);
    expect(mocks.controllers[0]?.end).toHaveBeenCalledTimes(1);
  });

  it('retains a failed state when a deferred initial engine start reports failure', async () => {
    const replayStart = vi.fn(async () => undefined);
    const replayBridge = bridge(controls({ start: replayStart }));
    await render(createElement(LiveCourseReplayHost, hostProps(replayBridge)));
    await flush();

    const replayStartCalls = replayStart.mock.calls as unknown as Array<
      [unknown, { requestGeneration?: number }]
    >;
    const requestGeneration = replayStartCalls.at(-1)?.[1]?.requestGeneration;
    if (typeof requestGeneration !== 'number') {
      throw new Error('initial replay start did not receive a request generation');
    }
    await replayBridge.reportPlaybackFailure?.(
      requestGeneration,
      new Error('deferred initial start failed'),
    );
    await flush();

    expect(mocks.controllers[0]?.notifyPlaybackFailure).toHaveBeenCalledTimes(1);
    expect(mocks.controllers[0]?.state).toBe('failed');
  });

  it('keeps replay W when engine stop fails during unmount cleanup', async () => {
    const replayBridge = bridge(
      controls({ stop: vi.fn(async () => Promise.reject(new Error('stop failed'))) }),
    );
    await render(createElement(LiveCourseReplayHost, hostProps(replayBridge)));
    await flush();

    await act(async () => {
      mounted?.root.unmount();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.controllers[0]?.end).not.toHaveBeenCalled();
    expect(mocks.repositories[0]?.destroy).not.toHaveBeenCalled();
  });

  it('does not create a replacement W when retry cleanup cannot stop the old engine', async () => {
    const replayBridge = bridge(controls());
    await render(createElement(LiveCourseReplayHost, hostProps(replayBridge)));
    await flush();

    const oldControls = replayBridge.engineControls!;
    oldControls.stop.mockImplementation(async () => {
      throw new Error('replacement stop failed');
    });
    const nextProps = { ...hostProps(replayBridge), courseId: 'course-2' };
    await act(async () => {
      mounted?.root.render(createElement(LiveCourseReplayHost, nextProps));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.startRepository).toHaveBeenCalledTimes(1);
    expect(mocks.startController).toHaveBeenCalledTimes(1);
    expect(mocks.controllers[0]?.end).not.toHaveBeenCalled();
  });

  it('keeps a failed replacement cleanup inactive until W destruction can be retried', async () => {
    const replayBridge = bridge(controls());
    const store = presentationStore();
    await render(createElement(LiveCourseReplayHost, hostProps(replayBridge, store)));
    await flush();

    const controller = mocks.controllers[0]!;
    controller.end.mockImplementationOnce(async () => {
      throw new Error('destroy failed');
    });
    await act(async () => {
      mounted?.root.render(
        createElement(LiveCourseReplayHost, {
          ...hostProps(replayBridge, store),
          courseId: 'course-2',
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(replayBridge.engineControls?.stop).toHaveBeenCalledTimes(1);
    expect(mocks.presentationRestore).not.toHaveBeenCalled();
    expect(mocks.startRepository).toHaveBeenCalledTimes(1);
    expect(mounted?.container.textContent).toContain('livecourse.replayLoadFailed');
    expect(mounted?.container.textContent).not.toContain('livecourse.pause');

    const retry = [...(mounted?.container.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'livecourse.retry',
    );
    if (!retry) throw new Error('replacement cleanup retry button missing');
    await act(async () => {
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(controller.end).toHaveBeenCalledTimes(2);
    expect(mocks.presentationRestore).toHaveBeenCalledTimes(1);
    expect(mocks.startRepository).toHaveBeenCalledTimes(2);
  });

  it('restores the old projection before creating a replacement W when the new start fails', async () => {
    const replayBridge = bridge(controls());
    await render(createElement(LiveCourseReplayHost, hostProps(replayBridge)));
    await flush();
    expect(mocks.startRepository).toHaveBeenCalledTimes(1);

    mocks.failNextStart();
    const nextProps = { ...hostProps(replayBridge), courseId: 'course-2' };
    await act(async () => {
      mounted?.root.render(createElement(LiveCourseReplayHost, nextProps));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.presentationRestore).toHaveBeenCalled();
    expect(mocks.startRepository).toHaveBeenCalledTimes(2);
    const restoreIndex = mocks.lifecycleEvents.indexOf('presentation:restore');
    const replacementRepositoryIndex = mocks.lifecycleEvents.lastIndexOf('repository:create');
    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    expect(restoreIndex).toBeLessThan(replacementRepositoryIndex);
  });

  it('does not create a replacement W when the old projection CAS restore fails', async () => {
    const replayBridge = bridge(controls());
    const restoreError = new Error('old projection restore failed');
    const oldStore = presentationStore(() => {
      throw restoreError;
    });
    await render(createElement(LiveCourseReplayHost, hostProps(replayBridge, oldStore)));
    await flush();

    await act(async () => {
      mounted?.root.render(
        createElement(LiveCourseReplayHost, {
          ...hostProps(replayBridge, oldStore),
          courseId: 'course-2',
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.startRepository).toHaveBeenCalledTimes(1);
    // W is ended first, but a failed projection restore still blocks creation
    // of the replacement owner until the same cleanup is explicitly retried.
    expect(mocks.controllers[0]?.end).toHaveBeenCalledTimes(1);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('restore presentation'),
      restoreError,
    );
  });

  it('does not restore or replace an owner with an unresolved replay action', async () => {
    const replayBridge = bridge(controls());
    await render(createElement(LiveCourseReplayHost, hostProps(replayBridge)));
    await flush();

    const controller = mocks.controllers[0]!;
    controller.hasPendingReplayAction.mockReturnValue(true);
    await act(async () => {
      mounted?.root.render(
        createElement(LiveCourseReplayHost, {
          ...hostProps(replayBridge),
          courseId: 'course-2',
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.startRepository).toHaveBeenCalledTimes(1);
    expect(mocks.presentationRestore).not.toHaveBeenCalled();
    expect(controller.end).not.toHaveBeenCalled();
  });

  it('retains a new owner when its failed start cannot restore the partial projection', async () => {
    const replayBridge = bridge(controls());
    const oldStore = presentationStore();
    await render(createElement(LiveCourseReplayHost, hostProps(replayBridge, oldStore)));
    await flush();

    const restoreError = new Error('new projection restore failed');
    const newStore = presentationStore(() => {
      throw restoreError;
    });
    mocks.failNextStart();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await act(async () => {
        mounted?.root.render(
          createElement(LiveCourseReplayHost, {
            ...hostProps(replayBridge, newStore),
            courseId: 'course-2',
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      await flush();
      await Promise.resolve();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(mocks.startRepository).toHaveBeenCalledTimes(2);
    expect(mocks.repositories[1]?.destroy).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('restore presentation'),
      restoreError,
    );
    expect(unhandled).toEqual([]);
    expect(mounted?.container.textContent).toContain('livecourse.replayLoadFailed');
  });

  it('does not resurrect an owner when end fails after the Host unmounts', async () => {
    let rejectEnd!: (cause: Error) => void;
    const firstEnd = new Promise<never>((_resolve, reject) => {
      rejectEnd = (cause) => reject(cause);
    });
    const replayBridge = bridge(controls());
    await render(createElement(LiveCourseReplayHost, hostProps(replayBridge)));
    await flush();

    const controller = mocks.controllers[0]!;
    controller.end.mockImplementationOnce(() => firstEnd);
    replayBridge.complete?.();
    await flush();
    expect(controller.end).toHaveBeenCalledTimes(1);

    await act(async () => {
      mounted?.root.unmount();
      await Promise.resolve();
    });
    rejectEnd(new Error('late end failure'));
    await flush();
    await flush();

    // Unmount cleanup retries the orphaned W instead of reattaching it to the
    // dead Host after the first end promise rejects.
    expect(controller.end.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('tokenizes engine restoration after a failed end for deferred failure reporting', async () => {
    const replayStart = vi.fn(async () => undefined);
    const replayBridge = bridge(controls({ start: replayStart }));
    await render(createElement(LiveCourseReplayHost, hostProps(replayBridge)));
    await flush();

    const controller = mocks.controllers[0]!;
    controller.end.mockImplementationOnce(async () => {
      throw new Error('destroy failed');
    });

    await act(async () => {
      replayBridge.complete?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    // One initial start plus one tokenized restoration after end fails.
    expect(replayStart).toHaveBeenCalledTimes(2);
    const replayStartCalls = replayStart.mock.calls as unknown as Array<
      [unknown, { requestGeneration?: number }]
    >;
    const requestGeneration = replayStartCalls.at(-1)?.[1]?.requestGeneration;
    expect(typeof requestGeneration).toBe('number');
    expect(replayBridge.reportPlaybackFailure).toBeTypeOf('function');

    if (typeof requestGeneration !== 'number') throw new Error('request generation was not passed');
    await replayBridge.reportPlaybackFailure!(
      requestGeneration,
      new Error('deferred start failed'),
    );
    expect(controller.notifyPlaybackFailure).toHaveBeenCalledTimes(1);
    expect(controller.state).toBe('failed');
  });
});

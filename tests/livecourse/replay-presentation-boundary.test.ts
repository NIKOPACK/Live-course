// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const createStore = vi.fn();
  return { createStore, logger };
});

vi.mock('@/lib/api/stage-api', () => ({
  createStagePresentationStore: mocks.createStore,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => mocks.logger,
}));

import {
  ReplayPresentationBoundary,
  type ReplayPresentationBridge,
} from '@/components/livecourse/ReplayPresentationBoundary';

function fakeStore(dispose: () => void) {
  return {
    getState: vi.fn(() => ({ stage: null, scenes: [], currentSceneId: null, mode: 'play' })),
    setState: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    presentation: {
      dispose,
      isDisposed: vi.fn(() => false),
    },
  } as never;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let bridge: ReplayPresentationBridge | null = null;

async function renderBoundary(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    const child = ({ replayBridge }: { replayBridge: ReplayPresentationBridge }) => {
      bridge = replayBridge;
      return null;
    };
    // The boundary intentionally models a render-prop API; passing this
    // function through `children` is the component contract, not nested JSX.
    // eslint-disable-next-line react/no-children-prop
    root?.render(createElement(ReplayPresentationBoundary, { children: child }));
    await Promise.resolve();
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  });
}

beforeEach(() => {
  mocks.createStore.mockReset();
  mocks.logger.error.mockReset();
  mocks.logger.warn.mockReset();
  bridge = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    await flushMicrotasks();
  }
  container?.remove();
  root = null;
  container = null;
  bridge = null;
  vi.clearAllMocks();
});

describe('ReplayPresentationBoundary termination', () => {
  it('reports a rejected tracked cleanup without creating an unhandled rejection', async () => {
    const cleanupError = new Error('replay cleanup failed');
    const dispose = vi.fn();
    mocks.createStore.mockReturnValue(fakeStore(dispose));
    await renderBoundary();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      bridge?.trackReplayCleanup?.(Promise.reject(cleanupError));
      await act(async () => {
        root?.unmount();
        await Promise.resolve();
      });
      await flushMicrotasks();
      // Give the host rejection observer one turn to run before asserting.
      await Promise.resolve();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('replay cleanup'),
      cleanupError,
    );
    expect(unhandled).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('reports a disposer failure through the observed termination path without an uncaught error', async () => {
    const disposeError = new Error('replay dispose failed');
    const dispose = vi.fn(() => {
      throw disposeError;
    });
    mocks.createStore.mockReturnValue(fakeStore(dispose));
    await renderBoundary();

    const uncaught: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      uncaught.push(event.error);
      event.preventDefault();
    };
    window.addEventListener('error', onError);
    try {
      await act(async () => {
        root?.unmount();
        await Promise.resolve();
      });
      await flushMicrotasks();
    } finally {
      window.removeEventListener('error', onError);
    }

    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('dispose'),
      disposeError,
    );
    expect(uncaught).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not render a new Boundary until the previous cleanup and dispose finish', async () => {
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const oldDispose = vi.fn();
    const newDispose = vi.fn();
    mocks.createStore
      .mockReturnValueOnce(fakeStore(oldDispose))
      .mockReturnValueOnce(fakeStore(newDispose));
    await renderBoundary();
    expect(bridge).not.toBeNull();
    bridge?.trackReplayCleanup?.(cleanup);

    const oldContainer = container;
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    oldContainer?.remove();
    root = null;
    container = null;
    bridge = null;

    await renderBoundary();
    // The second adapter may be constructed, but its Stage/Host children must
    // not project until the previous W cleanup and presentation dispose have
    // released the process-wide turn.
    expect(bridge).toBeNull();
    expect(oldDispose).not.toHaveBeenCalled();

    releaseCleanup();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(oldDispose).toHaveBeenCalledTimes(1);
    expect(bridge).not.toBeNull();
    expect(newDispose).not.toHaveBeenCalled();
  });
});

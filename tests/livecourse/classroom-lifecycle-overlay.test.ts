// @vitest-environment jsdom

import { act, createElement, Fragment, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  classroomState: 'finalizing',
  finalizeSession: vi.fn<() => Promise<void>>(),
  saveAndLeaveSession: vi.fn<() => Promise<void>>(),
  push: vi.fn<(_url: string) => void>(),
  onViewChange: vi.fn(),
  onReplay: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/livecourse/session/context', () => ({
  useLiveCourseSession: () => ({
    classroomState: mocks.classroomState,
    finalizeSession: mocks.finalizeSession,
    saveAndLeaveSession: mocks.saveAndLeaveSession,
  }),
  useLiveCourseSessionOptional: () => ({
    status: 'ready',
    classroomState: mocks.classroomState,
    currentNodeId: 'node-1',
    completedNodeIds: [],
    lessonPlan: { nodes: [{ id: 'node-1', title: 'Current lesson node' }] },
    saveAndLeaveSession: mocks.saveAndLeaveSession,
  }),
}));
vi.mock('@/lib/hooks/use-i18n', () => {
  const messages: Readonly<Record<string, string>> = {
    'livecourse.finalizing': 'Archiving classroom',
    'livecourse.finalizeFailed': 'Archive failed',
    'livecourse.retryFinalize': 'Retry archive',
    'livecourse.postClassTitle': 'Classroom completed',
    'livecourse.replay': 'Replay',
    'livecourse.leave': 'Leave',
    'livecourse.leaveFailed': 'Leave failed',
    'livecourse.leaveClassroom': 'Leave classroom',
    'livecourse.leaveSaving': 'Saving classroom',
    'livecourse.teaching': 'Teaching',
    'common.loading': 'Loading',
  };
  return { useI18n: () => ({ t: (key: string) => messages[key] ?? key }) };
});

// Exercise the actual Radix portal, focus scope and dismissable layer.
import {
  ClassroomLifecycleOverlay,
  PostClassChoice,
} from '@/components/livecourse/ClassroomLifecycleOverlay';
import { ClassroomSessionBar } from '@/components/livecourse/ClassroomSessionBar';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type ClassroomView = 'teach' | 'post';

function Harness({ initialView }: { initialView: ClassroomView }) {
  const [view, setView] = useState(initialView);
  return createElement(
    Fragment,
    null,
    createElement('button', { id: 'background-control' }, 'Background classroom control'),
    view === 'post'
      ? createElement(PostClassChoice, { onReplay: mocks.onReplay })
      : createElement(ClassroomLifecycleOverlay, {
          onFinalized: () => {
            mocks.onViewChange('post');
            setView('post');
          },
        }),
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Lifecycle UI tests must not access the network');
    }),
  );
  mocks.classroomState = 'finalizing';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderOverlay(view: ClassroomView = 'teach') {
  await act(async () => {
    root.render(createElement(StrictMode, null, createElement(Harness, { initialView: view })));
  });
  // Radix installs its outside-pointer listener on the next task.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!element) throw new Error('Expected the lifecycle dialog to remain open');
  return element;
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === label,
  );
}

function button(label: string): HTMLButtonElement {
  const element = findButton(label);
  if (!element) throw new Error(`Expected the ${label} button`);
  return element;
}

async function click(label: string) {
  await act(async () => {
    const element = button(label);
    element.focus();
    element.click();
  });
}

function expectNoPostActions() {
  expect(findButton('Replay')).toBeUndefined();
  expect(findButton('Leave')).toBeUndefined();
  expect(mocks.onViewChange).not.toHaveBeenCalled();
  expect(mocks.push).not.toHaveBeenCalled();
}

describe('ClassroomLifecycleOverlay — J3.8 / J4.1 / J4.3', () => {
  it('keeps ordinary teaching outside the lifecycle dialog without archiving', async () => {
    mocks.classroomState = 'teaching';
    await renderOverlay();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
    expect(mocks.onViewChange).not.toHaveBeenCalled();
  });

  it('archives once in StrictMode and exposes post-class choices only after success', async () => {
    const archive = deferred();
    mocks.finalizeSession.mockReturnValue(archive.promise);
    await renderOverlay();
    await renderOverlay();

    expect(mocks.finalizeSession).toHaveBeenCalledOnce();
    expect(dialog().querySelector('[role="status"]')?.textContent).toBe('Archiving classroom');
    expect(dialog().contains(document.activeElement)).toBe(true);
    expectNoPostActions();

    await act(async () => archive.resolve());

    expect(mocks.onViewChange).toHaveBeenCalledExactlyOnceWith('post');
    expect(button('Replay').disabled).toBe(false);
    expect(button('Leave').disabled).toBe(false);
    expect(dialog().querySelectorAll('button')).toHaveLength(2);
    expect(dialog().contains(document.activeElement)).toBe(true);
    expect(mocks.finalizeSession).toHaveBeenCalledOnce();
  });

  it('retains failed finalization and focus through a failed retry, then permits a successful retry', async () => {
    const archive = deferred();
    const retry = deferred();
    const successfulRetry = deferred();
    mocks.finalizeSession
      .mockReturnValueOnce(archive.promise)
      .mockReturnValueOnce(retry.promise)
      .mockReturnValueOnce(successfulRetry.promise);
    await renderOverlay();
    await act(async () => archive.reject(new Error('Course archive storage unavailable')));

    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('Archive failed');
    expect(button('Retry archive').disabled).toBe(false);
    expect(dialog().contains(document.activeElement)).toBe(true);
    expectNoPostActions();

    await act(async () => document.getElementById('background-control')?.focus());
    expect(dialog().contains(document.activeElement)).toBe(true);
    await click('Retry archive');

    expect(mocks.finalizeSession).toHaveBeenCalledTimes(2);
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    expect(dialog().querySelector('[role="status"]')).not.toBeNull();
    expect(findButton('Retry archive')).toBeUndefined();
    expect(dialog().contains(document.activeElement)).toBe(true);
    expectNoPostActions();

    await act(async () => retry.reject(new Error('Course archive storage still unavailable')));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('Archive failed');
    expect(dialog().contains(document.activeElement)).toBe(true);
    expectNoPostActions();

    await click('Retry archive');
    expect(mocks.finalizeSession).toHaveBeenCalledTimes(3);
    expectNoPostActions();
    await act(async () => successfulRetry.resolve());

    expect(mocks.onViewChange).toHaveBeenCalledExactlyOnceWith('post');
    expect(button('Replay').disabled).toBe(false);
    expect(button('Leave').disabled).toBe(false);
    expect(mocks.saveAndLeaveSession).not.toHaveBeenCalled();
  });

  it.each(['pending', 'failed', 'post'] as const)(
    'does not dismiss the %s dialog through Escape or outside interaction',
    async (state) => {
      const archive = deferred();
      mocks.finalizeSession.mockReturnValue(archive.promise);
      await renderOverlay(state === 'post' ? 'post' : 'teach');
      if (state === 'failed') {
        await act(async () => archive.reject(new Error('Archive failed')));
      }

      const content = dialog();
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        document.activeElement?.dispatchEvent(escape);
      });
      expect(escape.defaultPrevented).toBe(true);

      const overlay = document.querySelector('[data-slot="dialog-overlay"]');
      if (!overlay) throw new Error('Expected the actual dialog overlay');
      await act(async () => {
        overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
        document.getElementById('background-control')?.focus();
      });

      expect(dialog()).toBe(content);
      expect(dialog().getAttribute('data-state')).toBe('open');
      expect(dialog().contains(document.activeElement)).toBe(true);
      expect(container.getAttribute('aria-hidden')).toBe('true');
      expect(dialog().querySelector('[data-slot="dialog-close"]')).toBeNull();
      expect(mocks.onViewChange).not.toHaveBeenCalled();
      expect(mocks.push).not.toHaveBeenCalled();
      expect(mocks.finalizeSession).toHaveBeenCalledTimes(state === 'post' ? 0 : 1);
    },
  );

  it('loops keyboard focus between the two post-class actions', async () => {
    await renderOverlay('post');
    expect(document.activeElement).toBe(button('Replay'));
    await act(async () => {
      button('Leave').focus();
      button('Leave').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(button('Replay'));
    await act(async () => {
      button('Replay').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(button('Leave'));
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
  });

  it('leaves an archived classroom by navigation alone and prevents another action while navigating', async () => {
    await renderOverlay('post');
    await click('Leave');

    expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/');
    expect(button('Loading').getAttribute('aria-busy')).toBe('true');
    expect(button('Loading').disabled).toBe(true);
    expect(button('Replay').disabled).toBe(true);
    await click('Loading');
    await click('Replay');
    expect(mocks.push).toHaveBeenCalledOnce();
    expect(mocks.onReplay).not.toHaveBeenCalled();
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
    expect(mocks.saveAndLeaveSession).not.toHaveBeenCalled();
    expect(mocks.onViewChange).not.toHaveBeenCalled();
  });

  it('retains post-class choices when navigation throws and retries only navigation', async () => {
    mocks.push.mockImplementationOnce(() => {
      throw new Error('Router navigation failed');
    });
    await renderOverlay('post');
    await click('Leave');

    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('Leave failed');
    expect(button('Leave').disabled).toBe(false);
    expect(button('Replay').disabled).toBe(false);
    expect(dialog().contains(document.activeElement)).toBe(true);
    await click('Leave');

    expect(mocks.push.mock.calls).toEqual([['/'], ['/']]);
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
    expect(mocks.saveAndLeaveSession).not.toHaveBeenCalled();
    expect(mocks.onViewChange).not.toHaveBeenCalled();
  });

  it('starts replay only through its callback without navigating or finalizing again', async () => {
    await renderOverlay('post');
    await click('Replay');

    expect(mocks.onReplay).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
    expect(mocks.saveAndLeaveSession).not.toHaveBeenCalled();
  });
});

describe('ClassroomSessionBar — J3.7 save-and-leave feedback', () => {
  it('keeps navigation blocked while saving, exposes failure, and navigates only after retry succeeds', async () => {
    mocks.classroomState = 'teaching';
    const save = deferred();
    const retry = deferred();
    mocks.saveAndLeaveSession.mockReturnValueOnce(save.promise).mockReturnValueOnce(retry.promise);
    await act(async () => {
      root.render(
        createElement(ClassroomSessionBar, {
          onPlayPause: vi.fn(),
          onRetryCurrentNode: vi.fn(),
          playbackError: null,
        }),
      );
    });
    const leaveButton = [...container.querySelectorAll('button')].find(
      (element) => element.textContent === 'Leave classroom',
    );
    if (!leaveButton) throw new Error('Expected the save-and-leave button');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Teaching');

    await act(async () => leaveButton.click());
    expect(leaveButton.textContent).toBe('Saving classroom');
    expect(leaveButton.disabled).toBe(true);
    expect(leaveButton.getAttribute('aria-busy')).toBe('true');
    await act(async () => leaveButton.click());
    expect(mocks.saveAndLeaveSession).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();

    await act(async () => save.reject(new Error('Recovery point could not be saved')));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Leave failed');
    expect(leaveButton.disabled).toBe(false);
    expect(leaveButton.getAttribute('aria-busy')).toBe('false');
    expect(mocks.push).not.toHaveBeenCalled();

    await act(async () => leaveButton.click());
    expect(mocks.saveAndLeaveSession).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
    await act(async () => retry.resolve());
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/');
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
  });
});

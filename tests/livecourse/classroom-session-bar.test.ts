// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  classroomState: 'teaching',
  currentNodeId: 'node-1',
  completedNodeIds: [] as string[],
  nodes: [{ id: 'node-1', sceneId: 's1', title: 'Node 1', order: 0 }],
  push: vi.fn(),
  saveAndLeaveSession: vi.fn(async () => undefined),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'livecourse.classroomPage') {
        return `${options?.index} / ${options?.total}`;
      }
      return (
        {
          'livecourse.entryStatusInProgress': 'In progress',
          'livecourse.teaching': 'Teaching',
          'livecourse.retryCurrentNode': 'Retry current node',
          'livecourse.pause': 'Pause',
          'livecourse.startTeaching': 'Start teaching',
          'livecourse.teacherReady': 'Teacher is ready',
          'livecourse.resume': 'Resume',
          'livecourse.leaveClassroom': 'Leave classroom',
        }[key] ?? key
      );
    },
  }),
}));

vi.mock('@/lib/livecourse/session/context', () => ({
  useLiveCourseSessionOptional: () => ({
    status: 'ready',
    classroomState: mocks.classroomState,
    currentNodeId: mocks.currentNodeId,
    completedNodeIds: mocks.completedNodeIds,
    lessonPlan: { nodes: mocks.nodes },
    saveAndLeaveSession: mocks.saveAndLeaveSession,
  }),
}));

const stageState = {
  scenes: [{ id: 's1', title: 'Scene 1', order: 1 }],
  currentSceneId: 's1',
  getCurrentScene: () => ({ id: 's1', title: 'Scene 1', order: 1 }),
};

vi.mock('@/lib/store', () => ({
  useStageStore: (select?: (state: typeof stageState) => unknown) =>
    select ? select(stageState) : stageState,
}));

vi.mock('@/components/livecourse/InClassRelistenControl', () => ({
  InClassRelistenControl: () => null,
}));

import { ClassroomSessionBar } from '@/components/livecourse/ClassroomSessionBar';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.classroomState = 'teaching';
  mocks.currentNodeId = 'node-1';
  mocks.completedNodeIds = [];
  mocks.nodes = [{ id: 'node-1', sceneId: 's1', title: 'Node 1', order: 0 }];
  mocks.push.mockClear();
  mocks.saveAndLeaveSession.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

async function renderBar(props: ComponentProps<typeof ClassroomSessionBar>): Promise<void> {
  await act(async () => root?.render(createElement(ClassroomSessionBar, props)));
}

describe('ClassroomSessionBar controls', () => {
  it('navigates in lesson order without counting skipped chapters as completed', async () => {
    mocks.nodes = [
      { id: 'node-3', sceneId: 's3', title: 'Node 3', order: 2 },
      { id: 'node-1', sceneId: 's1', title: 'Node 1', order: 0 },
      { id: 'node-2', sceneId: 's2', title: 'Node 2', order: 1 },
    ];
    mocks.completedNodeIds = ['node-1'];
    const onChapterChange = vi.fn(async () => undefined);
    const props = {
      onPlayPause: vi.fn(),
      onRetryCurrentNode: vi.fn(),
      playbackError: null,
      onChapterChange,
    };
    await renderBar(props);
    const previous = () =>
      container!.querySelector<HTMLButtonElement>('[aria-label="livecourse.previousChapter"]')!;
    const next = () =>
      container!.querySelector<HTMLButtonElement>('[aria-label="livecourse.nextChapter"]')!;
    expect(previous().disabled).toBe(true);
    expect(next().disabled).toBe(false);
    await act(async () => next().click());
    expect(onChapterChange).toHaveBeenCalledWith('node-2');
    expect(container!.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('1');
    mocks.currentNodeId = 'node-3';
    await renderBar(props);
    expect(next().disabled).toBe(true);
    await act(async () => previous().click());
    expect(onChapterChange).toHaveBeenLastCalledWith('node-2');
    expect(container!.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('1');
  });

  it.each(['interrupted', 'replaying'])('disables chapter navigation during %s', async (state) => {
    mocks.classroomState = state;
    mocks.nodes.push({ id: 'node-2', sceneId: 's2', title: 'Node 2', order: 1 });
    const onChapterChange = vi.fn(async () => undefined);
    await renderBar({
      onPlayPause: vi.fn(),
      onRetryCurrentNode: vi.fn(),
      playbackError: null,
      onChapterChange,
    });
    expect(
      container!.querySelector<HTMLButtonElement>('[aria-label="livecourse.nextChapter"]')!
        .disabled,
    ).toBe(true);
    expect(onChapterChange).not.toHaveBeenCalled();
  });

  it('prevents double navigation and leaving during a pending switch, then exposes failure', async () => {
    mocks.nodes.push({ id: 'node-2', sceneId: 's2', title: 'Node 2', order: 1 });
    let reject!: (error: Error) => void;
    const onChapterChange = vi.fn(
      () =>
        new Promise<void>((_resolve, no) => {
          reject = no;
        }),
    );
    await renderBar({
      onPlayPause: vi.fn(),
      onRetryCurrentNode: vi.fn(),
      playbackError: null,
      onChapterChange,
    });
    const next = container!.querySelector<HTMLButtonElement>(
      '[aria-label="livecourse.nextChapter"]',
    )!;
    await act(async () => {
      next.click();
      next.click();
    });
    expect(onChapterChange).toHaveBeenCalledOnce();
    expect(next.disabled).toBe(true);
    const leave = [...container!.querySelectorAll('button')].find(
      (button) => button.textContent === 'Leave classroom',
    )!;
    expect(leave.disabled).toBe(true);
    await act(async () => reject(new Error('Position save failed')));
    expect(container!.querySelector('[role=alert]')?.textContent).toContain('Position save failed');
    expect(next.disabled).toBe(false);
    expect(mocks.saveAndLeaveSession).not.toHaveBeenCalled();
  });

  it('blocks duplicate start controls while connecting', async () => {
    const onPlayPause = vi.fn();
    await renderBar({
      onPlayPause,
      onRetryCurrentNode: vi.fn(),
      playbackError: null,
      playbackIdle: true,
      starting: true,
    });
    const button = [...container!.querySelectorAll('button')].find(
      (item) => item.textContent === 'livecourse.connectingTeacher',
    );
    expect(button?.disabled).toBe(true);
    await act(async () => button?.click());
    expect(onPlayPause).not.toHaveBeenCalled();
    expect(container?.querySelector('[data-testid="classroom-session-bar"]')?.className).toContain(
      'lc-classroom-session-header',
    );
  });

  it('keeps a waiting checkpoint idle rather than offering a misleading pause', async () => {
    mocks.classroomState = 'checking';
    await renderBar({
      onPlayPause: vi.fn(),
      onRetryCurrentNode: vi.fn(),
      playbackError: null,
      playbackIdle: true,
    });
    expect(container?.textContent).toContain('livecourse.checkpointAwaiting');
    expect(container?.textContent).not.toContain('Pause');
    expect(container?.textContent).not.toContain('Start teaching');
  });

  it('freezes speech before saving, and does not leave if that boundary fails', async () => {
    const onPrepareLeave = vi.fn<() => Promise<void>>(async () => {
      throw new Error('Could not pause teacher');
    });
    await renderBar({
      onPlayPause: vi.fn(),
      onRetryCurrentNode: vi.fn(),
      playbackError: null,
      onPrepareLeave,
    });
    const leave = [...container!.querySelectorAll('button')].find(
      (item) => item.textContent === 'Leave classroom',
    )!;
    await act(async () => leave.click());
    expect(mocks.saveAndLeaveSession).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(container?.textContent).toContain('livecourse.leaveFailed');
    const order: string[] = [];
    onPrepareLeave.mockImplementation(async () => {
      order.push('pause');
    });
    mocks.saveAndLeaveSession.mockImplementationOnce(async () => {
      order.push('save');
    });
    mocks.push.mockImplementationOnce(() => {
      order.push('navigate');
    });
    await act(async () => leave.click());
    expect(order).toEqual(['pause', 'save', 'navigate']);
  });
  it('labels an idle engine as start rather than pause without changing the command handler', async () => {
    const onPlayPause = vi.fn();
    await renderBar({
      onPlayPause,
      onRetryCurrentNode: vi.fn(),
      playbackError: null,
      playbackIdle: true,
    });
    const startButton = [...(container?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Start teaching',
    );
    if (!startButton) throw new Error('Start button was not rendered');
    expect(container?.querySelector('[role="status"]')?.textContent).toBe('Teacher is ready');
    await act(async () => startButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onPlayPause).toHaveBeenCalledOnce();
  });

  it('routes playback recovery to the node retry command, not play/pause', async () => {
    const onPlayPause = vi.fn();
    const onRetryCurrentNode = vi.fn();
    await renderBar({
      onPlayPause,
      onRetryCurrentNode,
      playbackError: 'node playback failed',
    });

    const retryButton = [...(container?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Retry current node',
    );
    if (!retryButton) throw new Error('Retry button was not rendered');
    await act(async () => retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(onRetryCurrentNode).toHaveBeenCalledOnce();
    expect(onPlayPause).not.toHaveBeenCalled();
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe('node playback failed');
  });

  it('exposes pause/resume transaction failures as an alert', async () => {
    await renderBar({
      onPlayPause: vi.fn(),
      onRetryCurrentNode: vi.fn(),
      playbackError: null,
      controlError: 'Playback state could not be restored',
    });

    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
      'Playback state could not be restored',
    );
  });

  it('shows the current page and node title instead of course-incomplete copy', async () => {
    await renderBar({
      onPlayPause: vi.fn(),
      onRetryCurrentNode: vi.fn(),
      playbackError: null,
    });

    expect(container?.textContent).toContain('1 / 1');
    expect(container?.textContent).toContain('Node 1');
    expect(container?.textContent).not.toContain('In progress');
  });
});

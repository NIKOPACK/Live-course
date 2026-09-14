// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeacherSpeechPort } from '@/lib/livecourse/realtime/client/teacher-speech';

let currentTeacher: TeacherSpeechPort | null = null;

const mocks = vi.hoisted(() => ({
  bridgeAudioElements: [] as HTMLAudioElement[],
  currentNodeType: 'instruction' as 'instruction' | 'checkpoint',
  classroomState: 'teaching' as 'teaching' | 'checking' | 'paused' | 'interrupted',
  desktop: true,
  emitAction: vi.fn(async (_input: unknown): Promise<void> => undefined),
  registryCleanupCount: 0,
  ask: vi.fn<(_text: string) => Promise<void>>(async () => undefined),
  speak: vi.fn(async (_text: string) => undefined),
  sessions: [] as Array<{
    closeCount: number;
    canInterrupt(): boolean;
    connect(): Promise<void>;
    close(): Promise<void>;
    emit(event: { type: string; [key: string]: unknown }): void;
    captureInterruption(nodeId: string): Promise<void>;
    resumeInterruption(nodeId: string): Promise<void>;
  }>,
}));

vi.mock('@/lib/livecourse/realtime/client/audio-bridge', () => ({
  RealtimeAudioBridge: class FakeRealtimeAudioBridge {
    readonly audioElement: HTMLAudioElement;

    constructor(audioElement: HTMLAudioElement) {
      this.audioElement = audioElement;
      mocks.bridgeAudioElements.push(audioElement);
    }
  },
  registerRealtimeAudioBridge: () => {
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      mocks.registryCleanupCount += 1;
    };
  },
}));

vi.mock('@/lib/livecourse/realtime/client/session', () => ({
  RealtimeInterruptionUncertaintyError: class RealtimeInterruptionUncertaintyError extends Error {
    override readonly name = 'RealtimeInterruptionUncertaintyError';

    constructor(
      readonly nodeId: string,
      readonly operationCause: unknown,
    ) {
      super('Classroom interruption confirmation is pending; playback remains paused');
    }
  },
  LiveCourseRealtimeSession: class FakeLiveCourseRealtimeSession {
    closeCount = 0;
    connected = false;
    readonly canInterrupt: () => boolean;
    readonly #onEvent?: (event: { type: string; [key: string]: unknown }) => void;
    readonly #interruptNode: (nodeId: string) => Promise<void>;
    readonly #resumeNode: (nodeId: string) => Promise<void>;
    #pendingNodeId: string | null = null;

    constructor(options: {
      onEvent?: (event: { type: string; [key: string]: unknown }) => void;
      interruptNode: (nodeId: string) => Promise<void>;
      resumeNode: (nodeId: string) => Promise<void>;
      canInterrupt: () => boolean;
    }) {
      this.#onEvent = options.onEvent;
      this.#interruptNode = options.interruptNode;
      this.#resumeNode = options.resumeNode;
      this.canInterrupt = options.canInterrupt;
      mocks.sessions.push(this);
    }

    async connect(): Promise<void> {
      this.connected = true;
      this.#onEvent?.({ type: 'status', status: 'connected' });
    }

    async close(): Promise<void> {
      this.closeCount += 1;
      if (this.#pendingNodeId) {
        const nodeId = this.#pendingNodeId;
        await this.#resumeNode(nodeId);
        this.#pendingNodeId = null;
        this.#onEvent?.({ type: 'node_resumed', nodeId });
      }
      this.#onEvent?.({ type: 'status', status: 'closed' });
      this.connected = false;
    }

    ask(text: string): Promise<void> {
      return mocks.ask(text);
    }
    speak(text: string): Promise<void> {
      return mocks.speak(text);
    }
    emit(event: { type: string; [key: string]: unknown }): void {
      this.#onEvent?.(event);
    }

    async captureInterruption(nodeId: string): Promise<void> {
      this.#pendingNodeId = nodeId;
      this.#onEvent?.({ type: 'interrupted', nodeId });
      try {
        await this.#interruptNode(nodeId);
      } catch (error) {
        if (error instanceof Error && error.name === 'RealtimeInterruptionUncertaintyError') {
          this.#onEvent?.({ type: 'interruption_uncertain', nodeId, error });
        } else {
          this.#pendingNodeId = null;
          this.#onEvent?.({ type: 'interruption_failed', nodeId, error });
        }
        throw error;
      }
    }

    async resumeInterruption(nodeId: string): Promise<void> {
      try {
        await this.#resumeNode(nodeId);
        this.#pendingNodeId = null;
        this.#onEvent?.({ type: 'node_resumed', nodeId });
      } catch (error) {
        this.#onEvent?.({ type: 'error', error });
        throw error;
      }
    }

    mute(): void {}

    interrupt(): void {}
  },
}));

vi.mock('@/lib/livecourse/session/context', () => ({
  useLiveCourseSessionOptional: () => ({
    courseId: 'course-1',
    lessonId: 'lesson-1',
    learnerId: 'learner-1',
    status: 'ready',
    classroomState: mocks.classroomState,
    currentNodeId: 'node-1',
    lessonPlan: {
      nodes: [{ id: 'node-1', type: mocks.currentNodeType, goalIds: ['goal-1'] }],
      goals: [
        {
          id: 'goal-1',
          title: 'Understand the lesson',
          description: 'Demonstrate the target skill.',
        },
      ],
    },
    goalStates: [
      {
        goalId: 'goal-1',
        status: 'in_progress',
        acceptedEvidenceCount: 0,
        pendingReviewCount: 0,
      },
    ],
    error: null,
    emitAction: mocks.emitAction,
  }),
}));

vi.mock('@/lib/store', () => ({
  useStageStore: (
    selector: (state: {
      getCurrentScene: () => { id: string; title: string; actions: [] };
    }) => unknown,
  ) => selector({ getCurrentScene: () => ({ id: 'scene-1', title: 'Scene 1', actions: [] }) }),
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    locale: 'zh-CN',
    setLocale: vi.fn(),
    t: (key: string) =>
      key === 'livecourse.realtimeRecognitionFailed'
        ? '没听清，请再说一次（恢复点已保留）'
        : key === 'livecourse.realtimeInterruptionPending'
          ? '插话状态待确认，播放已暂停；请重试或断开以恢复主线'
          : key,
  }),
}));

vi.mock('@/components/ui/tooltip', async () => {
  const { Fragment } = await import('react');
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children);
  return {
    Tooltip: Passthrough,
    TooltipContent: Passthrough,
    TooltipTrigger: Passthrough,
  };
});

vi.mock('next/image', () => ({
  default: (props: { alt: string }) => createElement('img', props),
}));

vi.mock('@/components/livecourse/TeacherAvatar', () => ({
  TeacherAvatar: () => createElement('div', { 'data-testid': 'teacher-avatar' }),
}));

import { RealtimeTeacherControls } from '@/components/livecourse/RealtimeTeacherControls';
import { TeacherAvatarHost } from '@/components/livecourse/TeacherAvatarHost';
import { ClassroomAppendUncertaintyError } from '@/lib/livecourse/session/controller';
import { RealtimePlaybackControlError } from '@/lib/livecourse/session/realtime-playback-control';

function appendUncertaintyError(): ClassroomAppendUncertaintyError {
  return new ClassroomAppendUncertaintyError(
    {
      schemaVersion: 1,
      id: 'action-interrupt-1',
      courseId: 'course-1',
      lessonId: 'lesson-1',
      nodeId: 'node-1',
      sequence: 1,
      timestamp: '2026-09-02T00:00:00.000Z',
      idempotencyKey: 'realtime:interrupt:test',
      type: 'lesson.interrupt',
      payload: {},
    },
    new Error('append response lost'),
    new Error('reconciliation failed'),
  );
}

interface MountedComponent {
  container: HTMLDivElement;
  root: Root;
}

let mounted: MountedComponent | null = null;

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

async function render(component: ReactNode): Promise<MountedComponent> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(component));
  mounted = { container, root };
  return mounted;
}

beforeEach(() => {
  currentTeacher = null;
  mocks.bridgeAudioElements.length = 0;
  mocks.currentNodeType = 'instruction';
  mocks.classroomState = 'teaching';
  mocks.desktop = true;
  mocks.emitAction.mockClear();
  mocks.registryCleanupCount = 0;
  mocks.sessions.length = 0;
  mocks.ask.mockReset().mockResolvedValue(undefined);
  mocks.speak.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: mocks.desktop,
      media: '(min-width: 640px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (mounted) {
    await act(async () => mounted?.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  vi.clearAllMocks();
});

describe('Realtime teacher controls lifecycle', () => {
  it('keeps interrupted questions retryable but blocks input while paused', async () => {
    const view = await render(createElement(RealtimeTeacherControls));
    await click(getButton(view.container, '连接实时语音'));
    const realtime = mocks.sessions[0];
    expect(realtime.canInterrupt()).toBe(true);
    mocks.classroomState = 'interrupted';
    await act(async () => view.root.render(createElement(RealtimeTeacherControls)));
    expect(realtime.canInterrupt()).toBe(true);
    mocks.classroomState = 'paused';
    await act(async () => view.root.render(createElement(RealtimeTeacherControls)));
    expect(realtime.canInterrupt()).toBe(false);
  });
  it('coalesces repeated text submits while the teacher is answering', async () => {
    const { container } = await render(createElement(RealtimeTeacherControls));
    const textarea = container.querySelector('textarea')!;
    let finish!: () => void;
    mocks.ask.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Explain this.',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      const form = container.querySelector('form')!;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mocks.ask).toHaveBeenCalledOnce();
    expect(textarea.disabled).toBe(true);
    expect(textarea.value).toBe('Explain this.');
    await act(async () => {
      finish();
    });
    expect(textarea.value).toBe('');
    expect(textarea.disabled).toBe(false);
  });
  it('exposes the same connected teacher to lecture playback', async () => {
    const { container } = await render(
      createElement(RealtimeTeacherControls, {
        onTeacherChange: (teacher) => {
          currentTeacher = teacher;
        },
      }),
    );
    expect(currentTeacher).not.toBeNull();
    await expect(currentTeacher!.speak('Before connection')).rejects.toThrow();
    await act(async () => currentTeacher!.connect());
    await act(async () => currentTeacher!.speak('The first teaching sentence.'));
    expect(mocks.speak).toHaveBeenCalledWith('The first teaching sentence.');
    expect(container.querySelector('textarea')).not.toBeNull();
  });

  it('retains a typed question on failure and clears it after a successful retry', async () => {
    const { container } = await render(createElement(RealtimeTeacherControls));
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Question input was not rendered');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Why?',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    mocks.ask.mockRejectedValueOnce(new Error('Question transport failed'));
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(textarea.value).toBe('Why?');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Question transport failed',
    );
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(textarea.value).toBe('');
    expect(mocks.ask).toHaveBeenCalledTimes(2);
  });
  it('releases local playback when interruption freeze reports a rollback failure', async () => {
    const freezeError = new RealtimePlaybackControlError(
      new Error('freeze failed after mutation'),
      [new Error('playback rollback failed')],
    );
    const onPlaybackInterrupt = vi.fn().mockRejectedValue(freezeError);
    const onPlaybackResume = vi.fn();
    const { container } = await render(
      createElement(RealtimeTeacherControls, { onPlaybackInterrupt, onPlaybackResume }),
    );

    await click(getButton(container, '连接实时语音'));
    const activeSession = mocks.sessions[0];
    if (!activeSession) throw new Error('Realtime session was not created');

    await expect(
      act(async () => {
        await activeSession.captureInterruption('node-1');
      }),
    ).rejects.toBe(freezeError);
    expect(onPlaybackResume).toHaveBeenCalledWith('node-1');
  });

  it('freezes playback on learner VAD and exposes a retryable recognition error', async () => {
    const onPlaybackInterrupt = vi.fn();
    const onPlaybackResume = vi.fn();
    const { container } = await render(
      createElement(RealtimeTeacherControls, { onPlaybackInterrupt, onPlaybackResume }),
    );

    await click(getButton(container, '连接实时语音'));
    const activeSession = mocks.sessions[0];
    if (!activeSession) throw new Error('Realtime session was not created');

    await act(async () => {
      await activeSession.captureInterruption('node-1');
      await Promise.resolve();
    });
    expect(onPlaybackInterrupt).toHaveBeenCalledWith('node-1');
    expect(mocks.emitAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lesson.interrupt', nodeId: 'node-1' }),
    );

    await act(async () => {
      activeSession.emit({
        type: 'recognition_failed',
        error: new Error('could not transcribe'),
        nodeId: 'node-1',
      });
      await Promise.resolve();
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('请再说一次');
    expect(alert?.textContent).toContain('恢复点已保留');

    await act(async () => {
      await activeSession.resumeInterruption('node-1');
      await Promise.resolve();
    });
    expect(onPlaybackResume).toHaveBeenCalledWith('node-1');
  });

  it('keeps playback frozen and reconciles the same interrupt key after an uncertain append', async () => {
    let interruptWrites = 0;
    mocks.emitAction.mockImplementation(async (input) => {
      const action = input as { type: string };
      if (action.type !== 'lesson.interrupt') return;
      interruptWrites += 1;
      if (interruptWrites === 1) throw appendUncertaintyError();
    });
    const onPlaybackInterrupt = vi.fn();
    const onPlaybackResume = vi.fn();
    const { container } = await render(
      createElement(RealtimeTeacherControls, { onPlaybackInterrupt, onPlaybackResume }),
    );

    await click(getButton(container, '连接实时语音'));
    const activeSession = mocks.sessions[0];
    if (!activeSession) throw new Error('Realtime session was not created');

    await expect(
      act(async () => {
        await activeSession.captureInterruption('node-1');
      }),
    ).rejects.toThrow('confirmation is pending');
    await act(async () => {
      await Promise.resolve();
    });
    expect(onPlaybackInterrupt).toHaveBeenCalledTimes(1);
    expect(onPlaybackResume).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('播放已暂停');

    await act(async () => {
      await activeSession.resumeInterruption('node-1');
    });

    const interruptActions = mocks.emitAction.mock.calls
      .map(([input]) => input as { type: string; idempotencyKey?: string })
      .filter((input) => input.type === 'lesson.interrupt');
    expect(interruptActions).toHaveLength(2);
    expect(interruptActions[1]?.idempotencyKey).toBe(interruptActions[0]?.idempotencyKey);
    expect(onPlaybackResume).toHaveBeenCalledWith('node-1');
  });

  it('compensates the classroom when local playback cannot resume', async () => {
    const onPlaybackInterrupt = vi.fn();
    const onPlaybackResume = vi.fn().mockRejectedValueOnce(new Error('local resume failed'));
    const { container } = await render(
      createElement(RealtimeTeacherControls, { onPlaybackInterrupt, onPlaybackResume }),
    );

    await click(getButton(container, '连接实时语音'));
    const activeSession = mocks.sessions[0];
    if (!activeSession) throw new Error('Realtime session was not created');

    await act(async () => {
      await activeSession.captureInterruption('node-1');
    });
    await expect(
      act(async () => {
        await activeSession.resumeInterruption('node-1');
      }),
    ).rejects.toThrow('local resume failed');

    const interruptionActions = mocks.emitAction.mock.calls
      .map(([input]) => input as { type: string; idempotencyKey?: string })
      .filter((input) => input.type === 'lesson.interrupt');
    expect(interruptionActions).toHaveLength(2);
    expect(interruptionActions[1]?.idempotencyKey).toMatch(/:compensate:0$/);
    expect(onPlaybackResume).toHaveBeenCalledWith('node-1');
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('local resume failed');

    // W is interrupted again, so the same frozen node can resume on a later
    // successful response without creating a second teaching path.
    await act(async () => {
      await activeSession.resumeInterruption('node-1');
    });
    expect(onPlaybackResume).toHaveBeenCalledTimes(2);
  });

  it('retries a failed resume compensation with the same key', async () => {
    let interruptWrites = 0;
    mocks.emitAction.mockImplementation(async (input) => {
      const action = input as { type: string };
      if (action.type === 'lesson.interrupt') {
        interruptWrites += 1;
        if (interruptWrites === 2) throw new Error('compensation write failed');
      }
    });
    const onPlaybackResume = vi.fn().mockRejectedValueOnce(new Error('local resume failed'));
    const { container } = await render(
      createElement(RealtimeTeacherControls, {
        onPlaybackInterrupt: vi.fn(),
        onPlaybackResume,
      }),
    );

    await click(getButton(container, '连接实时语音'));
    const activeSession = mocks.sessions[0];
    if (!activeSession) throw new Error('Realtime session was not created');
    await act(async () => {
      await activeSession.captureInterruption('node-1');
    });

    await expect(
      act(async () => {
        await activeSession.resumeInterruption('node-1');
      }),
    ).rejects.toThrow('Classroom resume failed');
    await expect(
      act(async () => {
        await activeSession.resumeInterruption('node-1');
      }),
    ).rejects.toThrow('Interruption restored');

    const compensationKeys = mocks.emitAction.mock.calls
      .map(([input]) => input as { type: string; idempotencyKey?: string })
      .filter(
        (input) =>
          input.type === 'lesson.interrupt' && input.idempotencyKey?.includes(':compensate:'),
      )
      .map((input) => input.idempotencyKey);
    expect(compensationKeys).toHaveLength(2);
    expect(new Set(compensationKeys).size).toBe(1);

    await act(async () => {
      await activeSession.resumeInterruption('node-1');
    });
    expect(onPlaybackResume).toHaveBeenCalledTimes(2);
  });

  it('advances the compensation key across distinct failed resume attempts', async () => {
    const onPlaybackResume = vi
      .fn()
      .mockRejectedValueOnce(new Error('first local resume failed'))
      .mockRejectedValueOnce(new Error('second local resume failed'));
    const { container } = await render(
      createElement(RealtimeTeacherControls, {
        onPlaybackInterrupt: vi.fn(),
        onPlaybackResume,
      }),
    );

    await click(getButton(container, '连接实时语音'));
    const activeSession = mocks.sessions[0];
    if (!activeSession) throw new Error('Realtime session was not created');
    await act(async () => {
      await activeSession.captureInterruption('node-1');
    });

    await expect(
      act(async () => {
        await activeSession.resumeInterruption('node-1');
      }),
    ).rejects.toThrow('first local resume failed');
    await expect(
      act(async () => {
        await activeSession.resumeInterruption('node-1');
      }),
    ).rejects.toThrow('second local resume failed');
    await act(async () => {
      await activeSession.resumeInterruption('node-1');
    });

    const compensationKeys = mocks.emitAction.mock.calls
      .map(([input]) => input as { type: string; idempotencyKey?: string })
      .filter(
        (input) =>
          input.type === 'lesson.interrupt' && input.idempotencyKey?.includes(':compensate:'),
      )
      .map((input) => input.idempotencyKey);
    expect(compensationKeys).toHaveLength(2);
    expect(compensationKeys[0]).toMatch(/:compensate:0$/);
    expect(compensationKeys[1]).toMatch(/:compensate:1$/);
    expect(onPlaybackResume).toHaveBeenCalledTimes(3);
  });

  it('keeps the connected controls retryable when disconnect cannot release playback', async () => {
    const onPlaybackResume = vi.fn().mockRejectedValueOnce(new Error('disconnect release failed'));
    const { container } = await render(
      createElement(RealtimeTeacherControls, {
        onPlaybackInterrupt: vi.fn(),
        onPlaybackResume,
      }),
    );

    await click(getButton(container, '连接实时语音'));
    const activeSession = mocks.sessions[0];
    if (!activeSession) throw new Error('Realtime session was not created');
    await act(async () => {
      await activeSession.captureInterruption('node-1');
    });

    await click(getButton(container, '断开实时语音'));

    expect(getButton(container, '断开实时语音')).toBeDefined();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'disconnect release failed',
    );

    await click(getButton(container, '断开实时语音'));
    expect(getButton(container, '连接实时语音')).toBeDefined();
  });

  it('uses a fresh audio element after disconnecting and reconnecting', async () => {
    const { container } = await render(createElement(RealtimeTeacherControls));
    const firstAudio = container.querySelector('audio');
    if (!firstAudio) throw new Error('Initial audio element was not rendered');

    await click(getButton(container, '连接实时语音'));
    expect(mocks.bridgeAudioElements).toEqual([firstAudio]);

    await click(getButton(container, '断开实时语音'));
    const secondAudio = container.querySelector('audio');
    if (!secondAudio) throw new Error('Replacement audio element was not rendered');

    expect(secondAudio).not.toBe(firstAudio);
    expect(firstAudio.isConnected).toBe(false);
    expect(mocks.sessions[0]?.closeCount).toBe(1);

    await click(getButton(container, '连接实时语音'));
    expect(mocks.bridgeAudioElements).toEqual([firstAudio, secondAudio]);
    expect(mocks.sessions).toHaveLength(2);
  });

  it('keeps the realtime session mounted when the avatar panel is collapsed', async () => {
    const { container, root } = await render(createElement(TeacherAvatarHost));
    const audio = container.querySelector('audio');
    if (!audio) throw new Error('Realtime controls were not rendered');

    await click(getButton(container, '连接实时语音'));
    const activeSession = mocks.sessions[0];
    if (!activeSession) throw new Error('Realtime session was not created');

    await click(getButton(container, '收起 AI 教师'));

    expect(activeSession.closeCount).toBe(0);
    expect(mocks.registryCleanupCount).toBe(0);
    expect(container.querySelector('audio')).toBe(audio);
    expect(container.querySelector('[data-testid="teacher-avatar"]')).toBeNull();
    expect(getButton(container, '展开 AI 教师')).toBeDefined();

    await act(async () => root.unmount());
    mounted = null;
    container.remove();
    expect(activeSession.closeCount).toBe(1);
    expect(mocks.registryCleanupCount).toBe(1);
  });

  it('does not mount the VRM avatar until the panel is visible on mobile', async () => {
    mocks.desktop = false;
    const { container } = await render(createElement(TeacherAvatarHost));

    expect(container.querySelector('[data-testid="teacher-avatar"]')).toBeNull();
    expect(container.querySelector('audio')).not.toBeNull();

    await click(getButton(container, '展开 AI 教师'));
    expect(container.querySelector('[data-testid="teacher-avatar"]')).not.toBeNull();
  });

  it('opens checkpoint controls from the compact bottom-sheet entry on narrow screens', async () => {
    mocks.currentNodeType = 'checkpoint';
    mocks.desktop = false;
    const { container } = await render(createElement(TeacherAvatarHost));
    const compactButton = getButton(container, '展开 AI 教师');

    expect(compactButton.className).toContain('bottom-3');
    await click(compactButton);

    expect(container.querySelector('aside')?.className).toContain('bottom-3');
    expect(container.querySelector('[data-testid="teacher-avatar"]')).not.toBeNull();
  });

  it('keeps the teacher lectern open at desktop checkpoints', async () => {
    mocks.currentNodeType = 'checkpoint';
    const { container } = await render(createElement(TeacherAvatarHost));

    expect(container.querySelector('[data-testid="teacher-avatar"]')).not.toBeNull();
    expect(getButton(container, '收起 AI 教师')).toBeDefined();
  });

  it('shows realtime controls directly during mobile presentation', async () => {
    mocks.desktop = false;
    const { container } = await render(createElement(TeacherAvatarHost, { isPresenting: true }));

    expect(container.querySelector('aside')?.className.split(' ')).toContain('flex');
    expect(container.querySelector('audio')).not.toBeNull();
    expect(container.querySelector('[data-testid="teacher-avatar"]')).toBeNull();
  });
});

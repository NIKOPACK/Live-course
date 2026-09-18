// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeacherSpeechPort } from '@/lib/livecourse/realtime/client/teacher-speech';
import { useHtmlQuestionContext } from '@/lib/livecourse/html/question-context';
import { useLiveCaptionStore } from '@/lib/store/live-caption';
import type { PlaybackSpeechContext } from '@/lib/playback/types';

let currentTeacher: TeacherSpeechPort | null = null;

const mocks = vi.hoisted(() => ({
  bridgeAudioElements: [] as HTMLAudioElement[],
  currentNodeType: 'instruction' as 'instruction' | 'checkpoint',
  currentSceneId: 'scene-1',
  classroomState: 'teaching' as 'teaching' | 'checking' | 'paused' | 'interrupted',
  desktop: true,
  emitAction: vi.fn(async (_input: unknown): Promise<void> => undefined),
  registryCleanupCount: 0,
  ask: vi.fn<(_text: string) => Promise<void>>(async () => undefined),
  connect: vi.fn<() => Promise<void>>(async () => undefined),
  speak: vi.fn(async (_text: string) => undefined),
  mute: vi.fn((_muted: boolean) => undefined),
  question: vi.fn(async (_question: unknown, _options: unknown) => undefined),
  hintOralQuestion: vi.fn(async () => undefined),
  retryOralQuestion: vi.fn(async () => undefined),
  endOralQuestion: vi.fn(async () => undefined),
  sessions: [] as Array<{
    closeCount: number;
    canInterrupt(): boolean;
    getTeachingContext(): string;
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
  getActiveLipSyncAudioNode: () => null,
  subscribeRealtimeAudioBridge: () => () => undefined,
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
    readonly getTeachingContext: () => string;
    readonly #onEvent?: (event: { type: string; [key: string]: unknown }) => void;
    readonly #interruptNode: (nodeId: string) => Promise<void>;
    readonly #resumeNode: (nodeId: string) => Promise<void>;
    #pendingNodeId: string | null = null;

    constructor(options: {
      onEvent?: (event: { type: string; [key: string]: unknown }) => void;
      interruptNode: (nodeId: string) => Promise<void>;
      resumeNode: (nodeId: string) => Promise<void>;
      canInterrupt: () => boolean;
      getTeachingContext: () => string;
    }) {
      this.#onEvent = options.onEvent;
      this.#interruptNode = options.interruptNode;
      this.#resumeNode = options.resumeNode;
      this.canInterrupt = options.canInterrupt;
      this.getTeachingContext = options.getTeachingContext;
      mocks.sessions.push(this);
    }

    async connect(): Promise<void> {
      await mocks.connect();
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
    question = mocks.question;
    hintOralQuestion = mocks.hintOralQuestion;
    retryOralQuestion = mocks.retryOralQuestion;
    endOralQuestion = mocks.endOralQuestion;
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

    mute(muted: boolean): void {
      mocks.mute(muted);
      this.#onEvent?.({ type: 'muted', muted });
    }

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
      getCurrentScene: () => {
        id: string;
        title: string;
        actions: [];
        content: { type: string; html: string };
      };
    }) => unknown,
  ) =>
    selector({
      getCurrentScene: () => ({
        id: mocks.currentSceneId,
        title: 'Scene 1',
        actions: [],
        content: {
          type: 'interactive',
          html: '<html><head><script data-livecourse-teacher-bridge></script></head></html>',
        },
      }),
    }),
}));

vi.mock('@/lib/hooks/use-i18n', async () => {
  const { default: zh } = await import('@/lib/i18n/locales/zh-CN.json');
  const voiceLabels = new Map(
    Object.entries(zh.livecourse)
      .filter(([key]) => key.startsWith('voice') || key.startsWith('microphone'))
      .map(([key, value]) => [`livecourse.${key}`, value]),
  );
  return {
    useI18n: () => ({
      locale: 'zh-CN',
      setLocale: vi.fn(),
      t: (key: string, values?: Record<string, string>) =>
        key === 'livecourse.quotedQuestion'
          ? `Quote: ${values?.quote}\nQuestion: ${values?.question}`
          : key === 'livecourse.realtimeRecognitionFailed'
            ? '没听清，请再说一次（恢复点已保留）'
            : key === 'livecourse.realtimeInterruptionPending'
              ? '插话状态待确认，播放已暂停；请重试或断开以恢复主线'
              : (voiceLabels.get(key) ?? key),
    }),
  };
});

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
  TeacherAvatar: (props: { lookAt?: string; expression?: string; mode?: string }) =>
    createElement('div', {
      'data-testid': 'teacher-avatar',
      'data-avatar-look-at': props.lookAt,
      'data-avatar-expression': props.expression,
      'data-avatar-mode': props.mode,
    }),
}));

import { RealtimeTeacherControls } from '@/components/livecourse/RealtimeTeacherControls';
import { TeacherAvatarHost } from '@/components/livecourse/TeacherAvatarHost';
import { teachingActionBus } from '@/lib/livecourse/actions/bus';
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
  useHtmlQuestionContext.getState().clearQuote();
  useLiveCaptionStore.getState().clearCaption();
  currentTeacher = null;
  mocks.bridgeAudioElements.length = 0;
  mocks.currentNodeType = 'instruction';
  mocks.currentSceneId = 'scene-1';
  mocks.classroomState = 'teaching';
  mocks.desktop = true;
  mocks.emitAction.mockClear();
  mocks.registryCleanupCount = 0;
  mocks.sessions.length = 0;
  mocks.ask.mockReset().mockResolvedValue(undefined);
  mocks.connect.mockReset().mockResolvedValue(undefined);
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
  it.each([false, true])(
    'reads the live playback anchor through the avatar host (presence=%s) without leaking another scene',
    async (presence) => {
      let context: PlaybackSpeechContext = {
        sceneId: 'scene-1',
        lastCompletedText: 'Already played.',
        resumeText: 'Unfinished passage.',
        nextText: 'Following passage.',
      };
      const { container } = await render(
        createElement(TeacherAvatarHost, {
          presence,
          getPlaybackSpeechContext: () => context,
        }),
      );
      await click(getButton(container, '连接实时语音'));
      const session = mocks.sessions[0];
      expect(session.getTeachingContext()).toContain('Already played.');
      expect(session.getTeachingContext()).toContain('Unfinished passage.');
      context = { ...context, resumeText: 'Later unfinished passage.' };
      expect(session.getTeachingContext()).toContain('Later unfinished passage.');
      expect(session.getTeachingContext()).not.toContain('Unfinished passage.');
      context = { ...context, sceneId: 'other-scene', resumeText: 'Wrong scene content.' };
      expect(session.getTeachingContext()).not.toContain('Wrong scene content.');
      expect(session.getTeachingContext()).toContain('Scene 1');
    },
  );

  it('does not overwrite resumed teacher captions with the answered learner question', async () => {
    const { container } = await render(createElement(RealtimeTeacherControls));
    await click(getButton(container, '连接实时语音'));
    const session = mocks.sessions[0];
    mocks.ask.mockImplementationOnce(async (text) => {
      session.emit({ type: 'transcript', speaker: 'student', text });
      session.emit({ type: 'transcript', speaker: 'teacher', text: 'The explanation continues.' });
    });
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Why?',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(getButton(container, 'livecourse.sendQuestion'));
    expect(useLiveCaptionStore.getState().caption).toMatchObject({
      speaker: 'teacher',
      text: 'The explanation continues.',
    });
    expect(textarea.value).toBe('');
  });

  it('labels the lectern connection and microphone without starting teaching', async () => {
    const { container } = await render(createElement(RealtimeTeacherControls, { tone: 'lectern' }));
    expect(container.querySelector('[role=status]')?.textContent).toBe('语音未连接');
    expect(getButton(container, '连接实时语音').textContent).toContain('连接语音');
    await click(getButton(container, '连接实时语音'));
    expect(container.querySelector('[role=status]')?.textContent).toBe('语音已连接');
    expect(mocks.speak).not.toHaveBeenCalled();
    expect(mocks.emitAction).not.toHaveBeenCalled();
    expect(getButton(container, '静音麦克风').textContent).toBe('麦克风已开');
    await click(getButton(container, '静音麦克风'));
    expect(mocks.mute).toHaveBeenCalledWith(true);
    expect(getButton(container, '打开麦克风').getAttribute('aria-pressed')).toBe('true');
    expect(getButton(container, '打开麦克风').textContent).toBe('麦克风已关');
    await click(getButton(container, '打开麦克风'));
    expect(mocks.mute).toHaveBeenLastCalledWith(false);
  });

  it('keeps secondary lectern voice actions keyboard-accessible in a menu', async () => {
    const { container } = await render(createElement(RealtimeTeacherControls, { tone: 'lectern' }));
    await click(getButton(container, '连接实时语音'));
    const audio = container.querySelector('audio');
    expect(container.querySelector('[aria-label="断开实时语音"]')).toBeNull();
    const trigger = getButton(container, '更多语音操作');
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const items = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')];
    const interrupt = items.find((item) => item.textContent === '打断教师')!;
    expect(interrupt.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector('audio')).toBe(audio);
    expect(mocks.sessions[0].closeCount).toBe(0);
    const disconnect = items.find((item) => item.textContent === '断开实时语音')!;
    await act(async () => disconnect.click());
    expect(mocks.sessions[0].closeCount).toBe(1);
    expect(getButton(container, '连接实时语音')).toBeDefined();
  });

  it('grows the lectern input within a limit and preserves drafts while paused', async () => {
    const view = await render(createElement(RealtimeTeacherControls, { tone: 'lectern' }));
    const textarea = view.container.querySelector('textarea')!;
    expect(textarea.rows).toBe(2);
    expect(textarea.labels?.[0]?.textContent).toBe('livecourse.questionTitle');
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 320 });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'A question with several lines.\nPlease explain the second step.',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(textarea.style.height).toBe('144px');
    mocks.classroomState = 'paused';
    await act(async () =>
      view.root.render(createElement(RealtimeTeacherControls, { tone: 'lectern' })),
    );
    expect(textarea.disabled).toBe(true);
    expect(textarea.value).toContain('Please explain the second step.');
    expect(
      view.container.querySelector(`[id="${textarea.getAttribute('aria-describedby')}"]`)
        ?.textContent,
    ).toBe('livecourse.questionPausedHint');
    mocks.classroomState = 'teaching';
    await act(async () =>
      view.root.render(createElement(RealtimeTeacherControls, { tone: 'lectern' })),
    );
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toContain('Please explain the second step.');
  });

  it('sends only explicit Enter, not a newline or an IME confirmation', async () => {
    const { container } = await render(createElement(RealtimeTeacherControls, { tone: 'lectern' }));
    const quickButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'livecourse.questionExample',
    )!;
    await click(quickButton);
    const textarea = container.querySelector('textarea')!;
    for (const options of [{ shiftKey: true }, { isComposing: true }]) {
      await act(async () => {
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...options }),
        );
      });
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(mocks.sessions).toHaveLength(0);
    }
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(mocks.ask).toHaveBeenCalledOnce();
    expect(mocks.ask).toHaveBeenCalledWith('livecourse.questionExamplePrompt');
    expect(textarea.value).toBe('');
  });

  it('exposes the oral speech port and keeps ordinary drafts and quotes separate from oral answers', async () => {
    useHtmlQuestionContext.getState().setQuote({ sceneId: 'scene-1', text: 'An unsent quote' });
    const { container } = await render(
      createElement(RealtimeTeacherControls, {
        onTeacherChange: (teacher) => {
          currentTeacher = teacher;
        },
      }),
    );
    await click(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'livecourse.questionExample',
      )!,
    );
    await act(async () => {
      await currentTeacher?.connect();
    });
    const planned = { question: 'Why does the slope change?', guidance: 'Reason about the rate.' };
    const options = { hintText: 'Hint.', resumeText: 'Continue.' };
    await act(async () => {
      await currentTeacher?.question?.(planned, options);
    });
    expect(mocks.question).toHaveBeenCalledWith(planned, options);
    await act(async () =>
      mocks.sessions[0].emit({
        type: 'oral_question',
        state: {
          phase: 'waiting',
          question: planned.question,
          teacherText: 'What changes locally?',
          answer: '',
          answeredRounds: 0,
          error: null,
        },
      }),
    );
    expect(container.querySelector('[data-testid=classroom-oral-question]')?.textContent).toContain(
      planned.question,
    );
    expect(container.querySelector('[role=group]')).toBeNull();
    expect(container.querySelector('[data-testid=classroom-question-quote]')).toBeNull();
    const textarea = container.querySelector('textarea')!;
    expect(textarea.value).toBe('');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'The local rate changes.',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    mocks.ask.mockRejectedValueOnce(new Error('Response failed'));
    await click(getButton(container, 'livecourse.sendQuestion'));
    expect(textarea.value).toBe('The local rate changes.');
    await click(getButton(container, 'livecourse.sendQuestion'));
    expect(mocks.ask).toHaveBeenLastCalledWith('The local rate changes.');
    expect(textarea.value).toBe('');
    expect(useHtmlQuestionContext.getState().quote?.text).toBe('An unsent quote');
    await act(async () => mocks.sessions[0].emit({ type: 'oral_question', state: null }));
    expect(textarea.value).toBe('livecourse.questionExamplePrompt');
    expect(container.querySelector('[data-testid=classroom-question-quote]')).not.toBeNull();
  });

  it('gates oral hints, retry and continuation by the current dialogue phase', async () => {
    const { container } = await render(createElement(RealtimeTeacherControls));
    await click(getButton(container, '连接实时语音'));
    const state = { question: 'Why?', teacherText: '', answer: '', answeredRounds: 0, error: null };
    const emit = async (phase: string) => {
      await act(async () =>
        mocks.sessions[0].emit({ type: 'oral_question', state: { ...state, phase } }),
      );
    };
    const button = (key: string) =>
      [...container.querySelectorAll('button')].find((item) => item.textContent === key)!;
    await emit('asking');
    expect(container.querySelector('textarea')!.disabled).toBe(true);
    expect(button('livecourse.oralContinue').disabled).toBe(true);
    await emit('waiting');
    await click(button('livecourse.questionHint'));
    expect(mocks.hintOralQuestion).toHaveBeenCalledOnce();
    await emit('failed');
    await click(button('livecourse.oralRetry'));
    expect(mocks.retryOralQuestion).toHaveBeenCalledOnce();
    await click(button('livecourse.oralContinue'));
    expect(mocks.endOralQuestion).toHaveBeenCalledOnce();
  });
  it('prepares editable quick questions without connecting, interrupting or overwriting a draft', async () => {
    const { container } = await render(createElement(RealtimeTeacherControls));
    const textarea = container.querySelector('textarea')!;
    const quickButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'livecourse.questionExample',
    )!;
    await click(quickButton);
    expect(textarea.value).toBe('livecourse.questionExamplePrompt');
    expect(document.activeElement).toBe(textarea);
    expect(mocks.sessions).toHaveLength(0);
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.emitAction).not.toHaveBeenCalled();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'My own question.',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(quickButton);
    await click(quickButton);
    expect(textarea.value).toBe('My own question.\nlivecourse.questionExamplePrompt');
    await click(getButton(container, 'livecourse.sendQuestion'));
    expect(mocks.ask).toHaveBeenCalledWith('My own question.\nlivecourse.questionExamplePrompt');
  });

  it('preserves typed content at the length limit rather than truncating it for a quick question', async () => {
    const { container } = await render(createElement(RealtimeTeacherControls));
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'x'.repeat(2000),
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const quickButtons = container.querySelectorAll<HTMLButtonElement>('[role=group] button');
    expect(quickButtons.length).toBe(3);
    expect([...quickButtons].every((button) => button.disabled)).toBe(true);
    expect(textarea.value).toHaveLength(2000);
  });

  it('sends a visible quote only on explicit submission and retains it after a failed ask', async () => {
    useHtmlQuestionContext
      .getState()
      .setQuote({ sceneId: 'scene-1', text: '<em>Secant slope</em>' });
    const { container } = await render(createElement(RealtimeTeacherControls));
    const quoted = container.querySelector('[data-testid=classroom-question-quote]')!;
    expect(quoted.textContent).toContain('<em>Secant slope</em>');
    expect(quoted.querySelector('em')).toBeNull();
    expect(mocks.ask).not.toHaveBeenCalled();
    const hint = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'livecourse.questionHint',
    )!;
    await click(hint);
    mocks.ask.mockRejectedValueOnce(new Error('Question failed'));
    await click(getButton(container, 'livecourse.sendQuestion'));
    const expected = 'Quote: <em>Secant slope</em>\nQuestion: livecourse.questionHintPrompt';
    expect(mocks.ask).toHaveBeenCalledWith(expected);
    expect(container.querySelector('textarea')!.value).toBe('livecourse.questionHintPrompt');
    expect(useHtmlQuestionContext.getState().quote?.text).toBe('<em>Secant slope</em>');
    await click(getButton(container, 'livecourse.sendQuestion'));
    expect(mocks.ask).toHaveBeenLastCalledWith(expected);
    expect(useHtmlQuestionContext.getState().quote).toBeNull();
    expect(container.querySelector('textarea')!.value).toBe('');
  });

  it('removes a quote without changing the question or asking the teacher', async () => {
    useHtmlQuestionContext.getState().setQuote({ sceneId: 'scene-1', text: 'Current passage' });
    const { container } = await render(createElement(RealtimeTeacherControls));
    const rephrase = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'livecourse.questionRephrase',
    )!;
    await click(rephrase);
    await click(getButton(container, 'livecourse.removeQuestionQuote'));
    expect(useHtmlQuestionContext.getState().quote).toBeNull();
    expect(container.querySelector('textarea')!.value).toBe('livecourse.questionRephrasePrompt');
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it('does not consume a newer selection when the previous question finishes', async () => {
    useHtmlQuestionContext.getState().setQuote({ sceneId: 'scene-1', text: 'First passage' });
    const { container } = await render(createElement(RealtimeTeacherControls));
    let finish!: () => void;
    mocks.ask.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const rephrase = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'livecourse.questionRephrase',
    )!;
    await click(rephrase);
    await click(getButton(container, 'livecourse.sendQuestion'));
    await act(async () => {
      useHtmlQuestionContext.getState().setQuote({ sceneId: 'scene-1', text: 'Next passage' });
      finish();
    });
    expect(useHtmlQuestionContext.getState().quote?.text).toBe('Next passage');
  });

  it('supports checkpoint hints but blocks submission and shortcuts while paused', async () => {
    mocks.currentNodeType = 'checkpoint';
    mocks.classroomState = 'checking';
    const view = await render(createElement(RealtimeTeacherControls));
    const hint = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'livecourse.questionHint',
    )!;
    await click(hint);
    await click(getButton(view.container, 'livecourse.sendQuestion'));
    expect(mocks.ask).toHaveBeenCalledWith('livecourse.questionHintPrompt');
    mocks.classroomState = 'paused';
    await act(async () => view.root.render(createElement(RealtimeTeacherControls)));
    expect(hint.disabled).toBe(true);
    await act(async () => {
      view.container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mocks.ask).toHaveBeenCalledTimes(1);
  });

  it('does not show a quotation from another classroom page', async () => {
    useHtmlQuestionContext.getState().setQuote({ sceneId: 'other-scene', text: 'Other page' });
    const { container } = await render(createElement(RealtimeTeacherControls));
    expect(container.querySelector('[data-testid=classroom-question-quote]')).toBeNull();
  });

  it.each(['page', 'pause'] as const)(
    'keeps the question without sending if %s changes while voice connects',
    async (change) => {
      let connect!: () => void;
      mocks.connect.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            connect = resolve;
          }),
      );
      const view = await render(createElement(RealtimeTeacherControls));
      const example = [...view.container.querySelectorAll('button')].find(
        (button) => button.textContent === 'livecourse.questionExample',
      )!;
      await click(example);
      await click(getButton(view.container, 'livecourse.sendQuestion'));
      if (change === 'page') mocks.currentSceneId = 'scene-2';
      else mocks.classroomState = 'paused';
      await act(async () => view.root.render(createElement(RealtimeTeacherControls)));
      await act(async () => connect());
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(view.container.querySelector('textarea')!.value).toBe(
        'livecourse.questionExamplePrompt',
      );
      expect(view.container.querySelector('[role=alert]')?.textContent).toBe(
        'livecourse.questionContextChanged',
      );
    },
  );

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

  it('closes the live session through the speech port while still mounted', async () => {
    const { container } = await render(
      createElement(RealtimeTeacherControls, {
        onTeacherChange: (teacher) => {
          currentTeacher = teacher;
        },
      }),
    );
    await click(getButton(container, '连接实时语音'));
    expect(mocks.sessions[0]?.closeCount).toBe(0);
    expect(mocks.registryCleanupCount).toBe(0);

    await act(async () => {
      await currentTeacher?.close();
    });

    expect(mocks.sessions[0]?.closeCount).toBe(1);
    expect(mocks.registryCleanupCount).toBe(1);
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

  it('keeps the lectern teacher facing the learner when the board is a slide', async () => {
    const { container } = await render(
      createElement(TeacherAvatarHost, { presence: true, docked: true }),
    );
    await act(async () => {
      await teachingActionBus.publish({
        schemaVersion: 1,
        id: 'action-look',
        courseId: 'course-1',
        lessonId: 'lesson-1',
        nodeId: 'node-1',
        sequence: 1,
        timestamp: '2026-09-14T00:00:00.000Z',
        idempotencyKey: 'look-1',
        type: 'avatar.look_at',
        payload: { target: 'slides' },
      });
    });
    expect(
      container.querySelector('[data-avatar-look-at]')?.getAttribute('data-avatar-look-at'),
    ).toBe('camera');
  });

  it('does not freeze a grinning open mouth while the lectern teacher speaks', async () => {
    const { container } = await render(
      createElement(TeacherAvatarHost, { presence: true, docked: true }),
    );
    await act(async () => {
      await teachingActionBus.publish({
        schemaVersion: 1,
        id: 'action-speak',
        courseId: 'course-1',
        lessonId: 'lesson-1',
        nodeId: 'node-1',
        sequence: 1,
        timestamp: '2026-09-14T00:00:00.000Z',
        idempotencyKey: 'speak-1',
        type: 'avatar.speech_start',
        payload: { text: '今天这堂课只做一件事。' },
      });
    });
    const avatar = container.querySelector('[data-testid="teacher-avatar"]');
    expect(avatar?.getAttribute('data-avatar-mode')).toBe('speaking');
    expect(avatar?.getAttribute('data-avatar-expression')).toBe('relaxed');
  });
});

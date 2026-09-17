// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import { BrowserRuntimeStore, type RuntimeStore } from '@livecourse/storage';
import { act, createElement, Fragment, useCallback, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lessonPlanSchema, type LessonPlan } from '@/lib/livecourse/domain';
import type { TeacherSpeechPort } from '@/lib/livecourse/realtime/client/teacher-speech';
import {
  LiveCourseSessionProvider,
  useLiveCourseSession,
  type LiveCourseSessionValue,
} from '@/lib/livecourse/session/context';
import { createCourseStateRepository } from '@/lib/livecourse/session/course-state-repository';
import { listEvidenceRecords } from '@/lib/livecourse/evidence/runtime-repository';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import type { Scene } from '@/lib/types/stage';
import { PlaybackChromeRoot } from '@/components/edit/PlaybackChromeRoot';
import { ReplayPresentationBoundary } from '@/components/livecourse/ReplayPresentationBoundary';
import { LiveCourseReplayHost } from '@/components/livecourse/LiveCourseReplayHost';
import { useLiveCaptionStore } from '@/lib/store/live-caption';
import {
  ClassroomLifecycleOverlay,
  PostClassChoice,
} from '@/components/livecourse/ClassroomLifecycleOverlay';
import { COURSE_ID, LESSON_ONE, makeCourseSnapshotInput } from './course-state-fixture';
import { makeAdjustmentCoursePlan } from './evidence-fixture';

interface SpeechRequest {
  text: string;
  signal?: AbortSignal;
  finish: () => void;
  fail: (cause: Error) => void;
}
const mocks = vi.hoisted(() => ({
  store: null as RuntimeStore | null,
  teacher: null as TeacherSpeechPort | null,
  speech: [] as SpeechRequest[],
  routerPush: vi.fn(),
  finalized: vi.fn(),
  playbackHandlers: {} as {
    onPlaybackInterrupt?: (nodeId: string) => Promise<void>;
    onPlaybackResume?: (nodeId: string) => Promise<void>;
  },
  discussion: { cleanup: vi.fn(), handleSegmentSealed: vi.fn(), shouldHold: vi.fn() },
}));
vi.mock('@/lib/runtime/store', () => ({ getRuntimeStore: () => mocks.store }));
vi.mock('@/lib/runtime/learner-key', () => ({ getLearnerKey: async () => 'learner-1' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.routerPush }) }));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
vi.mock('@/lib/hooks/use-discussion-tts', () => ({ useDiscussionTTS: () => mocks.discussion }));
vi.mock('@/components/audio/speech-button', () => ({ SpeechButton: () => null }));
vi.mock('@/lib/livecourse/session/replay-speech', () => ({
  createReplaySpeech: () => {
    if (!mocks.teacher) throw new Error('Replay teacher is not configured');
    return { ...mocks.teacher, close: async () => undefined };
  },
}));
vi.mock('@/components/livecourse/TeacherAvatarHost', async () => {
  const React = await import('react');
  return {
    TeacherAvatarHost: (props: {
      onTeacherChange: (teacher: TeacherSpeechPort | null) => void;
      onPlaybackInterrupt?: (nodeId: string) => Promise<void>;
      onPlaybackResume?: (nodeId: string) => Promise<void>;
    }) => {
      mocks.playbackHandlers = props;
      const { onTeacherChange } = props;
      React.useEffect(() => {
        onTeacherChange(mocks.teacher);
        return () => onTeacherChange(null);
      }, [onTeacherChange]);
      return null;
    },
  };
});
vi.mock('@/components/chat/chat-area', async () => {
  const React = await import('react');
  const ChatArea = React.forwardRef((_props, ref) => {
    React.useImperativeHandle(
      ref,
      () => ({
        startLecture: async (sceneId: string) => `lecture:${sceneId}`,
        endSession: vi.fn(async () => undefined),
        endActiveSession: vi.fn(async () => undefined),
        addLectureAction: vi.fn(),
        addLectureMessage: vi.fn(),
        getLectureMessageId: () => null,
        pauseBuffer: vi.fn(),
        resumeBuffer: vi.fn(),
        clearBuffer: vi.fn(),
        getActiveSessionType: () => 'lecture',
      }),
      [],
    );
    return null;
  });
  ChatArea.displayName = 'TestChatArea';
  return { ChatArea };
});
vi.mock('@/components/canvas/canvas-area', async () => {
  const React = await import('react');
  const { useStageStore: useStore } = await import('@/lib/store');
  const { QuizView } = await import('@/components/scene-renderers/quiz-view');
  return {
    CanvasArea: () => {
      const scene = useStore((state) => state.getCurrentScene());
      return scene?.content.type === 'quiz'
        ? React.createElement(QuizView, {
            questions: scene.content.questions,
            sceneId: scene.id,
            stageId: scene.stageId,
          })
        : React.createElement('main', null, scene?.title);
    },
  };
});

let root: Root;
let container: HTMLDivElement;
let session: LiveCourseSessionValue;
let store: BrowserRuntimeStore;
let plan: LessonPlan;
const scope = {
  stageId: 'stage-1',
  learnerId: 'learner-1',
  courseId: COURSE_ID,
  lessonId: LESSON_ONE,
};

function Probe() {
  const value = useLiveCourseSession();
  useEffect(() => {
    session = value;
  }, [value]);
  return null;
}
function ClassroomApp() {
  const [finalized, setFinalized] = useState(false);
  const onFinalized = useCallback(() => {
    mocks.finalized();
    setFinalized(true);
  }, []);
  if (finalized) return createElement(PostClassChoice, { onReplay: vi.fn() });
  const props = {
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    children: createElement(
      Fragment,
      null,
      createElement(Probe),
      createElement(PlaybackChromeRoot),
      createElement(ClassroomLifecycleOverlay, { onFinalized }),
    ),
  };
  return createElement(LiveCourseSessionProvider, props);
}

function ReplayApp() {
  const [ended, setEnded] = useState(false);
  const onEnd = useCallback(() => {
    mocks.finalized();
    setEnded(true);
  }, []);
  if (ended) return createElement('div', null, 'Replay ended');
  // eslint-disable-next-line react/no-children-prop -- Boundary children are a typed render prop.
  return createElement(ReplayPresentationBoundary, {
    children: ({ presentationStore, replayBridge }) =>
      createElement(
        Fragment,
        null,
        createElement(PlaybackChromeRoot, {
          presentationOnly: true,
          presentationStore,
          replayBridge,
        }),
        createElement(LiveCourseReplayHost, {
          courseId: COURSE_ID,
          lessonId: LESSON_ONE,
          presentationStore,
          replayBridge,
          onEnd,
          onAbort: onEnd,
        }),
      ),
  });
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  expect(predicate(), container.textContent ?? undefined).toBe(true);
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing button ${label}: ${container.textContent}`);
  await act(async () => {
    button.click();
  });
}
async function finishSpeech(index: number) {
  await until(() => mocks.speech.length > index);
  await act(async () => {
    mocks.speech[index].finish();
  });
}
async function mount(
  checkpointLast = false,
  introText = 'Introduction',
  replay: boolean | 'all' = false,
) {
  const previousSession = session;
  const coursePlan = makeAdjustmentCoursePlan();
  const nodes: LessonPlan['nodes'] = [
    {
      id: 'node:intro',
      sceneId: 'intro',
      title: 'Introduction',
      order: 0,
      type: 'instruction',
      goalIds: ['goal:one'],
    },
    {
      id: 'node:quiz',
      sceneId: 'quiz',
      title: 'Checkpoint',
      order: 1,
      type: 'checkpoint',
      goalIds: ['goal:one'],
    },
    ...(!checkpointLast
      ? [
          {
            id: 'node:outro',
            sceneId: 'outro',
            title: 'Conclusion',
            order: 2,
            type: 'instruction' as const,
            goalIds: ['goal:one'],
          },
        ]
      : []),
  ];
  coursePlan.lessons = [{ ...coursePlan.lessons[0], nodes }];
  coursePlan.checkpointRules = [
    { id: 'check', nodeId: 'node:quiz', goalIds: ['goal:one'], required: true },
  ];
  plan = lessonPlanSchema.parse({
    schemaVersion: 1,
    id: 'plan',
    stageId: scope.stageId,
    courseId: COURSE_ID,
    title: 'Complete lesson',
    version: 1,
    status: 'approved',
    createdAt: coursePlan.createdAt,
    goals: coursePlan.goals,
    nodes,
    presentation: { mode: 'html', visualStyle: 'Ink diagrams on warm paper.' },
  });
  const scenes: Scene[] = nodes.map((node) => ({
    id: node.sceneId,
    stageId: scope.stageId,
    title: node.title,
    order: node.order,
    ...(node.type === 'checkpoint'
      ? {
          type: 'quiz' as const,
          content: {
            type: 'quiz' as const,
            html: '<html><head></head><body>Checkpoint</body></html>',
            questions: [
              {
                id: 'q1',
                type: 'single' as const,
                question: 'One plus one?',
                options: [
                  { value: 'A', label: 'Two' },
                  { value: 'B', label: 'Three' },
                ],
                answer: ['A'],
                analysis: 'Adding one to one gives two.',
                points: 1,
              },
            ],
          },
        }
      : {
          type: 'interactive' as const,
          content: {
            type: 'interactive' as const,
            url: '',
            html: '<html><head></head><body>Lesson</body></html>',
          },
          actions: [
            {
              id: `speech:${node.id}`,
              type: 'speech' as const,
              text: node.order === 0 ? introText : node.title,
            },
          ],
        }),
  }));
  useStageStore.setState({
    stage: { id: scope.stageId, name: plan.title, createdAt: 0, updatedAt: 0 },
    lessonPlan: plan,
    coursePlan,
    scenes,
    currentSceneId: 'intro',
    generatingOutlines: [],
  });
  await createCourseStateRepository({ store, ...scope }).save(
    makeCourseSnapshotInput({
      coursePlan,
      evidence: [],
      adjustments: [],
      assistantTasks: { schemaVersion: 1, tasks: [], events: [] },
      teachingActions: { actions: [], currentNodeId: null, lastSequence: -1 },
    }),
  );
  if (replay) {
    await createCourseStateRepository({ store, ...scope }).saveProgress({
      idempotencyKey: 'replay-taught-intro',
      progress: {
        completedNodeIds: replay === 'all' ? ['node:intro', 'node:quiz'] : ['node:intro'],
        lastCompletedNodeId: replay === 'all' ? 'node:quiz' : 'node:intro',
        updatedAt: coursePlan.createdAt,
      },
    });
  }
  await act(async () => {
    root.render(createElement(replay ? ReplayApp : ClassroomApp));
  });
  if (replay) {
    await until(() => mocks.speech.length > 0);
    return;
  }
  await until(
    () =>
      session !== previousSession &&
      session?.status === 'ready' &&
      !!container.querySelector('[data-testid="classroom-session-bar"]'),
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      media,
      matches: false,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network request');
    }),
  );
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  store = new BrowserRuntimeStore({ dbName: `classroom-flow-${crypto.randomUUID()}` });
  mocks.store = store;
  mocks.speech.length = 0;
  mocks.finalized.mockClear();
  mocks.routerPush.mockClear();
  mocks.teacher = {
    connect: vi.fn(async () => undefined),
    ask: vi.fn(async () => undefined),
    speak: vi.fn(
      (text, options) =>
        new Promise<void>((resolve, reject) => {
          const signal = options?.signal;
          const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          const cleanup = () => signal?.removeEventListener('abort', abort);
          signal?.addEventListener('abort', abort, { once: true });
          mocks.speech.push({
            text,
            signal,
            finish: () => {
              cleanup();
              resolve();
            },
            fail: (cause) => {
              cleanup();
              reject(cause);
            },
          });
        }),
    ),
  };
  useSettingsStore.setState({ autoPlayLecture: false });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  useLiveCaptionStore.getState().clearCaption();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('whole classroom with controlled real-audio boundaries', () => {
  it('naturally ends a replay through its actionless checkpoint without synthesizing empty speech', async () => {
    await mount(true, 'Introduction', 'all');
    const repository = createCourseStateRepository({ store, ...scope });
    const baseline = await repository.loadVersioned();
    await finishSpeech(0);
    await until(() => mocks.finalized.mock.calls.length === 1);
    expect(mocks.speech).toHaveLength(1);
    expect(await repository.loadVersioned()).toEqual(baseline);
    expect(await listEvidenceRecords(scope.stageId, { store, ...scope })).toHaveLength(0);
    expect(
      (await store.listSessions(scope.stageId, scope.learnerId)).some((entry) =>
        entry.id.includes(':replay:'),
      ),
    ).toBe(false);
  }, 20_000);

  it('surfaces asynchronous replay speech failure and retries without writing C or evidence', async () => {
    await mount(true, 'Introduction', true);
    const repository = createCourseStateRepository({ store, ...scope });
    const baseline = await repository.loadVersioned();
    await act(async () => mocks.speech[0].fail(new Error('Replay voice unavailable')));
    await until(() => !!container.textContent?.includes('livecourse.replayFailed'));
    expect(container.textContent).not.toContain('livecourse.pause');
    expect(await repository.loadVersioned()).toEqual(baseline);
    await click('livecourse.retry');
    await until(() => mocks.speech.length === 2);
    await finishSpeech(1);
    await until(() => mocks.finalized.mock.calls.length === 1);
    expect(await repository.loadVersioned()).toEqual(baseline);
    expect(await listEvidenceRecords(scope.stageId, { store, ...scope })).toHaveLength(0);
    expect(
      (await store.listSessions(scope.stageId, scope.learnerId)).some((entry) =>
        entry.id.includes(':replay:'),
      ),
    ).toBe(false);
  }, 20_000);

  it('pauses and resumes actual replay audio without advancing C', async () => {
    await mount(true, 'Introduction', true);
    const repository = createCourseStateRepository({ store, ...scope });
    const baseline = await repository.loadVersioned();
    await click('livecourse.pause');
    expect(mocks.speech[0].signal?.aborted).toBe(true);
    await until(() => !!container.textContent?.includes('livecourse.resume'));
    await click('livecourse.resume');
    await until(() => mocks.speech.length === 2);
    expect(mocks.speech[1].text).toBe('Introduction');
    await finishSpeech(1);
    await until(() => mocks.finalized.mock.calls.length === 1);
    expect(await repository.loadVersioned()).toEqual(baseline);
    expect(await listEvidenceRecords(scope.stageId, { store, ...scope })).toHaveLength(0);
  }, 20_000);

  it('bounds long Chinese narration and waits for every audio chunk before advancing', async () => {
    const script = '这是课堂中的重要概念。'.repeat(60);
    await mount(false, script);
    await click('livecourse.startTeaching');
    let spoken = '';
    let index = 0;
    while (spoken.length < script.length) {
      await until(() => mocks.speech.length > index);
      const chunk = mocks.speech[index].text;
      expect(chunk.length).toBeLessThanOrEqual(200);
      expect(session.completedNodeIds).toEqual([]);
      spoken += chunk;
      await finishSpeech(index++);
    }
    expect(spoken).toBe(script);
    await until(() => session.completedNodeIds.includes('node:intro'));
  }, 20_000);
  it('runs lecture, an actionless quiz, spoken correction, next lecture and archival', async () => {
    await mount();
    await click('livecourse.startTeaching');
    await until(() => mocks.speech.length === 1);
    expect(session.completedNodeIds).toEqual([]);
    expect(useLiveCaptionStore.getState().caption).toEqual(
      expect.objectContaining({ speaker: 'teacher', text: 'Introduction' }),
    );
    await finishSpeech(0);
    await until(() => mocks.speech.length === 2);
    expect(session.completedNodeIds).toEqual(['node:intro']);
    expect(session.currentNodeId).toBe('node:quiz');
    expect(mocks.speech[1].text).toBe('livecourse.checkpointInstruction');
    await finishSpeech(1);
    await click('quiz.startQuiz');
    await until(() => session.classroomState === 'checking');
    await until(() => !!container.textContent?.includes('One plus one?'));
    await click('BThree');
    await click('quiz.submitAnswers');
    await until(() => mocks.speech.length === 3);
    expect(mocks.speech[2].text).toContain('Adding one to one gives two.');
    expect(await listEvidenceRecords(scope.stageId, { store, ...scope })).toHaveLength(0);
    await finishSpeech(2);
    await until(() => mocks.speech.length === 4);
    expect(session.currentNodeId).toBe('node:outro');
    expect(session.classroomState).toBe('teaching');
    expect(await listEvidenceRecords(scope.stageId, { store, ...scope })).toHaveLength(1);
    await finishSpeech(3);
    await until(() => mocks.finalized.mock.calls.length === 1);
    expect(document.body.textContent).toContain('livecourse.postClassTitle');
    const saved = await createCourseStateRepository({ store, ...scope }).load();
    expect(saved?.lifecycle?.status).toBe('archived');
  }, 20_000);

  it('never advances silent or failed narration and retries the retained node', async () => {
    await mount();
    await click('livecourse.startTeaching');
    await until(() => mocks.speech.length === 1);
    await until(() => session.currentNodeId === 'node:intro');
    await act(async () => {
      mocks.speech[0].fail(new Error('Audio transport failed'));
    });
    await until(() => !!container.textContent?.includes('Audio transport failed'));
    expect(session.currentNodeId).toBe('node:intro');
    expect(session.completedNodeIds).toEqual([]);
    expect(await listEvidenceRecords(scope.stageId, { store, ...scope })).toHaveLength(0);
    await click('livecourse.retryCurrentNode');
    await until(() => mocks.speech.length === 2);
    expect(mocks.speech[1].text).toBe('Introduction');
    await finishSpeech(1);
    await until(() => session.completedNodeIds.includes('node:intro'));
  }, 20_000);

  it('restarts the unfinished sentence after an interruption without crediting cancelled audio', async () => {
    await mount();
    await click('livecourse.startTeaching');
    await until(() => mocks.speech.length === 1);
    await act(async () => {
      await mocks.playbackHandlers.onPlaybackInterrupt?.('node:intro');
      await session.emitAction({ type: 'lesson.interrupt', nodeId: 'node:intro', payload: {} });
    });
    expect(mocks.speech[0].signal?.aborted).toBe(true);
    expect(session.completedNodeIds).toEqual([]);
    await act(async () => {
      await session.emitAction({
        type: 'lesson.resume_interrupted',
        nodeId: 'node:intro',
        payload: { targetNodeId: 'node:intro' },
      });
      await mocks.playbackHandlers.onPlaybackResume?.('node:intro');
    });
    await until(() => mocks.speech.length === 2);
    expect(mocks.speech[1].text).toBe(mocks.speech[0].text);
    await finishSpeech(1);
    await until(() => session.completedNodeIds.includes('node:intro'));
    expect(await listEvidenceRecords(scope.stageId, { store, ...scope })).toHaveLength(0);
  }, 20_000);

  it('relistens with audio and returns to the same waiting checkpoint without new evidence', async () => {
    await mount();
    await click('livecourse.startTeaching');
    await finishSpeech(0);
    await finishSpeech(1);
    await click('quiz.startQuiz');
    await until(() => session.classroomState === 'checking');
    await click('livecourse.relistenOpen');
    await click('Introduction');
    await until(() => session.classroomState === 'replaying' && mocks.speech.length === 3);
    expect(mocks.speech[2].text).toBe('Introduction');
    await finishSpeech(2);
    await until(
      () => session.classroomState === 'checking' && session.currentNodeId === 'node:quiz',
    );
    expect(session.completedNodeIds).toEqual(['node:intro']);
    expect(await listEvidenceRecords(scope.stageId, { store, ...scope })).toHaveLength(0);
    await act(async () => {
      await mocks.playbackHandlers.onPlaybackInterrupt?.('node:quiz');
    });
  }, 20_000);

  it('waits for final spoken feedback, retries its failure, and preserves model-grade uncertainty', async () => {
    await mount(true);
    await click('livecourse.startTeaching');
    await finishSpeech(0);
    await finishSpeech(1);
    await act(async () => {
      await session.openCheckpoint({ sceneId: 'quiz', attemptId: 'model-attempt' });
    });
    const input = {
      sceneId: 'quiz',
      attemptId: 'model-attempt',
      score: 0.8,
      hasModelGradedItems: true,
      modelId: 'quiz-grader',
      inputSummary: 'A successfully assessed short answer',
      metadata: { results: [{ questionId: 'q1', correct: true, earned: 0.8 }] },
    };
    let submission!: ReturnType<LiveCourseSessionValue['recordQuizEvidence']>;
    await act(async () => {
      submission = session.recordQuizEvidence(input);
      void submission.catch(() => undefined);
    });
    await until(() => mocks.speech.length === 3);
    expect(session.classroomState).toBe('checking');
    expect(await listEvidenceRecords(scope.stageId, { store, ...scope })).toHaveLength(0);
    await act(async () => {
      mocks.speech[2].fail(new Error('Feedback audio failed'));
      await expect(submission).rejects.toThrow('Feedback audio failed');
    });
    expect(session.classroomState).toBe('checking');
    await act(async () => {
      submission = session.recordQuizEvidence(input);
      void submission.catch(() => undefined);
    });
    await until(() => mocks.speech.length === 4);
    expect(mocks.speech[3].text).toContain('provisional');
    expect(session.classroomState).toBe('checking');
    await finishSpeech(3);
    await act(async () => {
      await submission;
    });
    await until(() => mocks.finalized.mock.calls.length === 1);
    const evidence = await listEvidenceRecords(scope.stageId, { store, ...scope });
    expect(evidence).toHaveLength(1);
    expect(evidence[0].status).toBe('pending_review');
    expect(evidence[0].evaluation?.method).toBe('model');
    const saved = await createCourseStateRepository({ store, ...scope }).load();
    expect(saved?.lifecycle?.status).toBe('archived');
  }, 20_000);

  it('continues a saved reviewed quiz in fresh W without regrading or duplicate evidence', async () => {
    await mount(true);
    await click('livecourse.startTeaching');
    await finishSpeech(0);
    await finishSpeech(1);
    await click('quiz.startQuiz');
    await until(() => !!container.textContent?.includes('One plus one?'));
    await click('ATwo');
    await click('quiz.submitAnswers');
    await until(() => mocks.speech.length === 3);
    await click('livecourse.pause');
    await until(() => session.classroomState === 'paused');
    expect(await listEvidenceRecords(scope.stageId, { store, ...scope })).toHaveLength(0);
    await click('livecourse.leaveClassroom');
    await until(() => mocks.routerPush.mock.calls.length === 1);
    const oldSession = session;
    await act(async () => {
      root.unmount();
    });

    root = createRoot(container);
    await act(async () => {
      root.render(createElement(ClassroomApp));
    });
    await until(() => session !== oldSession && session.status === 'ready');
    await until(() => mocks.speech.length === 4);
    expect(session.classroomState).toBe('checking');
    expect(await listEvidenceRecords(scope.stageId, { store, ...scope })).toHaveLength(0);
    await finishSpeech(3);
    await until(() => mocks.finalized.mock.calls.length === 1);
    expect(await listEvidenceRecords(scope.stageId, { store, ...scope })).toHaveLength(1);
    const saved = await createCourseStateRepository({ store, ...scope }).load();
    expect(saved?.lifecycle?.status).toBe('archived');
  }, 20_000);
});

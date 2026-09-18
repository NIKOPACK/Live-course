// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizQuestion, Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  open: vi.fn(),
  evidence: vi.fn(),
  draft: vi.fn(),
  fetch: vi.fn(),
  writer: {
    scheduleDraft: vi.fn(),
    flushDraft: vi.fn(async () => undefined),
    recordPhase: vi.fn(async (_input: { phase: string }) => undefined),
    cancelDraft: vi.fn(),
  },
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
vi.mock('@/lib/livecourse/session/context', () => ({
  useLiveCourseSessionOptional: () => ({
    openCheckpoint: mocks.open,
    recordQuizEvidence: mocks.evidence,
  }),
}));
vi.mock('@/lib/quiz/runtime', () => ({
  loadQuizAttemptState: mocks.load,
  createQuizAttemptWriter: () => mocks.writer,
  QuizRetryProgressedError: class QuizRetryProgressedError extends Error {},
}));
vi.mock('@/lib/quiz/persistence', () => ({ writeDraftRecovery: mocks.draft }));
vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: () => ({ modelString: 'test:model', apiKey: 'test-key' }),
}));
vi.mock('@/lib/livecourse/html/use-resolved-html', () => ({
  useResolvedHtml: (html: string) => html,
}));
vi.mock('@/components/audio/speech-button', () => ({ SpeechButton: () => null }));
vi.mock('@/components/slide-renderer/SlideThumbnail', () => ({ SlideThumbnail: () => null }));
vi.mock('@/components/slide-renderer/Editor', () => ({ SlideEditor: () => null }));
vi.mock('@/components/scene-renderers/pbl-renderer', () => ({ PBLRenderer: () => null }));
vi.mock('@/components/scene-renderers/interactive-renderer', () => ({
  InteractiveRenderer: () => null,
}));

import { QuizView } from '@/components/scene-renderers/quiz-view';
import { HtmlQuizSurface } from '@/components/scene-renderers/html-quiz-surface';
import { SegmentClassroomPreview } from '@/app/generation-preview/components/segment-classroom-preview';
import { SceneThumbnailContent } from '@/components/stage/scene-thumbnail-content';
import { SceneRenderer } from '@/components/stage/scene-renderer';
import { useLiveCaptionStore } from '@/lib/store/live-caption';

const html =
  '<!doctype html><html><head></head><body><h1>Real model layout</h1><input></body></html>';
const questions: QuizQuestion[] = [
  {
    id: 'q1',
    type: 'single',
    question: 'Choose',
    options: [{ value: 'A', label: 'Alpha' }],
    answer: ['A'],
  },
];
let root: Root;
let container: HTMLDivElement;

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}
function quiz(presentationOnly = false) {
  return createElement(QuizView, {
    html,
    questions,
    sceneId: 'quiz-1',
    stageId: 'stage-1',
    presentationOnly,
  });
}
function iframe() {
  return container.querySelector('iframe')!;
}
function button(label: string) {
  const result = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === label,
  );
  if (!result) throw new Error(`Button not found: ${label}`);
  return result;
}
async function post(data: unknown, source: Window | null = iframe().contentWindow) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source, data }));
  });
}
async function answer(value: unknown = ['A']) {
  await post({ __livecourseQuiz: true, kind: 'answer', questionId: 'q1', answer: value });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.load.mockResolvedValue({ attemptId: 'attempt-1', state: undefined });
  mocks.open.mockResolvedValue(undefined);
  mocks.evidence.mockResolvedValue(undefined);
  mocks.fetch.mockReset();
  vi.stubGlobal('fetch', mocks.fetch);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useLiveCaptionStore.getState().clearCaption();
  vi.unstubAllGlobals();
});

describe('HTML assessment lifecycle', () => {
  it('retains host-controlled start/submit and rejects source spoofing and unsolicited completion', async () => {
    await render(quiz());
    expect(iframe().srcdoc).toContain('Real model layout');
    expect(iframe().sandbox?.toString() ?? iframe().getAttribute('sandbox')).toBe('allow-scripts');
    await answer();
    expect(mocks.draft).not.toHaveBeenCalled();
    await act(async () => button('quiz.startQuiz').click());
    expect(mocks.open).toHaveBeenCalledWith({ sceneId: 'quiz-1', attemptId: 'attempt-1' });
    await post({ __livecourseQuiz: true, kind: 'answer', questionId: 'q1', answer: ['A'] }, window);
    await answer('A');
    await post({ __livecourseQuiz: true, kind: 'complete', score: 1 });
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(mocks.evidence).not.toHaveBeenCalled();
    await answer();
    expect(mocks.draft).toHaveBeenCalledWith('quiz-1', 'attempt-1', { q1: 'A' });
    expect(mocks.writer.recordPhase).not.toHaveBeenCalled();
    await act(async () => button('quiz.submitAnswers').click());
    expect(
      mocks.writer.recordPhase.mock.calls.map(([input]) => (input as { phase: string }).phase),
    ).toEqual(['submitted', 'reviewed']);
    expect(mocks.evidence).toHaveBeenCalledTimes(1);
    const draftCalls = mocks.draft.mock.calls.length;
    await answer([]);
    expect(mocks.draft).toHaveBeenCalledTimes(draftCalls);
  });

  it('keeps host start/submit outside the caption overlay so a held intro remains clickable', async () => {
    useLiveCaptionStore.getState().setCaption({
      speaker: 'teacher',
      text: 'Read the checkpoint before you start.',
    });
    useLiveCaptionStore.getState().holdCaption();
    await render(
      createElement(QuizView, {
        html,
        questions,
        sceneId: 'quiz-1',
        stageId: 'stage-1',
        showCaptions: true,
      }),
    );
    const captions = container.querySelector('[data-testid=classroom-captions]');
    const page = container.querySelector('[data-classroom-page-surface]');
    const chrome = container.querySelector('[data-quiz-host-chrome]');
    expect(captions?.textContent).toContain('Read the checkpoint before you start.');
    expect(page?.contains(captions)).toBe(true);
    expect(chrome?.contains(captions)).toBe(false);
    await act(async () => button('quiz.startQuiz').click());
    expect(mocks.open).toHaveBeenCalledWith({ sceneId: 'quiz-1', attemptId: 'attempt-1' });
    await answer();
    await act(async () => button('quiz.submitAnswers').click());
    expect(mocks.evidence).toHaveBeenCalledTimes(1);
  });

  it('hydrates values, synchronizes after load/ready, and preserves drafts on page retry', async () => {
    mocks.load.mockResolvedValue({
      attemptId: 'attempt-1',
      state: { phase: 'draft', answers: { q1: 'A' } },
    });
    await render(quiz());
    const firstFrame = iframe();
    const send = vi.spyOn(firstFrame.contentWindow!, 'postMessage');
    await act(async () => firstFrame.dispatchEvent(new Event('load')));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'state',
        state: expect.objectContaining({ phase: 'answering', answers: { q1: ['A'] } }),
      }),
      '*',
    );
    send.mockClear();
    await post({ __livecourseQuiz: true, kind: 'ready' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'state' }), '*');
    await post(
      { __livecourseInteractive: true, kind: 'runtime-error', message: 'Model script failed' },
      window,
    );
    expect(container.querySelector('[role=alert]')).toBeNull();
    await post({
      __livecourseInteractive: true,
      kind: 'runtime-error',
      message: 'Model script failed',
    });
    expect(container.querySelector('[role=alert]')?.textContent).toContain(
      'htmlClassroom.quizRuntimeFailed',
    );
    await act(async () => button('htmlClassroom.retryPage').click());
    expect(iframe()).not.toBe(firstFrame);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    const replay = vi.spyOn(iframe().contentWindow!, 'postMessage');
    await act(async () => iframe().dispatchEvent(new Event('load')));
    expect(replay).toHaveBeenCalledWith(
      expect.objectContaining({ state: expect.objectContaining({ answers: { q1: ['A'] } }) }),
      '*',
    );
    expect(mocks.writer.recordPhase).not.toHaveBeenCalled();
  });

  it('keeps failed checkpoint opening recoverable without accepting drafts', async () => {
    mocks.open.mockRejectedValueOnce(new Error('Cannot save checkpoint'));
    await render(quiz());
    await act(async () => button('quiz.startQuiz').click());
    expect(container.querySelector('[role=alert]')?.textContent).toContain(
      'Cannot save checkpoint',
    );
    await answer();
    expect(mocks.draft).not.toHaveBeenCalled();
    await act(async () => button('quiz.startQuiz').click());
    await answer();
    expect(mocks.draft).toHaveBeenCalledOnce();
  });

  it('keeps grading failure unscored and retries the same submission only from trusted controls', async () => {
    mocks.load.mockResolvedValue({
      attemptId: 'attempt-1',
      state: { phase: 'draft', answers: { q1: 'My explanation' } },
    });
    mocks.fetch.mockRejectedValueOnce(new Error('Grading offline')).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, score: 1, comment: 'Good explanation' }), {
        status: 200,
      }),
    );
    await render(
      createElement(QuizView, {
        html,
        sceneId: 'quiz-1',
        stageId: 'stage-1',
        questions: [{ id: 'q1', type: 'short_answer', question: 'Explain', points: 1 }],
      }),
    );
    await act(async () => button('quiz.submitAnswers').click());
    expect(container.querySelector('[role=alert]')?.textContent).toContain('not been scored');
    expect(mocks.evidence).not.toHaveBeenCalled();
    await answer('Changed after submission');
    expect(mocks.draft).not.toHaveBeenCalled();
    await act(async () => button('quiz.retry').click());
    expect(mocks.evidence).toHaveBeenCalledTimes(1);
    expect(mocks.writer.recordPhase.mock.calls.map(([input]) => input.phase)).toEqual([
      'submitted',
      'submitted',
      'reviewed',
    ]);
    expect(mocks.writer.recordPhase).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attemptId: 'attempt-1',
        answers: { q1: 'My explanation' },
      }),
    );
  });

  it('shows the native alternative without discarding the hydrated answers', async () => {
    mocks.load.mockResolvedValue({
      attemptId: 'attempt-1',
      state: { phase: 'draft', answers: { q1: 'A' } },
    });
    await render(quiz());
    expect(container.textContent).not.toContain('htmlClassroom.basicQuestionView');
    await post({ __livecourseInteractive: true, kind: 'runtime-error', message: 'Broken page' });
    await act(async () => button('htmlClassroom.basicQuestionView').click());
    expect(iframe()).toBeNull();
    expect(button('quiz.submitAnswers').disabled).toBe(false);
    expect(container.textContent).toContain('Alpha');
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.writer.recordPhase).not.toHaveBeenCalled();
  });

  it('keeps pending teacher feedback and failed evidence sync recoverable without regrading', async () => {
    let rejectFeedback!: (error: Error) => void;
    mocks.evidence.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectFeedback = reject;
      }),
    );
    mocks.load.mockResolvedValue({
      attemptId: 'attempt-1',
      state: {
        phase: 'reviewed',
        answers: { q1: 'A' },
        results: [{ questionId: 'q1', correct: true, status: 'correct', earned: 1 }],
      },
    });
    await render(quiz());
    expect(container.textContent).toContain('livecourse.checkpointFeedback');
    expect(button('quiz.retry').disabled).toBe(true);
    const sent = vi.spyOn(iframe().contentWindow!, 'postMessage');
    await act(async () => iframe().dispatchEvent(new Event('load')));
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          phase: 'reviewing',
          readOnly: true,
          results: [expect.objectContaining({ answer: ['A'], earned: 1 })],
        }),
      }),
      '*',
    );
    await act(async () => rejectFeedback(new Error('Feedback unavailable')));
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Feedback unavailable');
    const retry = container.querySelector('[role=alert] button') as HTMLButtonElement;
    await act(async () => retry.click());
    expect(mocks.evidence).toHaveBeenCalledTimes(2);
    expect(mocks.writer.recordPhase).not.toHaveBeenCalled();
    expect(container.querySelector('[role=alert]')).toBeNull();
  });

  it('lets learners scroll the checkpoint HTML before starting', async () => {
    await render(quiz());
    expect(button('quiz.startQuiz')).toBeTruthy();
    expect(iframe().style.pointerEvents).not.toBe('none');
    expect(iframe().parentElement?.hasAttribute('inert')).toBe(false);
    expect(iframe().hasAttribute('inert')).toBe(false);
  });

  it('renders replay HTML without hydrating, grading, or writing attempts/evidence', async () => {
    await render(quiz(true));
    expect(iframe().srcdoc).toContain('Real model layout');
    await answer();
    await post({ __livecourseQuiz: true, kind: 'complete', score: 1 });
    expect(container.querySelector('button')).toBeNull();
    expect(iframe().style.pointerEvents).not.toBe('none');
    expect(iframe().parentElement?.hasAttribute('inert')).toBe(false);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(mocks.writer.recordPhase).not.toHaveBeenCalled();
    expect(mocks.evidence).not.toHaveBeenCalled();
  });

  it('keeps every structured question and graded feedback accessible outside the inert HTML document', async () => {
    const allQuestions: QuizQuestion[] = [
      { ...questions[0], analysis: 'Alpha is the matching option.' },
      { id: 'q2', type: 'short_answer', question: 'Explain the relationship.', points: 3 },
    ];
    const results = [
      { questionId: 'q1', correct: true, status: 'correct' as const, earned: 1 },
      {
        questionId: 'q2',
        correct: false,
        status: 'incorrect' as const,
        earned: 1,
        aiComment: 'Add the missing causal step.',
      },
    ];
    await render(
      createElement(HtmlQuizSurface, {
        html,
        questions: allQuestions,
        state: {
          phase: 'reviewing',
          answers: { q1: ['A'], q2: 'My causal explanation' },
          results,
          readOnly: true,
        },
      }),
    );
    const accessible = container.querySelector('[data-html-quiz-accessible-content]')!;
    expect(accessible.closest('[inert]')).toBeNull();
    expect(accessible.querySelectorAll(':scope > ol > li')).toHaveLength(2);
    expect(accessible.textContent).toContain('Choose');
    expect(accessible.textContent).toContain('Explain the relationship.');
    expect(accessible.textContent).toContain('My causal explanation');
    expect(accessible.textContent).toContain('Alpha is the matching option.');
    expect(accessible.textContent).toContain('Add the missing causal step.');
    expect(accessible.textContent).toContain('quiz.incorrect');
    expect(accessible.textContent).toContain('1 / 3');
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.evidence).not.toHaveBeenCalled();

    await render(createElement(HtmlQuizSurface, { html, questions: allQuestions }));
    expect(
      container.querySelector('[data-html-quiz-accessible-content]')?.textContent,
    ).not.toContain('Alpha is the matching option.');
    expect(
      container.querySelector('[data-html-quiz-accessible-content]')?.textContent,
    ).not.toContain('Add the missing causal step.');
  });
});

describe('HTML preview surfaces', () => {
  it('propagates saved quiz HTML through the scene dispatcher', async () => {
    const scene = {
      id: 'quiz-1',
      stageId: 'stage-1',
      title: 'Model quiz',
      order: 0,
      type: 'quiz',
      content: { type: 'quiz', html, questions },
    } as Scene;
    await render(createElement(SceneRenderer, { scene, mode: 'playback', presentationOnly: true }));
    expect(iframe().srcdoc).toContain('Real model layout');
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it.each(['interactive', 'quiz'] as const)(
    'renders the real %s page in generation previews and thumbnails, without attempts',
    async (type) => {
      const content = type === 'quiz' ? { type, questions, html } : { type, url: '', html };
      const scene = {
        id: 'scene',
        stageId: 'stage',
        title: 'Model page',
        order: 1,
        type,
        content,
      } as Scene;
      await render(createElement(SegmentClassroomPreview, { scene }));
      expect(iframe().srcdoc).toContain('Real model layout');
      expect(iframe().title).toBe('Model page');
      await answer();
      await render(
        createElement(SceneThumbnailContent, { scene, viewportSize: 1000, viewportRatio: 0.5625 }),
      );
      expect(iframe().srcdoc).toContain('Real model layout');
      expect(iframe().getAttribute('sandbox')).toBe('allow-scripts');
      await render(
        createElement(SceneThumbnailContent, {
          scene,
          viewportSize: 1000,
          viewportRatio: 0.5625,
          visible: false,
        }),
      );
      expect(iframe()).toBeNull();
      expect(mocks.load).not.toHaveBeenCalled();
      expect(mocks.draft).not.toHaveBeenCalled();
      expect(mocks.evidence).not.toHaveBeenCalled();
    },
  );

  it('rejects answers on a read-only surface even if a callback is accidentally supplied', async () => {
    const callback = vi.fn();
    await render(createElement(HtmlQuizSurface, { html, questions, onAnswer: callback }));
    await answer();
    expect(callback).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openCheckpoint: vi.fn(),
  recordQuizEvidence: vi.fn(),
  loadQuizAttemptState: vi.fn(),
  writer: {
    scheduleDraft: vi.fn(),
    flushDraft: vi.fn(async () => undefined),
    recordPhase: vi.fn(async () => undefined),
    cancelDraft: vi.fn(),
  },
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    locale: 'en-US',
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/livecourse/session/context', () => ({
  useLiveCourseSessionOptional: () => ({
    openCheckpoint: mocks.openCheckpoint,
    recordQuizEvidence: mocks.recordQuizEvidence,
  }),
}));

vi.mock('@/lib/quiz/runtime', () => ({
  createQuizAttemptWriter: () => mocks.writer,
  loadQuizAttemptState: mocks.loadQuizAttemptState,
  QuizRetryProgressedError: class QuizRetryProgressedError extends Error {},
}));

vi.mock('@/lib/quiz/persistence', () => ({
  writeDraftRecovery: vi.fn(),
  clearDraftRecovery: vi.fn(),
}));

vi.mock('@/components/audio/speech-button', () => ({
  SpeechButton: () => createElement('button', { type: 'button' }),
}));

vi.mock('motion/react', async () => {
  const React = await import('react');
  const passthrough = (tag: string) => {
    const Component = ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement(tag, props, children);
    Component.displayName = `Motion${tag}`;
    return Component;
  };
  return {
    AnimatePresence: passthrough('div'),
    motion: new Proxy(
      {},
      {
        get: (_target, property) => passthrough(String(property)),
      },
    ),
  };
});

vi.mock('lucide-react', async () => {
  const React = await import('react');
  const Icon = (props: Record<string, unknown>) => React.createElement('svg', props);
  return {
    PieChart: Icon,
    CheckCircle2: Icon,
    XCircle: Icon,
    RotateCcw: Icon,
    ChevronRight: Icon,
    Check: Icon,
    BookOpenText: Icon,
    Loader2: Icon,
    Sparkles: Icon,
  };
});

import { QuizView } from '@/components/scene-renderers/quiz-view';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const question = {
  id: 'q1',
  type: 'single' as const,
  question: 'Choose one',
  options: [{ value: 'A', label: 'A' }],
  answer: ['A'],
  points: 1,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderQuiz(quizQuestion = question): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(QuizView, {
        questions: [quizQuestion],
        sceneId: 'scene:quiz-1',
        stageId: 'stage-1',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const candidate = [...(container?.querySelectorAll('button') ?? [])].find(
    (item) => item.textContent === label,
  );
  if (!(candidate instanceof HTMLButtonElement)) throw new Error(`Missing button ${label}`);
  return candidate;
}

describe('quiz checkpoint lifecycle', () => {
  beforeEach(() => {
    mocks.openCheckpoint.mockReset().mockResolvedValue(undefined);
    mocks.recordQuizEvidence.mockReset();
    mocks.loadQuizAttemptState.mockReset().mockResolvedValue({
      attemptId: 'attempt-1',
      state: undefined,
    });
    Object.values(mocks.writer).forEach((mock) => mock.mockClear());
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it('opens the durable checkpoint before entering the answering phase', async () => {
    await renderQuiz();

    await act(async () => {
      button('quiz.startQuiz').click();
      await Promise.resolve();
    });

    expect(mocks.openCheckpoint).toHaveBeenCalledExactlyOnceWith({
      sceneId: 'scene:quiz-1',
      attemptId: 'attempt-1',
    });
    expect(container?.textContent).toContain('quiz.answering');
  });

  it('keeps the cover visible and exposes the error when checkpoint opening fails', async () => {
    mocks.openCheckpoint.mockRejectedValueOnce(new Error('checkpoint store unavailable'));
    await renderQuiz();

    await act(async () => {
      button('quiz.startQuiz').click();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('checkpoint store unavailable');
    expect(container?.textContent).not.toContain('quiz.answering');
  });

  it('surfaces an invalid local answer key without persisting a review or evidence', async () => {
    mocks.loadQuizAttemptState.mockResolvedValueOnce({
      attemptId: 'attempt-1',
      state: { phase: 'draft', answers: { q1: 'A' } },
    });
    await renderQuiz({ ...question, answer: ['unknown'] });
    await act(async () => {
      button('quiz.submitAnswers').click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(container?.textContent).toContain('This attempt has not been scored');
    expect(button('quiz.retry')).toBeDefined();
    expect(mocks.writer.recordPhase).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ phase: 'submitted' }),
    );
    expect(mocks.recordQuizEvidence).not.toHaveBeenCalled();
  });
});

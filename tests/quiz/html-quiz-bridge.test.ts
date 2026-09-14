import { describe, expect, it, vi } from 'vitest';
import type { QuizQuestion } from '@/lib/types/stage';
import {
  htmlQuizAnswers,
  parseHtmlQuizAnswer,
  patchQuizHtml,
} from '@/lib/livecourse/html/quiz-bridge';

const questions: QuizQuestion[] = [
  { id: 'single', type: 'single', question: '?', options: [{ value: 'A', label: 'Alpha' }] },
  {
    id: 'multiple',
    type: 'multiple',
    question: '?',
    options: [
      { value: 'A', label: 'Alpha' },
      { value: 'B', label: 'Beta' },
    ],
  },
  { id: 'text', type: 'short_answer', question: '?' },
];
const frame = {} as Window;
const message = (questionId: string, answer: unknown) => ({
  source: frame,
  data: { __livecourseQuiz: true, kind: 'answer', questionId, answer },
});

describe('HTML quiz answer boundary', () => {
  it('accepts only the current frame and an enabled answer phase', () => {
    const event = message('single', ['A']);
    expect(parseHtmlQuizAnswer(event, frame, questions, true)).toEqual({
      questionId: 'single',
      answer: 'A',
    });
    expect(parseHtmlQuizAnswer(event, {} as Window, questions, true)).toBeNull();
    expect(parseHtmlQuizAnswer(event, null, questions, true)).toBeNull();
    expect(parseHtmlQuizAnswer(event, frame, questions, false)).toBeNull();
  });

  it.each([
    ['unknown', ['A']],
    ['__proto__', ['A']],
    ['single', 'A'],
    ['single', ['A', 'B']],
    ['single', [5]],
    ['single', new Array(1)],
    ['multiple', ['A', 'A']],
    ['multiple', ['unknown']],
    ['multiple', null],
    ['multiple', { A: true }],
    ['text', ['A']],
    ['text', 7],
  ])('rejects malformed or unknown answer %s / %j', (id, answer) => {
    expect(parseHtmlQuizAnswer(message(id, answer), frame, questions, true)).toBeNull();
  });

  it('accepts clearing selections, multiple selections and short text', () => {
    expect(parseHtmlQuizAnswer(message('single', []), frame, questions, true)?.answer).toBe('');
    expect(
      parseHtmlQuizAnswer(message('multiple', ['B', 'A']), frame, questions, true)?.answer,
    ).toEqual(['B', 'A']);
    expect(parseHtmlQuizAnswer(message('text', 'Explain'), frame, questions, true)?.answer).toBe(
      'Explain',
    );
  });

  it.each(['submit', 'complete', 'grade', 'rpc'])('does not accept %s messages', (kind) => {
    expect(
      parseHtmlQuizAnswer(
        { source: frame, data: { ...message('single', ['A']).data, kind, score: 1 } },
        frame,
        questions,
        true,
      ),
    ).toBeNull();
  });

  it('restores legacy single-choice drafts as arrays without unknown keys', () => {
    expect(
      htmlQuizAnswers(questions, { single: 'A', multiple: ['B'], text: 'Answer', unknown: 'x' }),
    ).toEqual({
      single: ['A'],
      multiple: ['B'],
      text: 'Answer',
    });
  });

  it('installs the script before model scripts and replays state at DOM readiness', () => {
    const html = patchQuizHtml(
      '<html><HEAD><script>modelCode()</script></HEAD><body></body></html>',
    );
    expect(html.indexOf('data-livecourse-quiz-bridge')).toBeLessThan(html.indexOf('modelCode'));
    expect(html).toContain('data-iframe-error-shim');
    const script = html.match(/<script data-livecourse-quiz-bridge>([\s\S]*?)<\/script>/)![1];
    const listeners: Record<string, (event?: unknown) => void> = {};
    const dispatchEvent = vi.fn();
    const postMessage = vi.fn();
    const parent = { postMessage };
    const win = {
      parent,
      addEventListener: (type: string, listener: () => void) => {
        listeners[type] = listener;
      },
      dispatchEvent,
      livecourseQuiz: { setAnswer: (_id: string, _answer: unknown) => {} },
    };
    const doc = {
      body: { inert: false },
      addEventListener: (type: string, listener: () => void) => {
        listeners[type] = listener;
      },
    };
    class Event {
      constructor(
        public type: string,
        public options: unknown,
      ) {}
    }
    new Function('window', 'document', 'CustomEvent', script)(win, doc, Event);
    win.livecourseQuiz.setAnswer('single', ['A']);
    expect(postMessage).not.toHaveBeenCalled();
    const state = { phase: 'answering', answers: { single: ['A'] }, results: [], readOnly: false };
    listeners.message({ source: {}, data: { __livecourseQuiz: true, kind: 'state', state } });
    expect(dispatchEvent).not.toHaveBeenCalled();
    listeners.message({ source: parent, data: { __livecourseQuiz: true, kind: 'state', state } });
    listeners.DOMContentLoaded();
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    expect(doc.body.inert).toBe(false);
    win.livecourseQuiz.setAnswer('single', ['A']);
    expect(postMessage).toHaveBeenLastCalledWith(message('single', ['A']).data, '*');
    listeners.message({
      source: parent,
      data: { __livecourseQuiz: true, kind: 'state', state: { ...state, readOnly: true } },
    });
    expect(doc.body.inert).toBe(true);
    postMessage.mockClear();
    win.livecourseQuiz.setAnswer('single', []);
    expect(postMessage).not.toHaveBeenCalled();
  });
});

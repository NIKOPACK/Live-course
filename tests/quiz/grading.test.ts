import { describe, it, expect } from 'vitest';
import { gradeChoiceQuestions, isShortAnswer } from '@/lib/quiz/grading';
import type { QuizQuestion } from '@/lib/types/stage';

function q(overrides: Partial<QuizQuestion>): QuizQuestion {
  return {
    id: 'q1',
    type: 'single',
    question: 'Pick one',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
    answer: ['a'],
    hasAnswer: true,
    points: 1,
    ...overrides,
  };
}

describe('gradeChoiceQuestions', () => {
  it('scores a correct single-choice answer', () => {
    const results = gradeChoiceQuestions([q({})], { q1: 'a' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ questionId: 'q1', correct: true, earned: 1 });
  });

  it('scores an incorrect single-choice answer', () => {
    const results = gradeChoiceQuestions([q({})], { q1: 'b' });
    expect(results[0]).toMatchObject({ correct: false, earned: 0 });
  });

  it('treats multi-choice order-insensitively', () => {
    const question = q({ id: 'm1', type: 'multiple', answer: ['a', 'b'] });
    const results = gradeChoiceQuestions([question], { m1: ['b', 'a'] });
    expect(results[0].correct).toBe(true);
  });

  it('scores missing answer as incorrect', () => {
    const results = gradeChoiceQuestions([q({})], {});
    expect(results[0]).toMatchObject({ correct: false, earned: 0 });
  });

  it('skips short-answer questions', () => {
    const sa = q({ id: 's1', type: 'short_answer', answer: [], hasAnswer: false });
    const results = gradeChoiceQuestions([sa], { s1: 'anything' });
    expect(results).toHaveLength(0);
  });

  it('honors custom point values', () => {
    const results = gradeChoiceQuestions([q({ points: 5 })], { q1: 'a' });
    expect(results[0].earned).toBe(5);
  });

  it('grades a legacy answer label against its unique option value without rewriting it', () => {
    const question = q({
      question: '1 + 1 = ?',
      options: [
        { value: 'A', label: '1' },
        { value: 'B', label: '2' },
        { value: 'C', label: '3' },
      ],
      answer: ['2'],
      points: 10,
    });
    expect(gradeChoiceQuestions([question], { q1: 'B' })[0]).toMatchObject({
      correct: true,
      earned: 10,
    });
    expect(question.answer).toEqual(['2']);
  });

  it.each([{ answer: undefined }, { answer: [] }, { answer: ['unknown'] }])(
    'rejects an unusable key $answer instead of manufacturing a score',
    ({ answer }) => {
      expect(() => gradeChoiceQuestions([q({ answer })], {})).toThrow(/answer/i);
    },
  );

  it('rejects ambiguous answer labels', () => {
    const question = q({
      options: [
        { value: 'a', label: 'same' },
        { value: 'b', label: 'same' },
      ],
      answer: ['same'],
    });
    expect(() => gradeChoiceQuestions([question], { q1: 'a' })).toThrow(/answer/i);
  });
});

describe('isShortAnswer', () => {
  it('returns true for type=short_answer', () => {
    expect(isShortAnswer(q({ type: 'short_answer' }))).toBe(true);
  });

  it('classifies by type only: an unanswered choice question is still a choice question', () => {
    // hasAnswer / empty answer must NOT re-route a single/multiple question to
    // AI grading — the explicit type wins.
    expect(isShortAnswer(q({ type: 'single', hasAnswer: false, answer: [] }))).toBe(false);
    expect(isShortAnswer(q({ type: 'multiple', hasAnswer: undefined, answer: [] }))).toBe(false);
  });

  it('returns false for a regular choice question', () => {
    expect(isShortAnswer(q({}))).toBe(false);
  });
});

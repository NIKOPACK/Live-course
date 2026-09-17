import { describe, expect, it } from 'vitest';
import { normalizeQuizQuestion, normalizeScene } from '@livecourse/dsl';
import type { QuizQuestion, Scene } from '@livecourse/dsl';

function question(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: 'q1',
    type: 'single',
    question: '1 + 1 = ?',
    options: [
      { value: 'A', label: '1' },
      { value: 'B', label: '2' },
      { value: 'C', label: '3' },
    ],
    answer: ['B'],
    ...overrides,
  };
}

describe('normalizeQuizQuestion', () => {
  it('keeps canonical answers unchanged', () => {
    const input = question();
    expect(normalizeQuizQuestion(input)).toBe(input);
  });

  it('repairs unique labels purely and idempotently', () => {
    const input = question({ answer: ['2'] });
    const output = normalizeQuizQuestion(input);
    expect(output.answer).toEqual(['B']);
    expect(input.answer).toEqual(['2']);
    expect(normalizeQuizQuestion(output)).toBe(output);
  });

  it('prefers an existing value over another option label', () => {
    const input = question({
      options: [
        { value: 'A', label: 'B' },
        { value: 'B', label: 'A' },
      ],
    });
    expect(normalizeQuizQuestion(input)).toBe(input);
  });

  it('normalizes surrounding whitespace, not case or meaning', () => {
    expect(normalizeQuizQuestion(question({ answer: [' 2 '] })).answer).toEqual(['B']);
    expect(normalizeQuizQuestion(question({ answer: [' B '] })).answer).toEqual(['B']);
    expect(() => normalizeQuizQuestion(question({ answer: ['b'] }))).toThrow(/answer/i);
  });

  it('supports multiple choice mixing values and labels without reordering', () => {
    expect(
      normalizeQuizQuestion(question({ type: 'multiple', answer: ['3', 'A'] })).answer,
    ).toEqual(['C', 'A']);
  });

  it.each<{ name: string; overrides: Partial<QuizQuestion> }>([
    { name: 'unknown label', overrides: { answer: ['unknown'] } },
    {
      name: 'ambiguous labels',
      overrides: {
        options: [
          { value: 'A', label: 'same' },
          { value: 'B', label: 'same' },
        ],
        answer: ['same'],
      },
    },
    { name: 'missing options', overrides: { options: undefined } },
    {
      name: 'duplicate values',
      overrides: {
        options: [
          { value: 'B', label: '1' },
          { value: 'B', label: '2' },
        ],
      },
    },
    { name: 'multiple answers to a single choice', overrides: { answer: ['A', 'B'] } },
    {
      name: 'duplicate resolved answers',
      overrides: { type: 'multiple', answer: ['B', '2'] },
    },
  ])('rejects $name without guessing', ({ overrides }) => {
    expect(() => normalizeQuizQuestion(question(overrides))).toThrow(/invalid quiz answer/i);
  });

  it.each<Partial<QuizQuestion>>([
    { type: 'short_answer', answer: ['free text'], options: undefined },
    { answer: undefined },
    { answer: [] },
  ])('does not invent an answer for ungraded content %j', (overrides) => {
    const input = question(overrides);
    expect(normalizeQuizQuestion(input)).toBe(input);
  });

  it('is applied by the scene normalizer without mutating the document', () => {
    const scene: Scene = {
      id: 'scene',
      stageId: 'stage',
      type: 'quiz',
      title: 'Addition',
      order: 0,
      content: { type: 'quiz', questions: [question({ answer: ['2'] })] },
      actions: [],
    };
    expect(normalizeScene(scene).content).toMatchObject({
      questions: [{ answer: ['B'] }],
    });
    expect(scene.content).toMatchObject({ questions: [{ answer: ['2'] }] });
  });
});

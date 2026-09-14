import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizQuestion } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  getCurrentModelConfig: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: mocks.getCurrentModelConfig,
}));

import { gradeShortAnswerQuestion } from '@/components/scene-renderers/quiz-view';

const question: QuizQuestion = {
  id: 'short-1',
  type: 'short_answer',
  question: 'Explain the concept.',
  points: 5,
};

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('short-answer grading client', () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.getCurrentModelConfig.mockReset();
    mocks.getCurrentModelConfig.mockReturnValue({
      modelString: 'test:test-model',
      apiKey: 'test-key',
    });
  });

  it('accepts the API success envelope without clamping or coercion', async () => {
    mocks.fetch.mockResolvedValue(response(200, { success: true, score: 4, comment: 'Good' }));

    await expect(gradeShortAnswerQuestion(question, 'My answer', 'en-US')).resolves.toEqual({
      questionId: 'short-1',
      correct: true,
      status: 'correct',
      earned: 4,
      aiComment: 'Good',
    });
  });

  it('rejects an API error instead of returning a synthetic base score', async () => {
    mocks.fetch.mockResolvedValue(
      response(502, {
        success: false,
        errorCode: 'PARSE_FAILED',
        error: 'Quiz grading service returned an invalid response',
      }),
    );

    await expect(gradeShortAnswerQuestion(question, 'My answer', 'en-US')).rejects.toThrow(
      'Quiz grading service returned an invalid response',
    );
  });

  it('propagates a request failure instead of returning a synthetic base score', async () => {
    mocks.fetch.mockRejectedValue(new Error('network offline'));

    await expect(gradeShortAnswerQuestion(question, 'My answer', 'en-US')).rejects.toThrow(
      'network offline',
    );
  });

  it.each([
    ['the success discriminator is absent', { score: 4, comment: 'Good' }],
    ['the score is out of range', { success: true, score: 8, comment: 'Good' }],
    ['the score is fractional', { success: true, score: 2.5, comment: 'Good' }],
    ['the comment is empty', { success: true, score: 4, comment: '' }],
  ])('rejects a successful HTTP response when %s', async (_case, body) => {
    mocks.fetch.mockResolvedValue(response(200, body));

    await expect(gradeShortAnswerQuestion(question, 'My answer', 'en-US')).rejects.toThrow(
      'Quiz grading service returned an invalid response',
    );
  });
});

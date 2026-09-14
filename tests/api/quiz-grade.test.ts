import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  resolveModelFromRequest: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function postQuizGrade(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/quiz-grade/route');
  const request = new Request('http://localhost/api/quiz-grade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/quiz-grade', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.callLLM.mockReset();
    mocks.resolveModelFromRequest.mockReset();
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: { provider: 'test.chat', modelId: 'test-model' },
      thinkingConfig: undefined,
    });
  });

  it('returns a validated score and trimmed comment', async () => {
    mocks.callLLM.mockResolvedValue({ text: '{"score":4,"comment":"  Good answer.  "}' });

    const response = await postQuizGrade({
      question: 'Explain the concept.',
      userAnswer: 'An explanation.',
      points: 5,
      language: 'en-US',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      score: 4,
      comment: 'Good answer.',
    });
  });

  it.each([
    ['non-JSON output', 'The answer deserves partial credit.'],
    ['JSON surrounded by prose', 'Result: {"score":4,"comment":"Good"}'],
    ['a coerced string score', '{"score":"4","comment":"Good"}'],
    ['a fractional score', '{"score":2.5,"comment":"Good"}'],
    ['an out-of-range score', '{"score":6,"comment":"Good"}'],
    ['an empty comment', '{"score":4,"comment":"   "}'],
    ['an unexpected property', '{"score":4,"comment":"Good","passed":true}'],
  ])('returns 502 instead of fabricating a grade for %s', async (_case, text) => {
    mocks.callLLM.mockResolvedValue({ text });

    const response = await postQuizGrade({
      question: 'Explain the concept.',
      userAnswer: 'An explanation.',
      points: 5,
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      success: false,
      errorCode: 'PARSE_FAILED',
    });
    expect(body).not.toHaveProperty('score');
  });

  it('reports an upstream grading failure as 502 without a score', async () => {
    mocks.callLLM.mockRejectedValue(new Error('provider unavailable'));

    const response = await postQuizGrade({
      question: 'Explain the concept.',
      userAnswer: 'An explanation.',
      points: 5,
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      success: false,
      errorCode: 'UPSTREAM_ERROR',
    });
    expect(body).not.toHaveProperty('score');
  });

  it('rejects a fractional point scale before resolving a model', async () => {
    const response = await postQuizGrade({
      question: 'Explain the concept.',
      userAnswer: 'An explanation.',
      points: 2.5,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.resolveModelFromRequest).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('classifies a missing model text result as an invalid response', async () => {
    mocks.callLLM.mockResolvedValue({});

    const response = await postQuizGrade({
      question: 'Explain the concept.',
      userAnswer: 'An explanation.',
      points: 5,
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      success: false,
      errorCode: 'PARSE_FAILED',
    });
  });

  it('returns 400 for malformed JSON before resolving a model', async () => {
    const { POST } = await import('@/app/api/quiz-grade/route');
    const request = new Request('http://localhost/api/quiz-grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });

    const response = await POST(request as unknown as NextRequest);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.resolveModelFromRequest).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });
});

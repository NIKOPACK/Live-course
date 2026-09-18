import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { createClassroomReviewer } from '@/lib/server/classroom-review';
import { llmApiError } from '@/lib/server/llm-error-response';
import { ClassroomReviewUnavailableError } from '@/lib/livecourse/lesson/quality-review';

const mocks = vi.hoisted(() => ({ collectStreamedCompletion: vi.fn() }));
vi.mock('@/lib/ai/llm', () => ({
  collectStreamedCompletion: mocks.collectStreamedCompletion,
}));
const model = createOpenAI({ apiKey: 'unused' }).chat('review-model');
const final = { text: '{"checks":["ok"],"issues":[]}', finishReason: 'stop', reasoningText: '' };

describe('independent reviewer calls', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('LLM_THINKING_DISABLED', 'false');
    mocks.collectStreamedCompletion.mockResolvedValue(final);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('resolves once and uses native output capacity with thinking off', async () => {
    const resolve = vi.fn().mockResolvedValue({ model, modelInfo: { outputWindow: 32768 } });
    const controller = new AbortController();
    const call = createClassroomReviewer(resolve, controller.signal);
    await call('system', 'first');
    await call('system', 'second');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(mocks.collectStreamedCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        model,
        maxOutputTokens: 32768,
        abortSignal: controller.signal,
      }),
      'classroom-review',
      { mode: 'disabled', enabled: false },
    );
  });

  it('respects explicit settings and custom models without metadata', async () => {
    await createClassroomReviewer(async () => ({
      model,
      modelInfo: null,
      thinkingConfig: { mode: 'disabled' },
    }))('system', 'prompt');
    expect(mocks.collectStreamedCompletion.mock.calls[0][2]).toEqual({
      mode: 'disabled',
      enabled: false,
    });
  });

  it('keeps HTML-bearing patches on the compatible non-reasoning path without reducing output capacity', async () => {
    await createClassroomReviewer(
      async () => ({
        model,
        modelInfo: { outputWindow: 32768 },
        thinkingConfig: { mode: 'enabled', effort: 'high' },
      }),
      undefined,
      'html-repair',
    )('system', 'prompt');
    expect(mocks.collectStreamedCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model, maxOutputTokens: 32768 }),
      'classroom-review-repair',
      { mode: 'disabled', enabled: false },
    );
  });

  it.each([
    { text: '', finishReason: 'stop' },
    { text: '{}', finishReason: 'length' },
    { text: '{}', finishReason: 'error' },
    { text: '{}', finishReason: 'content-filter' },
  ])('does not retry or accept incomplete reviewer output (%j)', async (result) => {
    mocks.collectStreamedCompletion.mockResolvedValue({ ...result, reasoningText: '' });
    await expect(createClassroomReviewer(async () => ({ model }))('', '')).rejects.toMatchObject({
      name: 'ClassroomQualityError',
      isRetryable: false,
    });
    expect(mocks.collectStreamedCompletion).toHaveBeenCalledTimes(1);
  });

  it('keeps thinking off for HTML patches even on OpenAI Responses models', async () => {
    const responsesModel = createOpenAI({ apiKey: 'unused' }).responses('gpt-5.5');
    await createClassroomReviewer(
      async () => ({ model: responsesModel }),
      undefined,
      'html-repair',
    )('', '');
    expect(mocks.collectStreamedCompletion.mock.calls[0][2]).toEqual({
      mode: 'disabled',
      enabled: false,
    });
  });

  it('retries only the failed review call, not the completed authoring work', async () => {
    vi.useFakeTimers();
    mocks.collectStreamedCompletion
      .mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { statusCode: 502 }))
      .mockResolvedValueOnce(final);
    const result = createClassroomReviewer(async () => ({ model }))('', '');
    await vi.runAllTimersAsync();
    expect(await result).toBe(final.text);
    expect(mocks.collectStreamedCompletion).toHaveBeenCalledTimes(2);
  });

  it('marks exhausted review transport retries so outer scene retries cannot multiply them', async () => {
    vi.useFakeTimers();
    mocks.collectStreamedCompletion.mockRejectedValue(
      Object.assign(new Error('private upstream detail'), { statusCode: 502 }),
    );
    const result = createClassroomReviewer(async () => ({ model }))('', '');
    const assertion = expect(result).rejects.toMatchObject({
      name: 'ClassroomReviewUnavailableError',
      isRetryable: false,
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(mocks.collectStreamedCompletion).toHaveBeenCalledTimes(3);
    const response = llmApiError(
      new ClassroomReviewUnavailableError('review unavailable', {
        cause: Object.assign(new Error('private upstream detail'), { statusCode: 502 }),
      }),
    );
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.isRetryable).toBe(false);
    expect(JSON.stringify(body)).not.toContain('private upstream');
  });

  it('does not replace an invalid reviewer route with another model', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('Misconfigured reviewer'));
    await expect(createClassroomReviewer(resolve)('', '')).rejects.toMatchObject({
      name: 'ClassroomReviewUnavailableError',
      isRetryable: false,
    });
    expect(mocks.collectStreamedCompletion).not.toHaveBeenCalled();
  });

  it('does not resolve or call a model after cancellation', async () => {
    const resolve = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(createClassroomReviewer(resolve, controller.signal)('', '')).rejects.toMatchObject(
      { name: 'AbortError' },
    );
    expect(resolve).not.toHaveBeenCalled();
  });
});

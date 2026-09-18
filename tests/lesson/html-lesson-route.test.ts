import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  designHtml: vi.fn(),
  designLegacy: vi.fn(),
  callLLM: vi.fn(),
  collectStreamedCompletion: vi.fn(),
}));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModel,
}));
vi.mock('@/lib/livecourse/lesson/html-presentation', () => ({
  designHtmlLessonPlan: mocks.designHtml,
}));
vi.mock('@/lib/livecourse/lesson/designer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/livecourse/lesson/designer')>()),
  designLessonPlanWithSubagents: mocks.designLegacy,
}));
vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
  collectStreamedCompletion: mocks.collectStreamedCompletion,
}));

import { POST } from '@/app/api/generate/lesson-plan/route';

function request(htmlPresentation?: boolean) {
  return new NextRequest('http://localhost/api/generate/lesson-plan', {
    method: 'POST',
    body: JSON.stringify({
      stageId: 'stage',
      courseId: 'course',
      requirements: { requirement: 'Teach derivatives.' },
      outlines: [{ id: 'intro', type: 'slide', title: 'Derivatives', order: 0 }],
      htmlPresentation,
    }),
  });
}

describe('HTML lesson preparation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveModel.mockResolvedValue({ model: {} });
    mocks.callLLM.mockResolvedValue({ text: 'final answer' });
    mocks.collectStreamedCompletion.mockResolvedValue({
      text: 'final answer',
      finishReason: 'stop',
      reasoningText: '',
    });
  });

  it('returns the main-agent direction with the lesson rather than the legacy designer', async () => {
    const plan = { presentation: { mode: 'html', visualStyle: 'Teal diagrams on warm paper.' } };
    mocks.designHtml.mockResolvedValue(plan);
    const response = await POST(request(true));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, lessonPlan: plan });
    expect(mocks.designLegacy).not.toHaveBeenCalled();
  });

  it('surfaces a failed main direction so preview can retry without starting page workers', async () => {
    mocks.designHtml.mockRejectedValue(new Error('No visual direction generated'));
    const response = await POST(request(true));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).toMatchObject({ success: false });
    expect(mocks.designLegacy).not.toHaveBeenCalled();
  });

  it('always uses the HTML designer even when the caller omits htmlPresentation', async () => {
    const plan = { presentation: { mode: 'html', visualStyle: 'Teal diagrams on warm paper.' } };
    mocks.designHtml.mockResolvedValue(plan);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, lessonPlan: plan });
    expect(mocks.designLegacy).not.toHaveBeenCalled();
    expect(mocks.designHtml).toHaveBeenCalled();
  });

  it('forwards an abort signal so a refresh can cancel the in-flight design', async () => {
    const plan = { presentation: { mode: 'html', visualStyle: 'Teal diagrams on warm paper.' } };
    mocks.designHtml.mockResolvedValue(plan);
    await POST(request(true));
    expect(mocks.designHtml.mock.calls[0]?.[1]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('provides an independently resolved reviewer rather than reusing the lesson model', async () => {
    const reviewModel = { modelId: 'independent-review' };
    mocks.resolveModel.mockImplementation(async (_req, _body, stage) => ({
      model: stage === 'classroom-review' ? reviewModel : { modelId: 'lesson' },
      modelInfo: { outputWindow: 32768 },
    }));
    mocks.designHtml.mockImplementationOnce(async (_input, _runtime, _author, reviewCall) => {
      await reviewCall('review system', 'review prompt');
      return { presentation: { mode: 'html', visualStyle: 'Ink.' } };
    });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.collectStreamedCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        model: reviewModel,
        maxOutputTokens: 32768,
        abortSignal: expect.any(AbortSignal),
      }),
      'classroom-review',
      { mode: 'disabled', enabled: false },
    );
  });

  it.each([undefined, { mode: 'disabled' }, { mode: 'enabled', effort: 'high' }])(
    'shares the lesson reasoning configuration with the main call and node workers (%j)',
    async (thinkingConfig) => {
      const model = { modelId: 'lesson-model' };
      mocks.resolveModel.mockResolvedValue({
        model,
        modelInfo: { outputWindow: 32768 },
        thinkingConfig,
      });
      mocks.designHtml.mockImplementationOnce(async (_input, _runtime, aiCall) => {
        await aiCall('system', 'prompt');
        return { presentation: { mode: 'html', visualStyle: 'Ink diagrams.' } };
      });
      expect((await POST(request())).status).toBe(200);
      const expected = thinkingConfig ?? { mode: 'enabled', effort: 'high' };
      expect(mocks.resolveModel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'lesson-plan',
      );
      expect(mocks.designHtml.mock.calls[0][1]).toMatchObject({
        languageModel: model,
        thinkingConfig: expected,
        maxOutputTokens: 32768,
      });
      expect(mocks.collectStreamedCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          model,
          system: 'system',
          prompt: 'prompt',
          maxOutputTokens: 32768,
        }),
        'lesson-plan',
        expected,
      );
    },
  );

  it('aborts an in-flight HTML design when the same stage starts again', async () => {
    const plan = { presentation: { mode: 'html', visualStyle: 'Teal diagrams on warm paper.' } };
    let firstSignal: AbortSignal | undefined;
    mocks.designHtml.mockImplementationOnce(
      (_input: unknown, runtime: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          firstSignal = runtime.abortSignal;
          const fail = () => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (runtime.abortSignal?.aborted) {
            fail();
            return;
          }
          runtime.abortSignal?.addEventListener('abort', fail, { once: true });
        }),
    );
    mocks.designHtml.mockResolvedValueOnce(plan);

    const first = POST(request(true));
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    const second = await POST(request(true));
    const firstResponse = await first;

    expect(firstSignal?.aborted).toBe(true);
    expect(firstResponse.status).toBe(499);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ success: true, lessonPlan: plan });
  });
});

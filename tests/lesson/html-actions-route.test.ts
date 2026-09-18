import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AICallFn } from '@/lib/generation/pipeline-types';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  generateSceneActions: vi.fn(),
  buildCompleteScene: vi.fn(),
  callLLM: vi.fn(),
  completeLLMText: vi.fn(),
  collectStreamedCompletion: vi.fn(),
}));
vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
  completeLLMText: mocks.completeLLMText,
  collectStreamedCompletion: mocks.collectStreamedCompletion,
}));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModelFromRequest: mocks.resolveModel }));
vi.mock('@/lib/generation/generation-pipeline', () => ({
  generateSceneActions: mocks.generateSceneActions,
  buildCompleteScene: mocks.buildCompleteScene,
  buildVisionUserContent: vi.fn(),
}));
vi.mock('@/lib/generation/scene-generator', () => ({
  generateSceneActions: mocks.generateSceneActions,
}));
import { POST } from '@/app/api/generate/scene-actions/route';

const design = {
  teachingPoints: ['One worked example'],
  explanationPlan: 'Explain the assumption before the result.',
};
function request(lessonNodeDesign: unknown = design, htmlClassroom = true) {
  const outline = { id: 'one', type: 'slide', title: 'Example', order: 0 };
  return new NextRequest('http://localhost/api/generate/scene-actions', {
    method: 'POST',
    body: JSON.stringify({
      outline,
      allOutlines: [outline],
      stageId: 'stage',
      content: htmlClassroom
        ? { html: '<html></html>', htmlPresentation: true }
        : { elements: [], remark: '' },
      lessonNodeDesign,
    }),
  });
}

describe('HTML action design boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('LLM_THINKING_DISABLED', 'false');
    mocks.resolveModel.mockResolvedValue({ model: {}, modelInfo: {}, modelString: 'test:model' });
    mocks.callLLM.mockImplementation(async (_params, source) => ({
      text:
        source === 'classroom-review'
          ? JSON.stringify({ checks: ['Content verified.'], issues: [] })
          : '[]',
      finishReason: 'stop',
      reasoningText: '',
    }));
    mocks.collectStreamedCompletion.mockImplementation(mocks.callLLM);
    mocks.completeLLMText.mockResolvedValue('[]');
    mocks.generateSceneActions.mockResolvedValue([]);
    mocks.buildCompleteScene.mockReturnValue({ id: 'scene', actions: [] });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('forwards the validated shared design to narration generation', async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.generateSceneActions).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({ lessonNodeDesign: design }),
    );
  });

  it('rejects invalid teaching design before model resolution or generation', async () => {
    expect((await POST(request({ ...design, teachingPoints: [] }))).status).toBe(400);
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.generateSceneActions).not.toHaveBeenCalled();
  });

  it.each([undefined, { mode: 'disabled' }, { mode: 'enabled', effort: 'high' }])(
    'streams HTML narration with thinking off so the page stays in content (%j)',
    async (thinkingConfig) => {
      const model = { modelId: 'narration-model' };
      mocks.resolveModel.mockResolvedValue({
        model,
        modelInfo: { outputWindow: 32768 },
        thinkingConfig,
      });
      mocks.generateSceneActions.mockImplementation(
        async (_outline, _content, aiCall: AICallFn) => {
          expect(await aiCall('system', 'prompt')).toBe('[]');
          return [];
        },
      );

      expect((await POST(request())).status).toBe(200);
      expect(mocks.resolveModel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'scene-actions',
      );
      expect(mocks.collectStreamedCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          model,
          maxOutputTokens: 32768,
          maxRetries: 0,
          abortSignal: expect.any(AbortSignal),
        }),
        'scene-actions',
        { mode: 'disabled', enabled: false },
      );
      expect(mocks.completeLLMText).not.toHaveBeenCalled();
    },
  );

  it('preserves the legacy action completion path for non-HTML content', async () => {
    mocks.generateSceneActions.mockImplementation(async (_outline, _content, aiCall: AICallFn) => {
      await aiCall('system', 'prompt');
      return [];
    });
    expect((await POST(request(design, false))).status).toBe(200);
    expect(mocks.completeLLMText).toHaveBeenCalledWith(
      expect.anything(),
      'scene-actions',
      undefined,
    );
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('uses the review route and assembles the corrected HTML rather than the original draft', async () => {
    const reviewModel = { modelId: 'independent-review' };
    mocks.resolveModel.mockImplementation(async (_req, _body, stage) => ({
      model: stage === 'classroom-review' ? reviewModel : { modelId: 'author' },
      modelInfo: { outputWindow: 32768 },
    }));
    let reviews = 0;
    mocks.callLLM.mockImplementation(async (_params, source) => ({
      text:
        source === 'classroom-review'
          ? JSON.stringify({
              checks: ['Amplitude is 1.'],
              resolutions: [
                { issueIndex: 0, fixed: true, evidence: 'The amplitude label is corrected.' },
              ],
              issues:
                reviews++ === 0
                  ? [
                      {
                        severity: 'blocking',
                        confidence: 'high',
                        target: 'html',
                        evidence: 'Incorrect amplitude label.',
                        correction: 'Amplitude is 1.',
                      },
                    ]
                  : [],
            })
          : JSON.stringify({
              edits: [
                {
                  oldText: '<html></html>',
                  newText:
                    '<!DOCTYPE html><html><head></head><body><p id="value">Amplitude is 1.</p></body></html>',
                },
              ],
            }),
      finishReason: 'stop',
    }));
    expect((await POST(request())).status).toBe(200);
    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(2);
    expect(mocks.buildCompleteScene).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ html: expect.stringContaining('Amplitude is 1.') }),
      [],
      'stage',
    );
    expect(mocks.collectStreamedCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: reviewModel, maxOutputTokens: 32768 }),
      'classroom-review',
      { mode: 'disabled', enabled: false },
    );
    expect(mocks.resolveModel).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'scene-content:slide',
    );
    expect(mocks.collectStreamedCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: reviewModel, maxOutputTokens: 32768 }),
      'classroom-review-repair',
      { mode: 'disabled', enabled: false },
    );
  });

  it.each([
    { text: '', reasoningText: 'The amplitude is one.', finishReason: 'stop' },
    { text: '[]', finishReason: 'length' },
  ])('does not assemble empty or truncated narration (%j)', async (result) => {
    mocks.collectStreamedCompletion.mockResolvedValue(result);
    mocks.generateSceneActions.mockImplementation(async (_outline, _content, aiCall: AICallFn) => {
      await aiCall('system', 'prompt');
      return [];
    });
    const response = await POST(request());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ success: false, isRetryable: false });
    expect(mocks.buildCompleteScene).not.toHaveBeenCalled();
  });

  it('returns a non-retryable failure instead of assembling a scene from a malformed review', async () => {
    mocks.callLLM.mockResolvedValue({ text: '{}', finishReason: 'stop', reasoningText: '' });
    const response = await POST(request());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ success: false, isRetryable: false });
    expect(mocks.buildCompleteScene).not.toHaveBeenCalled();
    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(1);
  });
});

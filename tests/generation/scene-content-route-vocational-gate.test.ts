import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { SceneOutline } from '@/lib/types/generation';

const completeLLMTextMock = vi.hoisted(() => vi.fn());
const resolveModelFromRequestMock = vi.hoisted(() => vi.fn());
const VOCATIONAL_FLAG = 'LIVECOURSE_ENABLE_VOCATIONAL';
const PRESENTATION = { mode: 'html' as const, visualStyle: 'Teal diagrams on paper.' };
let originalVocationalFlag: string | undefined;

vi.mock('@/lib/ai/llm', () => ({
  completeLLMText: completeLLMTextMock,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: resolveModelFromRequestMock,
}));

describe('scene-content vocational gate', () => {
  beforeEach(() => {
    originalVocationalFlag = process.env[VOCATIONAL_FLAG];
    delete process.env[VOCATIONAL_FLAG];
    completeLLMTextMock.mockReset();
    resolveModelFromRequestMock.mockReset();
    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'test.chat', modelId: 'test-model' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'test:test-model',
      thinkingConfig: undefined,
    });
  });

  afterEach(() => {
    if (originalVocationalFlag === undefined) {
      delete process.env[VOCATIONAL_FLAG];
    } else {
      process.env[VOCATIONAL_FLAG] = originalVocationalFlag;
    }
  });

  test.each(['false', '1', undefined])(
    'flag %s never bypasses the HTML classroom prerequisite',
    async (flag) => {
      vi.resetModules();
      if (flag !== undefined) process.env[VOCATIONAL_FLAG] = flag;

      const { POST } = await import('@/app/api/generate/scene-content/route');
      const response = await POST(
        mockRequest(createProceduralSkillOutline(), { taskEngineMode: true }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
      expect(body.error).toContain('HTML classroom visual direction');
      expect(completeLLMTextMock).not.toHaveBeenCalled();
      expect(resolveModelFromRequestMock).not.toHaveBeenCalled();
    },
  );

  test('omitting legacy mode requirements still requires an HTML visual direction', async () => {
    vi.resetModules();

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(mockRequest(createProceduralSkillOutline()));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(completeLLMTextMock).not.toHaveBeenCalled();
  });

  test.each(['false', '1'])(
    'flag %s uses free-form HTML instead of restoring the widget engine',
    async (flag) => {
      vi.resetModules();
      process.env[VOCATIONAL_FLAG] = flag;
      completeLLMTextMock.mockResolvedValueOnce(
        '<!DOCTYPE html><html><body><main>Free-form classroom</main></body></html>',
      );

      const { POST } = await import('@/app/api/generate/scene-content/route');
      const response = await POST(
        mockRequest(createProceduralSkillOutline(), { taskEngineMode: true }, PRESENTATION),
      );
      const body = await response.json();

      expect(body.success).toBe(true);
      expect(body.content.html).toContain('Free-form classroom');
      expect(body.content.widgetType).toBeUndefined();
      expect(body.content.widgetConfig).toBeUndefined();
      expect(completeLLMTextMock).toHaveBeenCalledTimes(1);
      expect(completeLLMTextMock.mock.calls[0][0].system).not.toContain('Procedural Skill');
      expect(completeLLMTextMock.mock.calls[0][0].prompt).toContain(PRESENTATION.visualStyle);
    },
  );
});

function mockRequest(
  outline: SceneOutline,
  requirements?: { taskEngineMode?: boolean },
  presentation?: typeof PRESENTATION,
) {
  return {
    json: async () => ({
      outline,
      allOutlines: [outline],
      stageId: 'stage-1',
      stageInfo: { name: 'Test Stage' },
      requirements,
      presentation,
    }),
  } as unknown as Parameters<typeof import('@/app/api/generate/scene-content/route').POST>[0];
}

function createProceduralSkillOutline(): SceneOutline {
  return {
    id: 'scene-procedural-skill',
    type: 'interactive',
    title: 'Device Calibration Practice',
    description: 'Practice a generic calibration procedure with step feedback.',
    keyPoints: ['Follow steps in order', 'Check each success criterion'],
    order: 1,
    widgetType: 'procedural-skill',
    widgetOutline: {
      concept: 'calibration procedure',
      procedureType: 'operation',
      task: 'Calibrate a training device',
      tools: ['multimeter', 'checklist'],
      steps: ['Inspect the device', 'Connect the tool', 'Confirm the reading'],
      successCriteria: ['No visible damage', 'Reading is within range'],
      errorConsequences: ['Unsafe readings require stopping and rechecking'],
    },
  };
}

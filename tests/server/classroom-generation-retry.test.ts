import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLessonPlanSkeleton } from '@/lib/livecourse/lesson/skeleton';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  isProviderKeyRequired: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
  applyOutlineFallbacks: vi.fn(),
  generateSceneContent: vi.fn(),
  generateSceneActions: vi.fn(),
  createSceneWithActions: vi.fn(),
  designLessonPlanWithSubagents: vi.fn(),
  persistClassroom: vi.fn(),
  callLLM: vi.fn(),
  getStageModel: vi.fn(),
}));
const PBLGenerationErrorMock = vi.hoisted(
  () =>
    class PBLGenerationError extends Error {
      readonly statusCode?: number;

      constructor(message: string, options?: { statusCode?: number }) {
        super(message);
        this.name = 'PBLGenerationError';
        this.statusCode = options?.statusCode;
      }
    },
);

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
}));
vi.mock('@/lib/server/model-routes', () => ({ getStageModel: mocks.getStageModel }));

vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  // The module graph now reaches the settings store (stage store -> settings),
  // whose init reads PROVIDERS - keep the real exports and stub only the probe.
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: mocks.isProviderKeyRequired,
}));

vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
  collectStreamedCompletion: mocks.callLLM,
  completeLLMText: async (
    params: unknown,
    source: string,
    thinking?: unknown,
  ) => {
    const result = (await mocks.callLLM(params, source, undefined, thinking)) as {
      text?: string;
    };
    return result?.text ?? '';
  },
  resolveLlmText: (result: { text?: string; reasoningText?: string }) =>
    result.text?.trim() ? result.text : (result.reasoningText ?? ''),
}));

vi.mock('@/lib/generation/outline-generator', () => ({
  generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
  applyOutlineFallbacks: mocks.applyOutlineFallbacks,
}));

vi.mock('@/lib/generation/scene-generator', () => ({
  generateSceneContent: mocks.generateSceneContent,
  generateSceneActions: mocks.generateSceneActions,
  createSceneWithActions: mocks.createSceneWithActions,
  PBLGenerationError: PBLGenerationErrorMock,
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  persistClassroom: mocks.persistClassroom,
}));

vi.mock('@/lib/livecourse/lesson/html-presentation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/livecourse/lesson/html-presentation')>()),
  designHtmlLessonPlan: mocks.designLessonPlanWithSubagents,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Retry Basics',
  description: 'Explain retries',
  keyPoints: ['Retry transient failures'],
  order: 1,
} as const;

const slideContent = {
  elements: [],
  remark: 'Retry transient failures',
};

async function generateWithProgress() {
  const progress: Array<{ message: string }> = [];
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  const result = await generateClassroom(
    { requirement: 'Teach retry basics' },
    {
      baseUrl: 'http://localhost',
      onProgress: (event) => {
        progress.push({ message: event.message });
      },
    },
  );
  return { result, progress };
}

describe('classroom scene generation retries', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
    });
    mocks.isProviderKeyRequired.mockReturnValue(false);
    mocks.callLLM.mockResolvedValue({ text: 'ok', finishReason: 'stop', reasoningText: '' });
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'Use English.',
        outlines: [outline],
      },
    });
    mocks.applyOutlineFallbacks.mockImplementation((value) => value);
    mocks.designLessonPlanWithSubagents.mockResolvedValue({
      ...buildLessonPlanSkeleton({
        stageId: 'stage-1',
        requirement: 'Teach retry basics',
        outlines: [{ ...outline, keyPoints: [...outline.keyPoints] }],
      }),
      presentation: { mode: 'html', visualStyle: 'Ink diagrams on warm paper.' },
    });
    mocks.generateSceneActions.mockResolvedValue([]);
    mocks.createSceneWithActions.mockImplementation((sceneOutline, content, actions, api) => {
      const sceneResult = api.scene.create({
        type: sceneOutline.type,
        title: sceneOutline.title,
        order: sceneOutline.order,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            elements: content.elements,
          },
        },
        actions,
      });
      return sceneResult.success ? (sceneResult.data ?? null) : null;
    });
    mocks.persistClassroom.mockImplementation(async ({ id, scenes }) => ({
      id,
      url: `http://localhost/classroom/${id}`,
      scenesCount: scenes.length,
      createdAt: '2026-06-22T00:00:00.000Z',
    }));
  });

  it('retries an empty scene content result before skipping the scene', async () => {
    mocks.generateSceneContent.mockResolvedValueOnce(null).mockResolvedValueOnce(slideContent);

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(1);
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(2);
    expect(progress.some((event) => event.message.includes('Retrying scene 1/1 content'))).toBe(
      true,
    );
  }, 15_000); // Retries use a real backoff delay; under full-suite worker load, the default 5s timeout flakes

  it('persists reviewed HTML corrections and does not regenerate the original content stage', async () => {
    const real = await vi.importActual<typeof import('@/lib/generation/scene-generator')>(
      '@/lib/generation/scene-generator',
    );
    mocks.createSceneWithActions.mockImplementation(real.createSceneWithActions);
    mocks.generateSceneContent.mockResolvedValue({
      html: '<html><head></head><body><p id="value">Wrong value.</p></body></html>',
      htmlPresentation: true,
    });
    let reviews = 0;
    mocks.callLLM.mockImplementation(async (_params, source) => ({
      text:
        source === 'classroom-review' &&
        !String(_params.system).includes('minimal exact-text edits')
          ? JSON.stringify({
              checks: ['Amplitude is 1.'],
              resolutions: [{ issueIndex: 0, fixed: true, evidence: 'The label is corrected.' }],
              issues:
                reviews++ === 0
                  ? [
                      {
                        severity: 'blocking',
                        confidence: 'high',
                        target: 'html',
                        evidence: 'The label is wrong.',
                        correction: 'Amplitude is 1.',
                      },
                    ]
                  : [],
            })
          : JSON.stringify({ edits: [{ oldText: 'Wrong value.', newText: 'Amplitude is 1.' }] }),
      finishReason: 'stop',
    }));
    await generateWithProgress();
    expect(mocks.persistClassroom.mock.calls[0][0].scenes[0].content.html).toContain(
      'Amplitude is 1.',
    );
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(1);
    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(2);
    expect(mocks.resolveModel).toHaveBeenCalledWith({ stage: 'classroom-review' });
  });

  it('does not persist a material error or multiply the single quality repair', async () => {
    mocks.generateSceneContent.mockResolvedValue({
      html: '<html><head></head><body><p id="value">Value.</p></body></html>',
      htmlPresentation: true,
    });
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify({
        checks: ['The explanation is incorrect.'],
        resolutions: [
          { issueIndex: 0, fixed: false, evidence: 'The narration is still incorrect.' },
        ],
        issues: [
          {
            severity: 'blocking',
            confidence: 'high',
            target: 'actions',
            evidence: 'The narration is incorrect.',
            correction: 'Explain the correct value.',
          },
        ],
      }),
      finishReason: 'stop',
    });
    await expect(generateWithProgress()).rejects.toMatchObject({
      name: 'ClassroomQualityError',
      isRetryable: false,
    });
    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(2);
    expect(mocks.createSceneWithActions).not.toHaveBeenCalled();
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('does not multiply exhausted HTML syntax repair or persist a failed page in the one-shot path', async () => {
    const { generateHtmlClassroomPage } = await vi.importActual<
      typeof import('@/lib/livecourse/lesson/html-presentation')
    >('@/lib/livecourse/lesson/html-presentation');
    mocks.callLLM.mockResolvedValue({
      text: '<html><head></head><body><p>Retries</p><script>const data = {;</script></body></html>',
    });
    mocks.generateSceneContent.mockImplementation((sceneOutline, aiCall, options) =>
      generateHtmlClassroomPage(sceneOutline, aiCall, { presentation: options.presentation }),
    );
    await expect(generateWithProgress()).rejects.toMatchObject({
      name: 'ClassroomHtmlGenerationError',
      isRetryable: false,
      message: expect.stringContaining('syntax repair failed'),
    });
    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(1);
    expect(mocks.generateSceneActions).not.toHaveBeenCalled();
    expect(mocks.createSceneWithActions).not.toHaveBeenCalled();
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('forwards classroom thinking config to scene retry LLM calls', async () => {
    const thinkingConfig = { enabled: true, effort: 'high' };
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
      thinkingConfig,
    });
    mocks.generateSceneContent.mockImplementation(async (_outline, aiCall) => {
      await aiCall('system', 'user');
      return slideContent;
    });

    await generateWithProgress();

    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0 }),
      'generate-classroom-scene',
      undefined,
      { mode: 'disabled', enabled: false },
    );
  });

  it('retries retryable action generation errors', async () => {
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateSceneActions
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { statusCode: 429 }))
      .mockResolvedValueOnce([]);

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(1);
    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(2);
    expect(progress.some((event) => event.message.includes('Retrying scene 1/1 actions'))).toBe(
      true,
    );
  }, 15_000); // Retries use a real backoff delay; under full-suite worker load, the default 5s timeout flakes

  it.each([undefined, { mode: 'disabled' }, { mode: 'enabled', effort: 'high' }])(
    'uses the scene-actions route and its reasoning configuration for HTML narration (%j)',
    async (thinkingConfig) => {
      const model = { id: 'narration-model' };
      mocks.getStageModel.mockImplementation((stage) =>
        stage === 'scene-actions' ? 'test:narration' : undefined,
      );
      mocks.resolveModel.mockImplementation(async ({ stage }) => ({
        model: stage === 'scene-actions' ? model : { id: 'default-model' },
        modelInfo: { outputWindow: 32768 },
        modelString: stage === 'scene-actions' ? 'test:narration' : 'test:default',
        providerId: 'test',
        apiKey: '',
        thinkingConfig: stage === 'scene-actions' ? thinkingConfig : undefined,
      }));
      mocks.generateSceneContent.mockResolvedValue(slideContent);
      mocks.generateSceneActions.mockImplementation(async (_outline, _content, aiCall) => {
        expect(await aiCall('narration system', 'narration prompt')).toBe('ok');
        return [];
      });

      await generateWithProgress();

      expect(mocks.callLLM).toHaveBeenCalledWith(
        expect.objectContaining({ model, maxOutputTokens: 32768 }),
        'generate-classroom-scene',
        { mode: 'disabled', enabled: false },
      );
    },
  );

  it.each([
    { text: '', reasoningText: 'Not a final answer', finishReason: 'stop' },
    { text: '[]', finishReason: 'length' },
  ])('does not persist empty or truncated narration (%j)', async (result) => {
    mocks.callLLM.mockResolvedValue(result);
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateSceneActions.mockImplementation(async (_outline, _content, aiCall) => {
      await aiCall('system', 'prompt');
      return [];
    });
    await expect(generateWithProgress()).rejects.toThrow(/final answer|truncated/);
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('persists the designed lesson plan with the classroom file', async () => {
    const lessonPlan = {
      schemaVersion: 1,
      id: 'lesson-plan:classroom',
      courseId: 'course-1',
      stageId: 'stage-1',
      title: 'Retry Basics',
      version: 1,
      status: 'approved' as const,
      createdAt: '2026-09-14T00:00:00.000Z',
      presentation: { mode: 'html', visualStyle: 'Ink diagrams on warm paper.' },
      goals: [],
      nodes: [
        {
          id: 'node:outline-1',
          sceneId: 'outline-1',
          title: 'Retry Basics',
          type: 'instruction' as const,
          order: 0,
          goalIds: [],
          design: {
            teachingPoints: ['Retry transient failures'],
            explanationPlan: 'Show the failure, then the retry.',
            anticipatedQuestions: [
              { question: 'When to retry?', response: 'Only transient errors.' },
            ],
          },
        },
      ],
    };
    mocks.designLessonPlanWithSubagents.mockResolvedValue(lessonPlan);
    mocks.generateSceneContent.mockResolvedValue(slideContent);

    await generateWithProgress();

    expect(mocks.persistClassroom).toHaveBeenCalledWith(
      expect.objectContaining({ lessonPlan }),
      'http://localhost',
    );
    expect(mocks.generateSceneContent).toHaveBeenCalledWith(
      expect.objectContaining({ id: outline.id }),
      expect.any(Function),
      expect.objectContaining({ presentation: lessonPlan.presentation }),
    );
    expect(mocks.applyOutlineFallbacks).not.toHaveBeenCalled();
  });

  it('does not complete a new HTML course by silently skipping a failed page', async () => {
    mocks.designLessonPlanWithSubagents.mockResolvedValue({
      ...buildLessonPlanSkeleton({
        stageId: 'stage-1',
        requirement: 'Teach retry basics',
        outlines: [{ ...outline, keyPoints: [...outline.keyPoints] }],
      }),
      presentation: { mode: 'html', visualStyle: 'Ink diagrams on warm paper.' },
    });
    mocks.generateSceneContent.mockRejectedValue(new PBLGenerationErrorMock('Unusable HTML page'));
    await expect(generateWithProgress()).rejects.toThrow('Failed to generate HTML page');
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('uses the independently routed lesson model and reasoning for both main design and workers', async () => {
    const lessonModel = { id: 'reasoning-lesson-model' };
    const thinking = { mode: 'enabled', effort: 'high' };
    mocks.getStageModel.mockImplementation((stage) =>
      stage === 'lesson-plan' ? 'test:reasoning' : undefined,
    );
    mocks.resolveModel.mockImplementation(async ({ stage }) => ({
      model: stage === 'lesson-plan' ? lessonModel : { id: 'fast-model' },
      modelInfo: { outputWindow: 8192 },
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
      thinkingConfig: stage === 'lesson-plan' ? thinking : undefined,
    }));
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    await generateWithProgress();
    expect(mocks.resolveModel).toHaveBeenCalledWith({ stage: 'lesson-plan' });
    const [, runtime, designCall] = mocks.designLessonPlanWithSubagents.mock.calls[0];
    expect(runtime).toEqual({
      languageModel: lessonModel,
      thinkingConfig: thinking,
      maxOutputTokens: 8192,
    });
    await designCall('design system', 'design prompt');
    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        model: lessonModel,
        system: 'design system',
        prompt: 'design prompt',
      }),
      'lesson-plan',
      thinking,
    );
  });

  it('fails visibly when an explicitly configured lesson route cannot resolve', async () => {
    const failure = new Error('Lesson model not configured');
    mocks.getStageModel.mockImplementation((stage) =>
      stage === 'lesson-plan' ? 'test:missing' : undefined,
    );
    mocks.resolveModel.mockImplementation(async ({ stage }) => {
      if (stage === 'lesson-plan') throw failure;
      return {
        model: {},
        modelInfo: {},
        modelString: 'test:model',
        providerId: 'test',
        apiKey: '',
      };
    });
    await expect(generateWithProgress()).rejects.toBe(failure);
    expect(mocks.designLessonPlanWithSubagents).not.toHaveBeenCalled();
    expect(mocks.generateSceneContent).not.toHaveBeenCalled();
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });
  it('does not retry non-retryable action generation errors', async () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateSceneActions.mockRejectedValue(unauthorized);

    await expect(generateWithProgress()).rejects.toBe(unauthorized);

    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(1);
  });

  it('converts only PBLGenerationError to a null scene result', async () => {
    const { containPBLGenerationError } = await import('@/lib/server/classroom-generation');

    expect(
      containPBLGenerationError(
        new PBLGenerationErrorMock('both planners failed'),
        'Failed PBL scene',
      ),
    ).toBeNull();

    const unrelated = new Error('unrelated failure');
    expect(() => containPBLGenerationError(unrelated, 'Other scene')).toThrow(unrelated);
  });

  it('does not retry a status-less PBL failure and completes surrounding slides', async () => {
    const outlines = [
      { ...outline, id: 'outline-slide-1', title: 'Opening slide', order: 0 },
      {
        ...outline,
        id: 'outline-pbl',
        type: 'pbl' as const,
        title: 'Practice project',
        order: 1,
        pblConfig: {
          projectTopic: 'Retries',
          projectDescription: 'Practice resilient generation',
          targetSkills: ['Retry handling'],
        },
      },
      { ...outline, id: 'outline-slide-2', title: 'Closing slide', order: 2 },
    ];
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Use English.', outlines },
    });
    mocks.generateSceneContent.mockImplementation(async (sceneOutline) => {
      if (sceneOutline.type === 'pbl') {
        throw new PBLGenerationErrorMock('both planners failed');
      }
      return slideContent;
    });

    await expect(generateWithProgress()).rejects.toThrow('Failed to generate HTML page');
  });

  it('does not retry a 401 PBL failure and completes surrounding slides', async () => {
    const outlines = [
      { ...outline, id: 'outline-slide-1', title: 'Opening slide', order: 0 },
      {
        ...outline,
        id: 'outline-pbl',
        type: 'pbl' as const,
        title: 'Practice project',
        order: 1,
        pblConfig: {
          projectTopic: 'Retries',
          projectDescription: 'Practice resilient generation',
          targetSkills: ['Retry handling'],
        },
      },
      { ...outline, id: 'outline-slide-2', title: 'Closing slide', order: 2 },
    ];
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Use English.', outlines },
    });
    mocks.generateSceneContent.mockImplementation(async (sceneOutline) => {
      if (sceneOutline.type === 'pbl') {
        throw new PBLGenerationErrorMock('provider key rejected', { statusCode: 401 });
      }
      return slideContent;
    });

    await expect(generateWithProgress()).rejects.toThrow('Failed to generate HTML page');
  });

  it('retries a 429 PBL failure before skipping it and completing surrounding slides', async () => {
    vi.useFakeTimers();
    try {
      const outlines = [
        { ...outline, id: 'outline-slide-1', title: 'Opening slide', order: 0 },
        {
          ...outline,
          id: 'outline-pbl',
          type: 'pbl' as const,
          title: 'Practice project',
          order: 1,
          pblConfig: {
            projectTopic: 'Retries',
            projectDescription: 'Practice resilient generation',
            targetSkills: ['Retry handling'],
          },
        },
        { ...outline, id: 'outline-slide-2', title: 'Closing slide', order: 2 },
      ];
      mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
        success: true,
        data: { languageDirective: 'Use English.', outlines },
      });
      mocks.generateSceneContent.mockImplementation(async (sceneOutline) => {
        if (sceneOutline.type === 'pbl') {
          throw new PBLGenerationErrorMock('provider rate limited', { statusCode: 429 });
        }
        return slideContent;
      });

      const generation = generateWithProgress();
      const assertion = expect(generation).rejects.toThrow('Failed to generate HTML page');
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

import { createOpenAI } from '@ai-sdk/openai';
import { describe, expect, it, vi } from 'vitest';
import {
  ClassroomHtmlParseError,
  designHtmlLessonPlan,
  generateHtmlClassroomPage,
  parseClassroomHtml,
} from '@/lib/livecourse/lesson/html-presentation';
import { isRetryableGenerationError, withGenerationRetry } from '@/lib/generation/generation-retry';
import {
  ClassroomHtmlGenerationError,
  ClassroomHtmlSyntaxError,
  validateClassroomHtmlSyntax,
} from '@/lib/livecourse/html/syntax-validator';
import { lessonPlanSchema, type LessonPresentation } from '@/lib/livecourse/domain/schemas';
import {
  generateSceneContent,
  generateSceneActions,
  createSceneWithActions,
} from '@/lib/generation/scene-generator';
import { buildCompleteScene } from '@/lib/generation/scene-builder';
import { createStageAPI } from '@/lib/api/stage-api';
import { attachHtmlTeacherBridge } from '@/lib/livecourse/html/teacher-bridge';
import { patchQuizHtml } from '@/lib/livecourse/html/quiz-bridge';
import * as teacherBridge from '@/lib/livecourse/html/teacher-bridge';
import * as quizBridge from '@/lib/livecourse/html/quiz-bridge';
import * as mathProcessor from '@/lib/generation/interactive-post-processor';
import * as iframePatch from '@/lib/utils/iframe';
import type { StageStore } from '@/lib/api/stage-api-types';
import type { SceneOutline } from '@/lib/types/generation';

const outline: SceneOutline = {
  id: 'intro',
  type: 'slide',
  title: 'The slope of a curve',
  description: 'Explain how a secant approaches a tangent.',
  keyPoints: ['Secant slope', 'Tangent slope'],
  order: 0,
};
const html =
  '<!DOCTYPE html><html><head><style>body{background:#f8f3e8}</style></head><body><svg id="slope"></svg><p>A secant approaches the tangent.</p><script>const x = 1;</script></body></html>';
const presentation: LessonPresentation = {
  mode: 'html',
  visualStyle:
    'Warm editorial paper, ink typography and teal mathematical diagrams; --accent: #087f83.',
};
const teachingBrief = {
  throughline:
    'Use the same moving secant to build the tangent definition; keep notation consistent.',
  estimatedDurationSeconds: 180,
};
const direction = { visualStyle: presentation.visualStyle, teachingBrief };
const runtime = { languageModel: createOpenAI({ apiKey: 'unused' }).chat('test-model') };
const reviewCall = async () => JSON.stringify({ checks: ['Teaching verified.'], issues: [] });
const design = {
  teachingPoints: ['Explain the limiting secant.'],
  explanationPlan: 'Animate the slope, then derive it.',
};
const input = {
  stageId: 'stage',
  courseId: 'course',
  requirement: 'Teach derivatives visually.',
  languageDirective: 'English',
  outlines: [outline],
  now: '2026-09-14T00:00:00.000Z',
};

describe('main-agent HTML visual direction', () => {
  it('routes factual plan repair to the independently configured reviewer rather than the original author', async () => {
    const corrected = {
      ...design,
      teachingPoints: ['The secant slope tends to the tangent slope.'],
    };
    const author = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(direction))
      .mockResolvedValueOnce(JSON.stringify({ nodes: [{ sceneId: outline.id, design }] }));
    const reviewer = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          checks: ['The limiting slope is the derivative.'],
          issues: [
            {
              severity: 'blocking',
              confidence: 'high',
              target: 'node',
              sceneId: outline.id,
              evidence: 'Incorrect definition.',
              correction: 'State the correct limiting slope.',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ nodes: [{ sceneId: outline.id, design: corrected }] }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          checks: ['The definition is fixed.'],
          resolutions: [{ issueIndex: 0, fixed: true, evidence: 'Correct limit definition.' }],
          regressions: [],
        }),
      );
    const plan = await designHtmlLessonPlan(input, runtime, author, reviewer);
    expect(plan.nodes[0].design).toEqual(corrected);
    expect(author).toHaveBeenCalledTimes(2);
    expect(reviewer).toHaveBeenCalledTimes(3);
    expect(reviewer.mock.calls[1][0]).toContain('Correct only the specified teaching errors');
  });

  it('decides one shared style before node workers and persists it in the plan', async () => {
    const plannedDesign = {
      ...design,
      oralQuestion: {
        question: 'Why does the rate change?',
        guidance: 'Consider the local slope.',
      },
    };
    const aiCall = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(direction))
      .mockResolvedValueOnce(
        JSON.stringify({ nodes: [{ sceneId: outline.id, design: plannedDesign }] }),
      );
    const plan = await designHtmlLessonPlan(input, runtime, aiCall, reviewCall);
    expect(aiCall).toHaveBeenCalledTimes(2);
    expect(aiCall.mock.calls[0][0]).toContain('main agent');
    expect(aiCall.mock.calls[0][0]).toContain('coverPrompt');
    expect(aiCall.mock.calls[1][1]).toContain(presentation.visualStyle);
    expect(plan.presentation).toEqual(presentation);
    expect(plan.teachingBrief).toEqual(teachingBrief);
    expect(plan.nodes[0].design).toEqual(plannedDesign);
    expect(lessonPlanSchema.parse(JSON.parse(JSON.stringify(plan))).nodes[0].design).toEqual(
      plannedDesign,
    );
    expect(lessonPlanSchema.parse(JSON.parse(JSON.stringify(plan))).presentation).toEqual(
      presentation,
    );
  });

  it('rejects an incomplete node design instead of shipping a styled skeleton', async () => {
    const aiCall = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(direction))
      .mockResolvedValueOnce('not a lesson plan');
    await expect(designHtmlLessonPlan(input, runtime, aiCall, reviewCall)).rejects.toThrow(
      'Lesson design incomplete: intro',
    );
    expect(aiCall).toHaveBeenCalledTimes(2);
  });

  it('fails before node generation when the main style is absent or invalid', async () => {
    const aiCall = vi.fn().mockResolvedValue('{}');
    await expect(designHtmlLessonPlan(input, runtime, aiCall, reviewCall)).rejects.toThrow();
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it('persists a cover prompt from the visual-direction JSON', async () => {
    const aiCall = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          visualStyle: presentation.visualStyle,
          teachingBrief,
          coverPrompt: 'A 16:9 teal waveform over warm paper.',
        }),
      )
      .mockResolvedValueOnce(JSON.stringify({ nodes: [{ sceneId: outline.id, design }] }));
    const plan = await designHtmlLessonPlan(input, runtime, aiCall, reviewCall);
    expect(plan.presentation).toEqual({
      ...presentation,
      coverPrompt: 'A 16:9 teal waveform over warm paper.',
    });
  });

  it('keeps visual direction when coverPrompt is missing or not a string', async () => {
    const aiCall = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ ...direction, coverPrompt: 3 }))
      .mockResolvedValueOnce(JSON.stringify({ nodes: [{ sceneId: outline.id, design }] }));
    const plan = await designHtmlLessonPlan(input, runtime, aiCall, reviewCall);
    expect(plan.presentation).toEqual(presentation);
  });

  it('accepts complete teaching design without an estimated duration', async () => {
    const brief = { throughline: teachingBrief.throughline };
    const aiCall = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ ...direction, teachingBrief: brief }))
      .mockResolvedValueOnce(JSON.stringify({ nodes: [{ sceneId: outline.id, design }] }));
    const plan = await designHtmlLessonPlan(input, runtime, aiCall, reviewCall);
    expect(plan.teachingBrief).toEqual(brief);
    expect(plan.nodes[0].design).toEqual(design);
    expect(aiCall).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, {}, { throughline: 'A plan', estimatedDurationSeconds: 0 }])(
    'requires a valid course teaching brief before starting node workers (%j)',
    async (invalidBrief) => {
      const aiCall = vi.fn().mockResolvedValue(
        JSON.stringify({
          visualStyle: presentation.visualStyle,
          teachingBrief: invalidBrief,
        }),
      );
      await expect(designHtmlLessonPlan(input, runtime, aiCall, reviewCall)).rejects.toThrow();
      expect(aiCall).toHaveBeenCalledTimes(1);
    },
  );
});

describe('quality-first classroom narration', () => {
  const output = (text: string) =>
    JSON.stringify([
      { type: 'action', name: 'widget_highlight', params: { target: '#slope' } },
      { type: 'text', content: text },
    ]);

  it('shares the design without imposing a time or word quota', async () => {
    const text = '变化'.repeat(2000);
    const aiCall = vi.fn().mockResolvedValue(output(text));
    const actions = await generateSceneActions(outline, { html, htmlPresentation: true }, aiCall, {
      lessonNodeDesign: design,
    });
    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(aiCall.mock.calls[0][1]).toContain(design.explanationPlan);
    expect(aiCall.mock.calls[0][0]).toContain('cannot click, drag or set control values');
    expect(aiCall.mock.calls[0][0]).toContain('Do not shorten essential');
    expect(aiCall.mock.calls[0][1]).not.toContain('Node time budget:');
    expect(actions.at(-1)).toMatchObject({ text });
  });

  it('keeps old lessons readable and does not truncate narration', async () => {
    const text = '变化'.repeat(200);
    const aiCall = vi.fn().mockResolvedValue(output(text));
    const actions = await generateSceneActions(outline, { html, htmlPresentation: true }, aiCall, {
      lessonNodeDesign: design,
    });
    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(actions.at(-1)).toMatchObject({ text });
  });

  it('uses HTML teaching actions for checkpoint pages instead of the default quiz speech', async () => {
    const quizOutline: SceneOutline = { ...outline, type: 'quiz' };
    const text = 'Look at the given options.';
    const aiCall = vi.fn().mockResolvedValue(output(text));
    const actions = await generateSceneActions(
      quizOutline,
      { html, questions: [], htmlPresentation: true },
      aiCall,
      { lessonNodeDesign: design },
    );
    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(actions.map((action) => action.type)).toContain('speech');
    expect(actions.some((action) => 'text' in action && action.text.includes('小测验'))).toBe(
      false,
    );
  });
});

describe('model-authored classroom pages', () => {
  it('rejects invalid oral metadata before generation and requires narration after the trigger', async () => {
    const oralQuestion = {
      question: 'Why does the rate change?',
      guidance: 'Reason about the slope.',
    };
    const content = await generateSceneContent(outline, vi.fn().mockResolvedValue(html), {
      presentation,
      lessonNodeDesign: { ...design, oralQuestion },
    });
    if (!content || !('htmlPresentation' in content)) throw new Error('Expected an HTML lesson');
    const aiCall = vi.fn().mockResolvedValue(
      JSON.stringify([
        { type: 'action', name: 'widget_highlight', params: { target: '#slope' } },
        { type: 'text', content: 'Only one sentence.' },
      ]),
    );
    await expect(generateSceneActions(outline, content, aiCall)).rejects.toMatchObject({
      isRetryable: true,
    });
    aiCall.mockClear();
    await expect(
      generateSceneActions(
        outline,
        { ...content, oralQuestion: { ...oralQuestion, question: '' } },
        aiCall,
      ),
    ).rejects.toThrow();
    expect(aiCall).not.toHaveBeenCalled();
  });
  it('preserves a planned oral question and binds it to one middle narration beat', async () => {
    const oralQuestion = {
      question: 'Why does the slope change?',
      guidance: 'Look at the local rate.',
    };
    const content = await generateSceneContent(outline, vi.fn().mockResolvedValue(html), {
      presentation,
      lessonNodeDesign: { ...design, oralQuestion },
    });
    expect(content).toMatchObject({ oralQuestion });
    const aiCall = vi.fn().mockResolvedValue(
      JSON.stringify(
        ['first', 'second', 'third', 'fourth'].flatMap((text) => [
          { type: 'action', name: 'widget_highlight', params: { target: '#slope' } },
          { type: 'text', content: text },
        ]),
      ),
    );
    const actions = await generateSceneActions(outline, content!, aiCall);
    const speeches = actions.filter((action) => action.type === 'speech');
    expect(speeches.map((action) => action.oralQuestion)).toEqual([
      undefined,
      oralQuestion,
      undefined,
      undefined,
    ]);
    expect(aiCall.mock.calls[0][1]).toContain(oralQuestion.question);
    expect(aiCall.mock.calls[0][1]).not.toContain(oralQuestion.guidance);
    const saved = buildCompleteScene(outline, content!, actions, 'stage');
    expect(saved?.actions).toEqual(actions);
    expect(
      JSON.parse(JSON.stringify(saved)).actions.filter(
        (action: { type: string }) => action.type === 'speech',
      )[1],
    ).toMatchObject({ oralQuestion });
  });
  it('persists HTML in the server scene constructor for lecture and checkpoint pages', () => {
    const state: ReturnType<StageStore['getState']> = {
      stage: { id: 'stage', name: 'Derivatives', createdAt: 1, updatedAt: 1 },
      scenes: [],
      currentSceneId: null,
      mode: 'playback',
    };
    const api = createStageAPI({
      getState: () => state,
      setState: (partial) => Object.assign(state, partial),
      subscribe: () => () => {},
    });
    const oralSpeech = {
      id: 'oral-speech',
      type: 'speech' as const,
      text: 'A local rate.',
      oralQuestion: { question: 'Why?', guidance: 'Consider local changes.' },
    };
    expect(
      createSceneWithActions(outline, { html, htmlPresentation: true }, [oralSpeech], api),
    ).toBeTruthy();
    expect(state.scenes[0].actions).toEqual([oralSpeech]);
    expect(
      createSceneWithActions(
        { ...outline, id: 'check', type: 'quiz' },
        { html, questions: [] },
        [],
        api,
      ),
    ).toBeTruthy();
    expect(state.scenes.map((scene) => scene.type)).toEqual(['interactive', 'quiz']);
    expect(state.scenes.map((scene) => scene.content)).toEqual([
      expect.objectContaining({ html }),
      expect.objectContaining({ html, questions: [] }),
    ]);
  });

  it.each(['slide', 'interactive', 'pbl'] as const)(
    'renders %s intent as unrestricted HTML, not a widget template',
    async (type) => {
      const aiCall = vi.fn().mockResolvedValue(html);
      const content = await generateSceneContent({ ...outline, type }, aiCall, {
        presentation,
        lessonNodeDesign: design,
        languageDirective: 'English',
      });
      expect(content).toEqual({ html: attachHtmlTeacherBridge(html), htmlPresentation: true });
      expect(aiCall).toHaveBeenCalledTimes(1);
      expect(aiCall.mock.calls[0][0]).toContain('not filling a slide template');
      expect(aiCall.mock.calls[0][0]).toContain('Do not add recap footers');
      expect(aiCall.mock.calls[0][1]).toContain(presentation.visualStyle);
      expect(aiCall.mock.calls[0][1]).toContain(design.teachingPoints[0]);
      const scene = content && buildCompleteScene({ ...outline, type }, content, [], 'stage');
      expect(scene?.type).toBe('interactive');
      expect(scene?.content).toMatchObject({ html: attachHtmlTeacherBridge(html) });
      expect(scene?.outlineId).toBe(outline.id);
    },
  );

  it('keeps checkpoint questions authoritative and generates their HTML with no answer key', async () => {
    const question = {
      id: 'q1',
      type: 'single',
      question: 'What does slope measure?',
      options: [
        { value: 'A', label: 'Rate of change' },
        { value: 'B', label: 'Area' },
      ],
      answer: ['A'],
      analysis: 'A unique secret grading explanation.',
    };
    const aiCall = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify([question]))
      .mockResolvedValueOnce(html);
    const quizOutline: SceneOutline = { ...outline, type: 'quiz' };
    const content = await generateSceneContent(quizOutline, aiCall, {
      presentation,
      lessonNodeDesign: design,
    });
    expect(content).toMatchObject({ html, questions: [question], htmlPresentation: true });
    expect(aiCall.mock.calls[0][1]).toContain(design.teachingPoints[0]);
    const [system, user] = aiCall.mock.calls[1];
    expect(system).toContain('window.livecourseQuiz.setAnswer');
    expect(system).toContain('livecourse:quiz-state');
    expect(system).toContain('scroll inside the iframe');
    expect(user).not.toContain(question.analysis);
    expect(user).not.toContain('"answer"');
    expect(user).not.toContain(design.teachingPoints[0]);
    expect(user).not.toContain(design.explanationPlan);
    expect(system).toContain('Do not preload solutions');
    expect(system).toContain('results is an ARRAY');
    expect(system).toContain('state.results.find');
    expect(system).toContain('!state.readOnly');
    expect(system).toContain('result.answer is the CORRECT ANSWER KEY');
    const scene = content && buildCompleteScene(quizOutline, content, [], 'stage');
    expect(scene?.type).toBe('quiz');
    expect(scene?.content).toMatchObject({ html, questions: [question] });
  });

  it('fails a page instead of replacing bad HTML or an empty checkpoint with a fixed template', async () => {
    await expect(
      generateSceneContent(outline, vi.fn().mockResolvedValue('<div>fragment</div>'), {
        presentation,
      }),
    ).rejects.toThrow('complete HTML');
    await expect(
      generateSceneContent({ ...outline, type: 'quiz' }, vi.fn().mockResolvedValue('[]'), {
        presentation,
      }),
    ).rejects.toThrow('No checkpoint questions');
  });

  it('passes supplied media through and does not inject a CDN into non-mathematical pages', async () => {
    const aiCall = vi.fn().mockResolvedValue(html);
    const page = await generateHtmlClassroomPage(
      {
        ...outline,
        mediaGenerations: [
          { type: 'image', elementId: 'lesson_img_intro_1', prompt: 'A secant diagram' },
        ],
      },
      aiCall,
      {
        presentation,
        assignedImages: [{ id: 'pdf1', src: '', pageNumber: 1 }],
        imageMapping: { pdf1: 'data:image/png;base64,AAAA' },
      },
    );
    expect(aiCall.mock.calls[0][1]).toContain('lesson_img_intro_1');
    expect(aiCall.mock.calls[0][1]).toContain('data:image/png;base64,AAAA');
    expect(page).not.toContain('cdn.jsdelivr');
  });

  it('teaches the actual HTML rather than generating a generic widget introduction', async () => {
    const aiCall = vi.fn().mockResolvedValue(
      JSON.stringify([
        { type: 'action', name: 'widget_highlight', params: { target: '#slope' } },
        { type: 'text', content: 'The secant slope approaches the tangent slope.' },
      ]),
    );
    const actions = await generateSceneActions(outline, { html, htmlPresentation: true }, aiCall);
    expect(aiCall.mock.calls[0][1]).toContain(html);
    expect(aiCall.mock.calls[0][0]).not.toContain('3-8');
    expect(actions.some((action) => action.type === 'speech')).toBe(true);
    expect(actions.map((action) => action.type)).toEqual(['widget_highlight', 'speech']);
    await expect(
      generateSceneActions(
        outline,
        { html, htmlPresentation: true },
        vi.fn().mockResolvedValue('[]'),
      ),
    ).rejects.toThrow('No teacher narration');
  });

  it('interleaves real visual targets with every teaching beat', async () => {
    const page = html.replace('<p>', '<p id="example" hidden>');
    const aiCall = vi.fn().mockResolvedValue(
      JSON.stringify([
        { type: 'action', name: 'widget_highlight', params: { target: '#slope' } },
        { type: 'text', content: 'Start with the secant.' },
        { type: 'action', name: 'widget_reveal', params: { target: '#example' } },
        { type: 'action', name: 'widget_highlight', params: { target: '#example' } },
        { type: 'text', content: 'Now take the limit.' },
      ]),
    );
    const actions = await generateSceneActions(
      outline,
      { html: page, htmlPresentation: true },
      aiCall,
    );
    expect(actions.map((action) => action.type)).toEqual([
      'widget_highlight',
      'speech',
      'widget_reveal',
      'widget_highlight',
      'speech',
    ]);
    expect(aiCall.mock.calls[0][0]).toContain('BEFORE EVERY');
    expect(aiCall.mock.calls[0][1]).toContain('Real element inventory:');
    expect(aiCall.mock.calls[0][1]).toContain('#example <p>');
  });

  it('recovers class-only lab selectors onto a real teaching id instead of failing generation', async () => {
    const actions = await generateSceneActions(
      outline,
      { html, htmlPresentation: true },
      vi.fn().mockResolvedValue(
        JSON.stringify([
          { type: 'action', name: 'widget_highlight', params: { target: '.trace' } },
          { type: 'text', content: 'Watch the trace.' },
          {
            type: 'action',
            name: 'widget_highlight',
            params: { target: '.trace-line.tl-1' },
          },
          { type: 'text', content: 'Then the first line.' },
        ]),
      ),
    );
    expect(actions.map((action) => ('target' in action ? action.target : action.type))).toEqual([
      '#slope',
      'speech',
      '#slope',
      'speech',
    ]);
  });

  it('inserts a highlight before speech that arrived without a visual cue', async () => {
    const actions = await generateSceneActions(
      outline,
      { html, htmlPresentation: true },
      vi
        .fn()
        .mockResolvedValue(
          JSON.stringify([{ type: 'text', content: 'Speech without a visual cue.' }]),
        ),
    );
    expect(actions.map((action) => action.type)).toEqual(['widget_highlight', 'speech']);
    expect(actions[0]).toMatchObject({ type: 'widget_highlight', target: '#slope' });
  });

  it('still fails when the page has no narration at all', async () => {
    await expect(
      generateSceneActions(
        outline,
        { html, htmlPresentation: true },
        vi
          .fn()
          .mockResolvedValue(
            JSON.stringify([
              { type: 'action', name: 'widget_highlight', params: { target: '#slope' } },
            ]),
          ),
      ),
    ).rejects.toMatchObject({ name: 'ClassroomHtmlActionsError', isRetryable: true });
  });

  it('keeps a highlight until the next focus so consecutive narration beats stay valid', async () => {
    const actions = await generateSceneActions(
      outline,
      { html, htmlPresentation: true },
      vi.fn().mockResolvedValue(
        JSON.stringify([
          { type: 'action', name: 'widget_highlight', params: { target: '#slope' } },
          { type: 'text', content: 'First beat.' },
          { type: 'text', content: 'The highlight remains on the same region.' },
        ]),
      ),
    );
    expect(actions.map((action) => action.type)).toEqual(['widget_highlight', 'speech', 'speech']);
  });

  it('maps class and descendant selectors onto the real teaching id', async () => {
    const page =
      '<!DOCTYPE html><html><body><div id="scene-draw" class="wave-frame formula-stage"><span class="label-legend">A</span></div></body></html>';
    const actions = await generateSceneActions(
      outline,
      { html: page, htmlPresentation: true },
      vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            type: 'action',
            name: 'widget_highlight',
            params: { target: '#scene-draw .wave-frame' },
          },
          { type: 'text', content: 'Read the waveform.' },
          { type: 'action', name: 'widget_highlight', params: { target: '.formula-stage' } },
          { type: 'text', content: 'Then the formula.' },
        ]),
      ),
    );
    expect(actions.map((action) => ('target' in action ? action.target : action.type))).toEqual([
      '#scene-draw',
      'speech',
      '#scene-draw',
      'speech',
    ]);
  });

  it('drops a visual action with no target instead of failing the page', async () => {
    const actions = await generateSceneActions(
      outline,
      { html, htmlPresentation: true },
      vi.fn().mockResolvedValue(
        JSON.stringify([
          { type: 'action', name: 'widget_highlight', params: {} },
          { type: 'action', name: 'widget_highlight', params: { target: '#slope' } },
          { type: 'text', content: 'Teach the slope.' },
        ]),
      ),
    );
    expect(actions.map((action) => action.type)).toEqual(['widget_highlight', 'speech']);
  });

  it('does not treat script-only ids as teaching regions; remaps them to a real id', async () => {
    const page = html.replace(
      '</body>',
      '<!-- <p id="fake"> -->' +
        '<script>const markup = \'<div id="fake"></div>\';</script></body>',
    );
    const actions = await generateSceneActions(
      outline,
      { html: page, htmlPresentation: true },
      vi.fn().mockResolvedValue(
        JSON.stringify([
          { type: 'action', name: 'widget_highlight', params: { target: '#fake' } },
          { type: 'text', content: 'Not a real teaching region.' },
        ]),
      ),
    );
    expect(actions.map((action) => ('target' in action ? action.target : action.type))).toEqual([
      '#slope',
      'speech',
    ]);
  });

  it('accepts a fenced complete document, but rejects truncated and empty pages', () => {
    expect(parseClassroomHtml(`\`\`\`html\n${html}\n\`\`\``)).toBe(html);
    expect(parseClassroomHtml(html.replace(/<\/?[a-z]+/g, (tag) => tag.toUpperCase()))).toContain(
      '<HTML>',
    );
    expect(parseClassroomHtml(html.replace('</html>', ''))).toBe(html);
    expect(parseClassroomHtml(`${html.replace('</body></html>', '')}<p>more</p>`)).toContain(
      '</html>',
    );
    expect(parseClassroomHtml(`${html}\nThanks`)).toBe(html);
    expect(() => parseClassroomHtml('<html><head></head><body> </body></html>')).toThrow(
      ClassroomHtmlParseError,
    );
    expect(() => parseClassroomHtml('<p>not a document</p>')).toThrow(ClassroomHtmlParseError);
    expect(isRetryableGenerationError(new ClassroomHtmlParseError())).toBe(true);
  });

  describe('bounded classroom HTML syntax repair', () => {
    const invalidHtml = html.replace('const x = 1;', 'const x = { value: 1;');
    const question = {
      id: 'q1',
      type: 'single' as const,
      question: 'What does slope measure?',
      options: [
        { value: 'A', label: 'Rate of change' },
        { value: 'B', label: 'Area' },
      ],
      answer: ['A'],
      analysis: 'PRIVATE grading explanation',
      commentPrompt: 'PRIVATE grading instructions',
    };

    it('rejects a complete shell with invalid or truncated executable JavaScript', () => {
      expect(() => parseClassroomHtml(invalidHtml)).toThrow(ClassroomHtmlSyntaxError);
      expect(() =>
        parseClassroomHtml(html.replace('const x = 1;</script></body></html>', 'const x = {')),
      ).toThrow(ClassroomHtmlSyntaxError);
    });

    it('does not mistake HTML closing tags in valid JavaScript strings for a shell boundary', () => {
      const quoted = html.replace('const x = 1;', 'const x = "</html>";');
      expect(parseClassroomHtml(quoted)).toBe(quoted);
      expect(parseClassroomHtml(`${quoted}\nThanks`)).toBe(quoted);
      expect(parseClassroomHtml(quoted.replace('</body></html>', ''))).toBe(quoted);
    });

    it('repairs only the current quiz HTML once without regenerating or leaking grading facts', async () => {
      const aiCall = vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify([question]))
        .mockResolvedValueOnce(invalidHtml)
        .mockResolvedValueOnce(html);
      const content = await generateSceneContent({ ...outline, type: 'quiz' }, aiCall, {
        presentation,
        lessonNodeDesign: design,
        languageDirective: 'English only',
      });
      expect(content).toMatchObject({ html, questions: [question] });
      expect(aiCall).toHaveBeenCalledTimes(3);
      const [system, prompt] = aiCall.mock.calls[2];
      expect(system).toContain('Repair ONLY the JavaScript syntax');
      for (const context of [
        invalidHtml,
        presentation.visualStyle,
        outline.id,
        'English only',
        question.id,
        'classic script #1',
        'HTML 1:',
      ]) {
        expect(prompt).toContain(context);
      }
      for (const call of aiCall.mock.calls.slice(1)) {
        expect(call[1]).not.toContain(design.teachingPoints[0]);
        expect(call[1]).not.toContain(design.explanationPlan);
        expect(call[1]).not.toContain('"answer"');
        expect(call[1]).not.toContain(question.analysis);
        expect(call[1]).not.toContain(question.commentPrompt);
      }
      expect(content && 'html' in content && content.html).not.toContain(
        'data-livecourse-quiz-bridge',
      );
    });

    it('does not mutate supplied questions or include unexpected option grading metadata', async () => {
      const supplied = Object.freeze({
        ...question,
        answer: Object.freeze(['A']),
        options: Object.freeze(
          question.options.map((option) =>
            Object.freeze({ ...option, correct: true, analysis: 'PRIVATE option metadata' }),
          ),
        ),
      });
      const questions = Object.freeze([supplied]);
      const before = JSON.stringify(questions);
      const aiCall = vi.fn().mockResolvedValueOnce(invalidHtml).mockResolvedValueOnce(html);
      await generateHtmlClassroomPage(outline, aiCall, {
        presentation,
        questions: questions as unknown as import('@/lib/types/stage').QuizQuestion[],
      });
      expect(JSON.stringify(questions)).toBe(before);
      expect(aiCall.mock.calls.every((call) => !call[1].includes('PRIVATE'))).toBe(true);
      expect(aiCall.mock.calls.every((call) => !call[1].includes('"correct"'))).toBe(true);
    });

    it.each([invalidHtml, '<p>not a repaired document</p>'])(
      'stops deterministic repair failure without multiplying outer retries',
      async (repair) => {
        const aiCall = vi.fn().mockResolvedValueOnce(invalidHtml).mockResolvedValue(repair);
        const operation = vi.fn(() => generateHtmlClassroomPage(outline, aiCall, { presentation }));
        const onRetry = vi.fn();
        await expect(
          withGenerationRetry(operation, {
            label: 'HTML content',
            maxRetries: 5,
            sleep: async () => undefined,
            onRetry,
          }),
        ).rejects.toMatchObject({ name: 'ClassroomHtmlGenerationError', isRetryable: false });
        expect(operation).toHaveBeenCalledTimes(1);
        expect(aiCall).toHaveBeenCalledTimes(2);
        expect(onRetry).not.toHaveBeenCalled();
      },
    );

    it.each([
      new DOMException('Aborted', 'AbortError'),
      Object.assign(new Error('rate limited'), { statusCode: 429 }),
      new TypeError('fetch failed'),
    ])(
      'propagates cancellation and transport errors without requesting syntax repair: %s',
      async (error) => {
        const aiCall = vi.fn().mockRejectedValue(error);
        await expect(generateHtmlClassroomPage(outline, aiCall, { presentation })).rejects.toBe(
          error,
        );
        expect(aiCall).toHaveBeenCalledTimes(1);
        aiCall.mockReset().mockResolvedValueOnce(invalidHtml).mockRejectedValueOnce(error);
        await expect(generateHtmlClassroomPage(outline, aiCall, { presentation })).rejects.toBe(
          error,
        );
        expect(aiCall).toHaveBeenCalledTimes(2);
        expect(error).not.toBeInstanceOf(ClassroomHtmlGenerationError);
      },
    );

    it('keeps math processing and validates raw, teacher and eventual quiz bridge scripts', async () => {
      const mathHtml = html.replace('<p>', () => '<p>$$x^2$$ ');
      for (const questions of [undefined, [question]]) {
        const aiCall = vi.fn().mockResolvedValue(mathHtml);
        const result = await generateHtmlClassroomPage(outline, aiCall, {
          presentation,
          questions,
        });
        expect(result).toContain('katex');
        expect(() => validateClassroomHtmlSyntax(result)).not.toThrow();
        expect(() =>
          validateClassroomHtmlSyntax(
            questions ? patchQuizHtml(result) : iframePatch.patchHtmlForIframe(result),
          ),
        ).not.toThrow();
        expect(result.includes('data-livecourse-quiz-bridge')).toBe(false);
        expect(result.includes('data-livecourse-teacher-bridge')).toBe(!questions);
        expect(aiCall).toHaveBeenCalledTimes(1);
      }
    });

    it.each(['math', 'teacher', 'quiz', 'iframe'] as const)(
      'surfaces trusted %s injection bugs without asking the model to repair them',
      async (phase) => {
        const spy =
          phase === 'math'
            ? vi.spyOn(mathProcessor, 'postProcessInteractiveHtml')
            : phase === 'teacher'
              ? vi.spyOn(teacherBridge, 'attachHtmlTeacherBridge')
              : phase === 'quiz'
                ? vi.spyOn(quizBridge, 'patchQuizHtml')
                : vi.spyOn(iframePatch, 'patchHtmlForIframe');
        spy.mockImplementation((page) =>
          page.replace('</body>', '<script>const broken = ;</script></body>'),
        );
        try {
          const aiCall = vi.fn().mockResolvedValue(html.replace('<p>', () => '<p>$$x^2$$ '));
          await expect(
            generateHtmlClassroomPage(outline, aiCall, {
              presentation,
              questions: phase === 'quiz' ? [question] : undefined,
            }),
          ).rejects.toMatchObject({
            isRetryable: false,
            message: expect.stringContaining('postprocessing introduced invalid JavaScript'),
            cause: expect.any(ClassroomHtmlSyntaxError),
          });
          expect(aiCall).toHaveBeenCalledTimes(1);
        } finally {
          spy.mockRestore();
        }
      },
    );
  });

  it('extracts a complete document from preface, thinking, JSON, or a missing head', () => {
    expect(parseClassroomHtml(`好的，这是完整页面：\n${html}`)).toBe(html);
    expect(parseClassroomHtml(`</think>\n${html}`)).toBe(html);
    expect(parseClassroomHtml(`<think>${html}</think>`)).toBe(html);
    expect(parseClassroomHtml(`Here is the page:\n\`\`\`html\n${html}\n\`\`\`\nThanks.`)).toBe(
      html,
    );
    expect(parseClassroomHtml(JSON.stringify({ html }))).toBe(html);
    expect(
      parseClassroomHtml(
        '<!DOCTYPE html><html lang="zh-CN"><body><h1 id="why">为什么需要傅里叶变换</h1></body></html>',
      ),
    ).toContain('<head></head>');
  });
});

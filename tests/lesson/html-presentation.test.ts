import { createOpenAI } from '@ai-sdk/openai';
import { describe, expect, it, vi } from 'vitest';
import {
  ClassroomHtmlParseError,
  designHtmlLessonPlan,
  generateHtmlClassroomPage,
  parseClassroomHtml,
} from '@/lib/livecourse/lesson/html-presentation';
import { isRetryableGenerationError } from '@/lib/generation/generation-retry';
import { lessonPlanSchema, type LessonPresentation } from '@/lib/livecourse/domain/schemas';
import {
  generateSceneContent,
  generateSceneActions,
  createSceneWithActions,
} from '@/lib/generation/scene-generator';
import { buildCompleteScene } from '@/lib/generation/scene-builder';
import { createStageAPI } from '@/lib/api/stage-api';
import { attachHtmlTeacherBridge } from '@/lib/livecourse/html/teacher-bridge';
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
const runtime = { languageModel: createOpenAI({ apiKey: 'unused' }).chat('test-model') };
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
  it('decides one shared style before node workers and persists it in the plan', async () => {
    const aiCall = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ visualStyle: presentation.visualStyle }))
      .mockResolvedValueOnce(JSON.stringify({ nodes: [{ sceneId: outline.id, design }] }));
    const plan = await designHtmlLessonPlan(input, runtime, aiCall);
    expect(aiCall).toHaveBeenCalledTimes(2);
    expect(aiCall.mock.calls[0][0]).toContain('main agent');
    expect(aiCall.mock.calls[1][1]).toContain(presentation.visualStyle);
    expect(plan.presentation).toEqual(presentation);
    expect(plan.nodes[0].design).toEqual(design);
    expect(lessonPlanSchema.parse(JSON.parse(JSON.stringify(plan))).presentation).toEqual(
      presentation,
    );
  });

  it('retains the main style when node design falls back to the real outline skeleton', async () => {
    const aiCall = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ visualStyle: presentation.visualStyle }))
      .mockResolvedValueOnce('not a lesson plan');
    const plan = await designHtmlLessonPlan(input, runtime, aiCall);
    expect(plan.presentation).toEqual(presentation);
    expect(plan.nodes.map((node) => node.sceneId)).toEqual(['intro']);
    expect(plan.nodes[0].design).toBeUndefined();
  });

  it('fails before node generation when the main style is absent or invalid', async () => {
    const aiCall = vi.fn().mockResolvedValue('{}');
    await expect(designHtmlLessonPlan(input, runtime, aiCall)).rejects.toThrow();
    expect(aiCall).toHaveBeenCalledTimes(1);
  });
});

describe('model-authored classroom pages', () => {
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
    expect(createSceneWithActions(outline, { html, htmlPresentation: true }, [], api)).toBeTruthy();
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
    expect(content).toMatchObject({ html, questions: [question] });
    expect(aiCall.mock.calls[0][1]).toContain(design.teachingPoints[0]);
    const [system, user] = aiCall.mock.calls[1];
    expect(system).toContain('window.livecourseQuiz.setAnswer');
    expect(system).toContain('livecourse:quiz-state');
    expect(user).not.toContain(question.analysis);
    expect(user).not.toContain('"answer"');
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
        { type: 'text', content: 'The secant slope approaches the tangent slope.' },
        { type: 'action', name: 'widget_highlight', params: { target: '#slope' } },
      ]),
    );
    const actions = await generateSceneActions(outline, { html, htmlPresentation: true }, aiCall);
    expect(aiCall.mock.calls[0][1]).toContain(html);
    expect(aiCall.mock.calls[0][0]).not.toContain('3-8');
    expect(actions.some((action) => action.type === 'speech')).toBe(true);
    await expect(
      generateSceneActions(
        outline,
        { html, htmlPresentation: true },
        vi.fn().mockResolvedValue('[]'),
      ),
    ).rejects.toThrow('No teacher narration');
  });

  it('accepts a fenced complete document, but rejects truncated and empty pages', () => {
    expect(parseClassroomHtml(`\`\`\`html\n${html}\n\`\`\``)).toBe(html);
    expect(parseClassroomHtml(html.toUpperCase())).toContain('<HTML>');
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

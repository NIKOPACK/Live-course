import { describe, expect, it } from 'vitest';

import { lessonPlanSchema, type LessonPlan } from '@/lib/livecourse/domain';
import { CourseStateBootstrapError } from '@/lib/livecourse/session/course-state-bootstrap';
import type { SceneOutline } from '@/lib/types/generation';
import {
  resolveGenerationLessonPlan,
  type LessonPlanSource,
} from '@/app/generation-preview/lesson-plan';
import type { GenerationSessionState } from '@/app/generation-preview/types';

const COURSE_ID = 'course:preview';
const STAGE_ID = 'stage:preview';
const NOW = '2026-08-31T00:00:00.000Z';

const outlines: SceneOutline[] = [
  {
    id: 'scene:intro',
    type: 'slide',
    title: '引入',
    description: '建立背景。',
    keyPoints: ['背景'],
    order: 0,
  },
  {
    id: 'scene:check',
    type: 'quiz',
    title: '检查',
    description: '检查理解。',
    keyPoints: ['检查'],
    order: 1,
  },
];

function session(lessonPlan?: unknown): GenerationSessionState {
  return {
    sessionId: 'session:preview',
    requirements: { requirement: '学习极限' },
    pdfText: '',
    currentStep: 'generating',
    ...(lessonPlan === undefined ? {} : { lessonPlan: lessonPlan as LessonPlan }),
  };
}

function validPlan(overrides: Partial<LessonPlan> = {}): LessonPlan {
  return lessonPlanSchema.parse({
    schemaVersion: 1,
    id: `lesson-plan:${COURSE_ID}`,
    courseId: COURSE_ID,
    stageId: STAGE_ID,
    title: '极限',
    version: 1,
    status: 'approved',
    createdAt: NOW,
    goals: [
      {
        id: 'goal:check',
        title: '完成检查',
        description: '通过检查点。',
        rule: {
          version: 'livecourse-quiz-mastery-v1',
          passScore: 0.7,
          minAcceptedEvidence: 1,
          minPassingEvidence: 1,
        },
      },
    ],
    nodes: [
      {
        id: 'node:intro',
        sceneId: 'scene:intro',
        title: '引入',
        type: 'instruction',
        order: 0,
        goalIds: [],
      },
      {
        id: 'node:check',
        sceneId: 'scene:check',
        title: '检查',
        type: 'checkpoint',
        order: 1,
        goalIds: ['goal:check'],
      },
    ],
    ...overrides,
  });
}

function resolve(
  input: {
    session?: GenerationSessionState;
    apiCandidate?: unknown;
  } = {},
): { plan: LessonPlan; source: LessonPlanSource } {
  return resolveGenerationLessonPlan({
    session: input.session ?? session(),
    outlines,
    courseId: COURSE_ID,
    stageId: STAGE_ID,
    requirement: '学习极限',
    courseTitle: '极限',
    now: NOW,
    ...(Object.prototype.hasOwnProperty.call(input, 'apiCandidate')
      ? { apiCandidate: input.apiCandidate }
      : {}),
  });
}

describe('resolveGenerationLessonPlan', () => {
  it('keeps the persisted main-agent style on resume and segment retries', () => {
    const presentation = { mode: 'html' as const, visualStyle: 'Paper and indigo diagrams.' };
    const persisted = validPlan({ presentation });
    expect(
      resolve({ session: session(persisted), apiCandidate: validPlan() }).plan.presentation,
    ).toEqual(presentation);
  });

  it('does not silently fall back to a fixed-template plan when new HTML direction fails', () => {
    expect(() =>
      resolveGenerationLessonPlan({
        session: session(),
        outlines,
        courseId: COURSE_ID,
        stageId: STAGE_ID,
        requirement: 'Learn limits',
        apiCandidate: validPlan(),
        requireHtmlPresentation: true,
      }),
    ).toThrow('visual direction');
  });

  it('prefers a valid persisted plan over any API candidate', () => {
    const persisted = validPlan();
    const result = resolve({
      session: session(persisted),
      apiCandidate: { definitely: 'not used' },
    });

    expect(result.source).toBe('persisted');
    expect(result.plan).toEqual(persisted);
  });

  it.each([
    ['missing candidate', undefined],
    ['null candidate', null],
    ['schema-invalid candidate', { courseId: COURSE_ID }],
    ['wrong-identity candidate', { ...validPlan(), stageId: 'stage:other' }],
    ['incomplete coverage candidate', { ...validPlan(), nodes: [validPlan().nodes[0]] }],
  ])('falls back to a truthful skeleton for %s', (_label, apiCandidate) => {
    const result = resolve({ apiCandidate });

    expect(result.source).toBe('skeleton');
    expect(result.plan.courseId).toBe(COURSE_ID);
    expect(result.plan.stageId).toBe(STAGE_ID);
    expect(result.plan.nodes.map((node) => node.sceneId).sort()).toEqual(
      outlines.map((outline) => outline.id).sort(),
    );
    expect(result.plan.nodes.map((node) => node.title)).toEqual(['引入', '检查']);
  });

  it.each([
    ['schema-invalid persisted plan', { ...validPlan(), nodes: 'broken' }],
    ['wrong-identity persisted plan', { ...validPlan(), courseId: 'course:other' }],
    ['incomplete-coverage persisted plan', { ...validPlan(), nodes: [validPlan().nodes[0]] }],
  ])('fails loudly for a %s', (_label, persisted) => {
    expect(() => resolve({ session: session(persisted) })).toThrow(CourseStateBootstrapError);
  });
});

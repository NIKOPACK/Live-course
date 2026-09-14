import { describe, expect, it } from 'vitest';

import {
  deriveCoursePlanFromLessonPlan,
  lessonPlanSchema,
  type LessonPlan,
} from '@/lib/livecourse/domain';

const NOW = '2026-08-30T00:00:00.000Z';

function makeLessonPlan(): LessonPlan {
  return lessonPlanSchema.parse({
    schemaVersion: 1,
    id: 'lesson-plan:stage-source',
    courseId: 'stage-source',
    stageId: 'stage-source',
    title: '微积分基础',
    version: 1,
    status: 'approved',
    createdAt: NOW,
    goals: [
      {
        id: 'goal:derivative',
        title: '理解导数',
        description: '能够解释导数的含义。',
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
        goalIds: ['goal:derivative'],
      },
      {
        id: 'node:definition',
        sceneId: 'scene:definition',
        title: '定义',
        type: 'instruction',
        order: 1,
        goalIds: ['goal:derivative'],
      },
      {
        id: 'node:check',
        sceneId: 'scene:check',
        title: '检查',
        type: 'checkpoint',
        order: 2,
        goalIds: ['goal:derivative'],
      },
    ],
  });
}

describe('deriveCoursePlanFromLessonPlan', () => {
  it('creates a stable single-lesson CoursePlan without losing nodes or checkpoints', () => {
    const source = makeLessonPlan();
    const plan = deriveCoursePlanFromLessonPlan({
      lessonPlan: source,
      courseId: 'course:calculus',
      stageId: 'course:calculus',
      lessonId: 'course:calculus',
      now: NOW,
    });

    expect(plan.courseId).toBe('course:calculus');
    expect(plan.id).toBe('course-plan:course:calculus');
    expect(plan.lessons.map((lesson) => lesson.id)).toEqual(['course:calculus']);
    expect(plan.lessons.map((lesson) => lesson.stageId)).toEqual(['course:calculus']);
    expect(plan.lessons.flatMap((lesson) => lesson.nodes).map((node) => node.id)).toEqual([
      'node:intro',
      'node:definition',
      'node:check',
    ]);
    expect(plan.checkpointRules).toEqual([
      {
        id: 'checkpoint:node:check',
        nodeId: 'node:check',
        goalIds: ['goal:derivative'],
        required: true,
      },
    ]);
    expect(plan.lessons[0]?.dependsOn).toEqual([]);
    expect(plan.lessons[0]?.title).toBe(source.title);
    expect(source.nodes).toHaveLength(3);
  });

  it('accepts a one-node lesson plan without synthesizing another lesson', () => {
    const source = makeLessonPlan();
    const oneNode = lessonPlanSchema.parse({ ...source, nodes: [source.nodes[0]] });

    const plan = deriveCoursePlanFromLessonPlan({
      lessonPlan: oneNode,
      courseId: 'course:calculus',
      stageId: 'stage:calculus',
      lessonId: 'lesson:calculus',
      now: NOW,
    });

    expect(plan.lessons).toHaveLength(1);
    expect(plan.lessons[0]?.id).toBe('lesson:calculus');
    expect(plan.lessons[0]?.stageId).toBe('stage:calculus');
    expect(plan.lessons[0]?.nodes).toHaveLength(1);
  });

  it('rejects a lesson plan with no executable nodes', () => {
    const source = makeLessonPlan();
    const empty = lessonPlanSchema.parse({ ...source, nodes: [] });

    expect(() =>
      deriveCoursePlanFromLessonPlan({
        lessonPlan: empty,
        courseId: 'course:calculus',
        stageId: 'stage:calculus',
        lessonId: 'lesson:calculus',
        now: NOW,
      }),
    ).toThrow(/at least one lesson node/i);
  });
});

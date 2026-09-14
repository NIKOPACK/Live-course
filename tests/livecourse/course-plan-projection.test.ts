import { describe, expect, it } from 'vitest';

import { projectCoursePlan, projectCoursePlanToLessonPlans } from '@/lib/livecourse/domain';
import { makeCoursePlan } from './course-plan-fixture';

describe('CoursePlan lesson projection', () => {
  it('projects one course plan into two deterministic executable lesson plans', () => {
    const plan = makeCoursePlan();
    const first = projectCoursePlan(plan);
    const second = projectCoursePlanToLessonPlans({
      ...plan,
      lessons: [...plan.lessons].reverse(),
    });

    expect(first).toHaveLength(2);
    expect(first.map((lesson) => lesson.stageId)).toEqual(['stage-1', 'stage-2']);
    expect(new Set(first.map((lesson) => lesson.stageId)).size).toBe(2);
    expect(first.map((lesson) => lesson.id)).toEqual([
      'lesson-plan:course-plan:algebra:lesson-1',
      'lesson-plan:course-plan:algebra:lesson-2',
    ]);
    expect(first.every((lesson) => lesson.nodes.length > 0)).toBe(true);
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(plan.lessons[0]!.order).toBe(0);
  });

  it('rejects a course plan that would produce duplicate executable stage ids', () => {
    const plan = makeCoursePlan();
    plan.lessons[1]!.stageId = plan.lessons[0]!.stageId;
    expect(() => projectCoursePlan(plan)).toThrow(/stage/i);
  });
});

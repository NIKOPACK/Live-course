import { describe, expect, it } from 'vitest';

import {
  assistantTaskSchema,
  coursePlanSchema,
  teachingAdjustmentSchema,
} from '@/lib/livecourse/domain';

import { makeCoursePlan, timestamps } from './course-plan-fixture';

describe('versioned LiveCourse teaching-loop contracts', () => {
  it('validates course goals, lesson references, dependencies and checkpoint rules', () => {
    const plan = coursePlanSchema.parse(makeCoursePlan());
    expect(plan.version).toBe(3);
    expect(plan.lessons).toHaveLength(2);
  });

  it.each([
    [
      'a missing lesson dependency',
      (plan: ReturnType<typeof makeCoursePlan>) => {
        plan.lessons[1]!.dependsOn = ['missing'];
      },
    ],
    [
      'a dependency cycle',
      (plan: ReturnType<typeof makeCoursePlan>) => {
        plan.lessons[0]!.dependsOn = ['lesson-2'];
      },
    ],
    [
      'a duplicate stage',
      (plan: ReturnType<typeof makeCoursePlan>) => {
        plan.lessons[1]!.stageId = 'stage-1';
      },
    ],
    [
      'a missing plan version',
      (plan: ReturnType<typeof makeCoursePlan>) => {
        delete (plan as { version?: number }).version;
      },
    ],
  ])('%s', (_label, mutate) => {
    const plan = makeCoursePlan();
    mutate(plan);
    expect(() => coursePlanSchema.parse(plan)).toThrow();
  });

  it('requires explicit versions and stable idempotency fields on adjustments and tasks', () => {
    expect(() =>
      teachingAdjustmentSchema.parse({
        id: 'adjustment:one',
        courseId: 'course:algebra',
      }),
    ).toThrow();
    expect(() =>
      assistantTaskSchema.parse({
        schemaVersion: 1,
        id: 'task:one',
        courseId: 'course:algebra',
        lessonId: 'lesson-1',
        nodeId: 'node:lesson-1',
        version: 1,
        kind: 'prepare_hint',
        delegatedBy: 'teacher:one',
        assistantId: 'assistant:one',
        inputRefs: [],
        status: 'queued',
        createdAt: timestamps.createdAt,
        updatedAt: timestamps.updatedAt,
      }),
    ).toThrow(/idempotency/i);
  });
});

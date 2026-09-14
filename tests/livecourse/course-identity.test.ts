import { describe, expect, it } from 'vitest';

import { coursePlanSchema, type CoursePlan } from '@/lib/livecourse/domain';
import {
  CourseIdentityError,
  resolveCourseIdentity,
} from '@/lib/livecourse/session/course-identity';

const NOW = '2026-08-30T00:00:00.000Z';

function makePlan(): CoursePlan {
  return coursePlanSchema.parse({
    schemaVersion: 1,
    id: 'course-plan:course-1',
    courseId: 'course-1',
    title: 'Course',
    version: 1,
    status: 'approved',
    createdAt: NOW,
    updatedAt: NOW,
    goals: [
      {
        id: 'goal-1',
        title: 'Goal',
        rule: {
          version: 'livecourse-quiz-mastery-v1',
          passScore: 0.7,
          minAcceptedEvidence: 1,
          minPassingEvidence: 1,
        },
      },
    ],
    lessons: [
      {
        id: 'lesson-other',
        stageId: 'stage-other',
        title: 'Other',
        order: 0,
        dependsOn: [],
        nodes: [
          {
            id: 'node-other',
            sceneId: 'scene-other',
            title: 'Other',
            type: 'instruction',
            order: 0,
            goalIds: ['goal-1'],
          },
        ],
      },
      {
        id: 'lesson-current',
        stageId: 'stage-current',
        title: 'Current',
        order: 4,
        dependsOn: [],
        nodes: [
          {
            id: 'node-current',
            sceneId: 'scene-current',
            title: 'Current',
            type: 'instruction',
            order: 0,
            goalIds: ['goal-1'],
          },
        ],
      },
    ],
    checkpointRules: [],
  });
}

describe('resolveCourseIdentity', () => {
  it('keeps the stage identity for legacy documents without a course plan', () => {
    expect(resolveCourseIdentity({ stageId: 'legacy-stage' })).toEqual({
      courseId: 'legacy-stage',
      lessonId: 'legacy-stage',
    });
    expect(resolveCourseIdentity({ stageId: 'legacy-stage', coursePlan: null })).toEqual({
      courseId: 'legacy-stage',
      lessonId: 'legacy-stage',
    });
  });

  it('uses the plan course id and the lesson mapped to the route stage', () => {
    expect(resolveCourseIdentity({ stageId: 'stage-current', coursePlan: makePlan() })).toEqual({
      courseId: 'course-1',
      lessonId: 'lesson-current',
    });
  });

  it('fails closed for malformed or unrelated plans', () => {
    expect(() =>
      resolveCourseIdentity({ stageId: 'stage-current', coursePlan: { courseId: 'course-1' } }),
    ).toThrow(CourseIdentityError);
    expect(() =>
      resolveCourseIdentity({ stageId: 'stage-missing', coursePlan: makePlan() }),
    ).toThrow(/no lesson for classroom/i);
  });

  it('rejects an empty route identity instead of inventing a fallback', () => {
    expect(() => resolveCourseIdentity({ stageId: '   ' })).toThrow(CourseIdentityError);
  });
});

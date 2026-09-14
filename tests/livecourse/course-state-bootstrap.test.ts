import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it } from 'vitest';

import { lessonPlanSchema, type LessonPlan } from '@/lib/livecourse/domain';
import {
  buildInitialCourseStateInput,
  initializeCourseState,
} from '@/lib/livecourse/session/course-state-bootstrap';
import { createCourseStateRepository } from '@/lib/livecourse/session/course-state-repository';

const NOW = '2026-08-30T00:00:00.000Z';
const COURSE_ID = 'course:bootstrap';
const STAGE_ID = COURSE_ID;
const LEARNER_ID = 'learner:one';

function lessonPlan(): LessonPlan {
  return lessonPlanSchema.parse({
    schemaVersion: 1,
    id: 'lesson-plan:bootstrap',
    courseId: STAGE_ID,
    stageId: STAGE_ID,
    title: 'Bootstrap lesson',
    version: 1,
    status: 'approved',
    createdAt: NOW,
    goals: [],
    nodes: [
      {
        id: 'node:first',
        sceneId: 'scene:first',
        title: 'First',
        type: 'instruction',
        order: 0,
        goalIds: [],
      },
      {
        id: 'node:second',
        sceneId: 'scene:second',
        title: 'Second',
        type: 'instruction',
        order: 1,
        goalIds: [],
      },
    ],
  });
}

describe('course state bootstrap', () => {
  it('builds a fresh C input with no teaching or evidence side effects', () => {
    const input = buildInitialCourseStateInput({
      courseId: COURSE_ID,
      stageId: STAGE_ID,
      learnerId: LEARNER_ID,
      lessonPlan: lessonPlan(),
      now: NOW,
    });

    expect(input.idempotencyKey).toBe(`course:init:${COURSE_ID}`);
    expect(input.createdAt).toBe(NOW);
    expect(input.courseId).toBe(COURSE_ID);
    expect(input.lessonId).toBe(COURSE_ID);
    expect(input.teachingActions).toEqual({
      actions: [],
      currentNodeId: null,
      lastSequence: -1,
    });
    expect(input.evidence).toEqual([]);
    expect(input.adjustments).toEqual([]);
    expect(input.assistantTasks).toEqual({ schemaVersion: 1, tasks: [], events: [] });
    expect(input.coursePlan.lessons).toHaveLength(1);
    expect(input.coursePlan.lessons[0]?.nodes.map((node) => node.id)).toEqual([
      'node:first',
      'node:second',
    ]);
  });

  it('initializes C once so the first progress projection is immediately writable', async () => {
    const store = new BrowserRuntimeStore({ dbName: `course-bootstrap-${crypto.randomUUID()}` });
    const repository = createCourseStateRepository({
      store,
      stageId: STAGE_ID,
      learnerId: LEARNER_ID,
      courseId: COURSE_ID,
      now: () => NOW,
    });

    const initialized = await initializeCourseState({
      repository,
      courseId: COURSE_ID,
      stageId: STAGE_ID,
      learnerId: LEARNER_ID,
      lessonPlan: lessonPlan(),
      now: NOW,
    });
    const progressed = await repository.saveProgress({
      idempotencyKey: 'lesson.complete_node:first',
      progress: {
        completedNodeIds: ['node:first'],
        lastCompletedNodeId: 'node:first',
        updatedAt: NOW,
      },
    });

    expect(initialized.progress).toBeUndefined();
    expect(progressed.progress?.completedNodeIds).toEqual(['node:first']);
    expect((await repository.load())?.progress?.lastCompletedNodeId).toBe('node:first');
  });
});

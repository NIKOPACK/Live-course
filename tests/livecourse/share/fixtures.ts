import type { LessonPlan } from '@/lib/livecourse/domain/schemas';
import type { Scene, Stage } from '@/lib/types/stage';

export const SOURCE_IDS = {
  courseId: 'course-AAA',
  stageId: 'stage-AAA',
  lessonId: 'lesson-AAA',
} as const;

export function htmlLessonPlan(overrides: Partial<LessonPlan> = {}): LessonPlan {
  return {
    schemaVersion: 1,
    id: SOURCE_IDS.lessonId,
    courseId: SOURCE_IDS.courseId,
    stageId: SOURCE_IDS.stageId,
    title: 'Shared Fourier',
    version: 1,
    status: 'approved',
    createdAt: '2026-09-18T00:00:00.000Z',
    goals: [
      {
        id: 'goal-one',
        title: 'Understand the transform',
        rule: { version: 'rule-v1', passScore: 0.7, minAcceptedEvidence: 1, minPassingEvidence: 1 },
      },
    ],
    nodes: [
      {
        id: 'node-one',
        sceneId: 'scene-1',
        title: 'Intro',
        type: 'instruction',
        order: 0,
        goalIds: ['goal-one'],
        design: {
          teachingPoints: ['What a transform is'],
          explanationPlan: 'Show the diagram then speak.',
          misconceptions: ['Confusing frequency with amplitude'],
        },
      },
    ],
    presentation: { mode: 'html', visualStyle: 'Ink diagrams on warm paper.' },
    ...overrides,
  };
}

export function htmlScene(html: string, extras: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    stageId: SOURCE_IDS.stageId,
    title: 'Intro',
    order: 0,
    type: 'interactive',
    content: { type: 'interactive', html },
    ...extras,
  } as Scene;
}

export function htmlStage(extras: Partial<Stage> = {}): Stage {
  return {
    id: SOURCE_IDS.stageId,
    name: 'Shared Fourier',
    createdAt: 1,
    updatedAt: 1,
    ...extras,
  } as Stage;
}

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readClassroom: vi.fn(),
}));

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/classroom-storage')>()),
  readClassroom: mocks.readClassroom,
}));

import { coursePlanSchema, type CoursePlan } from '@/lib/livecourse/domain';
import {
  ClassroomAgentSessionService,
  deriveClassroomAgents,
  InMemoryClassroomAgentSessionStore,
} from '@/lib/livecourse/realtime/server/classroom-agent-session';
import {
  getClassroomAgentSessionService,
  resetClassroomAgentSessionRuntime,
} from '@/lib/livecourse/realtime/server/classroom-agent-session-runtime';
import { deterministicAssistantExecutor } from './fixtures/deterministic-assistant-executor';

const NOW = '2026-08-31T00:00:00.000Z';

function planForStage(
  stageId: string,
  options: { courseId?: string; includeOtherLesson?: boolean } = {},
): CoursePlan {
  const courseId = options.courseId ?? 'course-1';
  const lessons = [
    ...(options.includeOtherLesson === false
      ? []
      : [
          {
            id: 'lesson-other',
            stageId: 'stage-other',
            title: 'Other lesson',
            order: 0,
            dependsOn: [],
            nodes: [
              {
                id: 'node-other',
                sceneId: 'scene-other',
                title: 'Other node',
                type: 'instruction' as const,
                order: 0,
                goalIds: ['goal-1'],
              },
            ],
          },
        ]),
    {
      id: 'lesson-current',
      stageId,
      title: 'Current lesson',
      order: 1,
      dependsOn: options.includeOtherLesson === false ? [] : ['lesson-other'],
      nodes: [
        {
          id: 'node-current',
          sceneId: 'scene-current',
          title: 'Current node',
          type: 'instruction' as const,
          order: 0,
          goalIds: ['goal-1'],
        },
      ],
    },
  ];
  return coursePlanSchema.parse({
    schemaVersion: 1,
    id: `course-plan:${courseId}`,
    courseId,
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
          version: 'rule:v1',
          passScore: 0.7,
          minAcceptedEvidence: 1,
          minPassingEvidence: 1,
        },
      },
    ],
    lessons,
    checkpointRules: [],
  });
}

function serviceWithPlan(
  resolveCoursePlan: (input: { courseId: string; stageId: string }) => CoursePlan,
) {
  return new ClassroomAgentSessionService({
    store: new InMemoryClassroomAgentSessionStore(),
    executor: deterministicAssistantExecutor,
    clock: () => NOW,
    resolveCoursePlan,
    resolveClassroomAgents: deriveClassroomAgents,
  });
}

function persistedClassroom(stageId: string, coursePlan?: unknown, scenes = 2) {
  return {
    id: stageId,
    stage: { id: stageId, name: 'Persisted classroom', createdAt: 1, updatedAt: 1 },
    scenes: Array.from({ length: scenes }, (_, order) => ({
      id: `scene-${order}`,
      title: `Scene ${order}`,
      order,
      type: 'slide',
    })),
    ...(coursePlan === undefined ? {} : { coursePlan }),
    createdAt: NOW,
  };
}

afterEach(() => {
  resetClassroomAgentSessionRuntime();
  vi.clearAllMocks();
});

describe('ClassroomAgentSession identity binding', () => {
  it('selects the lesson mapped to the route stage even when courseId differs', async () => {
    const stageId = 'stage-current';
    const coursePlan = planForStage(stageId, { courseId: 'course-1' });
    const resolveCoursePlan = vi.fn(() => coursePlan);
    const service = serviceWithPlan(resolveCoursePlan);

    const established = await service.establish({
      classroomId: stageId,
      learnerId: 'learner-1',
    });

    expect(resolveCoursePlan).toHaveBeenCalledWith({ courseId: stageId, stageId });
    expect(established.session.courseId).toBe('course-1');
    expect(established.session.stageId).toBe(stageId);
    expect(established.session.lessonId).toBe('lesson-current');
  });

  it('fails explicitly when the returned plan has no lesson for the route stage', async () => {
    const resolveCoursePlan = vi.fn(() =>
      planForStage('stage-other', { includeOtherLesson: false }),
    );
    const service = serviceWithPlan(resolveCoursePlan);

    await expect(
      service.establish({ classroomId: 'stage-missing', learnerId: 'learner-1' }),
    ).rejects.toMatchObject({
      code: 'CLASSROOM_LESSON_NOT_FOUND',
    });
  });

  it('fails explicitly when multiple lessons claim the route stage', async () => {
    const plan = planForStage('stage-current');
    const duplicatePlan = {
      ...plan,
      lessons: [...plan.lessons, { ...plan.lessons[1]!, id: 'lesson-duplicate', order: 2 }],
    } as CoursePlan;
    const service = serviceWithPlan(() => duplicatePlan);

    await expect(
      service.establish({ classroomId: 'stage-current', learnerId: 'learner-1' }),
    ).rejects.toMatchObject({
      code: 'CLASSROOM_LESSON_AMBIGUOUS',
    });
  });
});

describe('server classroom resolver identity boundary', () => {
  it('uses a persisted course plan before attempting legacy derivation', async () => {
    const stageId = 'stage-persisted';
    const coursePlan = planForStage(stageId, { courseId: 'course-persisted' });
    mocks.readClassroom.mockResolvedValueOnce(persistedClassroom(stageId, coursePlan, 1));

    const established = await getClassroomAgentSessionService().establish({
      classroomId: stageId,
      learnerId: 'learner-1',
    });

    expect(mocks.readClassroom).toHaveBeenCalledWith(stageId);
    expect(established.session.courseId).toBe('course-persisted');
    expect(established.session.stageId).toBe(stageId);
    expect(established.session.lessonId).toBe('lesson-current');
  });

  it('fails loudly for a malformed persisted course plan', async () => {
    const stageId = 'stage-malformed';
    mocks.readClassroom.mockResolvedValueOnce(
      persistedClassroom(stageId, { schemaVersion: 1, courseId: 'course-bad' }),
    );

    await expect(
      getClassroomAgentSessionService().establish({
        classroomId: stageId,
        learnerId: 'learner-1',
      }),
    ).rejects.toThrow();
  });

  it('derives legacy classrooms with the route stage as both identities', async () => {
    const stageId = 'stage-legacy';
    mocks.readClassroom.mockResolvedValueOnce(persistedClassroom(stageId));

    const established = await getClassroomAgentSessionService().establish({
      classroomId: stageId,
      learnerId: 'learner-1',
    });

    expect(established.session.courseId).toBe(stageId);
    expect(established.session.stageId).toBe(stageId);
    expect(established.session.lessonId).toBe(`lesson:${stageId}:1`);
  });
});

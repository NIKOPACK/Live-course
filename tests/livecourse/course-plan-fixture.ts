export const timestamps = {
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
};

function lesson(id: string, stageId: string, dependsOn: string[] = []) {
  return {
    id,
    stageId,
    title: id,
    order: id === 'lesson-1' ? 0 : 1,
    dependsOn,
    nodes: [
      {
        id: `node:${id}`,
        sceneId: `scene:${id}`,
        title: id,
        type: 'instruction' as const,
        order: 0,
        goalIds: ['goal:one'],
      },
    ],
  };
}

export function makeCoursePlan() {
  return {
    schemaVersion: 1 as const,
    id: 'course-plan:algebra',
    courseId: 'course:algebra',
    title: 'Algebra',
    version: 3,
    status: 'approved' as const,
    ...timestamps,
    goals: [
      {
        id: 'goal:one',
        title: 'Solve linear equations',
        rule: {
          version: 'rule:v1',
          passScore: 0.7,
          minAcceptedEvidence: 1,
          minPassingEvidence: 1,
        },
      },
    ],
    lessons: [lesson('lesson-1', 'stage-1'), lesson('lesson-2', 'stage-2', ['lesson-1'])],
    checkpointRules: [
      { id: 'checkpoint:one', nodeId: 'node:lesson-2', goalIds: ['goal:one'], required: true },
    ],
  };
}

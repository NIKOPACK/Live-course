import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLASSROOMS_DIR,
  isValidClassroomId,
  persistClassroom,
  readClassroom,
} from '@/lib/server/classroom-storage';

const createdFiles: string[] = [];

function fixtureClassroom(id: string) {
  return {
    id,
    stage: { id, name: 'Storage test stage', createdAt: 1, updatedAt: 1 } as never,
    scenes: [],
  };
}

afterEach(async () => {
  await Promise.all(createdFiles.splice(0).map((filePath) => fs.rm(filePath, { force: true })));
});

describe('classroom file storage', () => {
  it('rejects path traversal before resolving a classroom file path', async () => {
    expect(isValidClassroomId('../outside')).toBe(false);
    await expect(readClassroom('../outside')).rejects.toThrow(/invalid classroom id/i);
    await expect(
      persistClassroom({ ...fixtureClassroom('../outside') }, 'http://localhost'),
    ).rejects.toThrow(/invalid classroom id/i);
  });

  it('round-trips an opaque course plan without dropping unknown metadata', async () => {
    const id = `storage-course-plan-${Date.now()}`;
    const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
    createdFiles.push(filePath);
    const coursePlan = {
      schemaVersion: 1,
      id: 'course-plan:opaque',
      courseId: 'course:opaque',
      title: 'Opaque plan',
      version: 1,
      goals: [],
      lessons: [],
      checkpointRules: [],
      extension: { producer: 'test', values: ['preserve-me'] },
    };

    await persistClassroom({ ...fixtureClassroom(id), coursePlan }, 'http://localhost');

    await expect(readClassroom(id)).resolves.toMatchObject({ id, coursePlan });
  });

  it('round-trips a persisted lesson plan so reopen does not re-derive teaching design', async () => {
    const id = `storage-lesson-plan-${Date.now()}`;
    const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
    createdFiles.push(filePath);
    const lessonPlan = {
      schemaVersion: 1,
      id: `lesson-plan:${id}`,
      courseId: id,
      stageId: id,
      title: 'Designed lesson',
      version: 1,
      status: 'approved',
      createdAt: '2026-09-14T00:00:00.000Z',
      goals: [],
      nodes: [
        {
          id: 'node:intro',
          sceneId: 'scene-intro',
          title: 'Intro',
          type: 'instruction',
          order: 0,
          goalIds: [],
          design: {
            teachingPoints: ['What the chain rule is'],
            explanationPlan: 'Hook, expand, recap.',
            anticipatedQuestions: [
              { question: 'Why compose?', response: 'Because rates multiply.' },
            ],
          },
        },
      ],
    };

    await persistClassroom({ ...fixtureClassroom(id), lessonPlan }, 'http://localhost');

    await expect(readClassroom(id)).resolves.toMatchObject({ id, lessonPlan });
  });

  it('fails loudly when a persisted course plan is malformed', async () => {
    const id = `storage-malformed-plan-${Date.now()}`;
    const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
    createdFiles.push(filePath);
    const classroom = fixtureClassroom(id);
    await fs.mkdir(CLASSROOMS_DIR, { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({ ...classroom, coursePlan: { schemaVersion: 1, version: 1 } }),
      'utf8',
    );

    await expect(readClassroom(id)).rejects.toThrow(/course plan/i);
  });
});

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sweepClassroomGenerationJobsForClassroom } from '@/lib/server/classroom-job-store';
import {
  CLASSROOM_JOBS_DIR,
  CLASSROOMS_DIR,
  deleteClassroom,
  isValidClassroomId,
  persistClassroom,
  readClassroom,
  resolveSafeClassroomMediaFile,
} from '@/lib/server/classroom-storage';

const createdFiles: string[] = [];
const createdDirs: string[] = [];

function fixtureClassroom(id: string) {
  return {
    id,
    stage: { id, name: 'Storage test stage', createdAt: 1, updatedAt: 1 } as never,
    scenes: [],
  };
}

afterEach(async () => {
  await Promise.all(createdFiles.splice(0).map((filePath) => fs.rm(filePath, { force: true })));
  await Promise.all(
    createdDirs.splice(0).map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
  );
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

  it('deleteClassroom removes the json file and media directory and is idempotent', async () => {
    const id = `storage-delete-${Date.now()}`;
    const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
    const mediaDir = path.join(CLASSROOMS_DIR, id);
    createdFiles.push(filePath);
    createdDirs.push(mediaDir);

    await persistClassroom(fixtureClassroom(id), 'http://localhost');
    await fs.mkdir(path.join(mediaDir, 'media'), { recursive: true });
    await fs.writeFile(path.join(mediaDir, 'media', 'cover.png'), 'png');

    await deleteClassroom(id);
    await expect(readClassroom(id)).resolves.toBeNull();
    await expect(fs.access(mediaDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(deleteClassroom(id)).resolves.toBeUndefined();
  });

  it('deleteClassroom treats a missing file as success', async () => {
    const id = `storage-delete-missing-${Date.now()}`;
    await expect(deleteClassroom(id)).resolves.toBeUndefined();
  });

  it('rejects path traversal on delete before touching the filesystem', async () => {
    await expect(deleteClassroom('../outside')).rejects.toThrow(/invalid classroom id/i);
  });

  it('follows a classroom-directory symlink when resolving media', async () => {
    const id = `storage-media-link-${Date.now()}`;
    const linkDir = path.join(CLASSROOMS_DIR, id);
    const realDir = path.join(CLASSROOMS_DIR, `${id}-real`);
    createdDirs.push(linkDir, realDir);
    await fs.mkdir(path.join(realDir, 'media'), { recursive: true });
    const filePath = path.join(realDir, 'media', 'cover.png');
    await fs.writeFile(filePath, 'png');
    await fs.symlink(realDir, linkDir);

    await expect(resolveSafeClassroomMediaFile(id, ['media', 'cover.png'])).resolves.toBe(
      await fs.realpath(filePath),
    );
    await expect(resolveSafeClassroomMediaFile(id, ['media', '..', 'cover.png'])).resolves.toBeNull();
  });

  it('refuses to delete the showcase classroom before any unlink', async () => {
    const filePath = path.join(CLASSROOMS_DIR, 'fourier-intro.json');
    createdFiles.push(filePath);
    await persistClassroom(fixtureClassroom('fourier-intro'), 'http://localhost');

    await expect(deleteClassroom('fourier-intro')).rejects.toThrow(
      /showcase classroom cannot be deleted/i,
    );
    await expect(readClassroom('fourier-intro')).resolves.toMatchObject({ id: 'fourier-intro' });
  });
});

describe('classroom generation job sweep', () => {
  it('unlinks matching job files by directory basename, not JSON id', async () => {
    const classroomId = `stage-target-${Date.now()}`;
    const resultJobId = `result-${Date.now()}`;
    const identityJobId = `ident-${Date.now()}`;
    const identityClassroomId = `stage-${identityJobId}`;
    const otherJobId = `other-${Date.now()}`;
    const forgedJobId = `forged-${Date.now()}`;

    await fs.mkdir(CLASSROOM_JOBS_DIR, { recursive: true });
    const resultPath = path.join(CLASSROOM_JOBS_DIR, `${resultJobId}.json`);
    const identityPath = path.join(CLASSROOM_JOBS_DIR, `${identityJobId}.json`);
    const otherPath = path.join(CLASSROOM_JOBS_DIR, `${otherJobId}.json`);
    const forgedPath = path.join(CLASSROOM_JOBS_DIR, `${forgedJobId}.json`);
    createdFiles.push(resultPath, identityPath, otherPath, forgedPath);

    await fs.writeFile(
      resultPath,
      JSON.stringify({
        id: resultJobId,
        result: { classroomId, url: '/x', scenesCount: 1 },
      }),
    );
    await fs.writeFile(identityPath, JSON.stringify({ id: identityJobId, status: 'running' }));
    await fs.writeFile(
      otherPath,
      JSON.stringify({
        id: otherJobId,
        result: { classroomId: 'stage-someone-else', url: '/y', scenesCount: 1 },
      }),
    );
    await fs.writeFile(
      forgedPath,
      JSON.stringify({
        id: '../outside',
        result: { classroomId, url: '/z', scenesCount: 1 },
      }),
    );

    await sweepClassroomGenerationJobsForClassroom(classroomId);

    await expect(fs.access(resultPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(forgedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(otherPath)).resolves.toBeUndefined();
    await expect(fs.access(identityPath)).resolves.toBeUndefined();
    const outside = path.join(CLASSROOM_JOBS_DIR, '..', 'outside');
    await expect(fs.access(outside)).rejects.toMatchObject({ code: 'ENOENT' });

    await sweepClassroomGenerationJobsForClassroom(identityClassroomId);
    await expect(fs.access(identityPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

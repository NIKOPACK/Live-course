import { describe, expect, it } from 'vitest';

import type { RuntimeStore } from '@livecourse/storage';

import {
  COURSE_MEMORY_KIND,
  LEARNER_MEMORY_KIND,
  LEARNER_MEMORY_PARTITION_STAGE_ID,
  WORKING_MEMORY_KIND,
  createCourseMemoryRepository,
  createEmptyWorkingMemory,
  createLearnerMemoryRepository,
  createWorkingMemoryRepository,
  courseMemorySessionId,
  learnerMemorySessionId,
  MissingCourseIdError,
  persistGenerationCourseIntake,
  workingMemorySessionId,
  type CourseIntake,
} from '@/lib/livecourse/memory';

const NOW = '2026-09-14T12:00:00.000Z';
const STAGE = 'stage-memory-contract';
const LEARNER_A = 'learner-a';
const LEARNER_B = 'learner-b';
const COURSE_A = 'course-a';
const COURSE_B = 'course-b';
const SESSION_A = 'classroom-session-a';
const SESSION_B = 'classroom-session-b';

function intake(requirement: string): CourseIntake {
  return {
    requirement,
    preClassAnswers: [],
    finalScope: [requirement],
    skipped: true,
    submittedAt: NOW,
  };
}

/**
 * A6 storage contract (docs/spec/05 A6): schema, namespace isolation,
 * idempotent update / CAS, and destroy boundaries. Every RuntimeStore backend
 * that can host W / C / L must pass this suite.
 */
export function runMemoryStoreContract(name: string, makeStore: () => RuntimeStore): void {
  describe(`A6 memory contract: ${name}`, () => {
    it('fails closed when a course-scoped repository is built without a courseId', () => {
      const store = makeStore();
      expect(() =>
        createCourseMemoryRepository({
          store,
          scope: { stageId: STAGE, learnerId: LEARNER_A, courseId: '' },
        }),
      ).toThrow(MissingCourseIdError);
    });

    it('isolates W / C / L across learners and courses', async () => {
      const store = makeStore();
      const courseA = createCourseMemoryRepository({
        store,
        scope: { stageId: STAGE, learnerId: LEARNER_A, courseId: COURSE_A },
        now: () => NOW,
      });
      const courseB = createCourseMemoryRepository({
        store,
        scope: { stageId: STAGE, learnerId: LEARNER_A, courseId: COURSE_B },
        now: () => NOW,
      });
      const otherLearner = createCourseMemoryRepository({
        store,
        scope: { stageId: STAGE, learnerId: LEARNER_B, courseId: COURSE_A },
        now: () => NOW,
      });
      const working = createWorkingMemoryRepository({
        store,
        scope: {
          stageId: STAGE,
          learnerId: LEARNER_A,
          classroomSessionId: SESSION_A,
          courseId: COURSE_A,
          lessonId: 'lesson-1',
        },
        now: () => NOW,
      });
      const workingOtherSession = createWorkingMemoryRepository({
        store,
        scope: {
          stageId: STAGE,
          learnerId: LEARNER_A,
          classroomSessionId: SESSION_B,
          courseId: COURSE_A,
          lessonId: 'lesson-1',
        },
        now: () => NOW,
      });
      const workingOtherLearner = createWorkingMemoryRepository({
        store,
        scope: {
          stageId: STAGE,
          learnerId: LEARNER_B,
          classroomSessionId: SESSION_A,
          courseId: COURSE_A,
          lessonId: 'lesson-1',
        },
        now: () => NOW,
      });
      const learner = createLearnerMemoryRepository({
        store,
        scope: { learnerId: LEARNER_A },
        now: () => NOW,
      });
      const otherLearnerProfile = createLearnerMemoryRepository({
        store,
        scope: { learnerId: LEARNER_B },
        now: () => NOW,
      });

      await persistGenerationCourseIntake({
        store,
        stageId: STAGE,
        learnerId: LEARNER_A,
        courseId: COURSE_A,
        intake: intake('课程 A 的秘密需求'),
        now: () => NOW,
      });
      await working.update((current) => ({
        ...current,
        currentNodeId: 'node:secret',
        shortSummary: '本堂课临时摘要',
      }));
      await learner.update((current) => ({
        ...current,
        entries: [
          {
            schemaVersion: 1,
            id: 'learner-entry:pace-slow',
            dimension: 'pace',
            value: '慢一点',
            sourceType: 'explicit_longterm',
            supportingCourseCount: 1,
            confidence: 0.9,
            observedAt: NOW,
            updatedAt: NOW,
          },
        ],
      }));

      expect((await courseA.load())?.intake?.requirement).toBe('课程 A 的秘密需求');
      expect(await courseB.load()).toBeUndefined();
      expect(await otherLearner.load()).toBeUndefined();
      expect((await working.load())?.shortSummary).toBe('本堂课临时摘要');
      expect(await workingOtherSession.load()).toBeUndefined();
      expect(await workingOtherLearner.load()).toBeUndefined();
      expect((await learner.load())?.entries.map((entry) => entry.value)).toEqual(['慢一点']);
      expect(await otherLearnerProfile.load()).toBeUndefined();

      const classroomSessions = await store.listSessions(STAGE, LEARNER_A);
      expect(classroomSessions.some((session) => session.kind === COURSE_MEMORY_KIND)).toBe(true);
      expect(classroomSessions.some((session) => session.kind === WORKING_MEMORY_KIND)).toBe(true);
      expect(classroomSessions.some((session) => session.kind === LEARNER_MEMORY_KIND)).toBe(false);

      const learnerSessions = await store.listSessions(
        LEARNER_MEMORY_PARTITION_STAGE_ID,
        LEARNER_A,
      );
      expect(learnerSessions.some((session) => session.kind === LEARNER_MEMORY_KIND)).toBe(true);
      expect(learnerSessions.some((session) => session.kind === COURSE_MEMORY_KIND)).toBe(false);
    });

    it('skips identical updates and appends a new revision only when C changes', async () => {
      const store = makeStore();
      const courseId = COURSE_A;
      const repo = createCourseMemoryRepository({
        store,
        scope: { stageId: STAGE, learnerId: LEARNER_A, courseId },
        now: () => NOW,
      });
      const sessionId = courseMemorySessionId({
        stageId: STAGE,
        learnerId: LEARNER_A,
        courseId,
      });

      const first = await persistGenerationCourseIntake({
        store,
        stageId: STAGE,
        learnerId: LEARNER_A,
        courseId,
        intake: intake('同一份 intake'),
        now: () => NOW,
      });
      const retry = await persistGenerationCourseIntake({
        store,
        stageId: STAGE,
        learnerId: LEARNER_A,
        courseId,
        intake: { ...intake('同一份 intake'), submittedAt: '2026-09-14T13:00:00.000Z' },
        now: () => '2026-09-14T13:00:00.000Z',
      });
      expect(retry).toEqual(first);
      expect((await store.listRecords(sessionId)).map((record) => record.seq)).toEqual([0]);

      await repo.update((current) => ({
        ...current,
        unresolvedQuestions: [
          {
            id: 'q-1',
            question: '为什么？',
            sourceSessionId: SESSION_A,
            archivedAt: NOW,
          },
        ],
      }));
      expect((await store.listRecords(sessionId)).map((record) => record.seq)).toEqual([0, 1]);
    });

    it('destroys W without deleting C or L, and destroy is idempotent', async () => {
      const store = makeStore();
      const working = createWorkingMemoryRepository({
        store,
        scope: {
          stageId: STAGE,
          learnerId: LEARNER_A,
          classroomSessionId: SESSION_A,
          courseId: COURSE_A,
          lessonId: 'lesson-1',
        },
        now: () => NOW,
      });
      const course = createCourseMemoryRepository({
        store,
        scope: { stageId: STAGE, learnerId: LEARNER_A, courseId: COURSE_A },
        now: () => NOW,
      });
      const learner = createLearnerMemoryRepository({
        store,
        scope: { learnerId: LEARNER_A },
        now: () => NOW,
      });

      await working.update((current) => ({ ...current, currentNodeId: 'node:1' }));
      await persistGenerationCourseIntake({
        store,
        stageId: STAGE,
        learnerId: LEARNER_A,
        courseId: COURSE_A,
        intake: intake('保留的课程 intake'),
        now: () => NOW,
      });
      await learner.update((current) => ({
        ...current,
        entries: [
          {
            schemaVersion: 1,
            id: 'learner-entry:language-zh',
            dimension: 'language',
            value: '中文',
            sourceType: 'explicit_longterm',
            supportingCourseCount: 1,
            confidence: 0.9,
            observedAt: NOW,
            updatedAt: NOW,
          },
        ],
      }));

      await working.destroy();
      await working.destroy();
      expect(await working.load()).toBeUndefined();
      expect(
        await store.getSession(
          workingMemorySessionId({
            stageId: STAGE,
            learnerId: LEARNER_A,
            classroomSessionId: SESSION_A,
          }),
        ),
      ).toBeUndefined();
      expect((await course.load())?.intake?.requirement).toBe('保留的课程 intake');
      expect(await learner.load()).toBeDefined();
      expect(
        await store.getSession(learnerMemorySessionId({ learnerId: LEARNER_A })),
      ).toMatchObject({ kind: LEARNER_MEMORY_KIND });
    });

    it('rejects a schema-invalid memory payload at the store validator', async () => {
      const store = makeStore();
      const repo = createWorkingMemoryRepository({
        store,
        scope: {
          stageId: STAGE,
          learnerId: LEARNER_A,
          classroomSessionId: SESSION_A,
          courseId: COURSE_A,
          lessonId: 'lesson-1',
        },
        now: () => NOW,
      });

      await expect(
        repo.update(() =>
          createEmptyWorkingMemory({
            classroomSessionId: SESSION_A,
            stageId: STAGE,
            learnerId: LEARNER_A,
            courseId: COURSE_A,
            lessonId: 'lesson-1',
            now: NOW,
          }),
        ),
      ).resolves.toMatchObject({ classroomSessionId: SESSION_A });

      await expect(
        repo.update(
          () =>
            ({
              schemaVersion: 1,
              classroomSessionId: SESSION_A,
            }) as never,
        ),
      ).rejects.toThrow();
    });
  });
}

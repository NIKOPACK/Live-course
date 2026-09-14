import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it } from 'vitest';

import {
  CourseStateRevisionConflictError,
  createCourseStateRepository,
  courseStateSessionId,
} from '@/lib/livecourse/session/course-state-repository';
import {
  CourseStatePartitionError,
  CourseStateSnapshotConflictError,
  buildCourseStateSnapshot,
} from '@/lib/livecourse/session/course-state-snapshot';

import { COURSE_ID, FIXED_NOW, makeCourseSnapshotInput } from '../livecourse/course-state-fixture';

const STAGE_ONE = 'stage-1';
const STAGE_TWO = 'stage-2';
const LEARNER_A = 'learner-a';
const LEARNER_B = 'learner-b';

function setup(overrides: { stageId?: string; learnerId?: string } = {}, dbName?: string) {
  const stageId = overrides.stageId ?? STAGE_ONE;
  const learnerId = overrides.learnerId ?? LEARNER_A;
  const store = new BrowserRuntimeStore({
    dbName: dbName ?? `course-state-roundtrip-${crypto.randomUUID()}`,
  });
  return {
    store,
    learnerId,
    repository: createCourseStateRepository({
      store,
      stageId,
      learnerId,
      courseId: COURSE_ID,
      now: () => FIXED_NOW,
    }),
  };
}

/** Input aligned with one repository partition (stage-1 / learner-a). */
function partitionInput(overrides: Parameters<typeof makeCourseSnapshotInput>[0] = {}) {
  return makeCourseSnapshotInput({ learnerId: LEARNER_A, ...overrides });
}

describe('course state snapshot RuntimeStore roundtrip (P-004)', () => {
  it('omits undefined optional fields from the built JSON payload', () => {
    const snapshot = buildCourseStateSnapshot(partitionInput());

    expect(Object.hasOwn(snapshot, 'progress')).toBe(false);
    expect(Object.hasOwn(snapshot, 'lifecycle')).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('undefined');
  });

  it('saves and loads an identical snapshot through the real runtime adapter', async () => {
    const { store, repository } = setup();
    const input = partitionInput();

    const saved = await repository.save(input);
    const loaded = await repository.load();

    // The full built snapshot survives the IndexedDB roundtrip unchanged; the
    // composed canonical parts equal the caller's input exactly.
    expect(loaded).toEqual(saved);
    expect(loaded?.coursePlan).toEqual(input.coursePlan);
    expect(loaded?.teachingActions).toEqual(input.teachingActions);
    expect(loaded?.assistantTasks).toEqual(input.assistantTasks);
    expect(loaded?.evidence).toEqual(input.evidence);
    expect(loaded?.adjustments).toEqual(input.adjustments);

    // One typed session in the right partition, one record with the snapshot.
    const sessions = await store.listSessions(STAGE_ONE, LEARNER_A);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ kind: 'livecourseCourseState', status: 'active' });
    const sessionId = courseStateSessionId({
      stageId: STAGE_ONE,
      learnerId: LEARNER_A,
      courseId: COURSE_ID,
    });
    expect((await store.listRecords(sessionId)).map((record) => record.payload)).toEqual([saved]);
  });

  it('initializes an empty course state with a null-tail CAS', async () => {
    const { store, repository } = setup();
    const input = partitionInput({ idempotencyKey: 'initialize-1' });

    const initialized = await repository.initialize(input);

    expect(initialized.idempotencyKey).toBe('initialize-1');
    expect(await repository.load()).toEqual(initialized);
    const sessionId = courseStateSessionId({
      stageId: STAGE_ONE,
      learnerId: LEARNER_A,
      courseId: COURSE_ID,
    });
    expect(await store.listRecords(sessionId)).toHaveLength(1);
  });

  it('makes an identical initialization retry idempotent without appending', async () => {
    const { store, repository } = setup();
    const input = partitionInput({ idempotencyKey: 'initialize-retry' });

    const first = await repository.initialize(input);
    const retry = await repository.initialize(input);

    expect(retry).toEqual(first);
    const sessionId = courseStateSessionId({
      stageId: STAGE_ONE,
      learnerId: LEARNER_A,
      courseId: COURSE_ID,
    });
    expect(await store.listRecords(sessionId)).toHaveLength(1);
  });

  it('rejects conflicting initialization keys and never overwrites an existing generation', async () => {
    const { store, repository } = setup();
    const input = partitionInput({ idempotencyKey: 'initialize-a' });
    const first = await repository.initialize(input);

    const altered = partitionInput({
      idempotencyKey: input.idempotencyKey,
      coursePlan: {
        ...input.coursePlan,
        title: 'Algebra (edited during initialization retry)',
        updatedAt: '2026-08-17T03:00:00.000Z',
      },
    });
    await expect(repository.initialize(altered)).rejects.toBeInstanceOf(
      CourseStateSnapshotConflictError,
    );

    await expect(
      repository.initialize(partitionInput({ idempotencyKey: 'initialize-b' })),
    ).rejects.toMatchObject({
      name: 'CourseStateRevisionConflictError',
      expectedRevision: null,
      actualRevision: 0,
    });

    expect(await repository.load()).toEqual(first);
    const sessionId = courseStateSessionId({
      stageId: STAGE_ONE,
      learnerId: LEARNER_A,
      courseId: COURSE_ID,
    });
    expect(await store.listRecords(sessionId)).toHaveLength(1);
  });

  it('returns the winner for concurrent identical initialization and rejects a different winner', async () => {
    const { store, repository } = setup();
    const input = partitionInput({ idempotencyKey: 'initialize-race' });

    const results = await Promise.all([repository.initialize(input), repository.initialize(input)]);
    expect(results[0]).toEqual(results[1]);

    const sessionId = courseStateSessionId({
      stageId: STAGE_ONE,
      learnerId: LEARNER_A,
      courseId: COURSE_ID,
    });
    expect(await store.listRecords(sessionId)).toHaveLength(1);

    const other = await setup({}, `course-state-init-race-${crypto.randomUUID()}`);
    const [winner, loser] = await Promise.allSettled([
      other.repository.initialize(partitionInput({ idempotencyKey: 'initialize-x' })),
      other.repository.initialize(partitionInput({ idempotencyKey: 'initialize-y' })),
    ]);
    expect([winner, loser].filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect([winner, loser].find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(CourseStateRevisionConflictError),
    });
    expect(await other.repository.load()).toBeDefined();
    expect(
      await other.store.listRecords(
        courseStateSessionId({
          stageId: STAGE_ONE,
          learnerId: LEARNER_A,
          courseId: COURSE_ID,
        }),
      ),
    ).toHaveLength(1);
  });

  it('an idempotent retry returns the original record without appending', async () => {
    const { store, repository } = setup();
    const input = partitionInput();

    const first = await repository.save(input);
    const retry = await repository.save(input);

    expect(retry).toEqual(first);
    const sessionId = courseStateSessionId({
      stageId: STAGE_ONE,
      learnerId: LEARNER_A,
      courseId: COURSE_ID,
    });
    expect(await store.listRecords(sessionId)).toHaveLength(1);
  });

  it('conflicting reuse of an idempotency key fails explicitly', async () => {
    const { store, repository } = setup();
    const input = partitionInput();
    await repository.save(input);

    // Same key, different content: a sibling snapshot swapping the plan title
    // must fail loudly instead of overwriting or silently appending.
    const altered = partitionInput({
      coursePlan: {
        ...input.coursePlan,
        title: 'Algebra (edited after snapshot)',
        updatedAt: '2026-08-17T03:00:00.000Z',
      },
    });

    await expect(repository.save(altered)).rejects.toBeInstanceOf(CourseStateSnapshotConflictError);
    expect(altered.idempotencyKey).toBe(input.idempotencyKey);
    const sessionId = courseStateSessionId({
      stageId: STAGE_ONE,
      learnerId: LEARNER_A,
      courseId: COURSE_ID,
    });
    expect(await store.listRecords(sessionId)).toHaveLength(1);
  });

  it('a newer snapshot generation supersedes the previous one on load', async () => {
    const { store, repository } = setup();
    const first = await repository.save(partitionInput({ idempotencyKey: 'gen-1' }));

    const nextPlan = {
      ...first.coursePlan,
      title: 'Algebra (second lesson)',
      updatedAt: '2026-08-17T03:00:00.000Z',
    };
    const second = await repository.save(
      partitionInput({ idempotencyKey: 'gen-2', coursePlan: nextPlan }),
    );

    expect(second.coursePlan.title).toBe('Algebra (second lesson)');
    expect(await repository.load()).toEqual(second);
    const sessionId = courseStateSessionId({
      stageId: STAGE_ONE,
      learnerId: LEARNER_A,
      courseId: COURSE_ID,
    });
    // History is append-only and ordered; both generations remain, latest wins.
    expect(await store.listRecords(sessionId)).toHaveLength(2);
  });

  it('rejects one racing writer that was derived from a stale revision', async () => {
    const { store, repository } = setup();
    await repository.save(partitionInput({ idempotencyKey: 'initial' }), {
      expectedRevision: null,
    });
    const observed = await repository.loadVersioned();
    expect(observed?.revision).toBe(0);
    const first = partitionInput({ idempotencyKey: 'race-a' });
    const second = partitionInput({ idempotencyKey: 'race-b' });

    const results = await Promise.allSettled([
      repository.save(first, { expectedRevision: observed!.revision }),
      repository.save(second, { expectedRevision: observed!.revision }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(CourseStateRevisionConflictError) });
    const sessionId = courseStateSessionId({
      stageId: STAGE_ONE,
      learnerId: LEARNER_A,
      courseId: COURSE_ID,
    });
    expect(await store.listRecords(sessionId)).toHaveLength(2);
  });

  it('stage and learner partitions cannot cross-read', async () => {
    const dbName = `course-state-partitions-${crypto.randomUUID()}`;
    const partitionA = setup({ stageId: STAGE_ONE, learnerId: LEARNER_A }, dbName);
    const otherStage = setup({ stageId: STAGE_TWO, learnerId: LEARNER_A }, dbName);
    const otherLearner = setup({ stageId: STAGE_ONE, learnerId: LEARNER_B }, dbName);

    await partitionA.repository.save(partitionInput());

    await expect(otherStage.repository.load()).resolves.toBeUndefined();
    await expect(otherLearner.repository.load()).resolves.toBeUndefined();
    await expect(partitionA.repository.load()).resolves.toBeDefined();

    // Writing a snapshot that claims a foreign partition fails explicitly.
    await expect(
      otherStage.repository.save(
        makeCourseSnapshotInput({
          idempotencyKey: 'foreign-partition-write',
          learnerId: LEARNER_A,
          stageId: STAGE_ONE,
        }),
      ),
    ).rejects.toBeInstanceOf(CourseStatePartitionError);
  });

  it('restore returns the classroom recovery point and requeued tasks from the store', async () => {
    const { repository } = setup();
    await repository.save(partitionInput());

    const recovery = await repository.restore();

    expect(recovery!.classroomRecoveryPoint).toEqual({
      currentNodeId: 'node:lesson-1-b',
      lastSequence: 1,
    });
    expect(recovery!.assistantTasks.list().some((task) => task.status === 'queued')).toBe(true);
    expect(
      recovery!.assistantTasks.list().filter((task) => task.status === 'succeeded'),
    ).toHaveLength(1);
  });
});

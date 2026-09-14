import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it, vi } from 'vitest';

import { coursePlanSchema, teachingAdjustmentSchema } from '@/lib/livecourse/domain';
import {
  createCourseStateRepository,
  courseStateSessionId,
} from '@/lib/livecourse/session/course-state-repository';
import {
  buildCourseStateSnapshot,
  CourseStateAdjustmentError,
  CourseStatePartitionError,
  CourseStateValidationError,
  recoverCourseState,
} from '@/lib/livecourse/session/course-state-snapshot';

import {
  approvedCourseChange,
  assistantTaskLifecycle,
  COURSE_ID,
  DECISION_NOW,
  evidenceLedger,
  FIXED_NOW,
  lessonOneClassroomHistory,
  makeCourseSnapshotInput,
  undecidedAdjustments,
} from './course-state-fixture';

function setup(dbName = `course-recovery-${crypto.randomUUID()}`) {
  const store = new BrowserRuntimeStore({ dbName });
  const repository = createCourseStateRepository({
    store,
    stageId: 'stage-1',
    learnerId: 'learner-1',
    courseId: COURSE_ID,
    now: () => FIXED_NOW,
  });
  return { store, repository };
}

describe('cross-lesson course recovery (P-004)', () => {
  it('restores every component from one snapshot and requeues running assistant work', async () => {
    const { store, repository } = setup();
    const input = makeCourseSnapshotInput();
    const taskSnapshot = assistantTaskLifecycle();
    const runningId = taskSnapshot.tasks.find((task) => task.status === 'running')!.id;
    const succeededId = taskSnapshot.tasks.find((task) => task.status === 'succeeded')!.id;
    const cancelledId = taskSnapshot.tasks.find((task) => task.status === 'cancelled')!.id;

    const saved = await repository.save(input);
    expect(saved.schemaVersion).toBe(1);
    expect(saved.coursePlan.version).toBe(4);

    const recovered = await repository.restore();
    expect(recovered).toBeDefined();
    const recovery = recovered!;

    // Course plan, evidence and adjustments survive byte-for-byte.
    expect(recovery.coursePlan).toEqual(input.coursePlan);
    expect(recovery.evidence).toEqual(input.evidence);
    expect(recovery.adjustments).toEqual(input.adjustments);
    expect(recovery.appliedAdjustments).toEqual(input.adjustments);

    // Classroom recovery point folds from the committed actions only.
    expect(recovery.classroomRecoveryPoint).toEqual({
      currentNodeId: 'node:lesson-1-b',
      lastSequence: 1,
    });
    expect(recovery.teachingActions.actions).toEqual(input.teachingActions.actions);
    expect(recovery.lessonId).toBe('lesson-1');

    // Assistant task lifecycle: terminal states stay terminal, running work is
    // explicitly requeued, queued work stays queued.
    expect(recovery.assistantTasks.get(succeededId).status).toBe('succeeded');
    expect(recovery.assistantTasks.get(cancelledId).status).toBe('cancelled');
    expect(recovery.assistantTasks.get(runningId).status).toBe('queued');
    expect(recovery.assistantTasks.snapshot().events.at(-1)).toMatchObject({
      type: 'requeued',
      to: 'queued',
    });

    // One durable record; nothing was replayed or appended by recovery.
    const sessionId = courseStateSessionId({
      stageId: 'stage-1',
      learnerId: 'learner-1',
      courseId: COURSE_ID,
    });
    expect(await store.listRecords(sessionId)).toHaveLength(1);
  });

  it('a repeated restore does not dispatch or duplicate actions/events', async () => {
    const { store, repository } = setup();
    const saved = await repository.save(makeCourseSnapshotInput());

    const appendRecord = vi.spyOn(store, 'appendRecord');
    const createSession = vi.spyOn(store, 'createSession');

    // Two independent recoveries of the SAME snapshot with a fixed clock are
    // byte-identical: the requeue event exists once per recovery and never
    // accumulates, and no action is ever replayed or appended.
    const first = recoverCourseState(saved, { now: () => FIXED_NOW });
    const second = recoverCourseState(saved, { now: () => FIXED_NOW });
    expect(second.assistantTasks.snapshot()).toEqual(first.assistantTasks.snapshot());
    expect(second.teachingActions.actions).toEqual(first.teachingActions.actions);
    expect(second.classroomRecoveryPoint).toEqual(first.classroomRecoveryPoint);

    // The repository boundary stays a pure read path during restore.
    await repository.restore();
    await repository.restore();
    expect(appendRecord).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();

    const sessionId = courseStateSessionId({
      stageId: 'stage-1',
      learnerId: 'learner-1',
      courseId: COURSE_ID,
    });
    expect(await store.listRecords(sessionId)).toHaveLength(1);
  });

  it('excludes pending and rejected adjustments from the applied course changes', async () => {
    const { repository } = setup();
    const { adjustment } = approvedCourseChange();
    const [pending, rejected] = undecidedAdjustments();
    const input = makeCourseSnapshotInput({ adjustments: [adjustment, pending, rejected] });

    const saved = await repository.save(input);
    expect(saved.adjustments).toHaveLength(3);

    const recovered = await repository.restore();
    // History is preserved exactly; only the approved record is applied.
    expect(recovered!.adjustments).toEqual([adjustment, pending, rejected]);
    expect(recovered!.appliedAdjustments).toEqual([adjustment]);
  });

  it('fails closed on an approved adjustment that cannot match the recovered plan context', async () => {
    const { repository } = setup();
    // A phantom approval: the recovered plan sits at the adjustment's own
    // target version, so the approval could never have produced it.
    const { coursePlan, adjustment: approved } = approvedCourseChange();
    const phantom = teachingAdjustmentSchema.parse({
      ...approved,
      id: 'adjustment:phantom',
      idempotencyKey: 'course-adjustment:phantom',
      coursePlanVersion: coursePlan.version,
      decidedAt: DECISION_NOW,
    });

    await expect(
      repository.save(makeCourseSnapshotInput({ coursePlan, adjustments: [phantom] })),
    ).rejects.toBeInstanceOf(CourseStateAdjustmentError);
    await expect(repository.load()).resolves.toBeUndefined();
  });

  it('fails closed on an approved adjustment from a different course', async () => {
    const { repository } = setup();
    const { coursePlan, adjustment: approved } = approvedCourseChange();
    const otherCourse = coursePlanSchema.parse({ ...coursePlan, courseId: 'course:physics' });
    const fromOtherCourse = teachingAdjustmentSchema.parse({
      ...approved,
      id: 'adjustment:other-course',
      idempotencyKey: 'course-adjustment:other-course',
      courseId: 'course:physics',
    });

    await expect(
      repository.save(
        makeCourseSnapshotInput({ coursePlan: otherCourse, adjustments: [fromOtherCourse] }),
      ),
    ).rejects.toBeInstanceOf(CourseStateAdjustmentError);
  });

  it('recovery refuses a partition that does not own the snapshot', async () => {
    const { repository } = setup();
    const saved = await repository.save(makeCourseSnapshotInput());

    expect(() => recoverCourseState(saved, { stageId: 'stage-2' })).toThrow(
      CourseStatePartitionError,
    );
    expect(() => recoverCourseState(saved, { learnerId: 'learner-2' })).toThrow(
      CourseStatePartitionError,
    );
  });

  it('a save with a foreign partition fails explicitly at the write boundary', async () => {
    const { repository } = setup();
    // The pure builder accepts any partition; the repository owns the gate.
    expect(() =>
      buildCourseStateSnapshot({
        ...makeCourseSnapshotInput({ idempotencyKey: 'snapshot-key-foreign' }),
        stageId: 'stage-9',
      }),
    ).not.toThrow();
    await expect(
      repository.save(
        makeCourseSnapshotInput({ idempotencyKey: 'snapshot-key-foreign', stageId: 'stage-9' }),
      ),
    ).rejects.toBeInstanceOf(CourseStatePartitionError);
  });

  it('fails loud instead of falling back to an empty snapshot when stored data is corrupt', async () => {
    const { store, repository } = setup();
    await repository.save(makeCourseSnapshotInput());
    const sessionId = courseStateSessionId({
      stageId: 'stage-1',
      learnerId: 'learner-1',
      courseId: COURSE_ID,
    });
    const [stored] = await store.listRecords(sessionId);
    await store.appendRecord({
      id: 'corrupt-snapshot',
      sessionId,
      createdAt: FIXED_NOW,
      payload: {
        ...(stored!.payload as Record<string, unknown>),
        id: 'corrupt-snapshot',
        idempotencyKey: 'corrupt-snapshot',
        evidence: [
          {
            ...((
              (stored!.payload as { evidence: unknown[] }).evidence as Record<string, unknown>[]
            )[0] as Record<string, unknown>),
            learnerId: 'learner-2',
          },
        ],
      },
    });

    // The tampered latest generation fails validation loud; no empty substitute.
    await expect(repository.load()).rejects.toBeInstanceOf(CourseStateValidationError);
  });
});

import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it } from 'vitest';

import {
  EvidenceConflictError,
  projectGoalState,
  teachingActionSchema,
  teachingAdjustmentSchema,
} from '@/lib/livecourse/domain';
import {
  CourseAdjustmentError,
  materializeImmediateAction,
  TeachingAdjustmentEngine,
} from '@/lib/livecourse/domain/teaching-adjustment';
import {
  createTeachingActionRepository,
  type TeachingActionRepository,
} from '@/lib/livecourse/session/action-repository';
import { createClassroomController } from '@/lib/livecourse/session/controller';

import { makeAdjustmentCoursePlan, makeEvidenceRecord } from './evidence-fixture';

const FIXED_NOW = '2026-08-17T01:00:00.000Z';

function projectedGoalState(evidence: ReturnType<typeof makeEvidenceRecord>[]) {
  const plan = makeAdjustmentCoursePlan();
  const goal = plan.goals.find((candidate) => candidate.id === 'goal:one')!;
  return projectGoalState({
    courseId: plan.courseId,
    learnerId: 'learner-1',
    goalId: goal.id,
    rule: goal.rule,
    evidence,
  });
}

function metInput() {
  const plan = makeAdjustmentCoursePlan();
  const evidence = [
    makeEvidenceRecord({
      id: 'evidence-1',
      courseId: plan.courseId,
      lessonId: 'lesson-1',
      goalId: 'goal:one',
      nodeId: 'node:lesson-1-a',
      score: 0.9,
      occurredAt: '2026-08-10T08:00:00.000Z',
      idempotencyKey: 'attempt-1',
    }),
  ];
  return { coursePlan: plan, evidence, goalStates: [projectedGoalState(evidence)] };
}

describe('teaching adjustment engine', () => {
  it('produces byte-equivalent course proposals for the same inputs and injected time', () => {
    const engine = new TeachingAdjustmentEngine({ now: () => FIXED_NOW });
    const input = metInput();

    const first = engine.proposeCourseAdjustments(input);
    const second = engine.proposeCourseAdjustments(input);

    expect(first).toHaveLength(1);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first[0]!.id).toBe(second[0]!.id);
    expect(first[0]!.idempotencyKey).toBe(second[0]!.idempotencyKey);
    teachingAdjustmentSchema.parse(first[0]!);
  });

  it('keeps stable ids and idempotency keys across injected time changes', () => {
    const engineAtTimeA = new TeachingAdjustmentEngine({ now: () => '2026-08-17T01:00:00.000Z' });
    const engineAtTimeB = new TeachingAdjustmentEngine({ now: () => '2026-08-17T09:00:00.000Z' });
    const input = metInput();

    const a = engineAtTimeA.proposeCourseAdjustments(input);
    const b = engineAtTimeB.proposeCourseAdjustments(input);

    expect(a[0]!.id).toBe(b[0]!.id);
    expect(a[0]!.idempotencyKey).toBe(b[0]!.idempotencyKey);
    expect(a[0]!.createdAt).not.toBe(b[0]!.createdAt);
  });

  it('identifies the accepted evidence and goal states in the proposal basis', () => {
    const engine = new TeachingAdjustmentEngine({ now: () => FIXED_NOW });
    const { coursePlan: plan, evidence } = metInput();
    const proposal = engine.proposeCourseAdjustments({
      coursePlan: plan,
      goalStates: [projectedGoalState(evidence)],
      evidence,
    })[0]!;

    expect(proposal.basis.evidenceIds).toEqual(['evidence-1']);
    expect(proposal.basis.goalStateIds).toEqual(['goal:one']);
    expect(proposal.basis.rationale.length).toBeLessThanOrEqual(4000);
    expect(proposal.basis.rationale).toContain('goal:one');
    expect(proposal.recommendation.revision).toEqual({
      kind: 'add_checkpoint',
      checkpoint: {
        id: 'checkpoint:course:algebra:goal:one:node:lesson-1-b',
        nodeId: 'node:lesson-1-b',
        goalIds: ['goal:one'],
        required: true,
      },
    });
    expect(proposal.approvalStatus).toBe('pending');
    expect(proposal.decidedAt).toBeUndefined();
    expect(proposal.decidedBy).toBeUndefined();
  });

  it('never mutates the supplied CoursePlan when proposing', () => {
    const engine = new TeachingAdjustmentEngine({ now: () => FIXED_NOW });
    const { coursePlan: plan, evidence } = metInput();
    const snapshot = JSON.stringify(plan);

    engine.proposeCourseAdjustments({
      coursePlan: plan,
      goalStates: [projectedGoalState(evidence)],
      evidence,
    });

    expect(JSON.stringify(plan)).toBe(snapshot);
    expect(plan.version).toBe(3);
  });

  it('emits an existing valid TeachingAction for an immediate advance with stable idempotency', async () => {
    const engine = new TeachingAdjustmentEngine({ now: () => FIXED_NOW });
    const { coursePlan: plan, evidence } = metInput();
    const drafts = engine.deriveImmediateActions({
      coursePlan: plan,
      goalStates: [projectedGoalState(evidence)],
      evidence,
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      kind: 'advance',
      sourceNodeId: 'node:lesson-1-a',
      targetLessonId: 'lesson-1',
      targetNodeId: 'node:lesson-1-b',
      sceneId: 'scene:lesson-1-b',
    });

    const action = materializeImmediateAction({
      courseId: plan.courseId,
      lessonId: 'lesson-1',
      draft: drafts[0]!,
      sequence: 0,
      timestamp: FIXED_NOW,
    });
    teachingActionSchema.parse(action);
    expect(action.type).toBe('lesson.goto_node');
    expect(action).toMatchObject({
      idempotencyKey:
        'adjustment-immediate:advance:course:algebra:3:node:lesson-1-a:node:lesson-1-b',
      sequence: 0,
    });

    // Deterministic identity: materializing again produces the same action.
    const actionAgain = materializeImmediateAction({
      courseId: plan.courseId,
      lessonId: 'lesson-1',
      draft: drafts[0]!,
      sequence: 0,
      timestamp: FIXED_NOW,
    });
    expect(actionAgain).toEqual(action);

    // Suitable for ClassroomController dispatch (existing boundary only).
    const repository: TeachingActionRepository = createTeachingActionRepository({
      store: new BrowserRuntimeStore({ dbName: `adjustment-${crypto.randomUUID()}` }),
      stageId: 'stage-1',
      learnerId: 'learner-1',
      courseId: plan.courseId,
      lessonId: 'lesson-1',
    });
    const controller = createClassroomController({
      repository,
      applyPresentation: () => ({ success: true, data: { handled: true } }),
      publish: () => undefined,
    });
    await controller.load();
    const result = await controller.dispatch(action);
    expect(result).toMatchObject({
      duplicate: false,
      presentationHandled: true,
      recoveryPoint: { currentNodeId: 'node:lesson-1-b', lastSequence: 0 },
    });
  });

  it('emits a remediate draft that reopens the failing checkpoint', () => {
    const engine = new TeachingAdjustmentEngine({ now: () => FIXED_NOW });
    const plan = makeAdjustmentCoursePlan();
    const evidence = [
      makeEvidenceRecord({
        id: 'evidence-fail',
        courseId: plan.courseId,
        lessonId: 'lesson-1',
        goalId: 'goal:one',
        nodeId: 'node:lesson-1-a',
        score: 0.4,
        occurredAt: '2026-08-10T08:00:00.000Z',
        idempotencyKey: 'attempt-fail',
      }),
    ];
    const goalStates = [projectedGoalState(evidence)];
    expect(goalStates[0]!.status).toBe('needs_support');

    const drafts = engine.deriveImmediateActions({ coursePlan: plan, goalStates, evidence });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      kind: 'remediate',
      sourceNodeId: 'node:lesson-1-a',
      checkpointId: 'checkpoint:lesson-1-a',
    });

    const action = materializeImmediateAction({
      courseId: plan.courseId,
      lessonId: 'lesson-1',
      draft: drafts[0]!,
      sequence: 0,
      timestamp: FIXED_NOW,
    });
    teachingActionSchema.parse(action);
    expect(action.type).toBe('checkpoint.open');
    expect(action.payload).toEqual({ checkpointId: 'checkpoint:lesson-1-a' });

    // The unmet goal also yields a course-level support proposal on the next node.
    const proposals = engine.proposeCourseAdjustments({ coursePlan: plan, goalStates, evidence });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.recommendation.revision).toMatchObject({
      kind: 'add_checkpoint',
      checkpoint: { nodeId: 'node:lesson-1-b', goalIds: ['goal:one'] },
    });
  });

  it('returns nothing without accepted evidence', () => {
    const engine = new TeachingAdjustmentEngine({ now: () => FIXED_NOW });
    const plan = makeAdjustmentCoursePlan();

    expect(
      engine.proposeCourseAdjustments({
        coursePlan: plan,
        goalStates: [],
        evidence: [],
      }),
    ).toEqual([]);
    expect(
      engine.deriveImmediateActions({
        coursePlan: plan,
        goalStates: [],
        evidence: [],
      }),
    ).toEqual([]);
  });

  it('rejects conflicting evidence deterministically instead of guessing', () => {
    const engine = new TeachingAdjustmentEngine({ now: () => FIXED_NOW });
    const plan = makeAdjustmentCoursePlan();
    const conflicting = [
      makeEvidenceRecord({ id: 'evidence-1' }),
      makeEvidenceRecord({ id: 'evidence-2', score: 0.2, idempotencyKey: 'attempt-1' }),
    ];

    expect(() =>
      engine.proposeCourseAdjustments({
        coursePlan: plan,
        goalStates: [projectedGoalState(conflicting)],
        evidence: conflicting,
      }),
    ).toThrow(EvidenceConflictError);
  });

  it('materializing an incomplete draft fails loudly', () => {
    expect(() =>
      materializeImmediateAction({
        courseId: 'course:algebra',
        lessonId: 'lesson-1',
        draft: {
          kind: 'advance',
          sourceNodeId: 'node:lesson-1-a',
          targetLessonId: 'lesson-1',
          sceneId: 'scene:lesson-1-a',
          idempotencyKey: 'adjustment-immediate:advance:broken',
        },
        sequence: 0,
        timestamp: FIXED_NOW,
      }),
    ).toThrow(CourseAdjustmentError);
  });
});

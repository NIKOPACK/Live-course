import { describe, expect, it } from 'vitest';

import {
  coursePlanSchema,
  projectGoalState,
  teachingAdjustmentSchema,
  type TeachingAdjustment,
} from '@/lib/livecourse/domain';
import {
  approveCourseAdjustment,
  CourseAdjustmentContextError,
  CourseAdjustmentStalePlanError,
  CourseAdjustmentStateError,
  rejectCourseAdjustment,
  TeachingAdjustmentEngine,
} from '@/lib/livecourse/domain/teaching-adjustment';

import { makeAdjustmentCoursePlan, makeEvidenceRecord } from './evidence-fixture';

const FIXED_NOW = '2026-08-17T01:00:00.000Z';
const DECISION_NOW = '2026-08-17T02:00:00.000Z';

function buildPendingProposal(): TeachingAdjustment {
  const engine = new TeachingAdjustmentEngine({ now: () => FIXED_NOW });
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
  const goal = plan.goals.find((candidate) => candidate.id === 'goal:one')!;
  const state = projectGoalState({
    courseId: plan.courseId,
    learnerId: 'learner-1',
    goalId: goal.id,
    rule: goal.rule,
    evidence,
  });
  return engine.proposeCourseAdjustments({ coursePlan: plan, goalStates: [state], evidence })[0]!;
}

describe('course-level adjustment approval', () => {
  it('leaves the CoursePlan unchanged before any teacher decision', () => {
    const engine = new TeachingAdjustmentEngine({ now: () => FIXED_NOW });
    const plan = makeAdjustmentCoursePlan();
    const evidence = [
      makeEvidenceRecord({
        courseId: plan.courseId,
        lessonId: 'lesson-1',
        goalId: 'goal:one',
        nodeId: 'node:lesson-1-a',
        score: 0.9,
      }),
    ];
    const goal = plan.goals.find((candidate) => candidate.id === 'goal:one')!;
    const snapshot = JSON.stringify(plan);

    const proposals = engine.proposeCourseAdjustments({
      coursePlan: plan,
      goalStates: [
        projectGoalState({
          courseId: plan.courseId,
          learnerId: 'learner-1',
          goalId: goal.id,
          rule: goal.rule,
          evidence,
        }),
      ],
      evidence,
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.approvalStatus).toBe('pending');
    expect(JSON.stringify(plan)).toBe(snapshot);
  });

  it('only a valid teacher approval produces a new higher plan version', () => {
    const plan = makeAdjustmentCoursePlan();
    const proposal = buildPendingProposal();

    const next = approveCourseAdjustment({
      adjustment: proposal,
      coursePlan: plan,
      decidedBy: 'teacher:1',
      now: () => DECISION_NOW,
    });

    expect(next.version).toBe(4);
    expect(next.courseId).toBe(plan.courseId);
    expect(next.status).toBe('approved');
    expect(next.updatedAt).toBe(DECISION_NOW);
    expect(next.checkpointRules).toEqual([
      ...plan.checkpointRules,
      proposal.recommendation.revision!.checkpoint,
    ]);
    coursePlanSchema.parse(next);

    // The caller's plan is untouched.
    expect(plan.version).toBe(3);
    expect(plan.updatedAt).toBe('2026-08-17T00:00:00.000Z');
    expect(plan.checkpointRules).toHaveLength(1);
  });

  it('stale proposals fail without changing the current plan', () => {
    const plan = makeAdjustmentCoursePlan();
    const proposal = buildPendingProposal();
    const next = approveCourseAdjustment({
      adjustment: proposal,
      coursePlan: plan,
      decidedBy: 'teacher:1',
      now: () => DECISION_NOW,
    });

    expect(() =>
      approveCourseAdjustment({
        adjustment: proposal,
        coursePlan: next,
        decidedBy: 'teacher:1',
        now: () => DECISION_NOW,
      }),
    ).toThrow(CourseAdjustmentStalePlanError);
    expect(next.version).toBe(4);
    expect(next.checkpointRules).toHaveLength(2);
  });

  it('rejects proposals for the wrong course', () => {
    const plan = makeAdjustmentCoursePlan();
    const proposal = buildPendingProposal();
    const otherCourse = coursePlanSchema.parse({ ...plan, courseId: 'course:other' });

    expect(() =>
      approveCourseAdjustment({
        adjustment: proposal,
        coursePlan: otherCourse,
        decidedBy: 'teacher:1',
        now: () => DECISION_NOW,
      }),
    ).toThrow(CourseAdjustmentContextError);
  });

  it('refuses to decide an adjustment that is not pending', () => {
    const plan = makeAdjustmentCoursePlan();
    const proposal = buildPendingProposal();
    const rejected = rejectCourseAdjustment({
      adjustment: proposal,
      decidedBy: 'teacher:1',
      now: () => DECISION_NOW,
    });

    expect(() =>
      approveCourseAdjustment({
        adjustment: rejected,
        coursePlan: plan,
        decidedBy: 'teacher:1',
        now: () => DECISION_NOW,
      }),
    ).toThrow(CourseAdjustmentStateError);
    expect(() => rejectCourseAdjustment({ adjustment: rejected, decidedBy: 'teacher:2' })).toThrow(
      CourseAdjustmentStateError,
    );
  });

  it('requires a typed revision — arbitrary patches are not accepted', () => {
    const plan = makeAdjustmentCoursePlan();
    const noRevision = teachingAdjustmentSchema.parse({
      schemaVersion: 1,
      id: 'adjustment:noop',
      courseId: 'course:algebra',
      coursePlanVersion: 3,
      targetLessonIds: ['lesson-2'],
      targetNodeIds: ['node:lesson-2-a'],
      basis: {
        evidenceIds: ['evidence-1'],
        goalStateIds: ['goal:one'],
        rationale: 'Review pacing for the applications lesson.',
      },
      recommendation: {
        kind: 'change_pacing',
        summary: 'Allow more practice time.',
      },
      approvalStatus: 'pending',
      idempotencyKey: 'course-adjustment:noop',
      createdAt: FIXED_NOW,
    });

    expect(() =>
      approveCourseAdjustment({
        adjustment: noRevision,
        coursePlan: plan,
        decidedBy: 'teacher:1',
        now: () => DECISION_NOW,
      }),
    ).toThrow(/no typed plan revision/);
    expect(plan.version).toBe(3);
  });

  it('rejection preserves the plan and records decider and timestamp', () => {
    const plan = makeAdjustmentCoursePlan();
    const proposal = buildPendingProposal();
    const snapshot = JSON.stringify(plan);

    const rejected = rejectCourseAdjustment({
      adjustment: proposal,
      decidedBy: 'teacher:1',
      now: () => DECISION_NOW,
    });

    expect(rejected.approvalStatus).toBe('rejected');
    expect(rejected.decidedAt).toBe(DECISION_NOW);
    expect(rejected.decidedBy).toBe('teacher:1');
    teachingAdjustmentSchema.parse(rejected);
    expect(JSON.stringify(plan)).toBe(snapshot);
  });

  it('schema requires decision fields on decided adjustments and forbids them while pending', () => {
    const base = {
      schemaVersion: 1,
      id: 'adjustment:decision-schema',
      courseId: 'course:algebra',
      coursePlanVersion: 3,
      targetLessonIds: ['lesson-2'],
      targetNodeIds: ['node:lesson-2-a'],
      basis: {
        evidenceIds: ['evidence-1'],
        goalStateIds: ['goal:one'],
        rationale: 'Retention checkpoint for goal:one.',
      },
      recommendation: {
        kind: 'add_checkpoint',
        summary: 'Confirm goal:one retention.',
        revision: {
          kind: 'add_checkpoint',
          checkpoint: {
            id: 'checkpoint:decision-schema',
            nodeId: 'node:lesson-2-a',
            goalIds: ['goal:one'],
            required: true,
          },
        },
      },
      idempotencyKey: 'course-adjustment:decision-schema',
      createdAt: FIXED_NOW,
    } as const;

    expect(() =>
      teachingAdjustmentSchema.parse({ ...base, approvalStatus: 'pending' }),
    ).not.toThrow();
    expect(() =>
      teachingAdjustmentSchema.parse({
        ...base,
        approvalStatus: 'pending',
        decidedAt: DECISION_NOW,
      }),
    ).toThrow(/cannot have decidedAt/);
    expect(() =>
      teachingAdjustmentSchema.parse({
        ...base,
        approvalStatus: 'pending',
        decidedBy: 'teacher:1',
      }),
    ).toThrow(/cannot have decidedBy/);
    expect(() =>
      teachingAdjustmentSchema.parse({
        ...base,
        approvalStatus: 'approved',
        decidedBy: 'teacher:1',
      }),
    ).toThrow(/require decidedAt/);
    expect(() =>
      teachingAdjustmentSchema.parse({
        ...base,
        approvalStatus: 'approved',
        decidedAt: DECISION_NOW,
      }),
    ).toThrow(/require decidedBy/);
    expect(() =>
      teachingAdjustmentSchema.parse({
        ...base,
        approvalStatus: 'approved',
        decidedAt: DECISION_NOW,
        decidedBy: 'teacher:1',
      }),
    ).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';

import {
  EvidenceConflictError,
  evidenceRecordSchema,
  projectGoalState,
  type EvidenceRecord,
  type GoalRule,
} from '@/lib/livecourse/domain';

const rule: GoalRule = {
  version: 'rule-v1',
  passScore: 0.7,
  minAcceptedEvidence: 2,
  minPassingEvidence: 2,
};

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return evidenceRecordSchema.parse({
    schemaVersion: 1,
    id: 'evidence-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    learnerId: 'learner-1',
    goalId: 'goal-1',
    nodeId: 'node-1',
    source: 'checkpoint',
    kind: 'objective_score',
    status: 'accepted',
    score: 0.8,
    occurredAt: '2026-08-10T08:00:00.000Z',
    idempotencyKey: 'attempt-1',
    evaluation: { method: 'deterministic', ruleVersion: 'choice-v1' },
    ...overrides,
  });
}

describe('LiveCourse evidence projection', () => {
  it('projects the same state regardless of evidence order', () => {
    const first = evidence();
    const second = evidence({
      id: 'evidence-2',
      idempotencyKey: 'attempt-2',
      score: 0.9,
      occurredAt: '2026-08-10T08:05:00.000Z',
    });

    const forward = projectGoalState({
      courseId: 'course-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      rule,
      evidence: [first, second],
    });
    const reverse = projectGoalState({
      courseId: 'course-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      rule,
      evidence: [second, first],
    });

    expect(reverse).toEqual(forward);
    expect(forward.status).toBe('met');
    expect(forward.averageScore).toBeCloseTo(0.85);
  });

  it('keeps pending model evidence out of mastery counts', () => {
    const state = projectGoalState({
      courseId: 'course-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      rule,
      evidence: [
        evidence({
          status: 'pending_review',
          kind: 'rubric_score',
          evaluation: {
            method: 'model',
            modelId: 'configured-model',
            rubricVersion: 'rubric-v1',
            inputSummary: 'One short answer was graded by a model.',
            confidence: 0,
            reviewStatus: 'pending',
          },
        }),
      ],
    });

    expect(state.status).toBe('in_progress');
    expect(state.acceptedEvidenceCount).toBe(0);
    expect(state.pendingReviewCount).toBe(1);
  });

  it('marks a completed but below-threshold goal as needing support', () => {
    const state = projectGoalState({
      courseId: 'course-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      rule,
      evidence: [
        evidence({ score: 0.4 }),
        evidence({
          id: 'evidence-2',
          idempotencyKey: 'attempt-2',
          score: 0.6,
          occurredAt: '2026-08-10T08:05:00.000Z',
        }),
      ],
    });

    expect(state.status).toBe('needs_support');
    expect(state.passingEvidenceCount).toBe(0);
  });

  it('deduplicates exact retries and rejects conflicting idempotency reuse', () => {
    const original = evidence();
    const duplicate = evidence();
    const state = projectGoalState({
      courseId: 'course-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      rule,
      evidence: [original, duplicate],
    });
    expect(state.evidenceIds).toEqual(['evidence-1']);

    expect(() =>
      projectGoalState({
        courseId: 'course-1',
        learnerId: 'learner-1',
        goalId: 'goal-1',
        rule,
        evidence: [
          original,
          evidence({ id: 'evidence-2', score: 0.2, idempotencyKey: 'attempt-1' }),
        ],
      }),
    ).toThrow(EvidenceConflictError);
  });

  it('never projects met from rejected evidence alone', () => {
    const state = projectGoalState({
      courseId: 'course-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      rule,
      evidence: [
        evidence({
          status: 'rejected',
          score: undefined,
          source: 'teacher_review',
          kind: 'rubric_score',
          evaluation: { method: 'human', reviewerId: 'teacher:1' },
          metadata: { decision: 'rejected' },
        }),
      ],
    });

    expect(state.status).not.toBe('met');
    expect(state.acceptedEvidenceCount).toBe(0);
    expect(state.passingEvidenceCount).toBe(0);
  });

  it('never projects met from self-report evidence', () => {
    const pendingSelfReport = projectGoalState({
      courseId: 'course-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      rule,
      evidence: [
        evidence({
          kind: 'self_report',
          status: 'pending_review',
          evaluation: { method: 'human', reviewerId: 'teacher:1' },
        }),
        evidence({ id: 'evidence-2', idempotencyKey: 'attempt-2', score: 0.9 }),
      ],
    });
    expect(pendingSelfReport.status).not.toBe('met');
    expect(pendingSelfReport.acceptedEvidenceCount).toBe(1);

    expect(() =>
      evidenceRecordSchema.parse(
        evidence({ kind: 'self_report', status: 'accepted', id: 'evidence-9' }),
      ),
    ).toThrow(/Self reports cannot be accepted/);
  });

  it('treats a teacher-reviewed pending record as resolved, not pending', () => {
    const pending = evidence({
      id: 'evidence:pending',
      idempotencyKey: 'pbl-eval:1',
      status: 'pending_review',
      kind: 'rubric_score',
      evaluation: {
        method: 'model',
        modelId: 'evaluator-model',
        rubricVersion: 'pbl-rubric-v1',
        inputSummary: 'PBL task summary.',
        confidence: 0,
        reviewStatus: 'pending',
      },
    });
    const approved = evidence({
      id: 'evidence:review',
      idempotencyKey: 'teacher-review:evidence:pending',
      source: 'teacher_review',
      kind: 'rubric_score',
      status: 'accepted',
      score: 0.8,
      occurredAt: '2026-08-10T08:10:00.000Z',
      evaluation: { method: 'human', reviewerId: 'teacher:1' },
      metadata: {
        reviewedEvidenceId: 'evidence:pending',
        reviewedIdempotencyKey: 'pbl-eval:1',
        decision: 'accepted',
      },
    });
    const singlePassRule: GoalRule = {
      version: 'rule-v3',
      passScore: 0.7,
      minAcceptedEvidence: 1,
      minPassingEvidence: 1,
    };

    const decided = projectGoalState({
      courseId: 'course-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      rule: singlePassRule,
      evidence: [pending, approved],
    });
    expect(decided.status).toBe('met');
    expect(decided.pendingReviewCount).toBe(0);
    expect(decided.acceptedEvidenceCount).toBe(1);

    const stillPending = projectGoalState({
      courseId: 'course-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      rule: singlePassRule,
      evidence: [pending],
    });
    expect(stillPending.status).not.toBe('met');
    expect(stillPending.pendingReviewCount).toBe(1);
  });

  it('keeps pending and rejected evidence out of mastery even with other accepted records', () => {
    const state = projectGoalState({
      courseId: 'course-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      rule: {
        version: 'rule-v2',
        passScore: 0.7,
        minAcceptedEvidence: 2,
        minPassingEvidence: 2,
      },
      evidence: [
        evidence({ score: 0.9 }),
        evidence({
          id: 'evidence:model',
          idempotencyKey: 'model-1',
          status: 'pending_review',
          kind: 'rubric_score',
          evaluation: {
            method: 'model',
            modelId: 'configured-model',
            rubricVersion: 'rubric-v1',
            inputSummary: 'One short answer was graded by a model.',
            confidence: 0,
            reviewStatus: 'pending',
          },
        }),
        evidence({
          id: 'evidence:rejected',
          idempotencyKey: 'rejected-1',
          status: 'rejected',
          score: undefined,
          source: 'teacher_review',
          kind: 'rubric_score',
          evaluation: { method: 'human', reviewerId: 'teacher:1' },
          metadata: { decision: 'rejected' },
        }),
      ],
    });

    expect(state.status).not.toBe('met');
    expect(state.acceptedEvidenceCount).toBe(1);
    expect(state.pendingReviewCount).toBe(1);
  });
});

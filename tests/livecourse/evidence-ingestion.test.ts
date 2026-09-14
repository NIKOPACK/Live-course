import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it } from 'vitest';

import { evidenceRecordSchema, projectGoalState, type GoalRule } from '@/lib/livecourse/domain';
import {
  EvidenceContextMismatchError,
  EvidenceIngestionService,
  EvidenceReviewTargetError,
} from '@/lib/livecourse/evidence/ingestion';
import { createRuntimeEvidenceLedger } from '@/lib/livecourse/evidence/runtime-port';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';

import { createFakeEvidenceLedger } from './evidence-fixture';

const RULE: GoalRule = {
  version: 'rule:v1',
  passScore: 0.7,
  minAcceptedEvidence: 1,
  minPassingEvidence: 1,
};

const SCOPE = { stageId: 'stage-1', learnerId: 'learner-1' };

function runtimeLedger(dbName: string) {
  return createRuntimeEvidenceLedger({
    store: new BrowserRuntimeStore({
      dbName,
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    }),
  });
}

describe('unified LiveCourse evidence ingestion boundary', () => {
  it('fails closed before appending when the owning session is disabled', async () => {
    let active = true;
    const store = new BrowserRuntimeStore({
      dbName: `evidence-lifecycle-${crypto.randomUUID()}`,
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
    const service = new EvidenceIngestionService(
      createRuntimeEvidenceLedger({
        store,
        assertActive: () => {
          if (!active) throw new Error('session expired');
        },
      }),
      { now: () => '2026-08-10T08:00:00.000Z' },
    );

    active = false;
    await expect(
      service.ingestCheckpoint({
        scope: SCOPE,
        courseId: 'course-1',
        lessonId: 'lesson-1',
        learnerId: 'learner-1',
        goalId: 'goal-1',
        nodeId: 'node:quiz-1',
        attemptId: 'expired-attempt',
        score: 1,
        gradedByModel: false,
      }),
    ).rejects.toThrow('session expired');
    await expect(store.listSessions(SCOPE.stageId, SCOPE.learnerId)).resolves.toEqual([]);
  });

  it('routes deterministic checkpoint results through the injected writer as accepted', async () => {
    const ledger = createFakeEvidenceLedger();
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-10T08:00:00.000Z',
    });

    const record = await service.ingestCheckpoint({
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:quiz-1',
      attemptId: 'attempt-1',
      score: 0.8,
      gradedByModel: false,
    });

    expect(record.status).toBe('accepted');
    expect(record.evaluation).toEqual({
      method: 'deterministic',
      ruleVersion: 'livecourse-choice-grading-v1',
    });
    expect(record.id).toBe('evidence:quiz:attempt-1');
    expect(record.idempotencyKey).toBe('quiz-review:attempt-1');
    expect(ledger.records).toHaveLength(1);
  });

  it('keeps model-graded quiz results pending_review through the same writer', async () => {
    const ledger = createFakeEvidenceLedger();
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-10T08:00:00.000Z',
    });

    const record = await service.ingestCheckpoint({
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:quiz-1',
      attemptId: 'attempt-2',
      score: 0.6,
      gradedByModel: true,
      modelId: 'configured-quiz-grader',
      inputSummary: 'A short answer was graded by the quiz model.',
    });

    expect(record.status).toBe('pending_review');
    expect(record.kind).toBe('rubric_score');
    expect(record.evaluation).toMatchObject({ method: 'model', reviewStatus: 'pending' });
    expect(ledger.records).toHaveLength(1);

    const state = projectGoalState({
      courseId: 'course-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      rule: RULE,
      evidence: ledger.records,
    });
    expect(state.status).not.toBe('met');
    expect(state.pendingReviewCount).toBe(1);
  });

  it('routes a PBL evaluation input through the same writer as pending_review', async () => {
    const ledger = createFakeEvidenceLedger();
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-10T08:00:00.000Z',
    });

    const record = await service.ingestPBLEvaluation({
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-2',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:pbl-1',
      modelId: 'evaluator-model',
      evaluationId: 'eval_abc',
      kind: 'milestone',
      projectId: 'project-9',
      milestoneId: 'milestone-1',
      score: 0.72,
      summary: 'PBL milestone evaluation; solved the scaffolded task.',
    });

    expect(record.status).toBe('pending_review');
    expect(record.source).toBe('homework');
    expect(record.evaluation).toMatchObject({
      method: 'model',
      modelId: 'evaluator-model',
      reviewStatus: 'pending',
    });
    expect(record.metadata).toMatchObject({
      pblEvaluationId: 'eval_abc',
      pblKind: 'milestone',
      pblProjectId: 'project-9',
      pblMilestoneId: 'milestone-1',
    });
  });

  it('requires a matching persistence scope and never infers a goal', async () => {
    const ledger = createFakeEvidenceLedger();
    const service = new EvidenceIngestionService(ledger);

    await expect(
      service.ingestCheckpoint({
        scope: SCOPE,
        courseId: 'course-1',
        lessonId: 'lesson-1',
        learnerId: 'learner-2',
        goalId: 'goal-1',
        nodeId: 'node:quiz-1',
        attemptId: 'attempt-1',
        score: 0.8,
        gradedByModel: false,
      }),
    ).rejects.toBeInstanceOf(EvidenceContextMismatchError);

    await expect(
      service.ingestPBLEvaluation({
        scope: SCOPE,
        courseId: 'course-1',
        lessonId: 'lesson-2',
        learnerId: 'learner-2',
        goalId: 'goal-1',
        nodeId: 'node:pbl-1',
        modelId: 'evaluator-model',
        evaluationId: 'eval_abc',
        kind: 'task',
        score: 0.5,
        summary: 'safe summary',
      }),
    ).rejects.toBeInstanceOf(EvidenceContextMismatchError);

    expect(ledger.records).toHaveLength(0);
  });

  it('only accepts or rejects model evidence through an explicit human review', async () => {
    const ledger = runtimeLedger(`evidence-review-${crypto.randomUUID()}`);
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-10T08:00:00.000Z',
    });

    const pending = await service.ingestPBLEvaluation({
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-2',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:pbl-1',
      modelId: 'evaluator-model',
      evaluationId: 'eval_abc',
      kind: 'final',
      projectId: 'project-9',
      score: 0.74,
      summary: 'PBL final evaluation summary.',
    });
    expect(pending.status).toBe('pending_review');

    const accepted = await service.decideTeacherReview({
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-2',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:pbl-1',
      reviewerId: 'teacher:5',
      pendingEvidenceId: pending.id,
      decision: 'accepted',
      rubricVersion: 'pbl-rubric-v1',
    });

    expect(accepted.status).toBe('accepted');
    expect(accepted.source).toBe('teacher_review');
    expect(accepted.evaluation).toMatchObject({ method: 'human', reviewerId: 'teacher:5' });
    expect(accepted.score).toBe(0.74);
    expect(accepted.metadata).toMatchObject({
      reviewedEvidenceId: pending.id,
      reviewedIdempotencyKey: pending.idempotencyKey,
      reviewedModelId: 'evaluator-model',
      decision: 'accepted',
    });

    // The resolved pending record no longer counts as pending in the projection.
    const state = projectGoalState({
      courseId: 'course-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      rule: RULE,
      evidence: await ledger.list(SCOPE),
    });
    expect(state.status).toBe('met');
    expect(state.pendingReviewCount).toBe(0);
  });

  it('records explicit rejection and keeps rejected evidence out of mastery', async () => {
    const ledger = runtimeLedger(`evidence-reject-${crypto.randomUUID()}`);
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-10T08:00:00.000Z',
    });

    const pending = await service.ingestPBLEvaluation({
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-2',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:pbl-1',
      modelId: 'evaluator-model',
      evaluationId: 'eval_rej',
      kind: 'task',
      score: 0.3,
      summary: 'PBL task evaluation summary.',
    });

    const rejected = await service.decideTeacherReview({
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-2',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:pbl-1',
      reviewerId: 'teacher:5',
      pendingEvidenceId: pending.id,
      decision: 'rejected',
    });

    expect(rejected.status).toBe('rejected');
    expect(rejected.score).toBeUndefined();
    const state = projectGoalState({
      courseId: 'course-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      rule: RULE,
      evidence: await ledger.list(SCOPE),
    });
    expect(state.status).not.toBe('met');
    expect(state.acceptedEvidenceCount).toBe(0);
  });

  it('returns the first durable record for idempotent retries and errors on conflict', async () => {
    const ledger = runtimeLedger(`evidence-idem-${crypto.randomUUID()}`);
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-10T08:00:00.000Z',
    });

    const first = await service.ingestCheckpoint({
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:quiz-1',
      attemptId: 'attempt-1',
      score: 0.8,
      gradedByModel: false,
    });
    const retry = await service.ingestCheckpoint({
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:quiz-1',
      attemptId: 'attempt-1',
      score: 0.8,
      gradedByModel: false,
      occurredAt: '2026-08-10T08:05:00.000Z',
    });
    const records = await ledger.list(SCOPE);

    expect(retry).toEqual(first);
    expect(records).toHaveLength(1);

    await expect(
      service.ingestCheckpoint({
        scope: SCOPE,
        courseId: 'course-1',
        lessonId: 'lesson-1',
        learnerId: 'learner-1',
        goalId: 'goal-1',
        nodeId: 'node:quiz-1',
        attemptId: 'attempt-1',
        score: 0.2,
        gradedByModel: false,
      }),
    ).rejects.toThrow(/idempotency conflict/i);
  });

  it('surfaces concrete errors for conflicting review reuse', async () => {
    const ledger = runtimeLedger(`evidence-review-idem-${crypto.randomUUID()}`);
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-10T08:00:00.000Z',
    });

    const pending = await service.ingestPBLEvaluation({
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-2',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:pbl-1',
      modelId: 'evaluator-model',
      evaluationId: 'eval_conflict',
      kind: 'task',
      score: 0.7,
      summary: 'PBL task summary.',
    });
    const review = {
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-2',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:pbl-1',
      reviewerId: 'teacher:5',
      pendingEvidenceId: pending.id,
      decision: 'accepted' as const,
    };

    const first = await service.decideTeacherReview(review);
    const retry = await service.decideTeacherReview({
      ...review,
      occurredAt: '2026-08-10T08:09:00.000Z',
    });
    expect(retry).toEqual(first);

    await expect(
      service.decideTeacherReview({ ...review, reviewerId: 'teacher:6' }),
    ).rejects.toThrow(/idempotency conflict/i);
  });

  it('refuses to review unknown or non-pending evidence and mismatched contexts', async () => {
    const ledger = runtimeLedger(`evidence-review-guard-${crypto.randomUUID()}`);
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-10T08:00:00.000Z',
    });

    await expect(
      service.decideTeacherReview({
        scope: SCOPE,
        courseId: 'course-1',
        lessonId: 'lesson-1',
        learnerId: 'learner-1',
        goalId: 'goal-1',
        nodeId: 'node:pbl-1',
        reviewerId: 'teacher:5',
        pendingEvidenceId: 'evidence:missing',
        decision: 'accepted',
      }),
    ).rejects.toBeInstanceOf(EvidenceReviewTargetError);

    const acceptedCheckpoint = await service.ingestCheckpoint({
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:quiz-1',
      attemptId: 'attempt-ok',
      score: 0.9,
      gradedByModel: false,
    });
    await expect(
      service.decideTeacherReview({
        scope: SCOPE,
        courseId: 'course-1',
        lessonId: 'lesson-1',
        learnerId: 'learner-1',
        goalId: 'goal-1',
        nodeId: 'node:quiz-1',
        reviewerId: 'teacher:5',
        pendingEvidenceId: acceptedCheckpoint.id,
        decision: 'accepted',
      }),
    ).rejects.toBeInstanceOf(EvidenceReviewTargetError);

    const pending = await service.ingestPBLEvaluation({
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-2',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:pbl-1',
      modelId: 'evaluator-model',
      evaluationId: 'eval_ctx',
      kind: 'task',
      score: 0.7,
      summary: 'PBL task summary.',
    });
    await expect(
      service.decideTeacherReview({
        scope: SCOPE,
        courseId: 'course-OTHER',
        lessonId: 'lesson-2',
        learnerId: 'learner-1',
        goalId: 'goal-1',
        nodeId: 'node:pbl-1',
        reviewerId: 'teacher:5',
        pendingEvidenceId: pending.id,
        decision: 'accepted',
      }),
    ).rejects.toBeInstanceOf(EvidenceContextMismatchError);
  });

  it('only ever writes schema-valid EvidenceRecords and never GoalState', async () => {
    const ledger = createFakeEvidenceLedger();
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-10T08:00:00.000Z',
    });

    await service.ingestCheckpoint({
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:quiz-1',
      attemptId: 'attempt-a',
      score: 0.8,
      gradedByModel: true,
    });
    await service.ingestPBLEvaluation({
      scope: SCOPE,
      courseId: 'course-1',
      lessonId: 'lesson-2',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      nodeId: 'node:pbl-1',
      modelId: 'evaluator-model',
      evaluationId: 'eval_a',
      kind: 'task',
      score: 0.6,
      summary: 'safe summary',
    });

    expect(ledger.records.every((record) => evidenceRecordSchema.safeParse(record).success)).toBe(
      true,
    );
    // The ingestion surface exposes no goal-state write path by construction.
    expect(Object.keys(service)).not.toContain('writeGoalState');
    const projected = projectGoalState({
      courseId: 'course-1',
      learnerId: 'learner-1',
      goalId: 'goal-1',
      rule: RULE,
      evidence: ledger.records,
    });
    expect(projected.status).not.toBe('met');
  });
});

describe('evidence record invariants (schema)', () => {
  it('rejects self_report evidence marked accepted', () => {
    expect(() =>
      evidenceRecordSchema.parse({
        schemaVersion: 1,
        id: 'evidence:self',
        courseId: 'course-1',
        lessonId: 'lesson-1',
        learnerId: 'learner-1',
        goalId: 'goal-1',
        nodeId: 'node:1',
        source: 'homework',
        kind: 'self_report',
        status: 'accepted',
        occurredAt: '2026-08-10T08:00:00.000Z',
        idempotencyKey: 'self-1',
        evaluation: { method: 'human', reviewerId: 'teacher:1' },
      }),
    ).toThrow();
  });
});

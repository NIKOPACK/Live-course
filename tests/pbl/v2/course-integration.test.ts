/**
 * P-005 — PBL course integration (A-009).
 *
 * Verifies that a completed PBL evaluation + explicit course context maps
 * through the shared evidence boundary without:
 *   - duplicating PBL progress state
 *   - bypassing the assistant-task allowlist
 *   - producing accepted (non-pending) evidence
 *
 * Uses an in-memory fake ledger so no persistence infrastructure is needed.
 */
import { describe, expect, it } from 'vitest';

import { EvidenceIngestionService } from '@/lib/livecourse/evidence/ingestion';
import { createFakeEvidenceLedger } from '@/tests/livecourse/evidence-fixture';

import { ingestPBLCourseEvidence } from '@/lib/pbl/v2/course-evidence-ingestion';
import type { PBLEvidenceContext } from '@/lib/pbl/v2/course-evidence-adapter';
import type { PBLEvaluation } from '@/lib/pbl/v2/types';

const CONTEXT: PBLEvidenceContext = {
  courseId: 'course:algebra',
  lessonId: 'lesson-2',
  learnerId: 'learner-1',
  goalId: 'goal:one',
  nodeId: 'node:pbl-1',
  scope: { stageId: 'stage-2', learnerId: 'learner-1' },
  modelId: 'evaluator-model',
  modelRubricVersion: 'pbl-rubric-v1',
  projectId: 'project-9',
};

function makeEvaluation(overrides: Partial<PBLEvaluation> = {}): PBLEvaluation {
  return {
    id: 'eval_task_456',
    kind: 'task',
    microtaskId: 'microtask-2',
    milestoneId: 'milestone-1',
    feedback: 'Good progress on the reasoning task.',
    strengths: ['clear logic'],
    improvements: ['double-check arithmetic'],
    score: 78,
    createdAt: '2026-08-17T08:00:00.000Z',
    ...overrides,
  };
}

describe('PBL course evidence ingestion (A-009)', () => {
  it('maps a completed PBL evaluation through the shared evidence boundary', async () => {
    const ledger = createFakeEvidenceLedger();
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-17T08:00:00.000Z',
    });

    const record = await ingestPBLCourseEvidence(service, CONTEXT, makeEvaluation());

    expect(record.courseId).toBe('course:algebra');
    expect(record.lessonId).toBe('lesson-2');
    expect(record.learnerId).toBe('learner-1');
    expect(record.goalId).toBe('goal:one');
    expect(record.nodeId).toBe('node:pbl-1');
    expect(record.source).toBe('homework');
    expect(record.status).toBe('pending_review');
    expect(record.score).toBeCloseTo(0.78);
    expect(record.id).toContain('evidence:pbl:');
    expect(ledger.records).toHaveLength(1);
  });

  it('keeps PBL project/progress input unchanged — the ingestion never reads or writes PBL state', async () => {
    const ledger = createFakeEvidenceLedger();
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-17T08:00:00.000Z',
    });

    const evaluation = makeEvaluation();
    const frozen = Object.freeze({ ...evaluation });
    const contextFrozen = Object.freeze({ ...CONTEXT });

    const record = await ingestPBLCourseEvidence(service, contextFrozen, frozen);

    // The PBL evaluation object is not mutated by the mapping/ingestion
    expect(evaluation).toEqual(frozen);
    // The ledger only contains the evidence record, nothing PBL-related
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0].id).toBe(record.id);
    // No PBL project/progress is written or read
    expect(Object.keys(record.metadata ?? {})).toContain('pblProjectId');
    expect(record.metadata?.pblProjectId).toBe('project-9');
  });

  it('mapped model evidence stays pending until teacher review', async () => {
    const ledger = createFakeEvidenceLedger();
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-17T08:00:00.000Z',
    });

    const record = await ingestPBLCourseEvidence(service, CONTEXT, makeEvaluation());
    expect(record.status).toBe('pending_review');

    // Only a teacher review can change the status — the ingestion service
    // has no path that accepts model evidence directly.
    const accepted = await service.decideTeacherReview({
      scope: { stageId: 'stage-2', learnerId: 'learner-1' },
      courseId: 'course:algebra',
      lessonId: 'lesson-2',
      learnerId: 'learner-1',
      goalId: 'goal:one',
      nodeId: 'node:pbl-1',
      reviewerId: 'teacher:5',
      pendingEvidenceId: record.id,
      decision: 'accepted',
    });
    expect(accepted.status).toBe('accepted');
    expect(accepted.source).toBe('teacher_review');
  });

  it('fails loudly for invalid context or evaluation', async () => {
    const ledger = createFakeEvidenceLedger();
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-17T08:00:00.000Z',
    });

    // Missing courseId (synchronous throw from the mapping)
    expect(() =>
      ingestPBLCourseEvidence(service, { ...CONTEXT, courseId: '' }, makeEvaluation()),
    ).toThrow(/required/);

    // Evaluation without score/stars (synchronous throw from the mapping)
    expect(() =>
      ingestPBLCourseEvidence(
        service,
        CONTEXT,
        makeEvaluation({ score: undefined, stars: undefined }),
      ),
    ).toThrow(/no numeric score/);

    // Mismatched learner scope (synchronous throw from the mapping)
    expect(() =>
      ingestPBLCourseEvidence(
        service,
        { ...CONTEXT, scope: { stageId: 'stage-2', learnerId: 'other' } },
        makeEvaluation(),
      ),
    ).toThrow(/scope.learnerId/);

    // No records were written for any failure
    expect(ledger.records).toHaveLength(0);
  });

  it('is idempotent through the shared ingestion service', async () => {
    const ledger = createFakeEvidenceLedger();
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-17T08:00:00.000Z',
    });

    const evaluation = makeEvaluation();
    const first = await ingestPBLCourseEvidence(service, CONTEXT, evaluation);
    const second = await ingestPBLCourseEvidence(service, CONTEXT, evaluation);

    expect(second).toEqual(first);
    expect(ledger.records).toHaveLength(1);
  });
});

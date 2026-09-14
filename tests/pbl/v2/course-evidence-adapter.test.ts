import { describe, expect, it } from 'vitest';

import { EvidenceIngestionService } from '@/lib/livecourse/evidence/ingestion';
import {
  mapPBLEvaluationToEvidenceInput,
  normalizePBLEvaluationScore,
  PBLEvidenceMappingError,
  type PBLEvidenceContext,
} from '@/lib/pbl/v2/course-evidence-adapter';
import type { PBLEvaluation, PBLProjectV2 } from '@/lib/pbl/v2/types';

import { createFakeEvidenceLedger } from '../../livecourse/evidence-fixture';

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
    id: 'eval_task_123',
    kind: 'task',
    microtaskId: 'microtask-1',
    milestoneId: 'milestone-1',
    feedback: 'Good attempt at the scaffolded problem.',
    strengths: ['clear setup'],
    improvements: ['check units'],
    score: 72,
    createdAt: '2026-08-10T08:00:00.000Z',
    ...overrides,
  };
}

function minimalProject(): PBLProjectV2 {
  return {
    uiPhase: 'completion',
    title: 'Algebra project',
    status: 'completed',
    language: 'en',
    roles: [],
    milestones: [],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    gains: [],
    createdAt: '2026-08-10T08:00:00.000Z',
    updatedAt: '2026-08-10T08:00:00.000Z',
  } as unknown as PBLProjectV2;
}

describe('PBL v2 course-evidence adapter', () => {
  it('maps a completed evaluation only with explicit LiveCourse context', () => {
    const input = mapPBLEvaluationToEvidenceInput(CONTEXT, makeEvaluation());

    expect(input.courseId).toBe('course:algebra');
    expect(input.lessonId).toBe('lesson-2');
    expect(input.learnerId).toBe('learner-1');
    expect(input.goalId).toBe('goal:one');
    expect(input.nodeId).toBe('node:pbl-1');
    expect(input.scope).toEqual({ stageId: 'stage-2', learnerId: 'learner-1' });
    expect(input.modelId).toBe('evaluator-model');
    expect(input.evaluationId).toBe('eval_task_123');
    expect(input.kind).toBe('task');
    expect(input.score).toBeCloseTo(0.72);
    expect(input.milestoneId).toBe('milestone-1');
    expect(input.microtaskId).toBe('microtask-1');
  });

  it('normalizes stars when the evaluation has no numeric score', () => {
    expect(normalizePBLEvaluationScore(makeEvaluation({ score: undefined, stars: 4 }))).toBeCloseTo(
      0.8,
    );
    const input = mapPBLEvaluationToEvidenceInput(
      CONTEXT,
      makeEvaluation({ score: undefined, stars: 2.5 }),
    );
    expect(input.score).toBeCloseTo(0.5);
  });

  it('refuses incomplete evaluations without a numeric outcome', () => {
    const evaluation = makeEvaluation({ score: undefined, stars: undefined });
    expect(() => mapPBLEvaluationToEvidenceInput(CONTEXT, evaluation)).toThrow(
      PBLEvidenceMappingError,
    );
    expect(() => mapPBLEvaluationToEvidenceInput(CONTEXT, evaluation)).toThrow(/no numeric score/);
  });

  it('requires the full explicit LiveCourse context and never infers a goal', () => {
    expect(() =>
      mapPBLEvaluationToEvidenceInput({ ...CONTEXT, goalId: '' }, makeEvaluation()),
    ).toThrow(PBLEvidenceMappingError);
    expect(() =>
      mapPBLEvaluationToEvidenceInput({ ...CONTEXT, courseId: '' }, makeEvaluation()),
    ).toThrow(PBLEvidenceMappingError);
    expect(() =>
      mapPBLEvaluationToEvidenceInput(
        { ...CONTEXT, learnerId: 'learner-1', scope: { ...CONTEXT.scope, learnerId: 'other' } },
        makeEvaluation(),
      ),
    ).toThrow(/scope.learnerId/);
  });

  it('preserves the PBL project identity and state — the mapping is read-only', () => {
    const project = minimalProject();
    Object.freeze(project);
    const before = JSON.stringify(project);

    const input = mapPBLEvaluationToEvidenceInput(
      CONTEXT,
      project.evaluations[0] ?? makeEvaluation(),
    );

    expect(input.projectId).toBe('project-9');
    expect(JSON.stringify(project)).toBe(before);
    expect(project.evaluations).toHaveLength(0);
  });

  it('keeps only safe summaries and ids — never raw submission content', () => {
    const evaluation = makeEvaluation({
      feedback: 'x'.repeat(5000),
      whatYouBuilt: ['RAW_BUILT_CONTENT_MARKER'],
      whatYouLearned: ['RAW_LEARNED_CONTENT_MARKER'],
    });
    const input = mapPBLEvaluationToEvidenceInput(CONTEXT, evaluation);

    expect(input.summary.length).toBeLessThanOrEqual(2000);
    expect(input.summary).not.toContain('RAW_BUILT_CONTENT_MARKER');
    expect(input.summary).not.toContain('RAW_LEARNED_CONTENT_MARKER');
    expect(input.summary).toContain('PBL task/milestone-1/microtask-1');
    expect(Object.keys(input.metadata ?? {}).sort()).toEqual(
      ['pblEvaluationId', 'pblKind', 'pblMicrotaskId', 'pblMilestoneId', 'pblProjectId'].sort(),
    );
  });

  it('cannot mark model evidence accepted — ingestion always enters pending_review', async () => {
    const ledger = createFakeEvidenceLedger();
    const service = new EvidenceIngestionService(ledger, {
      now: () => '2026-08-10T08:00:00.000Z',
    });
    const input = mapPBLEvaluationToEvidenceInput(CONTEXT, makeEvaluation());

    const record = await service.ingestPBLEvaluation(input);

    expect(record.status).toBe('pending_review');
    expect(record.evaluation).toMatchObject({
      method: 'model',
      modelId: 'evaluator-model',
      rubricVersion: 'pbl-rubric-v1',
      reviewStatus: 'pending',
    });
    expect(record.metadata).toMatchObject({
      pblEvaluationId: 'eval_task_123',
      pblKind: 'task',
      pblProjectId: 'project-9',
    });
    expect(record.id).toBe('evidence:pbl:eval_task_123');
    expect(record.idempotencyKey).toBe('pbl-eval:eval_task_123');
    expect(ledger.records.every((entry) => entry.status === 'pending_review')).toBe(true);
  });
});

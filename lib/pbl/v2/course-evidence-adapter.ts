/**
 * PBL v2 — course-evidence adapter (P-003).
 *
 * The ONE mapping that turns a completed `PBLEvaluation` into the shared
 * LiveCourse evidence ingestion contract. Hard rules:
 *
 *   - Explicit LiveCourse context is mandatory (`courseId`, `lessonId`,
 *     `learnerId`, `goalId`, `nodeId` plus the persistence scope). A goal is
 *     never inferred from evaluation text.
 *   - Only a *completed* evaluation (has an id, a createdAt and a numeric
 *     outcome) maps; anything else fails loudly.
 *   - The result is a model-produced score and can therefore never be
 *     `accepted` here — the ingestion service always writes it as
 *     `pending_review`, and only an explicit human review through the same
 *     boundary may accept or reject it.
 *   - The mapping is pure: it never edits `PBLProjectV2`, never issues
 *     assistant tasks and never touches PBL proficiency/progress.
 *   - Safe summaries and ids are preserved; raw submission content is not.
 */
import type {
  EvidencePersistenceScope,
  PBLEvaluationEvidenceInput,
} from '@/lib/livecourse/evidence/ingestion';

import type { PBLEvaluation, PBLEvaluationKind } from './types';

export class PBLEvidenceMappingError extends Error {
  override readonly name = 'PBLEvidenceMappingError';
}

/** Explicit LiveCourse context the adapter requires before mapping anything. */
export interface PBLEvidenceContext {
  courseId: string;
  lessonId: string;
  learnerId: string;
  goalId: string;
  nodeId: string;
  /** Persistence scope — the shared ingestion contract's stage/learner partition. */
  scope: EvidencePersistenceScope;
  /** Identity of the model that produced the evaluation. */
  modelId: string;
  modelRubricVersion?: string;
  /** PBL project id kept for audit metadata (identity only, never content). */
  projectId?: string;
}

const PBL_EVALUATION_KINDS: readonly PBLEvaluationKind[] = ['task', 'milestone', 'final'];

/** Normalize a PBL numeric outcome to the shared 0..1 evidence score. */
export function normalizePBLEvaluationScore(evaluation: PBLEvaluation): number {
  if (typeof evaluation.score === 'number' && Number.isFinite(evaluation.score)) {
    return Math.min(1, Math.max(0, evaluation.score / 100));
  }
  if (typeof evaluation.stars === 'number' && Number.isFinite(evaluation.stars)) {
    return Math.min(1, Math.max(0, evaluation.stars / 5));
  }
  throw new PBLEvidenceMappingError(
    `PBL evaluation ${JSON.stringify(evaluation.id)} has no numeric score or stars`,
  );
}

function requireContext(value: string, label: string): string {
  if (!value.trim()) {
    throw new PBLEvidenceMappingError(`${label} is required for PBL evidence mapping`);
  }
  return value;
}

/** Bounded safe summary — ids and headline, never raw submission content. */
function buildSafeSummary(evaluation: PBLEvaluation, score: number): string {
  const scope = [evaluation.kind, evaluation.milestoneId, evaluation.microtaskId]
    .filter((part): part is string => typeof part === 'string')
    .join('/');
  const feedback = (evaluation.feedback ?? '').trim().replace(/\s+/g, ' ').slice(0, 240);
  const parts = [`PBL ${scope || 'evaluation'}; normalized score ${score.toFixed(3)}`];
  if (feedback) parts.push(feedback);
  return parts.join(' — ').slice(0, 2000);
}

/**
 * Maps one completed `PBLEvaluation` into the shared evidence ingestion
 * contract. The evaluation object and the LiveCourse context are read-only;
 * nothing is persisted here.
 */
export function mapPBLEvaluationToEvidenceInput(
  context: PBLEvidenceContext,
  evaluation: PBLEvaluation,
): PBLEvaluationEvidenceInput {
  requireContext(context.courseId, 'context.courseId');
  requireContext(context.lessonId, 'context.lessonId');
  requireContext(context.learnerId, 'context.learnerId');
  requireContext(context.goalId, 'context.goalId');
  requireContext(context.nodeId, 'context.nodeId');
  requireContext(context.scope.stageId, 'context.scope.stageId');
  requireContext(context.scope.learnerId, 'context.scope.learnerId');
  requireContext(context.modelId, 'context.modelId');
  requireContext(evaluation.id, 'evaluation.id');
  requireContext(evaluation.createdAt ?? '', 'evaluation.createdAt');
  if (!PBL_EVALUATION_KINDS.includes(evaluation.kind)) {
    throw new PBLEvidenceMappingError(
      `Unsupported PBL evaluation kind ${JSON.stringify(evaluation.kind)}`,
    );
  }
  if (context.learnerId !== context.scope.learnerId) {
    throw new PBLEvidenceMappingError(
      'context.learnerId must match context.scope.learnerId for the shared evidence scope',
    );
  }

  const score = normalizePBLEvaluationScore(evaluation);
  const summary = buildSafeSummary(evaluation, score);

  return {
    scope: { ...context.scope },
    courseId: context.courseId,
    lessonId: context.lessonId,
    learnerId: context.learnerId,
    goalId: context.goalId,
    nodeId: context.nodeId,
    modelId: context.modelId,
    rubricVersion: context.modelRubricVersion,
    evaluationId: evaluation.id,
    kind: evaluation.kind,
    projectId: context.projectId,
    milestoneId: evaluation.milestoneId,
    microtaskId: evaluation.microtaskId,
    score,
    summary,
    metadata: {
      pblEvaluationId: evaluation.id,
      pblKind: evaluation.kind,
      ...(context.projectId ? { pblProjectId: context.projectId } : {}),
      ...(evaluation.milestoneId ? { pblMilestoneId: evaluation.milestoneId } : {}),
      ...(evaluation.microtaskId ? { pblMicrotaskId: evaluation.microtaskId } : {}),
    },
  };
}

/**
 * LiveCourse — subject Skill evidence adapter (P-005).
 *
 * A pure structured-result-to-existing-`EvidenceIngestionService.ingestModelEvaluation`
 * adapter. It requires:
 *
 *   1. A validated `SubjectSkillInvocation` (produced by `validateSubjectSkillInvocation`,
 *      which already proves the task is terminal-succeeded, kind/context/inputs/tools
 *      are correct).
 *   2. An explicit `SubjectSkillEvaluationResult` — never a raw `task.result` or a
 *      raw `AssistantTask` object.
 *
 * The output is always `pending_review` model evidence. It can never produce
 * accepted evidence — only the existing teacher-review flow can accept or reject it.
 *
 * The adapter is data-only and deterministic: the same input always produces the
 * same evidence shape (idempotency is handled by the ingestion service).
 *
 * Stage partition (D-0010):
 *   - The storage partition is `scope: { stageId, learnerId }` where `stageId`
 *     comes from the execution context, NOT from `courseId`.
 *   - The adapter verifies that the context's `stageId` matches the validated
 *     invocation's `stageId` and is non-empty before any evidence is written.
 *   - A missing, empty, or foreign stage/scope is rejected before the ingestion
 *     service is called.
 */
import type { EvidenceRecord } from '@/lib/livecourse/domain';
import type { EvidenceIngestionService } from '@/lib/livecourse/evidence/ingestion';

import type {
  SubjectSkillEvaluationResult,
  SubjectSkillExecutionContext,
  SubjectSkillInvocation,
} from '@/lib/livecourse/domain/subject-skill';

export class SubjectSkillEvidenceError extends Error {
  override readonly name = 'SubjectSkillEvidenceError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SubjectSkillEvidenceInput {
  /**
   * The explicit execution context the Skill was run in. Its `stageId` is the
   * storage partition (`scope.stageId`) and must match the invocation's.
   */
  context: SubjectSkillExecutionContext;
  /**
   * A validated invocation produced by `validateSubjectSkillInvocation`.
   * This guarantees the task has reached terminal success and its
   * kind/context/inputs/tools match the declaration. The adapter never
   * accepts a raw `AssistantTask` or `task.result` directly.
   */
  invocation: SubjectSkillInvocation;
  /**
   * The structured Skill result. Must be an explicit
   * `SubjectSkillEvaluationResult` — never the raw `task.result`.
   */
  result: SubjectSkillEvaluationResult;
  /** Identity of the model that produced this evaluation. */
  modelId: string;
  /** Rubric version identifier (optional). */
  rubricVersion?: string;
  /** ISO timestamp override (optional). */
  occurredAt?: string;
}

/**
 * Maps a validated Skill invocation and its structured result through the
 * shared evidence ingestion boundary. The output is always `pending_review`
 * and can only be accepted/rejected by the existing teacher-review flow.
 *
 * The adapter:
 *   - Rejects a non-succeeded invocation (terminal-status gate).
 *   - Rejects a result whose `skillId` does not match the invocation's.
 *   - Rejects a result whose `score` is outside 0..1.
 *   - Rejects an empty or missing context `stageId` or a mismatched stage
 *     between context and invocation — the storage partition is never derived
 *     from `courseId`.
 *   - Maps the result to `ingestModelEvaluation` on the injected service.
 */
export function mapSubjectSkillResultToEvidence(
  service: EvidenceIngestionService,
  input: SubjectSkillEvidenceInput,
): Promise<EvidenceRecord> {
  if (input.invocation.status !== 'succeeded') {
    throw new SubjectSkillEvidenceError(
      'SKILL_NOT_TERMINAL',
      'subject Skill evidence requires a succeeded terminal invocation',
    );
  }
  if (input.context.learnerId !== input.invocation.learnerId) {
    throw new SubjectSkillEvidenceError(
      'SKILL_LEARNER_MISMATCH',
      'subject Skill execution context learner does not match invocation',
    );
  }
  if (input.context.goalId !== input.invocation.goalId) {
    throw new SubjectSkillEvidenceError(
      'SKILL_GOAL_MISMATCH',
      'subject Skill execution context goal does not match invocation',
    );
  }
  // D-0010: stageId is the storage partition — required, never derived from courseId
  if (!input.context.stageId) {
    throw new SubjectSkillEvidenceError(
      'SKILL_STAGE_REQUIRED',
      'subject Skill execution context requires an explicit stageId (never derived from courseId)',
    );
  }
  if (!input.invocation.stageId || input.context.stageId !== input.invocation.stageId) {
    throw new SubjectSkillEvidenceError(
      'SKILL_STAGE_MISMATCH',
      'subject Skill execution context stage does not match the validated invocation stage; the storage partition is never derived from courseId',
    );
  }
  if (input.result.skillId !== input.invocation.skillId) {
    throw new SubjectSkillEvidenceError(
      'SKILL_ID_MISMATCH',
      `subject Skill result skillId ${JSON.stringify(input.result.skillId)} does not match invocation skillId ${JSON.stringify(input.invocation.skillId)}`,
    );
  }
  if (typeof input.result.score !== 'number' || input.result.score < 0 || input.result.score > 1) {
    throw new SubjectSkillEvidenceError(
      'SKILL_SCORE_INVALID',
      `subject Skill result score must be a number 0..1, got ${JSON.stringify(input.result.score)}`,
    );
  }
  const summary = input.result.summary?.trim();
  if (!summary) {
    throw new SubjectSkillEvidenceError(
      'SKILL_SUMMARY_REQUIRED',
      'subject Skill result requires a bounded safe summary',
    );
  }

  const evidenceId = `subject-skill:${input.invocation.taskId}:${input.result.checkpointId}`;

  return service.ingestModelEvaluation({
    scope: {
      stageId: input.context.stageId,
      learnerId: input.context.learnerId,
    },
    courseId: input.context.courseId,
    lessonId: input.context.lessonId,
    learnerId: input.context.learnerId,
    goalId: input.context.goalId,
    nodeId: input.context.nodeId,
    modelId: input.modelId,
    rubricVersion: input.rubricVersion,
    skillId: input.invocation.skillId,
    evidenceId,
    kind: 'checkpoint_evaluation',
    score: input.result.score,
    summary,
    occurredAt: input.occurredAt ?? input.result.occurredAt,
    metadata: {
      checkpointId: input.result.checkpointId,
      rubricId: input.result.rubricId,
      taskId: input.invocation.taskId,
      taskVersion: input.invocation.taskVersion,
    },
  });
}

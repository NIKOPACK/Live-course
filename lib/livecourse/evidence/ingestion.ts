/**
 * LiveCourse — unified evidence ingestion boundary (P-003).
 *
 * This is the only application-facing path that turns checkpoint results,
 * PBL evaluation outcomes and teacher review decisions into `EvidenceRecord`
 * writes. Callers never hand-assemble a record or call a persistence
 * repository directly:
 *
 *   - `ingestCheckpoint`      → deterministic results become `accepted`;
 *                               model-graded answers become `pending_review`.
 *   - `ingestPBLEvaluation`   → model-produced PBL scores ALWAYS enter as
 *                               `pending_review`. Nothing here can accept a
 *                               model score; only `decideTeacherReview` can.
 *   - `decideTeacherReview`   → explicit human decision produces the only
 *                               accepted/rejected evidence for model work.
 *
 * The service is pure domain logic over a narrow, injectable `EvidenceLedgerPort`
 * so every path shares one persistence boundary and keeps the runtime's
 * idempotency/conflict semantics (repeated semantic input returns the first
 * record; conflicting reuse of an id/idempotency key errors loudly).
 *
 * `GoalState` is never written here: mastery is projected read-only from
 * accepted evidence by `projectGoalState` in the domain package.
 */
import {
  evidenceRecordSchema,
  identifierSchema,
  type EvidenceRecord,
  type JsonValue,
} from '@/lib/livecourse/domain';

/** The persistence partition for one learner in one classroom stage. */
export interface EvidencePersistenceScope {
  stageId: string;
  learnerId: string;
  /** Course boundary when a caller operates on course-scoped evidence. */
  courseId?: string;
}

/** Narrow write port: insert-or-return-first with idempotency/conflict semantics. */
export interface EvidenceWriterPort {
  write(scope: EvidencePersistenceScope, record: EvidenceRecord): Promise<EvidenceRecord>;
}

/** Ledger port the teacher-review path needs to resolve pending records. */
export interface EvidenceLedgerPort extends EvidenceWriterPort {
  list(scope: EvidencePersistenceScope): Promise<EvidenceRecord[]>;
}

export class EvidenceIngestionError extends Error {
  override readonly name: string = 'EvidenceIngestionError';
}

export class EvidenceContextMismatchError extends EvidenceIngestionError {
  override readonly name = 'EvidenceContextMismatchError';

  constructor(message: string) {
    super(message);
  }
}

export class EvidenceReviewTargetError extends EvidenceIngestionError {
  override readonly name = 'EvidenceReviewTargetError';

  constructor(message: string) {
    super(message);
  }
}

export interface CheckpointEvidenceInput {
  scope: EvidencePersistenceScope;
  courseId: string;
  lessonId: string;
  learnerId: string;
  goalId: string;
  nodeId: string;
  attemptId: string;
  score: number;
  gradedByModel: boolean;
  modelId?: string;
  rubricVersion?: string;
  inputSummary?: string;
  occurredAt?: string;
  metadata?: Record<string, JsonValue>;
}

export interface PBLEvaluationEvidenceInput {
  scope: EvidencePersistenceScope;
  courseId: string;
  lessonId: string;
  learnerId: string;
  goalId: string;
  nodeId: string;
  modelId: string;
  rubricVersion?: string;
  evaluationId: string;
  kind: string;
  projectId?: string;
  milestoneId?: string;
  microtaskId?: string;
  score: number;
  summary: string;
  occurredAt?: string;
  metadata?: Record<string, JsonValue>;
}

export interface ModelEvaluationEvidenceInput {
  scope: EvidencePersistenceScope;
  courseId: string;
  lessonId: string;
  learnerId: string;
  goalId: string;
  nodeId: string;
  modelId: string;
  rubricVersion?: string;
  skillId: string;
  evidenceId: string;
  kind: string;
  score: number;
  summary: string;
  occurredAt?: string;
  metadata?: Record<string, JsonValue>;
}

export type TeacherReviewDecision = 'accepted' | 'rejected';

export interface TeacherReviewDecisionInput {
  scope: EvidencePersistenceScope;
  courseId: string;
  lessonId: string;
  learnerId: string;
  goalId: string;
  nodeId: string;
  reviewerId: string;
  pendingEvidenceId: string;
  decision: TeacherReviewDecision;
  rubricVersion?: string;
  occurredAt?: string;
  metadata?: Record<string, JsonValue>;
}

function requireIdentifier(value: string, label: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new EvidenceIngestionError(`${label} must be a non-empty identifier`);
  }
  return value;
}

function requireScopeLearner(input: {
  scope: EvidencePersistenceScope;
  learnerId: string;
  label: string;
}): void {
  requireIdentifier(input.scope.stageId, 'stageId');
  requireIdentifier(input.scope.learnerId, 'scope.learnerId');
  requireIdentifier(input.learnerId, `${input.label} learnerId`);
  if (input.learnerId !== input.scope.learnerId) {
    throw new EvidenceContextMismatchError(
      `${input.label} learnerId does not match the evidence persistence scope`,
    );
  }
}

function scopeOf(input: { scope: EvidencePersistenceScope }): EvidencePersistenceScope {
  return {
    stageId: requireIdentifier(input.scope.stageId, 'stageId'),
    learnerId: requireIdentifier(input.scope.learnerId, 'scope.learnerId'),
    ...(input.scope.courseId
      ? { courseId: requireIdentifier(input.scope.courseId, 'scope.courseId') }
      : {}),
  };
}

export const SKILL_MODEL_RUBRIC_VERSION = 'subject-skill-rubric-v1';

export const QUIZ_MODEL_RUBRIC_VERSION = 'livecourse-short-answer-rubric-v1';
export const QUIZ_DETERMINISTIC_RULE_VERSION = 'livecourse-choice-grading-v1';
export const PBL_MODEL_RUBRIC_VERSION = 'pbl-rubric-v1';
export const QUIZ_MODEL_DEFAULT_SUMMARY = 'A quiz containing model-graded answers was submitted.';

export class EvidenceIngestionService {
  readonly #ledger: EvidenceLedgerPort;
  readonly #now: () => string;

  constructor(ledger: EvidenceLedgerPort, options: { now?: () => string } = {}) {
    this.#ledger = ledger;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Deterministic checkpoint results can be accepted immediately; any
   * model-graded item keeps the whole attempt in `pending_review` until an
   * explicit teacher decision. Repeated attempts with the same `attemptId`
   * return the first durable record; conflicting reuse errors loudly.
   */
  async ingestCheckpoint(input: CheckpointEvidenceInput): Promise<EvidenceRecord> {
    requireScopeLearner({ scope: input.scope, learnerId: input.learnerId, label: 'Checkpoint' });
    const scope = scopeOf(input);
    requireIdentifier(input.courseId, 'courseId');
    requireIdentifier(input.lessonId, 'lessonId');
    requireIdentifier(input.goalId, 'goalId');
    requireIdentifier(input.nodeId, 'nodeId');
    const attemptId = requireIdentifier(input.attemptId, 'attemptId');
    const occurredAt = input.occurredAt ?? this.#now();

    const record = evidenceRecordSchema.parse({
      schemaVersion: 1,
      id: `evidence:quiz:${attemptId}`,
      courseId: input.courseId,
      lessonId: input.lessonId,
      learnerId: input.learnerId,
      goalId: input.goalId,
      nodeId: input.nodeId,
      source: 'checkpoint',
      kind: input.gradedByModel ? 'rubric_score' : 'objective_score',
      status: input.gradedByModel ? 'pending_review' : 'accepted',
      score: input.score,
      occurredAt,
      idempotencyKey: `quiz-review:${attemptId}`,
      evaluation: input.gradedByModel
        ? {
            method: 'model',
            modelId: input.modelId ?? 'configured-quiz-grader',
            rubricVersion: input.rubricVersion ?? QUIZ_MODEL_RUBRIC_VERSION,
            inputSummary: input.inputSummary ?? QUIZ_MODEL_DEFAULT_SUMMARY,
            confidence: 0,
            reviewStatus: 'pending',
          }
        : { method: 'deterministic', ruleVersion: QUIZ_DETERMINISTIC_RULE_VERSION },
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });

    return this.#ledger.write(scope, record);
  }

  /**
   * A model-produced skill evaluation ALWAYS enters as `pending_review`.
   * This is the shared boundary for any declaration-driven Skill whose
   * structured result must go through the same pending → teacher-review
   * lifecycle as quiz and PBL model evidence.
   */
  async ingestModelEvaluation(input: ModelEvaluationEvidenceInput): Promise<EvidenceRecord> {
    requireScopeLearner({
      scope: input.scope,
      learnerId: input.learnerId,
      label: 'Model evaluation',
    });
    const scope = scopeOf(input);
    requireIdentifier(input.courseId, 'courseId');
    requireIdentifier(input.lessonId, 'lessonId');
    requireIdentifier(input.goalId, 'goalId');
    requireIdentifier(input.nodeId, 'nodeId');
    const modelId = requireIdentifier(input.modelId, 'modelId');
    const skillId = requireIdentifier(input.skillId, 'skillId');
    const evidenceId = requireIdentifier(input.evidenceId, 'evidenceId');
    const kind = requireIdentifier(input.kind, 'kind');
    const summary = input.summary.trim();
    if (!summary) throw new EvidenceIngestionError('Model evaluation summary must not be empty');
    const occurredAt = input.occurredAt ?? this.#now();

    const record = evidenceRecordSchema.parse({
      schemaVersion: 1,
      id: `evidence:skill:${evidenceId}`,
      courseId: input.courseId,
      lessonId: input.lessonId,
      learnerId: input.learnerId,
      goalId: input.goalId,
      nodeId: input.nodeId,
      source: 'checkpoint',
      kind: 'rubric_score',
      status: 'pending_review',
      score: input.score,
      occurredAt,
      idempotencyKey: `skill-eval:${evidenceId}`,
      evaluation: {
        method: 'model',
        modelId,
        rubricVersion: input.rubricVersion ?? SKILL_MODEL_RUBRIC_VERSION,
        inputSummary: summary,
        confidence: 0,
        reviewStatus: 'pending',
      },
      metadata: {
        ...input.metadata,
        skillId,
        skillKind: kind,
      },
    });

    return this.#ledger.write(scope, record);
  }

  /**
   * A model-produced PBL score ALWAYS enters as `pending_review`. The
   * evaluation id is preserved in the metadata; raw submission content is
   * never written — callers provide a bounded safe summary instead.
   */
  async ingestPBLEvaluation(input: PBLEvaluationEvidenceInput): Promise<EvidenceRecord> {
    requireScopeLearner({
      scope: input.scope,
      learnerId: input.learnerId,
      label: 'PBL evaluation',
    });
    const scope = scopeOf(input);
    requireIdentifier(input.courseId, 'courseId');
    requireIdentifier(input.lessonId, 'lessonId');
    requireIdentifier(input.goalId, 'goalId');
    requireIdentifier(input.nodeId, 'nodeId');
    const modelId = requireIdentifier(input.modelId, 'modelId');
    const evaluationId = requireIdentifier(input.evaluationId, 'evaluationId');
    const kind = requireIdentifier(input.kind, 'kind');
    const summary = input.summary.trim();
    if (!summary) throw new EvidenceIngestionError('PBL evidence summary must not be empty');
    const occurredAt = input.occurredAt ?? this.#now();

    const record = evidenceRecordSchema.parse({
      schemaVersion: 1,
      id: `evidence:pbl:${evaluationId}`,
      courseId: input.courseId,
      lessonId: input.lessonId,
      learnerId: input.learnerId,
      goalId: input.goalId,
      nodeId: input.nodeId,
      source: 'homework',
      kind: 'rubric_score',
      status: 'pending_review',
      score: input.score,
      occurredAt,
      idempotencyKey: `pbl-eval:${evaluationId}`,
      evaluation: {
        method: 'model',
        modelId,
        rubricVersion: input.rubricVersion ?? PBL_MODEL_RUBRIC_VERSION,
        inputSummary: summary,
        confidence: 0,
        reviewStatus: 'pending',
      },
      metadata: {
        ...input.metadata,
        pblEvaluationId: evaluationId,
        pblKind: kind,
        ...(input.projectId ? { pblProjectId: input.projectId } : {}),
        ...(input.milestoneId ? { pblMilestoneId: input.milestoneId } : {}),
        ...(input.microtaskId ? { pblMicrotaskId: input.microtaskId } : {}),
      },
    });

    return this.#ledger.write(scope, record);
  }

  /**
   * The ONLY path that turns model/pending evidence into accepted or rejected
   * evidence. Validates the pending record exists in the same course/lesson/
   * learner/goal/node scope, then writes a `teacher_review` decision record
   * that links back to the reviewed evidence id.
   */
  async decideTeacherReview(input: TeacherReviewDecisionInput): Promise<EvidenceRecord> {
    requireScopeLearner({
      scope: input.scope,
      learnerId: input.learnerId,
      label: 'Teacher review',
    });
    const scope = scopeOf(input);
    requireIdentifier(input.courseId, 'courseId');
    requireIdentifier(input.lessonId, 'lessonId');
    requireIdentifier(input.goalId, 'goalId');
    requireIdentifier(input.nodeId, 'nodeId');
    const reviewerId = requireIdentifier(input.reviewerId, 'reviewerId');
    const pendingEvidenceId = requireIdentifier(input.pendingEvidenceId, 'pendingEvidenceId');
    if (input.decision !== 'accepted' && input.decision !== 'rejected') {
      throw new EvidenceIngestionError(
        `Unknown teacher review decision ${JSON.stringify(input.decision)}`,
      );
    }
    const occurredAt = input.occurredAt ?? this.#now();

    const pending = (await this.#ledger.list(scope)).find(
      (record) => record.id === pendingEvidenceId,
    );
    if (!pending) {
      throw new EvidenceReviewTargetError(
        `No pending evidence record ${JSON.stringify(pendingEvidenceId)} in this scope`,
      );
    }
    if (pending.status !== 'pending_review') {
      throw new EvidenceReviewTargetError(
        `Evidence ${JSON.stringify(pendingEvidenceId)} is ${JSON.stringify(pending.status)}, not pending_review`,
      );
    }
    const context = {
      courseId: pending.courseId === input.courseId,
      lessonId: pending.lessonId === input.lessonId,
      learnerId: pending.learnerId === input.learnerId,
      goalId: pending.goalId === input.goalId,
      nodeId: pending.nodeId === input.nodeId,
    };
    if (!Object.values(context).every(Boolean)) {
      throw new EvidenceContextMismatchError(
        `Teacher review context does not match evidence ${JSON.stringify(pendingEvidenceId)}`,
      );
    }
    if (input.decision === 'accepted' && pending.score === undefined) {
      throw new EvidenceReviewTargetError(
        `Evidence ${JSON.stringify(pendingEvidenceId)} has no score to accept`,
      );
    }

    const record = evidenceRecordSchema.parse({
      schemaVersion: 1,
      id: `evidence:teacher-review:${pendingEvidenceId}`,
      courseId: input.courseId,
      lessonId: input.lessonId,
      learnerId: input.learnerId,
      goalId: input.goalId,
      nodeId: input.nodeId,
      source: 'teacher_review',
      kind: 'rubric_score',
      status: input.decision,
      ...(input.decision === 'accepted' && pending.score !== undefined
        ? { score: pending.score }
        : {}),
      occurredAt,
      idempotencyKey: `teacher-review:${pendingEvidenceId}`,
      evaluation: {
        method: 'human',
        reviewerId,
        ...(input.rubricVersion ? { rubricVersion: input.rubricVersion } : {}),
      },
      metadata: {
        ...input.metadata,
        reviewedEvidenceId: pending.id,
        reviewedIdempotencyKey: pending.idempotencyKey,
        ...(pending.evaluation.method === 'model'
          ? { reviewedModelId: pending.evaluation.modelId }
          : {}),
        decision: input.decision,
      },
    });

    return this.#ledger.write(scope, record);
  }
}

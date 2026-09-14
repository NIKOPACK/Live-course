import {
  coursePlanSchema,
  teachingAdjustmentSchema,
  type CheckpointRule,
  type CoursePlan,
  type CoursePlanRevision,
  type TeachingAdjustment,
} from './course-plan';
import { EvidenceConflictError } from './evidence-reducer';
import {
  evidenceRecordSchema,
  goalStateSchema,
  identifierSchema,
  teachingActionSchema,
  type EvidenceRecord,
  type GoalState,
  type TeachingAction,
} from './schemas';

/**
 * LiveCourse — explainable, deterministic teaching adjustments (P-003).
 *
 * One domain engine consumes a validated CoursePlan, projected GoalStates and
 * accepted evidence and emits:
 *
 *   - `proposeCourseAdjustments(...)`  — course-level `TeachingAdjustment`
 *     proposals that stay `pending` and never touch the supplied CoursePlan.
 *   - `deriveImmediateActions(...)`    — node-level remediation/advance
 *     *drafts*. Drafts are data only: the caller materializes them into an
 *     existing `TeachingAction` through `materializeImmediateAction` and
 *     dispatches via the existing `ClassroomController`. The engine never
 *     writes presentation or persistence state.
 *
 * Every output is deterministic: identical inputs plus the injected
 * time/identity produce byte-equivalent output in a stable order with stable
 * ids and idempotency keys. `approveCourseAdjustment` is the single domain
 * function that turns a pending adjustment into a new, higher CoursePlan
 * version; `rejectCourseAdjustment` preserves the plan untouched.
 */
export class CourseAdjustmentError extends Error {
  override readonly name: string = 'CourseAdjustmentError';
}

export class CourseAdjustmentStateError extends CourseAdjustmentError {
  override readonly name = 'CourseAdjustmentStateError';
}

export class CourseAdjustmentContextError extends CourseAdjustmentError {
  override readonly name = 'CourseAdjustmentContextError';
}

export class CourseAdjustmentStalePlanError extends CourseAdjustmentError {
  override readonly name = 'CourseAdjustmentStalePlanError';
}

// ---------------------------------------------------------------------------
// Determinism primitives
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('Adjustment value is not JSON-safe');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

/** FNV-1a over the UTF-16 units — stable within a process and across runs. */
function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function boundedId(value: string, max = 32): string {
  return value.length <= max ? value : stableHash(value);
}

function sortIdentifiers(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function requireIdentifier(value: string, label: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success) throw new CourseAdjustmentError(`${label} must be a non-empty identifier`);
  return value;
}

function sortByOrderAndId<T extends { order: number; id: string }>(items: readonly T[]): T[] {
  return [...items].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
}

function validatedEvidence(records: readonly EvidenceRecord[]): EvidenceRecord[] {
  const byId = new Map<string, EvidenceRecord>();
  const byKey = new Map<string, EvidenceRecord>();
  for (const raw of records) {
    const record = evidenceRecordSchema.parse(raw);
    const serialized = canonicalJson(record);
    const sameId = byId.get(record.id);
    if (sameId && canonicalJson(sameId) !== serialized) {
      throw new EvidenceConflictError('id', record.id);
    }
    const sameKey = byKey.get(record.idempotencyKey);
    if (sameKey && canonicalJson(sameKey) !== serialized) {
      throw new EvidenceConflictError('idempotencyKey', record.idempotencyKey);
    }
    byId.set(record.id, record);
    byKey.set(record.idempotencyKey, record);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id),
  );
}

function validatedGoalStates(states: readonly GoalState[]): GoalState[] {
  return [...states]
    .map((state) => goalStateSchema.parse(state))
    .sort((left, right) => left.goalId.localeCompare(right.goalId));
}

// ---------------------------------------------------------------------------
// Immediate (node-level) action drafts
// ---------------------------------------------------------------------------

export type ImmediateActionKind = 'advance' | 'remediate';

/**
 * A node-level remediation/advance as *data*. It is not a classroom command
 * until `materializeImmediateAction` turns it into an existing schema-valid
 * `TeachingAction`, which the caller dispatches through the existing
 * `ClassroomController`. The idempotency key is stable per semantic input.
 */
export interface ImmediateActionDraft {
  kind: ImmediateActionKind;
  /** The node the learner is currently on (message anchor for the action). */
  sourceNodeId: string;
  targetLessonId: string;
  /** `advance` only — the next node to move to. */
  targetNodeId?: string;
  /** `remediate` only — the checkpoint rule to reopen. */
  checkpointId?: string;
  sceneId: string;
  idempotencyKey: string;
}

export function materializeImmediateAction(input: {
  courseId: string;
  lessonId: string;
  draft: ImmediateActionDraft;
  sequence: number;
  timestamp: string;
  id?: string;
}): TeachingAction {
  const { draft } = input;
  const id = input.id ?? `adjustment-action:${draft.idempotencyKey}`;
  const envelope = {
    schemaVersion: 1,
    id,
    courseId: input.courseId,
    lessonId: input.lessonId,
    nodeId: draft.sourceNodeId,
    sequence: input.sequence,
    timestamp: input.timestamp,
    idempotencyKey: draft.idempotencyKey,
  };
  if (draft.kind === 'advance') {
    if (!draft.targetNodeId) {
      throw new CourseAdjustmentError('Advance draft requires targetNodeId');
    }
    return teachingActionSchema.parse({
      ...envelope,
      type: 'lesson.goto_node',
      payload: { targetNodeId: draft.targetNodeId },
    });
  }
  if (!draft.checkpointId) {
    throw new CourseAdjustmentError('Remediate draft requires checkpointId');
  }
  return teachingActionSchema.parse({
    ...envelope,
    type: 'checkpoint.open',
    payload: { checkpointId: draft.checkpointId },
  });
}

// ---------------------------------------------------------------------------
// Adjustment engine
// ---------------------------------------------------------------------------

export interface CourseAdjustmentInput {
  coursePlan: CoursePlan;
  goalStates: readonly GoalState[];
  evidence: readonly EvidenceRecord[];
}

interface ProposalBuildInput {
  plan: CoursePlan;
  goal: { id: string };
  state: GoalState;
  met: boolean;
  acceptedEvidenceIds: string[];
  targetLessonId: string;
  targetNodeId: string;
  targetNodeTitle: string;
  revision: CoursePlanRevision;
}

export class TeachingAdjustmentEngine {
  readonly #now: () => string;

  constructor(options: { now?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Deterministic course-level proposals. The supplied CoursePlan is never
   * mutated; every proposal stays `pending` until an explicit teacher
   * decision through `approveCourseAdjustment` / `rejectCourseAdjustment`.
   */
  proposeCourseAdjustments(input: CourseAdjustmentInput): readonly TeachingAdjustment[] {
    const plan = coursePlanSchema.parse(input.coursePlan);
    const evidence = validatedEvidence(input.evidence);
    const goalStates = validatedGoalStates(input.goalStates);
    const stateByGoal = new Map(goalStates.map((state) => [state.goalId, state]));
    const lessons = sortByOrderAndId(plan.lessons);
    const existingCheckpoints = plan.checkpointRules;

    const proposals: TeachingAdjustment[] = [];
    for (const goal of [...plan.goals].sort((left, right) => left.id.localeCompare(right.id))) {
      const accepted = evidence.filter(
        (record) => record.goalId === goal.id && record.status === 'accepted',
      );
      if (accepted.length === 0) continue;
      const state = stateByGoal.get(goal.id);
      if (!state) continue;

      const latest = accepted[accepted.length - 1]!;
      const latestLesson = lessons.find((lesson) =>
        lesson.nodes.some((node) => node.id === latest.nodeId),
      );
      if (!latestLesson) continue;

      const sortedNodes = sortByOrderAndId(latestLesson.nodes);
      const nodeIndex = sortedNodes.findIndex((node) => node.id === latest.nodeId);
      const nextNode = nodeIndex >= 0 ? sortedNodes[nodeIndex + 1] : undefined;
      if (!nextNode) continue;
      if (
        existingCheckpoints.some(
          (rule) => rule.nodeId === nextNode.id && rule.goalIds.includes(goal.id),
        )
      ) {
        continue;
      }

      proposals.push(
        this.#buildProposal({
          plan,
          goal,
          state,
          met: state.status === 'met',
          acceptedEvidenceIds: accepted.map((record) => record.id),
          targetLessonId: latestLesson.id,
          targetNodeId: nextNode.id,
          targetNodeTitle: nextNode.title,
          revision: this.#checkpointRevision(plan, goal.id, nextNode.id),
        }),
      );
    }

    return Object.freeze(proposals.sort((left, right) => left.id.localeCompare(right.id)));
  }

  /**
   * Deterministic node-level drafts derived from the latest accepted evidence.
   * Returns an empty list when there is nothing to do. Drafts never touch
   * presentation or persistence state.
   */
  deriveImmediateActions(input: CourseAdjustmentInput): readonly ImmediateActionDraft[] {
    const plan = coursePlanSchema.parse(input.coursePlan);
    const evidence = validatedEvidence(input.evidence);
    const goalStates = validatedGoalStates(input.goalStates);
    const stateByGoal = new Map(goalStates.map((state) => [state.goalId, state]));
    const lessons = sortByOrderAndId(plan.lessons);
    const rulesByNode = new Map(plan.checkpointRules.map((rule) => [rule.nodeId, rule]));

    const accepted = evidence.filter((record) => record.status === 'accepted');
    const latest = accepted.at(-1);
    if (!latest) return Object.freeze([]);
    const lesson = lessons.find((candidate) =>
      candidate.nodes.some((node) => node.id === latest.nodeId),
    );
    if (!lesson) return Object.freeze([]);
    const state = stateByGoal.get(latest.goalId);
    const goal = plan.goals.find((candidate) => candidate.id === latest.goalId);
    if (!state || !goal) return Object.freeze([]);
    const node = lesson.nodes.find((candidate) => candidate.id === latest.nodeId);
    if (!node) return Object.freeze([]);

    const sortedNodes = sortByOrderAndId(lesson.nodes);
    const nodeIndex = sortedNodes.findIndex((candidate) => candidate.id === node.id);
    const nextNode = nodeIndex >= 0 ? sortedNodes[nodeIndex + 1] : undefined;
    const drafts: ImmediateActionDraft[] = [];

    if (state.status === 'met' && nextNode) {
      drafts.push({
        kind: 'advance',
        sourceNodeId: node.id,
        targetLessonId: lesson.id,
        targetNodeId: nextNode.id,
        sceneId: nextNode.sceneId,
        idempotencyKey: [
          'adjustment-immediate:advance',
          boundedId(plan.courseId),
          plan.version,
          boundedId(node.id),
          boundedId(nextNode.id),
        ].join(':'),
      });
    } else if (
      state.status !== 'met' &&
      latest.score !== undefined &&
      latest.score < goal.rule.passScore
    ) {
      const rule = rulesByNode.get(node.id);
      if (rule) {
        drafts.push({
          kind: 'remediate',
          sourceNodeId: node.id,
          targetLessonId: lesson.id,
          checkpointId: rule.id,
          sceneId: node.sceneId,
          idempotencyKey: [
            'adjustment-immediate:remediate',
            boundedId(plan.courseId),
            plan.version,
            boundedId(node.id),
            boundedId(rule.id),
          ].join(':'),
        });
      }
    }

    return Object.freeze(
      drafts.sort(
        (left, right) =>
          left.kind.localeCompare(right.kind) ||
          left.idempotencyKey.localeCompare(right.idempotencyKey),
      ),
    );
  }

  #checkpointRevision(plan: CoursePlan, goalId: string, targetNodeId: string): CoursePlanRevision {
    return {
      kind: 'add_checkpoint',
      checkpoint: {
        id: [
          'checkpoint',
          boundedId(plan.courseId),
          boundedId(goalId),
          boundedId(targetNodeId),
        ].join(':'),
        nodeId: targetNodeId,
        goalIds: [goalId],
        required: true,
      },
    };
  }

  #buildProposal(input: ProposalBuildInput): TeachingAdjustment {
    const { plan, goal, state } = input;
    const acceptedCount = input.acceptedEvidenceIds.length;
    const createdAt = this.#now();
    const seed = canonicalJson({
      courseId: plan.courseId,
      planVersion: plan.version,
      goalId: goal.id,
      targetLessonId: input.targetLessonId,
      targetNodeId: input.targetNodeId,
      revision: input.revision,
    });
    const id = `adjustment:course:${stableHash(seed)}`;
    const idempotencyKey = [
      'course-adjustment',
      boundedId(plan.courseId),
      plan.version,
      boundedId(goal.id),
      stableHash(seed).slice(0, 12),
    ].join(':');
    const rationale = input.met
      ? `Goal ${goal.id} is met from ${acceptedCount} accepted evidence item(s); add a retention checkpoint on node ${input.targetNodeId} in lesson ${input.targetLessonId} before new material.`
      : `Goal ${goal.id} needs support after ${acceptedCount} accepted evidence item(s); add a support checkpoint on node ${input.targetNodeId} to confirm the goal before continuing.`;
    const summary = input.met
      ? `Confirm ${goal.id} retention in ${input.targetLessonId} with a checkpoint on ${input.targetNodeId} (${input.targetNodeTitle}).`
      : `Add a support checkpoint for ${goal.id} on ${input.targetNodeId} (${input.targetNodeTitle}).`;

    return teachingAdjustmentSchema.parse({
      schemaVersion: 1,
      id,
      courseId: plan.courseId,
      coursePlanVersion: plan.version,
      targetLessonIds: [input.targetLessonId],
      targetNodeIds: [input.targetNodeId],
      basis: {
        evidenceIds: sortIdentifiers(input.acceptedEvidenceIds),
        goalStateIds: [state.goalId],
        rationale,
      },
      recommendation: {
        kind: input.revision.kind,
        summary,
        revision: input.revision,
      },
      approvalStatus: 'pending',
      idempotencyKey,
      createdAt,
    });
  }
}

// ---------------------------------------------------------------------------
// Teacher decisions (course level)
// ---------------------------------------------------------------------------

export interface ApproveCourseAdjustmentInput {
  adjustment: TeachingAdjustment;
  coursePlan: CoursePlan;
  decidedBy: string;
  now?: () => string;
}

/**
 * The single domain function that turns a pending course-level adjustment
 * into a new, higher CoursePlan version. Validates the constraint context
 * (plan course, plan version, pending state, typed revision), applies the
 * typed revision, and returns a brand-new validated `CoursePlan`; the
 * caller's plan is never mutated. Arbitrary JSON patches are rejected by
 * construction — only `coursePlanRevisionSchema` shapes apply.
 */
export function approveCourseAdjustment(input: ApproveCourseAdjustmentInput): CoursePlan {
  const adjustment = teachingAdjustmentSchema.parse(input.adjustment);
  const plan = coursePlanSchema.parse(input.coursePlan);
  // Validation-only: the decider identity gates the approval but the plan
  // itself carries no decision fields (the adjustment record does).
  requireIdentifier(input.decidedBy, 'decidedBy');
  if (adjustment.approvalStatus !== 'pending') {
    throw new CourseAdjustmentStateError(
      `Adjustment ${adjustment.id} is ${adjustment.approvalStatus}, not pending`,
    );
  }
  if (adjustment.courseId !== plan.courseId) {
    throw new CourseAdjustmentContextError(
      `Adjustment ${adjustment.id} targets course ${adjustment.courseId}, but the plan belongs to ${plan.courseId}`,
    );
  }
  if (adjustment.coursePlanVersion !== plan.version) {
    throw new CourseAdjustmentStalePlanError(
      `Adjustment ${adjustment.id} targets plan version ${adjustment.coursePlanVersion}, current version is ${plan.version}`,
    );
  }
  const revision = adjustment.recommendation.revision;
  if (!revision) {
    throw new CourseAdjustmentStateError(
      `Adjustment ${adjustment.id} carries no typed plan revision`,
    );
  }

  const now = input.now?.() ?? new Date().toISOString();
  const next: CoursePlan = {
    ...plan,
    version: plan.version + 1,
    status: 'approved',
    updatedAt: now,
    checkpointRules: applyCourseRevision(plan, revision),
  };
  return coursePlanSchema.parse(next);
}

export interface RejectCourseAdjustmentInput {
  adjustment: TeachingAdjustment;
  decidedBy: string;
  now?: () => string;
}

/**
 * Rejects a pending course-level adjustment. The CoursePlan is preserved
 * untouched — this function does not even take one.
 */
export function rejectCourseAdjustment(input: RejectCourseAdjustmentInput): TeachingAdjustment {
  const adjustment = teachingAdjustmentSchema.parse(input.adjustment);
  if (adjustment.approvalStatus !== 'pending') {
    throw new CourseAdjustmentStateError(
      `Adjustment ${adjustment.id} is ${adjustment.approvalStatus}, not pending`,
    );
  }
  const decidedBy = requireIdentifier(input.decidedBy, 'decidedBy');
  const decidedAt = input.now?.() ?? new Date().toISOString();
  return teachingAdjustmentSchema.parse({
    ...adjustment,
    approvalStatus: 'rejected',
    decidedAt,
    decidedBy,
  });
}

/** Applies a typed revision to a plan's checkpoint rules with explicit validation. */
export function applyCourseRevision(
  plan: CoursePlan,
  revision: CoursePlanRevision,
): CheckpointRule[] {
  if (revision.kind !== 'add_checkpoint') {
    throw new CourseAdjustmentStateError(
      `Unsupported course plan revision kind ${JSON.stringify(revision.kind)}`,
    );
  }
  const checkpoint = revision.checkpoint;
  if (plan.checkpointRules.some((rule) => rule.id === checkpoint.id)) {
    throw new CourseAdjustmentStateError(
      `Checkpoint ${checkpoint.id} already exists in plan ${plan.id}`,
    );
  }
  const nodeExists = plan.lessons.some((lesson) =>
    lesson.nodes.some((node) => node.id === checkpoint.nodeId),
  );
  if (!nodeExists) {
    throw new CourseAdjustmentStateError(
      `Cannot add checkpoint on unknown node ${checkpoint.nodeId}`,
    );
  }
  const goalIds = new Set(plan.goals.map((goal) => goal.id));
  for (const goalId of checkpoint.goalIds) {
    if (!goalIds.has(goalId)) {
      throw new CourseAdjustmentStateError(
        `Cannot add checkpoint referencing unknown goal ${goalId}`,
      );
    }
  }
  return [...plan.checkpointRules, checkpoint];
}

/**
 * LiveCourse — the one versioned, schema-validated `CourseStateSnapshot`
 * contract (P-004).
 *
 * A snapshot composes the existing canonical contracts — `CoursePlan`,
 * `TeachingActionSnapshot`, `AssistantTaskSnapshot`, `EvidenceRecord[]` and
 * `TeachingAdjustment[]` — into one durable, recoverable unit for one course
 * inside one `(stage, learner)` partition. It never invents copies of those
 * contracts: every member passes through its owning schema on both write and
 * recovery.
 *
 * Recovery discipline:
 *
 *   - Recovery is pure. It never invokes `ClassroomController.dispatch`,
 *     presentation handlers, realtime publish, or any replay/apply of a
 *     teaching action. The classroom recovery point (current node + last
 *     committed sequence) is folded from the already-committed actions.
 *   - The assistant task service is rebuilt through the existing
 *     `recoverAssistantTaskSnapshot` helper: running work is explicitly
 *     requeued, terminal states stay terminal.
 *   - Only `approved` adjustments are recoverable as *applied* course
 *     changes; `pending`/`rejected` records are audit history and are
 *     explicitly excluded from the applied projection.
 *   - There is no silent empty fallback: an unreadable snapshot fails loud
 *     with a typed validation error.
 */
import { z } from 'zod';

import {
  assistantTaskSnapshotSchema,
  coursePlanSchema,
  evidenceRecordSchema,
  teachingActionSchema,
  teachingAdjustmentSchema,
  type AssistantTaskSnapshot,
  type CoursePlan,
  type EvidenceRecord,
  type TeachingAction,
  type TeachingAdjustment,
} from '@/lib/livecourse/domain';
import { recoverAssistantTaskSnapshot } from '@/lib/livecourse/domain/assistant-task';
import type { AssistantTaskService } from '@/lib/livecourse/domain/assistant-task';
import type { ClassroomRecoveryPoint, TeachingActionSnapshot } from './action-repository';
import { foldTeachingActions } from './action-repository';

/** The schema revision of the course-state snapshot contract itself. */
export const COURSE_STATE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * `C.completedNode / C.progress`（docs/spec/04-detailed-design.md §1/§6，
 * A2）：`lesson.complete_node` 去重后立即持久化的课程进度投影。它只是恢复
 * 所需的物化进度——不是证据，不进入 evidence stream，不投影 `GoalState`。
 * 可选字段：A2 之前的旧快照没有它也能解析。
 */
export const courseProgressSchema = z
  .object({
    /** 已讲授完成的节点 id，按完成顺序排列，唯一。 */
    completedNodeIds: z.array(z.string().trim().min(1).max(240)),
    /** 最近一次 `lesson.complete_node` 完成的节点；尚无完成时为 null。 */
    lastCompletedNodeId: z.string().trim().min(1).max(240).nullable(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((progress, context) => {
    const seen = new Set<string>();
    for (const [index, nodeId] of progress.completedNodeIds.entries()) {
      if (seen.has(nodeId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate completed node id: ${nodeId}`,
          path: ['completedNodeIds', index],
        });
      }
      seen.add(nodeId);
    }
    if (progress.lastCompletedNodeId !== null && !seen.has(progress.lastCompletedNodeId)) {
      context.addIssue({
        code: 'custom',
        message: `lastCompletedNodeId ${progress.lastCompletedNodeId} is not part of completedNodeIds`,
        path: ['lastCompletedNodeId'],
      });
    }
  });

export type CourseProgress = z.infer<typeof courseProgressSchema>;

/**
 * 课程生命周期（docs/spec/04-detailed-design.md §1/§6，A2）：首页同课选择态
 * 的唯一权威依据——`in_progress` 才允许「继续」（J4.4），`archived` 只能
 * 「再听」（J4.2/J4.4）。`finalizeSession` 归档 `W → C` 时把它写成
 * `archived`；此外没有第二条写路径。可选字段：A2 之前的旧快照没有它，
 * 解析时视为 `in_progress`。
 */
export const courseLifecycleSchema = z
  .object({
    status: z.enum(['in_progress', 'archived']),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type CourseLifecycle = z.infer<typeof courseLifecycleSchema>;

const classroomActionListSchema = z
  .object({
    actions: z.array(teachingActionSchema),
    currentNodeId: z.string().nullable(),
    lastSequence: z.number().int().min(-1),
  })
  .strict();

/** One committed classroom action history plus its folded recovery point. */
export type ClassroomActionList = z.infer<typeof classroomActionListSchema>;

export const courseStateSnapshotSchema = z
  .object({
    schemaVersion: z.literal(COURSE_STATE_SNAPSHOT_SCHEMA_VERSION),
    /** Stable snapshot id — deterministic from the partition + idempotency key. */
    id: z.string().trim().min(1).max(240),
    /** Stable writer key: a retried save returns the original record. */
    idempotencyKey: z.string().trim().min(1).max(240),
    stageId: z.string().trim().min(1).max(240),
    learnerId: z.string().trim().min(1).max(240),
    courseId: z.string().trim().min(1).max(240),
    /** The lesson the classroom was in when the snapshot was taken. */
    lessonId: z.string().trim().min(1).max(240),
    createdAt: z.string().datetime({ offset: true }),
    coursePlan: coursePlanSchema,
    teachingActions: classroomActionListSchema,
    progress: courseProgressSchema.optional(),
    lifecycle: courseLifecycleSchema.optional(),
    assistantTasks: assistantTaskSnapshotSchema,
    evidence: z.array(evidenceRecordSchema),
    adjustments: z.array(teachingAdjustmentSchema),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const lessonIds = new Set(snapshot.coursePlan.lessons.map((lesson) => lesson.id));
    if (!lessonIds.has(snapshot.lessonId)) {
      context.addIssue({
        code: 'custom',
        message: `Snapshot lesson ${snapshot.lessonId} is not part of the recovered course plan`,
        path: ['lessonId'],
      });
    }

    // The classroom action list must fold back to the exact recovery point it
    // claims — same rule as foldTeachingActions: contiguous sequences from 0
    // and a current node derived from the last committed action.
    let foldedNode: string | null = null;
    let foldedSequence = -1;
    for (const [index, action] of snapshot.teachingActions.actions.entries()) {
      if (action.courseId !== snapshot.courseId) {
        context.addIssue({
          code: 'custom',
          message: `Teaching action ${action.id} belongs to course ${action.courseId}, not ${snapshot.courseId}`,
          path: ['teachingActions', 'actions', index, 'courseId'],
        });
      }
      if (action.lessonId !== snapshot.lessonId) {
        context.addIssue({
          code: 'custom',
          message: `Teaching action ${action.id} belongs to lesson ${action.lessonId}, not ${snapshot.lessonId}`,
          path: ['teachingActions', 'actions', index, 'lessonId'],
        });
      }
      if (action.sequence !== foldedSequence + 1) {
        context.addIssue({
          code: 'custom',
          message: `Teaching action sequence ${action.sequence} must equal ${foldedSequence + 1}`,
          path: ['teachingActions', 'actions', index, 'sequence'],
        });
        break;
      }
      foldedSequence = action.sequence;
      foldedNode = action.type === 'lesson.goto_node' ? action.payload.targetNodeId : action.nodeId;
    }
    if (snapshot.teachingActions.lastSequence !== foldedSequence) {
      context.addIssue({
        code: 'custom',
        message: `Teaching action list lastSequence ${snapshot.teachingActions.lastSequence} does not match the folded sequence ${foldedSequence}`,
        path: ['teachingActions', 'lastSequence'],
      });
    }
    if (snapshot.teachingActions.currentNodeId !== foldedNode) {
      context.addIssue({
        code: 'custom',
        message: `Teaching action list currentNodeId ${JSON.stringify(snapshot.teachingActions.currentNodeId)} does not match the folded node ${JSON.stringify(foldedNode)}`,
        path: ['teachingActions', 'currentNodeId'],
      });
    }

    const evidenceIds = new Set<string>();
    const evidenceKeys = new Set<string>();
    for (const [index, record] of snapshot.evidence.entries()) {
      if (record.courseId !== snapshot.courseId) {
        context.addIssue({
          code: 'custom',
          message: `Evidence ${record.id} belongs to course ${record.courseId}, not ${snapshot.courseId}`,
          path: ['evidence', index, 'courseId'],
        });
      }
      if (record.learnerId !== snapshot.learnerId) {
        context.addIssue({
          code: 'custom',
          message: `Evidence ${record.id} belongs to learner ${record.learnerId}, not ${snapshot.learnerId}`,
          path: ['evidence', index, 'learnerId'],
        });
      }
      if (evidenceIds.has(record.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate evidence id: ${record.id}`,
          path: ['evidence', index, 'id'],
        });
      }
      if (evidenceKeys.has(record.idempotencyKey)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate evidence idempotency key: ${record.idempotencyKey}`,
          path: ['evidence', index, 'idempotencyKey'],
        });
      }
      evidenceIds.add(record.id);
      evidenceKeys.add(record.idempotencyKey);
    }

    for (const [index, task] of snapshot.assistantTasks.tasks.entries()) {
      if (task.courseId !== snapshot.courseId) {
        context.addIssue({
          code: 'custom',
          message: `Assistant task ${task.id} belongs to course ${task.courseId}, not ${snapshot.courseId}`,
          path: ['assistantTasks', 'tasks', index, 'courseId'],
        });
      }
    }

    const adjustmentIds = new Set<string>();
    const adjustmentKeys = new Set<string>();
    for (const [index, adjustment] of snapshot.adjustments.entries()) {
      if (adjustment.courseId !== snapshot.courseId) {
        context.addIssue({
          code: 'custom',
          message: `Adjustment ${adjustment.id} belongs to course ${adjustment.courseId}, not ${snapshot.courseId}`,
          path: ['adjustments', index, 'courseId'],
        });
      }
      if (adjustmentIds.has(adjustment.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate adjustment id: ${adjustment.id}`,
          path: ['adjustments', index, 'id'],
        });
      }
      if (adjustmentKeys.has(adjustment.idempotencyKey)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate adjustment idempotency key: ${adjustment.idempotencyKey}`,
          path: ['adjustments', index, 'idempotencyKey'],
        });
      }
      adjustmentIds.add(adjustment.id);
      adjustmentKeys.add(adjustment.idempotencyKey);

      // Only approved adjustments are recoverable as applied course changes,
      // and each must match the recovered CoursePlan's course/version context:
      // applying an approval advances the plan by exactly one version, so the
      // recovered plan can never sit at the adjustment's own target version.
      if (adjustment.approvalStatus === 'approved') {
        if (adjustment.coursePlanVersion >= snapshot.coursePlan.version) {
          context.addIssue({
            code: 'custom',
            message: `Approved adjustment ${adjustment.id} targets plan version ${adjustment.coursePlanVersion}, which cannot be applied to produce recovered version ${snapshot.coursePlan.version}`,
            path: ['adjustments', index, 'coursePlanVersion'],
          });
        }
      }
    }
  });

export type CourseStateSnapshot = z.infer<typeof courseStateSnapshotSchema>;

/** Caller-facing snapshot payload. `id`/`createdAt` are derived when omitted. */
export interface CourseStateSnapshotInput {
  idempotencyKey: string;
  stageId: string;
  learnerId: string;
  courseId: string;
  lessonId: string;
  coursePlan: CoursePlan;
  teachingActions: TeachingActionSnapshot;
  /** `C.completedNode / C.progress` 投影；尚未提交过 `lesson.complete_node` 时省略。 */
  progress?: CourseProgress;
  /** 课程生命周期；缺省视为 `in_progress`。仅 `finalizeSession` 写 `archived`。 */
  lifecycle?: CourseLifecycle;
  assistantTasks: AssistantTaskSnapshot;
  evidence: readonly EvidenceRecord[];
  adjustments: readonly TeachingAdjustment[];
  id?: string;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Typed failure surface
// ---------------------------------------------------------------------------

export class CourseStateValidationError extends Error {
  override readonly name: string = 'CourseStateValidationError';
}

export class CourseStatePartitionError extends CourseStateValidationError {
  override readonly name = 'CourseStatePartitionError';
}

export class CourseStateSnapshotConflictError extends CourseStateValidationError {
  override readonly name = 'CourseStateSnapshotConflictError';

  constructor(
    readonly dimension: 'id' | 'idempotencyKey',
    readonly value: string,
  ) {
    super(
      `Course state snapshot conflict: ${dimension} ${JSON.stringify(value)} was reused with different content`,
    );
  }
}

export class CourseStateAdjustmentError extends CourseStateValidationError {
  override readonly name = 'CourseStateAdjustmentError';
}

// ---------------------------------------------------------------------------
// Stable ids and canonical comparison
// ---------------------------------------------------------------------------

/** Wide deterministic digest — safe in browser-shared code. */
function wideDigest(value: string): string {
  const seeds = [
    2166136261, 2654435761, 2246822519, 3266489917, 668265263, 374761393, 1442695041, 3628273133,
  ];
  return seeds
    .map((seed) => {
      let hash = seed;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    })
    .join('');
}

/** Stable snapshot identity: one id per (partition, idempotencyKey). */
export function deterministicCourseStateSnapshotId(input: {
  stageId: string;
  learnerId: string;
  courseId: string;
  idempotencyKey: string;
}): string {
  const value = `${input.courseId}\u0000${input.stageId}\u0000${input.learnerId}\u0000${input.idempotencyKey}`;
  return `course-state-snapshot:${wideDigest(value)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('Course state snapshot is not JSON-safe');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

export function sameCourseStateSnapshot(
  left: CourseStateSnapshot,
  right: CourseStateSnapshot,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

// ---------------------------------------------------------------------------
// Build + validate
// ---------------------------------------------------------------------------

/**
 * Translate a Zod failure into the typed course-state error surface so
 * callers never juggle raw validator internals. Any adjustment-context issue
 * is a `CourseStateAdjustmentError`; everything else is a plain
 * `CourseStateValidationError`.
 */
function errorFromZod(error: unknown, label: string): Error {
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? error : new CourseStateValidationError(String(error));
  }
  const summary = error.issues
    .map((issue) => `${issue.path.join('.') || '/'}: ${issue.message}`)
    .join('; ');
  const message = `${label}: ${summary}`;
  if (error.issues.some((issue) => issue.path[0] === 'adjustments')) {
    return new CourseStateAdjustmentError(message);
  }
  return new CourseStateValidationError(message);
}

/** Parse one snapshot, translating validator failures into typed errors. */
export function parseCourseStateSnapshot(value: unknown): CourseStateSnapshot {
  try {
    return courseStateSnapshotSchema.parse(value);
  } catch (error) {
    throw errorFromZod(error, 'Course state snapshot validation failed');
  }
}

/**
 * Parse and validate one snapshot. This is the single gate every component
 * passes through; callers (and the repository) never hand-assemble a snapshot
 * without it.
 */
export function buildCourseStateSnapshot(
  input: CourseStateSnapshotInput,
  options: { now?: () => string; idFactory?: typeof deterministicCourseStateSnapshotId } = {},
): CourseStateSnapshot {
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? deterministicCourseStateSnapshotId;
  const candidate = {
    schemaVersion: COURSE_STATE_SNAPSHOT_SCHEMA_VERSION,
    id: input.id ?? idFactory(input),
    idempotencyKey: input.idempotencyKey,
    stageId: input.stageId,
    learnerId: input.learnerId,
    courseId: input.courseId,
    lessonId: input.lessonId,
    createdAt: input.createdAt ?? now(),
    coursePlan: input.coursePlan,
    teachingActions: input.teachingActions,
    assistantTasks: input.assistantTasks,
    evidence: input.evidence,
    adjustments: input.adjustments,
    ...(input.progress === undefined ? {} : { progress: input.progress }),
    ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
  };
  return parseCourseStateSnapshot(candidate);
}

// ---------------------------------------------------------------------------
// Recovery (pure — no dispatch, no publish, no replay)
// ---------------------------------------------------------------------------

export interface CourseStateRecovery {
  snapshot: CourseStateSnapshot;
  coursePlan: CoursePlan;
  /** The lesson the classroom is in after recovery. */
  lessonId: string;
  teachingActions: TeachingActionSnapshot;
  classroomRecoveryPoint: ClassroomRecoveryPoint;
  /** Persisted `C.completedNode / C.progress`; absent for pre-A2 snapshots. */
  progress?: CourseProgress;
  /** Rebuilt via `recoverAssistantTaskSnapshot`; running work is requeued. */
  assistantTasks: AssistantTaskService;
  evidence: readonly EvidenceRecord[];
  adjustments: readonly TeachingAdjustment[];
  /** Approved-only projection — the recoverable applied course changes. */
  appliedAdjustments: readonly TeachingAdjustment[];
}

export interface RecoverCourseStateOptions {
  stageId?: string;
  learnerId?: string;
  /** Injected clock for deterministic requeue events during recovery. */
  now?: () => string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

/**
 * Recover one snapshot. Validates every component, rebuilds the assistant task
 * service with the existing recovery helper, preserves the course plan /
 * evidence / adjustments exactly, and returns the classroom recovery point.
 * This function has no side effects: nothing is dispatched, published,
 * replayed or appended. Calling it repeatedly produces identical, independent
 * results and never grows any event/action history.
 */
export function recoverCourseState(
  snapshot: CourseStateSnapshot,
  options: RecoverCourseStateOptions = {},
): CourseStateRecovery {
  const parsed = parseCourseStateSnapshot(snapshot);
  if (options.stageId !== undefined && options.stageId !== parsed.stageId) {
    throw new CourseStatePartitionError(
      `Snapshot ${parsed.id} belongs to stage ${parsed.stageId}, not ${options.stageId}`,
    );
  }
  if (options.learnerId !== undefined && options.learnerId !== parsed.learnerId) {
    throw new CourseStatePartitionError(
      `Snapshot ${parsed.id} belongs to learner ${parsed.learnerId}, not ${options.learnerId}`,
    );
  }

  const teachingActions = foldTeachingActions(parsed.teachingActions.actions);
  const taskService = recoverAssistantTaskSnapshot(parsed.assistantTasks, {
    ...(options.now ? { now: options.now } : {}),
  });
  const evidence = Object.freeze(
    parsed.evidence.map((record) => deepFreeze(record) as EvidenceRecord),
  );
  const adjustments = Object.freeze(
    parsed.adjustments.map((adjustment) => deepFreeze(adjustment) as TeachingAdjustment),
  );
  const appliedAdjustments = Object.freeze(
    adjustments.filter((adjustment) => adjustment.approvalStatus === 'approved'),
  );

  return {
    snapshot: deepFreeze(parsed) as CourseStateSnapshot,
    coursePlan: deepFreeze(parsed.coursePlan) as CoursePlan,
    lessonId: parsed.lessonId,
    teachingActions: Object.freeze({
      actions: Object.freeze(
        teachingActions.actions.map((action) => deepFreeze(action) as TeachingAction),
      ),
      currentNodeId: teachingActions.currentNodeId,
      lastSequence: teachingActions.lastSequence,
    }),
    classroomRecoveryPoint: {
      currentNodeId: teachingActions.currentNodeId,
      lastSequence: teachingActions.lastSequence,
    },
    ...(parsed.progress ? { progress: deepFreeze(parsed.progress) as CourseProgress } : {}),
    assistantTasks: taskService,
    evidence,
    adjustments,
    appliedAdjustments,
  };
}

// ---------------------------------------------------------------------------
// Course entry projection (homepage 同课选择态 / 课后选择态, A2)
// ---------------------------------------------------------------------------

/**
 * 首页同课选择态与课后选择态的只读投影（docs/spec/01-user-journeys.md
 * J4.1–J4.4）：可用入口、「再听」范围与「继续」恢复位置全部从同一份 `C`
 * 快照推导，UI 不得自行解释 progress / lifecycle 字段。
 */
export interface CourseEntryProjection {
  /** 未完成 = in_progress；完成 = archived。旧快照缺省视为未完成。 */
  status: 'in_progress' | 'archived';
  /** 「继续」仅对未完成课程可用（J4.4）；已完成 `C` 必须拒绝。 */
  canContinue: boolean;
  /** 有持久化已讲范围即可「再听」；完成课的已讲范围是全课。 */
  canReplay: boolean;
  /** `replaySession` 的播放范围：严格取 `C` 持久化的已讲范围。 */
  taughtNodeIds: readonly string[];
  /** 「继续」新建 teaching `W` 后要恢复的持久化未完成位置；无则从头开始。 */
  resumeNodeId: string | null;
}

export function resolveCourseEntry(snapshot: CourseStateSnapshot): CourseEntryProjection {
  const parsed = parseCourseStateSnapshot(snapshot);
  const status = parsed.lifecycle?.status ?? 'in_progress';
  const lesson = parsed.coursePlan.lessons.find((candidate) => candidate.id === parsed.lessonId);
  // 快照校验已保证 lessonId 属于 coursePlan；防御未知数据时视为无已讲范围。
  const lessonNodeIds = lesson ? lesson.nodes.map((node) => node.id) : [];
  const taughtNodeIds =
    status === 'archived' ? lessonNodeIds : (parsed.progress?.completedNodeIds ?? []);
  return {
    status,
    canContinue: status !== 'archived',
    canReplay: taughtNodeIds.length > 0,
    taughtNodeIds,
    resumeNodeId: parsed.teachingActions.currentNodeId,
  };
}

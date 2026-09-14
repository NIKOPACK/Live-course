'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  applyLiveCourseTeachingAction,
  createStagePresentationStore,
  type StagePresentationSnapshot,
  type StagePresentationStore,
} from '@/lib/api/stage-api';
import type { RuntimeStore } from '@livecourse/storage';
import { lessonCompletionEventBus, teachingActionBus } from '@/lib/livecourse/actions/bus';
import {
  bindLessonPlanToGeneratedScenes,
  deriveLessonPlanFromStage,
  lessonPlanSchema,
  nodeIdForScene,
  sceneIdFromNodeId,
  projectGoalState,
  teachingActionSchema,
  type EvidenceRecord,
  type GoalState,
  type JsonValue,
  type LessonNodeDesign,
  type LessonPlan,
  type TeachingAction,
  type TeachingActionType,
} from '@/lib/livecourse/domain';
import type { Scene, Stage } from '@/lib/types/stage';
import { listEvidenceRecords } from '@/lib/livecourse/evidence/runtime-repository';
import { createLiveCourseEvidenceService } from '@/lib/livecourse/evidence/runtime-port';
import {
  createTeachingActionRepository,
  livecourseActionSessionId,
  type ClassroomRecoveryPoint,
  type TeachingActionRepository,
  type TeachingActionSnapshot,
} from '@/lib/livecourse/session/action-repository';
import {
  createClassroomController,
  ClassroomActionCommittedError,
  ClassroomStateError,
  ClassroomWorkingMemoryProjectionError,
  readClassroomActionAuthority,
  type ClassroomCompletionResult,
  type ClassroomDispatchResult,
  type ClassroomState,
  type CompleteTeachingNodeInput,
  type FinalizeSessionResult,
  type PresentationApplyResult,
  type SaveAndLeaveSessionResult,
} from '@/lib/livecourse/session/controller';
import {
  createCourseStateRepository,
  type CourseStateRepository,
} from '@/lib/livecourse/session/course-state-repository';
import {
  resolveCourseEntry,
  type CourseStateSnapshot,
} from '@/lib/livecourse/session/course-state-snapshot';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import { useStageStore } from '@/lib/store';
import {
  buildTeacherContext,
  type ExplicitExpression,
  type TeacherContext,
  type TeacherContextMode,
} from '@/lib/livecourse/memory/context';
import {
  createCourseMemoryRepository,
  createLearnerMemoryRepository,
  createWorkingMemoryRepository,
  loadCourseLearningMemory,
  type CourseMemoryRepository,
  type LearnerMemoryRepository,
  type WorkingMemoryRepository,
} from '@/lib/livecourse/memory/repository';
import {
  classroomWorkingMemorySchema,
  MAX_WORKING_INTERRUPTIONS,
  type ClassroomWorkingMemory,
  type CourseLearningMemory,
  type LearnerMemory,
} from '@/lib/livecourse/memory/schemas';
import { type LearnerProfileCandidate } from '@/lib/livecourse/memory/policy';
import {
  archiveWorkingMemoryIntoCourse,
  finalizeSessionLearnerMemory,
} from '@/lib/livecourse/memory/lifecycle';
import {
  createCheckpointSubmissionCoordinator,
  isCompletedCheckpointEvidence,
  type CheckpointTeacherPort,
} from './teaching-flow';

type ActionFor<TType extends TeachingActionType> = Extract<TeachingAction, { type: TType }>;
export type TeachingActionInput = {
  [TType in TeachingActionType]: Pick<ActionFor<TType>, 'type' | 'payload'> & {
    nodeId?: string;
    idempotencyKey?: string;
  };
}[TeachingActionType];

export interface QuizEvidenceInput {
  sceneId: string;
  attemptId: string;
  score: number;
  hasModelGradedItems: boolean;
  modelId?: string;
  inputSummary?: string;
  metadata?: Record<string, JsonValue>;
}

/**
 * Explicitly enter a quiz checkpoint before the learner can answer.
 * `attemptId` is part of the command identity so a retry can reopen the same
 * checkpoint without being mistaken for the previous attempt.
 */
export interface OpenCheckpointInput {
  sceneId: string;
  attemptId: string;
}

interface DispatchResult {
  action: TeachingAction;
  duplicate: boolean;
  presentationHandled: boolean;
}

export interface FinalizeCommittedClassroomDispatchOptions {
  /** The operation that returns only after the authoritative W append. */
  dispatch: () => Promise<ClassroomDispatchResult>;
  /** Persist the companion classroom-W projection for the committed action. */
  persistWorkingMemory: (result: ClassroomDispatchResult) => Promise<unknown>;
  /** Update the provider read-side state from the committed result. */
  applyResult: (result: ClassroomDispatchResult) => DispatchResult;
  /** Fail closed before/after the projection write when the session changed. */
  assertCurrent: () => void;
  isCurrent: () => boolean;
}

/**
 * Finish one already-serialized classroom action at the W/projection
 * boundary.  `dispatch` is authoritative once it resolves; a later
 * projection or lifecycle failure must therefore retain that fact instead of
 * looking like a normal rejected command that callers may safely compensate.
 * Keeping this protocol in one pure helper prevents `emitAction`,
 * `dispatchAction`, and checkpoint entry from drifting apart.
 */
export async function finalizeCommittedClassroomDispatch(
  options: FinalizeCommittedClassroomDispatchOptions,
): Promise<DispatchResult> {
  let committedResult: ClassroomDispatchResult | null = null;
  try {
    const result = await options.dispatch();
    committedResult = result;
    options.assertCurrent();

    try {
      await options.persistWorkingMemory(result);
    } catch (cause) {
      // A projection failure does not undo W.  Apply the authoritative
      // controller result to the read side before surfacing the typed error so
      // the UI still knows which node/state must be reconciled.
      if (!options.isCurrent()) throw cause;
      const committed = new ClassroomWorkingMemoryProjectionError(result, cause);
      options.applyResult(result);
      throw committed;
    }

    options.assertCurrent();
    return options.applyResult(result);
  } catch (cause) {
    const surfacedCause =
      committedResult && readClassroomActionAuthority(cause) === null
        ? new ClassroomActionCommittedError(committedResult, cause)
        : cause;
    throw surfacedCause;
  }
}

export interface LiveCourseSessionValue {
  courseId: string;
  lessonId: string;
  status: 'loading' | 'ready' | 'error';
  lessonPlan: LessonPlan | null;
  /** A1: teach-side design of the active node (teachingPoints, anticipated
   *  questions, …). Null when the plan has no design for the current node —
   *  legacy decks never carry one. */
  currentNodeDesign: LessonNodeDesign | null;
  learnerId: string | null;
  /** A6 bounded teacher context assembled from the allowed memory scopes. */
  teacherContext: TeacherContext;
  /** Same-course C read side; null until hydration completes or when absent. */
  courseMemory: CourseLearningMemory | null;
  /** Learner-only L read side; null until hydration completes or when absent. */
  learnerMemory: LearnerMemory | null;
  evidence: readonly EvidenceRecord[];
  goalStates: readonly GoalState[];
  currentNodeId: string | null;
  lastSequence: number;
  /** A2 课堂状态机（docs/spec/04-detailed-design.md §1）。 */
  classroomState: ClassroomState;
  /** J3.6 课中重听可选范围：已讲（已完成）节点，按完成顺序。 */
  completedNodeIds: readonly string[];
  error: string | null;
  /** Retry failed hydration in the same runtime; never reset the durable session. */
  retryHydration: () => void;
  emitAction: (input: TeachingActionInput) => Promise<DispatchResult>;
  dispatchAction: (action: TeachingAction) => Promise<DispatchResult>;
  openCheckpoint: (input: OpenCheckpointInput) => Promise<DispatchResult>;
  recordQuizEvidence: (input: QuizEvidenceInput) => Promise<EvidenceRecord>;
  registerCheckpointTeacher: (teacher: CheckpointTeacherPort) => () => void;
  /** A2 唯一 `lesson.complete_node` 提交入口：speech / action 均成功结束后才允许调用。 */
  completeTeachingNode: (input: CompleteTeachingNodeInput) => Promise<ClassroomCompletionResult>;
  /** A2/J3.7 唯一「暂时离开课堂」命令：成功（写 C → 销毁 W）后由页面导航回首页。 */
  saveAndLeaveSession: () => Promise<SaveAndLeaveSessionResult>;
  /** A2/J3.8 唯一完成归档命令：仅 `finalizing` 可调用，失败留在 `finalizing` 可重试。 */
  finalizeSession: () => Promise<FinalizeSessionResult>;
}

const LiveCourseSessionContext = createContext<LiveCourseSessionValue | null>(null);

const EMPTY_RECOVERY_POINT: ClassroomRecoveryPoint = {
  currentNodeId: null,
  lastSequence: -1,
};

interface ClassroomActionController {
  load(): Promise<TeachingActionSnapshot>;
  getRecoveryPoint(): Promise<ClassroomRecoveryPoint>;
  dispatch(action: TeachingAction): Promise<ClassroomDispatchResult>;
  completeNode(input: CompleteTeachingNodeInput): Promise<ClassroomCompletionResult>;
  refreshCompletionGate(): Promise<ClassroomState>;
  getState(): ClassroomState;
  getCompletedNodeIds(): readonly string[];
  saveAndLeaveSession(): Promise<SaveAndLeaveSessionResult>;
  finalizeSession(): Promise<FinalizeSessionResult>;
}

interface LiveCourseRuntimeBundle {
  runtime: LiveCourseActionRuntime;
  /** Lifecycle snapshot captured when this runtime was constructed. */
  lifecycleToken: SessionLifecycleToken;
  learnerId: string;
  store: RuntimeStore;
  courseState: Pick<CourseStateRepository, 'load' | 'loadVersioned' | 'save' | 'saveProgress'>;
  learnerMemory: LearnerMemoryRepository;
  courseMemory: CourseMemoryRepository;
  workingMemory: WorkingMemoryRepository;
  /** Canonical-store projection owned by this teaching session. */
  presentationStore: StagePresentationStore;
}

/**
 * A command may outlive the render which created it (for example an audio
 * callback resolving after the classroom changed to replay).  Every durable
 * operation carries this immutable snapshot and is rejected when the
 * provider's current epoch no longer matches it.
 */
interface SessionLifecycleToken {
  epoch: number;
  identity: string;
}

interface SessionLifecycleState extends SessionLifecycleToken {
  enabled: boolean;
  alive: boolean;
}

type CanvasPresentationSnapshot = ReturnType<
  StagePresentationStore['presentation']['canvas']['capture']
>;

type TeachingPresentationImage = {
  stage: StagePresentationSnapshot;
  canvas: CanvasPresentationSnapshot;
};

function captureTeachingPresentationImage(
  presentationStore: StagePresentationStore,
): TeachingPresentationImage {
  return {
    stage: presentationStore.presentation.capture(),
    canvas: presentationStore.presentation.canvas.capture(),
  };
}

function attachPresentationRollback(cause: unknown, rollback: () => void): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause), { cause });
  // The classroom controller knows how to compensate a presentation failure
  // thrown before an apply result is returned. Keep the original error object
  // when it is extensible; otherwise use a wrapper with the same cause.
  try {
    Object.defineProperty(error, 'rollback', {
      configurable: true,
      enumerable: false,
      value: rollback,
      writable: false,
    });
    return error;
  } catch {
    const wrapped = new Error(error.message, { cause: error });
    Object.defineProperty(wrapped, 'rollback', {
      configurable: true,
      enumerable: false,
      value: rollback,
      writable: false,
    });
    return wrapped;
  }
}

function jsonPresentationEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/**
 * Build the production teaching presentation seam.  The returned adapter
 * applies one typed action to a shared Stage projection and exposes a
 * compare-and-set compensation hook for the controller's append boundary.
 * Keeping this seam independent of React makes the failure ordering directly
 * testable: Stage + Canvas are captured before apply, committed only after W,
 * and restored only when no newer writer has changed either image.
 */
export function createTeachingPresentationApplier(options: {
  presentationStore: StagePresentationStore;
  assertActive?: () => void;
  resolveNodeSceneId?: (nodeId: string) => string | undefined;
}): (action: TeachingAction) => Promise<PresentationApplyResult> {
  const { presentationStore, assertActive, resolveNodeSceneId } = options;
  const canvasOwner = presentationStore.presentation.canvas;

  return async (action: TeachingAction): Promise<PresentationApplyResult> => {
    assertActive?.();
    const before = captureTeachingPresentationImage(presentationStore);
    canvasOwner.beginMutation();

    let expected = before;
    let settled: 'pending' | 'committed' | 'rolled-back' = 'pending';

    const rollback = (): void => {
      if (settled !== 'pending') return;

      // Preflight both images before writing either side.  This avoids a
      // predictable partial restore when a concurrent Stage or Canvas writer
      // has already won the race.  The underlying restore calls repeat the
      // CAS at the actual write boundary.
      const currentStage = presentationStore.presentation.capture();
      const stageMatches = jsonPresentationEqual(currentStage, expected.stage);
      const canvasMatches = canvasOwner.canRestoreIfCurrent(before.canvas, expected.canvas);
      if (!stageMatches || !canvasMatches) {
        throw new Error('Teaching presentation changed before rollback could complete');
      }

      const canvasRestored = canvasOwner.restoreIfCurrent(before.canvas, expected.canvas);
      const stageRestored = presentationStore.presentation.restoreIfCurrent(
        before.stage,
        expected.stage,
      );
      if (!canvasRestored || !stageRestored) {
        throw new Error('Teaching presentation changed before rollback could complete');
      }
      // Keep the session baseline alive for a later action, but make the
      // compensated image the owner's new expected value.
      canvasOwner.endMutation();
      settled = 'rolled-back';
    };

    const commit = (): void => {
      if (settled !== 'pending') return;
      // The W append is authoritative now. Retain the current projection and
      // advance the owner's expected image for session disposal.
      canvasOwner.endMutation();
      settled = 'committed';
    };

    try {
      const result = applyLiveCourseTeachingAction(action, presentationStore, {
        resolveNodeSceneId:
          resolveNodeSceneId ??
          ((nodeId) =>
            presentationStore.getState().scenes.find((scene) => nodeIdForScene(scene.id) === nodeId)
              ?.id),
      });
      assertActive?.();
      expected = captureTeachingPresentationImage(presentationStore);
      if (!result.success) return { ...result, rollback };
      return { ...result, rollback, commit };
    } catch (cause) {
      // If the adapter applied part of an action and then threw, expose a
      // compensation hook through the controller's thrown-error seam.
      try {
        expected = captureTeachingPresentationImage(presentationStore);
      } catch {
        // The lifecycle may already have disposed the adapter. The rollback
        // callback will surface that failure to the controller.
      }
      throw attachPresentationRollback(cause, rollback);
    }
  };
}

function sessionLifecycleIdentity(
  stageId: string | undefined,
  courseId: string,
  lessonId: string,
  memoryMode: TeacherContextMode,
): string {
  return JSON.stringify([stageId ?? null, courseId, lessonId, memoryMode]);
}

/**
 * Repository methods contain multiple awaited store operations (read tail,
 * then create/append). Guarding only the repository entry would still leave a
 * race between those calls, so the store itself re-checks the token at every
 * operation boundary.
 */
function guardRuntimeStore(store: RuntimeStore, assertActive: () => void): RuntimeStore {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        assertActive();
        const result = Reflect.apply(value, target, args) as unknown;
        return Promise.resolve(result).then((resolved) => {
          assertActive();
          return resolved;
        });
      };
    },
  });
}

export interface LiveCourseActionRuntimeOptions {
  controller: ClassroomActionController;
  courseId: string;
  lessonId: string;
  getFallbackNodeId: () => string | null;
  /** Optional lifecycle guard; omitted for standalone/runtime unit tests. */
  assertActive?: () => void;
  now?: () => string;
  createActionId?: () => string;
}

export class LiveCourseActionRuntime {
  readonly #controller: ClassroomActionController;
  readonly #courseId: string;
  readonly #lessonId: string;
  readonly #getFallbackNodeId: () => string | null;
  readonly #assertActive?: () => void;
  readonly #now: () => string;
  readonly #createActionId: () => string;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: LiveCourseActionRuntimeOptions) {
    this.#controller = options.controller;
    this.#courseId = options.courseId;
    this.#lessonId = options.lessonId;
    this.#getFallbackNodeId = options.getFallbackNodeId;
    this.#assertActive = options.assertActive;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createActionId = options.createActionId ?? (() => mintId('teaching-action'));
  }

  load(): Promise<TeachingActionSnapshot> {
    return this.#enqueue(() => {
      this.#assertActive?.();
      return this.#controller.load();
    });
  }

  dispatch(action: TeachingAction): Promise<ClassroomDispatchResult> {
    return this.#enqueue(() => {
      this.#assertActive?.();
      // External callers may construct an action before the first classroom
      // hydration.  Complete the same W/C state load used by `emit` before
      // entering the controller's strict loading-state gate.
      return this.#controller
        .load()
        .then(() => this.#controller.dispatch(teachingActionSchema.parse(action)));
    });
  }

  completeNode(input: CompleteTeachingNodeInput): Promise<ClassroomCompletionResult> {
    return this.#enqueue(() => {
      this.#assertActive?.();
      return this.#controller.completeNode(input);
    });
  }

  refreshCompletionGate(): Promise<ClassroomState> {
    return this.#enqueue(() => {
      this.#assertActive?.();
      return this.#controller.refreshCompletionGate();
    });
  }

  getClassroomState(): Promise<ClassroomState> {
    return this.#enqueue(async () => {
      this.#assertActive?.();
      return this.#controller.getState();
    });
  }

  getRecoveryPoint(): Promise<ClassroomRecoveryPoint> {
    return this.#enqueue(async () => {
      this.#assertActive?.();
      return this.#controller.getRecoveryPoint();
    });
  }

  /** J3.6：课中重听可选范围 = 已讲（已完成）节点。 */
  getCompletedNodeIds(): Promise<readonly string[]> {
    return this.#enqueue(async () => {
      this.#assertActive?.();
      return this.#controller.getCompletedNodeIds();
    });
  }

  saveAndLeave(): Promise<SaveAndLeaveSessionResult> {
    return this.#enqueue(() => {
      this.#assertActive?.();
      return this.#controller.saveAndLeaveSession();
    });
  }

  finalize(): Promise<FinalizeSessionResult> {
    return this.#enqueue(() => {
      this.#assertActive?.();
      return this.#controller.finalizeSession();
    });
  }

  /** Resolve after all commands already queued on this runtime have settled. */
  drain(): Promise<void> {
    return this.#queue;
  }

  emit(input: TeachingActionInput): Promise<ClassroomDispatchResult> {
    return this.#enqueue(async () => {
      this.#assertActive?.();
      const recoveryPoint = await this.#controller.getRecoveryPoint();
      this.#assertActive?.();
      const nodeId = input.nodeId ?? recoveryPoint.currentNodeId ?? this.#getFallbackNodeId();
      if (!nodeId) {
        throw new Error('Cannot emit a teaching action without an active lesson node');
      }

      const id = this.#createActionId();
      const action = teachingActionSchema.parse({
        schemaVersion: 1,
        id,
        courseId: this.#courseId,
        lessonId: this.#lessonId,
        nodeId,
        sequence: recoveryPoint.lastSequence + 1,
        timestamp: this.#now(),
        idempotencyKey: input.idempotencyKey ?? id,
        type: input.type,
        payload: input.payload,
      });
      this.#assertActive?.();
      return this.#controller.dispatch(action);
    });
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** A persisted LessonPlan was present but could not be trusted for this stage. */
export class LessonPlanResolutionError extends Error {
  override readonly name = 'LessonPlanResolutionError';
}

/**
 * The teaching session interface is intentionally unavailable while a page is
 * rendering a replay.  Replay has its own ephemeral W and must never route a
 * command through the teaching runtime (which would create the durable
 * teaching-W partition on first append).
 */
export class LiveCourseSessionDisabledError extends Error {
  override readonly name = 'LiveCourseSessionDisabledError';

  constructor() {
    super('LiveCourse teaching session is disabled while replaying');
  }
}

function mintId(prefix: string): string {
  // crypto.randomUUID is secure-context only; over plain HTTP (e.g. a LAN or
  // bare-IP deployment) it is undefined, so fall back to a timestamp id.
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${id}`;
}

/**
 * Project committed teaching actions into the bounded classroom W record.
 * The action log remains authoritative; W is only a short-lived prompt
 * projection and is therefore updated after the controller commits an action.
 */
function projectWorkingMemoryAction(
  current: ClassroomWorkingMemory,
  action: TeachingAction,
): ClassroomWorkingMemory {
  let next: ClassroomWorkingMemory = {
    ...current,
    currentNodeId: action.nodeId,
    updatedAt: action.timestamp,
  };
  switch (action.type) {
    case 'lesson.goto_node':
      next = {
        ...next,
        currentNodeId: action.payload.targetNodeId,
        resumeNodeId: null,
      };
      break;
    case 'lesson.interrupt': {
      const interruption = action.payload.question
        ? {
            id: action.id,
            question: action.payload.question.slice(0, 500),
            resumeNodeId: action.nodeId,
            status: 'open' as const,
            occurredAt: action.timestamp,
          }
        : undefined;
      next = {
        ...next,
        resumeNodeId: action.nodeId,
        ...(interruption
          ? {
              interruptions: [
                ...next.interruptions.filter((item) => item.id !== interruption.id),
                interruption,
              ].slice(-MAX_WORKING_INTERRUPTIONS),
            }
          : {}),
      };
      break;
    }
    case 'lesson.resume_interrupted':
      next = {
        ...next,
        currentNodeId: action.payload.targetNodeId,
        resumeNodeId: null,
        interruptions: next.interruptions.map((item) =>
          item.resumeNodeId === action.payload.targetNodeId && item.status === 'open'
            ? { ...item, status: 'answered' as const }
            : item,
        ),
      };
      break;
    case 'lesson.relisten_start':
      next = { ...next, currentNodeId: action.payload.targetNodeId };
      break;
    case 'lesson.relisten_end':
      next = { ...next, currentNodeId: action.payload.targetNodeId };
      break;
    case 'checkpoint.open':
      next = {
        ...next,
        currentNodeId: action.nodeId,
        currentAnswer: {
          nodeId: action.nodeId,
          checkpointId: action.payload.checkpointId,
          status: 'answering',
          updatedAt: action.timestamp,
        },
      };
      break;
    case 'checkpoint.submit':
      next = {
        ...next,
        currentNodeId: action.nodeId,
        currentAnswer: {
          nodeId: action.nodeId,
          checkpointId: action.payload.checkpointId,
          status: 'submitted',
          updatedAt: action.timestamp,
        },
      };
      break;
    case 'checkpoint.close':
      next = { ...next, currentAnswer: null };
      break;
    default:
      break;
  }
  return classroomWorkingMemorySchema.parse(next);
}

function projectWorkingMemoryCompletion(
  current: ClassroomWorkingMemory,
  nodeId: string,
  timestamp: string,
): ClassroomWorkingMemory {
  return classroomWorkingMemorySchema.parse({
    ...current,
    currentNodeId: nodeId,
    resumeNodeId: null,
    currentAnswer: null,
    updatedAt: timestamp,
  });
}

/**
 * A1 read side (docs/spec/04-detailed-design.md §5/§7): prefer the lesson plan
 * persisted in the document outline snapshot; only decks without one (legacy
 * imports, or a plan whose generation was skipped/failed) fall back to
 * deriving a plan from stage + scenes. A present snapshot is authoritative:
 * malformed or cross-stage/course data fails loudly instead of being silently
 * re-derived under a different identity.
 */
export function resolveLessonPlan(input: {
  stage: Stage;
  scenes: readonly Scene[];
  persistedLessonPlan?: unknown;
  /** Expected durable course identity for a persisted plan. */
  courseId?: string;
  now?: string;
}): LessonPlan {
  // `undefined` and `null` both mean that the document predates A1. Only
  // that explicit absence is allowed to derive a legacy plan. Once a caller
  // has persisted a non-null envelope, corrupt or cross-stage data is a
  // durability error and must remain visible instead of being replaced by a
  // different source of truth.
  if (input.persistedLessonPlan == null) {
    return bindResolvedLessonPlan(
      deriveLessonPlanFromStage({ stage: input.stage, scenes: input.scenes, now: input.now }),
      input.scenes,
    );
  }

  const parsed = lessonPlanSchema.safeParse(input.persistedLessonPlan);
  if (!parsed.success) {
    throw new LessonPlanResolutionError(
      `Persisted lesson plan for stage ${JSON.stringify(input.stage.id)} is invalid`,
    );
  }
  if (parsed.data.stageId !== input.stage.id) {
    throw new LessonPlanResolutionError(
      `Persisted lesson plan belongs to stage ${JSON.stringify(parsed.data.stageId)}, not ${JSON.stringify(input.stage.id)}`,
    );
  }
  if (input.courseId !== undefined && parsed.data.courseId !== input.courseId) {
    throw new LessonPlanResolutionError(
      `Persisted lesson plan belongs to course ${JSON.stringify(parsed.data.courseId)}, not ${JSON.stringify(input.courseId)}`,
    );
  }
  return bindResolvedLessonPlan(parsed.data, input.scenes);
}

function bindResolvedLessonPlan(plan: LessonPlan, scenes: readonly Scene[]): LessonPlan {
  try {
    return bindLessonPlanToGeneratedScenes(plan, scenes);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new LessonPlanResolutionError(message);
  }
}

/**
 * J4.4 首页同课「继续」的恢复目标（docs/spec/04-detailed-design.md §1）：
 * 仅当本次 teaching `W` 为空（旧 `W` 已由 saveAndLeave/finalize 销毁）且
 * `C` 未完成（archived 课程拒绝「继续」）时，才从 `C` 的持久化未完成位置
 * 恢复；绝不恢复旧 `W`。
 */
export function resolveResumeNodeId(input: {
  work: TeachingActionSnapshot;
  courseState: CourseStateSnapshot | null | undefined;
}): string | null {
  if (input.work.actions.length > 0) return null;
  const snapshot = input.courseState;
  if (!snapshot) return null;
  if (!resolveCourseEntry(snapshot).canContinue) return null;
  return snapshot.teachingActions.currentNodeId;
}

export function resolveRecoverySceneId(
  recoveryPoint: ClassroomRecoveryPoint,
  lessonPlan: LessonPlan | null,
  scenes: readonly Scene[] = [],
): string | null {
  if (!recoveryPoint.currentNodeId) return null;
  const recovered = resolveRecoveredSceneId(recoveryPoint.currentNodeId, lessonPlan, scenes);
  if (!recovered) {
    throw new Error(
      `Cannot restore unknown lesson node ${JSON.stringify(recoveryPoint.currentNodeId)}`,
    );
  }
  return recovered;
}

function resolveRecoveredSceneId(
  currentNodeId: string,
  lessonPlan: LessonPlan | null,
  scenes: readonly Scene[],
): string | null {
  const nodeById = lessonPlan?.nodes.find((candidate) => candidate.id === currentNodeId);
  if (nodeById) return sceneIdForLessonNode(nodeById.sceneId, scenes);

  const suffix = sceneIdFromNodeId(currentNodeId) ?? currentNodeId;
  const nodeBySceneId = lessonPlan?.nodes.find((candidate) => candidate.sceneId === suffix);
  if (nodeBySceneId) return sceneIdForLessonNode(nodeBySceneId.sceneId, scenes);

  const scene =
    scenes.find((candidate) => candidate.id === suffix) ??
    scenes.find((candidate) => candidate.outlineId === suffix);
  if (!scene) return null;
  if (!lessonPlan) return scene.id;

  const nodeForScene = lessonPlan.nodes.find(
    (candidate) =>
      candidate.sceneId === scene.id ||
      candidate.sceneId === scene.outlineId ||
      candidate.id === nodeIdForScene(scene.id) ||
      (scene.outlineId != null && candidate.id === nodeIdForScene(scene.outlineId)),
  );
  return nodeForScene ? scene.id : null;
}

function sceneIdForLessonNode(sceneId: string, scenes: readonly Scene[]): string {
  if (scenes.some((scene) => scene.id === sceneId)) return sceneId;
  const byOutline = scenes.find((scene) => scene.outlineId === sceneId);
  return byOutline?.id ?? sceneId;
}

export function LiveCourseSessionProvider({
  courseId,
  lessonId,
  sessionEnabled = true,
  memoryMode = 'in-class',
  explicitTeacherContext,
  learnerMemoryCandidates = [],
  defaultTeacherContext,
  children,
}: {
  courseId: string;
  lessonId: string;
  /** replay 模式下为 false：不水合 teaching 会话、不恢复 W，上下文仅供
   *  只读消费者（此时 learnerId 为空，recordQuizEvidence 等写命令自然被拒绝，
   *  保证 replay 不新增 EvidenceRecord）。 */
  sessionEnabled?: boolean;
  /** A6 read matrix. Teaching defaults to `in-class`; generation callers may
   *  use `new-course` to make the C boundary impossible to read. */
  memoryMode?: TeacherContextMode;
  /** Explicit learner expression, highest context priority; never persisted by
   *  this provider and therefore remains scoped to the current course. */
  explicitTeacherContext?: readonly ExplicitExpression[];
  /** Model-produced L candidates. The finalization policy is the only writer. */
  learnerMemoryCandidates?: readonly LearnerProfileCandidate[];
  /** Lowest-priority defaults for the bounded teacher context. */
  defaultTeacherContext?: readonly ExplicitExpression[];
  children: ReactNode;
}) {
  const stage = useStageStore((state) => state.stage);
  const stageId = stage?.id;
  const scenes = useStageStore((state) => state.scenes);
  const persistedLessonPlan = useStageStore((state) => state.lessonPlan);
  const [learnerId, setLearnerId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [status, setStatus] = useState<LiveCourseSessionValue['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [hydrationAttempt, setHydrationAttempt] = useState(0);
  const hydrationRetryAvailableRef = useRef(false);
  const [recoveryPoint, setRecoveryPoint] = useState<ClassroomRecoveryPoint>(EMPTY_RECOVERY_POINT);
  const [classroomState, setClassroomState] = useState<ClassroomState>('loading');
  /** J3.6 课中重听可选范围（已讲节点），随水合与 complete_node 更新。 */
  const [completedNodeIds, setCompletedNodeIds] = useState<readonly string[]>([]);
  const checkpointTeacherRef = useRef<CheckpointTeacherPort | null>(null);
  const checkpointSubmissionsRef = useRef(createCheckpointSubmissionCoordinator<EvidenceRecord>());
  const registerCheckpointTeacher = useCallback((teacher: CheckpointTeacherPort) => {
    checkpointTeacherRef.current = teacher;
    return () => {
      if (checkpointTeacherRef.current === teacher) checkpointTeacherRef.current = null;
    };
  }, []);
  // Keep command closures fail-closed across a replay/session transition. A
  // callback captured by an in-flight playback effect can outlive the render
  // that created it; the epoch makes that stale closure unable to construct a
  // repository or commit a durable write.
  const lifecycleIdentity = sessionLifecycleIdentity(stageId, courseId, lessonId, memoryMode);
  const lifecycleStateRef = useRef<SessionLifecycleState>({
    epoch: 0,
    identity: lifecycleIdentity,
    enabled: sessionEnabled,
    alive: true,
  });
  const sessionEnabledRef = useRef(sessionEnabled);
  const providerAliveRef = useRef(true);
  const previousLifecycle = lifecycleStateRef.current;
  if (
    previousLifecycle.identity !== lifecycleIdentity ||
    previousLifecycle.enabled !== sessionEnabled
  ) {
    lifecycleStateRef.current = {
      epoch: previousLifecycle.epoch + 1,
      identity: lifecycleIdentity,
      enabled: sessionEnabled,
      alive: previousLifecycle.alive,
    };
  }
  // This assignment is intentionally synchronous.  An effect runs after the
  // render that disables replay, leaving a window in which an old callback
  // could otherwise observe the previous `true` value.
  sessionEnabledRef.current = sessionEnabled;
  const renderLifecycleEpoch = lifecycleStateRef.current.epoch;
  const renderLifecycleIdentity = lifecycleStateRef.current.identity;
  // Keep the token referentially stable for a render epoch.  Several callbacks
  // intentionally depend on the token's identity rather than on every render;
  // recreating it here would restart hydration effects unnecessarily.
  const renderLifecycleToken = useMemo<SessionLifecycleToken>(
    () => ({ epoch: renderLifecycleEpoch, identity: renderLifecycleIdentity }),
    [renderLifecycleEpoch, renderLifecycleIdentity],
  );
  useEffect(() => {
    providerAliveRef.current = true;
    lifecycleStateRef.current = {
      ...lifecycleStateRef.current,
      alive: true,
      enabled: sessionEnabledRef.current,
    };
    return () => {
      providerAliveRef.current = false;
      lifecycleStateRef.current = {
        ...lifecycleStateRef.current,
        enabled: false,
        alive: false,
      };
    };
  }, []);

  const isLifecycleTokenCurrent = useCallback((token: SessionLifecycleToken): boolean => {
    const current = lifecycleStateRef.current;
    return (
      sessionEnabledRef.current &&
      providerAliveRef.current &&
      current.enabled &&
      current.alive &&
      current.epoch === token.epoch &&
      current.identity === token.identity
    );
  }, []);

  const assertLifecycleToken = useCallback(
    (token: SessionLifecycleToken): void => {
      if (!isLifecycleTokenCurrent(token)) throw new LiveCourseSessionDisabledError();
    },
    [isLifecycleTokenCurrent],
  );

  const assertTeachingCommandsEnabled = useCallback((): SessionLifecycleToken => {
    assertLifecycleToken(renderLifecycleToken);
    return renderLifecycleToken;
  }, [assertLifecycleToken, renderLifecycleToken]);
  const [courseMemory, setCourseMemory] = useState<CourseLearningMemory | null>(null);
  const [learnerMemory, setLearnerMemory] = useState<LearnerMemory | null>(null);
  const [teacherContext, setTeacherContext] = useState<TeacherContext>(() =>
    buildTeacherContext({
      mode: memoryMode,
      explicit: explicitTeacherContext,
      defaults: defaultTeacherContext,
    }),
  );
  // Candidates may be produced by an async generation / review flow while
  // this provider stays mounted.  The cached runtime must always finalize
  // against the latest candidate set without being recreated (which would
  // split the classroom queue and its idempotency state).
  const learnerMemoryCandidatesRef = useRef(learnerMemoryCandidates);
  const explicitTeacherContextRef = useRef(explicitTeacherContext);
  useEffect(() => {
    learnerMemoryCandidatesRef.current = learnerMemoryCandidates;
  }, [learnerMemoryCandidates]);
  useEffect(() => {
    explicitTeacherContextRef.current = explicitTeacherContext;
  }, [explicitTeacherContext]);

  const lessonPlan = useMemo(
    () => (stage ? resolveLessonPlan({ stage, scenes, persistedLessonPlan, courseId }) : null),
    [courseId, scenes, stage, persistedLessonPlan],
  );

  const runtimeCacheRef = useRef<{ key: string; promise: Promise<LiveCourseRuntimeBundle> } | null>(
    null,
  );
  const runtimeBundlesRef = useRef(new Set<LiveCourseRuntimeBundle>());

  const getActionRuntime = useCallback(() => {
    const lifecycleToken = renderLifecycleToken;
    try {
      assertLifecycleToken(lifecycleToken);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!stageId) return Promise.reject(new Error('LiveCourse stage is not ready'));
    const key = JSON.stringify([lifecycleToken.identity, lifecycleToken.epoch]);
    const cached = runtimeCacheRef.current;
    if (cached?.key === key && cached.promise) return cached.promise;

    const promise = getLearnerKey().then((activeLearnerId) => {
      assertLifecycleToken(lifecycleToken);
      const store = guardRuntimeStore(getRuntimeStore(), () =>
        assertLifecycleToken(lifecycleToken),
      );
      const repository = createTeachingActionRepository({
        store,
        stageId,
        learnerId: activeLearnerId,
        courseId,
        lessonId,
      });
      // C：同一协调器立即持久化 completedNode / progress 的 repository。
      const courseState = createCourseStateRepository({
        store,
        stageId,
        learnerId: activeLearnerId,
        courseId,
      });
      const learnerMemory = createLearnerMemoryRepository({
        store,
        // L is learner-only.  The repository deliberately normalizes the
        // optional route stage to its reserved physical partition.
        scope: { stageId, learnerId: activeLearnerId },
      });
      const activeStage = useStageStore.getState();
      if (!activeStage.stage) {
        throw new Error('LiveCourse stage is not ready');
      }
      const activeLessonPlan = resolveLessonPlan({
        stage: activeStage.stage,
        scenes: activeStage.scenes,
        persistedLessonPlan: activeStage.lessonPlan,
        courseId,
      });
      // One presentation adapter belongs to one teaching runtime.  It is
      // lazy-fenced so constructing a provider during a concurrent render
      // cannot pause document persistence before the first visual mutation.
      const presentationStore = createStagePresentationStore({ fence: 'lazy' });
      const classroomSessionId = livecourseActionSessionId({
        stageId,
        learnerId: activeLearnerId,
        courseId,
        lessonId,
      });
      const workingMemory = createWorkingMemoryRepository({
        store,
        scope: {
          stageId,
          learnerId: activeLearnerId,
          classroomSessionId,
          courseId,
          lessonId,
        },
      });
      const courseMemory = createCourseMemoryRepository({
        store,
        scope: { stageId, learnerId: activeLearnerId, courseId },
      });
      assertLifecycleToken(lifecycleToken);

      const guardedWorkingMemory: WorkingMemoryRepository = {
        load: async () => {
          assertLifecycleToken(lifecycleToken);
          const value = await workingMemory.load();
          assertLifecycleToken(lifecycleToken);
          return value;
        },
        update: async (update) => {
          assertLifecycleToken(lifecycleToken);
          const value = await workingMemory.update(update);
          assertLifecycleToken(lifecycleToken);
          return value;
        },
        destroy: async () => {
          assertLifecycleToken(lifecycleToken);
          await workingMemory.destroy();
          assertLifecycleToken(lifecycleToken);
        },
      };
      const guardedCourseMemory: CourseMemoryRepository = {
        load: async () => {
          assertLifecycleToken(lifecycleToken);
          const value = await courseMemory.load();
          assertLifecycleToken(lifecycleToken);
          return value;
        },
        update: async (update) => {
          assertLifecycleToken(lifecycleToken);
          const value = await courseMemory.update(update);
          assertLifecycleToken(lifecycleToken);
          return value;
        },
        destroy: async () => {
          assertLifecycleToken(lifecycleToken);
          await courseMemory.destroy();
          assertLifecycleToken(lifecycleToken);
        },
      };
      const guardedLearnerMemory: LearnerMemoryRepository = {
        load: async () => {
          assertLifecycleToken(lifecycleToken);
          const value = await learnerMemory.load();
          assertLifecycleToken(lifecycleToken);
          return value;
        },
        update: async (update) => {
          assertLifecycleToken(lifecycleToken);
          const value = await learnerMemory.update(update);
          assertLifecycleToken(lifecycleToken);
          return value;
        },
        destroy: async () => {
          assertLifecycleToken(lifecycleToken);
          await learnerMemory.destroy();
          assertLifecycleToken(lifecycleToken);
        },
      };

      // The controller calls these ports at several asynchronous boundaries.
      // Guard every invocation so a transition between its reads and writes
      // cannot enqueue another durable operation from this stale session.
      const guardedRepository: TeachingActionRepository = {
        load: async () => {
          assertLifecycleToken(lifecycleToken);
          const snapshot = await repository.load();
          assertLifecycleToken(lifecycleToken);
          return snapshot;
        },
        inspect: async (action) => {
          assertLifecycleToken(lifecycleToken);
          const inspection = await repository.inspect(action);
          assertLifecycleToken(lifecycleToken);
          return inspection;
        },
        append: async (action) => {
          assertLifecycleToken(lifecycleToken);
          const result = await repository.append(action);
          assertLifecycleToken(lifecycleToken);
          return result;
        },
        destroy: async () => {
          assertLifecycleToken(lifecycleToken);
          await repository.destroy();
          assertLifecycleToken(lifecycleToken);
        },
      };
      const guardedCourseState = {
        load: async () => {
          assertLifecycleToken(lifecycleToken);
          const snapshot = await courseState.load();
          assertLifecycleToken(lifecycleToken);
          return snapshot;
        },
        loadVersioned: async () => {
          assertLifecycleToken(lifecycleToken);
          const versioned = await courseState.loadVersioned();
          assertLifecycleToken(lifecycleToken);
          return versioned;
        },
        save: async (
          input: Parameters<ReturnType<typeof createCourseStateRepository>['save']>[0],
          options?: Parameters<ReturnType<typeof createCourseStateRepository>['save']>[1],
        ) => {
          assertLifecycleToken(lifecycleToken);
          const snapshot = await courseState.save(input, options);
          assertLifecycleToken(lifecycleToken);
          return snapshot;
        },
        saveProgress: async (input: Parameters<CourseStateRepository['saveProgress']>[0]) => {
          assertLifecycleToken(lifecycleToken);
          const snapshot = await courseState.saveProgress(input);
          assertLifecycleToken(lifecycleToken);
          return snapshot;
        },
      };
      const applyPresentation = createTeachingPresentationApplier({
        presentationStore,
        assertActive: () => assertLifecycleToken(lifecycleToken),
      });
      const controller = createClassroomController({
        repository: guardedRepository,
        applyPresentation,
        publish: async (action) => {
          assertLifecycleToken(lifecycleToken);
          await teachingActionBus.publish(action);
          assertLifecycleToken(lifecycleToken);
        },
        lifecycle: {
          classroomSessionId,
          courseState: guardedCourseState,
          destroyWorkSession: async () => {
            // The action log and the A6 working-memory record are one
            // classroom W lifecycle.  Both are destroyed only after C (and,
            // for finalization, L) has succeeded; each repository's destroy
            // operation is idempotent so a retry can finish the other half.
            assertLifecycleToken(lifecycleToken);
            const working = await guardedWorkingMemory.load();
            assertLifecycleToken(lifecycleToken);
            const composed = await loadCourseLearningMemory({
              store,
              scope: { stageId, learnerId: activeLearnerId, courseId },
              courseState: guardedCourseState,
              goalRules: Object.fromEntries(
                activeLessonPlan.goals.map((goal) => [goal.id, goal.rule]),
              ),
              assertActive: () => assertLifecycleToken(lifecycleToken),
            });
            assertLifecycleToken(lifecycleToken);
            await archiveWorkingMemoryIntoCourse({
              courseMemory: guardedCourseMemory,
              workingMemory: working,
              goalStates: composed.goalStates,
            });
            assertLifecycleToken(lifecycleToken);
            await repository.destroy();
            assertLifecycleToken(lifecycleToken);
            await guardedWorkingMemory.destroy();
            assertLifecycleToken(lifecycleToken);
          },
          finalizeLearnerMemory: async () => {
            // Policy is the sole L writer. Empty/non-long-term candidates are
            // a no-op and must not create an empty learner session.
            assertLifecycleToken(lifecycleToken);
            const working = await guardedWorkingMemory.load();
            assertLifecycleToken(lifecycleToken);
            const composed = await loadCourseLearningMemory({
              store,
              scope: { stageId, learnerId: activeLearnerId, courseId },
              courseState: guardedCourseState,
              goalRules: Object.fromEntries(
                activeLessonPlan.goals.map((goal) => [goal.id, goal.rule]),
              ),
              assertActive: () => assertLifecycleToken(lifecycleToken),
            });
            assertLifecycleToken(lifecycleToken);
            await finalizeSessionLearnerMemory({
              learnerMemory: guardedLearnerMemory,
              courseMemory: guardedCourseMemory,
              workingMemory: working,
              intake: composed.intake,
              explicit: explicitTeacherContextRef.current,
              extraCandidates: learnerMemoryCandidatesRef.current,
              goalStates: composed.goalStates,
            });
            assertLifecycleToken(lifecycleToken);
          },
        },
        completion: {
          classroomSessionId,
          courseId,
          lessonId,
          lessonPlan: activeLessonPlan,
          progressStore: {
            load: guardedCourseState.load,
            saveProgress: guardedCourseState.saveProgress,
          },
          // Submitted model grades can finish a checkpoint without being
          // accepted as mastery evidence. Keep their pending-review provenance.
          hasValidEvidence: async (nodeId) => {
            assertLifecycleToken(lifecycleToken);
            const records = await listEvidenceRecords(stageId, {
              learnerId: activeLearnerId,
              courseId,
              assertActive: () => assertLifecycleToken(lifecycleToken),
            });
            assertLifecycleToken(lifecycleToken);
            return records.some(
              (record) => record.nodeId === nodeId && isCompletedCheckpointEvidence(record),
            );
          },
          publishEvent: async (event) => {
            assertLifecycleToken(lifecycleToken);
            await lessonCompletionEventBus.publish(event);
            assertLifecycleToken(lifecycleToken);
          },
        },
      });
      const runtime = new LiveCourseActionRuntime({
        controller,
        courseId,
        lessonId,
        assertActive: () => assertLifecycleToken(lifecycleToken),
        getFallbackNodeId: () => {
          const activeStage = useStageStore.getState();
          if (activeStage.stage?.id !== stageId || !activeStage.currentSceneId) return null;
          return nodeIdForScene(activeStage.currentSceneId);
        },
      });
      const bundle = {
        runtime,
        lifecycleToken,
        learnerId: activeLearnerId,
        store,
        courseState: guardedCourseState,
        learnerMemory: guardedLearnerMemory,
        courseMemory: guardedCourseMemory,
        workingMemory: guardedWorkingMemory,
        presentationStore,
      };
      runtimeBundlesRef.current.add(bundle);
      return bundle;
    });
    runtimeCacheRef.current = { key, promise };
    // A rejected initialization must not poison retries after a transient
    // storage/identity failure or a replay transition.
    void promise.catch(() => {
      if (runtimeCacheRef.current?.key === key && runtimeCacheRef.current.promise === promise) {
        runtimeCacheRef.current = null;
      }
    });
    return promise;
  }, [assertLifecycleToken, courseId, lessonId, renderLifecycleToken, stageId]);

  // A runtime owns a canonical presentation projection for the whole
  // lifecycle.  On provider unmount or a session/replay transition, wait for
  // its serialized command queue before disposing the adapter.  Disposal
  // restores Stage + Canvas before releasing the persistence fence, so a
  // pending document flush can never snapshot replay/teaching-only values.
  useEffect(() => {
    const lifecycleToken = renderLifecycleToken;
    const runtimeBundles = runtimeBundlesRef.current;
    return () => {
      const bundles = [...runtimeBundles].filter(
        (bundle) =>
          bundle.lifecycleToken.epoch === lifecycleToken.epoch &&
          bundle.lifecycleToken.identity === lifecycleToken.identity,
      );
      for (const bundle of bundles) {
        void bundle.runtime
          .drain()
          .then(() => {
            if (!bundle.presentationStore.presentation.isDisposed()) {
              bundle.presentationStore.presentation.dispose();
            }
            runtimeBundles.delete(bundle);
            const cached = runtimeCacheRef.current;
            if (cached?.key === JSON.stringify([lifecycleToken.identity, lifecycleToken.epoch])) {
              runtimeCacheRef.current = null;
            }
          })
          .catch((cause) => {
            // Cleanup cannot throw through React's effect boundary.  Surface
            // the root cause and retain the bundle for an explicit retry or
            // later unmount instead of silently dropping a live fence.
            console.error('[LiveCourse] Failed to dispose presentation runtime', cause);
          });
      }
    };
  }, [renderLifecycleToken]);

  const disposePresentationBundle = useCallback((bundle: LiveCourseRuntimeBundle): void => {
    if (!bundle.presentationStore.presentation.isDisposed()) {
      bundle.presentationStore.presentation.dispose();
    }
    runtimeBundlesRef.current.delete(bundle);
    const key = JSON.stringify([bundle.lifecycleToken.identity, bundle.lifecycleToken.epoch]);
    if (runtimeCacheRef.current?.key === key) runtimeCacheRef.current = null;
  }, []);

  /**
   * Read the A6 scopes for the active classroom and publish one bounded
   * teacher-context projection.  Repository reads are intentionally strict:
   * malformed rows or a storage failure reject this operation and therefore
   * enter the existing session hydration error path instead of becoming an
   * apparently empty memory state.
   */
  const memoryRefreshGenerationRef = useRef(0);
  const refreshMemoryContext = useCallback(
    async (
      bundle: LiveCourseRuntimeBundle,
      canCommit: () => boolean = () => true,
    ): Promise<void> => {
      const lifecycleToken = bundle.lifecycleToken;
      assertLifecycleToken(lifecycleToken);
      const refreshGeneration = ++memoryRefreshGenerationRef.current;
      const activeStage = useStageStore.getState();
      if (!activeStage.stage || activeStage.stage.id !== stageId) {
        throw new Error('LiveCourse stage changed while loading learning memory');
      }
      const activeLessonPlan = resolveLessonPlan({
        stage: activeStage.stage,
        scenes: activeStage.scenes,
        persistedLessonPlan: activeStage.lessonPlan,
        courseId,
      });
      const goalRules = Object.fromEntries(
        activeLessonPlan.goals.map((goal) => [goal.id, goal.rule]),
      );

      const [loadedLearnerMemory, loadedCourseMemory, loadedWorkingMemory] = await Promise.all([
        bundle.learnerMemory.load(),
        memoryMode === 'new-course'
          ? Promise.resolve(undefined)
          : loadCourseLearningMemory({
              store: bundle.store,
              scope: { stageId, learnerId: bundle.learnerId, courseId },
              courseState: bundle.courseState,
              goalRules,
              assertActive: () => assertLifecycleToken(lifecycleToken),
            }),
        memoryMode === 'in-class' ? bundle.workingMemory.load() : Promise.resolve(undefined),
      ]);

      assertLifecycleToken(lifecycleToken);

      // A refresh may finish after navigation or a replay transition.  Do not
      // let an old classroom overwrite the newly mounted provider's state.
      if (
        refreshGeneration !== memoryRefreshGenerationRef.current ||
        !canCommit() ||
        !isLifecycleTokenCurrent(lifecycleToken)
      ) {
        return;
      }
      const nextTeacherContext = buildTeacherContext({
        mode: memoryMode,
        explicit: explicitTeacherContext,
        workingMemory: loadedWorkingMemory,
        courseMemory: loadedCourseMemory,
        learnerMemory: loadedLearnerMemory,
        defaults: defaultTeacherContext,
      });
      setCourseMemory(loadedCourseMemory ?? null);
      setLearnerMemory(loadedLearnerMemory ?? null);
      setTeacherContext(nextTeacherContext);
    },
    [
      assertLifecycleToken,
      courseId,
      defaultTeacherContext,
      explicitTeacherContext,
      isLifecycleTokenCurrent,
      memoryMode,
      stageId,
    ],
  );

  // Keep W projections in commit order even when several realtime commands
  // resolve concurrently. The teaching-action runtime serializes its own
  // authoritative queue; this companion queue prevents a slower memory write
  // from overwriting a newer node/answer projection.
  const workingMemoryQueueRef = useRef<{ epoch: number; promise: Promise<void> }>({
    epoch: lifecycleStateRef.current.epoch,
    promise: Promise.resolve(),
  });
  const persistWorkingMemoryAction = useCallback(
    (bundle: LiveCourseRuntimeBundle, action: TeachingAction): Promise<ClassroomWorkingMemory> => {
      const lifecycleToken = bundle.lifecycleToken;
      assertLifecycleToken(lifecycleToken);
      if (workingMemoryQueueRef.current.epoch !== lifecycleToken.epoch) {
        // A stale write must never hold a newly mounted session behind its
        // queue (it is already guarded and will fail closed when it runs).
        workingMemoryQueueRef.current = {
          epoch: lifecycleToken.epoch,
          promise: Promise.resolve(),
        };
      }
      const write = workingMemoryQueueRef.current.promise.then(async () => {
        assertLifecycleToken(lifecycleToken);
        const next = await bundle.workingMemory.update((current) =>
          projectWorkingMemoryAction(current, action),
        );
        assertLifecycleToken(lifecycleToken);
        return next;
      });
      workingMemoryQueueRef.current = {
        epoch: lifecycleToken.epoch,
        promise: write.then(
          () => undefined,
          () => undefined,
        ),
      };
      return write;
    },
    [assertLifecycleToken],
  );

  const persistWorkingMemoryCompletion = useCallback(
    (
      bundle: LiveCourseRuntimeBundle,
      nodeId: string,
      timestamp: string,
    ): Promise<ClassroomWorkingMemory> => {
      const lifecycleToken = bundle.lifecycleToken;
      assertLifecycleToken(lifecycleToken);
      if (workingMemoryQueueRef.current.epoch !== lifecycleToken.epoch) {
        workingMemoryQueueRef.current = {
          epoch: lifecycleToken.epoch,
          promise: Promise.resolve(),
        };
      }
      const write = workingMemoryQueueRef.current.promise.then(async () => {
        assertLifecycleToken(lifecycleToken);
        const next = await bundle.workingMemory.update((current) =>
          projectWorkingMemoryCompletion(current, nodeId, timestamp),
        );
        assertLifecycleToken(lifecycleToken);
        return next;
      });
      workingMemoryQueueRef.current = {
        epoch: lifecycleToken.epoch,
        promise: write.then(
          () => undefined,
          () => undefined,
        ),
      };
      return write;
    },
    [assertLifecycleToken],
  );

  const retryHydration = useCallback(() => {
    assertLifecycleToken(renderLifecycleToken);
    // Consume the failed attempt synchronously: rapid clicks and callbacks
    // captured before a successful retry must not start another hydration.
    if (!hydrationRetryAvailableRef.current) return;
    hydrationRetryAvailableRef.current = false;
    setStatus('loading');
    setError(null);
    setHydrationAttempt((attempt) => attempt + 1);
  }, [assertLifecycleToken, renderLifecycleToken]);

  useEffect(() => {
    if (!stageId || !sessionEnabled) return;
    let cancelled = false;
    let lifecycleToken: SessionLifecycleToken;
    try {
      lifecycleToken = {
        epoch: lifecycleStateRef.current.epoch,
        identity: lifecycleStateRef.current.identity,
      };
      assertLifecycleToken(lifecycleToken);
    } catch {
      return;
    }

    const assertHydrationActive = () => {
      assertLifecycleToken(lifecycleToken);
      if (cancelled) throw new LiveCourseSessionDisabledError();
    };
    hydrationRetryAvailableRef.current = false;

    // A new storage partition must not expose the previous classroom's hydrated state.
    setStatus('loading');
    setError(null);
    setLearnerId(null);
    setEvidence([]);
    setRecoveryPoint(EMPTY_RECOVERY_POINT);
    setClassroomState('loading');
    setCompletedNodeIds([]);
    setCourseMemory(null);
    setLearnerMemory(null);
    setTeacherContext(
      buildTeacherContext({
        mode: memoryMode,
        explicit: explicitTeacherContext,
        defaults: defaultTeacherContext,
      }),
    );

    void getActionRuntime()
      .then(async (bundle) => {
        assertHydrationActive();
        const { runtime, learnerId: activeLearnerId, courseState } = bundle;
        const records = await listEvidenceRecords(stageId, {
          learnerId: activeLearnerId,
          courseId,
          assertActive: assertHydrationActive,
        });
        assertHydrationActive();
        // The runtime queue places this read after any action emitted during hydration.
        const snapshot = await runtime.load();
        assertHydrationActive();
        let recovery: ClassroomRecoveryPoint = {
          currentNodeId: snapshot.currentNodeId,
          lastSequence: snapshot.lastSequence,
        };
        // J4.4「继续」：新 teaching W 为空且 C 未完成时，以幂等 goto_node
        // 恢复 C 的持久化未完成位置；同一 C 快照的重进复用同一 key 判重。
        // A newly generated course is an explicit C boundary: do not inspect
        // any prior course-state snapshot while hydrating this provider.
        const courseSnapshot = memoryMode === 'new-course' ? undefined : await courseState.load();
        assertHydrationActive();
        const resumeNodeId = resolveResumeNodeId({ work: snapshot, courseState: courseSnapshot });
        const resumeKey = courseSnapshot ? `resume-c:${courseSnapshot.id}` : undefined;
        const lastAction = snapshot.actions.at(-1);
        // A previous attempt may have committed the resume action before its
        // presentation or W-memory projection failed. Reconcile that same
        // action through the controller, then the idempotent memory projection.
        let resumeAction =
          lastAction?.type === 'lesson.goto_node' && lastAction.idempotencyKey === resumeKey
            ? (await runtime.dispatch(lastAction)).action
            : undefined;
        assertHydrationActive();
        if (resumeNodeId && courseSnapshot) {
          const resumed = await runtime.emit({
            type: 'lesson.goto_node',
            nodeId: resumeNodeId,
            idempotencyKey: `resume-c:${courseSnapshot.id}`,
            payload: { targetNodeId: resumeNodeId },
          });
          resumeAction = resumed.action;
          recovery = resumed.recoveryPoint;
        }
        assertHydrationActive();
        if (resumeAction) await persistWorkingMemoryAction(bundle, resumeAction);
        assertHydrationActive();
        const hydratedState = await runtime.getClassroomState();
        assertHydrationActive();
        const taughtNodeIds = await runtime.getCompletedNodeIds();
        assertHydrationActive();
        await refreshMemoryContext(bundle, () => !cancelled);
        assertHydrationActive();
        return {
          activeLearnerId,
          records,
          recovery,
          hydratedState,
          taughtNodeIds,
        };
      })
      .then(({ activeLearnerId, records, recovery, hydratedState, taughtNodeIds }) => {
        if (cancelled || !isLifecycleTokenCurrent(lifecycleToken)) return;
        const activeStage = useStageStore.getState();
        if (activeStage.stage?.id !== stageId) {
          throw new Error('LiveCourse stage changed while restoring the classroom session');
        }
        const activeLessonPlan = resolveLessonPlan({
          stage: activeStage.stage,
          scenes: activeStage.scenes,
          persistedLessonPlan: activeStage.lessonPlan,
          courseId,
        });
        const recoverySceneId = resolveRecoverySceneId(
          recovery,
          activeLessonPlan,
          activeStage.scenes,
        );
        if (recoverySceneId && activeStage.currentSceneId !== recoverySceneId) {
          // Recovery is a projection of durable history, not a new teaching action.
          useStageStore.setState({ currentSceneId: recoverySceneId });
        }
        setLearnerId(activeLearnerId);
        setEvidence(records);
        setRecoveryPoint(recovery);
        setClassroomState(hydratedState);
        setCompletedNodeIds(taughtNodeIds);
        setStatus('ready');
      })
      .catch((cause) => {
        if (cancelled || !isLifecycleTokenCurrent(lifecycleToken)) return;
        hydrationRetryAvailableRef.current = true;
        setStatus('error');
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [
    courseId,
    defaultTeacherContext,
    explicitTeacherContext,
    getActionRuntime,
    hydrationAttempt,
    memoryMode,
    persistWorkingMemoryAction,
    refreshMemoryContext,
    assertLifecycleToken,
    isLifecycleTokenCurrent,
    sessionEnabled,
    stageId,
  ]);

  const applyDispatchResult = useCallback((result: ClassroomDispatchResult): DispatchResult => {
    setRecoveryPoint(result.recoveryPoint);
    setClassroomState(result.state);
    setError(result.publishError?.message ?? null);
    return {
      action: result.action,
      duplicate: result.duplicate,
      presentationHandled: result.presentationHandled,
    };
  }, []);

  const dispatchAction = useCallback(
    async (action: TeachingAction) => {
      const lifecycleToken = assertTeachingCommandsEnabled();
      try {
        const bundle = await getActionRuntime();
        return await finalizeCommittedClassroomDispatch({
          dispatch: async () => {
            assertLifecycleToken(lifecycleToken);
            return bundle.runtime.dispatch(action);
          },
          persistWorkingMemory: (result) => persistWorkingMemoryAction(bundle, result.action),
          applyResult: applyDispatchResult,
          assertCurrent: () => assertLifecycleToken(lifecycleToken),
          isCurrent: () => isLifecycleTokenCurrent(lifecycleToken),
        });
      } catch (cause) {
        if (isLifecycleTokenCurrent(lifecycleToken)) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        throw cause;
      }
    },
    [
      applyDispatchResult,
      assertLifecycleToken,
      assertTeachingCommandsEnabled,
      getActionRuntime,
      isLifecycleTokenCurrent,
      persistWorkingMemoryAction,
    ],
  );

  const emitAction = useCallback(
    async (input: TeachingActionInput) => {
      const lifecycleToken = assertTeachingCommandsEnabled();
      try {
        const bundle = await getActionRuntime();
        return await finalizeCommittedClassroomDispatch({
          dispatch: async () => {
            assertLifecycleToken(lifecycleToken);
            return bundle.runtime.emit(input);
          },
          persistWorkingMemory: (result) => persistWorkingMemoryAction(bundle, result.action),
          applyResult: applyDispatchResult,
          assertCurrent: () => assertLifecycleToken(lifecycleToken),
          isCurrent: () => isLifecycleTokenCurrent(lifecycleToken),
        });
      } catch (cause) {
        if (isLifecycleTokenCurrent(lifecycleToken)) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        throw cause;
      }
    },
    [
      applyDispatchResult,
      assertLifecycleToken,
      assertTeachingCommandsEnabled,
      getActionRuntime,
      isLifecycleTokenCurrent,
      persistWorkingMemoryAction,
    ],
  );

  const openCheckpoint = useCallback(
    async (input: OpenCheckpointInput): Promise<DispatchResult> => {
      const lifecycleToken = assertTeachingCommandsEnabled();
      try {
        const plan = lessonPlan;
        const node = plan?.nodes.find((item) => item.sceneId === input.sceneId);
        if (!plan || !node || node.type !== 'checkpoint') {
          throw new Error(`Quiz scene ${JSON.stringify(input.sceneId)} is not a lesson checkpoint`);
        }

        const bundle = await getActionRuntime();
        assertLifecycleToken(lifecycleToken);

        const dispatchWithBundle = async (actionInput: TeachingActionInput) => {
          return finalizeCommittedClassroomDispatch({
            dispatch: async () => {
              assertLifecycleToken(lifecycleToken);
              return bundle.runtime.emit(actionInput);
            },
            persistWorkingMemory: (result) => persistWorkingMemoryAction(bundle, result.action),
            applyResult: applyDispatchResult,
            assertCurrent: () => assertLifecycleToken(lifecycleToken),
            isCurrent: () => isLifecycleTokenCurrent(lifecycleToken),
          });
        };

        const openAction: TeachingActionInput = {
          type: 'checkpoint.open',
          nodeId: node.id,
          idempotencyKey: `checkpoint.open:${input.attemptId}`,
          payload: { checkpointId: input.sceneId },
        };

        // A previous open may already be durable while its companion W
        // projection failed. Re-emit the same key first so the helper can
        // reconcile that exact action; only a genuine state-gate rejection
        // should close an older checking attempt before opening a new one.
        const currentState = await bundle.runtime.getClassroomState();
        assertLifecycleToken(lifecycleToken);
        if (currentState === 'checking') {
          try {
            return await dispatchWithBundle(openAction);
          } catch (cause) {
            if (!(cause instanceof ClassroomStateError)) throw cause;
          }

          const recovery = await bundle.runtime.getRecoveryPoint();
          assertLifecycleToken(lifecycleToken);
          if (recovery.currentNodeId !== node.id) {
            throw new Error(
              `Cannot open quiz ${JSON.stringify(input.sceneId)} while checkpoint node ` +
                `${JSON.stringify(recovery.currentNodeId)} is active`,
            );
          }
          await dispatchWithBundle({
            type: 'checkpoint.close',
            nodeId: node.id,
            idempotencyKey: `checkpoint.close:${input.attemptId}`,
            payload: { checkpointId: input.sceneId },
          });
        }

        // The attempt id is already learner/scene scoped by the quiz runtime.
        // Reusing it makes a retried click reconcile the same W command, while
        // a new quiz attempt gets a distinct open transition.
        return dispatchWithBundle(openAction);
      } catch (cause) {
        if (isLifecycleTokenCurrent(lifecycleToken)) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        throw cause;
      }
    },
    [
      applyDispatchResult,
      assertLifecycleToken,
      assertTeachingCommandsEnabled,
      getActionRuntime,
      isLifecycleTokenCurrent,
      lessonPlan,
      persistWorkingMemoryAction,
    ],
  );

  const recordQuizEvidence = useCallback(
    async (input: QuizEvidenceInput): Promise<EvidenceRecord> => {
      const lifecycleToken = assertTeachingCommandsEnabled();
      const submissionKey = `${lifecycleToken.identity}:${lifecycleToken.epoch}:${input.attemptId}`;
      return checkpointSubmissionsRef.current(submissionKey, async () => {
        try {
          const plan = lessonPlan;
          const activeLearner = learnerId;
          if (!plan || !activeLearner) throw new Error('LiveCourse session is not ready');
          const node = plan.nodes.find((item) => item.sceneId === input.sceneId);
          const goalId = node?.goalIds[0];
          if (!node || !goalId) {
            throw new Error(`Quiz scene ${JSON.stringify(input.sceneId)} has no learning goal`);
          }

          const teacher = checkpointTeacherRef.current;
          if (!teacher)
            throw new Error('Classroom teacher is not ready to give checkpoint feedback');
          // A continued course has fresh W even when its quiz grade is already
          // stored. Reopen the retained attempt without grading it again.
          const bundle = await getActionRuntime();
          const recovery = await bundle.runtime.getRecoveryPoint();
          assertLifecycleToken(lifecycleToken);
          if (recovery.currentNodeId !== node.id) {
            throw new Error('Teaching position changed before checkpoint submission');
          }
          await openCheckpoint({ sceneId: input.sceneId, attemptId: input.attemptId });
          assertLifecycleToken(lifecycleToken);
          await teacher.feedback({ ...input, nodeId: node.id });
          assertLifecycleToken(lifecycleToken);
          const evidenceService = createLiveCourseEvidenceService({
            store: guardRuntimeStore(getRuntimeStore(), () => assertLifecycleToken(lifecycleToken)),
            assertActive: () => assertLifecycleToken(lifecycleToken),
          });
          const record = await evidenceService.ingestCheckpoint({
            scope: { stageId: plan.stageId, learnerId: activeLearner },
            courseId,
            lessonId,
            learnerId: activeLearner,
            goalId,
            nodeId: node.id,
            attemptId: input.attemptId,
            score: input.score,
            gradedByModel: input.hasModelGradedItems,
            modelId: input.modelId,
            inputSummary: input.inputSummary,
            metadata: input.metadata,
          });
          assertLifecycleToken(lifecycleToken);
          setEvidence((current) => {
            const existing = current.find((item) => item.idempotencyKey === record.idempotencyKey);
            if (existing) return current;
            return [...current, record];
          });
          assertLifecycleToken(lifecycleToken);
          await emitAction({
            type: 'checkpoint.submit',
            nodeId: node.id,
            idempotencyKey: `action:${record.idempotencyKey}`,
            payload: {
              checkpointId: input.sceneId,
              response: { evidenceId: record.id, score: record.score ?? null },
            },
          });
          assertLifecycleToken(lifecycleToken);
          setError(null);
          // J3.3：必要检查取得有效 evidence 后重估完成门——若它补齐最后尚缺的
          // 必需动作，唯一迁移 completed → finalizing。
          let canContinue = false;
          let terminalState: ClassroomState | null = null;
          try {
            const bundle = await getActionRuntime();
            assertLifecycleToken(lifecycleToken);
            const nextState = await bundle.runtime.refreshCompletionGate();
            canContinue = nextState === 'teaching' || nextState === 'checking';
            assertLifecycleToken(lifecycleToken);
            if (nextState === 'completed' || nextState === 'finalizing') terminalState = nextState;
            else setClassroomState(nextState);
            if (nextState === 'checking') {
              // A submitted attempt is no longer an active answer surface. Close
              // the checkpoint before the next teaching node (or a retry) can
              // open another one. Finalizing/completed states intentionally skip
              // this command because their lifecycle gate is terminal.
              await emitAction({
                type: 'checkpoint.close',
                nodeId: node.id,
                idempotencyKey: `checkpoint.close:${input.attemptId}`,
                payload: { checkpointId: input.sceneId },
              });
            }
          } catch (cause) {
            if (!isLifecycleTokenCurrent(lifecycleToken)) throw cause;
            setError(cause instanceof Error ? cause.message : String(cause));
            throw cause;
          }
          // Evidence is authoritative C input. Refresh the composed C/L/W view
          // after the append and action commit so the realtime teacher sees the
          // new evidence/goal projection on its next turn. A refresh failure is
          // surfaced in the session error without pretending the accepted
          // evidence write failed.
          try {
            const bundle = await getActionRuntime();
            assertLifecycleToken(lifecycleToken);
            await refreshMemoryContext(bundle);
            assertLifecycleToken(lifecycleToken);
          } catch (cause) {
            if (!isLifecycleTokenCurrent(lifecycleToken)) throw cause;
            setError(cause instanceof Error ? cause.message : String(cause));
          }
          assertLifecycleToken(lifecycleToken);
          if (canContinue) {
            await teacher.continueLesson(node.id);
            assertLifecycleToken(lifecycleToken);
          }
          if (terminalState) setClassroomState(terminalState);
          return record;
        } catch (cause) {
          if (isLifecycleTokenCurrent(lifecycleToken)) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
          throw cause;
        }
      });
    },
    [
      courseId,
      emitAction,
      getActionRuntime,
      learnerId,
      lessonId,
      lessonPlan,
      openCheckpoint,
      refreshMemoryContext,
      assertTeachingCommandsEnabled,
      assertLifecycleToken,
      isLifecycleTokenCurrent,
    ],
  );

  const completeTeachingNode = useCallback(
    async (input: CompleteTeachingNodeInput): Promise<ClassroomCompletionResult> => {
      const lifecycleToken = assertTeachingCommandsEnabled();
      try {
        const bundle = await getActionRuntime();
        assertLifecycleToken(lifecycleToken);
        const result = await bundle.runtime.completeNode(input);
        assertLifecycleToken(lifecycleToken);
        const taughtNodeIds = await bundle.runtime.getCompletedNodeIds();
        assertLifecycleToken(lifecycleToken);
        setCompletedNodeIds(taughtNodeIds);
        await persistWorkingMemoryCompletion(bundle, result.event.nodeId, result.event.occurredAt);
        assertLifecycleToken(lifecycleToken);
        setError(result.publishError?.message ?? null);
        // `lesson.complete_node` has already committed the authoritative C
        // progress before returning.  Recompose memory after that boundary;
        // a read failure is visible but must not report a successful C write
        // as a failed completion.
        try {
          const refreshedBundle = await getActionRuntime();
          assertLifecycleToken(lifecycleToken);
          await refreshMemoryContext(refreshedBundle);
          assertLifecycleToken(lifecycleToken);
        } catch (cause) {
          if (!isLifecycleTokenCurrent(lifecycleToken)) throw cause;
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        assertLifecycleToken(lifecycleToken);
        const currentState = await bundle.runtime.getClassroomState();
        assertLifecycleToken(lifecycleToken);
        setClassroomState(currentState);
        return result;
      } catch (cause) {
        // 提交被拒绝或 C 持久化失败：保持原状态和恢复点，可重试。
        if (isLifecycleTokenCurrent(lifecycleToken)) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        throw cause;
      }
    },
    [
      assertTeachingCommandsEnabled,
      getActionRuntime,
      persistWorkingMemoryCompletion,
      refreshMemoryContext,
      assertLifecycleToken,
      isLifecycleTokenCurrent,
    ],
  );

  const saveAndLeaveSession = useCallback(async (): Promise<SaveAndLeaveSessionResult> => {
    const lifecycleToken = assertTeachingCommandsEnabled();
    try {
      const bundle = await getActionRuntime();
      assertLifecycleToken(lifecycleToken);
      const result = await bundle.runtime.saveAndLeave();
      assertLifecycleToken(lifecycleToken);
      // C has been confirmed and W has been destroyed.  Release the
      // presentation projection now so the route transition cannot leave a
      // fence or teaching-only overlays behind if unmount is delayed.
      disposePresentationBundle(bundle);
      setClassroomState(result.state);
      return result;
    } catch (cause) {
      // J3.7：保存失败留在课堂，W 与状态不变，页面显示重试。
      if (isLifecycleTokenCurrent(lifecycleToken)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      throw cause;
    }
  }, [
    assertLifecycleToken,
    assertTeachingCommandsEnabled,
    disposePresentationBundle,
    getActionRuntime,
    isLifecycleTokenCurrent,
  ]);

  const finalizeSession = useCallback(async (): Promise<FinalizeSessionResult> => {
    const lifecycleToken = assertTeachingCommandsEnabled();
    try {
      const bundle = await getActionRuntime();
      assertLifecycleToken(lifecycleToken);
      const result = await bundle.runtime.finalize();
      assertLifecycleToken(lifecycleToken);
      // C/L and W finalization all succeeded.  Restore the canonical document
      // image before exposing the post-class choice view.
      disposePresentationBundle(bundle);
      setClassroomState(result.state);
      return result;
    } catch (cause) {
      // J3.8：归档失败停在 finalizing，保留 W 与待归档状态，页面显示重试。
      if (isLifecycleTokenCurrent(lifecycleToken)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      throw cause;
    }
  }, [
    assertLifecycleToken,
    assertTeachingCommandsEnabled,
    disposePresentationBundle,
    getActionRuntime,
    isLifecycleTokenCurrent,
  ]);

  const goalStates = useMemo(() => {
    if (!lessonPlan || !learnerId) return [];
    return lessonPlan.goals.map((goal) =>
      projectGoalState({
        courseId,
        learnerId,
        goalId: goal.id,
        rule: goal.rule,
        evidence,
      }),
    );
  }, [courseId, evidence, learnerId, lessonPlan]);

  const currentNodeDesign = useMemo(() => {
    const nodeId = recoveryPoint.currentNodeId;
    if (!lessonPlan || !nodeId) return null;
    return lessonPlan.nodes.find((node) => node.id === nodeId)?.design ?? null;
  }, [lessonPlan, recoveryPoint.currentNodeId]);

  const value = useMemo<LiveCourseSessionValue>(
    () => ({
      courseId,
      lessonId,
      status,
      lessonPlan,
      currentNodeDesign,
      learnerId,
      teacherContext,
      courseMemory,
      learnerMemory,
      evidence,
      goalStates,
      currentNodeId: recoveryPoint.currentNodeId,
      lastSequence: recoveryPoint.lastSequence,
      classroomState,
      completedNodeIds,
      error,
      retryHydration,
      emitAction,
      dispatchAction,
      openCheckpoint,
      recordQuizEvidence,
      registerCheckpointTeacher,
      completeTeachingNode,
      saveAndLeaveSession,
      finalizeSession,
    }),
    [
      classroomState,
      completeTeachingNode,
      completedNodeIds,
      courseId,
      currentNodeDesign,
      dispatchAction,
      emitAction,
      error,
      evidence,
      courseMemory,
      finalizeSession,
      goalStates,
      learnerId,
      learnerMemory,
      lessonId,
      lessonPlan,
      openCheckpoint,
      recordQuizEvidence,
      registerCheckpointTeacher,
      recoveryPoint,
      retryHydration,
      saveAndLeaveSession,
      status,
      teacherContext,
    ],
  );

  // A replay is a separate lifecycle with a separate replay W. Do not expose
  // the teaching context at all in that tree: an optional consumer must see
  // `null`, so an autoplay / quiz / realtime callback cannot accidentally
  // obtain a teaching command and create the durable teaching W.
  if (!sessionEnabled) return <>{children}</>;

  return (
    <LiveCourseSessionContext.Provider value={value}>{children}</LiveCourseSessionContext.Provider>
  );
}

export function useLiveCourseSession(): LiveCourseSessionValue {
  const value = useContext(LiveCourseSessionContext);
  if (!value) throw new Error('useLiveCourseSession requires LiveCourseSessionProvider');
  return value;
}

export function useLiveCourseSessionOptional(): LiveCourseSessionValue | null {
  return useContext(LiveCourseSessionContext);
}

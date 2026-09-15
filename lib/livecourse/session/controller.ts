import {
  lessonCompletionEventSchema,
  teachingActionSchema,
  type LessonCompletionEvent,
  type LessonPlan,
  type TeachingAction,
} from '@/lib/livecourse/domain';
import type {
  ClassroomRecoveryPoint,
  TeachingActionRepository,
  TeachingActionSnapshot,
} from '@/lib/livecourse/session/action-repository';
import type { VersionedCourseState } from '@/lib/livecourse/session/course-state-repository';
import {
  resolveCourseEntry,
  type CourseProgress,
  type CourseStateSnapshot,
  type CourseStateSnapshotInput,
} from '@/lib/livecourse/session/course-state-snapshot';
import { createBrowserUuid } from '@/lib/utils/random-id';

/**
 * 课堂状态机（docs/spec/04-detailed-design.md §1，A2）。任何失败保持原状态
 * 和恢复点，不推进节点；必要检查未产生有效证据时不得迁移到 `completed`；
 * `finalizing` 的唯一入口是 `completed → finalizing`。
 */
export const CLASSROOM_STATES = [
  'loading',
  'teaching',
  'interrupted',
  'checking',
  'paused',
  'replaying',
  'completed',
  'finalizing',
  'failed',
] as const;

export type ClassroomState = (typeof CLASSROOM_STATES)[number];

export interface ClassroomStateTransition {
  from: ClassroomState;
  to: ClassroomState;
  at: string;
  reason: string;
}

export type PresentationApplyResult =
  | {
      success: true;
      data?: { handled?: boolean };
      /** Finalize a presentation once its W action is known to be durable. */
      commit?: () => void | Promise<void>;
      /** Optional compensation when a presentation was not committed. */
      rollback?: () => void | Promise<void>;
    }
  | {
      success: false;
      error?: string;
      /** Optional compensation for a partially-applied presentation. */
      commit?: () => void | Promise<void>;
      rollback?: () => void | Promise<void>;
    };

interface StagedDispatchMetadata {
  /** Captured before relisten_start; committed only after W append succeeds. */
  relistenOrigin?: { originNodeId: string; originState: 'teaching' | 'checking' };
}

type ActiveClassroomState = 'teaching' | 'checking' | 'interrupted' | 'paused' | 'replaying';

/**
 * The state that can be reconstructed from the typed action log.  `completed`,
 * `finalizing`, and `failed` are lifecycle/projection states and therefore are
 * deliberately not inferred from a teaching action alone.
 */
export interface ClassroomActionStateProjection {
  state: ActiveClassroomState;
  pausedOriginState: 'teaching' | 'checking' | null;
  interruption: { resumeNodeId: string; resumeState: 'teaching' | 'checking' } | null;
  relisten: { originNodeId: string; originState: 'teaching' | 'checking' } | null;
  currentNodeId: string | null;
}

interface PendingPresentationCommit {
  action: TeachingAction;
  commit: () => void | Promise<void>;
  presentationHandled: boolean;
  duplicate: boolean;
  recoveryPoint: ClassroomRecoveryPoint;
  staged: StagedDispatchMetadata;
  publishedAttempted: boolean;
}

/**
 * A replay presentation that is visible locally while the corresponding W
 * append has not yet reached a known outcome. Keeping the exact action (and
 * therefore its idempotency key/sequence) is essential: minting a replacement
 * action on Retry could commit the same visible transition twice if the first
 * request eventually arrived at storage.
 */
interface PendingReplayAction {
  action: TeachingAction;
  presentation: Extract<PresentationApplyResult, { success: true }>;
  appendOutcome: 'uncertain' | 'durable';
  operationCause: unknown;
  reconciliationCause?: unknown;
  /** `true` when the action only re-projects an already durable W position. */
  presentationOnly: boolean;
  /** State to expose after the retained action is settled. */
  stateAfter: Exclude<ReplaySessionState, 'loading' | 'ended'>;
}

type ThrownPresentationFailure = {
  rollback?: () => void | Promise<void>;
};

function presentationRollbackFromThrown(error: unknown): (() => void | Promise<void>) | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const rollback = (error as ThrownPresentationFailure).rollback;
  return typeof rollback === 'function' ? rollback : undefined;
}

function sameReplayActionRequest(left: TeachingAction, right: TeachingAction): boolean {
  return (
    left.courseId === right.courseId &&
    left.lessonId === right.lessonId &&
    left.nodeId === right.nodeId &&
    left.type === right.type &&
    JSON.stringify(left.payload) === JSON.stringify(right.payload)
  );
}

export interface ClassroomControllerDeps {
  repository: TeachingActionRepository;
  applyPresentation: (
    action: TeachingAction,
  ) => PresentationApplyResult | Promise<PresentationApplyResult>;
  publish: (action: TeachingAction) => void | Promise<void>;
  completion?: ClassroomCompletionDeps;
  lifecycle?: ClassroomLifecycleDeps;
}

export interface ClassroomDispatchResult {
  action: TeachingAction;
  duplicate: boolean;
  presentationHandled: boolean;
  recoveryPoint: ClassroomRecoveryPoint;
  state: ClassroomState;
  publishError?: Error;
}

/**
 * The teaching action is already durable in W, but the companion classroom
 * working-memory projection could not be persisted.  Callers must not
 * compensate the action or release a locally frozen interruption: the exact
 * action result is retained so the next attempt can reconcile the projection.
 */
export class ClassroomActionCommittedError extends Error {
  override readonly name: string = 'ClassroomActionCommittedError';
  readonly authority = 'committed' as const;
  readonly result: ClassroomDispatchResult;
  readonly cause: unknown;

  constructor(result: ClassroomDispatchResult, cause: unknown, message?: string) {
    super(message ?? `Teaching action ${JSON.stringify(result.action.id)} is committed`);
    this.result = result;
    this.cause = cause;
  }
}

export class ClassroomWorkingMemoryProjectionError extends ClassroomActionCommittedError {
  override readonly name = 'ClassroomWorkingMemoryProjectionError';

  constructor(result: ClassroomDispatchResult, cause: unknown) {
    super(
      result,
      cause,
      `Teaching action ${JSON.stringify(result.action.id)} committed but working-memory projection failed`,
    );
  }
}

/**
 * The C-persistence port the completion coordinator writes through
 * (docs/spec/04-detailed-design.md §6: `CourseStateSnapshot` is C).
 * Implemented by `CourseStateRepository`.
 */
export interface LessonProgressStore {
  load(): Promise<CourseStateSnapshot | undefined>;
  saveProgress(input: {
    idempotencyKey: string;
    progress: CourseProgress;
  }): Promise<CourseStateSnapshot>;
}

/**
 * Wiring for the authoritative `lesson.complete_node` boundary (A2). Without
 * these deps the controller rejects completion submissions outright.
 */
export interface ClassroomCompletionDeps {
  classroomSessionId: string;
  courseId: string;
  lessonId: string;
  lessonPlan: LessonPlan;
  progressStore: LessonProgressStore;
  /** Whether a required checkpoint node already has valid (accepted) evidence. */
  hasValidEvidence: (nodeId: string) => boolean | Promise<boolean>;
  /** Required checkpoint nodes; defaults to every `checkpoint` node in the plan. */
  requiredCheckpointNodeIds?: readonly string[];
  publishEvent?: (event: LessonCompletionEvent) => void | Promise<void>;
  now?: () => string;
  createEventId?: () => string;
}

/**
 * The ONLY `lesson.complete_node` submission entry. Callers must reference the
 * teacher speech (`speech_start`/`speech_end`) and the teaching actions that
 * have all reported a successful end for this node. Media-playback arrival,
 * load callbacks and playback cursors have no entry point here.
 */
export interface CompleteTeachingNodeInput {
  nodeId: string;
  idempotencyKey: string;
  speech: { startActionId: string; endActionId: string };
  actionIds: readonly string[];
}

export interface ClassroomCompletionResult {
  event: LessonCompletionEvent;
  duplicate: boolean;
  state: ClassroomState;
  progress: CourseProgress;
  publishError?: Error;
}

export class ClassroomPresentationError extends Error {
  override readonly name: string = 'ClassroomPresentationError';
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/**
 * The presentation and its compensating operation both failed.  Keep both
 * causes visible: replacing either one with a generic error hides which side
 * of the W/presentation boundary is still divergent.
 */
export class ClassroomPresentationRollbackError extends ClassroomPresentationError {
  override readonly name: string = 'ClassroomPresentationRollbackError';
  readonly operationCause: unknown;
  readonly rollbackCause: unknown;

  constructor(operationCause: unknown, rollbackCause: unknown) {
    super('Classroom presentation could not be restored after a failed action', operationCause);
    this.operationCause = operationCause;
    this.rollbackCause = rollbackCause;
  }
}

/**
 * `append` failed and a follow-up read could not tell whether W accepted the
 * action.  In this state compensation is unsafe because the action may have
 * reached the authority, so the presentation is deliberately left visible.
 */
export class ClassroomAppendUncertaintyError extends Error {
  override readonly name = 'ClassroomAppendUncertaintyError';
  readonly authority = 'uncertain' as const;
  readonly action: TeachingAction;
  readonly operationCause: unknown;
  readonly reconciliationCause: unknown;

  constructor(action: TeachingAction, operationCause: unknown, reconciliationCause: unknown) {
    super(`Teaching action append outcome is uncertain for ${JSON.stringify(action.id)}`);
    this.action = action;
    this.operationCause = operationCause;
    this.reconciliationCause = reconciliationCause;
  }
}

/** W is durable, but the local presentation transaction could not be closed. */
export class ClassroomPresentationCommitError extends Error {
  override readonly name = 'ClassroomPresentationCommitError';
  readonly authority = 'committed' as const;
  readonly action: TeachingAction;
  readonly cause: unknown;
  /** Whether the authoritative action bus was attempted before surfacing this error. */
  readonly published: boolean;
  /** A non-authoritative publish failure observed alongside the commit failure. */
  readonly publishError?: Error;

  constructor(
    action: TeachingAction,
    cause: unknown,
    options: { published?: boolean; publishError?: Error } = {},
  ) {
    super(
      `Teaching action ${JSON.stringify(action.id)} committed but presentation finalization failed`,
    );
    this.action = action;
    this.cause = cause;
    this.published = options.published ?? false;
    this.publishError = options.publishError;
  }
}

export type ClassroomActionAuthority = 'committed' | 'uncertain' | 'not_committed';

/**
 * Read the strongest authority marker from a surfaced transaction error.
 * Local rollback wrappers and AggregateError can nest the W failure several
 * levels deep; compensation decisions must not depend on which wrapper was
 * constructed first. An unresolved outcome is stricter than a committed
 * outcome, which is stricter than a known non-commit.
 */
export function readClassroomActionAuthority(error: unknown): ClassroomActionAuthority | null {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  let strongest: ClassroomActionAuthority | null = null;

  while (pending.length > 0) {
    const candidate = pending.shift();
    if (!candidate || typeof candidate !== 'object') continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const marker = (candidate as { authority?: unknown }).authority;
    if (marker === 'uncertain') return 'uncertain';
    if (marker === 'committed') strongest = 'committed';
    else if (marker === 'not_committed' && strongest === null) strongest = 'not_committed';

    const nested = candidate as {
      cause?: unknown;
      operationCause?: unknown;
      rollbackCause?: unknown;
      rollbackCauses?: readonly unknown[];
      errors?: readonly unknown[];
    };
    if (nested.cause !== undefined) pending.push(nested.cause);
    if (nested.operationCause !== undefined) pending.push(nested.operationCause);
    if (nested.rollbackCause !== undefined) pending.push(nested.rollbackCause);
    if (nested.rollbackCauses) pending.push(...nested.rollbackCauses);
    if (nested.errors) pending.push(...nested.errors);
  }

  return strongest;
}

/** Illegal state-machine entry (e.g. completing a node while paused). */
export class ClassroomStateError extends Error {
  override readonly name = 'ClassroomStateError';
}

/**
 * A `lesson.complete_node` submission whose speech/action references cannot be
 * verified as successfully ended for the node, or that conflicts with an
 * already-committed event key.
 */
export class LessonCompletionRejectedError extends Error {
  override readonly name = 'LessonCompletionRejectedError';
}

// ---------------------------------------------------------------------------
// A2 lifecycle boundaries (J3.7 / J3.8 / J4.x)
// ---------------------------------------------------------------------------

/**
 * 生命周期命令使用的完整 C 端口（读 + 版本化读 + 整体写）。由
 * `CourseStateRepository` 实现；测试可用结构化 fake。
 */
export interface CourseStateLifecycleStore {
  load(): Promise<CourseStateSnapshot | undefined>;
  loadVersioned(): Promise<VersionedCourseState | undefined>;
  save(
    input: CourseStateSnapshotInput,
    options?: { expectedRevision?: number | null },
  ): Promise<CourseStateSnapshot>;
}

/**
 * `saveAndLeaveSession` / `finalizeSession` 的接线（docs/spec/04-detailed-design.md
 * §1，A2）。没有这些依赖时，两个生命周期命令都直接拒绝。
 */
export interface ClassroomLifecycleDeps {
  classroomSessionId: string;
  courseState: CourseStateLifecycleStore;
  /** 销毁本课堂 teaching `W` 的唯一边界（幂等）。 */
  destroyWorkSession: () => Promise<void>;
  /**
   * `L` 写入接缝：归档 `C` 成功后、销毁 `W` 前调用，失败则整条 finalize
   * 失败（停在 `finalizing`、保留 `W`）。A6 才实现 learner-only candidate
   * 的确定性白名单 policy；缺省表示没有任何候选，绝不假写 `L`。
   */
  finalizeLearnerMemory?: () => Promise<void>;
}

/** 生命周期边界失败（C 缺失、归档冲突等）；保持原状态与恢复点，可重试。 */
export class ClassroomLifecycleError extends Error {
  override readonly name = 'ClassroomLifecycleError';
}

export interface SaveAndLeaveSessionResult {
  idempotencyKey: string;
  duplicate: boolean;
  snapshot: CourseStateSnapshot;
  workSessionDestroyed: boolean;
  state: ClassroomState;
}

export interface FinalizeSessionResult {
  idempotencyKey: string;
  duplicate: boolean;
  snapshot: CourseStateSnapshot;
  workSessionDestroyed: boolean;
  state: ClassroomState;
}

/**
 * 归档合并（docs/spec/04-detailed-design.md §6）：`C` 既有动作历史在前，
 * 本次 `W` 动作重排 sequence 接续在后，得到跨多次进出课堂的完整历史。
 * 纯函数、确定性：同一 `(persisted, work)` 输入永远得到同一快照内容，
 * 这正是幂等重试能被 `sameCourseStateSnapshot` 判等的前提。
 */
export function mergeTeachingActionsForArchive(
  persisted: TeachingActionSnapshot,
  work: TeachingActionSnapshot,
): TeachingActionSnapshot {
  const persistedIds = new Set(persisted.actions.map((action) => action.id));
  const pending = work.actions.filter((action) => !persistedIds.has(action.id));
  if (pending.length === 0) {
    // 本次 W 的动作已全部在 C 中（例如 C 就是从这个 W 播种的）：原样保留。
    return {
      actions: [...persisted.actions],
      currentNodeId: persisted.currentNodeId,
      lastSequence: persisted.lastSequence,
    };
  }
  let sequence = persisted.lastSequence;
  const merged = [...persisted.actions];
  for (const action of pending) {
    sequence += 1;
    merged.push({ ...action, sequence });
  }
  return { actions: merged, currentNodeId: work.currentNodeId, lastSequence: sequence };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Reconstruct the small amount of local state needed when a controller sees a
 * command that another coordinator already appended.  `inspect()` returns the
 * post-append snapshot, so relisten's origin has to be read from the prefix;
 * otherwise a duplicate race can leave the local state machine in `teaching`
 * while authoritative W is already `replaying`.
 */
function recoveryNodeForAction(action: TeachingAction): string {
  return action.type === 'lesson.goto_node' ? action.payload.targetNodeId : action.nodeId;
}

function sameActionIdentity(left: TeachingAction, right: TeachingAction): boolean {
  return left.id === right.id || left.idempotencyKey === right.idempotencyKey;
}

/**
 * Fold the classroom state machine from the authoritative W action log.
 * Ordinary presentation actions preserve the active state; lifecycle commands
 * are the only actions that change it.  The reducer is intentionally pure so
 * load, duplicate dispatch, and tests all use exactly the same rules.
 */
export function foldClassroomActions(
  actions: readonly TeachingAction[],
): ClassroomActionStateProjection {
  let state: ActiveClassroomState = 'teaching';
  let pausedOriginState: 'teaching' | 'checking' | null = null;
  let interruption: ClassroomActionStateProjection['interruption'] = null;
  let relisten: ClassroomActionStateProjection['relisten'] = null;
  let currentNodeId: string | null = null;

  for (const action of actions) {
    const previousNodeId = currentNodeId;
    currentNodeId = recoveryNodeForAction(action);

    switch (action.type) {
      case 'lesson.pause':
        if (state === 'teaching' || state === 'checking') {
          pausedOriginState = state;
          state = 'paused';
        }
        break;
      case 'lesson.resume':
        if (state === 'paused') {
          state = pausedOriginState ?? 'teaching';
          pausedOriginState = null;
        }
        break;
      case 'checkpoint.open':
        if (state === 'teaching') state = 'checking';
        break;
      case 'checkpoint.close':
        if (state === 'checking') state = 'teaching';
        break;
      case 'lesson.interrupt':
        if (state === 'teaching' || state === 'checking') {
          interruption = { resumeNodeId: action.nodeId, resumeState: state };
          state = 'interrupted';
        }
        break;
      case 'lesson.resume_interrupted':
        if (state === 'interrupted' && interruption) {
          state = interruption.resumeState;
          interruption = null;
        }
        break;
      case 'lesson.relisten_start':
        if (state === 'teaching' || state === 'checking') {
          relisten = {
            originNodeId: previousNodeId ?? action.nodeId,
            originState: state,
          };
          state = 'replaying';
        }
        break;
      case 'lesson.relisten_end':
        if (state === 'replaying' && relisten) {
          state = relisten.originState;
          relisten = null;
        }
        break;
      default:
        break;
    }
  }

  return { state, pausedOriginState, interruption, relisten, currentNodeId };
}

/**
 * The event id and timestamp are generated at submission time, so they are
 * deliberately excluded from the retry identity.  Every field that can
 * change the meaning or authority of a completion must remain stable.
 */
function sameCompletionRequest(left: LessonCompletionEvent, right: LessonCompletionEvent): boolean {
  return (
    left.classroomSessionId === right.classroomSessionId &&
    left.courseId === right.courseId &&
    left.lessonId === right.lessonId &&
    left.nodeId === right.nodeId &&
    left.speech.startActionId === right.speech.startActionId &&
    left.speech.endActionId === right.speech.endActionId &&
    left.actionIds.length === right.actionIds.length &&
    left.actionIds.every((actionId, index) => actionId === right.actionIds[index])
  );
}

export class ClassroomController {
  readonly #repository: TeachingActionRepository;
  readonly #applyPresentation: ClassroomControllerDeps['applyPresentation'];
  readonly #publish: ClassroomControllerDeps['publish'];
  readonly #completion?: ClassroomCompletionDeps;
  readonly #lifecycle?: ClassroomLifecycleDeps;
  readonly #now: () => string;
  #queue: Promise<void> = Promise.resolve();
  // --- W：当前课堂工作记忆 / 运行时状态（以 classroomSessionId 隔离） ---
  #state: ClassroomState = 'loading';
  #transitions: ClassroomStateTransition[] = [];
  #completedNodeIds: string[] = [];
  /** J3.2：interrupted 期间被冻结的 resumeNode 与进入前的状态。 */
  #interruption: { resumeNodeId: string; resumeState: 'teaching' | 'checking' } | null = null;
  /** J3.4/J3.5：暂停前的 teaching / checking origin。 */
  #pausedOriginState: 'teaching' | 'checking' | null = null;
  /** J3.6：replaying 期间进入重听前的原位置与状态。 */
  #relisten: { originNodeId: string; originState: 'teaching' | 'checking' } | null = null;
  /** A durable W action whose presentation commit hook still needs a retry. */
  #pendingPresentationCommit: PendingPresentationCommit | null = null;
  #completionEvents = new Map<string, LessonCompletionEvent>();
  #completionHydrated = false;
  // 实例内幂等：生命周期命令成功后重试直接返回首次结果。
  #saveAndLeaveResult: SaveAndLeaveSessionResult | null = null;
  #finalizeResult: FinalizeSessionResult | null = null;

  constructor(deps: ClassroomControllerDeps) {
    this.#repository = deps.repository;
    this.#applyPresentation = deps.applyPresentation;
    this.#publish = deps.publish;
    this.#completion = deps.completion;
    this.#lifecycle = deps.lifecycle;
    this.#now = deps.completion?.now ?? (() => new Date().toISOString());
  }

  getState(): ClassroomState {
    return this.#state;
  }

  getTransitions(): readonly ClassroomStateTransition[] {
    return this.#transitions;
  }

  /** W 中已完成的节点（按完成顺序）。C 中的进度在首次 load / 提交时水合进来。 */
  getCompletedNodeIds(): readonly string[] {
    return this.#completedNodeIds;
  }

  async load(): Promise<TeachingActionSnapshot> {
    // Keep the initial state transition until both the action log and the
    // completion projection have hydrated successfully.  A failed C read is
    // still a load failure (and must remain retryable), not a partially-ready
    // teaching session.
    const shouldEnterTeaching = this.#state === 'loading' || this.#state === 'failed';
    try {
      const snapshot = await this.#repository.load();
      // Fold W into a temporary projection first.  Completion/C hydration can
      // still fail; in that case no partially-ready state is exposed.
      const projection = foldClassroomActions(snapshot.actions);
      await this.#hydrateCompletion();
      this.#applyHydratedProjection(projection, shouldEnterTeaching);
      return snapshot;
    } catch (error) {
      // 加载失败：从 loading 进入 failed，保留恢复点可重试，不推进任何节点。
      if (shouldEnterTeaching && this.#state === 'loading') {
        this.#transition('failed', 'classroom_load_failed');
      }
      throw error;
    }
  }

  async getRecoveryPoint(): Promise<ClassroomRecoveryPoint> {
    const snapshot = await this.load();
    return {
      currentNodeId: snapshot.currentNodeId,
      lastSequence: snapshot.lastSequence,
    };
  }

  dispatch(action: TeachingAction): Promise<ClassroomDispatchResult> {
    const result = this.#queue.then(() => this.#dispatchOne(action));
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #dispatchOne(action: TeachingAction): Promise<ClassroomDispatchResult> {
    const inspection = await this.#repository.inspect(action);
    if (inspection.status === 'duplicate') {
      // W already contains this command. If its presentation commit was left
      // pending by an earlier attempt, retry that hook first; the action bus is
      // attempted at most once for the original (non-duplicate) append.
      if (this.#pendingPresentationCommit) {
        const pending = this.#pendingPresentationCommit;
        if (sameActionIdentity(pending.action, inspection.action)) {
          const publishError = await this.#settlePendingPresentation();
          return {
            action: inspection.action,
            duplicate: true,
            presentationHandled: pending.presentationHandled,
            state: this.#state,
            recoveryPoint: {
              currentNodeId: inspection.snapshot.currentNodeId,
              lastSequence: inspection.snapshot.lastSequence,
            },
            ...(publishError ? { publishError } : {}),
          };
        }
        // A different command must not overtake an unresolved presentation
        // transaction.  Settling it here keeps the queue serial and leaves W,
        // local state, and the visible projection convergent before proceeding.
        await this.#settlePendingPresentation();
      }

      // Hydrate from the complete authoritative log rather than trying to
      // infer an origin from only the duplicate action's prefix.  This covers
      // checking, paused, interrupted, and replaying states uniformly.
      this.#applyHydratedProjection(
        foldClassroomActions(inspection.snapshot.actions),
        this.#state === 'loading' || this.#state === 'failed',
      );
      return {
        action: inspection.action,
        duplicate: true,
        presentationHandled: false,
        state: this.#state,
        recoveryPoint: {
          currentNodeId: inspection.snapshot.currentNodeId,
          lastSequence: inspection.snapshot.lastSequence,
        },
      };
    }

    // A prior durable action may have an unclosed presentation transaction;
    // finish it before allowing a new action to mutate the projection.
    if (this.#pendingPresentationCommit) await this.#settlePendingPresentation();

    // 状态门禁在呈现之前：被拒绝的命令既不迁移状态也不改变画面。
    const staged = await this.#validateActionGuards(inspection.action, inspection.snapshot);

    let presentation: PresentationApplyResult;
    try {
      presentation = await this.#applyPresentation(inspection.action);
    } catch (error) {
      // 呈现失败：保持原状态和恢复点，不推进节点（可重试当前节点）。
      const presentationError = new ClassroomPresentationError(
        'Classroom presentation apply threw',
        error,
      );
      const rollback = presentationRollbackFromThrown(error);
      if (rollback) {
        try {
          await rollback();
        } catch (rollbackCause) {
          throw new ClassroomPresentationRollbackError(presentationError, rollbackCause);
        }
      }
      throw presentationError;
    }
    if (!presentation.success) {
      const presentationError = new ClassroomPresentationError(
        presentation.error || 'Classroom presentation apply failed',
      );
      await this.#rollbackPresentation(presentation, presentationError);
      throw presentationError;
    }

    let committed;
    try {
      committed = await this.#repository.append(inspection.action);
    } catch (operationCause) {
      // A lost response does not prove that W rejected the action. Reconcile
      // the idempotency key before deciding whether compensation is safe.
      let reconciled;
      try {
        reconciled = await this.#repository.inspect(inspection.action);
      } catch (reconciliationCause) {
        throw new ClassroomAppendUncertaintyError(
          inspection.action,
          operationCause,
          reconciliationCause,
        );
      }
      if (reconciled.status === 'duplicate') {
        // The append may have succeeded before its response was lost. W is
        // authoritative, so migrate local state and finalize the presentation
        // transaction, while preserving the no-republish duplicate contract.
        return this.#completeDurableDispatch({
          action: reconciled.action,
          duplicate: true,
          presentation,
          recoveryPoint: {
            currentNodeId: reconciled.snapshot.currentNodeId,
            lastSequence: reconciled.snapshot.lastSequence,
          },
          staged,
        });
      }
      await this.#rollbackPresentation(presentation, operationCause);
      throw operationCause;
    }
    if (committed.duplicate) {
      // The action won a compare-and-append race. It is already authoritative,
      // so migrate local state, but retain the historical no-republish rule.
      return this.#completeDurableDispatch({
        action: committed.action,
        duplicate: true,
        presentation,
        recoveryPoint: committed.recoveryPoint,
        staged,
      });
    }

    return this.#completeDurableDispatch({
      action: committed.action,
      duplicate: false,
      presentation,
      recoveryPoint: committed.recoveryPoint,
      staged,
    });
  }

  async #completeDurableDispatch(input: {
    action: TeachingAction;
    duplicate: boolean;
    presentation: PresentationApplyResult;
    recoveryPoint: ClassroomRecoveryPoint;
    staged: StagedDispatchMetadata;
  }): Promise<ClassroomDispatchResult> {
    const { action, duplicate, presentation, recoveryPoint, staged } = input;
    // W is authoritative as soon as append returns.  Migrate local state before
    // invoking a potentially failing presentation commit hook.
    this.#applyActionTransition(action, staged);

    if (presentation.success && presentation.commit) {
      const pending: PendingPresentationCommit = {
        action,
        commit: presentation.commit,
        presentationHandled: presentation.data?.handled ?? false,
        duplicate,
        recoveryPoint,
        staged,
        publishedAttempted: false,
      };
      this.#pendingPresentationCommit = pending;
      const publishError = await this.#settlePendingPresentation();
      return this.#dispatchResult({
        action,
        duplicate,
        presentationHandled: pending.presentationHandled,
        recoveryPoint,
        publishError,
      });
    }

    const publishError = duplicate ? undefined : await this.#publishActionOnce(action);
    return this.#dispatchResult({
      action,
      duplicate,
      presentationHandled: presentation.success ? (presentation.data?.handled ?? false) : false,
      recoveryPoint,
      publishError,
    });
  }

  async #settlePendingPresentation(): Promise<Error | undefined> {
    const pending = this.#pendingPresentationCommit;
    if (!pending) return undefined;
    try {
      await pending.commit();
    } catch (cause) {
      // W is already durable at this point. Never compensate the presentation
      // here: doing so would create a visible divergence from authoritative W.
      // A new append must be broadcast at least once even when presentation
      // finalization fails.  A duplicate append retains the historical
      // no-republish contract: another coordinator already owns its event.
      const publishError = pending.duplicate ? undefined : await this.#publishPendingOnce(pending);
      throw new ClassroomPresentationCommitError(pending.action, cause, {
        published: pending.publishedAttempted,
        ...(publishError ? { publishError } : {}),
      });
    }
    this.#pendingPresentationCommit = null;

    // A duplicate append is already broadcast by the winning coordinator in
    // the normal path.  Only a non-duplicate append gets this controller's
    // regular publish after its presentation commit succeeds.  (A commit
    // failure takes the separate catch path above, which intentionally makes
    // one recovery publish attempt even for a duplicate race.)
    if (pending.duplicate) return undefined;
    return this.#publishPendingOnce(pending);
  }

  async #publishPendingOnce(pending: PendingPresentationCommit): Promise<Error | undefined> {
    if (pending.publishedAttempted) return undefined;
    pending.publishedAttempted = true;
    try {
      await this.#publish(pending.action);
      return undefined;
    } catch (error) {
      return toError(error);
    }
  }

  async #publishActionOnce(action: TeachingAction): Promise<Error | undefined> {
    try {
      await this.#publish(action);
      return undefined;
    } catch (error) {
      return toError(error);
    }
  }

  #dispatchResult(input: {
    action: TeachingAction;
    duplicate: boolean;
    presentationHandled: boolean;
    recoveryPoint: ClassroomRecoveryPoint;
    publishError?: Error;
  }): ClassroomDispatchResult {
    return {
      action: input.action,
      duplicate: input.duplicate,
      presentationHandled: input.presentationHandled,
      state: this.#state,
      recoveryPoint: input.recoveryPoint,
      ...(input.publishError ? { publishError: input.publishError } : {}),
    };
  }

  /**
   * J3.2 / J3.6 命令门禁（docs/spec/01）：插话只在讲授 / 检查中冻结
   * resumeNode；恢复命令必须精确回到被冻结节点；课中重听只许覆盖已讲
   * （已完成）范围；interrupted / replaying 中禁止 goto_node 改线。
   */
  async #validateActionGuards(
    action: TeachingAction,
    snapshot: TeachingActionSnapshot,
  ): Promise<StagedDispatchMetadata> {
    const staged: StagedDispatchMetadata = {};
    switch (action.type) {
      case 'lesson.pause': {
        if (this.#state !== 'teaching' && this.#state !== 'checking') {
          throw new ClassroomStateError(
            `lesson.pause cannot run while the classroom is ${this.#state}`,
          );
        }
        break;
      }
      case 'lesson.resume': {
        if (this.#state !== 'paused') {
          throw new ClassroomStateError(
            `lesson.resume cannot run while the classroom is ${this.#state}`,
          );
        }
        break;
      }
      case 'lesson.retry': {
        // A node retry is an explicit control command, not a pause/resume
        // alias.  It may only target the node currently held by W; a stale
        // callback must not restart a different scene or advance progress.
        if (this.#state !== 'teaching' && this.#state !== 'checking') {
          throw new ClassroomStateError(
            `lesson.retry cannot run while the classroom is ${this.#state}`,
          );
        }
        if (!snapshot.currentNodeId || action.nodeId !== snapshot.currentNodeId) {
          throw new ClassroomStateError('lesson.retry must target the current lesson node');
        }
        break;
      }
      case 'lesson.interrupt': {
        if (this.#state !== 'teaching' && this.#state !== 'checking') {
          throw new ClassroomStateError(
            `lesson.interrupt cannot run while the classroom is ${this.#state}`,
          );
        }
        // 冻结点必须就是当前节点：插话不改变教学位置。
        if (!snapshot.currentNodeId || action.nodeId !== snapshot.currentNodeId) {
          throw new ClassroomStateError(
            'lesson.interrupt must freeze the current node as resumeNode',
          );
        }
        break;
      }
      case 'lesson.resume_interrupted': {
        if (this.#state !== 'interrupted' || !this.#interruption) {
          throw new ClassroomStateError(
            `lesson.resume_interrupted cannot run while the classroom is ${this.#state}`,
          );
        }
        if (action.payload.targetNodeId !== this.#interruption.resumeNodeId) {
          throw new ClassroomStateError(
            'lesson.resume_interrupted must return to the frozen resumeNode',
          );
        }
        if (action.nodeId !== action.payload.targetNodeId) {
          throw new ClassroomStateError(
            'lesson.resume_interrupted nodeId must equal the frozen resumeNode',
          );
        }
        break;
      }
      case 'lesson.relisten_start': {
        if (this.#state !== 'teaching' && this.#state !== 'checking') {
          throw new ClassroomStateError(
            `lesson.relisten_start cannot run while the classroom is ${this.#state}`,
          );
        }
        if (action.nodeId !== action.payload.targetNodeId) {
          throw new ClassroomStateError(
            'lesson.relisten_start nodeId must equal payload.targetNodeId',
          );
        }
        // 只能重听已讲部分（已完成节点）；未讲的范围拒绝进入。
        await this.#hydrateCompletion();
        if (!this.#completedNodeIds.includes(action.payload.targetNodeId)) {
          throw new ClassroomStateError(
            `lesson.relisten_start target ${action.payload.targetNodeId} is outside the taught range`,
          );
        }
        if (!snapshot.currentNodeId) {
          throw new ClassroomStateError('lesson.relisten_start requires an active origin node');
        }
        // Keep this metadata local to the in-flight dispatch. It becomes
        // controller state only after the W append succeeds, so a failed
        // presentation or append cannot poison a later retry.
        staged.relistenOrigin = {
          originNodeId: snapshot.currentNodeId,
          originState: this.#state,
        };
        break;
      }
      case 'lesson.relisten_end': {
        if (this.#state !== 'replaying' || !this.#relisten) {
          throw new ClassroomStateError(
            `lesson.relisten_end cannot run while the classroom is ${this.#state}`,
          );
        }
        if (action.payload.targetNodeId !== this.#relisten.originNodeId) {
          throw new ClassroomStateError(
            'lesson.relisten_end must return to the pre-relisten origin node',
          );
        }
        if (action.nodeId !== action.payload.targetNodeId) {
          throw new ClassroomStateError('lesson.relisten_end nodeId must equal the origin node');
        }
        break;
      }
      case 'lesson.goto_node': {
        // paused / interrupted / replaying 中改线只能走各自的显式恢复命令。
        if (this.#state !== 'teaching' && this.#state !== 'checking') {
          throw new ClassroomStateError(
            `lesson.goto_node cannot run while the classroom is ${this.#state}`,
          );
        }
        break;
      }
      case 'checkpoint.open': {
        if (this.#state !== 'teaching') {
          throw new ClassroomStateError(
            `checkpoint.open cannot run while the classroom is ${this.#state}`,
          );
        }
        break;
      }
      case 'checkpoint.submit': {
        if (this.#state !== 'checking') {
          throw new ClassroomStateError(
            `checkpoint.submit cannot run while the classroom is ${this.#state}`,
          );
        }
        break;
      }
      case 'checkpoint.close': {
        if (this.#state !== 'checking') {
          throw new ClassroomStateError(
            `checkpoint.close cannot run while the classroom is ${this.#state}`,
          );
        }
        break;
      }
      case 'stage.goto_scene':
      case 'stage.highlight':
      case 'stage.pointer':
      case 'board.apply':
      case 'board.clear':
      case 'avatar.expression':
      case 'avatar.gesture':
      case 'avatar.look_at':
      case 'avatar.speech_start':
      case 'avatar.speech_end':
      case 'source.show': {
        // A teacher may continue presenting while answering an interruption,
        // but no presentation work is allowed to leak into a paused, replaying,
        // loading, failed, completed, or finalizing classroom.
        if (
          this.#state !== 'teaching' &&
          this.#state !== 'checking' &&
          this.#state !== 'interrupted'
        ) {
          throw new ClassroomStateError(
            `${action.type} cannot run while the classroom is ${this.#state}`,
          );
        }
        break;
      }
      default:
        break;
    }
    return staged;
  }

  /**
   * State transitions driven by committed typed commands. Only commands that
   * actually committed move the machine; failed dispatches never do.
   */
  #applyActionTransition(action: TeachingAction, staged: StagedDispatchMetadata = {}): void {
    switch (action.type) {
      case 'lesson.pause':
        if (this.#state === 'teaching' || this.#state === 'checking') {
          this.#pausedOriginState = this.#state;
          this.#transition('paused', 'lesson.pause');
        }
        break;
      case 'lesson.resume':
        if (this.#state === 'paused') {
          const origin = this.#pausedOriginState ?? 'teaching';
          this.#pausedOriginState = null;
          this.#transition(origin, 'lesson.resume');
        }
        break;
      case 'checkpoint.open':
        if (this.#state === 'teaching') this.#transition('checking', 'checkpoint.open');
        break;
      case 'checkpoint.close':
        if (this.#state === 'checking') this.#transition('teaching', 'checkpoint.close');
        break;
      case 'lesson.interrupt':
        if (this.#state === 'teaching' || this.#state === 'checking') {
          this.#interruption = { resumeNodeId: action.nodeId, resumeState: this.#state };
          this.#transition('interrupted', 'lesson.interrupt');
        }
        break;
      case 'lesson.resume_interrupted':
        if (this.#state === 'interrupted' && this.#interruption) {
          const { resumeState } = this.#interruption;
          this.#interruption = null;
          this.#transition(resumeState, 'lesson.resume_interrupted');
        }
        break;
      case 'lesson.relisten_start':
        if ((this.#state === 'teaching' || this.#state === 'checking') && staged.relistenOrigin) {
          this.#relisten = {
            originNodeId: staged.relistenOrigin.originNodeId,
            originState: staged.relistenOrigin.originState,
          };
          this.#transition('replaying', 'lesson.relisten_start');
        }
        break;
      case 'lesson.relisten_end':
        if (this.#state === 'replaying' && this.#relisten) {
          const { originState } = this.#relisten;
          this.#relisten = null;
          this.#transition(originState, 'lesson.relisten_end');
        }
        break;
      default:
        break;
    }
  }

  #transition(to: ClassroomState, reason: string): void {
    if (this.#state === to) return;
    const from = this.#state;
    this.#state = to;
    this.#transitions.push({ from, to, at: this.#now(), reason });
  }

  #applyHydratedProjection(projection: ClassroomActionStateProjection, initialLoad: boolean): void {
    this.#pausedOriginState = projection.pausedOriginState;
    this.#interruption = projection.interruption;
    this.#relisten = projection.relisten;

    // A terminal lifecycle state is owned by C/finalization and must not be
    // downgraded merely because the teaching W has been archived or trimmed.
    if (this.#state === 'completed' || this.#state === 'finalizing') return;

    const target = projection.state;
    if (initialLoad && (this.#state === 'loading' || this.#state === 'failed')) {
      this.#transition(
        target,
        target === 'teaching' ? 'classroom_loaded' : 'classroom_state_rehydrated',
      );
      return;
    }
    if (this.#state !== target) {
      this.#transition(target, 'classroom_state_rehydrated');
    }
  }

  async #rollbackPresentation(
    presentation: PresentationApplyResult,
    operationCause: unknown,
  ): Promise<void> {
    if (!presentation.rollback) return;
    try {
      await presentation.rollback();
    } catch (rollbackCause) {
      throw new ClassroomPresentationRollbackError(operationCause, rollbackCause);
    }
  }

  /** Hydrate W completion from persisted C once successfully; failed reads remain retryable. */
  async #hydrateCompletion(): Promise<void> {
    if (!this.#completion || this.#completionHydrated) return;
    const snapshot = await this.#completion.progressStore.load();
    const persisted = snapshot?.progress;
    if (persisted) {
      for (const nodeId of persisted.completedNodeIds) {
        if (!this.#completedNodeIds.includes(nodeId)) this.#completedNodeIds.push(nodeId);
      }
    }
    // Mark only after the complete read and projection have succeeded.  A
    // transient failure must be retried rather than poisoning this instance.
    this.#completionHydrated = true;
  }

  #requireCompletion(): ClassroomCompletionDeps {
    if (!this.#completion) {
      throw new ClassroomStateError(
        'lesson.complete_node is not configured for this classroom controller',
      );
    }
    return this.#completion;
  }

  /**
   * Submit the authoritative `lesson.complete_node` event. Serialized with
   * action dispatch so recovery points, W and C never interleave.
   */
  completeNode(input: CompleteTeachingNodeInput): Promise<ClassroomCompletionResult> {
    this.#requireCompletion();
    const result = this.#queue.then(() => this.#completeNode(input));
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Re-evaluate the completion gate after evidence changed (J3.3 path: the
   * last required checkpoint gained valid evidence and thereby supplied the
   * last missing required action).
   */
  refreshCompletionGate(): Promise<ClassroomState> {
    this.#requireCompletion();
    const result = this.#queue.then(async () => {
      await this.#hydrateCompletion();
      await this.#evaluateCompletionGate('valid_evidence_update');
      return this.#state;
    });
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * J3.7「暂时离开课堂」的唯一边界（A2）。严格顺序：先把可恢复点快照写入
   * `C`，确认成功后才销毁本次 `W`；任一步失败都抛错、保持原状态与 `W`，
   * 可整体重试。幂等：同一 `W` 内容的重试复用同一 idempotency key，命中
   * `C` tail 时跳过写入只补齐销毁；浏览器 / 标签卸载不得调用本方法冒充
   * 成功迁移（best-effort 保存由调用方另行决定，且不算成功）。
   */
  saveAndLeaveSession(): Promise<SaveAndLeaveSessionResult> {
    const lifecycle = this.#requireLifecycle();
    const result = this.#queue.then(() => this.#saveAndLeave(lifecycle));
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * J3.8 完成归档的唯一边界（A2）：只允许在 `finalizing` 调用。幂等归档
   * `W → C`（含生命周期 `archived` 与最新进度投影），随后经 A6 policy 接缝
   * 处理 learner-only candidate，全部成功后才销毁 `W`。失败抛错、停在
   * `finalizing`、保留 `W` 与待归档状态。重复调用返回首次结果，绝不二次
   * 归档。
   */
  finalizeSession(): Promise<FinalizeSessionResult> {
    const lifecycle = this.#requireLifecycle();
    const result = this.#queue.then(() => this.#finalize(lifecycle));
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #requireLifecycle(): ClassroomLifecycleDeps {
    if (!this.#lifecycle) {
      throw new ClassroomStateError(
        'Session lifecycle commands are not configured for this classroom controller',
      );
    }
    return this.#lifecycle;
  }

  async #saveAndLeave(deps: ClassroomLifecycleDeps): Promise<SaveAndLeaveSessionResult> {
    if (this.#saveAndLeaveResult) {
      return { ...this.#saveAndLeaveResult, duplicate: true };
    }
    if (
      this.#state !== 'teaching' &&
      this.#state !== 'checking' &&
      this.#state !== 'paused' &&
      this.#state !== 'interrupted' &&
      this.#state !== 'replaying'
    ) {
      throw new ClassroomStateError(
        `saveAndLeaveSession cannot run while the classroom is ${this.#state}`,
      );
    }
    const work = await this.#repository.load();
    const versioned = await deps.courseState.loadVersioned();
    if (!versioned) {
      // 「开始生成写 C」接缝尚未建立快照：失败留在课堂，W 保留，可重试。
      throw new ClassroomLifecycleError(
        'Cannot save and leave before a course state snapshot exists for this partition',
      );
    }
    const latest = versioned.snapshot;
    const leaveKeyPrefix = `saveAndLeave:${deps.classroomSessionId}:`;
    if (work.actions.length === 0 && latest.idempotencyKey.startsWith(leaveKeyPrefix)) {
      // W 已被此前一次成功离开销毁，tail 已是该次离开的保存点：判重返回。
      await deps.destroyWorkSession();
      this.#saveAndLeaveResult = {
        idempotencyKey: latest.idempotencyKey,
        duplicate: true,
        snapshot: latest,
        workSessionDestroyed: true,
        state: this.#state,
      };
      return this.#saveAndLeaveResult;
    }

    // key 以 W 首动作 id + 末序列为内容指纹：同一次离开的重试同 key，
    // 下次进课新建 W 后首动作 id 不同，绝不会撞上历史离开记录。
    const idempotencyKey = `${leaveKeyPrefix}${work.actions[0]?.id ?? 'empty'}:${work.lastSequence}`;
    let snapshot: CourseStateSnapshot;
    let duplicate = false;
    if (latest.idempotencyKey === idempotencyKey) {
      // 上次已确认写 C，重试只补齐销毁。
      duplicate = true;
      snapshot = latest;
    } else {
      const teachingActions = mergeTeachingActionsForArchive(latest.teachingActions, work);
      snapshot = await deps.courseState.save(
        {
          idempotencyKey,
          stageId: latest.stageId,
          learnerId: latest.learnerId,
          courseId: latest.courseId,
          lessonId: latest.lessonId,
          coursePlan: latest.coursePlan,
          teachingActions,
          ...(latest.progress ? { progress: latest.progress } : {}),
          ...(latest.lifecycle ? { lifecycle: latest.lifecycle } : {}),
          assistantTasks: latest.assistantTasks,
          evidence: latest.evidence,
          adjustments: latest.adjustments,
        },
        { expectedRevision: versioned.revision },
      );
    }
    // 严格顺序：C 恢复点确认写入后才销毁 W；销毁失败同样整体失败可重试。
    await deps.destroyWorkSession();
    this.#saveAndLeaveResult = {
      idempotencyKey,
      duplicate,
      snapshot,
      workSessionDestroyed: true,
      state: this.#state,
    };
    return this.#saveAndLeaveResult;
  }

  async #finalize(deps: ClassroomLifecycleDeps): Promise<FinalizeSessionResult> {
    if (this.#finalizeResult) {
      return { ...this.#finalizeResult, duplicate: true };
    }
    const idempotencyKey = `finalize:${deps.classroomSessionId}`;
    const versioned = await deps.courseState.loadVersioned();
    if (!versioned) {
      throw new ClassroomLifecycleError(
        'Cannot finalize before a course state snapshot exists for this partition',
      );
    }
    const latest = versioned.snapshot;
    const alreadyArchived = latest.lifecycle?.status === 'archived';
    if (alreadyArchived && latest.idempotencyKey !== idempotencyKey) {
      throw new ClassroomLifecycleError(
        `Course state ${latest.id} is already archived by an unknown writer`,
      );
    }
    if (!alreadyArchived && this.#state !== 'finalizing') {
      throw new ClassroomStateError(
        `finalizeSession cannot run while the classroom is ${this.#state}`,
      );
    }

    let snapshot: CourseStateSnapshot;
    let duplicate = false;
    if (latest.idempotencyKey === idempotencyKey) {
      // 归档快照已确认写入（J4.1：不得再次 finalization）：只补齐 L / 销毁。
      duplicate = true;
      snapshot = latest;
    } else {
      await this.#hydrateCompletion();
      const work = await this.#repository.load();
      const teachingActions = mergeTeachingActionsForArchive(latest.teachingActions, work);
      const progress: CourseProgress | undefined = this.#completion
        ? this.#progressProjection(this.#now())
        : latest.progress;
      snapshot = await deps.courseState.save(
        {
          idempotencyKey,
          stageId: latest.stageId,
          learnerId: latest.learnerId,
          courseId: latest.courseId,
          lessonId: latest.lessonId,
          coursePlan: latest.coursePlan,
          teachingActions,
          ...(progress ? { progress } : {}),
          lifecycle: { status: 'archived', updatedAt: this.#now() },
          assistantTasks: latest.assistantTasks,
          evidence: latest.evidence,
          adjustments: latest.adjustments,
        },
        { expectedRevision: versioned.revision },
      );
    }
    // L 接缝（A6 policy 才写）：归档 C 成功后、销毁 W 前；失败则 finalize
    // 整体失败，停在 finalizing、保留 W。
    await deps.finalizeLearnerMemory?.();
    // 全部成功后才销毁 W。
    await deps.destroyWorkSession();
    this.#finalizeResult = {
      idempotencyKey,
      duplicate,
      snapshot,
      workSessionDestroyed: true,
      state: this.#state,
    };
    return this.#finalizeResult;
  }

  async #completeNode(input: CompleteTeachingNodeInput): Promise<ClassroomCompletionResult> {
    const deps = this.#requireCompletion();
    await this.#hydrateCompletion();

    const event = lessonCompletionEventSchema.parse({
      schemaVersion: 1,
      type: 'lesson.complete_node',
      id: deps.createEventId?.() ?? `lesson-completion:${createBrowserUuid()}`,
      idempotencyKey: input.idempotencyKey,
      classroomSessionId: deps.classroomSessionId,
      courseId: deps.courseId,
      lessonId: deps.lessonId,
      nodeId: input.nodeId,
      speech: input.speech,
      actionIds: [...input.actionIds],
      occurredAt: this.#now(),
    });

    // These fields are assembled from trusted completion dependencies, but
    // keep the identity check at the event boundary so a mutable/stale
    // dependency object cannot turn a submission into another partition's
    // completion.
    if (
      event.classroomSessionId !== deps.classroomSessionId ||
      event.courseId !== deps.courseId ||
      event.lessonId !== deps.lessonId ||
      deps.lessonPlan.courseId !== event.courseId
    ) {
      throw new LessonCompletionRejectedError(
        `lesson.complete_node event identity does not match the classroom completion partition`,
      );
    }

    const node = deps.lessonPlan.nodes.find((candidate) => candidate.id === event.nodeId);
    if (!node) {
      throw new LessonCompletionRejectedError(
        `lesson.complete_node references unknown lesson node ${event.nodeId}`,
      );
    }
    if (node.type === 'checkpoint') {
      // 必要检查只能凭有效 evidence 完成，讲授完成事件无权把它标成完成。
      throw new LessonCompletionRejectedError(
        `Checkpoint node ${event.nodeId} completes via valid evidence, not lesson.complete_node`,
      );
    }

    // 幂等去重：同一 key 重试只认第一次提交的事件，W / C 不重复推进。
    const prior = this.#completionEvents.get(event.idempotencyKey);
    if (prior) {
      if (!sameCompletionRequest(prior, event)) {
        throw new LessonCompletionRejectedError(
          `lesson.complete_node key ${event.idempotencyKey} was already committed with a different completion request`,
        );
      }
      return {
        event: prior,
        duplicate: true,
        state: this.#state,
        progress: this.#progressProjection(event.occurredAt),
      };
    }

    // 协调器重启后 W 已从 C 水合：节点已完成即视为同一事件的重复提交。
    if (this.#completedNodeIds.includes(event.nodeId)) {
      // C persists the completed-node projection, not the event's references.
      // Re-validate those references against the committed W before accepting
      // a restart retry; otherwise any key could forge a duplicate merely by
      // naming an already-completed node.
      await this.#assertSpeechAndActionsEnded(event);
      this.#completionEvents.set(event.idempotencyKey, event);
      return {
        event,
        duplicate: true,
        state: this.#state,
        progress: this.#progressProjection(event.occurredAt),
      };
    }

    if (this.#state !== 'teaching' && this.#state !== 'checking') {
      // 只有真正的新提交受状态门禁约束；已提交事件的重试在上面直接判重。
      // 加载 / 播放失败或暂停态保持原状态和恢复点。
      throw new ClassroomStateError(
        `lesson.complete_node cannot be submitted while the classroom is ${this.#state}`,
      );
    }

    await this.#assertSpeechAndActionsEnded(event);

    // 先更新 W，再由同一协调器立即持久化 C.completedNode / C.progress。
    this.#completedNodeIds.push(event.nodeId);
    const progress: CourseProgress = {
      completedNodeIds: [...this.#completedNodeIds],
      lastCompletedNodeId: event.nodeId,
      updatedAt: event.occurredAt,
    };
    try {
      await deps.progressStore.saveProgress({
        idempotencyKey: `lesson.complete_node:${event.idempotencyKey}`,
        progress,
      });
    } catch (error) {
      // C 持久化失败：回滚 W，状态与恢复点不变，同一事件可重试。
      this.#completedNodeIds = this.#completedNodeIds.filter((nodeId) => nodeId !== event.nodeId);
      throw error;
    }
    this.#completionEvents.set(event.idempotencyKey, event);

    // 事件广播是非权威的：订阅失败不回滚已提交的 W / C。
    let publishError: Error | undefined;
    try {
      await deps.publishEvent?.(event);
    } catch (error) {
      publishError = toError(error);
    }

    await this.#evaluateCompletionGate(`lesson.complete_node:${event.nodeId}`);

    return {
      event,
      duplicate: false,
      state: this.#state,
      progress,
      ...(publishError ? { publishError } : {}),
    };
  }

  /**
   * 权威校验：speech_start / speech_end 与所有 action 引用都必须是本节点
   * 已成功结束（= 已通过呈现并提交进动作日志）的教师动作。媒体播放到达、
   * 加载回调或播放游标不产生这些提交，因此无权触发完成。
   */
  async #assertSpeechAndActionsEnded(event: LessonCompletionEvent): Promise<void> {
    const snapshot = await this.#repository.load();
    const committed = new Map(snapshot.actions.map((action) => [action.id, action]));

    const speechStart = committed.get(event.speech.startActionId);
    if (
      !speechStart ||
      speechStart.type !== 'avatar.speech_start' ||
      speechStart.courseId !== event.courseId ||
      speechStart.lessonId !== event.lessonId ||
      speechStart.nodeId !== event.nodeId
    ) {
      throw new LessonCompletionRejectedError(
        `Speech start ${event.speech.startActionId} has not been committed for node ${event.nodeId}`,
      );
    }
    const speechEnd = committed.get(event.speech.endActionId);
    if (
      !speechEnd ||
      speechEnd.type !== 'avatar.speech_end' ||
      speechEnd.courseId !== event.courseId ||
      speechEnd.lessonId !== event.lessonId ||
      speechEnd.nodeId !== event.nodeId ||
      speechEnd.sequence < speechStart.sequence
    ) {
      throw new LessonCompletionRejectedError(
        `Speech end ${event.speech.endActionId} has not been committed after its start for node ${event.nodeId}`,
      );
    }
    for (const actionId of event.actionIds) {
      const action = committed.get(actionId);
      if (
        !action ||
        action.courseId !== event.courseId ||
        action.lessonId !== event.lessonId ||
        action.nodeId !== event.nodeId
      ) {
        throw new LessonCompletionRejectedError(
          `Action ${actionId} has not been committed for node ${event.nodeId}`,
        );
      }
    }
  }

  #progressProjection(updatedAt: string): CourseProgress {
    return {
      completedNodeIds: [...this.#completedNodeIds],
      lastCompletedNodeId: this.#completedNodeIds.at(-1) ?? null,
      updatedAt,
    };
  }

  /**
   * 唯一完成迁移（docs/spec/01-user-journeys.md J3.1/J3.3 → J4.1 入口）：
   * 所有必需讲授节点都已提交 `lesson.complete_node`，且所有必要检查都已有
   * 有效 evidence 时，才 `completed → finalizing`。必要检查没有有效
   * evidence 时绝不进入完成态。
   */
  async #evaluateCompletionGate(reason: string): Promise<void> {
    const deps = this.#requireCompletion();
    if (this.#state !== 'teaching' && this.#state !== 'checking') return;
    const requiredCheckpoints =
      deps.requiredCheckpointNodeIds ??
      deps.lessonPlan.nodes.filter((node) => node.type === 'checkpoint').map((node) => node.id);

    for (const node of deps.lessonPlan.nodes) {
      if (node.type === 'checkpoint') {
        if (!requiredCheckpoints.includes(node.id)) continue;
        if (!(await deps.hasValidEvidence(node.id))) return;
      } else if (!this.#completedNodeIds.includes(node.id)) {
        return;
      }
    }

    this.#transition('completed', reason);
    this.#transition('finalizing', reason);
  }
}

export function createClassroomController(deps: ClassroomControllerDeps): ClassroomController {
  return new ClassroomController(deps);
}

// ---------------------------------------------------------------------------
// A2 replaySession（J4.2 课后再听 / J4.4 首页同课「再听」）
// ---------------------------------------------------------------------------

export type ReplaySessionState = 'loading' | 'playing' | 'paused' | 'failed' | 'ended';

export interface ReplaySessionDeps {
  /**
   * 独立 replay `W` 的仓库：每次重听都必须用全新 replayId 构造
   * （`livecourseReplaySessionId`），绝不恢复旧 `W`。
   */
  repository: TeachingActionRepository;
  /** 只读 `C`：播放范围严格取持久化已讲范围；replay 永不写 `C / L`。 */
  loadCourseState: () => Promise<CourseStateSnapshot | undefined>;
  applyPresentation: (
    action: TeachingAction,
  ) => PresentationApplyResult | Promise<PresentationApplyResult>;
  courseId: string;
  lessonId: string;
  now?: () => string;
  createActionId?: () => string;
}

export interface ReplaySessionStartResult {
  state: ReplaySessionState;
  /** 播放范围：`C` 持久化的已讲范围（完成课为全课）。 */
  range: readonly string[];
  /** 当前回放位置（replay `W` 折叠出的 currentNodeId）。 */
  position: string | null;
  /** 播放失败重试 / 中断后重新开始时保留的既有位置。 */
  resumed: boolean;
}

export type ReplayAdvanceResult =
  | { status: 'advanced'; nodeId: string }
  | { status: 'position-mismatch'; expectedNodeId: string; actualNodeId: string | null }
  | { status: 'at-end'; position: string | null }
  | { status: 'failed'; error: unknown };

/** Both sides of a replay presentation commit failed to converge. */
export class ReplayPresentationRollbackError extends Error {
  override readonly name = 'ReplayPresentationRollbackError';
  constructor(
    readonly operationCause: unknown,
    readonly rollbackCause: unknown,
  ) {
    super('Replay presentation could not be restored after a failed W write');
  }
}

/**
 * A replay W append failed and the idempotency read could not establish
 * whether the action reached storage.  Compensation is unsafe in this state:
 * the presentation must remain visible until the caller can retry/reconcile.
 */
export class ReplayAppendUncertaintyError extends Error {
  override readonly name = 'ReplayAppendUncertaintyError';
  readonly action: TeachingAction;
  readonly operationCause: unknown;
  readonly reconciliationCause: unknown;

  constructor(action: TeachingAction, operationCause: unknown, reconciliationCause: unknown) {
    super(`Replay action append outcome is uncertain for ${JSON.stringify(action.id)}`);
    this.action = action;
    this.operationCause = operationCause;
    this.reconciliationCause = reconciliationCause;
  }
}

/**
 * 独立 `replaySession` 生命周期（docs/spec/01-user-journeys.md J4.2/J4.4，
 * docs/spec/04-detailed-design.md §1/§6）。首页同课与课后「再听」共用。
 * 每次新建独立 replay `W`；加载失败停在 `loading`（入口留在选择态）；播放
 * 失败停在 `failed`、保留 replay `W` 的当前回放位置，可 `retry()`；暂停 /
 * 继续只写 replay `W`；自然结束或「结束重听」只销毁 replay `W`。它不调
 * 用 `finalizeSession`、不写 `C / L`、不产生 `EvidenceRecord`、不重判
 * `GoalState`。
 */
export class ReplaySessionController {
  readonly #deps: ReplaySessionDeps;
  readonly #now: () => string;
  readonly #createActionId: () => string;
  #queue: Promise<void> = Promise.resolve();
  #state: ReplaySessionState = 'loading';
  #range: readonly string[] = [];
  #pendingReplayAction: PendingReplayAction | null = null;

  constructor(deps: ReplaySessionDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#createActionId = deps.createActionId ?? (() => `replay-action:${createBrowserUuid()}`);
  }

  getState(): ReplaySessionState {
    return this.#state;
  }

  getRange(): readonly string[] {
    return this.#range;
  }

  /**
   * Whether a replay presentation/W transaction still needs reconciliation.
   * Hosts use this read-only signal to avoid destroying replay W after an
   * uncertain append that occurred outside the initial start path (for
   * example, a pause or navigation command).
   */
  hasPendingReplayAction(): boolean {
    return this.#pendingReplayAction !== null;
  }

  /** 当前回放位置：replay `W` 折叠出的 currentNodeId。 */
  async getPosition(): Promise<string | null> {
    return (await this.#deps.repository.load()).currentNodeId;
  }

  /**
   * 加载 `C` 并进入播放。加载失败抛错、停在 `loading`（不创建 replay
   * `W`）；范围为空（无已讲范围）同样抛错。`failed` 后可重新 `start()`，
   * 从 replay `W` 保留的回放位置继续。
   */
  start(): Promise<ReplaySessionStartResult> {
    return this.#enqueue(() => this.#start());
  }

  pause(): Promise<ReplaySessionState> {
    return this.#enqueue(async () => {
      if (this.#state !== 'playing') {
        throw new ClassroomStateError(`Cannot pause a replay while it is ${this.#state}`);
      }
      await this.#appendReplayAction('lesson.pause', {});
      this.#state = 'paused';
      return this.#state;
    });
  }

  resume(): Promise<ReplaySessionState> {
    return this.#enqueue(async () => {
      if (this.#state !== 'paused') {
        throw new ClassroomStateError(`Cannot resume a replay while it is ${this.#state}`);
      }
      await this.#appendReplayAction('lesson.resume', {});
      this.#state = 'playing';
      return this.#state;
    });
  }

  /** 推进回放到范围内下一节点（播放游标前进由 UI 驱动，逐节点提交）。 */
  advance(expectedNodeId?: string): Promise<string | null> {
    return this.advanceResult(expectedNodeId).then((result) => {
      if (result.status === 'advanced') return result.nodeId;
      if (result.status === 'failed') {
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
      }
      return null;
    });
  }

  /** Structured replay progression outcome for UI/controller bridges. */
  advanceResult(expectedNodeId?: string): Promise<ReplayAdvanceResult> {
    return this.#enqueue(async () => {
      try {
        if (this.#state !== 'playing') {
          throw new ClassroomStateError(`Cannot advance a replay while it is ${this.#state}`);
        }
        const position = (await this.#deps.repository.load()).currentNodeId;
        if (expectedNodeId && position !== expectedNodeId) {
          return { status: 'position-mismatch', expectedNodeId, actualNodeId: position };
        }
        const index = position ? this.#range.indexOf(position) : -1;
        const next = this.#range[index + 1];
        if (!next) return { status: 'at-end', position };
        await this.#appendReplayAction('lesson.goto_node', { targetNodeId: next }, next);
        return { status: 'advanced', nodeId: next };
      } catch (error) {
        return { status: 'failed', error };
      }
    });
  }

  /** Navigate to an explicitly requested node inside the persisted replay range. */
  navigate(targetNodeId: string): Promise<{ advanced: boolean; ended: boolean }> {
    return this.#enqueue(async () => {
      if (this.#state !== 'playing' && this.#state !== 'paused') {
        throw new ClassroomStateError(`Cannot navigate a replay while it is ${this.#state}`);
      }
      if (!this.#range.includes(targetNodeId)) {
        throw new ClassroomLifecycleError('Replay target is outside the persisted taught range');
      }
      const snapshot = await this.#deps.repository.load();
      if (snapshot.currentNodeId === targetNodeId) return { advanced: false, ended: false };
      await this.#appendReplayAction('lesson.goto_node', { targetNodeId }, targetNodeId);
      return { advanced: true, ended: false };
    });
  }

  /** 播放失败：停在 `failed`，保留 replay `W` 的当前回放位置。 */
  notifyPlaybackFailure(): Promise<ReplaySessionState> {
    return this.#enqueue(async () => {
      if (this.#state === 'ended' || this.#state === 'loading') {
        throw new ClassroomStateError(`Cannot fail a replay while it is ${this.#state}`);
      }
      this.#state = 'failed';
      return this.#state;
    });
  }

  /** 播放失败重试：重新呈现当前回放位置（replay `W` 从未丢失）。 */
  retry(): Promise<ReplaySessionState> {
    return this.#enqueue(async () => {
      if (this.#state !== 'failed') {
        throw new ClassroomStateError(`Cannot retry a replay while it is ${this.#state}`);
      }
      // A failed append may still have reached W. Reconcile the exact pending
      // action before looking at the current cursor; minting a fresh action
      // here would lose the original idempotency key and can double-commit a
      // late write.
      if (this.#pendingReplayAction) {
        const settled = await this.#settlePendingReplayAction();
        this.#state = settled.type === 'lesson.pause' ? 'paused' : 'playing';
        return this.#state;
      }
      const position = (await this.#deps.repository.load()).currentNodeId;
      if (!position) throw new ClassroomLifecycleError('Replay has no position to retry from');
      await this.#appendReplayAction('lesson.goto_node', { targetNodeId: position }, position);
      this.#state = 'playing';
      return this.#state;
    });
  }

  /**
   * 自然结束或「结束重听」的唯一出口：只销毁 replay `W`，幂等；按入口返回
   * 首页同课选择态或课后选择态由调用方导航。不写 `C / L`。
   */
  end(): Promise<ReplaySessionState> {
    return this.#enqueue(async () => {
      if (this.#state === 'ended') return this.#state;
      if (this.#state === 'loading') {
        throw new ClassroomStateError('Cannot end a replay that never started');
      }
      // Never destroy a W while an append outcome or presentation commit is
      // unresolved. The retained action must converge first so end remains a
      // safe, idempotent lifecycle boundary.
      if (this.#pendingReplayAction) await this.#settlePendingReplayAction();
      await this.#deps.repository.destroy();
      this.#state = 'ended';
      return this.#state;
    });
  }

  async #start(): Promise<ReplaySessionStartResult> {
    if (this.#state !== 'loading' && this.#state !== 'failed') {
      throw new ClassroomStateError(`Cannot start a replay while it is ${this.#state}`);
    }
    const snapshot = await this.#deps.loadCourseState();
    if (!snapshot) {
      throw new ClassroomLifecycleError(
        'Cannot start a replay before a course state snapshot exists for this partition',
      );
    }
    const entry = resolveCourseEntry(snapshot);
    if (!entry.canReplay) {
      throw new ClassroomLifecycleError('This course has no persisted taught range to replay');
    }
    this.#range = entry.taughtNodeIds;

    // Retry the exact action retained after an uncertain append (or a durable
    // action whose presentation commit failed) before inspecting the cursor.
    // In particular, a late durable write must not take the existing-position
    // branch below and cause a second presentation projection.
    if (this.#pendingReplayAction) {
      const pending = this.#pendingReplayAction;
      if (
        pending.action.type !== 'lesson.goto_node' ||
        !this.#range.includes(pending.action.payload.targetNodeId)
      ) {
        throw new ClassroomLifecycleError('Replay pending action is outside the persisted range');
      }
      const settled = await this.#settlePendingReplayAction();
      if (settled.type !== 'lesson.goto_node') {
        throw new ClassroomLifecycleError('Replay pending action is not a navigation action');
      }
      const position = settled.payload.targetNodeId;
      this.#state = 'playing';
      return {
        state: this.#state,
        range: this.#range,
        position,
        resumed: pending.presentationOnly,
      };
    }

    const existing = await this.#deps.repository.load();
    if (existing.currentNodeId && this.#range.includes(existing.currentNodeId)) {
      // 播放失败后的重开：replay `W` 仍在，从保留的回放位置继续。
      await this.#presentReplayPosition(existing.currentNodeId, existing.lastSequence);
      this.#state = 'playing';
      return {
        state: this.#state,
        range: this.#range,
        position: existing.currentNodeId,
        resumed: true,
      };
    }
    const first = this.#range[0]!;
    await this.#appendReplayAction('lesson.goto_node', { targetNodeId: first }, first);
    this.#state = 'playing';
    return { state: this.#state, range: this.#range, position: first, resumed: false };
  }

  /** 先呈现成功才提交 replay `W`（与 teaching 派发同序），失败保持原位置。 */
  async #appendReplayAction(
    type: 'lesson.pause' | 'lesson.resume' | 'lesson.goto_node',
    payload: Record<string, never> | { targetNodeId: string },
    nodeId?: string,
  ): Promise<TeachingAction> {
    const snapshot = await this.#deps.repository.load();
    const node = nodeId ?? snapshot.currentNodeId ?? this.#range[0];
    if (!node) throw new ClassroomLifecycleError('Replay has no node context for this action');

    // A previous attempt may still be unresolved. Never mint a replacement
    // request while that action is pending: first reconcile the original key,
    // and only then allow the caller to issue another command.
    const pending = this.#pendingReplayAction;
    if (pending) {
      const sameRequest =
        pending.action.nodeId === node &&
        pending.action.type === type &&
        JSON.stringify(pending.action.payload) === JSON.stringify(payload);
      if (!sameRequest) {
        // Resolve the earlier action first, then reload W so the new action's
        // sequence/current-node context is based on the post-reconciliation
        // snapshot. This is needed by playback rollback (for example a
        // failed resume that must issue a compensating pause).
        await this.#settlePendingReplayAction();
        return this.#appendReplayAction(type, payload, nodeId);
      }
      return this.#settlePendingReplayAction();
    }

    const id = this.#createActionId();
    const action = teachingActionSchema.parse({
      schemaVersion: 1,
      id,
      courseId: this.#deps.courseId,
      lessonId: this.#deps.lessonId,
      nodeId: node,
      sequence: snapshot.lastSequence + 1,
      timestamp: this.#now(),
      idempotencyKey: `replay:${id}`,
      type,
      payload,
    });
    const stateAfter: PendingReplayAction['stateAfter'] =
      type === 'lesson.pause'
        ? 'paused'
        : type === 'lesson.resume'
          ? 'playing'
          : this.#state === 'paused'
            ? 'paused'
            : 'playing';
    return this.#applyAndAppendReplayAction(action, {
      presentationOnly: false,
      stateAfter,
    });
  }

  /** Apply a replay action and converge its presentation/W transaction. */
  async #applyAndAppendReplayAction(
    action: TeachingAction,
    options: {
      presentationOnly: boolean;
      stateAfter: PendingReplayAction['stateAfter'];
    },
  ): Promise<TeachingAction> {
    let presentation: PresentationApplyResult;
    try {
      presentation = await this.#deps.applyPresentation(action);
    } catch (operationCause) {
      const rollback = presentationRollbackFromThrown(operationCause);
      if (rollback) {
        try {
          await rollback();
        } catch (rollbackCause) {
          throw new ReplayPresentationRollbackError(operationCause, rollbackCause);
        }
      }
      throw operationCause;
    }
    if (!presentation.success) {
      const presentationError = new ClassroomPresentationError(
        presentation.error || 'Replay presentation apply failed',
      );
      await this.#rollbackPresentation(presentation, presentationError);
      throw presentationError;
    }

    const pending: PendingReplayAction = {
      action,
      presentation,
      appendOutcome: 'uncertain',
      operationCause: undefined,
      presentationOnly: options.presentationOnly,
      stateAfter: options.stateAfter,
    };
    // Keep the exact action alive from the moment its presentation becomes
    // visible. If append/inspect loses a response, Retry can use this object
    // to preserve idempotency key, sequence, and the compensation hook.
    this.#pendingReplayAction = pending;

    if (options.presentationOnly) {
      pending.appendOutcome = 'durable';
      return this.#finishPendingReplayAction(pending);
    }

    // Keep the append boundary separate from presentation finalization.  If
    // `commit()` fails after append succeeds, W is already authoritative and
    // must not be mistaken for an uncertain append or compensated away.
    let committed: { action: TeachingAction; duplicate: boolean };
    try {
      committed = await this.#deps.repository.append(action);
    } catch (operationCause) {
      // A lost response does not prove that W rejected the action. Reconcile
      // the idempotency key before deciding whether compensation is safe.
      let inspection;
      try {
        inspection = await this.#deps.repository.inspect(action);
      } catch (reconciliationCause) {
        pending.operationCause = operationCause;
        pending.reconciliationCause = reconciliationCause;
        throw new ReplayAppendUncertaintyError(action, operationCause, reconciliationCause);
      }
      if (inspection.status === 'duplicate') {
        if (!sameReplayActionRequest(action, inspection.action)) {
          pending.operationCause = operationCause;
          pending.reconciliationCause = new Error(
            'Replay reconciliation returned a different action for the same idempotency key',
          );
          throw new ReplayAppendUncertaintyError(
            action,
            operationCause,
            pending.reconciliationCause,
          );
        }
        pending.action = inspection.action;
        pending.appendOutcome = 'durable';
        return this.#finishPendingReplayAction(pending);
      }

      // `new` confirms the candidate is absent at the reconciliation point;
      // only now is compensating the local presentation safe. The pending
      // object remains until rollback succeeds, so a rollback failure can be
      // retried without losing the original action identity.
      try {
        await this.#rollbackPresentation(presentation, operationCause);
      } catch (rollbackCause) {
        pending.operationCause = operationCause;
        pending.reconciliationCause = rollbackCause;
        throw rollbackCause;
      }
      if (this.#pendingReplayAction === pending) this.#pendingReplayAction = null;
      throw operationCause;
    }

    if (!sameReplayActionRequest(action, committed.action)) {
      pending.appendOutcome = 'durable';
      pending.action = committed.action;
      const mismatch = new Error(
        'Replay append returned a different action for the requested idempotency key',
      );
      pending.operationCause = mismatch;
      throw new ClassroomPresentationCommitError(committed.action, mismatch);
    }
    pending.action = committed.action;
    pending.appendOutcome = 'durable';
    return this.#finishPendingReplayAction(pending);
  }

  /**
   * Reconcile a retained replay action. For an uncertain append, duplicate
   * means the old presentation can be committed; `new` means it must be
   * rolled back and then re-applied with the exact same action before append.
   */
  async #settlePendingReplayAction(): Promise<TeachingAction> {
    const pending = this.#pendingReplayAction;
    if (!pending) throw new Error('No pending replay action to settle');

    if (pending.appendOutcome === 'durable') {
      return this.#finishPendingReplayAction(pending);
    }

    let inspection;
    try {
      inspection = await this.#deps.repository.inspect(pending.action);
    } catch (reconciliationCause) {
      pending.reconciliationCause = reconciliationCause;
      throw new ReplayAppendUncertaintyError(
        pending.action,
        pending.operationCause,
        reconciliationCause,
      );
    }

    if (inspection.status === 'duplicate') {
      if (!sameReplayActionRequest(pending.action, inspection.action)) {
        const mismatch = new Error(
          'Replay reconciliation returned a different action for the same idempotency key',
        );
        pending.reconciliationCause = mismatch;
        throw new ReplayAppendUncertaintyError(pending.action, pending.operationCause, mismatch);
      }
      pending.action = inspection.action;
      pending.appendOutcome = 'durable';
      return this.#finishPendingReplayAction(pending);
    }

    // The authority confirms the original request is absent. Compensation is
    // safe now; after rollback, re-apply the same action (not a newly minted
    // one) and retry append so the idempotency boundary remains stable.
    try {
      await this.#rollbackPresentation(pending.presentation, pending.operationCause);
    } catch (rollbackCause) {
      pending.reconciliationCause = rollbackCause;
      throw rollbackCause;
    }
    if (this.#pendingReplayAction === pending) this.#pendingReplayAction = null;
    return this.#applyAndAppendReplayAction(pending.action, {
      presentationOnly: pending.presentationOnly,
      stateAfter: pending.stateAfter,
    });
  }

  /** W is durable at this point; never roll the presentation back here. */
  async #finishPendingReplayAction(pending: PendingReplayAction): Promise<TeachingAction> {
    // Pause/resume are state transitions in their own right. Migrate those
    // states before commit so a commit-hook failure cannot make local W/state
    // contradict an already durable command. A goto action from `start()` is
    // migrated only after commit succeeds so Host can keep the loading gate
    // retryable when its first presentation finalization fails.
    if (pending.action.type !== 'lesson.goto_node') this.#state = pending.stateAfter;
    try {
      if (pending.presentation.commit) await pending.presentation.commit();
    } catch (cause) {
      pending.operationCause = cause;
      throw new ClassroomPresentationCommitError(pending.action, cause);
    }
    if (this.#pendingReplayAction === pending) this.#pendingReplayAction = null;
    if (pending.action.type === 'lesson.goto_node') this.#state = pending.stateAfter;
    return pending.action;
  }

  /** Re-apply the retained W position without appending a second W action. */
  async #presentReplayPosition(nodeId: string, sequence: number): Promise<void> {
    const action = teachingActionSchema.parse({
      schemaVersion: 1,
      id: `replay-present:${this.#createActionId()}`,
      courseId: this.#deps.courseId,
      lessonId: this.#deps.lessonId,
      nodeId,
      sequence: sequence + 1,
      timestamp: this.#now(),
      idempotencyKey: `replay-present:${nodeId}:${sequence}`,
      type: 'lesson.goto_node',
      payload: { targetNodeId: nodeId },
    });
    let presentation: PresentationApplyResult;
    try {
      presentation = await this.#deps.applyPresentation(action);
    } catch (operationCause) {
      const rollback = presentationRollbackFromThrown(operationCause);
      if (rollback) {
        try {
          await rollback();
        } catch (rollbackCause) {
          throw new ReplayPresentationRollbackError(operationCause, rollbackCause);
        }
      }
      throw operationCause;
    }
    if (!presentation.success) {
      await this.#rollbackPresentation(
        presentation,
        new ClassroomPresentationError(presentation.error || 'Replay position apply failed'),
      );
      throw new ClassroomPresentationError(presentation.error || 'Replay position apply failed');
    }
    const pending: PendingReplayAction = {
      action,
      presentation,
      appendOutcome: 'durable',
      operationCause: undefined,
      presentationOnly: true,
      stateAfter: 'playing',
    };
    this.#pendingReplayAction = pending;
    await this.#finishPendingReplayAction(pending);
  }

  async #rollbackPresentation(
    presentation: PresentationApplyResult,
    operationCause: unknown,
  ): Promise<void> {
    if (!presentation.rollback) return;
    try {
      await presentation.rollback();
    } catch (rollbackCause) {
      throw new ReplayPresentationRollbackError(operationCause, rollbackCause);
    }
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

export function createReplaySessionController(deps: ReplaySessionDeps): ReplaySessionController {
  return new ReplaySessionController(deps);
}

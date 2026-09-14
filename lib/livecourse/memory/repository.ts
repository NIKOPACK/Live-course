/**
 * LiveCourse A6 — 三层记忆的类型化 repository
 * （docs/spec/04-detailed-design.md §6，05 A6）。
 *
 * 只在现有存储矩阵（`RuntimeStore`：IndexedDB 默认、HTTP adapter、可选
 * PostgreSQL）上提供读写；不另建平行数据库。三种作用域共用同一套
 * 「单会话单记录 + compare-and-append」模式（最新记录即当前状态）：
 *
 *   - `WorkingMemoryRepository`：以 classroomSessionId 隔离，`destroy`
 *     是生命周期命令（saveAndLeave / finalize / replay 结束）的唯一
 *     销毁边界之外的补充——销毁幂等；
 *   - `CourseMemoryRepository`：以 learnerId + courseId 隔离；构造即
 *     要求显式可信 courseId（缺 courseId fail closed，见 namespaces.ts）。
 *     只持久化 intake / 误解 / 未解决问题；进度仍由
 *     `CourseStateRepository` 写，证据只走 append-only evidence stream，
 *     本模块绝不双写；
 *   - `LearnerMemoryRepository`：以 learnerId 隔离；写入前重新过白名单
 *     schema（policy.ts 是判定入口，这里是最后一道结构闸门）。
 *
 * `loadCourseLearningMemory` 把 C 记录 + `CourseStateSnapshot` 进度 +
 * 权威 evidence / GoalState 投影组合成完整 C 视图（只读组合，不产生
 * 第二事实源）。
 */
import { RuntimeAppendConflictError, type RuntimeStore } from '@livecourse/storage';
import type { RuntimeRecord, RuntimeSession } from '@livecourse/dsl';

import type { GoalRule } from '@/lib/livecourse/domain';
import { projectGoalState } from '@/lib/livecourse/domain';
import { listEvidenceRecords } from '@/lib/livecourse/evidence/runtime-repository';
import {
  assertMemorySessionIdentity,
  COURSE_MEMORY_KIND,
  courseMemorySessionId,
  LEARNER_MEMORY_KIND,
  learnerMemoryPartitionStageId,
  learnerMemorySessionId,
  WORKING_MEMORY_KIND,
  workingMemorySessionId,
  type CourseMemoryScope,
  type LearnerMemoryScope,
  type WorkingMemoryScope,
} from './namespaces';
import {
  classroomWorkingMemorySchema,
  courseMemoryRecordSchema,
  createEmptyCourseMemoryRecord,
  createEmptyLearnerMemory,
  createEmptyWorkingMemory,
  learnerMemorySchema,
  type ClassroomWorkingMemory,
  type CourseLearningMemory,
  type CourseMemoryRecord,
  type LearnerMemory,
} from './schemas';
import type { CourseStateRepository } from '@/lib/livecourse/session/course-state-repository';

const MAX_WRITE_ATTEMPTS = 8;

/** 存储行内容不合法：fail loud，不做静默空回退。 */
export class MemoryValidationError extends Error {
  override readonly name: string = 'MemoryValidationError';
}

/** A memory session exists but is no longer writable/readable in this scope. */
export class MemorySessionNotActiveError extends MemoryValidationError {
  override readonly name = 'MemorySessionNotActiveError';

  constructor(
    readonly sessionId: string,
    readonly status: RuntimeSession['status'],
  ) {
    super(`Memory session ${JSON.stringify(sessionId)} is ${JSON.stringify(status)}, not active`);
  }
}

interface SingleRecordRepoConfig<T> {
  store: RuntimeStore;
  scope: { stageId: string; learnerId: string };
  sessionId: string;
  kind: string;
  parse: (payload: unknown) => T;
  createEmpty: (now: string) => T;
  now: () => string;
}

/**
 * 单会话单记录 repository：create-or-get 会话，append 新记录表示新状态，
 * `expectedLastSeq` CAS 防并发覆盖；重试同内容天然幂等（同输入产生同
 * payload，判等返回现状）。
 */
class SingleRecordMemoryRepository<T extends object> {
  readonly #config: SingleRecordRepoConfig<T>;

  constructor(config: SingleRecordRepoConfig<T>) {
    this.#config = config;
  }

  #assertSession(session: RuntimeSession): RuntimeSession {
    assertMemorySessionIdentity(session, {
      id: this.#config.sessionId,
      kind: this.#config.kind,
      stageId: this.#config.scope.stageId,
      learnerId: this.#config.scope.learnerId,
    });
    if (session.status !== 'active') {
      throw new MemorySessionNotActiveError(session.id, session.status);
    }
    return session;
  }

  async #ensureSession(): Promise<RuntimeSession> {
    const { store, sessionId, kind, scope } = this.#config;
    const existing = await store.getSession(sessionId);
    if (existing) {
      return this.#assertSession(existing);
    }
    const now = this.#config.now();
    try {
      const created = await store.createSession({
        id: sessionId,
        kind,
        stageId: scope.stageId,
        learnerKey: scope.learnerId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      return this.#assertSession(created);
    } catch (error) {
      const raced = await store.getSession(sessionId).catch(() => undefined);
      if (!raced) throw error;
      return this.#assertSession(raced);
    }
  }

  /** 最新状态；会话不存在时返回 `undefined`（调用方决定默认值）。 */
  async load(): Promise<T | undefined> {
    const { store, sessionId } = this.#config;
    const session = await store.getSession(sessionId);
    if (!session) return undefined;
    this.#assertSession(session);
    const records = await store.listRecords(sessionId);
    // A lifecycle transition may land while the records request is in flight.
    // Re-read the session before exposing the payload so an archived W/C/L row
    // can never be observed as an active memory value.
    const currentSession = await store.getSession(sessionId);
    if (!currentSession) return undefined;
    this.#assertSession(currentSession);
    const tail = records.at(-1);
    if (!tail) return undefined;
    return this.#config.parse(tail.payload);
  }

  /**
   * 以 CAS 写入新状态。`update` 是纯函数：输入当前状态（无则空态），
   * 输出新状态；返回值与原状态深等时不动存储（幂等空写）。
   */
  async update(update: (current: T) => T): Promise<T> {
    const { store, sessionId } = this.#config;
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const session = await this.#ensureSession();
      const records = await store.listRecords(sessionId);
      // Do not run the caller's projection against a session that was closed
      // after #ensureSession resolved. The append boundary also checks this,
      // but failing before invoking user code keeps the operation fail-closed
      // and avoids computing a value from stale W/C/L state.
      const currentSession = await store.getSession(sessionId);
      if (!currentSession) {
        throw new MemoryValidationError(
          `Memory session ${JSON.stringify(sessionId)} disappeared during update`,
        );
      }
      this.#assertSession(currentSession);
      const tail: RuntimeRecord | undefined = records.at(-1);
      const current = tail
        ? this.#config.parse(tail.payload)
        : this.#config.createEmpty(this.#config.now());
      const next = update(current);
      if (JSON.stringify(next) === JSON.stringify(current)) return next;
      const now = this.#config.now();
      const revision = tail ? tail.seq + 1 : 0;
      try {
        await store.appendRecord(
          {
            id: `${sessionId}:revision:${revision}`,
            sessionId: session.id,
            payload: next as RuntimeRecord['payload'],
            createdAt: now,
          },
          { expectedLastSeq: tail ? tail.seq : null },
        );
        return next;
      } catch (error) {
        if (error instanceof RuntimeAppendConflictError && attempt < MAX_WRITE_ATTEMPTS - 1) {
          continue;
        }
        throw error;
      }
    }
    throw new Error(`Memory session ${JSON.stringify(sessionId)} write conflicted repeatedly`);
  }

  /** 销毁整个作用域（W 生命周期 / 遗忘边界）。幂等。 */
  async destroy(): Promise<void> {
    const session = await this.#config.store.getSession(this.#config.sessionId);
    if (!session) return;
    this.#assertSession(session);
    // Re-check immediately before deletion to avoid deleting a session whose
    // lifecycle changed while the first read was in flight.
    const currentSession = await this.#config.store.getSession(this.#config.sessionId);
    if (!currentSession) return;
    this.#assertSession(currentSession);
    await this.#config.store.deleteSession(currentSession.id);
  }
}

function defaultNow(): string {
  return new Date().toISOString();
}

function parseWith<T>(
  label: string,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): (payload: unknown) => T {
  return (payload) => {
    const result = parse(payload);
    if (!result.success) {
      throw new MemoryValidationError(`Stored ${label} memory payload failed schema validation`);
    }
    return result.data;
  };
}

// ──────────────────────────────────────────────
//  W
// ──────────────────────────────────────────────

export interface WorkingMemoryRepository {
  load(): Promise<ClassroomWorkingMemory | undefined>;
  update(
    update: (current: ClassroomWorkingMemory) => ClassroomWorkingMemory,
  ): Promise<ClassroomWorkingMemory>;
  destroy(): Promise<void>;
}

export function createWorkingMemoryRepository(options: {
  store: RuntimeStore;
  scope: WorkingMemoryScope & { courseId: string; lessonId: string };
  now?: () => string;
}): WorkingMemoryRepository {
  const now = options.now ?? defaultNow;
  const repo = new SingleRecordMemoryRepository<ClassroomWorkingMemory>({
    store: options.store,
    scope: options.scope,
    sessionId: workingMemorySessionId(options.scope),
    kind: WORKING_MEMORY_KIND,
    parse: parseWith('working', (v) => classroomWorkingMemorySchema.safeParse(v)),
    createEmpty: (timestamp) =>
      createEmptyWorkingMemory({
        classroomSessionId: options.scope.classroomSessionId,
        stageId: options.scope.stageId,
        learnerId: options.scope.learnerId,
        courseId: options.scope.courseId,
        lessonId: options.scope.lessonId,
        now: timestamp,
      }),
    now,
  });
  return { load: () => repo.load(), update: (u) => repo.update(u), destroy: () => repo.destroy() };
}

// ──────────────────────────────────────────────
//  C（intake / 误解 / 未解决问题 + 组合视图）
// ──────────────────────────────────────────────

export interface CourseMemoryRepository {
  load(): Promise<CourseMemoryRecord | undefined>;
  update(update: (current: CourseMemoryRecord) => CourseMemoryRecord): Promise<CourseMemoryRecord>;
  destroy(): Promise<void>;
}

/**
 * 构造即要求显式可信的 `learnerId + courseId`：缺 `courseId` 时
 * `courseMemorySessionId` fail closed（MissingCourseIdError），绝不退化
 * 成 learner-wide 搜索。
 */
export function createCourseMemoryRepository(options: {
  store: RuntimeStore;
  scope: CourseMemoryScope;
  now?: () => string;
}): CourseMemoryRepository {
  const now = options.now ?? defaultNow;
  const repo = new SingleRecordMemoryRepository<CourseMemoryRecord>({
    store: options.store,
    scope: options.scope,
    sessionId: courseMemorySessionId(options.scope),
    kind: COURSE_MEMORY_KIND,
    parse: parseWith('course', (v) => courseMemoryRecordSchema.safeParse(v)),
    createEmpty: (timestamp) =>
      createEmptyCourseMemoryRecord({
        stageId: options.scope.stageId,
        learnerId: options.scope.learnerId,
        courseId: options.scope.courseId,
        now: timestamp,
      }),
    now,
  });
  return { load: () => repo.load(), update: (u) => repo.update(u), destroy: () => repo.destroy() };
}

/**
 * 组合完整 C 视图（只读）：C 记录 + `CourseStateSnapshot` 进度物化 +
 * 权威 evidence stream 与按规则重算的 GoalState 投影。evidence append
 * stream 是唯一权威事实源；本函数不产生第二套可写事实。
 */
export async function loadCourseLearningMemory(options: {
  store: RuntimeStore;
  scope: CourseMemoryScope;
  courseState: Pick<CourseStateRepository, 'load'>;
  goalRules?: Readonly<Record<string, GoalRule>>;
  now?: () => string;
  /** Optional owner lifecycle guard for asynchronous reads. */
  assertActive?: () => void;
}): Promise<CourseLearningMemory> {
  options.assertActive?.();
  const record = await createCourseMemoryRepository({
    store: options.store,
    scope: options.scope,
    ...(options.now ? { now: options.now } : {}),
  }).load();
  options.assertActive?.();
  const snapshot = await options.courseState.load();
  options.assertActive?.();
  // 证据读取仍走既有 stage+learner 分区的权威 stream，再按 courseId
  // 收窄到本课程；缺 courseId 时本函数在构造 repository 时已失败。
  const evidence = await listEvidenceRecords(options.scope.stageId, {
    store: options.store,
    learnerId: options.scope.learnerId,
    courseId: options.scope.courseId,
    assertActive: options.assertActive,
  });
  options.assertActive?.();
  const goalIds = [...new Set(evidence.map((item) => item.goalId))];
  const goalStates = goalIds
    .map((goalId) => {
      const rule = options.goalRules?.[goalId];
      if (!rule) return undefined;
      return projectGoalState({
        courseId: options.scope.courseId,
        learnerId: options.scope.learnerId,
        goalId,
        rule,
        evidence,
      });
    })
    .filter((state): state is NonNullable<typeof state> => state !== undefined);

  const memory: CourseLearningMemory = {
    stageId: options.scope.stageId,
    learnerId: options.scope.learnerId,
    courseId: options.scope.courseId,
    misconceptions: record?.misconceptions ?? [],
    unresolvedQuestions: record?.unresolvedQuestions ?? [],
    evidenceTailRevision: evidence.length,
    goalStates,
    evidence,
  };
  if (record?.intake) memory.intake = record.intake;
  if (snapshot?.progress) {
    memory.progress = {
      completedNodeIds: [...snapshot.progress.completedNodeIds],
      updatedAt: snapshot.progress.updatedAt,
    };
  }
  return memory;
}

// ──────────────────────────────────────────────
//  L
// ──────────────────────────────────────────────

export interface LearnerMemoryRepository {
  load(): Promise<LearnerMemory | undefined>;
  update(update: (current: LearnerMemory) => LearnerMemory): Promise<LearnerMemory>;
  destroy(): Promise<void>;
}

export function createLearnerMemoryRepository(options: {
  store: RuntimeStore;
  scope: LearnerMemoryScope;
  now?: () => string;
}): LearnerMemoryRepository {
  const now = options.now ?? defaultNow;
  // RuntimeStore indexes every session by `(stageId, learnerKey)`.  L is
  // learner-only by contract, so normalize the caller's route stage to the
  // reserved physical partition before constructing the generic repository.
  // The caller-supplied stage (if any) is intentionally never used for L.
  const physicalScope = {
    stageId: learnerMemoryPartitionStageId(options.scope),
    learnerId: options.scope.learnerId,
  };
  const assertLearnerPayloadIdentity = (memory: LearnerMemory): LearnerMemory => {
    if (memory.stageId !== physicalScope.stageId || memory.learnerId !== physicalScope.learnerId) {
      throw new MemoryValidationError(
        'Stored learner memory payload belongs to another learner-only partition',
      );
    }
    return memory;
  };
  const repo = new SingleRecordMemoryRepository<LearnerMemory>({
    store: options.store,
    scope: physicalScope,
    sessionId: learnerMemorySessionId(options.scope),
    kind: LEARNER_MEMORY_KIND,
    parse: (payload) =>
      assertLearnerPayloadIdentity(
        parseWith('learner', (v) => learnerMemorySchema.safeParse(v))(payload),
      ),
    createEmpty: (timestamp) =>
      createEmptyLearnerMemory({
        stageId: physicalScope.stageId,
        learnerId: options.scope.learnerId,
        now: timestamp,
      }),
    now,
  });
  return {
    load: () => repo.load(),
    update: (update) => repo.update((current) => assertLearnerPayloadIdentity(update(current))),
    destroy: () => repo.destroy(),
  };
}

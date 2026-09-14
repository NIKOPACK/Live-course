/**
 * LiveCourse A6 — 记忆作用域（namespace）构造的唯一入口
 * （docs/spec/04-detailed-design.md §6）。
 *
 * 三种作用域映射到现有 `RuntimeStore` 的 `(stageId, learnerKey)` 分区 +
 * 确定性 session id，与 teaching-action / evidence / course-state
 * repository 的既有模式一致：
 *
 *   - W：`livecourseWorkingMemory`  — 以 classroomSessionId 隔离；
 *   - C：`livecourseCourseMemory`   — 以 learnerId + courseId 隔离；
 *   - L：`livecourseLearnerMemory`  — 以 learnerId 隔离。
 *
 * 纪律：
 *   - 课程作用域缺 `courseId` 必须 fail closed（抛 `MissingCourseIdError`），
 *     不能退化成 learner-wide 搜索；
 *   - 模型无权拼 namespace 或 filter：所有 id 只能由本模块的函数构造；
 *   - filter 不是安全边界——分区身份在读写两侧都要校验（repository.ts）。
 */
import type { RuntimeSession } from '@livecourse/dsl';

export const WORKING_MEMORY_KIND = 'livecourseWorkingMemory';
export const COURSE_MEMORY_KIND = 'livecourseCourseMemory';
export const LEARNER_MEMORY_KIND = 'livecourseLearnerMemory';

/**
 * RuntimeStore's native partition key includes `stageId`, while A6 learner
 * memory is deliberately learner-only.  Keep the storage contract unchanged
 * by placing every L record in one reserved physical stage partition.  This
 * value is an implementation marker, not a classroom/stage identity and must
 * never be taken from a route or a model-produced value.
 */
// The colon is intentional: classroom route ids are restricted to
// `[A-Za-z0-9_-]+`, so a user-created stage cannot collide with this bucket.
export const LEARNER_MEMORY_PARTITION_STAGE_ID = '__livecourse:learner-memory__';

/** 课程作用域缺 courseId：fail closed，绝不退化。 */
export class MissingCourseIdError extends Error {
  override readonly name = 'MissingCourseIdError';

  constructor() {
    super('Course-scoped memory access requires an explicit trusted courseId');
  }
}

/** 存储行与本模块声明的分区不一致：fail loud。 */
export class MemoryPartitionError extends Error {
  override readonly name = 'MemoryPartitionError';
}

export interface WorkingMemoryScope {
  stageId: string;
  learnerId: string;
  classroomSessionId: string;
}

export interface CourseMemoryScope {
  stageId: string;
  learnerId: string;
  courseId: string;
}

export interface LearnerMemoryScope {
  learnerId: string;
  /**
   * Deprecated compatibility field.  L is not stage-scoped; callers may keep
   * passing the current classroom stage, but it is intentionally ignored when
   * constructing the physical namespace.
   */
  stageId?: string;
}

function requireIdentifier(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new MemoryPartitionError(`Memory scope field ${field} must be a non-empty identifier`);
  }
  return trimmed;
}

/** W session id：以 classroomSessionId 隔离；新 session 天然拿到全新 W。 */
export function workingMemorySessionId(scope: WorkingMemoryScope): string {
  return [
    'livecourse-working-memory',
    requireIdentifier(scope.stageId, 'stageId'),
    requireIdentifier(scope.learnerId, 'learnerId'),
    requireIdentifier(scope.classroomSessionId, 'classroomSessionId'),
  ]
    .map(encodeURIComponent)
    .join(':');
}

/** C session id：以 learnerId + courseId 隔离；缺 courseId 直接失败。 */
export function courseMemorySessionId(scope: CourseMemoryScope): string {
  if (!scope.courseId?.trim()) throw new MissingCourseIdError();
  return [
    'livecourse-course-memory',
    requireIdentifier(scope.stageId, 'stageId'),
    requireIdentifier(scope.learnerId, 'learnerId'),
    requireIdentifier(scope.courseId, 'courseId'),
  ]
    .map(encodeURIComponent)
    .join(':');
}

/** L session id：以 learnerId 隔离（同一 learner 跨课程共享的唯一作用域）。 */
export function learnerMemorySessionId(scope: LearnerMemoryScope): string {
  return ['livecourse-learner-memory', requireIdentifier(scope.learnerId, 'learnerId')]
    .map(encodeURIComponent)
    .join(':');
}

/**
 * The physical RuntimeStore stage used by learner-only memory.  Keeping this
 * behind the namespace module makes it impossible for a caller to accidentally
 * reintroduce the route stage into an L repository partition.
 */
export function learnerMemoryPartitionStageId(scope: LearnerMemoryScope): string {
  requireIdentifier(scope.learnerId, 'learnerId');
  return LEARNER_MEMORY_PARTITION_STAGE_ID;
}

/** 读 / 写两侧的存储行身份校验（沿用 evidence / course-state 的模式）。 */
export function assertMemorySessionIdentity(
  session: RuntimeSession,
  expected: { id: string; kind: string; stageId: string; learnerId: string },
): void {
  if (
    session.id !== expected.id ||
    session.kind !== expected.kind ||
    session.stageId !== expected.stageId ||
    session.learnerKey !== expected.learnerId
  ) {
    throw new MemoryPartitionError(
      `Memory session ${JSON.stringify(session.id)} belongs to another partition`,
    );
  }
}

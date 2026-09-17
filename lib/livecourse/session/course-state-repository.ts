/**
 * LiveCourse — RuntimeStore-backed course state repository (P-004).
 *
 * This is the ONLY write/read boundary for `CourseStateSnapshot`. It persists
 * one versioned, schema-validated snapshot per course inside the existing
 * `(stage, learner)` partition through the existing `RuntimeStore` contract:
 *
 *   - a distinct typed runtime session/record (`livecourseCourseState` kind),
 *     partitioned and identity-checked exactly like the teaching-action and
 *     evidence runtime repositories;
 *   - stable snapshot id + idempotency semantics — a retried `save` returns
 *     the original record, never a duplicate;
 *   - optimistic concurrency — every append is a compare-and-append against
 *     the observed record tail, so a concurrent writer can never silently
 *     overwrite; conflicting reuse of an id/idempotency key fails explicitly.
 *
 * Recovery (`restore`) is the pure `recoverCourseState` path: it never
 * dispatches, publishes, reapplies or appends anything.
 */
import { RuntimeAppendConflictError, type RuntimeStore } from '@livecourse/storage';
import type { RuntimeSession } from '@livecourse/dsl';

import {
  buildCourseStateSnapshot,
  courseProgressSchema,
  parseCourseStateSnapshot,
  recoverCourseState,
  sameCourseStateSnapshot,
  CourseStatePartitionError,
  CourseStateSnapshotConflictError,
  CourseStateValidationError,
  type CourseProgress,
  type CourseStateRecovery,
  type CourseStateSnapshot,
  type CourseStateSnapshotInput,
} from './course-state-snapshot';

/** Runtime session kind for one course's durable snapshot stream. */
export const LIVECOURSE_COURSE_STATE_KIND = 'livecourseCourseState';

const MAX_APPEND_ATTEMPTS = 8;

export function courseStateSessionId(options: {
  stageId: string;
  learnerId: string;
  courseId: string;
}): string {
  return ['livecourse-course-state', options.stageId, options.learnerId, options.courseId]
    .map(encodeURIComponent)
    .join(':');
}

export interface CourseStateRepository {
  /**
   * Create the first durable `C` snapshot for this course partition. The
   * operation is guarded by an empty-tail CAS (`expectedLastSeq: null`): an
   * identical retry returns the winner, a same-key/content mismatch fails
   * explicitly, and a different generation can never replace the first one.
   * The caller must provide the complete, schema-valid snapshot input; this
   * boundary never invents a `CoursePlan` or other course data.
   */
  initialize(input: CourseStateSnapshotInput): Promise<CourseStateSnapshot>;
  /**
   * Persist one snapshot under the repository partition. A retry with the
   * same id/idempotency key and identical content returns the original
   * record; conflicting reuse fails with `CourseStateSnapshotConflictError`.
   */
  save(
    input: CourseStateSnapshotInput,
    options?: { expectedRevision?: number | null },
  ): Promise<CourseStateSnapshot>;
  /**
   * Persist the `C.completedNode / C.progress` projection for one
   * `lesson.complete_node` event (docs/spec/04-detailed-design.md §1, A2).
   * The snapshot idempotency key is derived from the event key, so a retried
   * event returns the record it produced and never advances progress twice;
   * same-key reuse with a different projection fails explicitly. Progress is
   * append-only: a retry whose projection is already covered by the persisted
   * tail is a no-op even after the coordinator restarted. Fails loud when no
   * course state snapshot exists for the partition yet.
   */
  saveProgress(
    input: { idempotencyKey: string; progress: CourseProgress },
    options?: { expectedRevision?: number | null },
  ): Promise<CourseStateSnapshot>;
  /** Load the latest stored snapshot for the partition, or `undefined`. */
  load(): Promise<CourseStateSnapshot | undefined>;
  /** Load the authoritative snapshot together with its RuntimeStore tail revision. */
  loadVersioned(): Promise<VersionedCourseState | undefined>;
  /** Load + recover. `undefined` when no snapshot exists for the partition. */
  restore(): Promise<CourseStateRecovery | undefined>;
}

export interface VersionedCourseState {
  snapshot: CourseStateSnapshot;
  revision: number;
}

export class CourseStateRevisionConflictError extends Error {
  override readonly name = 'CourseStateRevisionConflictError';

  constructor(
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null,
  ) {
    super(
      `Course state revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}`,
    );
  }
}

export interface RuntimeCourseStateRepositoryOptions {
  store: RuntimeStore;
  stageId: string;
  learnerId: string;
  courseId: string;
  now?: () => string;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function sameCourseProgress(left: CourseProgress, right: CourseProgress): boolean {
  return (
    left.lastCompletedNodeId === right.lastCompletedNodeId &&
    left.updatedAt === right.updatedAt &&
    left.completedNodeIds.length === right.completedNodeIds.length &&
    left.completedNodeIds.every((nodeId, index) => nodeId === right.completedNodeIds[index])
  );
}

/** Append-only coverage: every node of `next` is already in `persisted`. */
function courseProgressCovered(persisted: CourseProgress, next: CourseProgress): boolean {
  const persistedIds = new Set(persisted.completedNodeIds);
  return next.completedNodeIds.every((nodeId) => persistedIds.has(nodeId));
}

function assertSessionIdentity(
  session: RuntimeSession,
  expected: { id: string; stageId: string; learnerId: string },
): void {
  if (
    session.id !== expected.id ||
    session.kind !== LIVECOURSE_COURSE_STATE_KIND ||
    session.stageId !== expected.stageId ||
    session.learnerKey !== expected.learnerId
  ) {
    throw new CourseStatePartitionError(
      `Course state session ${JSON.stringify(session.id)} has invalid identity`,
    );
  }
}

export class RuntimeCourseStateRepository implements CourseStateRepository {
  readonly #store: RuntimeStore;
  readonly #stageId: string;
  readonly #learnerId: string;
  readonly #courseId: string;
  readonly #sessionId: string;
  readonly #now: () => string;

  constructor(options: RuntimeCourseStateRepositoryOptions) {
    this.#store = options.store;
    this.#stageId = requireIdentifier(options.stageId, 'stageId');
    this.#learnerId = requireIdentifier(options.learnerId, 'learnerId');
    this.#courseId = requireIdentifier(options.courseId, 'courseId');
    this.#sessionId = courseStateSessionId({
      stageId: this.#stageId,
      learnerId: this.#learnerId,
      courseId: this.#courseId,
    });
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async initialize(input: CourseStateSnapshotInput): Promise<CourseStateSnapshot> {
    const candidate = buildCourseStateSnapshot(input, { now: this.#now });
    this.#assertPartition(candidate);
    const session = await this.#ensureSession();

    // Initialization is intentionally stricter than `save`: once any C
    // generation exists, a new generation must not silently replace it. The
    // matching-id checks make retries deterministic even after a coordinator
    // restart; the append below supplies the atomic empty-tail CAS for races.
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const records = await this.#store.listRecords(session.id);
      for (const record of records) {
        const existing = parseCourseStateSnapshot(record.payload);
        if (existing.id === candidate.id) {
          if (sameCourseStateSnapshot(existing, candidate)) return existing;
          throw new CourseStateSnapshotConflictError('id', candidate.id);
        }
        if (existing.idempotencyKey === candidate.idempotencyKey) {
          if (sameCourseStateSnapshot(existing, candidate)) return existing;
          throw new CourseStateSnapshotConflictError('idempotencyKey', candidate.idempotencyKey);
        }
      }

      const actualRevision = records.at(-1)?.seq ?? null;
      if (actualRevision !== null) {
        throw new CourseStateRevisionConflictError(null, actualRevision);
      }

      try {
        await this.#store.appendRecord(
          {
            id: candidate.id,
            sessionId: session.id,
            createdAt: candidate.createdAt,
            payload: candidate,
          },
          { expectedLastSeq: null },
        );
        return candidate;
      } catch (error) {
        if (error instanceof RuntimeAppendConflictError) {
          // Another initializer won the empty-tail race. Re-read and apply
          // the idempotency/content checks above; never append a second C.
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `Course state initialization did not converge after ${MAX_APPEND_ATTEMPTS} compare-and-append retries`,
    );
  }

  async save(
    input: CourseStateSnapshotInput,
    options: { expectedRevision?: number | null } = {},
  ): Promise<CourseStateSnapshot> {
    const candidate = buildCourseStateSnapshot(input, { now: this.#now });
    this.#assertPartition(candidate);
    const session = await this.#ensureSession();
    return this.#appendOnce(session, candidate, options.expectedRevision);
  }

  async load(): Promise<CourseStateSnapshot | undefined> {
    return (await this.loadVersioned())?.snapshot;
  }

  async saveProgress(
    input: { idempotencyKey: string; progress: CourseProgress },
    options: { expectedRevision?: number | null } = {},
  ): Promise<CourseStateSnapshot> {
    const idempotencyKey = requireIdentifier(input.idempotencyKey, 'idempotencyKey');
    const progress = courseProgressSchema.parse(input.progress);
    const versioned = await this.loadVersioned();
    if (!versioned) {
      throw new CourseStateValidationError(
        'Cannot persist lesson progress before a course state snapshot exists for this partition',
      );
    }
    const latest = versioned.snapshot;

    if (latest.idempotencyKey === idempotencyKey) {
      // Retry of the event that produced the current tail.
      if (latest.progress && sameCourseProgress(latest.progress, progress)) return latest;
      throw new CourseStateSnapshotConflictError('idempotencyKey', idempotencyKey);
    }
    if (latest.progress && courseProgressCovered(latest.progress, progress)) {
      // Cross-restart retry: the projection is already part of the tail.
      return latest;
    }

    return this.save(
      {
        idempotencyKey,
        stageId: latest.stageId,
        learnerId: latest.learnerId,
        courseId: latest.courseId,
        lessonId: latest.lessonId,
        coursePlan: latest.coursePlan,
        teachingActions: latest.teachingActions,
        progress,
        ...(latest.playbackPosition ? { playbackPosition: latest.playbackPosition } : {}),
        ...(latest.lifecycle ? { lifecycle: latest.lifecycle } : {}),
        assistantTasks: latest.assistantTasks,
        evidence: latest.evidence,
        adjustments: latest.adjustments,
      },
      { expectedRevision: options.expectedRevision ?? versioned.revision },
    );
  }

  async loadVersioned(): Promise<VersionedCourseState | undefined> {
    const session = await this.#store.getSession(this.#sessionId);
    if (!session) return undefined;
    assertSessionIdentity(session, {
      id: this.#sessionId,
      stageId: this.#stageId,
      learnerId: this.#learnerId,
    });
    const records = await this.#store.listRecords(session.id);
    if (records.length === 0) return undefined;
    // Records are store-ordered by seq; the latest generation is authoritative.
    const latest = records[records.length - 1]!;
    return {
      snapshot: parseCourseStateSnapshot(latest.payload),
      revision: latest.seq,
    };
  }

  async restore(): Promise<CourseStateRecovery | undefined> {
    const snapshot = await this.load();
    if (!snapshot) return undefined;
    return recoverCourseState(snapshot, {
      stageId: this.#stageId,
      learnerId: this.#learnerId,
    });
  }

  #assertPartition(candidate: CourseStateSnapshot): void {
    if (candidate.stageId !== this.#stageId) {
      throw new CourseStatePartitionError(
        `Snapshot ${candidate.id} belongs to stage ${candidate.stageId}, not ${this.#stageId}`,
      );
    }
    if (candidate.learnerId !== this.#learnerId) {
      throw new CourseStatePartitionError(
        `Snapshot ${candidate.id} belongs to learner ${candidate.learnerId}, not ${this.#learnerId}`,
      );
    }
    if (candidate.courseId !== this.#courseId) {
      throw new CourseStatePartitionError(
        `Snapshot ${candidate.id} belongs to course ${candidate.courseId}, not ${this.#courseId}`,
      );
    }
  }

  async #ensureSession(): Promise<RuntimeSession> {
    const existing = await this.#store.getSession(this.#sessionId);
    if (existing) {
      assertSessionIdentity(existing, {
        id: this.#sessionId,
        stageId: this.#stageId,
        learnerId: this.#learnerId,
      });
      return existing;
    }

    const timestamp = this.#now();
    try {
      return await this.#store.createSession({
        id: this.#sessionId,
        kind: LIVECOURSE_COURSE_STATE_KIND,
        stageId: this.#stageId,
        learnerKey: this.#learnerId,
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      const winner = await this.#store.getSession(this.#sessionId);
      if (!winner) throw error;
      assertSessionIdentity(winner, {
        id: this.#sessionId,
        stageId: this.#stageId,
        learnerId: this.#learnerId,
      });
      return winner;
    }
  }

  /**
   * Compare-and-append one snapshot. Idempotent retries return the original
   * record; same-key reuse with different content fails explicitly; racing
   * writers retry on the store's tail conflict and never overwrite silently.
   */
  async #appendOnce(
    session: RuntimeSession,
    candidate: CourseStateSnapshot,
    expectedRevision?: number | null,
  ): Promise<CourseStateSnapshot> {
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const records = await this.#store.listRecords(session.id);
      for (const record of records) {
        const existing = parseCourseStateSnapshot(record.payload);
        if (existing.id === candidate.id) {
          if (sameCourseStateSnapshot(existing, candidate)) return existing;
          throw new CourseStateSnapshotConflictError('id', candidate.id);
        }
        if (existing.idempotencyKey === candidate.idempotencyKey) {
          if (sameCourseStateSnapshot(existing, candidate)) return existing;
          throw new CourseStateSnapshotConflictError('idempotencyKey', candidate.idempotencyKey);
        }
      }

      const actualRevision = records.at(-1)?.seq ?? null;
      if (expectedRevision !== undefined && actualRevision !== expectedRevision) {
        throw new CourseStateRevisionConflictError(expectedRevision, actualRevision);
      }

      try {
        await this.#store.appendRecord(
          {
            id: candidate.id,
            sessionId: session.id,
            createdAt: candidate.createdAt,
            payload: candidate,
          },
          { expectedLastSeq: records.at(-1)?.seq ?? null },
        );
        return candidate;
      } catch (error) {
        if (error instanceof RuntimeAppendConflictError) {
          if (expectedRevision !== undefined) {
            throw new CourseStateRevisionConflictError(expectedRevision, error.actualLastSeq);
          }
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `Course state snapshot save did not converge after ${MAX_APPEND_ATTEMPTS} compare-and-append retries`,
    );
  }
}

export function createCourseStateRepository(
  options: RuntimeCourseStateRepositoryOptions,
): CourseStateRepository {
  return new RuntimeCourseStateRepository(options);
}

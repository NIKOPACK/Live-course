import { RuntimeAppendConflictError, type RuntimeStore } from '@livecourse/storage';
import type { RuntimeRecord, RuntimeSession } from '@livecourse/dsl';

import { teachingActionSchema, type TeachingAction } from '@/lib/livecourse/domain';

export const LIVECOURSE_ACTION_KIND = 'livecourseAction';

const EMPTY_SEQUENCE = -1;
const MAX_APPEND_ATTEMPTS = 8;

export interface ClassroomRecoveryPoint {
  currentNodeId: string | null;
  lastSequence: number;
}

export interface TeachingActionSnapshot extends ClassroomRecoveryPoint {
  actions: readonly TeachingAction[];
}

export type TeachingActionInspection =
  | {
      status: 'new';
      action: TeachingAction;
      snapshot: TeachingActionSnapshot;
    }
  | {
      status: 'duplicate';
      action: TeachingAction;
      snapshot: TeachingActionSnapshot;
    };

export interface AppendTeachingActionResult {
  action: TeachingAction;
  duplicate: boolean;
  recoveryPoint: ClassroomRecoveryPoint;
}

export interface TeachingActionRepository {
  load(): Promise<TeachingActionSnapshot>;
  inspect(action: TeachingAction): Promise<TeachingActionInspection>;
  append(action: TeachingAction): Promise<AppendTeachingActionResult>;
  /**
   * 销毁本仓库对应的整个 `W` 会话（docs/spec/04-detailed-design.md §6：
   * `saveAndLeaveSession` / `finalizeSession` / replay 结束的唯一销毁边界）。
   * 幂等：会话不存在时直接返回。
   */
  destroy(): Promise<void>;
}

export interface RuntimeTeachingActionRepositoryOptions {
  store: RuntimeStore;
  stageId: string;
  learnerId: string;
  courseId: string;
  lessonId: string;
  /**
   * 重放会话鉴别符（A2，J4.2/J4.4）：每次 `replaySession` 必须用全新的
   * replayId 得到一条独立 replay `W`，绝不复用或恢复旧 `W`。
   */
  replayId?: string;
  now?: () => string;
}

export class TeachingActionIdempotencyConflictError extends Error {
  override readonly name = 'TeachingActionIdempotencyConflictError';

  constructor(readonly idempotencyKey: string) {
    super(`Teaching action idempotency conflict for ${JSON.stringify(idempotencyKey)}`);
  }
}

export class TeachingActionIdentityConflictError extends Error {
  override readonly name = 'TeachingActionIdentityConflictError';

  constructor(readonly actionId: string) {
    super(`Teaching action id conflict for ${JSON.stringify(actionId)}`);
  }
}

export class TeachingActionSequenceError extends Error {
  override readonly name = 'TeachingActionSequenceError';

  constructor(
    readonly actualSequence: number,
    readonly expectedSequence: number,
  ) {
    super(`Teaching action sequence ${actualSequence} must equal ${expectedSequence}`);
  }
}

export class TeachingActionSessionNotActiveError extends Error {
  override readonly name = 'TeachingActionSessionNotActiveError';

  constructor(
    readonly sessionId: string,
    readonly status: RuntimeSession['status'],
  ) {
    super(
      `Teaching action session ${JSON.stringify(sessionId)} is ${JSON.stringify(status)}, not active`,
    );
  }
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

export function livecourseActionSessionId(options: {
  stageId: string;
  learnerId: string;
  courseId: string;
  lessonId: string;
}): string {
  return [
    'livecourse-actions',
    options.stageId,
    options.learnerId,
    options.courseId,
    options.lessonId,
  ]
    .map(encodeURIComponent)
    .join(':');
}

/**
 * 独立 replay `W` 的会话 id（A2，J4.2/J4.4）：每次重听都用新的 replayId，
 * 与 teaching `W` 以及任何一次历史 replay `W` 都不相同。
 */
export function livecourseReplaySessionId(options: {
  stageId: string;
  learnerId: string;
  courseId: string;
  lessonId: string;
  replayId: string;
}): string {
  return `${livecourseActionSessionId(options)}:replay:${encodeURIComponent(options.replayId)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('Teaching action value is not JSON-safe');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

function normalizeTeachingAction(input: TeachingAction): TeachingAction {
  const parsed = teachingActionSchema.parse(input);
  const serialized = JSON.stringify(parsed);
  if (serialized === undefined) throw new TypeError('Teaching action is not JSON-safe');
  return teachingActionSchema.parse(JSON.parse(serialized));
}

function semanticAction(action: TeachingAction): object {
  return {
    courseId: action.courseId,
    lessonId: action.lessonId,
    nodeId: action.nodeId,
    type: action.type,
    payload: action.payload,
  };
}

function sameActionRequest(left: TeachingAction, right: TeachingAction): boolean {
  return canonicalJson(semanticAction(left)) === canonicalJson(semanticAction(right));
}

function recoveryNodeId(action: TeachingAction): string {
  return action.type === 'lesson.goto_node' ? action.payload.targetNodeId : action.nodeId;
}

function recoveryPoint(snapshot: TeachingActionSnapshot): ClassroomRecoveryPoint {
  return {
    currentNodeId: snapshot.currentNodeId,
    lastSequence: snapshot.lastSequence,
  };
}

export function foldTeachingActions(actions: readonly TeachingAction[]): TeachingActionSnapshot {
  const parsed = actions.map((action) => teachingActionSchema.parse(action));
  let currentNodeId: string | null = null;
  let lastSequence = EMPTY_SEQUENCE;

  for (const action of parsed) {
    const expectedSequence = lastSequence + 1;
    if (action.sequence !== expectedSequence) {
      throw new TeachingActionSequenceError(action.sequence, expectedSequence);
    }
    currentNodeId = recoveryNodeId(action);
    lastSequence = action.sequence;
  }

  return { actions: parsed, currentNodeId, lastSequence };
}

function inspectCandidate(
  snapshot: TeachingActionSnapshot,
  candidate: TeachingAction,
): TeachingActionInspection {
  const sameKey = snapshot.actions.find(
    (action) => action.idempotencyKey === candidate.idempotencyKey,
  );
  if (sameKey) {
    if (!sameActionRequest(sameKey, candidate)) {
      throw new TeachingActionIdempotencyConflictError(candidate.idempotencyKey);
    }
    return { status: 'duplicate', action: sameKey, snapshot };
  }

  const sameId = snapshot.actions.find((action) => action.id === candidate.id);
  if (sameId) throw new TeachingActionIdentityConflictError(candidate.id);

  const expectedSequence = snapshot.lastSequence + 1;
  if (candidate.sequence !== expectedSequence) {
    throw new TeachingActionSequenceError(candidate.sequence, expectedSequence);
  }

  return { status: 'new', action: candidate, snapshot };
}

function assertSessionIdentity(
  session: RuntimeSession,
  expected: {
    id: string;
    stageId: string;
    learnerId: string;
  },
): void {
  if (
    session.id !== expected.id ||
    session.kind !== LIVECOURSE_ACTION_KIND ||
    session.stageId !== expected.stageId ||
    session.learnerKey !== expected.learnerId
  ) {
    throw new Error(`Teaching action session ${JSON.stringify(session.id)} has invalid identity`);
  }
}

function assertSessionActive(session: RuntimeSession): void {
  if (session.status !== 'active') {
    throw new TeachingActionSessionNotActiveError(session.id, session.status);
  }
}

export class RuntimeTeachingActionRepository implements TeachingActionRepository {
  readonly #store: RuntimeStore;
  readonly #stageId: string;
  readonly #learnerId: string;
  readonly #courseId: string;
  readonly #lessonId: string;
  readonly #sessionId: string;
  readonly #now: () => string;

  constructor(options: RuntimeTeachingActionRepositoryOptions) {
    this.#store = options.store;
    this.#stageId = requireIdentifier(options.stageId, 'stageId');
    this.#learnerId = requireIdentifier(options.learnerId, 'learnerId');
    this.#courseId = requireIdentifier(options.courseId, 'courseId');
    this.#lessonId = requireIdentifier(options.lessonId, 'lessonId');
    this.#sessionId = options.replayId
      ? livecourseReplaySessionId({
          stageId: this.#stageId,
          learnerId: this.#learnerId,
          courseId: this.#courseId,
          lessonId: this.#lessonId,
          replayId: requireIdentifier(options.replayId, 'replayId'),
        })
      : livecourseActionSessionId({
          stageId: this.#stageId,
          learnerId: this.#learnerId,
          courseId: this.#courseId,
          lessonId: this.#lessonId,
        });
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async load(): Promise<TeachingActionSnapshot> {
    const session = await this.#store.getSession(this.#sessionId);
    if (!session) return foldTeachingActions([]);
    assertSessionIdentity(session, {
      id: this.#sessionId,
      stageId: this.#stageId,
      learnerId: this.#learnerId,
    });
    // A teaching/replay W is usable only while its RuntimeSession is active.
    // Reading a completed/archived session would let a newly mounted
    // classroom resurrect stale W instead of starting a fresh lifecycle.
    assertSessionActive(session);
    const records = await this.#store.listRecords(session.id);
    // Keep the boundary fail-closed if a store transition races the read.
    const current = await this.#store.getSession(this.#sessionId);
    if (!current) return foldTeachingActions([]);
    assertSessionIdentity(current, {
      id: this.#sessionId,
      stageId: this.#stageId,
      learnerId: this.#learnerId,
    });
    assertSessionActive(current);
    return this.#foldRecords(records);
  }

  async destroy(): Promise<void> {
    const session = await this.#store.getSession(this.#sessionId);
    if (!session) return;
    assertSessionIdentity(session, {
      id: this.#sessionId,
      stageId: this.#stageId,
      learnerId: this.#learnerId,
    });
    // Never delete a session outside the active W lifecycle.  In particular,
    // an archived/other-owner row must not be treated as an idempotent cleanup
    // target and silently removed.
    assertSessionActive(session);
    await this.#store.deleteSession(session.id);
  }

  async inspect(input: TeachingAction): Promise<TeachingActionInspection> {
    const candidate = this.#parseCandidate(input);
    return inspectCandidate(await this.load(), candidate);
  }

  async append(input: TeachingAction): Promise<AppendTeachingActionResult> {
    const candidate = this.#parseCandidate(input);
    const preflight = inspectCandidate(await this.load(), candidate);
    if (preflight.status === 'duplicate') {
      return {
        action: preflight.action,
        duplicate: true,
        recoveryPoint: recoveryPoint(preflight.snapshot),
      };
    }
    const session = await this.#ensureSession();

    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const records = await this.#store.listRecords(session.id);
      const snapshot = this.#foldRecords(records);
      const inspection = inspectCandidate(snapshot, candidate);
      if (inspection.status === 'duplicate') {
        return {
          action: inspection.action,
          duplicate: true,
          recoveryPoint: recoveryPoint(snapshot),
        };
      }

      try {
        await this.#store.appendRecord(
          {
            id: candidate.id,
            sessionId: session.id,
            sceneId: recoveryNodeId(candidate).replace(/^node:/, ''),
            createdAt: candidate.timestamp,
            payload: candidate,
          },
          { expectedLastSeq: records.at(-1)?.seq ?? null },
        );
        const committed = foldTeachingActions([...snapshot.actions, candidate]);
        return {
          action: candidate,
          duplicate: false,
          recoveryPoint: recoveryPoint(committed),
        };
      } catch (error) {
        if (error instanceof RuntimeAppendConflictError) continue;
        throw error;
      }
    }

    throw new Error(
      `Teaching action append did not converge after ${MAX_APPEND_ATTEMPTS} compare-and-append retries`,
    );
  }

  #parseCandidate(input: TeachingAction): TeachingAction {
    const candidate = normalizeTeachingAction(input);
    if (candidate.courseId !== this.#courseId || candidate.lessonId !== this.#lessonId) {
      throw new Error('Teaching action does not belong to this repository partition');
    }
    return candidate;
  }

  #foldRecords(records: readonly RuntimeRecord[]): TeachingActionSnapshot {
    const actions = records.map((record) => this.#parseCandidate(record.payload as TeachingAction));
    return foldTeachingActions(actions);
  }

  async #ensureSession(): Promise<RuntimeSession> {
    const existing = await this.#store.getSession(this.#sessionId);
    if (existing) {
      assertSessionIdentity(existing, {
        id: this.#sessionId,
        stageId: this.#stageId,
        learnerId: this.#learnerId,
      });
      assertSessionActive(existing);
      return existing;
    }

    const timestamp = this.#now();
    try {
      return await this.#store.createSession({
        id: this.#sessionId,
        kind: LIVECOURSE_ACTION_KIND,
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
      assertSessionActive(winner);
      return winner;
    }
  }
}

export function createTeachingActionRepository(
  options: RuntimeTeachingActionRepositoryOptions,
): TeachingActionRepository {
  return new RuntimeTeachingActionRepository(options);
}

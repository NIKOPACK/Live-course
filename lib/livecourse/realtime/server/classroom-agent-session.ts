/**
 * LiveCourse — ClassroomAgentSession: the single server-owned trust binding
 * for one classroom's realtime teacher Agent, assistant roster, location,
 * task allowlists and confirmation authority (P-007, R-012).
 *
 * The session record contains ONLY stable identifiers and allowlists:
 *
 *   {
 *     sessionId, courseId, lessonId, stageId, learnerId,
 *     realtimeTeacherAgentId,
 *     assistantRoster: [{ assistantAgentId, allowedTaskKinds, allowedTools }],
 *     expiresAt,
 *   }
 *
 * It never stores provider keys, raw media, full lesson materials or content
 * derived from learner input. Companion runtime state (current location, the
 * server-derived CoursePlan, the AssistantTaskService snapshot, evidence and
 * adjustments) lives in a separate store and is rebuilt from the session, so
 * request bodies, URL, headers, localStorage and general browser state can
 * never declare or elevate teacher/assistant identity, classroom scope, task
 * permissions or confirmation authority.
 *
 * Trust posture (fail closed):
 *   - absent/expired/forged session → SESSION_* errors
 *   - forged teacher/assistant/header fields → structurally impossible (the
 *     teacher id, roster and allowlists come from the session, never from the
 *     request)
 *   - course/lesson/node/scene mismatch → scope errors against the
 *     server-derived CoursePlan lesson scope
 *   - unknown assistant / kind / tool → roster + capability errors
 *   - repeated idempotency key → gateway 409
 *   - confirmation before a task succeeds → 409, never a command
 *   - failed/cancelled tasks → terminal, never success
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

import {
  assistantTaskKindSchema,
  identifierSchema,
  projectGoalState,
  teachingAdjustmentSchema,
  type AssistantTask,
  type AssistantTaskKind,
  type CoursePlan,
  type EvidenceRecord,
  type GoalState,
  type TeachingAdjustment,
} from '@/lib/livecourse/domain';
import { AssistantTaskService } from '@/lib/livecourse/domain/assistant-task';
import {
  approveCourseAdjustment,
  rejectCourseAdjustment,
} from '@/lib/livecourse/domain/teaching-adjustment';
import {
  ASSISTANT_TASK_CAPABILITIES,
  AssistantTaskConfirmation,
  AssistantTaskConfirmationError,
  AssistantTaskRunner,
  type AssistantCapability,
  type ConstrainedAssistantExecutor,
} from '@/lib/livecourse/realtime/assistant-task-runner';
import {
  AssistantTaskGateway,
  type AssistantRoster,
} from '@/lib/livecourse/realtime/server/assistant-task-gateway';
import type {
  RealtimeTeachingCommand,
  RealtimeToolRequest,
} from '@/lib/livecourse/realtime/contracts';
import {
  buildCourseStateSnapshot,
  recoverCourseState,
  type CourseStateSnapshot,
  type RecoverCourseStateOptions,
} from '@/lib/livecourse/session/course-state-snapshot';

// ---------------------------------------------------------------------------
// Constants and schema
// ---------------------------------------------------------------------------

export const CLASSROOM_AGENT_SESSION_SCHEMA_VERSION = 1 as const;
export const CLASSROOM_AGENT_SESSION_COOKIE = 'lc-agent-session';
export const DEFAULT_CLASSROOM_AGENT_SESSION_TTL_MS = 30 * 60 * 1000;
export const MAX_AGENT_SESSION_TOKEN_LENGTH = 128;

export const ASSISTANT_CAPABILITY_NAMES = [
  'read_source_reference',
  'read_lesson_reference',
  'draft_classroom_note',
] as const;

const assistantRosterEntrySchema = z
  .object({
    assistantAgentId: z.string().trim().min(1).max(64),
    allowedTaskKinds: z.array(assistantTaskKindSchema),
    allowedTools: z.array(z.enum(ASSISTANT_CAPABILITY_NAMES)),
  })
  .strict();

export const classroomAgentSessionSchema = z
  .object({
    schemaVersion: z.literal(CLASSROOM_AGENT_SESSION_SCHEMA_VERSION),
    sessionId: z.string().trim().min(1).max(MAX_AGENT_SESSION_TOKEN_LENGTH),
    courseId: identifierSchema,
    lessonId: identifierSchema,
    stageId: identifierSchema,
    learnerId: identifierSchema,
    realtimeTeacherAgentId: z.string().trim().min(1).max(64),
    assistantRoster: z.array(assistantRosterEntrySchema),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ClassroomAgentRosterEntry = z.infer<typeof assistantRosterEntrySchema>;
export type ClassroomAgentSessionRecord = z.infer<typeof classroomAgentSessionSchema>;

/** The teacher and assistant roster the server owns for one classroom. */
export interface ClassroomAgents {
  realtimeTeacherAgentId: string;
  assistantRoster: readonly ClassroomAgentRosterEntry[];
}

export interface ClassroomAgentLocation {
  nodeId: string;
  sceneId: string;
}

/**
 * Server-owned runtime companion state. It is rebuilt from the session and
 * never accepted from the browser.
 */
export interface ClassroomAgentSessionState {
  location: ClassroomAgentLocation;
  coursePlan: CoursePlan;
  /** The live task lifecycle authority for the session's course scope. */
  tasks: AssistantTaskService;
  evidence: EvidenceRecord[];
  adjustments: TeachingAdjustment[];
}

export interface ClassroomAgentSessionEntry {
  session: ClassroomAgentSessionRecord;
  state: ClassroomAgentSessionState;
}

export interface ClassroomAgentSessionStore {
  create(session: ClassroomAgentSessionRecord, state: ClassroomAgentSessionState): void;
  update(session: ClassroomAgentSessionRecord, state: ClassroomAgentSessionState): void;
  get(sessionId: string): ClassroomAgentSessionEntry | undefined;
  delete(sessionId: string): void;
  /** One current session per classroom stage + learner partition (reload recovery). */
  binding(stageId: string, learnerId: string): string | undefined;
  setBinding(stageId: string, learnerId: string, sessionId: string): void;
  list(): readonly ClassroomAgentSessionEntry[];
}

// ---------------------------------------------------------------------------
// Typed failure surface
// ---------------------------------------------------------------------------

export class ClassroomAgentSessionError extends Error {
  override readonly name = 'ClassroomAgentSessionError';
  constructor(
    readonly code: string,
    message: string,
    readonly status = 401,
  ) {
    super(message);
  }
}

/**
 * Resolve the one lesson represented by a classroom route.  A route carries a
 * stage identity, not a course identity; selecting by array position would
 * silently bind a session to another lesson when a course contains several
 * stages.  The resolver is deliberately strict so missing or ambiguous
 * mappings cannot create a partially scoped session.
 */
export function selectUniqueLessonForStage(
  coursePlan: CoursePlan,
  stageId: string,
): CoursePlan['lessons'][number] {
  const matches = coursePlan.lessons.filter((lesson) => lesson.stageId === stageId);
  if (matches.length === 0) {
    throw new ClassroomAgentSessionError(
      'CLASSROOM_LESSON_NOT_FOUND',
      `server course plan has no lesson for classroom stage ${JSON.stringify(stageId)}`,
      500,
    );
  }
  if (matches.length > 1) {
    throw new ClassroomAgentSessionError(
      'CLASSROOM_LESSON_AMBIGUOUS',
      `server course plan has multiple lessons for classroom stage ${JSON.stringify(stageId)}`,
      500,
    );
  }
  return matches[0]!;
}

// ---------------------------------------------------------------------------
// In-memory store (acceptable for the current single-process runtime)
// ---------------------------------------------------------------------------

export class InMemoryClassroomAgentSessionStore implements ClassroomAgentSessionStore {
  readonly #sessions = new Map<string, ClassroomAgentSessionEntry>();
  readonly #bindings = new Map<string, string>();

  create(session: ClassroomAgentSessionRecord, state: ClassroomAgentSessionState): void {
    if (this.#sessions.has(session.sessionId)) {
      throw new ClassroomAgentSessionError(
        'SESSION_ID_COLLISION',
        'agent session id collides with an existing session',
        500,
      );
    }
    this.#sessions.set(session.sessionId, { session, state });
  }

  update(session: ClassroomAgentSessionRecord, state: ClassroomAgentSessionState): void {
    this.#sessions.set(session.sessionId, { session, state });
  }

  get(sessionId: string): ClassroomAgentSessionEntry | undefined {
    return this.#sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.#sessions.delete(sessionId);
    for (const [key, value] of this.#bindings) {
      if (value === sessionId) this.#bindings.delete(key);
    }
  }

  binding(stageId: string, learnerId: string): string | undefined {
    return this.#bindings.get(`${stageId}\u0000${learnerId}`);
  }

  setBinding(stageId: string, learnerId: string, sessionId: string): void {
    this.#bindings.set(`${stageId}\u0000${learnerId}`, sessionId);
  }

  list(): readonly ClassroomAgentSessionEntry[] {
    return Object.freeze([...this.#sessions.values()]);
  }
}

// ---------------------------------------------------------------------------
// Server-owned classroom plan and agent derivation
// ---------------------------------------------------------------------------

export interface ClassroomShapeScene {
  id: string;
  title?: string;
  order: number;
  type?: string;
}

function goalRule() {
  return {
    version: 'livecourse-quiz-mastery-v1',
    passScore: 0.7,
    minAcceptedEvidence: 1,
    minPassingEvidence: 1,
  };
}

/**
 * Derive a schema-valid single-lesson CoursePlan from the server's classroom
 * document. One classroom is one lesson (docs/spec/04 §5, 05 A7). The browser
 * never supplies this structure: only the server classroom store feeds it.
 */
export function deriveCoursePlanFromClassroomShape(input: {
  courseId: string;
  stageId: string;
  stageTitle?: string;
  scenes: readonly ClassroomShapeScene[];
  now?: string;
}): CoursePlan {
  if (input.scenes.length < 1) {
    throw new ClassroomAgentSessionError(
      'COURSE_LOOP_UNSUPPORTED',
      'the teaching loop requires a classroom with at least one lesson scene',
      400,
    );
  }
  const now = input.now ?? new Date().toISOString();
  const title = input.stageTitle?.trim() || input.courseId;
  const ordered = [...input.scenes]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((scene) => ({
      id: identifierSchema.parse(scene.id),
      title: scene.title?.trim() || `Scene ${scene.order + 1}`,
      order: scene.order,
      type: scene.type ?? 'slide',
    }));

  const quizScenes = ordered.filter((scene) => scene.type === 'quiz');
  const fallbackGoalId = `goal:${input.courseId}:lesson`;
  const goals =
    quizScenes.length > 0
      ? quizScenes.map((scene) => ({
          id: `goal:${scene.id}`,
          title: `${scene.title} 检查点`,
          description: `通过课堂节点“${scene.title}”的可审计结果判断掌握状态。`,
          rule: goalRule(),
        }))
      : [
          {
            id: fallbackGoalId,
            title: `${title} 本课学习目标`,
            description: '等待课堂检查点或教师复核证据。',
            rule: goalRule(),
          },
        ];
  const nodeFromScene = (scene: (typeof ordered)[number]) => ({
    id: `node:${scene.id}`,
    sceneId: scene.id,
    title: scene.title,
    type:
      scene.type === 'quiz'
        ? ('checkpoint' as const)
        : scene.type === 'interactive'
          ? ('interactive' as const)
          : ('instruction' as const),
    order: scene.order,
    goalIds:
      quizScenes.length > 0
        ? scene.type === 'quiz'
          ? [`goal:${scene.id}`]
          : []
        : [fallbackGoalId],
  });

  const lessons = [
    {
      id: `lesson:${input.courseId}:1`,
      stageId: input.stageId,
      title,
      order: 0,
      dependsOn: [] as string[],
      nodes: ordered.map(nodeFromScene),
    },
  ];

  return coursePlanFromParts({
    courseId: input.courseId,
    title,
    now,
    goals,
    lessons,
  });
}

interface CoursePlanParts {
  courseId: string;
  title: string;
  now: string;
  goals: { id: string; title: string; description?: string; rule: ReturnType<typeof goalRule> }[];
  lessons: {
    id: string;
    stageId: string;
    title: string;
    order: number;
    dependsOn: string[];
    nodes: {
      id: string;
      sceneId: string;
      title: string;
      type: 'checkpoint' | 'interactive' | 'instruction' | 'project';
      order: number;
      goalIds: string[];
    }[];
  }[];
}

function coursePlanFromParts(parts: CoursePlanParts): CoursePlan {
  return {
    schemaVersion: 1,
    id: `course-plan:${parts.courseId}`,
    courseId: parts.courseId,
    title: parts.title,
    version: 1,
    status: 'approved',
    createdAt: parts.now,
    updatedAt: parts.now,
    goals: parts.goals,
    lessons: parts.lessons,
    checkpointRules: [],
  };
}

export interface ResolveCoursePlan {
  /** `stageId` is the classroom route identity; `courseId` may be different. */
  (input: { courseId: string; stageId: string }): CoursePlan | Promise<CoursePlan>;
}

export interface ResolveClassroomAgents {
  (input: {
    courseId: string;
    lessonId: string;
    stageId: string;
    learnerId: string;
  }): ClassroomAgents | Promise<ClassroomAgents>;
}

/**
 * Deterministic server-owned agents for the current single-process runtime.
 * The teacher id is derived from the course scope, never from the browser.
 * Default roster is empty: the learner path has one speaker
 * (docs/spec/04-detailed-design.md §2).
 */
export function deriveClassroomAgents(input: {
  courseId: string;
  lessonId: string;
  stageId: string;
  learnerId: string;
}): ClassroomAgents {
  const digest = createHash('sha256').update(input.courseId).digest('hex').slice(0, 16);
  return {
    realtimeTeacherAgentId: `realtime-teacher:${input.courseId}:${digest}`,
    assistantRoster: [],
  };
}

// ---------------------------------------------------------------------------
// Service options and helpers
// ---------------------------------------------------------------------------

export interface ClassroomAgentSessionServiceOptions {
  store: ClassroomAgentSessionStore;
  executor: ConstrainedAssistantExecutor;
  resolveCoursePlan: ResolveCoursePlan;
  resolveClassroomAgents: ResolveClassroomAgents;
  clock?: () => string;
  ttlMs?: number;
  tokenFactory?: () => string;
}

function isExpired(expiresAt: string, now: string): boolean {
  return new Date(expiresAt).getTime() <= new Date(now).getTime();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface ClassroomAgentSessionStateView {
  sessionId: string;
  realtimeTeacherAgentId: string;
  expiresAt: string;
  roster: readonly ClassroomAgentRosterEntry[];
  location: ClassroomAgentLocation;
  coursePlan: {
    courseId: string;
    version: number;
    status: CoursePlan['status'];
    updatedAt: string;
    checkpointRules: readonly {
      id: string;
      nodeId: string;
      goalIds: readonly string[];
      required: boolean;
    }[];
    lessons: readonly {
      id: string;
      title: string;
      order: number;
      stageId: string;
      nodes: readonly {
        id: string;
        sceneId: string;
        title: string;
        order: number;
        type: string;
        goalIds: readonly string[];
      }[];
    }[];
  };
  lessonId: string;
  tasks: readonly AssistantTask[];
  evidence: readonly EvidenceRecord[];
  goalStates: readonly GoalState[];
  adjustments: readonly TeachingAdjustment[];
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class ClassroomAgentSessionService {
  readonly #store: ClassroomAgentSessionStore;
  readonly #options: Required<
    Pick<ClassroomAgentSessionServiceOptions, 'clock' | 'ttlMs' | 'tokenFactory'>
  > &
    Pick<
      ClassroomAgentSessionServiceOptions,
      'executor' | 'resolveCoursePlan' | 'resolveClassroomAgents'
    >;

  constructor(options: ClassroomAgentSessionServiceOptions) {
    this.#store = options.store;
    this.#options = {
      clock: options.clock ?? (() => new Date().toISOString()),
      ttlMs: options.ttlMs ?? DEFAULT_CLASSROOM_AGENT_SESSION_TTL_MS,
      tokenFactory: options.tokenFactory ?? (() => `session:${randomBytes(24).toString('hex')}`),
      executor: options.executor,
      resolveCoursePlan: options.resolveCoursePlan,
      resolveClassroomAgents: options.resolveClassroomAgents,
    };
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /**
   * Establish (or restore) the session for one classroom + learner. The
   * browser supplies only the classroom lookup id and its own learner
   * partition key; the plan, teacher id, roster and allowlists are derived
   * server-side. A reload restores the same session state (tasks, evidence,
   * adjustments, plan version) so recovery keeps equivalent semantics.
   */
  async establish(input: {
    classroomId: string;
    learnerId: string;
    resumeToken?: string | null;
  }): Promise<{
    token: string;
    session: ClassroomAgentSessionRecord;
    restored: boolean;
  }> {
    // The public field retains its API name for compatibility, but its value
    // is the classroom route's stage identity throughout this service.
    const stageId = requireIdentifier(input.classroomId, 'classroomId');
    const learnerId = requireIdentifier(input.learnerId, 'learnerId');

    const existingId = this.#store.binding(stageId, learnerId);
    if (existingId) {
      const existing = this.#store.get(existingId);
      if (existing && !isExpired(existing.session.expiresAt, this.#options.clock())) {
        if (input.resumeToken !== existing.session.sessionId) {
          throw new ClassroomAgentSessionError(
            'SESSION_RESUME_REQUIRED',
            'an existing classroom session can only be resumed with its opaque session token',
            403,
          );
        }
        const refreshed: ClassroomAgentSessionRecord = {
          ...existing.session,
          expiresAt: this.#expiry(),
        };
        this.#store.update(refreshed, existing.state);
        return { token: refreshed.sessionId, session: refreshed, restored: true };
      }
    }

    const coursePlan = await this.#options.resolveCoursePlan({
      courseId: stageId,
      stageId,
    });
    const lesson = selectUniqueLessonForStage(coursePlan, stageId);
    const agents = await this.#options.resolveClassroomAgents({
      courseId: coursePlan.courseId,
      lessonId: lesson.id,
      stageId: lesson.stageId,
      learnerId,
    });
    const session = classroomAgentSessionSchema.parse({
      schemaVersion: CLASSROOM_AGENT_SESSION_SCHEMA_VERSION,
      sessionId: this.#options.tokenFactory(),
      courseId: coursePlan.courseId,
      lessonId: lesson.id,
      stageId: lesson.stageId,
      learnerId,
      realtimeTeacherAgentId: agents.realtimeTeacherAgentId,
      assistantRoster: agents.assistantRoster.map((entry) => clone(entry)),
      expiresAt: this.#expiry(),
    });
    const state: ClassroomAgentSessionState = {
      location: {
        nodeId: lesson.nodes[0].id,
        sceneId: lesson.nodes[0].sceneId,
      },
      coursePlan,
      tasks: new AssistantTaskService({ now: this.#options.clock }),
      evidence: [],
      adjustments: [],
    };
    this.#store.create(session, state);
    this.#store.setBinding(stageId, learnerId, session.sessionId);
    return { token: session.sessionId, session, restored: false };
  }

  resolveToken(token: string): ClassroomAgentSessionEntry {
    const normalized = token?.trim();
    if (!normalized || normalized.length > MAX_AGENT_SESSION_TOKEN_LENGTH) {
      throw new ClassroomAgentSessionError('SESSION_INVALID', 'agent session token is invalid');
    }
    const entry = this.#store.get(normalized);
    if (!entry) {
      throw new ClassroomAgentSessionError(
        'SESSION_MISSING',
        'classroom agent session does not exist',
      );
    }
    if (isExpired(entry.session.expiresAt, this.#options.clock())) {
      throw new ClassroomAgentSessionError(
        'SESSION_EXPIRED',
        'classroom agent session has expired',
      );
    }
    return entry;
  }

  revoke(token: string): void {
    const { session } = this.resolveToken(token);
    this.#store.delete(session.sessionId);
  }

  // -------------------------------------------------------------------------
  // Location
  // -------------------------------------------------------------------------

  updateLocation(
    token: string,
    input: { nodeId: string; sceneId: string },
  ): ClassroomAgentSessionStateView {
    const entry = this.resolveToken(token);
    const nodeId = requireIdentifier(input.nodeId, 'nodeId');
    const sceneId = requireIdentifier(input.sceneId, 'sceneId');
    this.#validateNodeScene(entry.session, entry.state, nodeId, sceneId);
    entry.state.location = { nodeId, sceneId };
    this.#store.update(entry.session, entry.state);
    return this.#view(entry.session, entry.state);
  }

  // -------------------------------------------------------------------------
  // Assistant delegation (panel + realtime tool route share this core)
  // -------------------------------------------------------------------------

  delegate(
    token: string,
    input: {
      assistantId: string;
      kind: string;
      inputRefs: readonly string[];
      callId: string;
      nodeId?: string;
      sceneId?: string;
    },
  ): AssistantTask {
    const entry = this.resolveToken(token);
    const { session, state } = entry;
    const kind = parseKind(input.kind);
    const callId = requireIdentifier(input.callId, 'callId', 230);
    const assistantId = input.assistantId?.trim();
    if (!assistantId || assistantId.length > 64) {
      throw new ClassroomAgentSessionError('ASSISTANT_ID_INVALID', 'assistant id is invalid', 400);
    }
    const nodeId = input.nodeId?.trim() || state.location.nodeId;
    const sceneId = input.sceneId?.trim() || state.location.sceneId;
    const node = this.#validateNodeScene(session, state, nodeId, sceneId);
    state.location = { nodeId: node.id, sceneId: node.sceneId };

    this.#assertAssistantAllowed(session, assistantId, kind);
    const gateway = this.#gateway(session, state);
    const task = gateway.delegate({
      courseId: session.courseId,
      lessonId: session.lessonId,
      nodeId: node.id,
      sceneId: node.sceneId,
      callId,
      assistantId,
      kind,
      inputRefs: [...input.inputRefs],
      delegatedBy: session.realtimeTeacherAgentId,
    });
    this.#scheduleRun(session, state);
    this.#store.update(session, state);
    return task;
  }

  /** Realtime tool route entry: validates the full request scope against the session. */
  delegateTool(token: string, request: RealtimeToolRequest): AssistantTask {
    if (request.tool.name !== 'delegate_assistant_task') {
      throw new ClassroomAgentSessionError(
        'NOT_DELEGATION_TOOL',
        'session delegation only accepts delegate_assistant_task',
        400,
      );
    }
    const entry = this.resolveToken(token);
    if (request.courseId !== entry.session.courseId) {
      throw new ClassroomAgentSessionError(
        'CLASSROOM_COURSE_MISMATCH',
        'request course does not match the agent session',
        403,
      );
    }
    if (request.lessonId !== entry.session.lessonId) {
      throw new ClassroomAgentSessionError(
        'CLASSROOM_LESSON_MISMATCH',
        'request lesson does not match the agent session',
        403,
      );
    }
    return this.delegate(token, {
      assistantId: request.tool.arguments.assistantId,
      kind: request.tool.arguments.kind,
      inputRefs: request.tool.arguments.inputRefs,
      callId: request.callId,
      nodeId: request.nodeId,
      sceneId: request.sceneId,
    });
  }

  cancelTask(token: string, taskId: string, reason: string): AssistantTask {
    const entry = this.resolveToken(token);
    const { session, state } = entry;
    const runner = this.#runner(session, state);
    try {
      const task = runner.cancel(taskId, reason);
      this.#store.update(session, state);
      return task;
    } catch (error) {
      throw this.#mapTaskStateError(error, 'TASK_CANCEL_NOT_ALLOWED');
    }
  }

  // -------------------------------------------------------------------------
  // Teacher confirmation (server-authoritative)
  // -------------------------------------------------------------------------

  confirmTask(
    token: string,
    taskId: string,
  ): { task: AssistantTask; command: RealtimeTeachingCommand } {
    const entry = this.resolveToken(token);
    const { session, state } = entry;
    const service = state.tasks;
    let task: AssistantTask;
    try {
      task = service.get(taskId);
    } catch (error) {
      throw this.#mapTaskStateError(error, 'TASK_NOT_FOUND', 404);
    }
    if (task.status !== 'succeeded' || !task.result) {
      throw new ClassroomAgentSessionError(
        'CONFIRMATION_NOT_ALLOWED',
        'only a succeeded task with a proposal can be confirmed',
        409,
      );
    }
    const confirmation = new AssistantTaskConfirmation(service, {
      now: this.#options.clock,
      authorize: (candidate, confirmedBy) => confirmedBy === session.realtimeTeacherAgentId,
    });
    let result: { task: AssistantTask; command: RealtimeTeachingCommand };
    try {
      result = confirmation.confirm(taskId, session.realtimeTeacherAgentId);
    } catch (error) {
      if (error instanceof AssistantTaskConfirmationError) {
        throw new ClassroomAgentSessionError(
          'CONFIRMATION_NOT_ALLOWED',
          error.message,
          error.message.includes('not authorized') ? 403 : 409,
        );
      }
      throw error;
    }
    this.#store.update(session, state);
    return result;
  }

  markTaskApplied(token: string, taskId: string, commandIdempotencyKey: string): AssistantTask {
    const entry = this.resolveToken(token);
    const { session, state } = entry;
    const confirmation = new AssistantTaskConfirmation(state.tasks, {
      now: this.#options.clock,
      authorize: (candidate, confirmedBy) => confirmedBy === session.realtimeTeacherAgentId,
    });
    try {
      const task = confirmation.markApplied(
        taskId,
        session.realtimeTeacherAgentId,
        requireIdentifier(commandIdempotencyKey, 'commandIdempotencyKey'),
      );
      this.#store.update(session, state);
      return task;
    } catch (error) {
      if (error instanceof AssistantTaskConfirmationError) {
        throw new ClassroomAgentSessionError('APPLICATION_NOT_ALLOWED', error.message, 409);
      }
      throw this.#mapTaskStateError(error, 'APPLICATION_NOT_ALLOWED');
    }
  }

  // -------------------------------------------------------------------------
  // Course loop: evidence, adjustments, approval
  // -------------------------------------------------------------------------

  decideAdjustment(
    token: string,
    adjustmentId: string,
    decision: 'approve' | 'reject',
  ): ClassroomAgentSessionStateView {
    const entry = this.resolveToken(token);
    const { session, state } = entry;
    const adjustment = state.adjustments.find((item) => item.id === adjustmentId);
    if (!adjustment) {
      throw new ClassroomAgentSessionError('ADJUSTMENT_NOT_FOUND', 'adjustment was not found', 404);
    }
    if (adjustment.approvalStatus !== 'pending') {
      throw new ClassroomAgentSessionError(
        'ADJUSTMENT_NOT_PENDING',
        'adjustment is no longer pending',
        409,
      );
    }
    const decidedBy = session.realtimeTeacherAgentId;
    if (decision === 'reject') {
      const record = rejectCourseAdjustment({
        adjustment,
        decidedBy,
        now: this.#options.clock,
      });
      state.adjustments = replaceAdjustment(state.adjustments, record);
    } else {
      const nextPlan = approveCourseAdjustment({
        adjustment,
        coursePlan: state.coursePlan,
        decidedBy,
        now: this.#options.clock,
      });
      const record = teachingAdjustmentSchema.parse({
        ...adjustment,
        approvalStatus: 'approved',
        decidedAt: this.#options.clock(),
        decidedBy,
      });
      state.coursePlan = nextPlan;
      state.adjustments = replaceAdjustment(state.adjustments, record);
      // One classroom is one lesson (docs/spec/04 §5). Approval may add a
      // checkpoint on the current lesson; it must not switch the session to
      // another lesson or rewrite stage identity.
    }
    this.#store.update(session, state);
    return this.#view(session, state);
  }

  // -------------------------------------------------------------------------
  // State / persistence boundary
  // -------------------------------------------------------------------------

  async stateView(token: string): Promise<ClassroomAgentSessionStateView> {
    const entry = this.resolveToken(token);
    await this.#runQueued(entry.session, entry.state);
    this.#store.update(entry.session, entry.state);
    return this.#view(entry.session, entry.state);
  }

  /**
   * The persistence boundary: serialize the session state into the existing
   * CourseStateSnapshot contract. `recoverStateFromSnapshot` rebuilds it
   * through the existing recovery path, so browser and PostgreSQL readers
   * share one schema-validated shape.
   */
  snapshotForSession(
    session: ClassroomAgentSessionRecord,
    state: ClassroomAgentSessionState,
  ): CourseStateSnapshot {
    return buildCourseStateSnapshot({
      idempotencyKey: `agent-session:${session.sessionId}:v${state.coursePlan.version}`,
      stageId: session.stageId,
      learnerId: session.learnerId,
      courseId: session.courseId,
      lessonId: session.lessonId,
      coursePlan: state.coursePlan,
      teachingActions: { actions: [], currentNodeId: null, lastSequence: -1 },
      assistantTasks: state.tasks.snapshot(),
      evidence: state.evidence,
      adjustments: state.adjustments,
    });
  }

  /**
   * Rebuild the runtime state from the persistence boundary. The session
   * record itself (teacher id, roster) is never taken from a snapshot: it is
   * always derived server-side on establishment.
   */
  recoverStateFromSnapshot(
    snapshot: CourseStateSnapshot,
    options: RecoverCourseStateOptions = {},
  ): {
    sessionFields: { courseId: string; lessonId: string; stageId: string; learnerId: string };
    state: ClassroomAgentSessionState;
  } {
    // Fail closed on an incoherent or missing recovered lesson: never fall
    // back to the first node of the whole course or to empty identifiers.
    const lessonId = snapshot.lessonId?.trim();
    const lesson = snapshot.coursePlan?.lessons?.find((candidate) => candidate.id === lessonId);
    if (!lessonId || !lesson) {
      throw new ClassroomAgentSessionError(
        'RECOVERY_LESSON_INCOHERENT',
        'recovered lesson is missing or not part of the recovered course plan',
        409,
      );
    }
    const recovery = recoverCourseState(snapshot, options);
    const firstNode = [...lesson.nodes].sort(
      (left, right) => left.order - right.order || left.id.localeCompare(right.id),
    )[0];
    if (!firstNode) {
      throw new ClassroomAgentSessionError(
        'RECOVERY_LESSON_INCOHERENT',
        'recovered lesson has no valid node to restore location into',
        409,
      );
    }
    return {
      // lesson/stage/location all describe the same selected lesson.
      sessionFields: {
        courseId: recovery.coursePlan.courseId,
        lessonId: lesson.id,
        stageId: lesson.stageId,
        learnerId: snapshot.learnerId,
      },
      state: {
        location: { nodeId: firstNode.id, sceneId: firstNode.sceneId },
        coursePlan: recovery.coursePlan,
        tasks: recovery.assistantTasks,
        evidence: [...recovery.evidence],
        adjustments: [...recovery.adjustments],
      },
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #expiry(): string {
    const now = this.#options.clock();
    return new Date(new Date(now).getTime() + this.#options.ttlMs).toISOString();
  }

  #validateNodeScene(
    session: ClassroomAgentSessionRecord,
    state: ClassroomAgentSessionState,
    nodeId: string,
    sceneId: string,
  ): { id: string; sceneId: string } {
    const lesson = state.coursePlan.lessons.find((candidate) => candidate.id === session.lessonId);
    if (!lesson) {
      throw new ClassroomAgentSessionError(
        'CLASSROOM_LESSON_MISMATCH',
        'session lesson is not part of the server course plan',
        403,
      );
    }
    const node = lesson.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      throw new ClassroomAgentSessionError(
        'CLASSROOM_NODE_MISMATCH',
        'node is not part of the session lesson scope',
        403,
      );
    }
    if (node.sceneId !== sceneId) {
      throw new ClassroomAgentSessionError(
        'CLASSROOM_SCENE_MISMATCH',
        'scene does not match the session lesson node',
        403,
      );
    }
    return node;
  }

  #assertAssistantAllowed(
    session: ClassroomAgentSessionRecord,
    assistantId: string,
    kind: AssistantTaskKind,
  ): void {
    const entry = session.assistantRoster.find(
      (candidate) => candidate.assistantAgentId === assistantId,
    );
    if (!entry) {
      throw new ClassroomAgentSessionError(
        'ASSISTANT_NOT_ROSTERED',
        'assistant is not rostered for this classroom',
        403,
      );
    }
    if (!entry.allowedTaskKinds.includes(kind)) {
      throw new ClassroomAgentSessionError(
        'ASSISTANT_KIND_NOT_ALLOWED',
        'assistant is not allowed to perform this task kind',
        403,
      );
    }
    const capability = ASSISTANT_TASK_CAPABILITIES[kind];
    if (!entry.allowedTools.includes(capability as AssistantCapability)) {
      throw new ClassroomAgentSessionError(
        'ASSISTANT_TOOL_NOT_ALLOWED',
        'assistant tools do not cover this task kind',
        403,
      );
    }
  }

  #gateway(
    session: ClassroomAgentSessionRecord,
    state: ClassroomAgentSessionState,
  ): AssistantTaskGateway {
    const roster: AssistantRoster = {
      getAssistant: (assistantId) => {
        const entry = session.assistantRoster.find(
          (candidate) => candidate.assistantAgentId === assistantId,
        );
        if (!entry) return null;
        return { id: entry.assistantAgentId, kinds: [...entry.allowedTaskKinds] };
      },
    };
    return new AssistantTaskGateway({
      taskService: state.tasks,
      getActiveClassroom: () => ({
        courseId: session.courseId,
        lessonId: session.lessonId,
        nodeId: state.location.nodeId,
        sceneId: state.location.sceneId,
        active: true,
        teacherId: session.realtimeTeacherAgentId,
      }),
      roster,
    });
  }

  #runner(
    session: ClassroomAgentSessionRecord,
    state: ClassroomAgentSessionState,
  ): AssistantTaskRunner {
    return new AssistantTaskRunner({
      service: state.tasks,
      executor: this.#options.executor,
      getAllowedKinds: (assistantId) => {
        const entry = session.assistantRoster.find(
          (candidate) => candidate.assistantAgentId === assistantId,
        );
        return entry ? [...entry.allowedTaskKinds] : [];
      },
    });
  }

  #scheduleRun(session: ClassroomAgentSessionRecord, state: ClassroomAgentSessionState): void {
    setTimeout(() => {
      void this.#runQueued(session, state).then(() => this.#store.update(session, state));
    }, 0);
  }

  async #runQueued(
    session: ClassroomAgentSessionRecord,
    state: ClassroomAgentSessionState,
  ): Promise<void> {
    const runner = this.#runner(session, state);
    const queued = state.tasks.list().filter((task) => task.status === 'queued');
    await Promise.allSettled(queued.map((task) => runner.run(task.id)));
  }

  #view(
    session: ClassroomAgentSessionRecord,
    state: ClassroomAgentSessionState,
  ): ClassroomAgentSessionStateView {
    const goalStates = state.coursePlan.goals.map((goal) =>
      projectGoalState({
        courseId: session.courseId,
        learnerId: session.learnerId,
        goalId: goal.id,
        rule: goal.rule,
        evidence: state.evidence,
      }),
    );
    return {
      sessionId: session.sessionId,
      realtimeTeacherAgentId: session.realtimeTeacherAgentId,
      expiresAt: session.expiresAt,
      roster: session.assistantRoster.map((entry) => clone(entry)),
      location: { ...state.location },
      coursePlan: {
        courseId: state.coursePlan.courseId,
        version: state.coursePlan.version,
        status: state.coursePlan.status,
        updatedAt: state.coursePlan.updatedAt,
        checkpointRules: state.coursePlan.checkpointRules.map((rule) => ({
          id: rule.id,
          nodeId: rule.nodeId,
          goalIds: [...rule.goalIds],
          required: rule.required,
        })),
        lessons: state.coursePlan.lessons.map((lesson) => ({
          id: lesson.id,
          title: lesson.title,
          order: lesson.order,
          stageId: lesson.stageId,
          nodes: lesson.nodes.map((node) => ({
            id: node.id,
            sceneId: node.sceneId,
            title: node.title,
            order: node.order,
            type: node.type,
            goalIds: [...node.goalIds],
          })),
        })),
      },
      lessonId: session.lessonId,
      tasks: state.tasks.list(),
      evidence: state.evidence.map(clone),
      goalStates: goalStates.map(clone),
      adjustments: state.adjustments.map(clone),
    };
  }

  #mapTaskStateError(error: unknown, code: string, status = 409): never {
    if (error instanceof ClassroomAgentSessionError) throw error;
    throw new ClassroomAgentSessionError(
      code,
      error instanceof Error ? error.message : String(error),
      status,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireIdentifier(value: string, label: string, max = 240): string {
  const normalized = value?.trim();
  const parsed = identifierSchema.max(max).safeParse(normalized);
  if (!parsed.success) {
    throw new ClassroomAgentSessionError(
      'INVALID_IDENTIFIER',
      `${label} must be a non-empty identifier of at most ${max} characters`,
      400,
    );
  }
  return parsed.data;
}

function parseKind(value: string): AssistantTaskKind {
  const parsed = assistantTaskKindSchema.safeParse(value);
  if (!parsed.success) {
    throw new ClassroomAgentSessionError('UNKNOWN_TASK_KIND', 'task kind is not recognized', 400);
  }
  return parsed.data;
}

function replaceAdjustment(
  adjustments: TeachingAdjustment[],
  next: TeachingAdjustment,
): TeachingAdjustment[] {
  return adjustments.map((item) => (item.id === next.id ? next : item));
}

/** Serialize the session cookie (opaque token, httpOnly, same-site). */
export function agentSessionCookieHeader(
  token: string,
  expiresAt: string,
  options: { secure?: boolean } = {},
): string {
  const secure = options.secure ?? process.env.NODE_ENV === 'production';
  return [
    `${CLASSROOM_AGENT_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function expiredAgentSessionCookieHeader(options: { secure?: boolean } = {}): string {
  const secure = options.secure ?? process.env.NODE_ENV === 'production';
  return [
    `${CLASSROOM_AGENT_SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** Read the opaque session token from the request cookie header. */
export function readAgentSessionToken(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== CLASSROOM_AGENT_SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    if (!value) return null;
    try {
      const decoded = decodeURIComponent(value);
      if (!decoded || decoded.length > MAX_AGENT_SESSION_TOKEN_LENGTH) return null;
      return decoded;
    } catch {
      return null;
    }
  }
  return null;
}

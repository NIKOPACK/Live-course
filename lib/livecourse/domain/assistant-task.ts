import { z } from 'zod';

import { identifierSchema, jsonValueSchema, timestampSchema } from './schemas';

export const ASSISTANT_TASK_SCHEMA_VERSION = 1 as const;

/**
 * The only task kinds that can be delegated by the realtime teacher.  Keep
 * this list deliberately small: adding a kind also requires adding its
 * capability and proposal/confirmation mapping below.
 */
export const ASSISTANT_TASK_KINDS = [
  'summarize_source',
  'draft_feedback',
  'draft_board_note',
  'suggest_next_step',
] as const;

export type AssistantTaskKind = (typeof ASSISTANT_TASK_KINDS)[number];
export const assistantTaskKindSchema = z.enum(ASSISTANT_TASK_KINDS);

export const assistantTaskInputRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) => !/[\s\r\n]/.test(value),
    'Input references must be bounded references, not free text',
  );

/** A proposal is data, not a classroom command or an executable tool call. */
export const assistantTaskProposalSchema = z
  .object({
    kind: assistantTaskKindSchema,
    summary: z.string().trim().min(1).max(2_000),
    sourceId: identifierSchema.optional(),
    targetNodeId: identifierSchema.optional(),
    content: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.kind === 'summarize_source' && !proposal.sourceId) {
      context.addIssue({
        code: 'custom',
        message: 'Source summaries require sourceId',
        path: ['sourceId'],
      });
    }
    if (proposal.kind === 'draft_feedback' && !proposal.content) {
      context.addIssue({
        code: 'custom',
        message: 'Feedback drafts require content',
        path: ['content'],
      });
    }
    if (proposal.kind === 'draft_board_note' && !proposal.content) {
      context.addIssue({
        code: 'custom',
        message: 'Board notes require content',
        path: ['content'],
      });
    }
    if (proposal.kind === 'suggest_next_step' && !proposal.targetNodeId) {
      context.addIssue({
        code: 'custom',
        message: 'Next-step proposals require targetNodeId',
        path: ['targetNodeId'],
      });
    }
    if (
      (proposal.kind === 'summarize_source' && (proposal.content || proposal.targetNodeId)) ||
      (proposal.kind === 'draft_board_note' && proposal.sourceId) ||
      (proposal.kind === 'suggest_next_step' && (proposal.sourceId || proposal.content))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Proposal fields are not permitted for this task kind',
      });
    }
  });

export type AssistantTaskProposal = z.infer<typeof assistantTaskProposalSchema>;

export const assistantTaskConfirmationSchema = z
  .object({
    confirmedBy: identifierSchema,
    confirmedAt: timestampSchema,
    commandIdempotencyKey: identifierSchema,
    applicationStatus: z.enum(['pending', 'applied']),
    appliedAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((confirmation, context) => {
    if (confirmation.applicationStatus === 'applied' && !confirmation.appliedAt) {
      context.addIssue({
        code: 'custom',
        message: 'Applied confirmations require appliedAt',
        path: ['appliedAt'],
      });
    }
    if (confirmation.applicationStatus === 'pending' && confirmation.appliedAt) {
      context.addIssue({
        code: 'custom',
        message: 'Pending confirmations cannot carry appliedAt',
        path: ['appliedAt'],
      });
    }
  });

export type AssistantTaskConfirmation = z.infer<typeof assistantTaskConfirmationSchema>;

export const assistantTaskSchema = z
  .object({
    schemaVersion: z.literal(ASSISTANT_TASK_SCHEMA_VERSION),
    id: identifierSchema,
    courseId: identifierSchema,
    lessonId: identifierSchema,
    nodeId: identifierSchema,
    sceneId: identifierSchema,
    version: z.number().int().positive(),
    kind: assistantTaskKindSchema,
    delegatedBy: identifierSchema,
    assistantId: z.string().trim().min(1).max(64),
    inputRefs: z.array(assistantTaskInputRefSchema).max(8),
    idempotencyKey: identifierSchema,
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    result: assistantTaskProposalSchema.optional(),
    failureReason: z.string().trim().min(1).max(240).optional(),
    cancellationReason: z.string().trim().min(1).max(240).optional(),
    confirmation: assistantTaskConfirmationSchema.optional(),
  })
  .strict()
  .superRefine((task, context) => {
    if (task.status === 'succeeded' && task.result === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Succeeded tasks require a result',
        path: ['result'],
      });
    }
    if (task.status !== 'succeeded' && task.result !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only succeeded tasks may carry a result',
        path: ['result'],
      });
    }
    if (task.result && task.result.kind !== task.kind) {
      context.addIssue({
        code: 'custom',
        message: 'Task result kind must match task kind',
        path: ['result', 'kind'],
      });
    }
    if (task.status === 'failed' && task.failureReason === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Failed tasks require failureReason',
        path: ['failureReason'],
      });
    }
    if (task.status !== 'failed' && task.failureReason !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only failed tasks may carry failureReason',
        path: ['failureReason'],
      });
    }
    if (task.status === 'cancelled' && task.cancellationReason === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Cancelled tasks require cancellationReason',
        path: ['cancellationReason'],
      });
    }
    if (task.status !== 'cancelled' && task.cancellationReason !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only cancelled tasks may carry cancellationReason',
        path: ['cancellationReason'],
      });
    }
    if (task.status !== 'succeeded' && task.confirmation !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only succeeded tasks may be confirmed',
        path: ['confirmation'],
      });
    }
  });

export type AssistantTask = z.infer<typeof assistantTaskSchema>;

export const assistantTaskEventSchema = z
  .object({
    schemaVersion: z.literal(ASSISTANT_TASK_SCHEMA_VERSION),
    id: identifierSchema,
    taskId: identifierSchema,
    type: z.enum([
      'created',
      'started',
      'succeeded',
      'failed',
      'cancelled',
      'requeued',
      'confirmed',
      'applied',
    ]),
    from: z.enum(['none', 'queued', 'running', 'succeeded', 'failed', 'cancelled']),
    to: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    occurredAt: timestampSchema,
    reason: z.string().trim().min(1).max(240).optional(),
  })
  .strict();

export type AssistantTaskEvent = z.infer<typeof assistantTaskEventSchema>;

export const assistantTaskSnapshotSchema = z
  .object({
    schemaVersion: z.literal(ASSISTANT_TASK_SCHEMA_VERSION),
    tasks: z.array(assistantTaskSchema),
    events: z.array(assistantTaskEventSchema),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const [index, task] of snapshot.tasks.entries()) {
      if (ids.has(task.id))
        context.addIssue({
          code: 'custom',
          message: `Duplicate task id: ${task.id}`,
          path: ['tasks', index, 'id'],
        });
      if (keys.has(task.idempotencyKey))
        context.addIssue({
          code: 'custom',
          message: `Duplicate task idempotency key: ${task.idempotencyKey}`,
          path: ['tasks', index, 'idempotencyKey'],
        });
      ids.add(task.id);
      keys.add(task.idempotencyKey);
    }
    for (const [index, event] of snapshot.events.entries()) {
      if (!ids.has(event.taskId))
        context.addIssue({
          code: 'custom',
          message: `Event references unknown task: ${event.taskId}`,
          path: ['events', index, 'taskId'],
        });
    }
  });

export type AssistantTaskSnapshot = z.infer<typeof assistantTaskSnapshotSchema>;

export class AssistantTaskIdempotencyConflictError extends Error {
  override readonly name = 'AssistantTaskIdempotencyConflictError';
  constructor(readonly idempotencyKey: string) {
    super(`Assistant task idempotency conflict for ${JSON.stringify(idempotencyKey)}`);
  }
}

/** A generated task identity was already assigned to a different request. */
export class AssistantTaskIdCollisionError extends Error {
  override readonly name = 'AssistantTaskIdCollisionError';
  constructor(readonly taskId: string) {
    super(`Assistant task id collision for ${JSON.stringify(taskId)}`);
  }
}

export class AssistantTaskNotFoundError extends Error {
  override readonly name = 'AssistantTaskNotFoundError';
  constructor(readonly taskId: string) {
    super(`Assistant task ${JSON.stringify(taskId)} was not found`);
  }
}

export class AssistantTaskStateError extends Error {
  override readonly name = 'AssistantTaskStateError';
  constructor(
    readonly taskId: string,
    readonly status: AssistantTask['status'],
    operation: string,
  ) {
    super(`Cannot ${operation} assistant task ${JSON.stringify(taskId)} in ${status} state`);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return value;
}

function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const oneLine = raw.replace(/[\r\n\t]+/g, ' ').trim();
  return (oneLine || 'assistant task execution failed').slice(0, 240);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

function sameRequest(left: AssistantTask, right: AssistantTaskCreationInput): boolean {
  return (
    canonical({
      courseId: left.courseId,
      lessonId: left.lessonId,
      nodeId: left.nodeId,
      sceneId: left.sceneId,
      kind: left.kind,
      delegatedBy: left.delegatedBy,
      assistantId: left.assistantId,
      inputRefs: left.inputRefs,
      idempotencyKey: left.idempotencyKey,
    }) ===
    canonical({
      courseId: right.courseId,
      lessonId: right.lessonId,
      nodeId: right.nodeId,
      sceneId: right.sceneId,
      kind: right.kind,
      delegatedBy: right.delegatedBy,
      assistantId: right.assistantId,
      inputRefs: right.inputRefs,
      idempotencyKey: right.idempotencyKey,
    })
  );
}

export type AssistantTaskCreationInput = Omit<
  AssistantTask,
  | 'schemaVersion'
  | 'id'
  | 'version'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
  | 'result'
  | 'failureReason'
  | 'cancellationReason'
  | 'confirmation'
> & { schemaVersion?: typeof ASSISTANT_TASK_SCHEMA_VERSION };

function deterministicTaskId(input: {
  idempotencyKey: string;
  courseId: string;
  lessonId: string;
}): string {
  // Keep the classroom scope in the identity and use a wide deterministic
  // digest that is safe in browser-shared domain code. The service still
  // checks the generated identity before storing it, so even a theoretical
  // digest collision is an explicit conflict rather than an overwrite.
  const value = `${input.courseId}\u0000${input.lessonId}\u0000${input.idempotencyKey}`;
  const seeds = [
    2166136261, 2654435761, 2246822519, 3266489917, 668265263, 374761393, 1442695041, 3628273133,
  ];
  const parts = seeds.map((seed) => {
    let hash = seed;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  });
  return `assistant-task:${parts.join('')}`;
}

export interface AssistantTaskServiceOptions {
  now?: () => string;
  idFactory?: (input: { idempotencyKey: string; courseId: string; lessonId: string }) => string;
}

/**
 * The single in-memory domain authority for task lifecycle transitions. P-004
 * can persist this serializable snapshot without changing the transition rules.
 */
export class AssistantTaskService {
  readonly #now: () => string;
  readonly #idFactory: NonNullable<AssistantTaskServiceOptions['idFactory']>;
  readonly #tasks = new Map<string, AssistantTask>();
  readonly #events: AssistantTaskEvent[] = [];

  constructor(options: AssistantTaskServiceOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? deterministicTaskId;
  }

  create(input: AssistantTaskCreationInput): AssistantTask {
    const candidate = assistantTaskSchema.parse({
      schemaVersion: ASSISTANT_TASK_SCHEMA_VERSION,
      ...input,
      id: this.#idFactory(input),
      version: 1,
      status: 'queued',
      createdAt: this.#now(),
      updatedAt: this.#now(),
    });
    const existing = [...this.#tasks.values()].find(
      (task) => task.idempotencyKey === candidate.idempotencyKey,
    );
    if (existing) {
      if (!sameRequest(existing, input))
        throw new AssistantTaskIdempotencyConflictError(candidate.idempotencyKey);
      return existing;
    }
    if (this.#tasks.has(candidate.id)) {
      throw new AssistantTaskIdCollisionError(candidate.id);
    }
    this.#tasks.set(candidate.id, freeze(clone(candidate)));
    const stored = this.#tasks.get(candidate.id)!;
    this.#record(stored, 'created', 'none', 'queued');
    return stored;
  }

  get(taskId: string): AssistantTask {
    const task = this.#tasks.get(taskId);
    if (!task) throw new AssistantTaskNotFoundError(taskId);
    return task;
  }

  list(): readonly AssistantTask[] {
    return Object.freeze([...this.#tasks.values()]);
  }

  snapshot(): AssistantTaskSnapshot {
    const snapshot = assistantTaskSnapshotSchema.parse({
      schemaVersion: ASSISTANT_TASK_SCHEMA_VERSION,
      tasks: [...this.#tasks.values()],
      events: [...this.#events],
    });
    return freeze(snapshot) as AssistantTaskSnapshot;
  }

  start(taskId: string): AssistantTask {
    const task = this.get(taskId);
    if (task.status === 'running') return task;
    if (task.status !== 'queued') throw new AssistantTaskStateError(taskId, task.status, 'start');
    return this.#transition(task, { status: 'running' }, 'started');
  }

  succeed(taskId: string, result: AssistantTaskProposal): AssistantTask {
    const task = this.get(taskId);
    if (task.status === 'succeeded') {
      if (canonical(task.result) !== canonical(result))
        throw new AssistantTaskStateError(taskId, task.status, 'replace result');
      return task;
    }
    if (task.status !== 'running')
      throw new AssistantTaskStateError(taskId, task.status, 'succeed');
    const parsed = assistantTaskProposalSchema.parse(result);
    if (parsed.kind !== task.kind)
      throw new Error(`Proposal kind ${parsed.kind} does not match task kind ${task.kind}`);
    return this.#transition(task, { status: 'succeeded', result: parsed }, 'succeeded');
  }

  fail(taskId: string, reason: unknown): AssistantTask {
    const task = this.get(taskId);
    if (task.status === 'failed') return task;
    if (task.status === 'succeeded' || task.status === 'cancelled')
      throw new AssistantTaskStateError(taskId, task.status, 'fail');
    return this.#transition(
      task,
      { status: 'failed', failureReason: safeReason(reason) },
      'failed',
      safeReason(reason),
    );
  }

  cancel(taskId: string, reason = 'classroom context closed'): AssistantTask {
    const task = this.get(taskId);
    if (task.status === 'cancelled') return task;
    if (task.status === 'succeeded' || task.status === 'failed')
      throw new AssistantTaskStateError(taskId, task.status, 'cancel');
    const safe = safeReason(reason);
    return this.#transition(
      task,
      { status: 'cancelled', cancellationReason: safe },
      'cancelled',
      safe,
    );
  }

  confirm(taskId: string, confirmation: AssistantTaskConfirmation): AssistantTask {
    const task = this.get(taskId);
    if (task.status !== 'succeeded')
      throw new AssistantTaskStateError(taskId, task.status, 'confirm');
    const parsed = assistantTaskConfirmationSchema.parse(confirmation);
    if (task.confirmation) {
      if (canonical(task.confirmation) !== canonical(parsed))
        throw new AssistantTaskStateError(taskId, task.status, 'change confirmation');
      return task;
    }
    return this.#transition(task, { confirmation: parsed }, 'confirmed', undefined, true);
  }

  markApplied(
    taskId: string,
    input: { confirmedBy: string; commandIdempotencyKey: string; appliedAt: string },
  ): AssistantTask {
    const task = this.get(taskId);
    const confirmation = task.confirmation;
    if (task.status !== 'succeeded' || !confirmation) {
      throw new AssistantTaskStateError(taskId, task.status, 'mark confirmation applied');
    }
    if (
      confirmation.confirmedBy !== input.confirmedBy ||
      confirmation.commandIdempotencyKey !== input.commandIdempotencyKey
    ) {
      throw new AssistantTaskStateError(taskId, task.status, 'change confirmation authority');
    }
    if (confirmation.applicationStatus === 'applied') return task;
    const applied = assistantTaskConfirmationSchema.parse({
      ...confirmation,
      applicationStatus: 'applied',
      appliedAt: input.appliedAt,
    });
    return this.#transition(task, { confirmation: applied }, 'applied', undefined, true);
  }

  /** Rehydrate deterministically. Running work is explicitly requeued, never dropped. */
  static fromSnapshot(
    snapshot: AssistantTaskSnapshot,
    options: AssistantTaskServiceOptions = {},
  ): AssistantTaskService {
    const parsed = assistantTaskSnapshotSchema.parse(snapshot);
    const service = new AssistantTaskService(options);
    for (const task of parsed.tasks) service.#tasks.set(task.id, freeze(clone(task)));
    service.#events.push(...parsed.events.map((event) => freeze(clone(event))));
    for (const task of [...service.#tasks.values()]) {
      if (task.status === 'queued' || task.status === 'running') {
        const requeued = service.#transition(
          task,
          { status: 'queued' },
          'requeued',
          'recovered unfinished task',
        );
        if (requeued !== task) service.#tasks.set(task.id, requeued);
      }
    }
    return service;
  }

  #transition(
    task: AssistantTask,
    patch: Partial<AssistantTask>,
    eventType: AssistantTaskEvent['type'],
    reason?: string,
    confirmationOnly = false,
  ): AssistantTask {
    const next = assistantTaskSchema.parse({
      ...task,
      ...patch,
      version: task.version + (confirmationOnly ? 0 : 1),
      updatedAt: this.#now(),
    });
    this.#tasks.set(task.id, freeze(clone(next)));
    this.#record(next, eventType, task.status, next.status, reason);
    return next;
  }

  #record(
    task: AssistantTask,
    type: AssistantTaskEvent['type'],
    from: AssistantTaskEvent['from'],
    to: AssistantTaskEvent['to'],
    reason?: string,
  ): void {
    this.#events.push(
      assistantTaskEventSchema.parse({
        schemaVersion: ASSISTANT_TASK_SCHEMA_VERSION,
        id: `${task.id}:event:${this.#events.length}`,
        taskId: task.id,
        type,
        from,
        to,
        occurredAt: task.updatedAt,
        ...(reason ? { reason } : {}),
      }),
    );
  }
}

export function recoverAssistantTaskSnapshot(
  snapshot: AssistantTaskSnapshot,
  options?: AssistantTaskServiceOptions,
): AssistantTaskService {
  return AssistantTaskService.fromSnapshot(snapshot, options);
}

// Keep this import-free JSON contract discoverable to consumers that validate
// result payloads before handing them to the service.
export const assistantTaskJsonValueSchema = jsonValueSchema;

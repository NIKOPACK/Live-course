import { createHash } from 'node:crypto';

import { ASSISTANT_TASK_CAPABILITIES } from '@/lib/livecourse/realtime/assistant-task-runner';
import {
  AssistantTaskIdCollisionError,
  AssistantTaskIdempotencyConflictError,
  AssistantTaskService,
  assistantTaskInputRefSchema,
  assistantTaskKindSchema,
  type AssistantTask,
  type AssistantTaskKind,
} from '@/lib/livecourse/domain';

export interface ActiveClassroom {
  courseId: string;
  lessonId: string;
  nodeId: string;
  sceneId: string;
  active: boolean;
  /** Optional binding when the server knows the active teacher identity. */
  teacherId?: string;
}

export interface RosteredAssistant {
  id: string;
  /** Capabilities are checked against the fixed kind-to-capability map. */
  kinds: readonly AssistantTaskKind[];
}

export interface AssistantRoster {
  getAssistant(assistantId: string): RosteredAssistant | null;
}

export interface AssistantTaskGatewayInput {
  courseId: string;
  lessonId: string;
  nodeId: string;
  sceneId: string;
  callId: string;
  assistantId: string;
  kind: AssistantTaskKind;
  inputRefs: readonly string[];
  delegatedBy: string;
}

export class AssistantTaskGatewayError extends Error {
  override readonly name = 'AssistantTaskGatewayError';
  constructor(
    readonly code: string,
    message: string,
    readonly status = 403,
  ) {
    super(message);
  }
}

export class AssistantTaskGatewayConfigurationError extends AssistantTaskGatewayError {
  constructor() {
    super('ASSISTANT_TASK_GATEWAY_NOT_CONFIGURED', 'assistant task gateway is not configured', 503);
  }
}

function requireText(value: string, label: string, max = 240): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\r\n]/.test(normalized)) {
    throw new AssistantTaskGatewayError('INVALID_ASSISTANT_TASK_INPUT', `${label} is invalid`, 400);
  }
  return normalized;
}

export interface AssistantTaskGatewayOptions {
  taskService: AssistantTaskService;
  getActiveClassroom: () => ActiveClassroom | null;
  roster: AssistantRoster;
}

/**
 * Server-side authority for realtime delegation. It has no permissive default:
 * every request must provide a live context and a roster capability.
 */
export class AssistantTaskGateway {
  readonly #taskService: AssistantTaskService;
  readonly #getActiveClassroom: () => ActiveClassroom | null;
  readonly #roster: AssistantRoster;

  constructor(options: AssistantTaskGatewayOptions) {
    this.#taskService = options.taskService;
    this.#getActiveClassroom = options.getActiveClassroom;
    this.#roster = options.roster;
  }

  delegate(input: AssistantTaskGatewayInput): AssistantTask {
    const delegatedBy = requireText(input.delegatedBy, 'delegatedBy');
    const request = {
      ...input,
      courseId: requireText(input.courseId, 'courseId'),
      lessonId: requireText(input.lessonId, 'lessonId'),
      nodeId: requireText(input.nodeId, 'nodeId'),
      sceneId: requireText(input.sceneId, 'sceneId'),
      callId: requireText(input.callId, 'callId', 230),
      assistantId: requireText(input.assistantId, 'assistantId', 64),
      kind: assistantTaskKindSchema.parse(input.kind),
      inputRefs: input.inputRefs.map((ref) => assistantTaskInputRefSchema.parse(ref)),
    };
    if (request.inputRefs.length > 8) {
      throw new AssistantTaskGatewayError(
        'INPUT_REFS_LIMIT_EXCEEDED',
        'too many input references',
        400,
      );
    }

    const active = this.#getActiveClassroom();
    if (!active || !active.active) {
      throw new AssistantTaskGatewayError(
        'ACTIVE_CLASSROOM_REQUIRED',
        'active classroom context is required',
      );
    }
    if (active.teacherId && active.teacherId !== delegatedBy) {
      throw new AssistantTaskGatewayError(
        'TEACHER_CONTEXT_MISMATCH',
        'delegator is not the active classroom teacher',
      );
    }
    if (!(request.kind in ASSISTANT_TASK_CAPABILITIES)) {
      throw new AssistantTaskGatewayError(
        'ASSISTANT_KIND_NOT_ALLOWED',
        'task kind is not allowlisted',
      );
    }
    if (
      active.courseId !== request.courseId ||
      active.lessonId !== request.lessonId ||
      active.nodeId !== request.nodeId ||
      active.sceneId !== request.sceneId
    ) {
      throw new AssistantTaskGatewayError(
        'CLASSROOM_CONTEXT_MISMATCH',
        'assistant task context does not match the active classroom',
      );
    }

    const assistant = this.#roster.getAssistant(request.assistantId);
    if (!assistant || assistant.id !== request.assistantId) {
      throw new AssistantTaskGatewayError(
        'ASSISTANT_NOT_ROSTERED',
        'assistant is not rostered for this classroom',
      );
    }
    if (!assistant.kinds.includes(request.kind)) {
      throw new AssistantTaskGatewayError(
        'ASSISTANT_KIND_NOT_ALLOWED',
        'assistant is not allowed to perform this task kind',
      );
    }

    // callId is the stable semantic key for a realtime retry. The task service
    // compares the complete request before returning an existing task.
    // A realtime call id is only stable within its classroom/course scope.
    // Including the lesson also prevents a reused call id in another lesson
    // from being treated as the same task.
    const scope = `${request.courseId}\u0000${request.lessonId}\u0000${request.callId}`;
    const idempotencyKey = `realtime:${createHash('sha256').update(scope).digest('hex')}`;
    try {
      return this.#taskService.create({
        schemaVersion: 1,
        courseId: request.courseId,
        lessonId: request.lessonId,
        nodeId: request.nodeId,
        sceneId: request.sceneId,
        kind: request.kind,
        delegatedBy,
        assistantId: request.assistantId,
        inputRefs: [...request.inputRefs],
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof AssistantTaskIdempotencyConflictError) {
        throw new AssistantTaskGatewayError(
          'ASSISTANT_TASK_IDEMPOTENCY_CONFLICT',
          error.message,
          409,
        );
      }
      if (error instanceof AssistantTaskIdCollisionError) {
        throw new AssistantTaskGatewayError('ASSISTANT_TASK_ID_COLLISION', error.message, 409);
      }
      throw error;
    }
  }

  snapshot() {
    return this.#taskService.snapshot();
  }
}

export function createAssistantTaskGateway(
  options: AssistantTaskGatewayOptions,
): AssistantTaskGateway {
  return new AssistantTaskGateway(options);
}

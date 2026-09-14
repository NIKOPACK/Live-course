import {
  AssistantTaskService,
  assistantTaskKindSchema,
  type AssistantTask,
  type AssistantTaskKind,
  type AssistantTaskProposal,
} from '@/lib/livecourse/domain';
import { realtimeTeachingCommandSchema, type RealtimeTeachingCommand } from './contracts';

export type AssistantCapability =
  | 'read_source_reference'
  | 'read_lesson_reference'
  | 'draft_classroom_note';

/** Fixed mapping: an executor receives a capability, never an arbitrary tool name. */
export const ASSISTANT_TASK_CAPABILITIES: Readonly<Record<AssistantTaskKind, AssistantCapability>> =
  {
    summarize_source: 'read_source_reference',
    draft_feedback: 'draft_classroom_note',
    draft_board_note: 'draft_classroom_note',
    suggest_next_step: 'read_lesson_reference',
  };

export interface ConstrainedAssistantExecutor {
  execute(task: AssistantTask, capability: AssistantCapability): Promise<AssistantTaskProposal>;
}

export interface AssistantTaskRunnerOptions {
  service: AssistantTaskService;
  executor: ConstrainedAssistantExecutor;
  getAllowedKinds?: (assistantId: string) => readonly AssistantTaskKind[];
}

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.replace(/[\r\n\t]+/g, ' ').trim() || 'assistant task execution failed').slice(
    0,
    240,
  );
}

/** Runs only queued tasks and turns every executor exception into failed. */
export class AssistantTaskRunner {
  readonly #service: AssistantTaskService;
  readonly #executor: ConstrainedAssistantExecutor;
  readonly #getAllowedKinds: (assistantId: string) => readonly AssistantTaskKind[];

  constructor(options: AssistantTaskRunnerOptions) {
    this.#service = options.service;
    this.#executor = options.executor;
    this.#getAllowedKinds =
      options.getAllowedKinds ??
      (() => Object.keys(ASSISTANT_TASK_CAPABILITIES) as AssistantTaskKind[]);
  }

  async run(taskId: string): Promise<AssistantTask> {
    const queued = this.#service.get(taskId);
    // The lifecycle service is the idempotency boundary. In particular, a
    // retry while execution is in flight must observe running and return
    // without starting another executor call; terminal states are returned
    // unchanged as well.
    if (queued.status !== 'queued') return queued;
    if (!this.#getAllowedKinds(queued.assistantId).includes(queued.kind)) {
      return this.#service.fail(taskId, 'assistant capability is no longer allowed');
    }
    const kind = assistantTaskKindSchema.parse(queued.kind);
    const running = this.#service.start(taskId);
    try {
      const proposal = await this.#executor.execute(running, ASSISTANT_TASK_CAPABILITIES[kind]);
      return this.#service.succeed(taskId, proposal);
    } catch (error) {
      return this.#service.fail(taskId, failureReason(error));
    }
  }

  cancel(taskId: string, reason: string): AssistantTask {
    return this.#service.cancel(taskId, reason);
  }

  cancelForContext(
    context: { courseId: string; lessonId: string; nodeId?: string; sceneId?: string },
    reason: string,
  ): AssistantTask[] {
    return this.#service
      .list()
      .filter(
        (task) =>
          task.courseId === context.courseId &&
          task.lessonId === context.lessonId &&
          (context.nodeId === undefined || task.nodeId === context.nodeId) &&
          (context.sceneId === undefined || task.sceneId === context.sceneId) &&
          (task.status === 'queued' || task.status === 'running'),
      )
      .map((task) => this.#service.cancel(task.id, reason));
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class AssistantTaskConfirmationError extends Error {
  override readonly name = 'AssistantTaskConfirmationError';
}

export interface ConfirmedAssistantTask {
  task: AssistantTask;
  command: RealtimeTeachingCommand;
}

export interface AssistantTaskConfirmationOptions {
  now?: () => string;
  /** Server-side authority check; it must not trust an arbitrary identifier. */
  authorize?: (task: AssistantTask, confirmedBy: string) => boolean;
  /** Alias for integrations that expose an authorization resolver by this name. */
  isAuthorized?: (task: AssistantTask, confirmedBy: string) => boolean;
}

/**
 * Converts a structured proposal to one existing realtime command only after
 * the teacher confirms. The caller must dispatch the returned command through
 * its ClassroomController callback.
 */
export class AssistantTaskConfirmation {
  readonly #service: AssistantTaskService;
  readonly #now: () => string;
  readonly #authorize: (task: AssistantTask, confirmedBy: string) => boolean;

  constructor(
    service: AssistantTaskService,
    nowOrOptions: (() => string) | AssistantTaskConfirmationOptions = {},
    authorize?: (task: AssistantTask, confirmedBy: string) => boolean,
  ) {
    this.#service = service;
    if (typeof nowOrOptions === 'function') {
      this.#now = nowOrOptions;
      this.#authorize = authorize ?? ((task, confirmedBy) => task.delegatedBy === confirmedBy);
    } else {
      this.#now = nowOrOptions.now ?? (() => new Date().toISOString());
      this.#authorize =
        nowOrOptions.authorize ??
        nowOrOptions.isAuthorized ??
        ((task, confirmedBy) => task.delegatedBy === confirmedBy);
    }
  }

  confirm(taskId: string, confirmedBy: string): ConfirmedAssistantTask {
    const task = this.#service.get(taskId);
    if (task.status !== 'succeeded' || !task.result) {
      throw new AssistantTaskConfirmationError(
        'only a succeeded task with a proposal can be confirmed',
      );
    }
    if (!this.#authorize(task, confirmedBy)) {
      throw new AssistantTaskConfirmationError('teacher is not authorized to confirm this task');
    }
    const proposal = task.result;
    let command: RealtimeTeachingCommand;
    const idempotencyKey = `assistant-confirm:${task.id}`;
    if (proposal.kind === 'suggest_next_step') {
      if (!proposal.targetNodeId)
        throw new AssistantTaskConfirmationError('proposal has no target node');
      command = {
        nodeId: task.nodeId,
        idempotencyKey,
        type: 'lesson.goto_node',
        payload: { targetNodeId: proposal.targetNodeId },
      };
    } else if (proposal.kind === 'summarize_source') {
      if (!proposal.sourceId)
        throw new AssistantTaskConfirmationError('proposal has no source reference');
      command = {
        nodeId: task.nodeId,
        idempotencyKey,
        type: 'source.show',
        payload: { sourceId: proposal.sourceId },
      };
    } else {
      if (!proposal.content)
        throw new AssistantTaskConfirmationError('proposal has no classroom note');
      const elementId = `assistant-task-note:${task.id}`;
      command = {
        nodeId: task.nodeId,
        idempotencyKey,
        type: 'board.apply',
        payload: {
          operation: 'add',
          elementId,
          element: {
            id: elementId,
            type: 'text',
            left: 24,
            top: 24,
            width: 520,
            height: 120,
            rotate: 0,
            content: `<p>${escapeHtml(proposal.content)}</p>`,
            defaultFontName: 'Inter',
            defaultColor: '#111827',
            lineHeight: 1.4,
          },
        },
      };
    }
    const parsedCommand = realtimeTeachingCommandSchema.parse(command);
    if (task.confirmation) {
      if (
        task.confirmation.confirmedBy !== confirmedBy ||
        task.confirmation.commandIdempotencyKey !== parsedCommand.idempotencyKey
      ) {
        throw new AssistantTaskConfirmationError(
          'existing confirmation does not match the current teacher or command',
        );
      }
      return { task, command: parsedCommand };
    }
    const confirmed = this.#service.confirm(task.id, {
      confirmedBy,
      confirmedAt: this.#now(),
      commandIdempotencyKey: parsedCommand.idempotencyKey,
      applicationStatus: 'pending',
    });
    return { task: confirmed, command: parsedCommand };
  }

  markApplied(taskId: string, confirmedBy: string, commandIdempotencyKey: string): AssistantTask {
    const task = this.#service.get(taskId);
    if (!this.#authorize(task, confirmedBy)) {
      throw new AssistantTaskConfirmationError('teacher is not authorized to apply this task');
    }
    try {
      return this.#service.markApplied(taskId, {
        confirmedBy,
        commandIdempotencyKey,
        appliedAt: this.#now(),
      });
    } catch (error) {
      if (error instanceof AssistantTaskConfirmationError) throw error;
      throw new AssistantTaskConfirmationError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async confirmAndDispatch(
    taskId: string,
    confirmedBy: string,
    dispatchCommand: (command: RealtimeTeachingCommand) => Promise<void>,
  ): Promise<ConfirmedAssistantTask> {
    const confirmed = this.confirm(taskId, confirmedBy);
    await dispatchCommand(confirmed.command);
    return {
      task: this.markApplied(taskId, confirmedBy, confirmed.command.idempotencyKey),
      command: confirmed.command,
    };
  }
}

export function confirmAssistantTask(
  service: AssistantTaskService,
  taskId: string,
  confirmedBy: string,
  nowOrOptions?: (() => string) | AssistantTaskConfirmationOptions,
  authorize?: (task: AssistantTask, confirmedBy: string) => boolean,
): ConfirmedAssistantTask {
  return new AssistantTaskConfirmation(service, nowOrOptions, authorize).confirm(
    taskId,
    confirmedBy,
  );
}

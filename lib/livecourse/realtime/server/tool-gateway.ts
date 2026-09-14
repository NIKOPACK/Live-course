import { createHash } from 'node:crypto';

import {
  REALTIME_TOOL_IDEMPOTENCY_PREFIX,
  realtimeToolRequestSchema,
  realtimeToolResponseSchema,
  type RealtimeTeachingCommand,
  type RealtimeToolRequest,
  type RealtimeToolResponse,
} from '@/lib/livecourse/realtime/contracts';
import {
  AssistantTaskGatewayConfigurationError,
  type AssistantTaskGateway,
} from './assistant-task-gateway';

export {
  AssistantTaskGatewayError,
  AssistantTaskGatewayConfigurationError,
} from './assistant-task-gateway';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function boardElementId(callId: string): string {
  const digest = createHash('sha256').update(callId).digest('hex').slice(0, 20);
  return `realtime-text-${digest}`;
}

function command(
  request: RealtimeToolRequest,
  value: Omit<RealtimeTeachingCommand, 'idempotencyKey'>,
): RealtimeTeachingCommand {
  return {
    ...value,
    idempotencyKey: `${REALTIME_TOOL_IDEMPOTENCY_PREFIX}${request.callId}`,
  };
}

export interface RealtimeToolGatewayOptions {
  assistantTaskGateway?: AssistantTaskGateway;
  delegatedBy?: string;
}

export function mapRealtimeToolRequest(
  rawInput: unknown,
  options: RealtimeToolGatewayOptions = {},
): RealtimeToolResponse {
  const request = realtimeToolRequestSchema.parse(rawInput);
  let mapped: RealtimeTeachingCommand;

  switch (request.tool.name) {
    case 'delegate_assistant_task': {
      if (!options.assistantTaskGateway || !options.delegatedBy) {
        throw new AssistantTaskGatewayConfigurationError();
      }
      const task = options.assistantTaskGateway.delegate({
        courseId: request.courseId,
        lessonId: request.lessonId,
        nodeId: request.nodeId,
        sceneId: request.sceneId,
        callId: request.callId,
        assistantId: request.tool.arguments.assistantId,
        kind: request.tool.arguments.kind,
        inputRefs: request.tool.arguments.inputRefs,
        delegatedBy: options.delegatedBy,
      });
      return realtimeToolResponseSchema.parse({
        success: true,
        task,
        message: `Assistant task ${task.id} queued for teacher review.`,
      });
    }
    case 'goto_node':
      mapped = command(request, {
        nodeId: request.nodeId,
        type: 'lesson.goto_node',
        payload: { targetNodeId: request.tool.arguments.targetNodeId },
      });
      break;
    case 'highlight':
      mapped = command(request, {
        nodeId: request.nodeId,
        type: 'stage.highlight',
        payload: {
          sceneId: request.sceneId,
          elementId: request.tool.arguments.elementId,
          ...(request.tool.arguments.durationMs
            ? { durationMs: request.tool.arguments.durationMs }
            : {}),
          ...(request.tool.arguments.color ? { color: request.tool.arguments.color } : {}),
          ...(request.tool.arguments.style ? { style: request.tool.arguments.style } : {}),
        },
      });
      break;
    case 'pointer':
      mapped = command(request, {
        nodeId: request.nodeId,
        type: 'stage.pointer',
        payload: {
          sceneId: request.sceneId,
          elementId: request.tool.arguments.elementId,
          ...(request.tool.arguments.x === undefined ? {} : { x: request.tool.arguments.x }),
          ...(request.tool.arguments.y === undefined ? {} : { y: request.tool.arguments.y }),
          ...(request.tool.arguments.durationMs
            ? { durationMs: request.tool.arguments.durationMs }
            : {}),
        },
      });
      break;
    case 'board_text': {
      const elementId = boardElementId(request.callId);
      mapped = command(request, {
        nodeId: request.nodeId,
        type: 'board.apply',
        payload: {
          operation: 'add',
          elementId,
          element: {
            id: elementId,
            type: 'text',
            left: request.tool.arguments.x,
            top: request.tool.arguments.y,
            width: request.tool.arguments.width ?? 420,
            height: request.tool.arguments.height ?? 100,
            rotate: 0,
            content: `<p>${escapeHtml(request.tool.arguments.content)}</p>`,
            defaultFontName: 'Inter',
            defaultColor: request.tool.arguments.color ?? '#111827',
            lineHeight: 1.4,
          },
        },
      });
      break;
    }
    case 'board_clear':
      mapped = command(request, {
        nodeId: request.nodeId,
        type: 'board.clear',
        payload: {},
      });
      break;
    case 'set_expression':
      mapped = command(request, {
        nodeId: request.nodeId,
        type: 'avatar.expression',
        payload: request.tool.arguments,
      });
      break;
    case 'look_at':
      mapped = command(request, {
        nodeId: request.nodeId,
        type: 'avatar.look_at',
        payload: request.tool.arguments,
      });
      break;
    case 'show_source':
      mapped = command(request, {
        nodeId: request.nodeId,
        type: 'source.show',
        payload: request.tool.arguments,
      });
      break;
  }

  return realtimeToolResponseSchema.parse({
    success: true,
    command: mapped,
    message: `Classroom action ${mapped.type} accepted by the tool gateway.`,
  });
}

import { z } from 'zod';

import {
  ASSISTANT_TASK_KINDS,
  assistantTaskSchema,
  jsonValueSchema,
  type AssistantTask,
} from '@/lib/livecourse/domain';

const MAX_IDENTIFIER_LENGTH = 240;

export const REALTIME_TOOL_IDEMPOTENCY_PREFIX = 'realtime:';

const identifierSchema = z.string().trim().min(1).max(MAX_IDENTIFIER_LENGTH);
const realtimeCallIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH - REALTIME_TOOL_IDEMPOTENCY_PREFIX.length);

export const realtimeClientSecretRequestSchema = z
  .object({
    courseId: identifierSchema,
    lessonId: identifierSchema,
    /** Optional learner-saved key. Ignored when the server already has OPENAI_API_KEY. */
    apiKey: z.string().max(2_000).optional(),
  })
  .strict();

export const realtimeClientSecretResponseSchema = z
  .object({
    value: z.string().trim().min(1),
    expiresAt: z.number().int().positive(),
    model: identifierSchema,
    voice: identifierSchema,
  })
  .strict();

const gotoNodeToolSchema = z
  .object({
    name: z.literal('goto_node'),
    arguments: z.object({ targetNodeId: identifierSchema }).strict(),
  })
  .strict();

const highlightToolSchema = z
  .object({
    name: z.literal('highlight'),
    arguments: z
      .object({
        elementId: identifierSchema,
        durationMs: z.number().int().positive().max(60_000).optional(),
        color: z.string().trim().min(1).max(64).optional(),
        style: z.enum(['outline', 'fill', 'shadow']).optional(),
      })
      .strict(),
  })
  .strict();

const pointerToolSchema = z
  .object({
    name: z.literal('pointer'),
    arguments: z
      .object({
        elementId: identifierSchema,
        x: z.number().min(0).max(1).optional(),
        y: z.number().min(0).max(1).optional(),
        durationMs: z.number().int().positive().max(60_000).optional(),
      })
      .strict(),
  })
  .strict();

const boardTextToolSchema = z
  .object({
    name: z.literal('board_text'),
    arguments: z
      .object({
        content: z.string().trim().min(1).max(2_000),
        x: z.number().min(0).max(1_000),
        y: z.number().min(0).max(1_000),
        width: z.number().positive().max(1_000).optional(),
        height: z.number().positive().max(1_000).optional(),
        color: z.string().trim().min(1).max(64).optional(),
      })
      .strict(),
  })
  .strict();

const boardClearToolSchema = z
  .object({
    name: z.literal('board_clear'),
    arguments: z.object({}).strict(),
  })
  .strict();

const expressionToolSchema = z
  .object({
    name: z.literal('set_expression'),
    arguments: z
      .object({
        expression: z.enum(['neutral', 'relaxed', 'think', 'happy', 'surprised']),
        intensity: z.number().min(0).max(1).optional(),
      })
      .strict(),
  })
  .strict();

const lookAtToolSchema = z
  .object({
    name: z.literal('look_at'),
    arguments: z.object({ target: z.enum(['student', 'slides', 'whiteboard', 'camera']) }).strict(),
  })
  .strict();

const delegateAssistantTaskToolSchema = z
  .object({
    name: z.literal('delegate_assistant_task'),
    arguments: z
      .object({
        assistantId: z.string().trim().min(1).max(64),
        kind: z.enum(ASSISTANT_TASK_KINDS),
        inputRefs: z.array(z.string().trim().min(1).max(240)).max(8),
      })
      .strict(),
  })
  .strict();

const showSourceToolSchema = z
  .object({
    name: z.literal('show_source'),
    arguments: z
      .object({
        sourceId: identifierSchema,
        page: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();

export const realtimeToolSchema = z.discriminatedUnion('name', [
  gotoNodeToolSchema,
  highlightToolSchema,
  pointerToolSchema,
  boardTextToolSchema,
  boardClearToolSchema,
  expressionToolSchema,
  lookAtToolSchema,
  showSourceToolSchema,
  delegateAssistantTaskToolSchema,
]);

export const realtimeToolRequestSchema = z
  .object({
    courseId: identifierSchema,
    lessonId: identifierSchema,
    nodeId: identifierSchema,
    sceneId: identifierSchema,
    callId: realtimeCallIdSchema,
    tool: realtimeToolSchema,
  })
  .strict();

export const realtimeTeachingCommandSchema = z
  .object({
    nodeId: identifierSchema,
    idempotencyKey: identifierSchema,
    type: z.enum([
      'lesson.goto_node',
      'stage.highlight',
      'stage.pointer',
      'board.apply',
      'board.clear',
      'avatar.expression',
      'avatar.look_at',
      'source.show',
    ]),
    payload: z.record(z.string(), jsonValueSchema),
  })
  .strict();

const realtimeTeachingToolResponseSchema = z
  .object({
    success: z.literal(true),
    command: realtimeTeachingCommandSchema,
    message: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const realtimeAssistantTaskResponseSchema = z
  .object({
    success: z.literal(true),
    task: assistantTaskSchema,
    message: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const realtimeToolResponseSchema = z.union([
  realtimeTeachingToolResponseSchema,
  realtimeAssistantTaskResponseSchema,
]);

export type RealtimeClientSecretRequest = z.infer<typeof realtimeClientSecretRequestSchema>;
export type RealtimeClientSecretResponse = z.infer<typeof realtimeClientSecretResponseSchema>;
export type RealtimeToolRequest = z.infer<typeof realtimeToolRequestSchema>;
export type RealtimeTeachingCommand = z.infer<typeof realtimeTeachingCommandSchema>;
export type RealtimeToolResponse = z.infer<typeof realtimeToolResponseSchema>;
export type RealtimeAssistantTaskResponse = z.infer<typeof realtimeAssistantTaskResponseSchema>;
export type { AssistantTask };

import { ZodError } from 'zod';

import { ClassroomAgentSessionError } from '@/lib/livecourse/realtime/server/classroom-agent-session';
import {
  AssistantTaskGatewayError,
  mapRealtimeToolRequest,
} from '@/lib/livecourse/realtime/server/tool-gateway';
import type { AssistantTaskGateway } from '@/lib/livecourse/realtime/server/assistant-task-gateway';
import {
  realtimeToolRequestSchema,
  realtimeToolResponseSchema,
} from '@/lib/livecourse/realtime/contracts';

export interface RealtimeToolRouteIdentity {
  learnerId: string;
  /** A trusted teacher identity is required for assistant delegation. */
  teacherId?: string;
}

export interface RealtimeSessionDelegator {
  delegate(
    request: import('@/lib/livecourse/realtime/contracts').RealtimeToolRequest,
  ): Promise<import('@/lib/livecourse/domain').AssistantTask>;
}

export interface RealtimeToolsRouteHandlerOptions {
  /** A trusted, server-owned gateway. There is deliberately no global default. */
  assistantTaskGateway?: AssistantTaskGateway;
  /** Resolve the gateway from trusted server/session state for each request. */
  resolveAssistantTaskGateway?: (
    identity: RealtimeToolRouteIdentity,
    request: Request,
  ) => AssistantTaskGateway | null | Promise<AssistantTaskGateway | null>;
  /** Resolve identities from trusted authentication/session state. */
  resolveIdentity?: (
    request: Request,
  ) => RealtimeToolRouteIdentity | null | Promise<RealtimeToolRouteIdentity | null>;
  /** Useful for a server bootstrap that has already authenticated the session. */
  identity?: RealtimeToolRouteIdentity;
  /** Explicit trusted identities for a server bootstrap. */
  learnerId?: string;
  teacherId?: string;
  /**
   * When provided, `delegate_assistant_task` is resolved SOLELY through the
   * ClassroomAgentSession: realtime teacher, roster, allowlists and current
   * course/lesson/node/scene come from the session, never from headers or the
   * request body. A missing session fails closed.
   */
  sessionDelegator?: (request: Request) => Promise<RealtimeSessionDelegator | null>;
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * Agent/assistant identity headers the route recognizes. In session-bound
 * mode the realtime teacher, roster and scope come from the ClassroomAgentSession
 * cookie, so any client-supplied identity header is a forgery and must be
 * rejected explicitly (never ignored).
 */
const AGENT_IDENTITY_HEADERS = [
  'x-teacher-key',
  'x-teacher-agent-id',
  'x-assistant-agent-id',
] as const;

function forgedAgentIdentityHeader(request: Request): string | null {
  for (const name of AGENT_IDENTITY_HEADERS) {
    const value = request.headers.get(name)?.trim();
    if (value) return name;
  }
  return null;
}

function headerIdentity(
  request: Request,
  allowTeacherHeader: boolean,
): RealtimeToolRouteIdentity | null {
  const learnerId = request.headers.get('x-learner-key')?.trim();
  if (!learnerId) return null;
  const teacherId = allowTeacherHeader ? request.headers.get('x-teacher-key')?.trim() : undefined;
  return { learnerId, ...(teacherId ? { teacherId } : {}) };
}

async function resolveIdentity(
  request: Request,
  options: RealtimeToolsRouteHandlerOptions,
): Promise<RealtimeToolRouteIdentity | null> {
  if (options.resolveIdentity) return options.resolveIdentity(request);
  if (options.identity) return options.identity;
  if (options.learnerId) {
    return {
      learnerId: options.learnerId,
      ...(options.teacherId ? { teacherId: options.teacherId } : {}),
    };
  }
  // A configured gateway must never promote a caller-controlled teacher
  // header into authority. Use identity/resolveIdentity for that trusted bind.
  return headerIdentity(
    request,
    !options.assistantTaskGateway && !options.resolveAssistantTaskGateway,
  );
}

/**
 * Build the route handler with the application's trusted task gateway and
 * identity resolver. The Next route supplies cookie-bound session delegation.
 */
export function createRealtimeToolsRouteHandler(
  options: RealtimeToolsRouteHandlerOptions = {},
): (request: Request) => Promise<Response> {
  return async function handleRealtimeTools(request: Request): Promise<Response> {
    const identity = await resolveIdentity(request, options);
    if (!identity?.learnerId.trim()) {
      return jsonError(401, 'LEARNER_ID_REQUIRED', 'learner identity is required');
    }

    try {
      const body = await request.json();
      const parsed = realtimeToolRequestSchema.safeParse(body);
      if (parsed.success && parsed.data.tool.name === 'delegate_assistant_task') {
        if (options.sessionDelegator) {
          // Fail closed on forged Agent identity: a caller-supplied teacher/agent
          // header must never be silently ignored on the session-bound path.
          const forged = forgedAgentIdentityHeader(request);
          if (forged) {
            return jsonError(
              403,
              'FORGED_AGENT_IDENTITY',
              `client-supplied agent identity header ${forged} is not accepted on session-bound delegation`,
            );
          }
          const delegator = await options.sessionDelegator(request);
          if (!delegator) {
            return jsonError(
              401,
              'SESSION_REQUIRED',
              'classroom agent session is required for assistant delegation',
            );
          }
          const task = await delegator.delegate(parsed.data);
          return Response.json(
            realtimeToolResponseSchema.parse({
              success: true,
              task,
              message: `Assistant task ${task.id} queued for teacher review.`,
            }),
            { headers: { 'Cache-Control': 'no-store' } },
          );
        }
      }

      const assistantTaskGateway = options.resolveAssistantTaskGateway
        ? await options.resolveAssistantTaskGateway(identity, request)
        : options.assistantTaskGateway;
      const delegatedBy = identity.teacherId?.trim();
      return Response.json(
        mapRealtimeToolRequest(body, {
          ...(assistantTaskGateway ? { assistantTaskGateway } : {}),
          ...(delegatedBy ? { delegatedBy } : {}),
        }),
        { headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ZodError) {
        return jsonError(400, 'INVALID_TOOL_REQUEST', 'invalid Realtime tool request');
      }
      if (error instanceof AssistantTaskGatewayError) {
        return jsonError(error.status, error.code, error.message);
      }
      if (error instanceof ClassroomAgentSessionError) {
        return jsonError(error.status, error.code, error.message);
      }
      console.error('Realtime tool gateway failed', error);
      return jsonError(500, 'TOOL_GATEWAY_ERROR', 'Realtime tool request failed');
    }
  };
}

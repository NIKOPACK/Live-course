/**
 * Shared HTTP helpers for the ClassroomAgentSession API surface (P-007).
 * Every route is server-owned: identity, scope, roster, allowlists and
 * confirmation authority come from the session cookie, never from the body.
 */
import { ZodError } from 'zod';

import { AssistantTaskGatewayError } from '@/lib/livecourse/realtime/server/assistant-task-gateway';
import {
  ClassroomAgentSessionError,
  readAgentSessionToken,
} from '@/lib/livecourse/realtime/server/classroom-agent-session';

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export function jsonOk(data: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(data, {
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

export function mapAgentSessionError(error: unknown): Response {
  if (error instanceof ClassroomAgentSessionError) {
    return jsonError(error.status, error.code, error.message);
  }
  if (error instanceof AssistantTaskGatewayError) {
    return jsonError(error.status, error.code, error.message);
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return jsonError(400, 'INVALID_REQUEST', 'invalid request body');
  }
  console.error('Agent session API failed', error);
  return jsonError(500, 'AGENT_SESSION_INTERNAL_ERROR', 'agent session request failed');
}

/** The opaque session token from the httpOnly cookie, or a fail-closed 401. */
export function requireSessionToken(request: Request): string {
  const token = readAgentSessionToken(request);
  if (!token) {
    throw new ClassroomAgentSessionError(
      'SESSION_REQUIRED',
      'classroom agent session is required',
      401,
    );
  }
  return token;
}

import { z } from 'zod';

import { ASSISTANT_TASK_KINDS } from '@/lib/livecourse/domain';
import { getClassroomAgentSessionService } from '@/lib/livecourse/realtime/server/classroom-agent-session-runtime';
import { jsonOk, mapAgentSessionError, requireSessionToken } from '../helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const delegateTaskSchema = z
  .object({
    assistantId: z.string().trim().min(1).max(64),
    kind: z.enum(ASSISTANT_TASK_KINDS),
    inputRefs: z.array(z.string().trim().min(1).max(240)).max(8),
    /**
     * Explicit bounded idempotency key supplied by the UI: the same key with
     * the same payload returns the same task; the same key with a conflicting
     * payload stays a 409. It maps directly onto the gateway call/idempotency
     * boundary (never a per-request random id).
     */
    idempotencyKey: z.string().trim().min(1).max(64),
    nodeId: z.string().trim().min(1).max(240).optional(),
    sceneId: z.string().trim().min(1).max(240).optional(),
  })
  .strict();

/**
 * POST /api/livecourse/agent-session/tasks — the teacher delegates one
 * allowlisted assistant task through the session-bound gateway. The delegator
 * is always the session's realtime teacher agent; the roster and allowlists
 * come from the session, never from the request.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const token = requireSessionToken(request);
    // Fail closed on a forged/missing/expired session before trusting the
    // request body: a bad token is never masked by a later body error.
    getClassroomAgentSessionService().resolveToken(token);
    const body = await request.json();
    const parsed = delegateTaskSchema.parse(body);
    const task = getClassroomAgentSessionService().delegate(token, {
      assistantId: parsed.assistantId,
      kind: parsed.kind,
      inputRefs: parsed.inputRefs,
      callId: parsed.idempotencyKey,
      nodeId: parsed.nodeId,
      sceneId: parsed.sceneId,
    });
    return jsonOk({ task });
  } catch (error) {
    return mapAgentSessionError(error);
  }
}

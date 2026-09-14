import { z } from 'zod';

import { identifierSchema } from '@/lib/livecourse/domain';
import { getClassroomAgentSessionService } from '@/lib/livecourse/realtime/server/classroom-agent-session-runtime';
import {
  agentSessionCookieHeader,
  expiredAgentSessionCookieHeader,
  readAgentSessionToken,
} from '@/lib/livecourse/realtime/server/classroom-agent-session';
import { jsonOk, mapAgentSessionError, requireSessionToken } from './helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const establishRequestSchema = z
  .object({
    classroomId: identifierSchema,
    learnerId: identifierSchema,
  })
  .strict();

/**
 * POST /api/livecourse/agent-session — establish (or restore) the classroom
 * agent session and set the opaque httpOnly cookie. The body carries only the
 * classroom lookup id and the learner partition key; the course plan, teacher
 * agent, roster and allowlists are resolved server-side.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const parsed = establishRequestSchema.parse(body);
    const service = getClassroomAgentSessionService();
    const { token, session, restored } = await service.establish({
      classroomId: parsed.classroomId,
      learnerId: parsed.learnerId,
      resumeToken: readAgentSessionToken(request),
    });
    const view = await service.stateView(token);
    return jsonOk(
      { ...view, restored },
      { 'Set-Cookie': agentSessionCookieHeader(token, session.expiresAt) },
    );
  } catch (error) {
    return mapAgentSessionError(error);
  }
}

/** GET /api/livecourse/agent-session — current session-bound classroom state. */
export async function GET(request: Request): Promise<Response> {
  try {
    const token = requireSessionToken(request);
    const view = await getClassroomAgentSessionService().stateView(token);
    return jsonOk(view);
  } catch (error) {
    return mapAgentSessionError(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const token = requireSessionToken(request);
    getClassroomAgentSessionService().revoke(token);
    return jsonOk({ success: true }, { 'Set-Cookie': expiredAgentSessionCookieHeader() });
  } catch (error) {
    return mapAgentSessionError(error);
  }
}

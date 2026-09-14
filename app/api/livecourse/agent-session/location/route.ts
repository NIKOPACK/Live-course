import { z } from 'zod';

import { identifierSchema } from '@/lib/livecourse/domain';
import { getClassroomAgentSessionService } from '@/lib/livecourse/realtime/server/classroom-agent-session-runtime';
import { jsonOk, mapAgentSessionError, requireSessionToken } from '../helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const locationRequestSchema = z
  .object({
    nodeId: identifierSchema,
    sceneId: identifierSchema,
  })
  .strict();

/**
 * POST /api/livecourse/agent-session/location — report the classroom position.
 * The server validates the node/scene pair against the session's lesson scope
 * before storing it; the browser can only move inside the frozen scope.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const token = requireSessionToken(request);
    const body = await request.json();
    const parsed = locationRequestSchema.parse(body);
    const view = getClassroomAgentSessionService().updateLocation(token, parsed);
    return jsonOk(view);
  } catch (error) {
    return mapAgentSessionError(error);
  }
}

import { getClassroomAgentSessionService } from '@/lib/livecourse/realtime/server/classroom-agent-session-runtime';
import { readAgentSessionToken } from '@/lib/livecourse/realtime/server/classroom-agent-session';
import { createRealtimeToolsRouteHandler, type RealtimeSessionDelegator } from './handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Session-bound delegation: realtime teacher, roster and scope come from the cookie session. */
async function defaultSessionDelegator(request: Request): Promise<RealtimeSessionDelegator | null> {
  const token = readAgentSessionToken(request);
  if (!token) return null;
  const service = getClassroomAgentSessionService();
  return {
    delegate: (toolRequest) => Promise.resolve(service.delegateTool(token, toolRequest)),
  };
}

const defaultHandler = createRealtimeToolsRouteHandler({
  sessionDelegator: defaultSessionDelegator,
});

export async function POST(request: Request): Promise<Response> {
  return defaultHandler(request);
}

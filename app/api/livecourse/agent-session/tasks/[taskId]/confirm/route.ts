import { getClassroomAgentSessionService } from '@/lib/livecourse/realtime/server/classroom-agent-session-runtime';
import { jsonOk, mapAgentSessionError, requireSessionToken } from '../../../helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/livecourse/agent-session/tasks/[taskId]/confirm — the session
 * teacher confirms a succeeded assistant task. Only the returned command may
 * affect the classroom, and only after this authoritative confirmation.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  try {
    const token = requireSessionToken(request);
    const { taskId } = await context.params;
    const result = getClassroomAgentSessionService().confirmTask(token, taskId);
    return jsonOk(result);
  } catch (error) {
    return mapAgentSessionError(error);
  }
}

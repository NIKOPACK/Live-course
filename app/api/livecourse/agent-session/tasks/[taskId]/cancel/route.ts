import { z } from 'zod';

import { getClassroomAgentSessionService } from '@/lib/livecourse/realtime/server/classroom-agent-session-runtime';
import { jsonOk, mapAgentSessionError, requireSessionToken } from '../../../helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const cancelTaskSchema = z
  .object({
    reason: z.string().trim().min(1).max(240).optional(),
  })
  .strict();

/**
 * POST /api/livecourse/agent-session/tasks/[taskId]/cancel — cancel a queued
 * or running assistant task. Terminal tasks (succeeded/failed) can never be
 * cancelled and a cancelled task never becomes success.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  try {
    const token = requireSessionToken(request);
    const { taskId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as unknown;
    const parsed = cancelTaskSchema.parse(body);
    const task = getClassroomAgentSessionService().cancelTask(
      token,
      taskId,
      parsed.reason ?? 'cancelled by teacher',
    );
    return jsonOk({ task });
  } catch (error) {
    return mapAgentSessionError(error);
  }
}

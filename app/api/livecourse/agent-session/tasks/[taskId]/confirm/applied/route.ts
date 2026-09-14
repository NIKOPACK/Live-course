import { z } from 'zod';

import { identifierSchema } from '@/lib/livecourse/domain';
import { getClassroomAgentSessionService } from '@/lib/livecourse/realtime/server/classroom-agent-session-runtime';
import { jsonOk, mapAgentSessionError, requireSessionToken } from '../../../../helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const appliedRequestSchema = z.object({ commandIdempotencyKey: identifierSchema }).strict();

/** Marks a confirmed command applied only after the classroom runtime accepted it. */
export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  try {
    const token = requireSessionToken(request);
    const { taskId } = await context.params;
    const body = appliedRequestSchema.parse(await request.json());
    const task = getClassroomAgentSessionService().markTaskApplied(
      token,
      taskId,
      body.commandIdempotencyKey,
    );
    return jsonOk({ task });
  } catch (error) {
    return mapAgentSessionError(error);
  }
}

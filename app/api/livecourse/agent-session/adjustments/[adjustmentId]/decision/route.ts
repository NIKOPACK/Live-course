import { z } from 'zod';

import { getClassroomAgentSessionService } from '@/lib/livecourse/realtime/server/classroom-agent-session-runtime';
import { jsonOk, mapAgentSessionError, requireSessionToken } from '../../../helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const decisionRequestSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
  })
  .strict();

/**
 * POST /api/livecourse/agent-session/adjustments/[adjustmentId]/decision —
 * the session teacher approves or rejects a pending course-level adjustment.
 * Approval writes a new CoursePlan version and, when it targets another
 * lesson, advances the classroom to that lesson; rejection leaves the plan
 * untouched.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ adjustmentId: string }> },
): Promise<Response> {
  try {
    const token = requireSessionToken(request);
    const { adjustmentId } = await context.params;
    const body = await request.json();
    const parsed = decisionRequestSchema.parse(body);
    const view = getClassroomAgentSessionService().decideAdjustment(
      token,
      adjustmentId,
      parsed.decision,
    );
    return jsonOk(view);
  } catch (error) {
    return mapAgentSessionError(error);
  }
}

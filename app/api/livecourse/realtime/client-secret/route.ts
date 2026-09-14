import { ZodError } from 'zod';

import {
  createRealtimeClientSecret,
  RealtimeConfigurationError,
  RealtimeUpstreamError,
} from '@/lib/livecourse/realtime/server/client-secret';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const learnerId = request.headers.get('x-learner-key')?.trim();
  if (!learnerId) {
    return jsonError(401, 'LEARNER_ID_REQUIRED', 'learner identity is required');
  }

  try {
    const secret = await createRealtimeClientSecret(await request.json(), learnerId);
    return Response.json(secret, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return jsonError(400, 'INVALID_REQUEST', 'invalid Realtime client secret request');
    }
    if (error instanceof RealtimeConfigurationError) {
      return jsonError(503, 'REALTIME_NOT_CONFIGURED', 'Realtime is not configured');
    }
    if (error instanceof RealtimeUpstreamError) {
      return jsonError(502, 'REALTIME_UPSTREAM_ERROR', 'Realtime service is unavailable');
    }
    console.error('Realtime client secret route failed', error);
    return jsonError(500, 'REALTIME_INTERNAL_ERROR', 'Realtime client secret request failed');
  }
}

import { ZodError } from 'zod';

import { volcRealtimeActionSchema } from '@/lib/livecourse/realtime/volc/protocol';
import {
  VolcRealtimeConfigurationError,
  VolcRealtimeUpstreamError,
  volcRealtimeSessionRegistry,
} from '@/lib/livecourse/realtime/volc/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

function requireSession(sessionId: string) {
  const session = volcRealtimeSessionRegistry.get(sessionId);
  if (!session) throw new VolcRealtimeUpstreamError('Realtime session not found');
  return session;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const action = volcRealtimeActionSchema.parse(await request.json());
    if (action.action === 'connect') {
      const apiKey = [process.env.VOLCENGINE_REALTIME_API_KEY, action.apiKey]
        .map((value) => value?.trim())
        .find(Boolean);
      if (!apiKey) {
        throw new VolcRealtimeConfigurationError('VOLCENGINE_REALTIME_API_KEY is not configured');
      }
      const session = await volcRealtimeSessionRegistry.create(
        apiKey,
        action.instructions,
        action.voice,
      );
      return Response.json({ sessionId: session.id }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const session = requireSession(action.sessionId);
    if (action.action === 'audio') session.sendAudio(action.audio);
    if (action.action === 'update') session.updateInstructions(action.instructions);
    if (action.action === 'text') session.sendText(action.text);
    if (action.action === 'query') session.sendQuery(action.text);
    if (action.action === 'commit') session.commitAudio();
    if (action.action === 'cancel') session.cancelResponse();
    if (action.action === 'close') session.close();
    return Response.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return jsonError(400, 'INVALID_REQUEST', 'Invalid Volc realtime request');
    }
    if (error instanceof VolcRealtimeConfigurationError) {
      return jsonError(503, 'REALTIME_NOT_CONFIGURED', 'Volc realtime is not configured');
    }
    if (error instanceof VolcRealtimeUpstreamError) {
      const missing = error.message === 'Realtime session not found';
      return jsonError(
        missing ? 404 : 502,
        missing ? 'REALTIME_SESSION_NOT_FOUND' : 'REALTIME_UPSTREAM_ERROR',
        error.message,
      );
    }
    console.error('Volc realtime route failed', error);
    return jsonError(500, 'REALTIME_INTERNAL_ERROR', 'Volc realtime request failed');
  }
}

export function GET(request: Request): Response {
  const sessionId = new URL(request.url).searchParams.get('sessionId')?.trim();
  if (!sessionId) return jsonError(400, 'INVALID_REQUEST', 'sessionId is required');
  const session = volcRealtimeSessionRegistry.get(sessionId);
  if (!session) {
    return jsonError(404, 'REALTIME_SESSION_NOT_FOUND', 'Realtime session not found');
  }

  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        controller.close();
      };
      unsubscribe = session.subscribe((event) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        if (event.type === 'local.closed') close();
      });
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(': keepalive\n\n'));
      }, 15_000);
      request.signal.addEventListener('abort', close, { once: true });
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

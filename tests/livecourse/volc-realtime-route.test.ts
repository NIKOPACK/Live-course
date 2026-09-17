import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VolcTextReplyContext } from '@/lib/livecourse/realtime/volc/server';

const replyMocks = vi.hoisted(() => ({
  callLLM: vi.fn(async () => ({ text: 'A short teacher reply.', finishReason: 'stop' })),
  resolveModelFromHeaders: vi.fn(async () => ({
    model: 'test-teacher-model',
    thinkingConfig: { enabled: false },
  })),
}));
vi.mock('@/lib/ai/llm', () => ({ callLLM: replyMocks.callLLM }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromHeaders: replyMocks.resolveModelFromHeaders,
}));

import { POST } from '@/app/api/livecourse/realtime/volc/route';

beforeEach(() => {
  replyMocks.callLLM
    .mockReset()
    .mockResolvedValue({ text: 'A short teacher reply.', finishReason: 'stop' });
  replyMocks.resolveModelFromHeaders.mockClear();
});

function request(body: unknown): Request {
  return new Request('http://localhost/api/livecourse/realtime/volc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Volc realtime route', () => {
  it('waits for the existing LLM to answer using the active node context and request cancellation', async () => {
    const { volcRealtimeSessionRegistry } = await import('@/lib/livecourse/realtime/volc/server');
    let release!: (value: { text: string; finishReason: string }) => void;
    replyMocks.callLLM.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let reply: string | undefined;
    const session = {
      sendQuery: vi.fn(
        async (
          question: string,
          generate: (context: VolcTextReplyContext) => Promise<string>,
          signal: AbortSignal,
        ) => {
          reply = await generate({
            instructions: 'Current node and learner context',
            question,
            signal,
          });
        },
      ),
    };
    const get = vi.spyOn(volcRealtimeSessionRegistry, 'get').mockReturnValue(session as never);
    const input = request({ action: 'query', sessionId: 'query-session', text: 'Please explain.' });
    try {
      let completed = false;
      const pending = POST(input).then((response) => {
        completed = true;
        return response;
      });
      await vi.waitFor(() => expect(replyMocks.callLLM).toHaveBeenCalledOnce());
      expect(completed).toBe(false);
      expect(replyMocks.resolveModelFromHeaders).toHaveBeenCalledWith(input, 'chat-adapter');
      expect(replyMocks.callLLM).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-teacher-model',
          system: expect.stringContaining('Current node and learner context'),
          prompt: 'Please explain.',
          abortSignal: input.signal,
        }),
        'chat-adapter',
        undefined,
        { enabled: false },
      );
      release({ text: 'The actual generated explanation.', finishReason: 'stop' });
      expect((await pending).status).toBe(200);
      expect(reply).toBe('The actual generated explanation.');
    } finally {
      get.mockRestore();
    }
  });

  it('returns an explicit cancellation instead of claiming the question was answered', async () => {
    const { volcRealtimeSessionRegistry, VolcRealtimeQueryCancelledError } =
      await import('@/lib/livecourse/realtime/volc/server');
    const get = vi.spyOn(volcRealtimeSessionRegistry, 'get').mockReturnValue({
      sendQuery: vi
        .fn()
        .mockRejectedValue(new VolcRealtimeQueryCancelledError('Question was interrupted')),
    } as never);
    try {
      const response = await POST(
        request({ action: 'query', sessionId: 'query-session', text: 'Question' }),
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'REALTIME_QUERY_CANCELLED' },
      });
    } finally {
      get.mockRestore();
    }
  });

  it('forwards input generation and mute gates to the same relay session', async () => {
    const { volcRealtimeSessionRegistry } = await import('@/lib/livecourse/realtime/volc/server');
    const session = { sendAudio: vi.fn(), setInputEnabled: vi.fn() };
    const get = vi.spyOn(volcRealtimeSessionRegistry, 'get').mockReturnValue(session as never);
    try {
      expect(
        (
          await POST(
            request({
              action: 'input',
              sessionId: 'input-session',
              enabled: false,
              generation: 2,
            }),
          )
        ).status,
      ).toBe(200);
      expect(session.setInputEnabled).toHaveBeenCalledWith(false, 2);
      expect(
        (
          await POST(
            request({
              action: 'audio',
              sessionId: 'input-session',
              audio: 'AAE=',
              generation: 1,
            }),
          )
        ).status,
      ).toBe(200);
      expect(session.sendAudio).toHaveBeenCalledWith('AAE=', 1);
    } finally {
      get.mockRestore();
    }
  });

  it('accepts a learner-saved key when the server env key is missing', async () => {
    vi.stubEnv('VOLCENGINE_REALTIME_API_KEY', '');
    const { volcRealtimeSessionRegistry } = await import('@/lib/livecourse/realtime/volc/server');
    const create = vi
      .spyOn(volcRealtimeSessionRegistry, 'create')
      .mockResolvedValue({ id: 'session-from-settings' } as never);

    const response = await POST(
      request({
        action: 'connect',
        instructions: 'Teach backpropagation',
        apiKey: 'ark-from-settings',
      }),
    );

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith('ark-from-settings', 'Teach backpropagation', undefined);
    await expect(response.json()).resolves.toEqual({ sessionId: 'session-from-settings' });
    create.mockRestore();
  });

  it('fails explicitly without returning any credential when the server key is missing', async () => {
    vi.stubEnv('VOLCENGINE_REALTIME_API_KEY', '');

    const response = await POST(
      request({ action: 'connect', instructions: 'Teach backpropagation' }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'REALTIME_NOT_CONFIGURED',
        message: 'Volc realtime is not configured',
      },
    });
  });

  it('rejects unknown client-controlled session fields', async () => {
    const response = await POST(
      request({
        action: 'connect',
        instructions: 'Teach backpropagation',
        model: 'must-not-be-client-controlled',
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('accepts narration text as a typed action before resolving its session', async () => {
    const response = await POST(
      request({
        action: 'text',
        sessionId: 'missing-narration-session',
        text: '请用模型声音讲解这一句。',
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'REALTIME_SESSION_NOT_FOUND' },
    });
  });

  it('accepts a learner query as a typed action before resolving its session', async () => {
    const response = await POST(
      request({
        action: 'query',
        sessionId: 'missing-query-session',
        text: '傅里叶变换和拉普拉斯变换有什么区别？',
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'REALTIME_SESSION_NOT_FOUND' },
    });
  });
});

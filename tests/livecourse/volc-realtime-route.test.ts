import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/livecourse/realtime/volc/route';

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
});
